// src/services/geminiService.js
const axios = require('axios');

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_URL     = 'https://api.groq.com/openai/v1/chat/completions';
const MODELO       = 'llama-3.3-70b-versatile';

// ─── Nombre del asistente — determinista por teléfono ────────────────────────
function obtenerNombreAsistente(telefono, asistentes = []) {
  const lista = asistentes.length ? asistentes : ['Asistente'];
  const idx = telefono.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % lista.length;
  return lista[idx];
}

// ─── Prompt dinámico: info de la tienda ───────────────────────────────────────
function buildInfoTienda(cfg) {
  const minMayor = cfg.mayorista?.minimoUnidades ?? 3;
  return `
=== ${cfg.empresa.nombre.toUpperCase()} ===
📍 ${cfg.empresa.direccion}
🕐 ${cfg.empresa.horario}
❌ Domingos: ${cfg.empresa.domingos ? 'Abierto' : 'Cerrado'}

=== ENVÍOS ===
- Despachamos a todo Chile SOLO por ${cfg.envio.courier} 🚚
- El costo de envío SIEMPRE lo paga el ${cfg.envio.quienPaga === 'cliente' ? 'cliente al recibir' : 'negocio'}.
- PROHIBIDO: No calcules ni inventes montos de envío.
- Si preguntan el costo: "El valor lo calcula ${cfg.envio.courier} según peso y tamaño al despachar".
- Tiempo de despacho: ${cfg.envio.tiempo} tras confirmar pago.

=== DATOS PARA TRANSFERENCIA ===
⚠️ CRÍTICO: SOLO entrega datos bancarios si el cliente CONFIRMÓ explícitamente que quiere comprar Y ya se le mostró el resumen del pedido. NUNCA los des si el cliente solo pregunta o consulta.

Cuando corresponda, usa EXACTAMENTE este formato:
💳 *Datos para transferencia:*
- Banco: ${cfg.pago.banco}
- Tipo de cuenta: ${cfg.pago.tipoCuenta}
- N° de cuenta: ${cfg.pago.numeroCuenta}
- Titular: ${cfg.pago.titular}
- RUT: ${cfg.pago.rut}
- Email: ${cfg.pago.email}

Formato de resumen de venta ANTES de dar datos bancarios:
📋 *Resumen de tu pedido:*
- Producto: [nombre]
- Cantidad: [N] unidad(es)
- 💰 Precio: $[PRECIO_REAL]
- 🚚 Envío: Por pagar al recibir (${cfg.envio.courier})
━━━━━━━━━━━━━━━━
✅ *Total a transferir: $[PRECIO_REAL]*
¿Confirmamos? 😊

=== DATOS POST-TRANSFERENCIA ===
Cuando el cliente confirme que pagó, pide:
"¡Perfecto! 🎉 Para procesar tu pedido necesito:
📝 *Nombre completo:*
🪪 *RUT:*
📱 *Teléfono:*
📍 *Región y Comuna:*
🏠 *Dirección exacta:*
Una vez que me envíes estos datos y el comprobante, coordinaremos el despacho 🚚"

=== GARANTÍAS Y DEVOLUCIONES ===
- Garantía legal de ${cfg.garantia.meses} meses SOLO por defectos de fábrica ✅
- ${cfg.garantia.condicion}
- NO cubre: mal uso, golpes, líquidos, ni disgusto con el producto.
- COMPRAS PRESENCIALES: NO se aceptan cambios ni devoluciones por "no cumplió expectativas".
- COMPRAS ONLINE: Solo garantía por defecto de fábrica, NO por arrepentimiento.
- PROHIBIDO mencionar devolución de dinero salvo defecto comprobado de fábrica.

=== FORMAS DE PAGO ===
- Efectivo, débito y crédito en tienda
- Transferencia bancaria para compras por WhatsApp

=== PRECIOS ===
- Precio unitario: 1 a ${minMayor - 1} unidades
- Precio mayorista: desde ${minMayor} unidades del mismo producto 📦
- Todos los precios incluyen IVA`.trim();
}

