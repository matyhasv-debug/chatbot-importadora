// src/services/chatbotController.js
const { emitirEvento, esModoHumano, actualizarEstadoCliente } = require('../routes/panel');
const db              = require('../config/database');
const geminiService   = require('./geminiService');
const bsaleService    = require('./bsaleService');
const followUpService = require('./followUpService');
const tenantService   = require('./tenantService');
const { enviarMensaje, enviarMenu } = require('./whatsappService');
const catalogoService = require('./catalogoService');

// ─── Notificación al dueño ────────────────────────────────────────────────────
async function notificarDueno(tipo, telefono, nombre, extra = '', config = null) {
  const DUENO_TEL = config?.credenciales?.notifTelefono || process.env.DUENO_WHATSAPP;
  if (!DUENO_TEL) return;

  const mensajes = {
    pago_detectado: `💰 *PAGO DETECTADO*\nCliente: ${nombre} (${telefono})\nMensaje: ${extra}`,
    comprobante:    `🧾 *COMPROBANTE RECIBIDO*\nCliente: ${nombre} (${telefono})\nRevisa el panel.`,
    error_bot:      `⚠️ *ERROR EN BOT*\nCliente: ${nombre} (${telefono})\nError: ${extra}`,
  };

  try {
    const { whatsappPhoneId, whatsappToken } = config?.credenciales || {};
    await enviarMensaje(DUENO_TEL, mensajes[tipo] || extra, whatsappPhoneId, whatsappToken);
  } catch (_) {}
}

// ─── Guardar mensaje en BD ────────────────────────────────────────────────────
function guardarMensaje(telefono, nombre, rol, mensaje, tenantId = null) {
  try {
    db.prepare(`INSERT INTO conversaciones (telefono, nombre, rol, mensaje, tenant_id) VALUES (?, ?, ?, ?, ?)`)
      .run(telefono, nombre, rol, mensaje, tenantId);
    emitirEvento('mensaje', {
      mensaje: { telefono, nombre, rol, mensaje, creado_en: new Date().toISOString() }
    });
  } catch (err) {
    console.error('[DB Error]:', err.message);
  }
}

// ─── Obtener historial de la BD ───────────────────────────────────────────────
function obtenerHistorial(telefono, tenantId, limite = 12) {
  try {
    return db.prepare(`
      SELECT rol, mensaje FROM conversaciones
      WHERE telefono = ? AND tenant_id = ?
      ORDER BY creado_en DESC LIMIT ?
    `).all(telefono, tenantId, limite).reverse();
  } catch (_) { return []; }
}

// ─── Registrar/actualizar cliente ─────────────────────────────────────────────
function registrarCliente(telefono, nombre, tenantId = null) {
  try {
    db.prepare(`
      INSERT INTO clientes (telefono, nombre, primer_pedido, tenant_id)
      VALUES (?, ?, datetime('now'), ?)
      ON CONFLICT(telefono) DO UPDATE SET
        nombre = COALESCE(excluded.nombre, nombre)
    `).run(telefono, nombre, tenantId);
  } catch (err) {
    console.error('[DB] registrarCliente:', err.message);
  }
}

// ─── Etapa de conversación ────────────────────────────────────────────────────
function getEtapa(telefono, tenantId) {
  return db.prepare(`SELECT etapa_conversacion FROM clientes WHERE telefono = ? AND tenant_id = ?`)
    .get(telefono, tenantId)?.etapa_conversacion || 'explorando';
}

function setEtapa(telefono, tenantId, etapa) {
  try {
    db.prepare(`UPDATE clientes SET etapa_conversacion = ? WHERE telefono = ? AND tenant_id = ?`)
      .run(etapa, telefono, tenantId);
    console.log(`[BOT] 🔄 Etapa ${telefono} → ${etapa}`);
  } catch (err) {
    console.error('[BOT] Error setEtapa:', err.message);
  }
}

// ─── Extraer cantidad del mensaje ─────────────────────────────────────────────
function extraerCantidad(texto) {
  const match = texto.match(/(\d+)\s*(unid|piezas?|cajas?|u\b)?/i);
  return match ? parseInt(match[1]) : 1;
}

