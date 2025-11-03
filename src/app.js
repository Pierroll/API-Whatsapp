// src/app.js - WhatsApp Bot API con Polka (Solo Baileys, sin flows)
require('dotenv').config();

const crypto = require('crypto');
const polka = require('polka');
const { json, urlencoded } = require('body-parser');
const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');

const qrcode = require('qrcode');
const fs = require('fs');
const pino = require('pino');

const PORT = process.env.PORT || 3005;
const API_KEY = process.env.API_KEY || 'tu-api-key-secreta-aqui';

// Logger silencioso (reduce spam de Baileys)
const logger = pino({ level: 'error' });

// ---- Login para QR ----
const QR_LOGIN_USER = process.env.QR_LOGIN_USER || 'admin';
const QR_LOGIN_PASS = process.env.QR_LOGIN_PASS || 'cambialo';
const COOKIE_SECRET = process.env.COOKIE_SECRET || process.env.API_KEY || 'cambia-este-secreto';
const COOKIE_NAME   = 'qr_session';
const COOKIE_TTL_MS = 30 * 60 * 1000;

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
let connectionStatus = 'disconnected';
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

// ---- auth API key ----
function authenticateAPI(req, res, next) {
  const apiKey = req.headers['x-api-key'] || (req.query && req.query.apiKey);
  if (apiKey !== API_KEY) return unauthorized(res, { error: 'API Key inválida' });
  next();
}

// ---- auth login ----
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

// ---- helpers para PDF ----
async function fetchBufferFromUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`No se pudo descargar el PDF (${res.status})`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

function parseBase64Pdf(b64) {
  const prefix = 'data:application/pdf;base64,';
  const clean = b64.startsWith(prefix) ? b64.slice(prefix.length) : b64;
  try {
    return Buffer.from(clean, 'base64');
  } catch {
    throw new Error('Base64 inválido para PDF');
  }
}

function guessFilenameFromUrl(url, fallback = 'documento.pdf') {
  try {
    const u = new URL(url);
    const last = (u.pathname.split('/').pop() || '').trim();
    if (last && last.includes('.')) return last;
  } catch {}
  return fallback;
}

async function resolvePdfInput(input) {
  const { url, base64, path, filename, message } = input || {};
  let buffer, name = filename || 'documento.pdf';

  if (url) {
    buffer = await fetchBufferFromUrl(url);
    if (!filename) name = guessFilenameFromUrl(url, name);
  } else if (base64) {
    buffer = parseBase64Pdf(base64);
  } else if (path) {
    if (!fs.existsSync(path)) throw new Error('Archivo local no existe');
    buffer = fs.readFileSync(path);
    if (!filename) name = (path.split('/').pop() || name);
  } else {
    throw new Error('Debes enviar "url", "base64" o "path" para el PDF');
  }

  if (!buffer || buffer.length < 4 || buffer.slice(0,4).toString() !== '%PDF') {
    const str = buffer.slice(0, 1024).toString();
    if (!str.includes('%PDF')) throw new Error('El archivo proporcionado no parece un PDF válido');
  }

  return { buffer, filename: name, caption: (message && String(message).trim()) || undefined };
}

// ---- Provider Baileys ----
class BaileysProvider {
  constructor() {
    this.sock = null;
    this.isConnected = false;
    this.messageHistory = [];
  }