// ─── Prompt dinámico: reglas de comportamiento ────────────────────────────────
function buildReglas(cfg, nombreAsistente) {
  return `
=== QUIÉN ERES ===
Eres ${nombreAsistente}, vendedora experta de ${cfg.empresa.nombre}. Tu objetivo principal es VENDER — no solo informar.
Piensa como una vendedora presencial que quiere cerrar cada conversación con una venta.

=== ESTRATEGIA DE VENTA ===
1. Cuando el cliente muestra interés en un producto → muestra precio y pregunta cuántas unidades quiere.
2. Cuando el cliente pregunta el precio → entrega el precio Y propone hacer el pedido: "¿Te lo separamos? 😊"
3. Cuando el cliente duda → destaca beneficios: garantía ${cfg.garantia.meses} meses, despacho rápido, calidad garantizada.
4. Cuando el cliente dice que está caro → no bajas el precio, pero destacas el valor. Puedes decir "puedo consultar con el equipo si hay alguna promoción disponible" sin prometer nada.
5. Cuando el cliente confirma → muestra el resumen del pedido y LUEGO da los datos bancarios.
6. SIEMPRE termina con una pregunta para mantener la conversación activa.

=== REGLAS CRÍTICAS ===
- NUNCA inventes precios. Si no está en [STOCK TIENDA BSALE], di: "Déjame consultar con bodega y te confirmo en un momento 👌"
- NUNCA confirmes haber realizado acciones que no puedes hacer: enviar correos, llamar, contactar bodega físicamente, enviar notificaciones.
- NUNCA digas que "encontraste el pedido" si no tienes acceso real a la BD de pedidos. Indica que deben enviar el comprobante o contactar directamente.
- NUNCA des datos bancarios sin que el cliente haya confirmado un pedido concreto.
- NUNCA interpretes precios como cantidades ("el de $23.000" = eligiendo por precio, no pidiendo 23 unidades).
- NUNCA menciones "sistema", "base de datos", "catálogo" ni términos técnicos al cliente.
- NUNCA inventes productos que no estén en Bsale.
- Si el cliente pregunta por algo que no vendemos, responde amablemente y redirige a lo que sí puedes ayudar.
- Si el cliente no recuerda el nombre del producto, ayúdalo con preguntas: "¿Para qué lo usas? ¿Cómo es?"
- Si el mensaje es ambiguo o no tiene relación con una compra, responde brevemente y pregunta en qué puedes ayudar.

=== FORMATO DE RESPUESTAS ===
- Máximo 5 líneas por respuesta (WhatsApp, no un email).
- Usa emojis relevantes pero sin exagerar.
- Trata al cliente de "tú" siempre.
- Si tiene mala ortografía, entiéndelo y responde sin corregirlo.
- Celebra cuando quiere comprar: "¡Excelente elección! 🎉"
- Siempre termina con una pregunta o llamada a la acción.

=== MANEJO DE CONSULTAS FUERA DE CONTEXTO ===
- "grupo de ofertas" → "No manejamos grupo, pero te puedo avisar de productos aquí mismo 😊 ¿Qué tipo de productos te interesan?"
- "instagram/redes" → "Puedes ver productos en ${cfg.empresa.web} 🌐 ¿Te busco algo específico?"
- Preguntas sin relación al negocio → responde brevemente y redirige a ventas.
- NUNCA muestres el menú de opciones como respuesta a una consulta específica.`.trim();
}