// ─── Obtener contexto de Bsale ────────────────────────────────────────────────
async function obtenerContextoBsale(query, mayorista = false, telefono = '', nombre = '', config = null) {
  if (!query || query.length < 2) return '';
  console.log(`🔍 Buscando: "${query}" | mayorista: ${mayorista}`);

  const modo = config?.modoCatalogo || 'bsale';

  if (modo === 'manual') {
    const productos = catalogoService.buscarProductos(query, config.tenantId, mayorista);
    if (productos.length > 0) {
      console.log('✅ Productos encontrados en catálogo manual.');
      return catalogoService.formatearParaBot(productos, mayorista, config.mayorista?.minimoUnidades);
    }
    console.log('⚠️ Sin resultados en catálogo manual.');
    if (telefono) {
      await notificarDueno('error_bot', telefono, nombre,
        `❓ Cliente buscó "${query}" y no se encontró en catálogo.`, config);
    }
    return `No encontramos "${query}" en nuestro catálogo actualmente.`;
  }

  // modo === 'bsale' (default)
  const terminos = await geminiService.expandirTerminoBusqueda(query);
  let resultados = [];
  for (const termino of terminos) {
    resultados = await bsaleService.buscarConPreciosYStock(termino, mayorista, config?.credenciales?.bsaleToken);
    if (resultados?.length > 0) {
      console.log(`✅ Datos de Bsale obtenidos con término: "${termino}"`);
      break;
    }
  }
  if (resultados?.length > 0) {
    return bsaleService.formatearParaBot(resultados);
  }
  console.log('⚠️ Sin resultados en Bsale.');
  if (telefono) {
    await notificarDueno('error_bot', telefono, nombre,
      `❓ Cliente buscó "${query}" y no se encontró en Bsale.`, config);
  }
  return `No encontramos "${query}" en nuestro catálogo actualmente.`;
}

// ─── Detección automática de pago ─────────────────────────────────────────────
function detectarPagoEnTexto(texto) {
  return /comprobante|transfer[ei]|pag[ué]|ya pag|hice la transfer|realic[eé] el pago|te mand[oé] el comprobante|adjunto comprobante|acá el comprobante|acá te mando/.test(texto.toLowerCase());
}

function detectarComprobante(data) {
  if (data.tipo !== 'image') return false;
  const texto = (data.texto || data.payload || '').toLowerCase();
  return /comprobante|transfer|pag[ué]|recibo|voucher|depósito|deposito/.test(texto);
}

// ─── Detectar objeción de precio ──────────────────────────────────────────────
function detectarObjecionPrecio(texto) {
  return /caro|barato|descuento|rebaja|precio.*alto|muy.*caro|vi.*más barato|otro.*lado|compet|oferta|precio.*mejor|négoci|negoci/i.test(texto);
}

// ─── Embalajes desde config del tenant ───────────────────────────────────────
function buscarEnListaEmbalaje(query, embalajes = []) {
  if (!query) return null;
  const q = query.toLowerCase().trim();
  return embalajes.find(p =>
    p.nombre.toLowerCase().includes(q) || q.includes(p.nombre.toLowerCase().split(' ')[0])
  ) || null;
}

function formatearEmbalaje(prod) {
  return (
    `📦 *${prod.nombre}*\n` +
    `  • Unidades por caja: ${prod.unidades} u\n` +
    `  • Precio c/u: $${prod.precioUnitario.toLocaleString('es-CL')}\n` +
    `  • 💵 Total caja: $${prod.totalCaja.toLocaleString('es-CL')}`
  );
}

