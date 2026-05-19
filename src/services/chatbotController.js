// src/services/chatbotController.js
const { emitirEvento, esModoHumano, actualizarEstadoCliente } = require('../routes/panel');
const db              = require('../config/database');
const geminiService   = require('./geminiService');
const bsaleService    = require('./bsaleService');
const followUpService = require('./followUpService');
const tenantService   = require('./tenantService');
const { enviarMensaje, enviarMenu, enviarBotonesConfirmar, reenviarMedia } = require('./whatsappService');
const catalogoService = require('./catalogoService');
const pdfService      = require('./pdfService');
const pagoService     = require('./pagoService');
const calendarService = require('./calendarService');

// ─── Notificación al dueño ────────────────────────────────────────────────────
async function notificarDueno(tipo, telefono, nombre, extra = '', config = null) {
  const DUENO_TEL = config?.credenciales?.notifTelefono || process.env.DUENO_WHATSAPP;
  if (!DUENO_TEL) {
    console.warn(`[Notif] ⚠️ Sin número de notificación configurado (tipo: ${tipo})`);
    return;
  }

  const mensajes = {
    pago_detectado:     `💰 *PAGO DETECTADO*\nCliente: ${nombre} (${telefono})\nMensaje: ${extra}`,
    comprobante:        `🧾 *COMPROBANTE RECIBIDO*\nCliente: ${nombre} (${telefono})\nRevisa el panel.`,
    error_bot:          `⚠️ *PRODUCTO NO ENCONTRADO*\nCliente: ${nombre} (${telefono})\n${extra}`,
    solicitud_humano:   `🙋 *CLIENTE PIDE HABLAR CON PERSONA*\nCliente: ${nombre} (${telefono})\n${extra}`,
    lead_mayorista:     `🛒 *POSIBLE REVENDEDOR/MAYORISTA*\nCliente: ${nombre} (${telefono})\n${extra}`,
    propuesta_comercial:`📢 *PROPUESTA COMERCIAL RECIBIDA*\nDe: ${nombre} (${telefono})\n${extra}`,
    datos_despacho:     `📍 *DATOS DE DESPACHO RECIBIDOS*\nCliente: ${nombre} (${telefono})\n\n${extra}`,
    cita_agendada:      `📅 *NUEVA CITA AGENDADA*\nCliente: ${nombre} (${telefono})\n${extra}`,
  };

  const msg = mensajes[tipo] || `📬 *${tipo.toUpperCase()}*\nCliente: ${nombre} (${telefono})\n${extra}`;

  try {
    const { whatsappPhoneId, whatsappToken } = config?.credenciales || {};
    await enviarMensaje(DUENO_TEL, msg, whatsappPhoneId, whatsappToken);
    console.log(`[Notif] ✅ Notificación "${tipo}" enviada al dueño (${DUENO_TEL})`);
  } catch (err) {
    console.error(`[Notif] ❌ Error enviando notificación "${tipo}":`, err.message);
  }
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

// ─── Carrito persistente ──────────────────────────────────────────────────────
function guardarCarrito(telefono, tenantId, producto) {
  try {
    db.prepare(`UPDATE clientes SET carrito_producto = ? WHERE telefono = ? AND tenant_id = ?`)
      .run(producto, telefono, tenantId);
  } catch (_) {}
}

function limpiarCarrito(telefono, tenantId) {
  try {
    db.prepare(`UPDATE clientes SET carrito_producto = NULL WHERE telefono = ? AND tenant_id = ?`)
      .run(telefono, tenantId);
  } catch (_) {}
}

function obtenerCarrito(telefono, tenantId) {
  try {
    return db.prepare(`SELECT carrito_producto, estado FROM clientes WHERE telefono = ? AND tenant_id = ?`)
      .get(telefono, tenantId)?.carrito_producto || null;
  } catch (_) { return null; }
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

  // modo === 'pdf'
  if (modo === 'pdf' || (modo !== 'manual' && config?.tieneCatalogoPDF)) {
    const chunks = pdfService.buscarEnPDF(query, config.tenantId);
    if (chunks) {
      console.log(`✅ Resultados encontrados en PDF para "${query}"`);
      return `=== CATÁLOGO PDF ===\n${chunks}`;
    }
    if (modo === 'pdf') {
      console.log(`⚠️ Sin resultados en PDF para "${query}"`);
      if (telefono) await notificarDueno('error_bot', telefono, nombre, `❓ Cliente buscó "${query}" y no se encontró en el PDF.`, config);
      return null;
    }
  }

  // modo === 'bsale' (default)
  // Siempre intentar primero el término original, luego las variantes IA
  const terminosIA = await geminiService.expandirTerminoBusqueda(query);
  const terminos = [query, ...terminosIA.filter(t => t.toLowerCase() !== query.toLowerCase())];
  let resultados = [];
  let fallbackSinStock = null; // primer resultado encontrado pero sin stock
  for (const termino of terminos) {
    const r = await bsaleService.buscarConPreciosYStock(termino, mayorista, config?.credenciales?.bsaleToken);
    if (!r?.length) continue;
    if (bsaleService.tieneStock(r)) {
      resultados = r;
      console.log(`✅ Datos de Bsale con STOCK obtenidos con término: "${termino}"`);
      break;
    }
    // Tiene resultados pero sin stock — guardar como fallback y seguir buscando
    if (!fallbackSinStock) {
      fallbackSinStock = r;
      console.log(`⚠️ "${termino}" encontrado pero sin stock, continuando búsqueda...`);
    }
  }
  // Si no encontramos nada con stock, usar el primer resultado sin stock (informa correctamente al cliente)
  if (!resultados.length && fallbackSinStock) {
    console.log(`⚠️ Todos los términos sin stock — usando fallback`);
    resultados = fallbackSinStock;
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

// ─── Extraer precio numérico del contexto de Bsale ───────────────────────────
function extraerPrecioDeContexto(contexto) {
  if (!contexto) return 0;
  const match = contexto.match(/💵[^$\n]*\$\s*([\d.]+)/);
  if (match) return parseInt(match[1].replace(/\./g, ''), 10) || 0;
  // fallback: primer precio con $ que encuentre
  const m2 = contexto.match(/\$\s*([\d.]{4,})/);
  return m2 ? parseInt(m2[1].replace(/\./g, ''), 10) : 0;
}

// ─── Detección de datos de despacho ──────────────────────────────────────────
function detectarDatosDespacho(texto) {
  return /(?:\d{1,2}\.?\d{3}\.?\d{3}-?[\dkK]|\brut[:\s]|direcci[oó]n|calle\s|av\.\s|avenida|villa |poblaci[oó]n|regi[oó]n|comuna|sector |pasaje|block |depto |departamento|c\.p\.|código postal)/i.test(texto);
}

function detectarComprobante(data) {
  // Documentos enviados mientras el cliente está en etapa de pago = comprobante
  if (data.tipo === 'document') return true;
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

    // ── Demo Contable: flujo simulado de oficina contable para prospectos ────────
    const historialPrevio = obtenerHistorial(telefono, tenantId, 10);

    const esDemoContable = /demo\s*contable/i.test(texto) ||
      historialPrevio.some(m => /demo\s*contable|Empresa Contable X/i.test(m.mensaje));

    if (texto && esDemoContable) {
      const NOTIF_DEMO = '56999269035'; // tu número para probar
      const yaIngresóRut  = historialPrevio.some(m => /\d{1,2}\.?\d{3}\.?\d{3}-[\dkK]|\d{7,8}-[\dkK]/.test(m.mensaje));
      const esperandoOtro = historialPrevio.some(m => /cuéntame con más detalle/i.test(m.mensaje) && m.rol === 'assistant');
      const yaEligióOpción = historialPrevio.some(m => /solicitud recibida/i.test(m.mensaje) && m.rol === 'assistant');

      const rutMatch = texto.match(/(\d{1,2}\.?\d{3}\.?\d{3}-[\dkK]|\d{7,8}-[\dkK])/);

      // Recuperar RUT del historial para usarlo en pasos siguientes
      const msgConRut   = historialPrevio.find(m => /\d{7,8}-[\dkK]/.test(m.mensaje));
      const rutGuardado = msgConRut?.mensaje?.match(/(\d{1,2}\.?\d{3}\.?\d{3}-[\dkK]|\d{7,8}-[\dkK])/)?.[1] || 'sin RUT';

      guardarMensaje(telefono, nombre, 'user', texto, tenantId);

      // Paso 1: bienvenida
      if (/demo\s*contable/i.test(texto) && !yaIngresóRut) {
        const msg = `👋 Bienvenido a *Empresa Contable X* _(demo de automatización por USAIA)_\n\nSoy el asistente virtual de la oficina. Para atenderte, por favor ingresa tu *RUT* (ej: 12.345.678-9).`;
        await enviarMensaje(telefono, msg, whatsappPhoneId, whatsappToken);
        guardarMensaje(telefono, nombre, 'assistant', msg, tenantId);
        return;
      }

      // Paso 2: RUT recibido → registrar y mostrar menú
      if (rutMatch && !yaEligióOpción && !esperandoOtro) {
        const rut = rutMatch[1];
        const msg =
          `✅ *RUT registrado:* ${rut}\n\n` +
          `¿Qué necesitas hoy?\n\n` +
          `1️⃣ Solicitar factura\n` +
          `2️⃣ Certificado tributario SII\n` +
          `3️⃣ Consulta IVA o Renta\n` +
          `4️⃣ Finiquito laboral\n` +
          `5️⃣ Otro — cuéntame qué necesitas`;
        await enviarMensaje(telefono, msg, whatsappPhoneId, whatsappToken);
        guardarMensaje(telefono, nombre, 'assistant', msg, tenantId);
        return;
      }

      // Paso 3a: eligió "Otro" (opción 5) → pedir descripción libre
      if (yaIngresóRut && !yaEligióOpción && !esperandoOtro && /^5$|^otro$/i.test(texto.trim())) {
        const msg = `Claro 😊 Cuéntame con más detalle qué necesitas y lo registro para que el contador te contacte.`;
        await enviarMensaje(telefono, msg, whatsappPhoneId, whatsappToken);
        guardarMensaje(telefono, nombre, 'assistant', msg, tenantId);
        return;
      }

      // Paso 3b: recibió descripción libre (después de "Otro") → confirmar y notificar
      if (esperandoOtro && !yaEligióOpción) {
        const descripcion = texto.slice(0, 200);
        const msgConfirm =
          `✅ *Solicitud recibida.*\n\n` +
          `📋 *Detalle:* ${descripcion}\n` +
          `🆔 *RUT:* ${rutGuardado}\n\n` +
          `El contador revisará tu caso y te contactará a la brevedad. ¡Gracias! 😊`;
        await enviarMensaje(telefono, msgConfirm, whatsappPhoneId, whatsappToken);
        guardarMensaje(telefono, nombre, 'assistant', msgConfirm, tenantId);

        const notif =
          `📬 *NUEVA SOLICITUD — Empresa Contable X*\n\n` +
          `👤 Cliente: ${nombre} (${telefono})\n` +
          `🆔 RUT: ${rutGuardado}\n` +
          `📋 Solicitud: ${descripcion}\n\n` +
          `_Demo generada por USAIA · usaiahoy.com_`;
        await enviarMensaje(NOTIF_DEMO, notif, whatsappPhoneId, whatsappToken).catch(() => {});
        return;
      }

      // Paso 3c: eligió opción 1-4 → confirmar y notificar
      if (yaIngresóRut && !yaEligióOpción && /^[1-4]$|factura|certificado|iva|renta|finiquito/i.test(texto)) {
        const opciones = {
          '1': 'Solicitar factura',           'factura':     'Solicitar factura',
          '2': 'Certificado tributario SII',  'certificado': 'Certificado tributario SII',
          '3': 'Consulta IVA o Renta',        'iva':         'Consulta IVA o Renta', 'renta': 'Consulta IVA o Renta',
          '4': 'Finiquito laboral',           'finiquito':   'Finiquito laboral',
        };
        const opcion = opciones[texto.trim().toLowerCase()] || opciones[texto.trim()] || 'Otra consulta';

        const msgConfirm =
          `✅ *Solicitud recibida.*\n\n` +
          `📋 *Trámite:* ${opcion}\n` +
          `🆔 *RUT:* ${rutGuardado}\n\n` +
          `El contador te contactará a la brevedad. ¡Gracias! 😊`;
        await enviarMensaje(telefono, msgConfirm, whatsappPhoneId, whatsappToken);
        guardarMensaje(telefono, nombre, 'assistant', msgConfirm, tenantId);

        const notif =
          `📬 *NUEVA SOLICITUD — Empresa Contable X*\n\n` +
          `👤 Cliente: ${nombre} (${telefono})\n` +
          `🆔 RUT: ${rutGuardado}\n` +
          `📋 Trámite: ${opcion}\n\n` +
          `_Demo generada por USAIA · usaiahoy.com_`;
        await enviarMensaje(NOTIF_DEMO, notif, whatsappPhoneId, whatsappToken).catch(() => {});
        return;
      }

      // Fallback
      const msgGenerico = `Por favor ingresa tu *RUT* para comenzar, o elige una opción del *1 al 5*. 😊`;
      await enviarMensaje(telefono, msgGenerico, whatsappPhoneId, whatsappToken);
      guardarMensaje(telefono, nombre, 'assistant', msgGenerico, tenantId);
      return;
    }

    // ── Demo USAIA: responder con info del servicio cuando alguien llega desde la web ──
    const esDemoUSAIA = /usaia/i.test(texto) ||
      historialPrevio.some(m => /usaia|56999269035/i.test(m.mensaje));

    if (texto && esDemoUSAIA) {
      const PLANES_USAIA = `=== PLANES USAIA ===
• *Starter* $39.000/mes (+$50.000 configuración única)
  ✅ Bot IA 24/7 · hasta 500 conversaciones · catálogo manual · panel admin
  ❌ Sin Bsale · sin Google Calendar · sin campañas

• *Pro* $89.000/mes (+$80.000 configuración única)
  ✅ Conversaciones ilimitadas · Bsale en tiempo real · Google Calendar
  ✅ Pedidos · campañas masivas · CRM · métricas · links de pago

• *Empresarial* — precio a cotizar
  ✅ Todo Pro + múltiples números · flujos a medida · soporte prioritario

📱 Habla con Matías: wa.me/56999269035 · 🌐 usaiahoy.com`;

      const esInicioDemo = /usaia/i.test(texto);
      const pareceBusqueda = !esInicioDemo && texto.length > 2 &&
        !/plan|precio|starter|pro|empresarial|contratar|agendar|info|cuanto|cuesta|vale|cobras|incluye/i.test(texto);

      let msgDemo = '';

      if (esInicioDemo) {
        // Primer mensaje: bienvenida + productos de ejemplo del catálogo real
        const ejemplos = await bsaleService.obtenerProductosEjemplo(config?.credenciales?.bsaleToken, 4);
        const listaEjemplos = ejemplos.length
          ? `\nPrueba preguntándome por:\n${ejemplos.map(p => `• ${p}`).join('\n')}`
          : '\nPrueba preguntándome por cualquier producto.';
        msgDemo =
          `¡Hola! 👋 Bienvenido a la demo en vivo de *USAIA*.\n\n` +
          `Esto que ves es un bot real, conectado a Bsale en tiempo real.\n` +
          `Pregúntame por un producto y verás cómo responde tu bot.${listaEjemplos}\n\n` +
          `O si prefieres ver los *planes y precios*, escríbeme "planes" 📊`;

        await enviarMensaje(telefono, msgDemo, whatsappPhoneId, whatsappToken);
        guardarMensaje(telefono, nombre, 'user', texto, tenantId);
        guardarMensaje(telefono, nombre, 'assistant', msgDemo, tenantId);
        return;
      }

      // Mensajes siguientes: buscar producto o responder sobre planes con IA
      let ctxDemo = PLANES_USAIA;
      if (pareceBusqueda) {
        const bsaleCtx = await obtenerContextoBsale(texto, false, telefono, nombre, config).catch(() => null);
        if (bsaleCtx) {
          ctxDemo = `[RESULTADO EN VIVO desde Bsale del cliente demo]:\n${bsaleCtx}\n\n` +
            `INSTRUCCIÓN: Muestra este resultado como si fueras el bot del negocio real. ` +
            `Al final agrega una línea: "_👆 Así respondería el bot de tu negocio en tiempo real._"\n\n` + PLANES_USAIA;
        } else {
          const ejemplos = await bsaleService.obtenerProductosEjemplo(config?.credenciales?.bsaleToken, 3);
          const sugerencias = ejemplos.length ? `\nPrueba con: ${ejemplos.map(p => `*${p}*`).join(', ')}` : '';
          msgDemo = `Ese producto no está en el catálogo de esta demo 😅 En tu negocio el bot buscaría en tu propio Bsale.${sugerencias}`;
          await enviarMensaje(telefono, msgDemo, whatsappPhoneId, whatsappToken);
          guardarMensaje(telefono, nombre, 'user', texto, tenantId);
          guardarMensaje(telefono, nombre, 'assistant', msgDemo, tenantId);
          return;
        }
      }

      const USAIA_CONTEXTO = `Eres el asistente de demostración de USAIA (usaiahoy.com). Sé breve y directo.
Si preguntan por un plan, explica qué incluye. Si quieren contratar, deriva a Matías (wa.me/56999269035).
NUNCA actúes como otra tienda — siempre eres la demo de USAIA.`;

      const historialUsaia = historialPrevio.map(m => ({ rol: m.rol, mensaje: m.mensaje }));
      const respDemo = await geminiService.generarRespuesta(texto, historialUsaia, USAIA_CONTEXTO + '\n\n' + ctxDemo, telefono, {
        empresa: { nombre: 'USAIA', web: 'usaiahoy.com' },
        tipoNegocio: 'servicios',
        asistentes: ['Bot USAIA'],
        credenciales: {},
        mayorista: {},
        garantia: {},
        embalajes: [],
      });

      await enviarMensaje(telefono, respDemo, whatsappPhoneId, whatsappToken);
      guardarMensaje(telefono, nombre, 'user', texto, tenantId);
      guardarMensaje(telefono, nombre, 'assistant', respDemo, tenantId);
      return;
    }

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
      // Reenviar el comprobante directamente al WhatsApp del dueño para que lo vea
      const dueno = config?.credenciales?.notifTelefono || process.env.DUENO_WHATSAPP;
      if (dueno && mediaInfo.media_id) {
        const caption = `🧾 Comprobante de *${nombre}* (${telefono})`;
        await reenviarMedia(dueno, mediaInfo.media_id, mediaInfo.tipo, caption, whatsappPhoneId, whatsappToken).catch(() => {});
      }
    }

    // Imágenes/audio/video sin caption llegan como texto "[IMAGE]", "[AUDIO]", etc.
    const textoEsMedia = !texto || /^\[(IMAGE|AUDIO|VOICE|VIDEO|DOCUMENT|STICKER|LOCATION)\]$/.test(texto);
    if (textoEsMedia) {
      if (mediaInfo?.tipo === 'image') {
        // Si es imagen que puede ser comprobante, responder diferente
        if (detectarComprobante(data)) {
          await enviarMensaje(telefono, '¡Comprobante recibido! 🧾 Lo revisaremos y coordinaremos tu pedido a la brevedad. ¿Necesitas algo más?', whatsappPhoneId, whatsappToken);
        } else {
          await enviarMensaje(telefono, 'No puedo ver imágenes directamente 📸 Si querés consultar por un producto, escribime su nombre y lo busco enseguida 😊', whatsappPhoneId, whatsappToken);
        }
      } else if (mediaInfo?.tipo === 'audio' || mediaInfo?.tipo === 'voice') {
        await enviarMensaje(telefono, '¡Recibí tu audio! 🎙️ Por favor escríbeme tu consulta para ayudarte mejor 😊', whatsappPhoneId, whatsappToken);
      } else if (mediaInfo?.tipo === 'document') {
        await enviarMensaje(telefono, '¡Comprobante recibido! 🧾 Lo revisaremos y coordinaremos tu pedido a la brevedad. ¿Necesitas algo más?', whatsappPhoneId, whatsappToken);
      }
      return;
    }

    // Propuesta comercial externa (publicidad, radio, auspicio, etc.) → notificar dueño sin negociar
    if (/ejecutiv[ao] comercial|oferta.*campaña|campaña.*publicitaria|radio.*fm|auspicio.*programa|frases.*diarias|banner.*web|valor.*iva mensual|publicidad.*radio|patrocinio|sponsor|propuesta.*comercial|agencia.*publicidad/i.test(texto)) {
      await notificarDueno('propuesta_comercial', telefono, nombre, `Propuesta comercial recibida de ${nombre}: "${texto.slice(0, 200)}"`, config);
      const respComercial = `¡Hola! 😊 Recibí tu propuesta. La he enviado a quien corresponde para que la evalúen. Si hay interés, te contactarán directamente. ¡Gracias!`;
      await enviarMensaje(telefono, respComercial, whatsappPhoneId, whatsappToken);
      guardarMensaje(telefono, nombre, 'assistant', respComercial, tenantId);
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
      // Priorizar carrito guardado (sabemos que tenía stock cuando se guardó)
      // Si no hay carrito, extraer con IA del historial como fallback
      const carritoActual = obtenerCarrito(telefono, tenantId);
      const prodAnterior  = carritoActual || await geminiService.extraerProductoConIA('quiero comprarlo', historial2);
      console.log(`[BOT] 🛒 confirmar_pedido | carrito: "${carritoActual}" | extraído: "${prodAnterior}"`);
      let ctxConfirmar = '';
      if (prodAnterior && prodAnterior.length > 2) {
        const bsaleCtx = await obtenerContextoBsale(prodAnterior, false, telefono, nombre, config);
        if (bsaleCtx && /💵/.test(bsaleCtx)) {
          ctxConfirmar = bsaleCtx;
        } else {
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
      // Si el cliente envía datos de despacho, notificar al dueño de forma estructurada
      if (detectarDatosDespacho(texto)) {
        await notificarDueno('datos_despacho', telefono, nombre, texto.slice(0, 400), config);
        console.log(`[BOT] 📍 Datos de despacho detectados de ${telefono}`);
      }
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
          // Recordar carrito si el cliente volvió sin haber comprado
          const carritoGuardado = obtenerCarrito(telefono, tenantId);
          const estadoActualCliente = db.prepare(`SELECT estado FROM clientes WHERE telefono = ? AND tenant_id = ?`).get(telefono, tenantId)?.estado;
          if (carritoGuardado && !['pagado', 'despachado'].includes(estadoActualCliente)) {
            const ctxCarrito = await obtenerContextoBsale(carritoGuardado, false, telefono, nombre, config);
            if (ctxCarrito && /💵/.test(ctxCarrito)) {
              const respCarrito = await geminiService.generarRespuesta(
                texto, historial,
                ctxCarrito + `\n\nCRÍTICO: El cliente consultó anteriormente por "${carritoGuardado}" y volvió. Recuérdale amablemente que lo tenía guardado y pregunta si quiere retomar o busca otra cosa. Tono cálido y sin presionar.`,
                telefono, config
              );
              if (respCarrito) {
                await enviarMensaje(telefono, respCarrito, whatsappPhoneId, whatsappToken);
                guardarMensaje(telefono, nombre, 'assistant', respCarrito, tenantId);
                await enviarBotonesConfirmar(telefono, whatsappPhoneId, whatsappToken);
              }
              break;
            }
          }

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
        if (/💵/.test(contextoExtra)) guardarCarrito(telefono, tenantId, producto);
        respuesta = await geminiService.generarRespuesta(texto, historial, contextoExtra + ctxImagen, telefono, config);
        followUpService.programarSeguimiento(telefono, 'follow_up_precio', 180, tenantId);
        if (respuesta) {
          await enviarMensaje(telefono, respuesta, whatsappPhoneId, whatsappToken);
          guardarMensaje(telefono, nombre, 'assistant', respuesta, tenantId);
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
        // Buscar cantidad en texto actual; si no hay, buscar en historial reciente
        let cantMayor = extraerCantidad(texto);
        if (cantMayor <= 1) {
          const histTexto = historial.slice(-10).map(m => m.mensaje).join(' ');
          const cantHist  = extraerCantidad(histTexto);
          if (cantHist > 1) cantMayor = cantHist;
        }
        const producto = await geminiService.extraerProductoConIA(texto, historial);
        const esMayor  = cantMayor >= bsaleService.MINIMO_MAYORISTA;
        contextoExtra  = await obtenerContextoBsale(producto, esMayor, telefono, nombre, config);
        if (contextoExtra === null) {
          respuesta = `No encontramos "${producto}" en nuestro catálogo actualmente. ¿Buscas otro producto? 😊`;
          break;
        }
        contextoExtra += esMayor
          ? `\n\nEl cliente quiere ${cantMayor} unidades — mostrar precio mayorista. Si no hay precio mayorista en el catálogo, indica que para ese volumen deben contactar directamente para obtener cotización especial.`
          : `\n\nEl cliente quiere ${cantMayor} unidades — precio unitario aplica. Mencionar que desde ${bsaleService.MINIMO_MAYORISTA} unidades hay precio mayorista.`;
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
          if (/💵/.test(bsaleCtx)) guardarCarrito(telefono, tenantId, producto);
        }
        const instrPedido = esMayor
          ? `\n\nEl cliente quiere ${cantidad} unidades de "${producto}" (pedido mayorista).
INSTRUCCIÓN CRÍTICA: Si el catálogo dice "CONSULTAR DIRECTAMENTE" para precio mayorista, NO calcules ningún total. Di: "Para ${cantidad} unidades te ofrezco precio especial mayorista 📦 Contáctanos directamente para cotizar ese volumen. ¿Quieres que te pase el teléfono o email de ventas?" — NO des precio unitario × cantidad como total.
Si SÍ hay precio mayorista en el catálogo, muestra el resumen con ese precio mayorista.`
          : `\n\nEl cliente quiere hacer un pedido de ${cantidad} unidad(es) de "${producto}".
INSTRUCCIÓN: Muestra el resumen del pedido:
📋 *Resumen de tu pedido:*
- Producto: [nombre]
- Cantidad: ${cantidad} unidad(es)
- Precio: $[precio unitario]
- Envío: Por pagar al recibir (${envio.courier} 🚚)
━━━━━━━━━━━━━━━━
💵 *Total a transferir: $[total]*
Luego pregunta: "¿Confirmamos? 😊" — NO des datos bancarios todavía.`;
        contextoExtra += instrPedido;
        respuesta = await geminiService.generarRespuesta(texto, historial, contextoExtra, telefono, config);
        setEtapa(telefono, tenantId, 'cotizando');
        break;
      }

      case 'CONFIRMAR': {
        // "Sí/Ok/Dale" genérico — solo avanza a compra si el último mensaje del bot
        // era explícitamente "¿Confirmamos?" o similar. De lo contrario responde en contexto.
        const ultimaBotMsg = historial.filter(m => m.rol === 'assistant').slice(-1)[0]?.mensaje || '';
        const eraConfirmPedido = /confirmamos\?|¿lo sep[ao]r[ao]|hacemos el pedido|quieres comprar|¿confirmás|confirmas\?/i.test(ultimaBotMsg);
        if (etapa === 'cotizando' && eraConfirmPedido) {
          intent = 'CONFIRMAR_PEDIDO'; // caer al case de abajo
        } else {
          respuesta = await geminiService.generarRespuesta(texto, historial, contextoExtra, telefono, config);
          break;
        }
        // falls through to CONFIRMAR_PEDIDO
      }
      // eslint-disable-next-line no-fallthrough
      case 'CONFIRMAR_PEDIDO': {
        if (etapa === 'cotizando') {
          const prodAnterior = await geminiService.extraerProductoConIA(texto || '', historial);
          if (prodAnterior.length > 1) {
            const bsaleCtx = await obtenerContextoBsale(prodAnterior, false, telefono, nombre, config);
            if (bsaleCtx !== null) contextoExtra = bsaleCtx;
          }

          // ── Intentar generar link de pago si el tenant tiene pasarela configurada ──
          const { pagoPasarela, pagoApiKey, pagoApiSecret } = config.credenciales;
          if (pagoPasarela && pagoPasarela !== 'ninguna' && pagoApiKey && pagoApiSecret) {
            try {
              const monto = extraerPrecioDeContexto(contextoExtra);
              if (monto > 0) {
                const linkPago = await pagoService.generarLinkPago(config, {
                  monto,
                  descripcion: `Pedido ${prodAnterior || 'producto'} — ${empresa.nombre}`,
                  telefono,
                });
                if (linkPago) {
                  respuesta = await geminiService.generarRespuesta(texto, historial,
                    contextoExtra + `\n\nEl cliente confirmó. Muestra el resumen del pedido con precio y luego AGREGA EXACTAMENTE este link de pago al final del mensaje:\n💳 *Paga aquí de forma segura:*\n${linkPago}\n_Válido por 24 horas ⏰_\nIndica que una vez pagado se coordinará el despacho.`,
                    telefono, config);
                  setEtapa(telefono, tenantId, 'pagando');
                  limpiarCarrito(telefono, tenantId);
                  followUpService.cancelarSeguimientos(telefono, tenantId);
                  break;
                }
              }
            } catch (errPago) {
              console.error('[Pago] Error generando link:', errPago.message);
              // Si falla la pasarela, cae al flujo normal de transferencia
            }
          }

          // Flujo normal: datos de transferencia bancaria
          // Recuperar cantidad del historial reciente para no resetear a 1
          const textoHistorialReciente = historial.slice(-8).map(m => m.mensaje).join(' ');
          const cantConfirmada = extraerCantidad(textoHistorialReciente);
          const instrCantidad = cantConfirmada > 1
            ? `\nCRÍTICO: La cantidad pedida es ${cantConfirmada} unidades. Usa ese número para calcular el total (${cantConfirmada} × precio unitario). NO uses 1 unidad.`
            : '';
          contextoExtra +=
            '\n\nEl cliente confirmó el pedido. Entrega los datos de transferencia completos.' + instrCantidad + '\n' +
            `Menciona que el envío se paga aparte al recibir (${envio.courier}). Pide el comprobante por WhatsApp.`;
          respuesta = await geminiService.generarRespuesta(texto, historial, contextoExtra, telefono, config);
          setEtapa(telefono, tenantId, 'pagando');
          limpiarCarrito(telefono, tenantId);
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

      case 'RETIRO_TIENDA': {
        const ctxRetiro = `El cliente quiere retirar su pedido en la tienda en persona.
📍 Dirección: ${empresa.direccion}
🕐 Horario: ${empresa.horario}
${empresa.domingos ? '✅ Abierto los domingos' : '❌ Cerrado los domingos'}
INSTRUCCIÓN CRÍTICA: Confirma que puede pasar a retirar en ese horario. NO des datos bancarios ni menciones transferencia. NO digas que "coordinarás" nada. Solo di que te espera en la tienda y que al llegar puede pagar y retirar.`;
        respuesta = await geminiService.generarRespuesta(texto, historial, ctxRetiro, telefono, config);
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

      case 'INICIAR_MATRICULA': {
        const { pagoPasarela, pagoApiKey, pagoApiSecret } = config.credenciales;
        const tieneLink = pagoPasarela && pagoPasarela !== 'ninguna' && pagoApiKey && pagoApiSecret;

        // Buscar info del programa en el PDF si está disponible
        const programaBuscado = await geminiService.extraerProductoConIA(texto, historial);
        let ctxPrograma = '';
        if (programaBuscado) ctxPrograma = await obtenerContextoBsale(programaBuscado, false, telefono, nombre, config) || '';

        if (tieneLink) {
          // Intentar generar link de matrícula
          try {
            const monto = extraerPrecioDeContexto(ctxPrograma) || 0;
            if (monto > 0) {
              const linkMatricula = await pagoService.generarLinkPago(config, {
                monto,
                descripcion: `Matrícula ${programaBuscado || 'programa'} — ${empresa.nombre}`,
                telefono,
              });
              if (linkMatricula) {
                respuesta = await geminiService.generarRespuesta(texto, historial,
                  ctxPrograma + `\n\nEl estudiante quiere iniciar el proceso de matrícula/inscripción.
INSTRUCCIÓN: Muestra un resumen breve del programa (nombre, duración, modalidad, arancel si aparece).
Luego agrega EXACTAMENTE este link de pago de matrícula al final:
💳 *Paga tu matrícula aquí:*\n${linkMatricula}\n_Válido por 48 horas_
Indica que una vez realizado el pago, el equipo académico se contactará para completar los documentos.`,
                  telefono, config);
                setEtapa(telefono, tenantId, 'pagando');
                await notificarDueno('comprobante', telefono, nombre, `📚 Matrícula iniciada — ${programaBuscado || 'programa'}`, config);
                break;
              }
            }
          } catch (errPago) {
            console.error('[Matrícula] Error generando link:', errPago.message);
          }
        }

        // Sin pasarela o sin precio: recopilar datos del estudiante
        respuesta = await geminiService.generarRespuesta(texto, historial,
          ctxPrograma + `\n\nEl estudiante quiere iniciar el proceso de matrícula/inscripción para "${programaBuscado || 'un programa'}".
INSTRUCCIÓN: Indica los pasos del proceso de matrícula. Luego pide sus datos básicos:
- Nombre completo
- RUT
- Email
- Teléfono de contacto
Explica que el equipo académico se contactará a la brevedad para completar la inscripción.`,
          telefono, config);
        await notificarDueno('solicitud_humano', telefono, nombre,
          `📚 *SOLICITUD DE MATRÍCULA*\nEstudiante: ${nombre} (${telefono})\nPrograma: ${programaBuscado || 'sin especificar'}`, config);
        break;
      }

      case 'ESTADO_PEDIDO': {
        const pedidoActual = db.prepare(`
          SELECT estado, productos, creado_en FROM pedidos
          WHERE telefono = ? AND tenant_id = ?
          ORDER BY creado_en DESC LIMIT 1
        `).get(telefono, tenantId);

        if (pedidoActual) {
          const estadosPedido = {
            pendiente:  'en espera de confirmación ⏳',
            confirmado: 'confirmado y en preparación 📦',
            preparando: 'siendo preparado 🔧',
            listo:      'listo para despacho o retiro ✅',
            entregado:  'entregado 🎉',
            cancelado:  'cancelado ❌',
          };
          const estadoTexto = estadosPedido[pedidoActual.estado] || pedidoActual.estado;
          const fecha = new Date(pedidoActual.creado_en).toLocaleDateString('es-CL');
          respuesta = `📦 *Estado de tu pedido*\n\nProducto: ${pedidoActual.productos}\nFecha: ${fecha}\nEstado: ${estadoTexto}\n\n¿Necesitas algo más? 😊`;
        } else {
          const estadoCliente = db.prepare(`SELECT estado FROM clientes WHERE telefono = ? AND tenant_id = ?`).get(telefono, tenantId)?.estado;
          if (estadoCliente === 'despachado') {
            respuesta = `🚚 Tu pedido ya fue despachado. Revisa con el courier para el seguimiento de la entrega.`;
          } else if (estadoCliente === 'pagado' || estadoCliente === 'pago_pendiente') {
            respuesta = `✅ Tu pago fue recibido y el pedido está siendo procesado. Te avisamos cuando salga para despacho 🚚`;
          } else {
            respuesta = `No encontré un pedido registrado a tu nombre 😕 Si ya realizaste una compra, escríbenos el nombre del producto o envíanos el comprobante de pago para ayudarte 📋`;
          }
        }
        break;
      }

      case 'AGENDAR_CITA': {
        try {
          const datosExtraidos = await geminiService.extraerCitaDeTexto(texto);
          if (datosExtraidos.fecha) {
            // Guardar cita en DB
            const citaResult = db.prepare(`
              INSERT INTO citas (tenant_id, telefono, nombre, servicio, fecha, hora)
              VALUES (?, ?, ?, ?, ?, ?)
            `).run(tenantId, telefono, nombre, datosExtraidos.servicio || 'Consulta', datosExtraidos.fecha, datosExtraidos.hora || '10:00');

            // Crear evento en Google Calendar si está configurado
            let googleLink = '';
            if (calendarService.tieneCalendario(config?.raw || {})) {
              try {
                const evento = await calendarService.crearEvento(config.raw, {
                  resumen: `${datosExtraidos.servicio || 'Cita'} — ${nombre}`,
                  descripcion: `Cliente WhatsApp: ${telefono}`,
                  fecha: datosExtraidos.fecha,
                  hora: datosExtraidos.hora || '10:00',
                });
                if (evento.id) {
                  db.prepare(`UPDATE citas SET google_event_id=? WHERE id=?`).run(evento.id, citaResult.lastInsertRowid);
                  googleLink = ' (agendado en calendario ✅)';
                }
              } catch(e) { console.error('[Cita/GCal]', e.message); }
            }

            const fechaFormateada = new Date(datosExtraidos.fecha + 'T12:00:00').toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'long' });
            respuesta = `✅ *¡Cita confirmada!*\n\n📅 ${fechaFormateada}\n⏰ ${datosExtraidos.hora || '10:00'} hrs\n📋 ${datosExtraidos.servicio || 'Consulta'}${googleLink}\n\nTe esperamos, ${nombre}. Si necesitas cambiar la hora avísanos 😊`;

            await notificarDueno('cita_agendada', telefono, nombre, `📅 ${fechaFormateada} · ${datosExtraidos.hora || '10:00'} · ${datosExtraidos.servicio || 'Consulta'}`, config);
          } else {
            respuesta = `Para agendar tu cita, por favor dime:\n📅 ¿Qué día prefieres?\n⏰ ¿A qué hora?\n\nPor ejemplo: _"quiero el martes 20 a las 15:00"_`;
          }
        } catch(e) {
          console.error('[AGENDAR_CITA]', e.message);
          respuesta = `Para agendar una cita escríbenos indicando el día y la hora que prefieres 😊`;
        }
        break;
      }

      case 'AYUDA': {
        await enviarMenu(telefono, whatsappPhoneId, whatsappToken);
        respuesta = '¡Aquí tienes las opciones! 👆 También puedes escribirme directamente lo que necesitas 😊';
        break;
      }

      case 'DESPEDIDA': {
        // Respuesta fija sin pasar por IA para evitar alucinaciones de confirmación de pedido
        respuesta = '¡Hasta luego! 👋 Cuando necesites algo más, aquí estamos 😊';
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