// ─── Llamada base a Groq ──────────────────────────────────────────────────────
async function llamarGroq(messages, maxTokens = 400, temperature = 0.3) {
  const { data } = await axios.post(GROQ_URL, {
    model:       MODELO,
    messages,
    max_tokens:  maxTokens,
    temperature,
  }, {
    headers: {
      Authorization:  `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    timeout: 15000,
  });
  return data?.choices?.[0]?.message?.content?.trim() || '';
}

// ─── Extraer producto con IA ──────────────────────────────────────────────────
async function extraerProductoConIA(mensaje, historialDB = []) {
  const contextoPrevio = historialDB.slice(-8).map(m => `${m.rol}: ${m.mensaje}`).join(' | ');

  const prompt = `Analiza la conversación y dime el nombre del PRODUCTO del que se está hablando.

Contexto anterior: "${contextoPrevio}"
Mensaje actual del cliente: "${mensaje}"

REGLAS:
1. Responde SOLO con el nombre del producto (ej: "tv box", "hervidor", "foco solar").
2. Si el mensaje actual NO dice el nombre, BÚSCALO en el contexto anterior.
3. Si el cliente pregunta por algo nuevo, prioriza el mensaje actual.
4. Si no hay ningún producto claro o es una consulta general, responde "".
5. PROHIBIDO: puntos, explicaciones, frases largas. Solo el nombre del producto.
6. Si el mensaje es sobre grupos, redes sociales, o temas no relacionados a productos, responde "".`;

  try {
    const resultado = await llamarGroq([{ role: 'user', content: prompt }], 20, 0);
    const producto = resultado.replace(/['"().]/g, '').trim().toLowerCase();
    console.log(`[IA] 🏷️ Producto extraído: "${producto}"`);
    return producto;
  } catch (_) {
    return '';
  }
}

// ─── Detectar intención con IA ────────────────────────────────────────────────
async function detectarIntencionIA(mensaje, historialDB = []) {
  const contextoPrevio = historialDB.slice(-4).map(m => `${m.rol}: ${m.mensaje}`).join('\n');

  const prompt = `Eres un clasificador de mensajes de WhatsApp para una tienda de importaciones chilena.

Contexto reciente de la conversación:
${contextoPrevio || '(sin contexto previo)'}

Mensaje actual del cliente: "${mensaje}"

Clasifica el mensaje actual considerando el contexto. Categorías:
- BUSCAR_PRODUCTO: pregunta por un producto específico o su precio
- PRECIO_MAYORISTA: pregunta por cantidad mayor o precio por volumen
- HACER_PEDIDO: quiere comprar algo concreto
- CONFIRMAR_PEDIDO: confirma un pedido que ya tenía resumen con precio y total
- CONFIRMAR: dice sí/ok/dale a algo que NO es confirmación de pedido
- TRANSFERENCIA: pregunta por datos bancarios o cómo pagar
- ENVIO: pregunta por envío, despacho, tiempo de entrega
- PAGO: pregunta sobre formas de pago
- GARANTIA: pregunta sobre garantía, cambios, devoluciones
- HORARIO: pregunta por horarios, ubicación o dirección
- SALUDO: saludo sin consulta específica
- AYUDA: pide ayuda general o menú de opciones
- CONSULTA_GENERAL: cualquier otra consulta
- DESARROLLADOR: pregunta quién hizo el bot

Responde SOLO con la categoría exacta, sin explicación.`;

  try {
    const intencion = await llamarGroq([{ role: 'user', content: prompt }], 15, 0);
    const resultado = intencion.toUpperCase().trim() || 'CONSULTA_GENERAL';
    console.log(`[IA] 🎯 Intención IA: ${resultado}`);
    return resultado;
  } catch (err) {
    console.error('[detectarIntencionIA Error]:', err.message);
    return 'CONSULTA_GENERAL';
  }
}

// ─── Detectar intención (híbrido: regex rápido + IA para el resto) ────────────
async function detectarIntencion(mensaje, historialDB = []) {
  if (/^\d+$/.test(mensaje.trim()))                                                          return 'CONFIRMAR';
  if (/caja|bulto|embalaje|por mayor|cajas/i.test(mensaje))                                  return 'PRECIO_EMBALAJE';
  if (/^(hola|buenas tardes|buenos días|buenas noches|hey|wenas|buen día)\b/i.test(mensaje)) return 'SALUDO';
  if (/transfer|número.*cuenta|datos.*banco|rut.*pago|cómo.*pago|como.*pago/i.test(mensaje)) return 'TRANSFERENCIA';
  if (/horario|abren|cierran|atienden|qué días|ubicaci[oó]n|direcci[oó]n/i.test(mensaje))    return 'HORARIO';
  if (/garantía|cambio|devolución|falla|defecto|no funciona/i.test(mensaje))                 return 'GARANTIA';
  if (/foto|imagen|ver.*producto/i.test(mensaje))                                             return 'CONSULTA_GENERAL';
  if (/desarrollador|creó|quien.*hizo/i.test(mensaje))                                       return 'DESARROLLADOR';

  return await detectarIntencionIA(mensaje, historialDB);
}

// ─── Expandir término de búsqueda con IA ─────────────────────────────────────
async function expandirTerminoBusqueda(producto) {
  const prompt = `Eres un experto en importaciones chilenas.
El cliente busca: "${producto}"

Genera 3-4 términos alternativos en español que podría usar este producto en un sistema de inventario chileno.
Responde SOLO con los términos separados por coma, sin explicación.
Ejemplo: "repisa, estantería, shelving, rack"`;

  try {
    const resultado = await llamarGroq([{ role: 'user', content: prompt }], 30, 0);
    const terminos = resultado.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
    console.log(`[IA] 🔍 Variantes expandidas: ${terminos.join(', ')}`);
    return terminos;
  } catch (_) {
    return [producto];
  }
}

// ─── Generar respuesta ────────────────────────────────────────────────────────
async function generarRespuesta(mensajeUsuario, historialDB = [], contextoExtra = '', telefono = '', config = null) {
  if (!config) {
    console.error('[Groq] ❌ generarRespuesta llamada sin config de tenant');
    return '😅 Tuve un problema técnico. Por favor intenta de nuevo en un momento.';
  }

  const nombreAsistente = telefono
    ? obtenerNombreAsistente(telefono, config.asistentes)
    : (config.asistentes?.[0] ?? 'Asistente');

  const embalajesPrompt = (() => {
    const embs = config.embalajes || [];
    if (!embs.length) return '';
    const lista = embs.map((p, i) =>
      `${i + 1}. ${p.nombre} (Caja de ${p.unidades}u): $${p.precioUnitario.toLocaleString('es-CL')} c/u (Total caja: $${(p.totalCaja || p.precioUnitario * p.unidades).toLocaleString('es-CL')})`
    ).join('\n');
    return `\n=== CATÁLOGO EMBALAJE MAYORISTA (CAJA CERRADA) ===\nSOLO entregar si el cliente pregunta por caja, bulto o embalaje:\n${lista}`;
  })();

  const systemPrompt = [
    `Eres ${nombreAsistente}, vendedora experta de ${config.empresa.nombre}. 🛍️`,
    `\n=== PRIORIDAD ABSOLUTA ===`,
    `1. Tu objetivo es VENDER. Cada respuesta debe acercar al cliente a la compra.`,
    `2. NUNCA des datos bancarios sin pedido confirmado.`,
    `3. NUNCA inventes precios — usa SOLO los datos de [STOCK TIENDA BSALE].`,
    `4. Mantén el contexto de toda la conversación para responder con coherencia.`,
    `5. NUNCA muestres el menú como respuesta a una consulta específica.`,
    `\n${buildInfoTienda(config)}`,
    `\n${buildReglas(config, nombreAsistente)}`,
    embalajesPrompt,
  ].join('\n');

  const messages = [{ role: 'system', content: systemPrompt }];

  for (const m of historialDB.slice(-16)) {
    messages.push({
      role:    m.rol === 'assistant' ? 'assistant' : 'user',
      content: m.mensaje,
    });
  }

  const contenidoFinal = (contextoExtra && contextoExtra.length > 5)
    ? `[STOCK TIENDA BSALE]:\n${contextoExtra}\n\n[Consulta Cliente]: ${mensajeUsuario}`
    : mensajeUsuario;

  messages.push({ role: 'user', content: contenidoFinal });

  try {
    const texto = await llamarGroq(messages, 450, 0.3);
    if (!texto) throw new Error('Respuesta vacía de Groq');
    return texto;
  } catch (err) {
    console.error('[Groq Error]:', err.response?.data || err.message);
    return '¡Ups! 😅 Tuve un pequeño problema técnico. ¿Puedes repetir tu consulta?';
  }
}

module.exports = {
  generarRespuesta,
  detectarIntencion,
  extraerProductoConIA,
  obtenerNombreAsistente,
  expandirTerminoBusqueda,
};
