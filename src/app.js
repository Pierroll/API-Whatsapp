// src/app.js - WhatsApp Bot API con Polka + Login para ver QR
require('dotenv').config();

const crypto = require('crypto');
const polka = require('polka');
const { json, urlencoded } = require('body-parser');
const botWhatsapp = require('@bot-whatsapp/bot');
const MockAdapter = require('@bot-whatsapp/database/mock');
const makeWASocket = require('baileys').default;
const { DisconnectReason, useMultiFileAuthState } = require('baileys');
const qrcode = require('qrcode');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'tu-api-key-secreta-aqui';

// ---- Login para QR ----
const QR_LOGIN_USER = process.env.QR_LOGIN_USER || 'admin';
const QR_LOGIN_PASS = process.env.QR_LOGIN_PASS || 'cambialo';
const COOKIE_SECRET = process.env.COOKIE_SECRET || process.env.API_KEY || 'cambia-este-secreto';
const COOKIE_NAME   = 'qr_session';
const COOKIE_TTL_MS = 30 * 60 * 1000; // 30 min

function sign(data) {
  return crypto.createHmac('sha256', COOKIE_SECRET).update(data).digest('hex');
}
function makeToken(username, ttlMs = COOKIE_TTL_MS) {
  const exp = Date.now() + ttlMs;
  const payload = `${username}.${exp}`;
  const sig = sign(payload);
  return `${Buffer.from(payload, 'utf8').toString('base64')}.${sig}`;
}
function verifyToken(token) {
  if (!token) return false;
  const [b64, sig] = token.split('.');
  if (!b64 || !sig) return false;
  const payload = Buffer.from(b64, 'base64').toString('utf8');
  const ok = sign(payload) === sig;
  if (!ok) return false;
  const exp = Number(payload.split('.')[1]);
  return Number.isFinite(exp) && Date.now() < exp;
}
function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  const map = Object.fromEntries(
    raw.split(/;\s*/).filter(Boolean).map(kv => {
      const i = kv.indexOf('=');
      if (i < 0) return [kv, ''];
      return [kv.slice(0, i), kv.slice(i + 1)];
    })
  );
  return map[name];
}

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

// ---- auth API key (para endpoints privados) ----
function authenticateAPI(req, res, next) {
  const apiKey = req.headers['x-api-key'] || (req.query && req.query.apiKey);
  if (apiKey !== API_KEY) return unauthorized(res, { error: 'API Key inválida' });
  next();
}

// ---- auth login (para ver QR) ----
function requireLogin(req, res, next) {
  if (connectionStatus === 'connected') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.statusCode = 200;
    return res.end(`<h2>Ya hay una sesión activa ✅</h2>
    <p>Para re-vincular primero haz <code>POST /api/logout</code>.</p>`);
  }
  const token = getCookie(req, COOKIE_NAME);
  if (verifyToken(token)) return next();
  res.statusCode = 302;
  res.setHeader('Location', '/login?msg=login');
  res.end();
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
app.use(urlencoded({ extended: false }));

// Health (sin API key)
app.get('/health', (req, res) => ok(res, {
  status: 'ok',
  uptime: process.uptime(),
  whatsapp: connectionStatus,
}));

// Estado (API key)
app.get('/api/status', authenticateAPI, (req, res) => ok(res, {
  status: connectionStatus,
  isConnected: !!botInstance?.isConnected,
  qrAvailable: qrCodeData !== null,
}));

