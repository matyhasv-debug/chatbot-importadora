// src/services/followUpService.js
const db = require('../config/database');

// ─── Programar un seguimiento ─────────────────────────────────────────────────
function programarSeguimiento(telefono, tipo, minutosDelay = 180, tenantId = null) {
  const existente = db.prepare(`
    SELECT id FROM seguimientos
    WHERE telefono = ? AND tipo = ? AND enviado = 0
      AND (tenant_id = ? OR (tenant_id IS NULL AND ? IS NULL))
  `).get(telefono, tipo, tenantId, tenantId);

  if (existente) {
    console.log(`[FollowUp] ⏭️  Ya existe seguimiento "${tipo}" para ${telefono}`);
    return;
  }

  const enviarEn = new Date(Date.now() + minutosDelay * 60 * 1000).toISOString();
  db.prepare(`
    INSERT INTO seguimientos (telefono, tipo, enviar_en, tenant_id)
    VALUES (?, ?, ?, ?)
  `).run(telefono, tipo, enviarEn, tenantId);

  console.log(`[FollowUp] 📅 Programado "${tipo}" para ${telefono} en ${minutosDelay} min`);
}

// ─── Cancelar seguimientos pendientes ────────────────────────────────────────
function cancelarSeguimientos(telefono, tenantId = null) {
  const result = tenantId
    ? db.prepare(`UPDATE seguimientos SET enviado = 1 WHERE telefono = ? AND tenant_id = ? AND enviado = 0`).run(telefono, tenantId)
    : db.prepare(`UPDATE seguimientos SET enviado = 1 WHERE telefono = ? AND enviado = 0`).run(telefono);

  if (result.changes > 0) {
    console.log(`[FollowUp] ✅ Cancelados ${result.changes} seguimientos para ${telefono}`);
  }
}

// ─── Obtener seguimientos listos para enviar ──────────────────────────────────
function obtenerPendientes() {
  return db.prepare(`
    SELECT s.*, t.whatsapp_phone_id, t.whatsapp_token
    FROM seguimientos s
    LEFT JOIN tenants t ON t.id = s.tenant_id
    WHERE s.enviado = 0 AND s.enviar_en <= datetime('now')
    ORDER BY s.enviar_en ASC
    LIMIT 20
  `).all();
}

// ─── Marcar como enviado ──────────────────────────────────────────────────────
function marcarEnviado(id) {
  db.prepare(`UPDATE seguimientos SET enviado = 1 WHERE id = ?`).run(id);
}

// ─── Obtener último producto consultado por el cliente ────────────────────────
function obtenerUltimoProducto(telefono, tenantId = null) {
  const query = tenantId
    ? `SELECT mensaje FROM conversaciones WHERE telefono = ? AND tenant_id = ? AND rol = 'assistant' ORDER BY creado_en DESC LIMIT 10`
    : `SELECT mensaje FROM conversaciones WHERE telefono = ? AND rol = 'assistant' ORDER BY creado_en DESC LIMIT 10`;

  const msgs = tenantId
    ? db.prepare(query).all(telefono, tenantId)
    : db.prepare(query).all(telefono);

  for (const m of msgs) {
    const match = m.mensaje.match(/📦\s*\*([^*]+)\*/);
    if (match) return match[1].trim();
  }
  return null;
}

