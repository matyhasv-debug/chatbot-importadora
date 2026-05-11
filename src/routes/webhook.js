// src/routes/webhook.js
const express       = require('express');
const crypto        = require('crypto');
const router        = express.Router();
const { parsearWebhook, marcarLeido, enviarMensaje } = require('../services/whatsappService');
const { procesarMensaje }             = require('../services/chatbotController');
const tenantService = require('../services/tenantService');
const db            = require('../config/database');
const pagoService   = require('../services/pagoService');

// ─── Verificar firma HMAC-SHA256 de Meta ──────────────────────────────────────
function verificarFirma(req, res, next) {
  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret) return next(); // no configurado → skip (no romper deployments existentes)

  const signature = req.headers['x-hub-signature-256'];
  if (!signature) {
    console.warn('[Webhook] ❌ Request sin X-Hub-Signature-256 — rechazado');
    return res.sendStatus(401);
  }

  const expected = 'sha256=' + crypto
    .createHmac('sha256', appSecret)
    .update(req.rawBody || '')
    .digest('hex');

  try {
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      console.warn('[Webhook] ❌ Firma inválida — request rechazado');
      return res.sendStatus(401);
    }
  } catch {
    return res.sendStatus(401);
  }

  next();
}

// ─── GET: Verificación del webhook (Meta lo llama al configurar) ──────────────
router.get('/', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    console.log('[Webhook] ✅ Verificación exitosa');
    return res.status(200).send(challenge);
  }

  console.warn('[Webhook] ❌ Token inválido');
  res.sendStatus(403);
});

// ─── Cola por usuario: evita respuestas dobles cuando llegan mensajes rápido ──
const colaMensajes = new Map();

function encolarMensaje(data) {
  const tel      = data.telefono;
  const anterior = colaMensajes.get(tel) || Promise.resolve();
  const siguiente = anterior
    .then(() => procesarMensaje(data))
    .catch(err => console.error('[Cola] Error procesando mensaje de', tel, ':', err.message));
  colaMensajes.set(tel, siguiente);
  siguiente.finally(() => {
    if (colaMensajes.get(tel) === siguiente) colaMensajes.delete(tel);
  });
}

// ─── Debounce de texto: agrupa mensajes rápidos del mismo usuario ─────────────
const DEBOUNCE_MS = 1500;
const pendingDebounce = new Map(); // tel -> { timer, partes[], baseData }

function encolarConDebounce(data) {
  // Botones, audio, imagen y otros tipos se procesan de inmediato
  if (data.tipo !== 'text') {
    encolarMensaje(data);
    return;
  }

  const tel = data.telefono;
  const pending = pendingDebounce.get(tel);

  if (pending) {
    clearTimeout(pending.timer);
    if (data.texto) pending.partes.push(data.texto);
  } else {
    pendingDebounce.set(tel, { partes: data.texto ? [data.texto] : [], baseData: data });
  }

  const entry = pendingDebounce.get(tel);
  entry.timer = setTimeout(() => {
    pendingDebounce.delete(tel);
    const textoFinal = entry.partes.join('\n');
    const merged = { ...entry.baseData, texto: textoFinal || entry.baseData.texto };
    if (entry.partes.length > 1) {
      console.log(`[Debounce] Agrupando ${entry.partes.length} mensajes de ${tel}: "${textoFinal.slice(0, 60)}"`);
    }
    encolarMensaje(merged);
  }, DEBOUNCE_MS);
}

// ─── POST: Recibir mensajes de WhatsApp ───────────────────────────────────────
router.post('/', verificarFirma, async (req, res) => {
  // Responder 200 de inmediato (Meta requiere respuesta rápida)
  res.sendStatus(200);

  try {
    const data = parsearWebhook(req.body);
    if (!data) return;

    // Marcar como leído con las credenciales del tenant correcto
    const cfg     = tenantService.getConfigByPhoneId(data.phoneNumberId);
    const phoneId = cfg?.credenciales?.whatsappPhoneId;
    const token   = cfg?.credenciales?.whatsappToken;
    await marcarLeido(data.messageId, phoneId, token);

    // Encolar con debounce para texto, inmediato para el resto
    encolarConDebounce(data);

  } catch (err) {
    console.error('[Webhook] Error procesando mensaje:', err);
  }
});