// ---------- Login para ver QR ----------
app.get('/login', (req, res) => {
  const msg = (req.query && req.query.msg) ? String(req.query.msg) : '';
  const note = msg === 'bad' ? 'Credenciales inválidas' :
               msg === 'login' ? 'Inicia sesión para continuar' : '';
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><html><head>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Login QR</title>
  <style>
    body{font-family:system-ui,Arial;margin:0;display:grid;place-items:center;height:100vh;background:#0b1020;color:#fff}
    .card{background:#131a33;padding:24px;border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,.4);width:min(360px,92%)}
    input{width:100%;padding:10px;border-radius:8px;border:0;margin:6px 0}
    button{width:100%;padding:10px;border-radius:8px;border:0;background:#3b82f6;color:#fff;font-weight:600;cursor:pointer}
    .muted{opacity:.75;margin:8px 0}
    .err{color:#f87171}
  </style></head><body>
  <div class="card">
    <h2>Acceso al QR</h2>
    ${note ? `<p class="${msg==='bad'?'err':'muted'}">${note}</p>` : ''}
    <form method="POST" action="/login">
      <input name="user" placeholder="Usuario" autocomplete="username" required />
      <input name="pass" type="password" placeholder="Contraseña" autocomplete="current-password" required />
      <button type="submit">Entrar</button>
    </form>
  </div>
  </body></html>`);
});

app.post('/login', (req, res) => {
  const { user, pass } = req.body || {};
  if (user === QR_LOGIN_USER && pass === QR_LOGIN_PASS) {
    const token = makeToken(user);
    res.setHeader('Set-Cookie',
      `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(COOKIE_TTL_MS/1000)}`
      // añade "; Secure" si sirves por HTTPS
    );
    res.statusCode = 302;
    res.setHeader('Location', '/qr-view');
    return res.end();
  }
  res.statusCode = 302;
  res.setHeader('Location', '/login?msg=bad');
  res.end();
});

app.get('/logout', (_req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.statusCode = 302;
  res.setHeader('Location', '/login?msg=login');
  res.end();
});

// Vista QR (protegida por login)
app.get('/qr-view', requireLogin, (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
  res.setHeader('Pragma','no-cache'); res.setHeader('Expires','0');
  res.end(`<!doctype html><html><head>
  <meta http-equiv="refresh" content="15">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>QR WhatsApp</title>
  <style>
    body{font-family:system-ui,Arial;margin:0;display:grid;place-items:center;height:100vh;background:#0b1020;color:#fff}
    .card{background:#131a33;padding:24px;border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,.4);text-align:center}
    img{width:320px;height:320px;object-fit:contain;background:#fff;border-radius:8px}
    .muted{opacity:.7;font-size:13px;margin-top:8px}
  </style>
</head><body>
  <div class="card">
    <h2>Escanea el QR</h2>
    <p class="muted">Se actualiza cada 15s</p>
    <img src="/api/qr?format=image&ts=${Date.now()}" />
  </div>
</body></html>`);
});

// QR (SIN API key, con login)
app.get('/api/qr', requireLogin, (req, res) => {
  if (!qrCodeData) return notfound(res, { error: 'QR no disponible', status: connectionStatus });
  res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
  res.setHeader('Pragma','no-cache'); res.setHeader('Expires','0');
  const format = (req.query?.format || 'json').toString();
  if (format === 'image') {
    const buffer = Buffer.from(qrCodeData.split(',')[1], 'base64');
    res.setHeader('Content-Type', 'image/png');
    res.statusCode = 200;
    return res.end(buffer);
  }
  return ok(res, { qr: qrCodeData, status: connectionStatus });
});

// Enviar mensaje (API key)
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

// Historial (API key)
app.get('/api/messages', authenticateAPI, (req, res) => {
  const limit = parseInt(req.query?.limit || '50', 10);
  const history = botInstance?.getMessageHistory() || [];
  return ok(res, { total: history.length, messages: history.slice(-limit) });
});

// Logout WhatsApp (API key)
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

// Home
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`
    <h1>WhatsApp Bot API</h1>
    <ul>
      <li><b>GET</b> /health</li>
      <li><b>GET</b> /login → <i>acceso a QR</i></li>
      <li><b>GET</b> /qr-view → <i>ver QR (requiere login)</i></li>
      <li><b>GET</b> /api/status (API Key)</li>
      <li><b>GET</b> /api/qr (login)</li>
      <li><b>POST</b> /api/send (API Key)</li>
      <li><b>GET</b> /api/messages (API Key)</li>
      <li><b>POST</b> /api/logout (API Key)</li>
    </ul>
    <p>Header API: <code>X-API-Key: ${API_KEY}</code></p>
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
