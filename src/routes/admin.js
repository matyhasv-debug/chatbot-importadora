// src/routes/admin.js
const express = require('express');
const router  = express.Router();
const { obtenerStats, actualizarEstado, obtenerPedido, ESTADOS } = require('../services/pedidosService');
const db = require('../config/database');

// ─── Middleware simple de autenticación ───────────────────────────────────────
router.use((req, res, next) => {
  const adminKey = req.headers['x-admin-key'] || req.query.key;
  if (adminKey !== process.env.ADMIN_KEY && process.env.NODE_ENV === 'production') {
    return res.status(401).json({ error: 'No autorizado' });
  }
  next();
});

// ─── GET /admin/stats ─────────────────────────────────────────────────────────
router.get('/stats', (req, res) => {
  try {
    const stats = obtenerStats();
    res.json({ ok: true, data: stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /admin/pedidos ───────────────────────────────────────────────────────
router.get('/pedidos', (req, res) => {
  const { estado, limite = 20, pagina = 1 } = req.query;
  const offset = (pagina - 1) * limite;

  let query = 'SELECT * FROM pedidos';
  const params = [];
  if (estado) { query += ' WHERE estado = ?'; params.push(estado); }
  query += ' ORDER BY creado_en DESC LIMIT ? OFFSET ?';
  params.push(Number(limite), Number(offset));

  const pedidos = db.prepare(query).all(...params);
  res.json({ ok: true, data: pedidos.map(p => ({ ...p, productos: JSON.parse(p.productos) })) });
});

// ─── GET /admin/pedidos/:id ───────────────────────────────────────────────────
router.get('/pedidos/:id', (req, res) => {
  const pedido = obtenerPedido(req.params.id);
  if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
  res.json({ ok: true, data: pedido });
});

// ─── PATCH /admin/pedidos/:id/estado ─────────────────────────────────────────
router.patch('/pedidos/:id/estado', async (req, res) => {
  const { estado } = req.body;
  try {
    const pedido = actualizarEstado(req.params.id, estado);

    // Notificar al cliente por WhatsApp
    const { enviarMensaje } = require('../services/whatsappService');
    const msg = `📦 *Actualización de tu pedido #${pedido.id}*\n\nEstado: ${ESTADOS[estado]}\n\n¿Tienes alguna consulta? Escríbenos 😊`;
    await enviarMensaje(pedido.telefono, msg);

    res.json({ ok: true, data: pedido });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── GET /admin/clientes ──────────────────────────────────────────────────────
router.get('/clientes', (req, res) => {
  const clientes = db.prepare(
    'SELECT * FROM clientes ORDER BY ultimo_pedido DESC LIMIT 50'
  ).all();
  res.json({ ok: true, data: clientes });
});

// ─── GET /admin/conversaciones/:telefono ─────────────────────────────────────
router.get('/conversaciones/:telefono', (req, res) => {
  const conv = db.prepare(`
    SELECT * FROM conversaciones
    WHERE telefono = ?
    ORDER BY creado_en DESC LIMIT 50
  `).all(req.params.telefono);
  res.json({ ok: true, data: conv.reverse() });
});

module.exports = router;