// ─── Procesador principal ─────────────────────────────────────────────────────
async function procesarMensaje(data) {
  const { telefono, nombre, texto: textoOriginal, payload, tipo, mediaInfo, phoneNumberId } = data;
  const texto = (payload || textoOriginal || '').trim();

  const config = tenantService.getConfigByPhoneId(phoneNumberId);
  if (!config) {
    console.error(`[BOT] ❌ Tenant no encontrado para phoneNumberId: ${phoneNumberId}`);
    return;
  }
  const { tenantId, empresa, garantia, envio, embalajes } = config;
  const { whatsappPhoneId, whatsappToken } = config.credenciales;

  try {

    if (esModoHumano(telefono)) {
      console.log(`[BOT] ⏸️  Modo humano activo para ${telefono} — bot pausado`);
      if (texto) guardarMensaje(telefono, nombre, 'user', texto, tenantId);
      if (mediaInfo && detectarComprobante(data)) {
        actualizarEstadoCliente(telefono, 'pago_pendiente');
      }
      return;
    }

    if (!texto && !mediaInfo) return;

    registrarCliente(telefono, nombre, tenantId);

    const textoParaGuardar = texto || `[${(tipo || 'media').toUpperCase()}]`;
    console.log(`[BOT] 📩 ${nombre} (${telefono}): ${textoParaGuardar}`);
    guardarMensaje(telefono, nombre, 'user', textoParaGuardar, tenantId);

    if (texto && detectarPagoEnTexto(texto)) {
      actualizarEstadoCliente(telefono, 'pago_pendiente');
      followUpService.cancelarSeguimientos(telefono, tenantId);
      console.log(`[BOT] 💰 Pago detectado de ${telefono}`);
      await notificarDueno('pago_detectado', telefono, nombre, texto.slice(0, 100), config);
    } else if (mediaInfo && detectarComprobante(data)) {
      actualizarEstadoCliente(telefono, 'pago_pendiente');
      followUpService.cancelarSeguimientos(telefono, tenantId);
      console.log(`[BOT] 🧾 Comprobante recibido de ${telefono}`);
      await notificarDueno('comprobante', telefono, nombre, '', config);
    }

    if (!texto) {
      if (mediaInfo?.tipo === 'image') {
        await enviarMensaje(telefono, '¡Gracias por tu imagen! 📸 La revisaremos pronto. ¿Hay algo más en que te podamos ayudar?', whatsappPhoneId, whatsappToken);
      } else if (mediaInfo?.tipo === 'audio' || mediaInfo?.tipo === 'voice') {
        await enviarMensaje(telefono, '¡Recibí tu audio! 🎙️ Por favor escríbeme tu consulta para ayudarte mejor 😊', whatsappPhoneId, whatsappToken);
      } else if (mediaInfo?.tipo === 'document') {
        await enviarMensaje(telefono, '¡Documento recibido! 📄 Lo revisaremos. ¿Necesitas algo más?', whatsappPhoneId, whatsappToken);
      }
      return;
    }

    if (payload === 'ver_productos') {
      const respuesta = '🛍️ *¿Qué producto estás buscando?*\n\nEscríbeme el nombre y te busco precio y stock al instante.\n\nEjemplos: _"focos solares"_, _"cámara de seguridad"_, _"hervidor"_ 😊';
      await enviarMensaje(telefono, respuesta, whatsappPhoneId, whatsappToken);
      guardarMensaje(telefono, nombre, 'assistant', respuesta, tenantId);
      return;
    }

    if (payload === 'mis_pedidos') {
      const respuesta = '📦 *Tus pedidos*\n\nPara revisar el estado de tu pedido, indícame:\n• Tu nombre completo\n• O el producto que compraste\n\n¡Te ayudo de inmediato! 😊';
      await enviarMensaje(telefono, respuesta, whatsappPhoneId, whatsappToken);
      guardarMensaje(telefono, nombre, 'assistant', respuesta, tenantId);
      return;
    }

    if (payload === 'contacto') {
      const respuesta = `📞 *Contáctanos*\n\n📍 ${empresa.direccion}\n🕐 ${empresa.horario}\n❌ Domingos ${empresa.domingos ? 'abierto' : 'cerrado'}\n\n¡También puedes escribirnos aquí! 😊`;
      await enviarMensaje(telefono, respuesta, whatsappPhoneId, whatsappToken);
      guardarMensaje(telefono, nombre, 'assistant', respuesta, tenantId);
      return;
    }

    if (payload === 'precios_embalaje') {
      const listaFormateada = embalajes.map(formatearEmbalaje).join('\n\n');
      const respuesta =
        '📦 *Precios por Caja Cerrada (Embalaje Mayorista)*\n\n' +
        listaFormateada +
        '\n\n_Precios por unidad dentro de la caja. Total es por caja completa._\n¿Te interesa alguno? 😊';
      await enviarMensaje(telefono, respuesta, whatsappPhoneId, whatsappToken);
      guardarMensaje(telefono, nombre, 'assistant', respuesta, tenantId);
      return;
    }

    const historial = obtenerHistorial(telefono, tenantId);
    const etapa     = getEtapa(telefono, tenantId);
    const intencion = await geminiService.detectarIntencion(texto, historial);
    console.log(`[BOT] 🎯 Intención: ${intencion} | Etapa: ${etapa}`);

    let respuesta     = '';
    let contextoExtra = '';

    if (detectarObjecionPrecio(texto)) {
      contextoExtra = `El cliente dice que el precio le parece alto o que lo vio más barato.
1. NO bajas el precio.
2. Destaca: garantía ${garantia.meses} meses, envío rápido ${envio.tiempo}, producto con boleta.
3. Si insiste, ofrece consultar con el equipo por una promoción (sin prometer nada).
4. Mantén tono amigable.`;
      respuesta = await geminiService.generarRespuesta(texto, historial, contextoExtra, telefono, config);
      if (respuesta) {
        await enviarMensaje(telefono, respuesta, whatsappPhoneId, whatsappToken);
        guardarMensaje(telefono, nombre, 'assistant', respuesta, tenantId);
      }
      return;
    }

    switch (intencion) {

      case 'SALUDO': {
        const esConocido = db.prepare('SELECT 1 FROM clientes WHERE telefono = ? AND tenant_id = ?').get(telefono, tenantId);
        if (esConocido) {
          respuesta = await geminiService.generarRespuesta(texto, historial, '', telefono, config);
        } else {
          const nombreAsistente = geminiService.obtenerNombreAsistente(telefono, config.asistentes);
          respuesta = `¡Hola ${nombre.split(' ')[0]}! 👋😊 Bienvenido a *${empresa.nombre}*.\nSoy ${nombreAsistente}, tu asistente virtual. ¿Qué estás buscando hoy?`;
          await enviarMensaje(telefono, respuesta, whatsappPhoneId, whatsappToken);
          guardarMensaje(telefono, nombre, 'assistant', respuesta, tenantId);
          await enviarMensaje(telefono,
            '¿En qué te puedo ayudar? 😊\n\n' +
            '1️⃣ *Ver productos y precios*\n' +
            '2️⃣ *Precios Embalaje* — cajas mayoristas 📦\n' +
            '3️⃣ *Mis pedidos*\n' +
            '4️⃣ *Contacto y horarios*\n\n' +
            'O escríbeme directamente lo que necesitas 🚀',
            whatsappPhoneId, whatsappToken
          );
          await enviarMenu(telefono, whatsappPhoneId, whatsappToken);
          return;
        }
        break;
      }

      case 'BUSCAR_PRODUCTO': {
        setEtapa(telefono, tenantId, 'explorando');
        actualizarEstadoCliente(telefono, 'consultando');
        const producto = await geminiService.extraerProductoConIA(texto, historial);
        if (!producto || producto.length < 3) {
          respuesta = await geminiService.generarRespuesta(texto, historial, '', telefono, config);
          break;
        }
        contextoExtra = await obtenerContextoBsale(producto, false, telefono, nombre, config);
        respuesta     = await geminiService.generarRespuesta(texto, historial, contextoExtra, telefono, config);
        followUpService.programarSeguimiento(telefono, 'follow_up_precio', 180, tenantId);
        break;
      }

      case 'PRECIO_EMBALAJE': {
        const producto   = await geminiService.extraerProductoConIA(texto, historial);
        const encontrado = buscarEnListaEmbalaje(producto, embalajes);
        if (encontrado) {
          respuesta =
            `¡Claro! 📦 Aquí tienes la info de la caja:\n\n` +
            formatearEmbalaje(encontrado) +
            `\n\n⚠️ Para consultas sobre colores, modelos o fotos visita ${config.empresa.web}\n\n¿Te gustaría apartar esta caja? Te doy los datos de pago 😊`;
          setEtapa(telefono, tenantId, 'cotizando');
          followUpService.programarSeguimiento(telefono, 'follow_up_precio', 240, tenantId);
        } else {
          contextoExtra = await obtenerContextoBsale(producto, true, telefono, nombre, config);
          respuesta = await geminiService.generarRespuesta(texto, historial, contextoExtra, telefono, config);
        }
        break;
      }

      case 'PRECIO_MAYORISTA': {
        const cantidad = extraerCantidad(texto);
        const producto = await geminiService.extraerProductoConIA(texto, historial);
        const esMayor  = cantidad >= bsaleService.MINIMO_MAYORISTA;
        contextoExtra  = await obtenerContextoBsale(producto, esMayor, telefono, nombre, config);
        contextoExtra += esMayor
          ? `\n\nEl cliente quiere ${cantidad} unidades — mostrar precio mayorista.`
          : `\n\nEl cliente quiere ${cantidad} unidades — precio unitario aplica. Mencionar que desde ${bsaleService.MINIMO_MAYORISTA} unidades hay precio mayorista.`;
        respuesta = await geminiService.generarRespuesta(texto, historial, contextoExtra, telefono, config);
        followUpService.programarSeguimiento(telefono, 'follow_up_precio', 180, tenantId);
        break;
      }

      case 'HACER_PEDIDO': {
        actualizarEstadoCliente(telefono, 'cotizado');
        const cantidad = extraerCantidad(texto);
        const producto = await geminiService.extraerProductoConIA(texto, historial);
        const esMayor  = cantidad >= bsaleService.MINIMO_MAYORISTA;
        if (producto.length > 1) contextoExtra = await obtenerContextoBsale(producto, esMayor, telefono, nombre, config);
        contextoExtra +=
          `\n\nEl cliente quiere hacer un pedido de ${cantidad} unidad(es) de "${producto}".
INSTRUCCIÓN: Muestra el resumen del pedido:
📋 *Resumen de tu pedido:*
- Producto: [nombre]
- Cantidad: ${cantidad} unidad(es)
- Precio: $[precio]
- Envío: Por pagar al recibir (${envio.courier} 🚚)
━━━━━━━━━━━━━━━━
💵 *Total a transferir: $[precio]*
Luego pregunta: "¿Confirmamos? 😊" — NO des datos bancarios todavía.`;
        respuesta = await geminiService.generarRespuesta(texto, historial, contextoExtra, telefono, config);
        setEtapa(telefono, tenantId, 'cotizando');
        break;
      }

      case 'CONFIRMAR':
      case 'CONFIRMAR_PEDIDO': {
        if (etapa === 'cotizando') {
          const prodAnterior = await geminiService.extraerProductoConIA(texto || '', historial);
          if (prodAnterior.length > 1) contextoExtra = await obtenerContextoBsale(prodAnterior, false, telefono, nombre, config);
          contextoExtra +=
            '\n\nEl cliente confirmó el pedido. Entrega los datos de transferencia completos.\n' +
            `Menciona que el envío se paga aparte al recibir (${envio.courier}). Pide el comprobante por WhatsApp.`;
          respuesta = await geminiService.generarRespuesta(texto, historial, contextoExtra, telefono, config);
          setEtapa(telefono, tenantId, 'pagando');
          followUpService.cancelarSeguimientos(telefono, tenantId);
          followUpService.programarSeguimiento(telefono, 'pago_recordatorio', 120, tenantId);
        } else {
          const prodAnterior = await geminiService.extraerProductoConIA(texto || '', historial);
          if (prodAnterior && prodAnterior.length > 2) {
            contextoExtra = await obtenerContextoBsale(prodAnterior, false, telefono, nombre, config);
            contextoExtra += `\n\nEl cliente quiere ${texto} unidad(es) de "${prodAnterior}". Confirma disponibilidad, muestra resumen del pedido con precio y pregunta "¿Confirmamos? 😊". NO des datos bancarios todavía.`;
            setEtapa(telefono, tenantId, 'cotizando');
          }
          respuesta = await geminiService.generarRespuesta(texto, historial, contextoExtra, telefono, config);
        }
        break;
      }

      case 'TRANSFERENCIA': {
        if (etapa === 'cotizando' || etapa === 'pagando') {
          contextoExtra = 'El cliente pregunta por datos de pago. Entrega los datos bancarios completos.';
          setEtapa(telefono, tenantId, 'pagando');
        } else {
          contextoExtra = 'El cliente pregunta por datos de pago pero no hay pedido confirmado. Pregúntale qué producto quiere comprar antes de dar los datos bancarios.';
        }
        respuesta = await geminiService.generarRespuesta(texto, historial, contextoExtra, telefono, config);
        break;
      }

      case 'ENVIO':
      case 'PAGO':
      case 'GARANTIA':
      case 'HORARIO': {
        respuesta = await geminiService.generarRespuesta(texto, historial, '', telefono, config);
        break;
      }

      case 'AYUDA': {
        await enviarMenu(telefono, whatsappPhoneId, whatsappToken);
        respuesta = '¡Aquí tienes las opciones! 👆 También puedes escribirme directamente lo que necesitas 😊';
        break;
      }

      default: {
        const prodAnterior = await geminiService.extraerProductoConIA(texto, historial);
        if (prodAnterior && prodAnterior.length > 2) {
          const cantidad = extraerCantidad(texto);
          const esMayor  = cantidad >= bsaleService.MINIMO_MAYORISTA;
          contextoExtra  = await obtenerContextoBsale(prodAnterior, esMayor, telefono, nombre, config);
        }
        respuesta = await geminiService.generarRespuesta(texto, historial, contextoExtra, telefono, config);
        break;
      }
    }

    if (respuesta) {
      await enviarMensaje(telefono, respuesta, whatsappPhoneId, whatsappToken);
      guardarMensaje(telefono, nombre, 'assistant', respuesta, tenantId);
      console.log(`[BOT] ✅ Respuesta enviada a ${nombre}`);
    }

  } catch (err) {
    console.error('[BOT] ❌ Error crítico:', err.message);
    try {
      await notificarDueno('error_bot', data.telefono, data.nombre, err.message, config);
      await enviarMensaje(data.telefono, '😅 Tuve un problema técnico. ¡Ya avisé al equipo! Intenta de nuevo en un momento.', whatsappPhoneId, whatsappToken);
    } catch (_) {}
  }
}

module.exports = { procesarMensaje };
