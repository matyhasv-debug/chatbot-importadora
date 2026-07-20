// src/services/emailService.js
const nodemailer = require('nodemailer');

let transporter;
let transporterConfigurado = false;

function getTransporter() {
  if (transporterConfigurado) return transporter;
  transporterConfigurado = true;

  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    transporter = null;
    return null;
  }

  transporter = nodemailer.createTransport({
    host:   SMTP_HOST,
    port:   Number(SMTP_PORT) || 587,
    secure: Number(SMTP_PORT) === 465,
    auth:   { user: SMTP_USER, pass: SMTP_PASS },
  });
  return transporter;
}

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
  const tr = getTransporter();
  if (!tr) {
    console.warn('[Email] ⚠️ SMTP no configurado (SMTP_HOST/SMTP_USER/SMTP_PASS), se omite envío');
    return;
  }

  const mailOptions = {
    from:    process.env.SMTP_FROM || process.env.SMTP_USER,
    to:      destinatario,
    subject: ASUNTOS[tipo] || `Notificación: ${tipo}`,
    text:    mensajeTexto,
  };

  if (adjunto?.content) {
    mailOptions.attachments = [{
      filename:    adjunto.filename || 'comprobante',
      content:     adjunto.content,
      contentType: adjunto.mime || 'application/octet-stream',
    }];
  }

  await tr.sendMail(mailOptions);
}

module.exports = { enviarNotificacion };
