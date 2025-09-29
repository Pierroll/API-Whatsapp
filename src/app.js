// src/app.js - WhatsApp Bot API con Polka
require('dotenv').config();

const polka = require('polka');
const { json } = require('body-parser');
const botWhatsapp = require('@bot-whatsapp/bot');
const MockAdapter = require('@bot-whatsapp/database/mock');
const makeWASocket = require('baileys').default;
const { DisconnectReason, useMultiFileAuthState } = require('baileys');
const qrcode = require('qrcode');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'tu-api-key-secreta-aqui';

// ---- helpers JSON para Polka ----
function send(res, status, obj) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.statusCode = status;
  res.end(JSON.stringify(obj));
}
function ok(res, obj) { send(res, 200, obj); }
function bad(res, obj) { send(res, 400, obj); }
function unauthorized(res, obj) { send(res, 401, obj); }
function notfound(res, obj) { send(res, 404, obj); }
function error(res, obj) { send(res, 500, obj); }

// ---- estado global ----
let botInstance = null;
let qrCodeData = null;
let connectionStatus = 'disconnected'; // disconnected | connecting | connected | qr_ready

// ---- auth middleware ----
function authenticateAPI(req, res, next) {
  const apiKey = req.headers['x-api-key'] || (req.query && req.query.apiKey);
  if (apiKey !== API_KEY) return unauthorized(res, { error: 'API Key inválida' });
  next();
}

// ---- provider personalizado (Baileys) ----
class CustomBaileysProvider {
  constructor() {
    this.sock = null;
    this.callbacks = new Map();
    this.isConnected = false;
    this.messageHistory = [];
  }

  async connect() {
    try {
      console.log('🔄 Conectando a WhatsApp...');
      connectionStatus = 'connecting';

      const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');

      this.sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
      });

      this.sock.ev.on('creds.update', saveCreds);

      this.sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          connectionStatus = 'qr_ready';
          console.log('📱 QR generado');
          try {
            qrCodeData = await qrcode.toDataURL(qr);
            await qrcode.toFile('./qr-code.png', qr);
          } catch (err) {
            console.error('Error generando QR:', err);
          }
        }

        if (connection === 'close') {
          this.isConnected = false;
          connectionStatus = 'disconnected';
          qrCodeData = null;

          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

          if (statusCode === DisconnectReason.loggedOut) {
            console.log('🚪 Sesión cerrada');
          } else if (shouldReconnect) {
            console.log('🔄 Reconectando en 5s...');
            setTimeout(() => this.connect(), 5000);
          }
        } else if (connection === 'open') {
          this.isConnected = true;
          connectionStatus = 'connected';
          qrCodeData = null;
          console.log('✅ WhatsApp conectado!');
        }
      });

      this.sock.ev.on('messages.upsert', (m) => {
        const msg = m.messages?.[0];
        if (!msg?.key || msg.key.fromMe) return;

        const text =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          '';

        const entry = {
          body: (text || '').toLowerCase(),
          from: msg.key.remoteJid,
          name: msg.pushName || 'Usuario',
          id: msg.key.id,
          timestamp: new Date(),
        };

        this.messageHistory.push(entry);
        if (this.messageHistory.length > 100) this.messageHistory.shift();

        console.log(`📨 ${entry.name}: "${text}"`);
        this.callbacks.forEach((cb) => {
          try { cb(entry); } catch (e) { console.error('Error en callback:', e); }
        });
      });
    } catch (e) {
      console.error('❌ Error conectando:', e);
      connectionStatus = 'error';
      setTimeout(() => this.connect(), 10000);
    }
  }

  on(event, callback) { this.callbacks.set(event, callback); }

  async sendMessage(to, message) {
    if (!this.sock || !this.isConnected) throw new Error('WhatsApp no está conectado');
    const jid = to.includes('@s.whatsapp.net') ? to : `${to}@s.whatsapp.net`;
    await this.sock.sendMessage(jid, { text: message });
    console.log(`📤 Mensaje enviado a ${to}`);
    return true;
  }

  getMessageHistory() { return this.messageHistory; }
}

