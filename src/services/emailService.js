// src/services/emailService.js
// Envía correos vía la API HTTP de Brevo (https://api.brevo.com) en vez de SMTP directo,
// porque muchos hosts (Railway incluido) bloquean conexiones SMTP salientes.
const axios = require('axios');

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';

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

  const apiKey    = process.env.BREVO_API_KEY;
  const remitente = process.env.SMTP_FROM || process.env.EMAIL_FROM;
  if (!apiKey || !remitente) {
    console.warn('[Email] ⚠️ BREVO_API_KEY/SMTP_FROM no configurado, se omite envío');
    return;
  }

  const payload = {
    sender:      { email: remitente },
    to:          [{ email: destinatario }],
    subject:     ASUNTOS[tipo] || `Notificación: ${tipo}`,
    textContent: mensajeTexto,
  };

  if (adjunto?.content) {
    payload.attachment = [{
      content: adjunto.content.toString('base64'),
      name:    adjunto.filename || 'comprobante',
    }];
  }

  await axios.post(BREVO_API_URL, payload, {
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json', accept: 'application/json' },
    timeout: 10000,
  });
}

module.exports = { enviarNotificacion };
