// src/routes/webhook.js
const express = require('express');
const router  = express.Router();
const { parsearWebhook, marcarLeido } = require('../services/whatsappService');
const { procesarMensaje }             = require('../services/chatbotController');

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
router.post('/', async (req, res) => {
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