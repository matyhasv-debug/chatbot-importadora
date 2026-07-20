// src/services/emailService.js
// Envía correos vía la API HTTP de Resend (https://resend.com).
// Se usa una API en vez de SMTP directo porque muchos hosts (Railway incluido)
// bloquean conexiones SMTP salientes. Con Resend sin dominio propio verificado,
// el remitente debe ser onboarding@resend.dev y solo se puede enviar al correo
// con el que se creó la cuenta de Resend.
const axios = require('axios');

const RESEND_API_URL = 'https://api.resend.com/emails';
const REMITENTE_DEFAULT = 'onboarding@resend.dev';

const ASUNTOS = {
  pago_detectado:      '💰 Pago detectado',
  comprobante:         '🧾 Comprobante de pago recibido',
  pago_confirmado:     '💳 Pago confirmado',
  error_bot:           '⚠️ Producto no encontrado',
  solicitud_humano:    '🙋 Cliente pide hablar con una persona',
  lead_mayorista:      '🛒 Posible revendedor/mayorista',
  propuesta_comercial: '📢 Propuesta comercial recibida',
  datos_despacho:      '📍 Datos de despacho recibidos',
  cita_agendada:       '📅 Nueva cita agendada',
};

// ─── Enviar notificación por correo al dueño ──────────────────────────────────
// adjunto opcional: { filename, content: Buffer, mime }
async function enviarNotificacion(destinatario, tipo, mensajeTexto, adjunto = null) {
  if (!destinatario) return;

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('[Email] ⚠️ RESEND_API_KEY no configurado, se omite envío');
    return;
  }

  const payload = {
    from:    process.env.EMAIL_FROM || REMITENTE_DEFAULT,
    to:      [destinatario],
    subject: ASUNTOS[tipo] || `Notificación: ${tipo}`,
    text:    mensajeTexto,
  };

  if (adjunto?.content) {
    payload.attachments = [{
      filename: adjunto.filename || 'comprobante',
      content:  adjunto.content.toString('base64'),
    }];
  }

  await axios.post(RESEND_API_URL, payload, {
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    timeout: 10000,
  });
}

module.exports = { enviarNotificacion };
