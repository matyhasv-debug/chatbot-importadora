// src/services/pedidosService.js
const db = require('../config/database');

const ESTADOS = {
  pendiente:   '⏳ Pendiente',
  confirmado:  '✅ Confirmado',
  preparando:  '🔧 En preparación',
  listo:       '📦 Listo para retiro',
  entregado:   '🎉 Entregado',
  cancelado:   '❌ Cancelado',
};

// ─── Crear pedido ─────────────────────────────────────────────────────────────
function crearPedido({ telefono, nombreCliente, productos, total, notas }) {
  const stmt = db.prepare(`
    INSERT INTO pedidos (telefono, nombre_cliente, productos, total, notas)
    VALUES (?, ?, ?, ?, ?)
  `);
  const result = stmt.run(telefono, nombreCliente, JSON.stringify(productos), total, notas);

  // Actualizar o crear cliente
  db.prepare(`
    INSERT INTO clientes (telefono, nombre, total_pedidos, primer_pedido, ultimo_pedido)
    VALUES (?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(telefono) DO UPDATE SET
      nombre = excluded.nombre,
      total_pedidos = total_pedidos + 1,
      ultimo_pedido = CURRENT_TIMESTAMP
  `).run(telefono, nombreCliente);

  return result.lastInsertRowid;
}

// ─── Obtener pedido por ID ────────────────────────────────────────────────────
function obtenerPedido(id) {
  const pedido = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(id);
  if (!pedido) return null;
  return { ...pedido, productos: JSON.parse(pedido.productos) };
}

// ─── Pedidos de un cliente ────────────────────────────────────────────────────
function pedidosDeCliente(telefono, limite = 5) {
  const pedidos = db.prepare(`
    SELECT * FROM pedidos WHERE telefono = ?
    ORDER BY creado_en DESC LIMIT ?
  `).all(telefono, limite);
  return pedidos.map(p => ({ ...p, productos: JSON.parse(p.productos) }));
}

// ─── Actualizar estado ────────────────────────────────────────────────────────
function actualizarEstado(id, estado) {
  if (!ESTADOS[estado]) throw new Error(`Estado inválido: ${estado}`);
  db.prepare(`
    UPDATE pedidos SET estado = ?, actualizado_en = CURRENT_TIMESTAMP WHERE id = ?
  `).run(estado, id);
  return obtenerPedido(id);
}

// ─── Formatear pedido para WhatsApp ──────────────────────────────────────────
function formatearPedido(pedido) {
  if (!pedido) return 'No encontré ese pedido. Verifica el número e intenta de nuevo.';

  const prods = pedido.productos
    .map(p => `  • ${p.nombre} x${p.cantidad}${p.precio ? ` — $${Number(p.precio).toLocaleString('es-CL')}` : ''}`)
    .join('\n');

  const total = pedido.total
    ? `\n💰 *Total:* $${Number(pedido.total).toLocaleString('es-CL')}`
    : '';

  const fecha = new Date(pedido.creado_en).toLocaleDateString('es-CL', {
    day: '2-digit', month: '2-digit', year: 'numeric',
  });

  return [
    `🧾 *Pedido #${pedido.id}*`,
    `📋 Estado: ${ESTADOS[pedido.estado] || pedido.estado}`,
    `👤 Cliente: ${pedido.nombre_cliente || 'Sin nombre'}`,
    `📅 Fecha: ${fecha}`,
    `\n*Productos:*\n${prods}`,
    total,
    pedido.notas ? `📝 Notas: ${pedido.notas}` : '',
  ].filter(Boolean).join('\n');
}

// ─── Stats para panel admin ───────────────────────────────────────────────────
function obtenerStats() {
  const hoy = new Date().toISOString().split('T')[0];
  return {
    totalHoy:       db.prepare(`SELECT COUNT(*) as n FROM pedidos WHERE DATE(creado_en) = ?`).get(hoy).n,
    pendientes:     db.prepare(`SELECT COUNT(*) as n FROM pedidos WHERE estado = 'pendiente'`).get().n,
    confirmados:    db.prepare(`SELECT COUNT(*) as n FROM pedidos WHERE estado = 'confirmado'`).get().n,
    totalClientes:  db.prepare(`SELECT COUNT(*) as n FROM clientes`).get().n,
    totalPedidos:   db.prepare(`SELECT COUNT(*) as n FROM pedidos`).get().n,
    ultimos10:      db.prepare(`
      SELECT id, nombre_cliente, estado, total, creado_en
      FROM pedidos ORDER BY creado_en DESC LIMIT 10
    `).all(),
  };
}

module.exports = {
  crearPedido,
  obtenerPedido,
  pedidosDeCliente,
  actualizarEstado,
  formatearPedido,
  obtenerStats,
  ESTADOS,
};