// ---- init bot ----
async function initBot() {
  console.log('🚀 Iniciando Bot de WhatsApp...');

  const { createBot, createFlow, addKeyword } = botWhatsapp;

  const flowWelcome = addKeyword(['hola', 'buenas', 'hi', 'hello'])
    .addAnswer('¡Hola! 👋 Soy tu bot de WhatsApp')
    .addAnswer('Escribe "ayuda" para ver los comandos disponibles');

  const flowInfo = addKeyword(['info', 'información'])
    .addAnswer('ℹ️ *Bot de WhatsApp API*')
    .addAnswer('Versión: 1.0.0')
    .addAnswer('Estado: ✅ Funcionando');

  const flowHelp = addKeyword(['ayuda', 'help', 'comandos'])
    .addAnswer('🆘 *Comandos Disponibles*')
    .addAnswer('• hola → Saludo')
    .addAnswer('• info → Información')
    .addAnswer('• ayuda → Esta lista');

  const provider = new CustomBaileysProvider();
  const database = new MockAdapter();

  await createBot({
    flow: createFlow([flowWelcome, flowInfo, flowHelp]),
    provider,
    database,
  });

  botInstance = provider;
  await provider.connect();
  return provider;
}

// ---- app (Polka) ----
const app = polka();
app.use(json());

// Health (sin API key)
app.get('/health', (req, res) => ok(res, {
  status: 'ok',
  uptime: process.uptime(),
  whatsapp: connectionStatus,
}));

// Estado
app.get('/api/status', authenticateAPI, (req, res) => ok(res, {
  status: connectionStatus,
  isConnected: !!botInstance?.isConnected,
  qrAvailable: qrCodeData !== null,
}));

// QR
app.get('/api/qr', authenticateAPI, (req, res) => {
  if (!qrCodeData) return notfound(res, { error: 'QR no disponible', status: connectionStatus });

  const format = (req.query?.format || 'json').toString();
  if (format === 'image') {
    const buffer = Buffer.from(qrCodeData.split(',')[1], 'base64');
    res.setHeader('Content-Type', 'image/png');
    res.statusCode = 200;
    return res.end(buffer);
  }
  return ok(res, { qr: qrCodeData, status: connectionStatus });
});

// Enviar mensaje
app.post('/api/send', authenticateAPI, async (req, res) => {
  try {
    const { to, message } = req.body || {};
    if (!to || !message) return bad(res, { error: 'Campos requeridos: to, message' });
    if (!botInstance?.isConnected) return send(res, 503, { error: 'WhatsApp no está conectado', status: connectionStatus });

    await botInstance.sendMessage(to, message);
    return ok(res, { success: true, message: 'Mensaje enviado', to, timestamp: new Date() });
  } catch (e) {
    console.error('Error /api/send:', e);
    return error(res, { error: 'Error enviando mensaje', details: e.message });
  }
});

// Historial
app.get('/api/messages', authenticateAPI, (req, res) => {
  const limit = parseInt(req.query?.limit || '50', 10);
  const history = botInstance?.getMessageHistory() || [];
  return ok(res, { total: history.length, messages: history.slice(-limit) });
});

// Logout
app.post('/api/logout', authenticateAPI, async (req, res) => {
  try {
    if (botInstance?.sock) await botInstance.sock.logout();
    if (fs.existsSync('./auth_info_baileys')) fs.rmSync('./auth_info_baileys', { recursive: true, force: true });
    connectionStatus = 'disconnected';
    qrCodeData = null;
    ok(res, { success: true, message: 'Sesión cerrada' });
    setTimeout(() => initBot(), 2000);
  } catch (e) {
    return error(res, { error: 'Error cerrando sesión', details: e.message });
  }
});

// Doc simple
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`
    <h1>WhatsApp Bot API</h1>
    <ul>
      <li><b>GET</b> /health</li>
      <li><b>GET</b> /api/status</li>
      <li><b>GET</b> /api/qr</li>
      <li><b>POST</b> /api/send</li>
      <li><b>GET</b> /api/messages</li>
      <li><b>POST</b> /api/logout</li>
    </ul>
    <p>Header requerido: <code>X-API-Key: ${API_KEY}</code></p>
  `);
});

// Start
async function start() {
  await initBot();
  app.listen(PORT, (err) => {
    if (err) throw err;
    console.log(`\n🚀 Polka server en http://localhost:${PORT}`);
    console.log(`📡 Health:   http://localhost:${PORT}/health`);
    console.log(`🔐 API Key:  ${API_KEY}\n`);
  });
}
start();