// ─── POST: Webhook de confirmación de pago Flow ───────────────────────────────
router.post('/pago-flow', express.urlencoded({ extended: true }), async (req, res) => {
  res.sendStatus(200); // Flow requiere 200 inmediato

  const { token } = req.body;
  if (!token) return;

  try {
    // Buscar qué pago corresponde a este token
    const pago = db.prepare(`SELECT * FROM pagos_pendientes WHERE flow_token = ? AND estado = 'pendiente'`).get(token);
    if (!pago) return console.warn(`[Flow] Token desconocido: ${token}`);

    // Buscar tenant para obtener credenciales de pasarela
    const tenant = db.prepare(`SELECT * FROM tenants WHERE id = ?`).get(pago.tenant_id);
    if (!tenant) return;

    // Verificar el pago con la API de Flow
    const estado = await pagoService.verificarPagoFlow(tenant.pasarela_api_key, tenant.pasarela_api_secret, token);
    // status 2 = pagado, 3 = rechazado, 4 = anulado
    if (estado.status !== 2) {
      console.warn(`[Flow] Pago no confirmado para ${pago.orden_id} — status: ${estado.status}`);
      return;
    }

    // Confirmar en BD
    pagoService.confirmarPago(pago.orden_id);

    const phoneId = tenant.whatsapp_phone_id || process.env.WHATSAPP_PHONE_ID;
    const tok     = tenant.whatsapp_token    || process.env.WHATSAPP_TOKEN;
    const nombre  = db.prepare(`SELECT nombre FROM clientes WHERE telefono = ? AND tenant_id = ?`).get(pago.telefono, pago.tenant_id)?.nombre || pago.telefono;

    // Actualizar estado del cliente
    const { actualizarEstadoCliente } = require('./panel');
    actualizarEstadoCliente(pago.telefono, 'pagado', pago.tenant_id);

    // Notificar al cliente
    await enviarMensaje(pago.telefono,
      `✅ *¡Pago confirmado!*\n\n` +
      `Tu pago de $${Math.round(pago.monto).toLocaleString('es-CL')} fue recibido correctamente 🎉\n` +
      `*${pago.descripcion}*\n\n` +
      `Te contactaremos a la brevedad para coordinar los pasos siguientes. ¡Gracias!`,
      phoneId, tok
    );

    // Notificar al dueño
    const notifTel = tenant.notif_telefono || process.env.DUENO_WHATSAPP;
    if (notifTel) {
      await enviarMensaje(notifTel,
        `💳 *PAGO FLOW CONFIRMADO*\n` +
        `Cliente: ${nombre} (${pago.telefono})\n` +
        `Monto: $${Math.round(pago.monto).toLocaleString('es-CL')}\n` +
        `Orden: ${pago.orden_id}\n` +
        `Detalle: ${pago.descripcion}`,
        phoneId, tok
      );
    }

    console.log(`[Flow] ✅ Pago confirmado — ${pago.orden_id} | ${pago.telefono} | $${pago.monto}`);
  } catch (err) {
    console.error('[Flow] Error procesando webhook:', err.message);
  }
});

// ─── GET: Página de retorno tras pago Flow ────────────────────────────────────
router.get('/gracias', (req, res) => {
  res.send(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Pago recibido</title>
    <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#F0FDF4}
    .box{text-align:center;padding:40px;background:#fff;border-radius:16px;box-shadow:0 4px 20px rgba(0,0,0,.08)}
    h1{color:#059669;font-size:28px;margin-bottom:8px}p{color:#4B5563;font-size:15px}</style></head>
    <body><div class="box"><div style="font-size:56px">✅</div>
    <h1>¡Pago recibido!</h1>
    <p>Tu pago fue procesado correctamente.<br>Recibirás un mensaje de WhatsApp con la confirmación.</p>
    <p style="margin-top:20px;color:#9CA3AF;font-size:13px">Puedes cerrar esta ventana.</p>
    </div></body></html>`);
});

module.exports = router;