// ─── Mensajes predeterminados ─────────────────────────────────────────────────
const MENSAJES_DEFAULT = {
  follow_up_precio: [
    `¡Hola {{nombre}}! 👋 ¿Pudiste decidirte por el producto que consultaste?\n\nTenemos stock disponible hoy 📦 ¿Te ayudo a cerrarlo? 😊`,
    `Hola {{nombre}} 😊 Solo quería avisarte que aún tenemos disponible el producto que cotizaste.\n\n¿Te quedó alguna duda sobre el precio o el envío? Con gusto te ayudo 🚀`,
  ],
  carrito_abandonado: [
    `Hola {{nombre}}! 👋 Vi que estuviste viendo nuestros productos.\n\n¿Hay algo en lo que pueda ayudarte? A veces conviene aclarar dudas antes de decidir 😊`,
  ],
  post_venta: [
    `¡Hola {{nombre}}! 🎉 ¿Cómo llegó tu pedido? Esperamos que estés súper contento con tu compra.\n\nSi necesitas algo o tienes alguna consulta, aquí estamos 💪`,
  ],
  pago_recordatorio: [
    `Hola {{nombre}} 👋 Notamos que aún no hemos recibido tu comprobante de transferencia.\n\n¿Necesitas los datos bancarios de nuevo? Con gusto te los envío 💳`,
  ],
};

// ─── Generar mensajes de seguimiento según tipo ───────────────────────────────
function generarMensaje(tipo, telefono, nombre = '', tenantId = null) {
  const primerNombre = (nombre || 'amigo').split(' ')[0];

  // Buscar template personalizado del tenant
  if (tenantId) {
    try {
      const custom = db.prepare(`SELECT mensaje FROM tenant_followups WHERE tenant_id = ? AND tipo = ?`).get(tenantId, tipo);
      if (custom?.mensaje) {
        return custom.mensaje.replace(/\{\{nombre\}\}/g, primerNombre);
      }
    } catch (_) {}
  }

  // Usar mensaje predeterminado
  const opciones = MENSAJES_DEFAULT[tipo] || MENSAJES_DEFAULT.follow_up_precio;
  const plantilla = opciones[Math.floor(Math.random() * opciones.length)];
  return plantilla.replace(/\{\{nombre\}\}/g, primerNombre);
}

// ─── Procesar y enviar seguimientos pendientes ────────────────────────────────
async function procesarSeguimientos(enviarMensajeFn) {
  const pendientes = obtenerPendientes();
  if (!pendientes.length) return;

  console.log(`[FollowUp] 🔄 Procesando ${pendientes.length} seguimiento(s)...`);

  for (const seg of pendientes) {
    try {
      const cliente = db.prepare(
        `SELECT nombre FROM clientes WHERE telefono = ? AND (tenant_id = ? OR tenant_id IS NULL)`
      ).get(seg.telefono, seg.tenant_id);
      const nombre = cliente?.nombre || '';

      const mensaje = generarMensaje(seg.tipo, seg.telefono, nombre, seg.tenant_id);

      // Usar las credenciales del tenant correcto (del JOIN en obtenerPendientes)
      await enviarMensajeFn(seg.telefono, mensaje, seg.whatsapp_phone_id, seg.whatsapp_token);
      marcarEnviado(seg.id);

      if (seg.tipo === 'follow_up_precio') {
        const pendientesRestantes = db.prepare(`
          SELECT COUNT(*) as total FROM seguimientos
          WHERE telefono = ? AND (tenant_id = ? OR (tenant_id IS NULL AND ? IS NULL)) AND enviado = 0
        `).get(seg.telefono, seg.tenant_id, seg.tenant_id);

        if (pendientesRestantes.total === 0) {
          db.prepare(`UPDATE clientes SET estado = 'abandono' WHERE telefono = ? AND (tenant_id = ? OR tenant_id IS NULL)`)
            .run(seg.telefono, seg.tenant_id);
          console.log(`[FollowUp] 👻 Cliente ${seg.telefono} marcado como abandono`);
        }
      }

      console.log(`[FollowUp] ✅ Enviado "${seg.tipo}" a ${seg.telefono} (tenant: ${seg.tenant_id})`);
      await new Promise(r => setTimeout(r, 1500));

    } catch (err) {
      console.error(`[FollowUp] ❌ Error enviando a ${seg.telefono}:`, err.message);
    }
  }
}

module.exports = {
  programarSeguimiento,
  cancelarSeguimientos,
  obtenerPendientes,
  generarMensaje,
  procesarSeguimientos,
  obtenerUltimoProducto,
  MENSAJES_DEFAULT,
};
