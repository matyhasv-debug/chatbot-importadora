// src/services/pagoService.js
const crypto = require('crypto');
const axios  = require('axios');
const db     = require('../config/database');

// ─── Tabla de pagos pendientes ────────────────────────────────────────────────
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pagos_pendientes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id   INTEGER NOT NULL,
      telefono    TEXT    NOT NULL,
      orden_id    TEXT    NOT NULL UNIQUE,
      monto       REAL    NOT NULL,
      descripcion TEXT,
      flow_token  TEXT,
      estado      TEXT    DEFAULT 'pendiente',
      creado_en   DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_pagos_orden ON pagos_pendientes(orden_id);
    CREATE INDEX IF NOT EXISTS idx_pagos_tel   ON pagos_pendientes(telefono, tenant_id);
  `);
} catch (_) {}

// ─── Flow: firmar parámetros ──────────────────────────────────────────────────
function firmarFlow(params, secret) {
  const str = Object.keys(params).sort().map(k => `${k}${params[k]}`).join('');
  return crypto.createHmac('sha256', secret).update(str).digest('hex');
}

// ─── Flow: crear pago ─────────────────────────────────────────────────────────
async function crearPagoFlow({ apiKey, apiSecret, monto, descripcion, ordenId }) {
  const BASE = process.env.FLOW_ENV === 'sandbox'
    ? 'https://sandbox.flow.cl/api'
    : 'https://www.flow.cl/api';
  const PAY  = process.env.FLOW_ENV === 'sandbox'
    ? 'https://sandbox.flow.cl/app/web/pay.php'
    : 'https://www.flow.cl/app/web/pay.php';

  const APP = (process.env.APP_URL || '').replace(/\/$/, '');

  const params = {
    apiKey,
    commerceOrder:   String(ordenId),
    subject:         String(descripcion).slice(0, 100),
    currency:        'CLP',
    amount:          Math.round(monto),
    urlConfirmation: `${APP}/webhook/pago-flow`,
    urlReturn:       `${APP}/pago/gracias`,
  };
  params.s = firmarFlow(params, apiSecret);

  const { data } = await axios.post(
    `${BASE}/payment/create`,
    new URLSearchParams(params).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
  );

  if (!data.token) throw new Error('Flow sin token: ' + JSON.stringify(data));
  return { token: data.token, url: `${PAY}?token=${data.token}`, flowOrder: data.flowOrder };
}

// ─── Flow: verificar pago (para webhook) ─────────────────────────────────────
async function verificarPagoFlow(apiKey, apiSecret, token) {
  const BASE = process.env.FLOW_ENV === 'sandbox'
    ? 'https://sandbox.flow.cl/api'
    : 'https://www.flow.cl/api';

  const params = { apiKey, token };
  params.s = firmarFlow(params, apiSecret);

  const { data } = await axios.get(`${BASE}/payment/getStatus`, { params, timeout: 10000 });
  return data;
}

// ─── API pública: generar link de pago ───────────────────────────────────────
async function generarLinkPago(config, { monto, descripcion, telefono }) {
  const { pagoPasarela, pagoApiKey, pagoApiSecret } = config.credenciales;
  if (!pagoPasarela || pagoPasarela === 'ninguna' || !pagoApiKey || !pagoApiSecret) return null;

  const ordenId = `T${config.tenantId}-${telefono.replace(/\D/g, '')}-${Date.now()}`;

  // Guardar pago pendiente
  try {
    db.prepare(`INSERT OR IGNORE INTO pagos_pendientes (tenant_id, telefono, orden_id, monto, descripcion) VALUES (?,?,?,?,?)`)
      .run(config.tenantId, telefono, ordenId, monto, descripcion);
  } catch (_) {}

  if (pagoPasarela === 'flow') {
    const resultado = await crearPagoFlow({ apiKey: pagoApiKey, apiSecret: pagoApiSecret, monto, descripcion, ordenId });
    // Guardar token Flow en el registro
    db.prepare(`UPDATE pagos_pendientes SET flow_token = ? WHERE orden_id = ?`).run(resultado.token, ordenId);
    return resultado.url;
  }

  throw new Error(`Pasarela "${pagoPasarela}" no soportada aún`);
}

// ─── Confirmar pago por orden_id ──────────────────────────────────────────────
function confirmarPago(ordenId) {
  try {
    db.prepare(`UPDATE pagos_pendientes SET estado = 'pagado' WHERE orden_id = ?`).run(ordenId);
    return db.prepare(`SELECT * FROM pagos_pendientes WHERE orden_id = ?`).get(ordenId);
  } catch (_) { return null; }
}

// ─── Obtener pago pendiente por teléfono + tenant ────────────────────────────
function obtenerPagoPendiente(telefono, tenantId) {
  try {
    return db.prepare(`
      SELECT * FROM pagos_pendientes
      WHERE telefono = ? AND tenant_id = ? AND estado = 'pendiente'
      ORDER BY creado_en DESC LIMIT 1
    `).get(telefono, tenantId);
  } catch (_) { return null; }
}

module.exports = { generarLinkPago, verificarPagoFlow, confirmarPago, obtenerPagoPendiente };
