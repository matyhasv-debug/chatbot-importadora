// src/routes/webhook.js
const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();
const { parsearWebhook, marcarLeido } = require('../services/whatsappService');
const { procesarMensaje }             = require('../services/chatbotController');

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

// ─── POST: Recibir mensajes de WhatsApp ───────────────────────────────────────
router.post('/', verificarFirma, async (req, res) => {
  // Responder 200 de inmediato (Meta requiere respuesta rápida)
  res.sendStatus(200);

  try {
    const data = parsearWebhook(req.body);
    if (!data) return;

    // Marcar como leído
    await marcarLeido(data.messageId);

    // Procesar de forma asíncrona
    await procesarMensaje(data);

  } catch (err) {
    console.error('[Webhook] Error procesando mensaje:', err);
  }
});

module.exports = router;