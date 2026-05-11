// src/index.js
require('dotenv').config();

// ─── Logger estructurado — parchear console antes de cargar cualquier módulo ──
const logger = require('./config/logger');
console.log   = logger.info;
console.info  = logger.info;
console.warn  = logger.warn;
console.error = logger.error;
console.debug = logger.debug;

// Capturar errores no manejados para que queden en los logs antes de caer
process.on('uncaughtException', (err) => {
  logger.error('[FATAL] uncaughtException:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logger.error('[FATAL] unhandledRejection:', reason);
});

// ─── Validar variables de entorno críticas antes de arrancar ──────────────────
const VARS_REQUERIDAS   = ['WEBHOOK_VERIFY_TOKEN', 'GROQ_API_KEY'];
const VARS_RECOMENDADAS = ['JWT_SECRET', 'PANEL_SECRET'];

const faltantes = VARS_REQUERIDAS.filter(v => !process.env[v]);
if (faltantes.length > 0) {
  console.error('\n❌ VARIABLES DE ENTORNO REQUERIDAS NO CONFIGURADAS:');
  faltantes.forEach(v => console.error(`   • ${v}`));
  console.error('\nCopia .env.example → .env, completa los valores y reinicia.\n');
  process.exit(1);
}

const sinConfigurar = VARS_RECOMENDADAS.filter(v => !process.env[v]);
if (sinConfigurar.length > 0) {
  console.warn('\n⚠️  Variables recomendadas sin configurar (riesgo en producción):');
  sinConfigurar.forEach(v => console.warn(`   • ${v}`));
  console.warn('');
}

const express   = require('express');
const path      = require('path');
const rateLimit = require('express-rate-limit');

const webhookRouter = require('./routes/webhook');
const adminRouter   = require('./routes/admin');
const { router: panelRouter } = require('./routes/panel');
const followUpService = require('./services/followUpService');
const { enviarMensaje } = require('./services/whatsappService');

const app  = express();
const PORT = process.env.PORT || 3000;
const { iniciarBackupAutomatico } = require('./services/backupService');

iniciarBackupAutomatico();

// Necesario para que rate-limit lea la IP real detrás del proxy de Railway/Heroku
app.set('trust proxy', 1);

// ─── Rate limiters ────────────────────────────────────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Demasiados intentos. Espera 15 minutos e intenta de nuevo.' },
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Demasiadas solicitudes. Espera un momento.' },
});

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Límite de solicitudes excedido.' },
});

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
}));

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ─── Rutas con rate limiting ──────────────────────────────────────────────────
app.use('/panel/api/login', loginLimiter);
app.use('/panel',   apiLimiter, panelRouter);
app.use('/admin',   apiLimiter, adminRouter);
app.use('/webhook', webhookLimiter, webhookRouter);
app.use('/pago',    webhookRouter); // /pago/gracias — retorno Flow

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    nombre: process.env.BUSINESS_NAME || 'Chatbot WSP',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

// ─── Arrancar servidor ────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log('\n' + '═'.repeat(50));
  console.log(`🤖 Chatbot WhatsApp + Bsale iniciado`);
  console.log(`📡 Puerto: ${PORT}`);
  console.log(`📊 Panel: http://localhost:${PORT}/panel`);
  console.log('═'.repeat(50) + '\n');
});

// ─── Graceful shutdown (Railway / Docker envían SIGTERM al reiniciar) ─────────
process.on('SIGTERM', () => {
  console.log('[SIGTERM] Cerrando servidor — esperando requests en curso...');
  server.close(() => {
    console.log('[SIGTERM] Servidor cerrado limpiamente');
    process.exit(0);
  });
  setTimeout(() => {
    console.error('[SIGTERM] Timeout — forzando cierre');
    process.exit(1);
  }, 10_000);
});

// ─── Cron de follow-ups ───────────────────────────────────────────────────────
setInterval(async () => {
  try {
    await followUpService.procesarSeguimientos(enviarMensaje);
  } catch (err) {
    console.error('[Cron FollowUp] Error:', err.message);
  }
}, 60 * 1000); // cada 1 minuto

console.log('⏰ Cron de follow-ups activado (cada 60s)');

// ─── Reporte diario a las 8 AM Chile (≈ 11 UTC) ───────────────────────────────
const db = require('./config/database');
let _reporteFecha = ''; // evita doble envío si el server reinicia en el mismo minuto

async function enviarReporteDiario() {
  try {
    const tenants = db.prepare(`SELECT * FROM tenants WHERE activo = 1 AND notif_telefono IS NOT NULL AND notif_telefono != ''`).all();
    for (const t of tenants) {
      const phoneId = t.whatsapp_phone_id || process.env.WHATSAPP_PHONE_ID;
      const tok     = t.whatsapp_token    || process.env.WHATSAPP_TOKEN;
      if (!t.notif_telefono || !phoneId || !tok) continue;
      try {
        const hoy = new Date().toISOString().split('T')[0];
        const clientesHoy = db.prepare(`SELECT COUNT(DISTINCT telefono) as n FROM conversaciones WHERE tenant_id = ? AND DATE(creado_en) = ?`).get(t.id, hoy)?.n || 0;
        const mensajesHoy = db.prepare(`SELECT COUNT(*) as n FROM conversaciones WHERE tenant_id = ? AND DATE(creado_en) = ?`).get(t.id, hoy)?.n || 0;
        const pagadosHoy  = db.prepare(`SELECT COUNT(*) as n FROM clientes WHERE tenant_id = ? AND estado IN ('pagado','despachado') AND DATE(ultimo_contacto) = ?`).get(t.id, hoy)?.n || 0;
        const fechaLocal  = new Date().toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'long' });
        const msg = `📊 *Reporte diario — ${fechaLocal}*\n\n` +
          `👤 Clientes que escribieron hoy: ${clientesHoy}\n` +
          `💬 Mensajes recibidos hoy: ${mensajesHoy}\n` +
          `✅ Con pago registrado hoy: ${pagadosHoy}\n\n` +
          `_Revisa el panel para más detalles._`;
        await enviarMensaje(t.notif_telefono, msg, phoneId, tok);
        console.log(`[Reporte] ✅ Enviado a ${t.slug} (${t.notif_telefono})`);
      } catch (err) {
        console.error(`[Reporte] ❌ Error para ${t.slug}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[Reporte] ❌ Error general:', err.message);
  }
}

setInterval(() => {
  const ahora = new Date();
  const horaUTC = ahora.getUTCHours();
  const minUTC  = ahora.getUTCMinutes();
  const fecha   = ahora.toISOString().split('T')[0];
  // 11:00 UTC ≈ 8:00 AM Chile estándar (UTC-3)
  if (horaUTC === 11 && minUTC === 0 && _reporteFecha !== fecha) {
    _reporteFecha = fecha;
    enviarReporteDiario();
  }
}, 60 * 1000);

console.log('⏰ Cron de reporte diario activado (8 AM Chile)');

module.exports = app;
