// src/services/chatbotController.js
const { emitirEvento, esModoHumano, actualizarEstadoCliente } = require('../routes/panel');
const db              = require('../config/database');
const geminiService   = require('./geminiService');
const bsaleService    = require('./bsaleService');
const followUpService = require('./followUpService');
const tenantService   = require('./tenantService');
const { enviarMensaje, enviarMenu, enviarBotonesConfirmar } = require('./whatsappService');
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

// ─── Extrae nombre de producto desde URL de la web propia ────────────────────
function extraerProductoDeURL(texto, webBase) {
  if (!webBase || !texto) return null;
  const dominio = webBase.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '').toLowerCase();
  const urlMatch = texto.match(/https?:\/\/[^\s]+/i);
  if (!urlMatch) return null;
  const url = urlMatch[0].toLowerCase();
  if (!url.includes(dominio)) return null;
  try {
    const slug = new URL(url).pathname.replace(/^\//, '').split('/')[0];
    if (!slug || slug.length < 3) return null;
    return slug.replace(/-/g, ' ').trim();
  } catch {
    return null;
  }
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
    return null;
  }

  // modo === 'bsale' (default)
  // Siempre intentar primero el término original, luego las variantes IA
  const terminosIA = await geminiService.expandirTerminoBusqueda(query);
  const terminos = [query, ...terminosIA.filter(t => t.toLowerCase() !== query.toLowerCase())];
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
  return null;
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
        actualizarEstadoCliente(telefono, 'pago_pendiente', tenantId);
      }
      return;
    }

    if (!texto && !mediaInfo) return;

    registrarCliente(telefono, nombre, tenantId);

    const textoParaGuardar = texto || `[${(tipo || 'media').toUpperCase()}]`;
    console.log(`[BOT] 📩 ${nombre} (${telefono}): ${textoParaGuardar}`);
    guardarMensaje(telefono, nombre, 'user', textoParaGuardar, tenantId);

    if (texto && detectarPagoEnTexto(texto)) {
      actualizarEstadoCliente(telefono, 'pago_pendiente', tenantId);
      followUpService.cancelarSeguimientos(telefono, tenantId);
      console.log(`[BOT] 💰 Pago detectado de ${telefono}`);
      await notificarDueno('pago_detectado', telefono, nombre, texto.slice(0, 100), config);
    } else if (mediaInfo && detectarComprobante(data)) {
      actualizarEstadoCliente(telefono, 'pago_pendiente', tenantId);
      followUpService.cancelarSeguimientos(telefono, tenantId);
      console.log(`[BOT] 🧾 Comprobante recibido de ${telefono}`);
      await notificarDueno('comprobante', telefono, nombre, '', config);
    }

    // Imágenes/audio/video sin caption llegan como texto "[IMAGE]", "[AUDIO]", etc.
    const textoEsMedia = !texto || /^\[(IMAGE|AUDIO|VOICE|VIDEO|DOCUMENT|STICKER|LOCATION)\]$/.test(texto);
    if (textoEsMedia) {
      if (mediaInfo?.tipo === 'image') {
        await enviarMensaje(telefono, 'No puedo ver imágenes directamente 📸 Si querés consultar por un producto, escribime su nombre y lo busco enseguida 😊', whatsappPhoneId, whatsappToken);
      } else if (mediaInfo?.tipo === 'audio' || mediaInfo?.tipo === 'voice') {
        await enviarMensaje(telefono, '¡Recibí tu audio! 🎙️ Por favor escríbeme tu consulta para ayudarte mejor 😊', whatsappPhoneId, whatsappToken);
      } else if (mediaInfo?.tipo === 'document') {
        await enviarMensaje(telefono, '¡Documento recibido! 📄 Lo revisaremos. ¿Necesitas algo más?', whatsappPhoneId, whatsappToken);
      }
      return;
    }

    // Cliente quiere ser revendedor → notificar al dueño como lead mayorista
    if (/quiero (vender|revender|ofrecer|comercializar)|soy (revendedor|distribuidor|mayorista|comerciante)|para (vender|revender|ofrecer).*(productos|artículos)|acceso.*imágenes.*(vender|ofrecer|revender)|catálogo.*(descargable|descargar|digital)|ser (proveedor|distribuidor)/i.test(texto)) {
      await notificarDueno('lead_mayorista', telefono, nombre, `Posible revendedor interesado. Mensaje: "${texto.slice(0, 150)}"`, config);
      const respRevend = `¡Gracias por tu interés en trabajar con nosotros! 😊 Esto lo maneja directamente nuestro equipo. Ya les avisé y te contactarán a la brevedad para darte toda la información.\n\n📍 También puedes pasar por ${empresa.direccion}\n🕐 ${empresa.horario}`;
      await enviarMensaje(telefono, respRevend, whatsappPhoneId, whatsappToken);
      guardarMensaje(telefono, nombre, 'assistant', respRevend, tenantId);
      return;
    }

    // Cliente pide hablar con una persona → notificar al dueño y pausar bot
    if (/hablar con (una? )?(persona|humano|alguien|encargado|dueño|vendedor|asesor)|necesito (un )?humano|quiero (un )?asesor|atención (humana|personal)|no (quiero|me gusta) (hablar con )?(el |un )?bot/i.test(texto)) {
      await notificarDueno('solicitud_humano', telefono, nombre, `El cliente solicitó hablar con una persona. Último mensaje: "${texto}"`, config);
      const respHumano = `Entendido 😊 Ya avisé a nuestro equipo. Un(a) asesor(a) de *${empresa.nombre}* te contactará a la brevedad en este mismo chat.\n\n📍 También puedes visitarnos en ${empresa.direccion}\n🕐 ${empresa.horario}`;
      await enviarMensaje(telefono, respHumano, whatsappPhoneId, whatsappToken);
      guardarMensaje(telefono, nombre, 'assistant', respHumano, tenantId);
      return;
    }

    // URLs externas (Instagram, YouTube, etc.) → preguntar qué producto es
    if (/https?:\/\/[^\s]+/i.test(texto) && !extraerProductoDeURL(texto, config.empresa.web)) {
      const respURL = `Veo que enviaste un link 😊 ¿Qué producto te interesa? Escríbeme el nombre y lo busco en nuestro catálogo 🔍`;
      await enviarMensaje(telefono, respURL, whatsappPhoneId, whatsappToken);
      guardarMensaje(telefono, nombre, 'assistant', respURL, tenantId);
      return;
    }

    // Si el cliente mandó una URL de la web propia, extraer el producto del slug y buscar en Bsale
    const productoDeURL = extraerProductoDeURL(texto, config.empresa.web);
    if (productoDeURL) {
      console.log(`[BOT] 🔗 URL propia detectada → producto: "${productoDeURL}"`);
      const historialURL = obtenerHistorial(telefono, tenantId);
      const ctxURL = await obtenerContextoBsale(productoDeURL, false, telefono, nombre, config);
      if (ctxURL === null) {
        const resp = `Busqué *"${productoDeURL}"* en nuestro catálogo y actualmente no lo tenemos disponible 😕 ¿Te puedo ayudar con otro producto?`;
        await enviarMensaje(telefono, resp, whatsappPhoneId, whatsappToken);
        guardarMensaje(telefono, nombre, 'assistant', resp, tenantId);
        return;
      }
      setEtapa(telefono, tenantId, 'explorando');
      const respURL = await geminiService.generarRespuesta(texto, historialURL, ctxURL, telefono, config);
      if (respURL) {
        await enviarMensaje(telefono, respURL, whatsappPhoneId, whatsappToken);
        guardarMensaje(telefono, nombre, 'assistant', respURL, tenantId);
        if (/💵/.test(ctxURL)) await enviarBotonesConfirmar(telefono, whatsappPhoneId, whatsappToken);
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

    if (payload === 'confirmar_pedido') {
      const historial2 = obtenerHistorial(telefono, tenantId);
      const prodAnterior = await geminiService.extraerProductoConIA('quiero comprarlo', historial2);
      let ctxConfirmar = '';
      if (prodAnterior && prodAnterior.length > 2) {
        const bsaleCtx = await obtenerContextoBsale(prodAnterior, false, telefono, nombre, config);
        if (bsaleCtx && /💵/.test(bsaleCtx)) {
          // Hay stock — proceder con confirmación
          ctxConfirmar = bsaleCtx;
        } else {
          // Sin stock — informar al cliente sin intentar confirmar
          const sinStockResp = `Lo siento, ese producto no está disponible en este momento 😕. ¿Te puedo ayudar a buscar otra opción?`;
          await enviarMensaje(telefono, sinStockResp, whatsappPhoneId, whatsappToken);
          guardarMensaje(telefono, nombre, 'assistant', sinStockResp, tenantId);
          return;
        }
      }
      ctxConfirmar += '\n\nEl cliente confirmó que quiere comprar. Muestra el resumen del pedido con precio y pregunta "¿Confirmamos? 😊". NO des datos bancarios todavía.';
      const respuesta = await geminiService.generarRespuesta('quiero comprarlo', historial2, ctxConfirmar, telefono, config);
      setEtapa(telefono, tenantId, 'cotizando');
      await enviarMensaje(telefono, respuesta, whatsappPhoneId, whatsappToken);
      guardarMensaje(telefono, nombre, 'assistant', respuesta, tenantId);
      return;
    }

    if (payload === 'mas_info') {
      const historial2 = obtenerHistorial(telefono, tenantId);
      const respuesta = await geminiService.generarRespuesta('tengo más dudas', historial2, '', telefono, config);
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

    // Nota para el AI cuando el cliente adjuntó una imagen con texto (caption)
    const ctxImagen = (mediaInfo?.tipo === 'image')
      ? '\n\nCRÍTICO: El cliente adjuntó una imagen a este mensaje. NO puedes verla ni analizar su contenido. NUNCA afirmes que identificaste algo en ella. Si pregunta qué hay en la imagen, dile honestamente que no puedes verla y pídele que escriba el nombre del producto.'
      : '';

    // Si ya está en etapa de pago, no volver al flujo de búsqueda/resumen
    if (etapa === 'pagando') {
      const ctxPagando = `El cliente ya tiene un pedido confirmado en proceso de pago o despacho.
Su mensaje actual: "${texto}"
INSTRUCCIONES según lo que envió:
• Datos de envío (nombre, RUT, teléfono, dirección, región, comuna): Confirma que recibiste los datos y que coordinarás el despacho a la brevedad.
• Pregunta por estado del pedido: Infórmale que está siendo procesado y que le avisarán.
• Otra consulta distinta: Atiéndela, pero no repitas el resumen del pedido anterior.
PROHIBIDO: Volver a mostrar el resumen del pedido. Pedir que confirmen de nuevo. Dar los datos bancarios otra vez.${ctxImagen}`;
      const resp = await geminiService.generarRespuesta(texto, historial, ctxPagando, telefono, config);
      if (resp) {
        await enviarMensaje(telefono, resp, whatsappPhoneId, whatsappToken);
        guardarMensaje(telefono, nombre, 'assistant', resp, tenantId);
      }
      return;
    }

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
          const productoEnSaludo = await geminiService.extraerProductoConIA(texto, historial);
          if (productoEnSaludo && productoEnSaludo.length > 2) {
            const ctx = await obtenerContextoBsale(productoEnSaludo, false, telefono, nombre, config);
            if (ctx === null) {
              respuesta = `¡Hola! 👋 No encontramos "${productoEnSaludo}" en nuestro catálogo actualmente. ¿Buscas otro producto o necesitas algo más? 😊`;
            } else {
              const respSaludo = await geminiService.generarRespuesta(texto, historial, ctx, telefono, config);
              followUpService.programarSeguimiento(telefono, 'follow_up_precio', 180, tenantId);
              if (respSaludo) {
                await enviarMensaje(telefono, respSaludo, whatsappPhoneId, whatsappToken);
                guardarMensaje(telefono, nombre, 'assistant', respSaludo, tenantId);
                await enviarBotonesConfirmar(telefono, whatsappPhoneId, whatsappToken);
              }
              break;
            }
          } else {
            respuesta = await geminiService.generarRespuesta(texto, historial, '', telefono, config);
          }
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
        actualizarEstadoCliente(telefono, 'consultando', tenantId);
        const producto = await geminiService.extraerProductoConIA(texto, historial);
        if (!producto || producto.length < 3) {
          respuesta = await geminiService.generarRespuesta(texto, historial, '', telefono, config);
          break;
        }
        contextoExtra = await obtenerContextoBsale(producto, false, telefono, nombre, config);
        if (contextoExtra === null) {
          respuesta = `No encontramos "${producto}" en nuestro catálogo actualmente. ¿Buscas otro producto o necesitas algo más? 😊`;
          break;
        }
        respuesta = await geminiService.generarRespuesta(texto, historial, contextoExtra + ctxImagen, telefono, config);
        followUpService.programarSeguimiento(telefono, 'follow_up_precio', 180, tenantId);
        if (respuesta) {
          await enviarMensaje(telefono, respuesta, whatsappPhoneId, whatsappToken);
          guardarMensaje(telefono, nombre, 'assistant', respuesta, tenantId);
          // Solo mostrar botón de compra si hay stock real (contexto contiene precio 💵)
          if (/💵/.test(contextoExtra)) {
            await enviarBotonesConfirmar(telefono, whatsappPhoneId, whatsappToken);
          }
          respuesta = '';
        }
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
          if (contextoExtra === null) {
            respuesta = `No encontramos "${producto || 'ese embalaje'}" en nuestro catálogo. ¿Buscas otro producto? 😊`;
          } else {
            respuesta = await geminiService.generarRespuesta(texto, historial, contextoExtra, telefono, config);
          }
        }
        break;
      }

      case 'PRECIO_MAYORISTA': {
        const cantidad = extraerCantidad(texto);
        const producto = await geminiService.extraerProductoConIA(texto, historial);
        const esMayor  = cantidad >= bsaleService.MINIMO_MAYORISTA;
        contextoExtra  = await obtenerContextoBsale(producto, esMayor, telefono, nombre, config);
        if (contextoExtra === null) {
          respuesta = `No encontramos "${producto}" en nuestro catálogo actualmente. ¿Buscas otro producto? 😊`;
          break;
        }
        contextoExtra += esMayor
          ? `\n\nEl cliente quiere ${cantidad} unidades — mostrar precio mayorista.`
          : `\n\nEl cliente quiere ${cantidad} unidades — precio unitario aplica. Mencionar que desde ${bsaleService.MINIMO_MAYORISTA} unidades hay precio mayorista.`;
        respuesta = await geminiService.generarRespuesta(texto, historial, contextoExtra, telefono, config);
        followUpService.programarSeguimiento(telefono, 'follow_up_precio', 180, tenantId);
        break;
      }

      case 'HACER_PEDIDO': {
        actualizarEstadoCliente(telefono, 'cotizado', tenantId);
        const cantidad = extraerCantidad(texto);
        const producto = await geminiService.extraerProductoConIA(texto, historial);
        const esMayor  = cantidad >= bsaleService.MINIMO_MAYORISTA;
        if (producto.length > 1) {
          const bsaleCtx = await obtenerContextoBsale(producto, esMayor, telefono, nombre, config);
          if (bsaleCtx === null) {
            respuesta = `No encontramos "${producto}" en nuestro catálogo actualmente. ¿Puedes confirmar el nombre exacto del producto? 😊`;
            break;
          }
          contextoExtra = bsaleCtx;
        }
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
          if (prodAnterior.length > 1) {
            const bsaleCtx = await obtenerContextoBsale(prodAnterior, false, telefono, nombre, config);
            if (bsaleCtx !== null) contextoExtra = bsaleCtx;
          }
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
            const bsaleCtx = await obtenerContextoBsale(prodAnterior, false, telefono, nombre, config);
            if (bsaleCtx !== null) {
              contextoExtra = bsaleCtx + `\n\nEl cliente quiere ${texto} unidad(es) de "${prodAnterior}". Confirma disponibilidad, muestra resumen del pedido con precio y pregunta "¿Confirmamos? 😊". NO des datos bancarios todavía.`;
              setEtapa(telefono, tenantId, 'cotizando');
            }
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

      case 'ENVIO': {
        contextoExtra = envio.courier
          ? `CRÍTICO: Solo despachamos con ${envio.courier}. Si el cliente pregunta por otro courier (Starken, Chilexpress, Correos, etc.), responder claramente que SOLO trabajamos con ${envio.courier} y no tenemos acuerdo con otros servicios. El cliente decide si procede o no.`
          : '';
        respuesta = await geminiService.generarRespuesta(texto, historial, contextoExtra, telefono, config);
        break;
      }

      case 'PAGO':
      case 'GARANTIA': {
        const ctxGarantia = `POLÍTICA DE GARANTÍA:
✅ Garantía: ${garantia.meses} meses por defectos de fábrica desde la fecha de compra.
📋 Condiciones: ${garantia.condicion || 'El producto no debe tener daños físicos causados por el cliente.'}
📍 Para hacer efectiva la garantía el cliente debe:
  1. Traer el producto con el defecto al local: ${empresa.direccion}
  2. Presentar la boleta o comprobante de compra.
  3. El producto no debe tener daños físicos externos.
🕐 Horario de atención: ${empresa.horario}
INSTRUCCIONES: Explica el proceso de garantía claramente. Si el producto fue comprado dentro del plazo, confirma que está cubierto y da los pasos. NO digas "Déjame consultar con bodega". Si el problema suena a mal uso (no defecto de fábrica), explícalo amablemente.`;
        respuesta = await geminiService.generarRespuesta(texto, historial, ctxGarantia, telefono, config);
        break;
      }

      case 'HORARIO': {
        const ctxHorario = `INFORMACIÓN DE LA TIENDA:
📍 Dirección: ${empresa.direccion}
🕐 Horario: ${empresa.horario}
${empresa.domingos ? '✅ Abierto los domingos' : '❌ Cerrado los domingos'}
🛒 Retiro en tienda: Sí, los clientes pueden pasar a retirar sus pedidos en persona en el horario indicado.
Si el cliente pregunta si puede comprar online y retirar hoy: responde que puede pasar a retirar en nuestra dirección durante el horario de atención.`;
        respuesta = await geminiService.generarRespuesta(texto, historial, ctxHorario, telefono, config);
        break;
      }

      case 'CATALOGO': {
        const web = empresa.web || '';
        if (web) {
          respuesta = `¡Claro! 😊 Puedes ver nuestro catálogo completo con fotos y precios en:\n🌐 *${web}*\n\nTambién puedes escribirme el nombre de cualquier producto y te busco precio y stock al instante 🔍`;
        } else {
          respuesta = `Escríbeme el nombre del producto que buscas y te doy precio y disponibilidad al instante 😊 ¿Por dónde empezamos?`;
        }
        break;
      }

      case 'SOPORTE_TECNICO': {
        setEtapa(telefono, tenantId, 'explorando');
        const prodSoporte = await geminiService.extraerProductoConIA(texto, historial);
        const ctxSoporte = `El cliente ya tiene el producto${prodSoporte ? ` "${prodSoporte}"` : ''} y necesita ayuda para usarlo o configurarlo.
INSTRUCCIONES:
- Da 3-4 pasos básicos para empezar a usar el producto.
- Sugiere buscar el manual o un tutorial en YouTube si necesita más detalle.
- NO ofrezcas venderle el producto ni muestres precios.
- NO des datos bancarios.
- Tono amigable y práctico.`;
        respuesta = await geminiService.generarRespuesta(texto, historial, ctxSoporte, telefono, config);
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
        respuesta = await geminiService.generarRespuesta(texto, historial, contextoExtra + ctxImagen, telefono, config);
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
