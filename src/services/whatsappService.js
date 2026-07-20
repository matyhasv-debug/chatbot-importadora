// src/services/whatsappService.js
const axios = require('axios');

function crearApiWA(phoneId, token) {
  return axios.create({
    baseURL: `https://graph.facebook.com/v18.0/${phoneId || process.env.WHATSAPP_PHONE_ID}`,
    headers: {
      Authorization: `Bearer ${token || process.env.WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });
}

async function enviarMensaje(telefono, texto, phoneId = null, token = null) {
  const api = crearApiWA(phoneId, token);
  let ultimoError;
  for (let intento = 1; intento <= 3; intento++) {
    try {
      await api.post('/messages', {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: telefono,
        type: 'text',
        text: { preview_url: false, body: texto },
      });
      console.log(`[WA] ✅ Mensaje enviado a ${telefono}${intento > 1 ? ` (intento ${intento})` : ''}`);
      return;
    } catch (err) {
      ultimoError = err;
      const status = err.response?.status;
      // No reintentar errores permanentes (credenciales, número inválido, etc.)
      if (status === 401 || status === 400) break;
      if (intento < 3) {
        console.warn(`[WA] Reintento ${intento}/3 para ${telefono} — ${err.response?.data?.error?.message || err.message}`);
        await new Promise(r => setTimeout(r, intento * 1500));
      }
    }
  }
  console.error(`[WA] ❌ Error enviando a ${telefono}:`, ultimoError.response?.data || ultimoError.message);
  throw ultimoError;
}

async function reenviarMedia(destino, mediaId, tipo, caption, phoneId = null, token = null) {
  const api = crearApiWA(phoneId, token);
  const tipoWA = tipo === 'document' ? 'document' : 'image';
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: destino,
    type: tipoWA,
    [tipoWA]: { id: mediaId, caption: caption || '' },
  };
  try {
    await api.post('/messages', payload);
    console.log(`[WA] ✅ Media reenviada a ${destino}`);
  } catch (err) {
    console.error(`[WA] ❌ Error reenviando media a ${destino}:`, err.response?.data || err.message);
  }
}

// ─── Descargar bytes de un media de WhatsApp (para adjuntar en email, etc.) ───
async function descargarMedia(mediaId, phoneId = null, token = null) {
  const tok = token || process.env.WHATSAPP_TOKEN;
  const { data: meta } = await axios.get(`https://graph.facebook.com/v18.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${tok}` },
  });
  const { data: binario } = await axios.get(meta.url, {
    headers: { Authorization: `Bearer ${tok}` },
    responseType: 'arraybuffer',
  });
  const ext = (meta.mime_type || '').split('/')[1]?.split(';')[0] || 'bin';
  return { filename: `comprobante.${ext}`, content: Buffer.from(binario), mime: meta.mime_type };
}

async function marcarLeido(messageId, phoneId = null, token = null) {
  const api = crearApiWA(phoneId, token);
  try {
    await api.post('/messages', {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
    });
  } catch (_) {}
}

async function enviarBotonesConfirmar(telefono, phoneId = null, token = null) {
  const api = crearApiWA(phoneId, token);
  try {
    await api.post('/messages', {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: telefono,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: '¿Qué quieres hacer? 😊' },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'confirmar_pedido', title: '✅ Lo quiero comprar' } },
            { type: 'reply', reply: { id: 'mas_info',         title: '❓ Tengo más dudas'  } },
          ],
        },
      },
    });
  } catch (_) {}
}

async function enviarMenu(telefono, phoneId = null, token = null) {
  const api = crearApiWA(phoneId, token);
  try {
    await api.post('/messages', {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: telefono,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: '¿En qué te puedo ayudar? 😊' },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'ver_productos',    title: '🛍️ Ver productos' } },
            { type: 'reply', reply: { id: 'precios_embalaje', title: '📦 Embalajes'     } },
            { type: 'reply', reply: { id: 'contacto',         title: '📞 Contacto'      } },
          ],
        },
      },
    });
  } catch (err) {
    await enviarMensaje(telefono,
      '¿En qué te puedo ayudar hoy? 👋😊\n\n' +
      '1️⃣ *Ver productos y precios*\n' +
      '2️⃣ *Precios Embalaje* 📦\n' +
      '3️⃣ *Mis pedidos*\n' +
      '4️⃣ *Contacto*\n\n' +
      'Escríbeme directamente lo que necesitas 🚀',
      phoneId, token
    );
  }
}

function parsearWebhook(body) {
  try {
    const entry   = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value   = changes?.value;
    const message = value?.messages?.[0];
    const contact = value?.contacts?.[0];

    if (!message) return null;

    let mediaInfo = null;

    if (message.type === 'image' && message.image) {
      mediaInfo = { tipo: 'image', media_id: message.image.id, caption: message.image.caption || '', mime: message.image.mime_type };
    } else if (message.type === 'audio' && message.audio) {
      mediaInfo = { tipo: 'audio', media_id: message.audio.id, mime: message.audio.mime_type };
    } else if (message.type === 'voice' && message.audio) {
      mediaInfo = { tipo: 'voice', media_id: message.audio.id, mime: message.audio.mime_type };
    } else if (message.type === 'video' && message.video) {
      mediaInfo = { tipo: 'video', media_id: message.video.id, caption: message.video.caption || '', mime: message.video.mime_type };
    } else if (message.type === 'document' && message.document) {
      mediaInfo = { tipo: 'document', media_id: message.document.id, filename: message.document.filename || 'documento', caption: message.document.caption || '', mime: message.document.mime_type };
    } else if (message.type === 'sticker' && message.sticker) {
      mediaInfo = { tipo: 'sticker', media_id: message.sticker.id, mime: message.sticker.mime_type };
    } else if (message.type === 'location' && message.location) {
      mediaInfo = { tipo: 'location', latitude: message.location.latitude, longitude: message.location.longitude, name: message.location.name || '', address: message.location.address || '' };
    }

    return {
      messageId:     message.id,
      telefono:      message.from,
      nombre:        contact?.profile?.name || 'Cliente',
      tipo:          message.type,
      phoneNumberId: value?.metadata?.phone_number_id,
      texto:         message.type === 'text'
                       ? message.text?.body
                       : message.type === 'image' && message.image?.caption
                         ? message.image.caption
                         : mediaInfo ? `[${message.type.toUpperCase()}]` : null,
      payload:       message.type === 'interactive'
                       ? (message.interactive?.button_reply?.id || message.interactive?.list_reply?.id || null)
                       : null,
      mediaInfo,
      timestamp:     message.timestamp,
    };
  } catch (err) {
    console.error('[WA] Error parseando webhook:', err.message);
    return null;
  }
}

module.exports = { enviarMensaje, marcarLeido, enviarMenu, enviarBotonesConfirmar, parsearWebhook, reenviarMedia, descargarMedia };