  async connect() {
    try {
      console.log('🔄 Conectando a WhatsApp...');
      connectionStatus = 'connecting';

      const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');
      
      // Obtener la versión más reciente de Baileys
      const { version } = await fetchLatestBaileysVersion();
      console.log('📦 Usando versión de Baileys:', version.join('.'));

      this.sock = makeWASocket({
        version,
        auth: state,
        logger,
        printQRInTerminal: false,
        generateHighQualityLinkPreview: true,
      });

      this.sock.ev.on('creds.update', saveCreds);

      this.sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          connectionStatus = 'qr_ready';
          reconnectAttempts = 0;
          console.log('📱 QR generado - escanéalo en 60s');
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
            console.log('🚪 Sesión cerrada por usuario');
            reconnectAttempts = 0;
          } else if (shouldReconnect) {
            reconnectAttempts++;
            if (reconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
              const delay = Math.min(5000 * reconnectAttempts, 30000);
              console.log(`🔄 Reconectando en ${delay/1000}s (intento ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
              setTimeout(() => this.connect(), delay);
            } else {
              console.log('❌ Max reconexiones alcanzado. Limpia la sesión con POST /api/logout');
            }
          }
        } else if (connection === 'open') {
          this.isConnected = true;
          connectionStatus = 'connected';
          qrCodeData = null;
          reconnectAttempts = 0;
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
      });
    } catch (e) {
      console.error('❌ Error conectando:', e.message);
      connectionStatus = 'error';
      reconnectAttempts++;
      if (reconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
        setTimeout(() => this.connect(), 5000);
      }
    }
  }

  async sendMessage(to, message) {
    if (!this.sock || !this.isConnected) throw new Error('WhatsApp no está conectado');
    const jid = to.includes('@s.whatsapp.net') ? to : `${to}@s.whatsapp.net`;
    await this.sock.sendMessage(jid, { text: message });
    console.log(`📤 Mensaje enviado a ${to}`);
    return true;
  }

  async sendPdf(to, pdfBuffer, filename, caption) {
    if (!this.sock || !this.isConnected) throw new Error('WhatsApp no está conectado');
    const jid = to.includes('@s.whatsapp.net') ? to : `${to}@s.whatsapp.net`;
    await this.sock.sendMessage(jid, {
      document: pdfBuffer,
      mimetype: 'application/pdf',
      fileName: filename,
      caption: caption
    });
    console.log(`📤 PDF enviado a ${to} (${filename})`);
    return true;
  }

  getMessageHistory() { return this.messageHistory; }
}

// ---- init bot ----
async function initBot() {
  console.log('🚀 Iniciando Bot de WhatsApp...');
  const provider = new BaileysProvider();
  await provider.connect();
  botInstance = provider;
}

// ---- app (Polka) ----
const app = polka();
app.use(json({ limit: '25mb' }));
app.use(urlencoded({ extended: false, limit: '25mb' }));

app.get('/health', (req, res) => ok(res, {
  status: 'ok',
  uptime: process.uptime(),
  whatsapp: connectionStatus,
}));

app.get('/api/status', authenticateAPI, (req, res) => ok(res, {
  status: connectionStatus,
  isConnected: !!botInstance?.isConnected,
  qrAvailable: qrCodeData !== null,
}));

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

app.post('/api/send-pdf', authenticateAPI, async (req, res) => {
  try {
    if (!botInstance?.isConnected) {
      return send(res, 503, { error: 'WhatsApp no está conectado', status: connectionStatus });
    }

    const { to, url, base64, path, filename, message } = req.body || {};
    if (!to) return bad(res, { error: 'Campo requerido: to' });

    const { buffer, filename: finalName, caption } = await resolvePdfInput({ url, base64, path, filename, message });

    await botInstance.sendPdf(to, buffer, finalName, caption);
    return ok(res, {
      success: true,
      message: 'PDF enviado',
      to,
      filename: finalName,
      hasMessage: !!caption,
      timestamp: new Date()
    });
  } catch (e) {
    console.error('Error /api/send-pdf:', e);
    return error(res, { error: 'Error enviando PDF', details: e.message });
  }
});

app.get('/api/messages', authenticateAPI, (req, res) => {
  const limit = parseInt(req.query?.limit || '50', 10);
  const history = botInstance?.getMessageHistory() || [];
  return ok(res, { total: history.length, messages: history.slice(-limit) });
});

app.post('/api/logout', authenticateAPI, async (req, res) => {
  try {
    if (botInstance?.sock) await botInstance.sock.logout();
    if (fs.existsSync('./auth_info_baileys')) fs.rmSync('./auth_info_baileys', { recursive: true, force: true });
    connectionStatus = 'disconnected';
    qrCodeData = null;
    reconnectAttempts = 0;
    ok(res, { success: true, message: 'Sesión cerrada' });
    setTimeout(() => initBot(), 2000);
  } catch (e) {
    return error(res, { error: 'Error cerrando sesión', details: e.message });
  }
});

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
      <li><b>POST</b> /api/send (API Key) → Enviar texto</li>
      <li><b>POST</b> /api/send-pdf (API Key) → Enviar PDF (mensaje opcional)</li>
      <li><b>GET</b> /api/messages (API Key)</li>
      <li><b>POST</b> /api/logout (API Key)</li>
    </ul>
    <p>Header API: <code>X-API-Key: ${API_KEY}</code></p>
  `);
});

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
