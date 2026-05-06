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

module.exports = app;
