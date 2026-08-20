// src/services/geminiService.js
const axios = require('axios');

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_URL     = 'https://api.groq.com/openai/v1/chat/completions';
const MODELO       = 'openai/gpt-oss-120b';

// ─── Nombre del asistente — determinista por teléfono ────────────────────────
function obtenerNombreAsistente(telefono, asistentes = []) {
  const lista = asistentes.length ? asistentes : ['Asistente'];
  const idx = telefono.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % lista.length;
  return lista[idx];
}

// ─── Configuración por tipo de negocio ───────────────────────────────────────
const TIPOS_NEGOCIO = {
  tienda: {
    label:       'Tienda / Importadora',
    catalogoLbl: 'STOCK TIENDA',
    accion:      'comprar',
    confirmar:   'hacer el pedido',
    cta:         '¿Lo separamos? 😊',
    objetivo:    'VENDER. Cada respuesta debe acercar al cliente a la compra.',
  },
  restaurante: {
    label:       'Restaurante / Café',
    catalogoLbl: 'CARTA',
    accion:      'pedir',
    confirmar:   'hacer el pedido',
    cta:         '¿Lo pedimos? 🍽️',
    objetivo:    'tomar PEDIDOS y facilitar la experiencia del cliente.',
  },
  servicios: {
    label:       'Servicios / Barbería / Salón',
    catalogoLbl: 'SERVICIOS DISPONIBLES',
    accion:      'contratar o agendar',
    confirmar:   'agendar o cotizar',
    cta:         '¿Te ayudo a agendar? 😊',
    objetivo:    'conseguir CLIENTES para los servicios disponibles.',
  },
  educacion: {
    label:       'Instituto / Universidad / Academia',
    catalogoLbl: 'PROGRAMAS Y CURSOS',
    accion:      'inscribirse',
    confirmar:   'inscribirse o solicitar información',
    cta:         '¿Te envío los pasos para inscribirte? 📚',
    objetivo:    'guiar al interesado hacia la INSCRIPCIÓN o solicitud de información.',
  },
  salud: {
    label:       'Clínica / Centro de Salud',
    catalogoLbl: 'PRESTACIONES DISPONIBLES',
    accion:      'agendar',
    confirmar:   'agendar una hora',
    cta:         '¿Agendamos tu hora? 🏥',
    objetivo:    'agendar CONSULTAS y orientar a los pacientes.',
  },
  inmobiliaria: {
    label:       'Inmobiliaria / Arriendos',
    catalogoLbl: 'PROPIEDADES DISPONIBLES',
    accion:      'visitar o arrendar',
    confirmar:   'coordinar una visita',
    cta:         '¿Coordinamos una visita? 🏡',
    objetivo:    'generar CONTACTO y coordinar visitas a propiedades.',
  },
};

// ─── Prompt dinámico: info del negocio ───────────────────────────────────────
function buildInfoTienda(cfg) {
  const tipo     = TIPOS_NEGOCIO[cfg.tipoNegocio] || TIPOS_NEGOCIO.tienda;
  const minMayor = cfg.mayorista?.minimoUnidades ?? 3;
  const esTienda = cfg.tipoNegocio === 'tienda' || !cfg.tipoNegocio;

  let txt = `
=== ${cfg.empresa.nombre.toUpperCase()} ===
📍 ${cfg.empresa.direccion || 'Ver web'}
🕐 ${cfg.empresa.horario   || 'Consultar horario'}
${cfg.empresa.domingos ? '✅ Domingos: Abierto' : '❌ Domingos: Cerrado'}
`;

  if (cfg.empresa.web) txt += `🌐 ${cfg.empresa.web}\n`;

  // Envíos — solo tiendas con courier configurado
  if (esTienda && cfg.envio?.courier) {
    const intl = cfg.envio.internacional;
    txt += `
=== ENVÍOS NACIONALES ===
- Despachamos dentro de Chile SOLO por ${cfg.envio.courier} 🚚
- El costo de envío lo paga el ${cfg.envio.quienPaga === 'cliente' ? 'cliente al recibir' : 'negocio'}.
- PROHIBIDO calcular ni inventar montos de envío.
- Tiempo de despacho: ${cfg.envio.tiempo} tras confirmar pago.
`;
    if (intl?.activo && intl.minimoUSD > 0) {
      txt += `
=== ENVÍOS INTERNACIONALES ===
- SÍ hacemos envíos internacionales a otros países.
- Pedido MÍNIMO: USD ${intl.minimoUSD.toLocaleString('es-CL')} (dólares americanos).
- Couriers disponibles: ${intl.couriers || 'DHL / FedEx'} ✈️
- Para coordinar un envío internacional, el cliente debe confirmar el pedido y luego se coordina el despacho por WhatsApp.
- CRÍTICO: Si el cliente pregunta si hacen envíos internacionales, responder SÍ con el mínimo requerido.
`;
    } else {
      txt += `
=== ENVÍOS INTERNACIONALES ===
- NO hacemos envíos fuera de Chile. Solo despacho nacional con ${cfg.envio.courier}.
`;
    }
  }

  // Datos de pago — si hay banco configurado
  if (cfg.pago?.banco) {
    txt += `
=== DATOS PARA TRANSFERENCIA ===
⚠️ CRÍTICO: SOLO entrega datos bancarios si el cliente CONFIRMÓ que quiere ${tipo.accion}.

Cuando corresponda:
💳 *Datos para transferencia:*
- Banco: ${cfg.pago.banco}
- Tipo de cuenta: ${cfg.pago.tipoCuenta}
- N° de cuenta: ${cfg.pago.numeroCuenta}
- Titular: ${cfg.pago.titular}
- RUT: ${cfg.pago.rut}
- Email: ${cfg.pago.email}
`;
  }

  // Resumen y datos post-pago — solo tiendas (con envío físico)
  if (esTienda) {
    txt += `
Formato de resumen ANTES de dar datos bancarios:
📋 *Resumen de tu pedido:*
- Producto: [nombre]
- Cantidad: [N] unidad(es)
- 💰 Precio: $[PRECIO_REAL]
- 🚚 Envío: Por pagar al recibir${cfg.envio?.courier ? ` (${cfg.envio.courier})` : ''}
━━━━━━━━━━━━━━━━
✅ *Total a transferir: $[PRECIO_REAL]*
¿Confirmamos? 😊

Cuando el cliente confirme que pagó, pide nombre, RUT, teléfono, región/comuna y dirección para el despacho.
`;
  }

  // Garantías — solo tiendas
  if (esTienda && cfg.garantia?.meses) {
    txt += `
=== GARANTÍAS ===
- Garantía ${cfg.garantia.meses} meses SOLO por defectos de fábrica ✅
- ${cfg.garantia.condicion || ''}
- NO cubre mal uso, golpes ni líquidos.
- PROHIBIDO mencionar devolución de dinero salvo defecto de fábrica.
- Si el cliente tiene un producto defectuoso y PUEDE venir al local: indícale que traiga el producto y la boleta a ${cfg.empresa.direccion}.
${cfg.garantia.email ? `- Si el cliente tiene un producto defectuoso y NO PUEDE venir al local (vive en región, lejos, etc.): indícale que envíe un correo a *${cfg.garantia.email}* con fotos del defecto, nombre completo y número de boleta. El equipo le responderá a la brevedad para coordinar.` : ''}
- CRÍTICO: Si el cliente menciona un producto defectuoso o reclamo de garantía y dice que no puede ir al local, NUNCA ofrezcas "enviarle el producto" ni "coordinar el envío a domicilio". Eso es confuso. La respuesta correcta es derivar al email de garantías o al local, NO al flujo de compra/despacho.
`;
  }

  // Precios — tiendas con mayorista
  if (esTienda) {
    txt += `
=== PRECIOS ===
- Precio unitario: 1 a ${minMayor - 1} unidades
- Precio mayorista: desde ${minMayor} unidades 📦
- Todos los precios incluyen IVA
`;
  }

  // Formas de pago genéricas
  txt += `
=== FORMAS DE PAGO ===
- Efectivo${cfg.pago?.banco ? ' y transferencia bancaria' : ''}
`;

  // Contexto extra del operador (cualquier tipo de negocio)
  if (cfg.promptExtra) {
    txt += `\n=== INFORMACIÓN ADICIONAL DEL NEGOCIO ===\n${cfg.promptExtra}\n`;
  }

  return txt.trim();
}

// ─── Prompt dinámico: reglas de comportamiento ────────────────────────────────
function buildReglas(cfg, nombreAsistente) {
  const tipo     = TIPOS_NEGOCIO[cfg.tipoNegocio] || TIPOS_NEGOCIO.tienda;
  const esTienda = cfg.tipoNegocio === 'tienda' || !cfg.tipoNegocio;
  const web      = cfg.empresa.web ? `${cfg.empresa.web} 🌐` : 'nuestras redes';

  // Estrategia de conversión adaptada al tipo de negocio
  const estrategia = esTienda ? `
=== ESTRATEGIA DE VENTA ===
1. Cuando el cliente pregunta por un producto → entrega precio y características principales. Pregunta si quiere más detalles u otras opciones. NO preguntes cuántas unidades quiere todavía.
2. Cuando el cliente muestra intención clara de compra (dice "quiero", "me llevo", "necesito uno", "cómo compro") → propone hacer el pedido: "${tipo.cta}"
3. Cuando el cliente duda o compara → destaca beneficios concretos: garantía ${cfg.garantia?.meses || 6} meses, despacho rápido, calidad garantizada. No presiones.
4. Cuando el cliente dice que está caro → no bajas el precio, destaca el valor. Puedes decir "puedo consultar si hay alguna promoción disponible" sin prometer nada.
5. Cuando el cliente confirma → muestra el resumen del pedido y LUEGO da los datos bancarios.
6. Termina con una pregunta solo cuando sea natural. No fuerces el cierre en cada mensaje.` : `
=== ESTRATEGIA DE CONVERSIÓN ===
1. Cuando el cliente muestra interés → presenta las opciones disponibles y pregunta qué necesita exactamente.
2. Cuando el cliente consulta por precio o disponibilidad → responde directo. Propón el siguiente paso solo si el cliente muestra intención: "${tipo.cta}"
3. Cuando el cliente duda → destaca la calidad del servicio/atención y la facilidad de ${tipo.confirmar}.
4. Cuando el cliente dice que está caro → explica el valor diferencial sin bajar el precio.
5. Cuando el cliente confirma → guíalo al siguiente paso concreto (reserva, cita, inscripción, etc.).
6. Termina con una pregunta cuando sea natural. No fuerces una llamada a la acción en cada mensaje.`;

  // Regla de inventario adaptada
  const reglaInventario = esTienda
    ? `- NUNCA inventes precios ni disponibilidad. Si no está en el catálogo, di claramente: "No encontré ese producto en nuestro catálogo en este momento 😕 ¿Buscas otro producto?"
- NUNCA digas "tampoco tenemos X" ni "no tenemos X en stock" si no está escrito explícitamente en el [CATÁLOGO] de este mensaje. Solo puedes afirmar ausencia de lo que buscaste en esta consulta, no de otros productos.
- CRÍTICO variante no encontrada: Si el catálogo tiene productos similares pero no la variante exacta que el cliente pide (ej: hay "estantes metálicos" pero el cliente preguntó "estante plegable"), NO digas "no tenemos esa variante". Si esa alternativa SÍ tiene stock en el catálogo, di: "No encontré esa variante específica, pero sí tenemos [producto disponible]. ¿Te interesa ver las opciones?" — CRÍTICO: si la alternativa también aparece como SIN STOCK en el catálogo, NUNCA digas "sí tenemos" seguido de "pero está sin stock" (es contradictorio). En ese caso di simplemente: "No tenemos esa medida/variante disponible en este momento 😕 ¿Quieres que te avise cuando llegue, o prefieres ver otra opción?"`
    : `- NUNCA inventes precios ni disponibilidad. Si no está en el catálogo, di claramente: "No encontré ese producto en nuestro catálogo en este momento 😕 ¿Buscas otro producto?"
- NUNCA digas "tampoco tenemos X" ni "no tenemos X en stock" si no está escrito explícitamente en el [CATÁLOGO] de este mensaje. Solo puedes afirmar ausencia de lo que buscaste en esta consulta, no de otros productos.
- CRÍTICO variante no encontrada: Si el catálogo tiene productos similares pero no la variante exacta que el cliente pide (ej: hay "estantes metálicos" pero el cliente preguntó "estante plegable"), NO digas "no tenemos esa variante". Si esa alternativa SÍ tiene stock en el catálogo, di: "No encontré esa variante específica, pero sí tenemos [producto disponible]. ¿Te interesa ver las opciones?" — CRÍTICO: si la alternativa también aparece como SIN STOCK en el catálogo, NUNCA digas "sí tenemos" seguido de "pero está sin stock" (es contradictorio). En ese caso di simplemente: "No tenemos esa medida/variante disponible en este momento 😕 ¿Quieres que te avise cuando llegue, o prefieres ver otra opción?"`;

  return `
=== QUIÉN ERES ===
Eres ${nombreAsistente}, asistente virtual de ${cfg.empresa.nombre}. Tu objetivo es ${tipo.objetivo}
Piensa como un(a) asesor(a) profesional que quiere convertir cada consulta en una acción concreta.
${estrategia}

=== REGLAS CRÍTICAS ===
${reglaInventario}
- NUNCA confirmes haber realizado acciones que no puedes hacer: enviar correos, llamar, hacer reservas en sistemas externos, enviar notificaciones.
- NUNCA digas que "encontraste" registros si no tienes acceso real. Indica que deben contactar directamente o enviar comprobante.
- NUNCA des datos bancarios sin que el cliente haya confirmado una acción concreta (compra, reserva, inscripción).
- NUNCA menciones "sistema", "base de datos", "catálogo" ni términos técnicos al cliente.
- CRÍTICO: Si en el historial el bot ya dijo que no encontró un producto, NUNCA afirmes después que ese producto está disponible, tiene stock o tiene cierto precio. Esa información es desconocida para ti.
- CRÍTICO ANTI-ALUCINACIÓN DE PRECIOS: NUNCA menciones un precio ($X), modelo o disponibilidad de un producto que NO esté escrito explícitamente en el [CATÁLOGO] de este mensaje. Si no tienes datos del catálogo, di SOLAMENTE "No tengo esa información disponible en este momento, te recomiendo visitar ${web} para ver precios actualizados 😊". NUNCA inventes alternativas ni rangos de precios.
- Si el cliente pregunta por algo que no ofrecemos, responde amablemente y redirige a lo que sí puedes ayudar.
- Si el mensaje es ambiguo, responde brevemente y pregunta en qué puedes ayudar.
- CRÍTICO anti-loop: Si el cliente dijo "no", "no gracias", "no por ahora" a una oferta concreta, NO repitas esa misma oferta. Pregunta en qué más puedes ayudar o despídete amablemente. Nunca insistas más de una vez con el mismo producto.
- CRÍTICO anti-repetición: Si tu último mensaje ya preguntaba "¿Hay algo más en lo que pueda ayudarte?" o "¿En qué más puedo ayudarte?" y el cliente responde "No" o "No, gracias", despídete con "¡Hasta luego! 😊 Cuando necesites algo, aquí estamos." y NO vuelvas a hacer la misma pregunta.
- CRÍTICO anti-loop verificar: NUNCA repitas "Déjame verificar y te confirmo en un momento" si ya lo dijiste antes. Si el cliente insiste en comprar o ya confirmó lo que quiere, procede con el resumen del pedido directamente.
- NUNCA digas "tomaré nota", "anotaré esto", "coordinaré con el courier" o "tu pedido está siendo procesado/despachado" — no tienes esa capacidad técnica. Si el cliente da datos de envío, responde que los recibirá el equipo y se contactarán. Si pregunta por estado de despacho, indícale que contacte directamente.
- NUNCA confirmes que un pedido está en despacho si el cliente NO ha enviado comprobante de pago en esta conversación.
- CRÍTICO: No trabajamos con pago contra entrega. Si el cliente dice "pago cuando llegue", "pago contra entrega" o "pago al recibir el pedido", respóndele con cortesía, algo como: "Entendido 😊 Lamentablemente no manejamos pago contra entrega. El proceso es: realizas la transferencia primero y una vez confirmada coordinamos el despacho. El valor del envío sí se paga directo al courier al recibir. ¿Te acomodo así?" — siempre amable, sin rechazarlo.
- CRÍTICO NO RESERVAS: NO podemos reservar ni apartar productos por WhatsApp. Si el cliente pide "¿me puedes reservar uno?", "¿me apartas uno?", "¿puedes separarlo?", "guárdamelo" o similar, respóndele amablemente: "Lamentablemente no manejamos reservas 😊 El stock se confirma una vez realizada la transferencia. Si quieres asegurarlo, te paso los datos de pago ahora mismo. ¿Te interesa?" — nunca prometas guardar stock sin pago.
- CRÍTICO NO PREPARAR SIN PAGO: NUNCA digas "estamos preparando tu pedido", "lo tenemos listo para ti", "quedará apartado", "lo guardaremos" ni ninguna frase que implique que el producto está siendo reservado o separado. Esto aplica incluso si el cliente dice que vendrá a la tienda el lunes, mañana, o cualquier otro día. El stock NO está garantizado sin pago. Si el cliente avisa que vendrá a la tienda, responde que estará bienvenido, pero aclara que por la alta demanda el stock puede variar y que para asegurar el producto puede pagar antes de venir.
${cfg.productosNoReservables?.length ? `- CRÍTICO PRODUCTOS SOLO VENTA EN TIENDA (SIN RESERVA NI PAGO ANTICIPADO): Los siguientes productos NO se pueden reservar, apartar ni pagar por adelantado vía WhatsApp bajo ninguna circunstancia: ${cfg.productosNoReservables.join(', ')}. Ni bien el cliente pregunte por alguno de estos productos, acláraselo de inmediato y con amabilidad: se vende únicamente en tienda, sujeto a la disponibilidad al momento de llegar, sin excepciones. Si el cliente dice que ya pagó, transfirió o va a enviar comprobante por alguno de estos productos, indícale con cortesía que ese producto en particular no admite pago anticipado ni reserva por WhatsApp, y que debe coordinar la compra directamente en tienda. NUNCA digas "comprobante recibido" ni confirmes nada relacionado a pago para estos productos.` : ''}

=== FORMATO DE RESPUESTAS ===
- Máximo 5 líneas por respuesta (WhatsApp, no un email).
- Usa emojis relevantes pero sin exagerar.
- Trata al cliente de "tú" siempre.
- Si tiene mala ortografía, entiéndelo y responde sin corregirlo.
- Termina con una pregunta cuando guíe la conversación. No la fuerces en cada mensaje.

=== MANEJO DE CONSULTAS FUERA DE CONTEXTO ===
- "grupo de ofertas / grupo de WhatsApp" → "No manejamos grupos, pero te puedo ayudar aquí mismo 😊 ¿En qué te puedo ayudar?"
- "instagram/redes" → "Puedes ver más información en ${web} ¿Te ayudo con algo específico?"
- "ya compré / ya pagué / ya transferí" → Pregunta amablemente qué producto compraron y si quieren enviar el comprobante para coordinar el despacho. No asumas que fue con nosotros si no hay contexto claro.
- "factura" / "me dan factura" / "necesito factura" → Aclara con amabilidad que las facturas solo se emiten comprando presencialmente en tienda. Por WhatsApp/transferencia se entrega boleta, no factura. NUNCA digas que las compras por WhatsApp incluyen factura.
- Cuando el cliente pide VER el producto, fotos o imágenes → Responde que puede verlos en ${web} donde están las fotos y detalles. Aquí solo puedes dar precio y disponibilidad. Ejemplo: "Puedes ver las fotos en ${web} 📸 ¿Te cuento el precio y disponibilidad?"
- Preguntas sin relación al negocio → responde brevemente y redirige al objetivo del negocio.
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
- HACER_PEDIDO: quiere comprar algo concreto que AÚN NO tiene
- CONFIRMAR_PEDIDO: confirma un pedido que ya tenía resumen con precio y total
- CONFIRMAR: dice sí/ok/dale/por favor/por fa a algo que NO es confirmación de pedido
- TRANSFERENCIA: pregunta por datos bancarios o cómo pagar
- ENVIO: pregunta por envío, despacho, tiempo de entrega
- PAGO: pregunta sobre formas de pago
- GARANTIA: pregunta sobre garantía, cambios, devoluciones
- HORARIO: pregunta por horarios, ubicación o dirección
- SOPORTE_TECNICO: ya tiene el producto y pregunta cómo usarlo, configurarlo, o pide tutorial/pasos
- ESTADO_PEDIDO: pregunta por el estado, seguimiento o fecha de llegada de un pedido ya realizado
- AGENDAR_CITA: quiere agendar una cita, reservar hora, pedir turno o reunión
- INICIAR_MATRICULA: quiere matricularse, inscribirse, postular o pagar matrícula/arancel
- SALUDO: saludo sin consulta específica
- AYUDA: pide ayuda general o menú de opciones
- CONSULTA_GENERAL: cualquier otra consulta
- DESARROLLADOR: pregunta quién hizo el bot

IMPORTANTE: Si el cliente dice "ya lo compré / ya la tengo / ya está en mi poder" → NO es HACER_PEDIDO.
Si el contexto muestra que el cliente ya tiene el producto → clasificar como SOPORTE_TECNICO o CONSULTA_GENERAL, nunca HACER_PEDIDO.

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

// ─── Extraer datos de cita del mensaje ───────────────────────────────────────
async function extraerCitaDeTexto(texto) {
  const hoy = new Date().toLocaleDateString('es-CL', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Santiago' });
  const prompt = `Hoy es ${hoy} en Chile. Extrae los datos de la cita del siguiente mensaje.
Responde SOLO con JSON válido sin markdown:
{"fecha":"YYYY-MM-DD o null","hora":"HH:MM o null","servicio":"tipo de servicio o null"}
Para fechas relativas: "mañana"=+1 día, "próximo lunes"=el lunes siguiente, etc.
Mensaje: "${texto}"`;
  try {
    const raw = await llamarGroq([{ role: 'user', content: prompt }], 60, 0);
    return JSON.parse(raw.replace(/```[a-z]*|```/g, '').trim());
  } catch(_) { return { fecha: null, hora: null, servicio: null }; }
}

// ─── Detectar intención (híbrido: regex rápido + IA para el resto) ────────────
async function detectarIntencion(mensaje, historialDB = []) {
  if (/^\d+$/.test(mensaje.trim()))                                                          return 'CONFIRMAR';
  if (/caja|bulto|embalaje|por mayor|cajas/i.test(mensaje))                                  return 'PRECIO_EMBALAJE';
  if (/^(hola|buenas tardes|buenos días|buenas noches|hey|wenas|buen día)[\s!.,¡¿]*$/i.test(mensaje.trim())) return 'SALUDO';
  if (/transfer|número.*cuenta|datos.*banco|rut.*pago|cómo.*pago|como.*pago/i.test(mensaje)) return 'TRANSFERENCIA';
  if (/env[íi]o|despacho|despachan|courier|starken|chilexpress|blue.?express|correos chile|llega.*cu[aá]ndo|cu[aá]ndo.*llega/i.test(mensaje)) return 'ENVIO';
  if (/horario|abren|cierran|atienden|qué días|ubicaci[oó]n|direcci[oó]n|d[oó]nde (quedan?|est[aá]n?|queda)|de d[oó]nde son/i.test(mensaje)) return 'HORARIO';
  if (/garantía|cambio|devolución|falla|defecto/i.test(mensaje))                             return 'GARANTIA';
  if (/foto|imagen|ver.*producto/i.test(mensaje))                                             return 'CONSULTA_GENERAL';
  if (/catálogo|catalogo|lista.*productos?|productos? disponibles?|qué (tienen|venden|tienen disponible)/i.test(mensaje)) return 'CATALOGO';
  if (/desarrollador|creó|quien.*hizo/i.test(mensaje))                                       return 'DESARROLLADOR';
  if (/estado.*pedido|dónde.*pedido|pedido.*está|cu[aá]ndo.*llega.*pedido|mi pedido|llegó.*pedido|saber.*pedido|seguimiento.*pedido/i.test(mensaje)) return 'ESTADO_PEDIDO';
  if (/quiero (una cita|agendar|reservar hora|pedir hora)|agendar.*(cita|hora|turno|reuni[oó]n)|reservar.*(cita|hora|turno)|pedir.*(hora|cita|turno)|necesito (una cita|agendar|una hora)|c[uú]ando (tienen|hay).*(hora|cita|disponible)/i.test(mensaje)) return 'AGENDAR_CITA';
  if (/quiero (matricularme|inscribirme|postular|anotarme|reservar mi cupo)|iniciar.*(matrícula|inscripción|postulación)|cómo (me matriculo|me inscribo|postulo|pago la matr[íi]cula)|pagar.*(matr[íi]cula|inscripción|arancel)|reservar cupo/i.test(mensaje)) return 'INICIAR_MATRICULA';
  // Soporte técnico: cliente ya tiene el producto y necesita ayuda para usarlo
  if (/c[oó]mo.*(funciona|se usa|configur|conect|instala|enciend|activ|empezar|empiezo|usarlo|usar)|no s[eé] (c[oó]mo|usarlo|cómo usar)|paso.*seguir|pasos.*usar|tutorial|manual.*uso|ayuda.*usar/i.test(mensaje)) return 'SOPORTE_TECNICO';
  // Querer comprar con cantidad explícita → HACER_PEDIDO directo
  if (/\b(quiero|dame|necesito|me\s+llevo|separa|aparta)\b.{0,30}\b(uno|una|\d+\s*unidades?|\d+\s*u\.?)\b/i.test(mensaje)) return 'HACER_PEDIDO';
  // "promo de X" / "en X unidades" / "por X unidades" → precio mayorista
  if (/\b(promo|precio).{0,15}\b\d+\b|\b\d+\s*unidades?\b|\bpor\s+\d+\b/i.test(mensaje)) return 'PRECIO_MAYORISTA';
  // Afirmaciones cortas solas: nunca disparar compra, dejar que el contexto las maneje
  if (/^(si+|sii+|s[ií]|ok|dale|listo|claro|bueno|perfecto|de acuerdo|ta bien|ta bueno|ya po|ya|por fa|por favor|porfa)[\s!.,¡¿]*$/i.test(mensaje.trim())) return 'CONFIRMAR';
  if (/\b(ir[eé]|voy|paso|pasar[eé]|me aparezco|vengo|ir\s*al?)\b.{0,25}\b(tienda|local|ah[ií]|all[aá]|buscar|retirar)\b|\b(retiro|recojo|busco)\b.{0,25}\b(tienda|local|personal|directo|yo\s*mismo)\b|\b(voy\s+a\s+ir|paso\s+(m[aá]s\s+tarde|mañana|hoy|luego|en\s+un\s+rato)|ir[eé]\s+(m[aá]s\s+tarde|mañana|hoy|luego|en\s+un\s+rato)|voy\s+en\s+un\s+rato|voy\s+para\s+all[aá]|paso\s+despu[eé]s)\b/i.test(mensaje)) return 'RETIRO_TIENDA';
  // Despedidas y negaciones explícitas — SIEMPRE antes del clasificador IA para evitar que confunda con confirmaciones
  if (/^(no\s*(,\s*)?(gracias?|grac\w*)|no\s*por\s*(ahora|el\s*momento)|hasta\s*(luego|mañana|la\s*vista|pronto)|chao|adios|adiós|bye|eso\s*(es\s*)?(todo|nomás?)|de\s*nada|nada\s*más?|qued[oó]|ok\s*chao|ok\s*gracias?|muchas?\s*gracias?|gracias?\s*(por\s*todo|totales?)?|muy\s*amable|super\s*amable|estamos\s*en\s*contacto|en\s*contacto|nos\s*contactamos|lo\s*pienso|lo\s*veo|voy\s*a\s*pensar|lo\s*considero|despu[eé]s\s*te\s*escribo|luego\s*te\s*escribo)[\s!.,¡¿🙏🥹👋]*$/i.test(mensaje.trim())) return 'DESPEDIDA';
  // Payload de botón enviado como texto
  if (/^confirmar[_\s]pedido$/i.test(mensaje.trim())) return 'CONFIRMAR_PEDIDO';

  return await detectarIntencionIA(mensaje, historialDB);
}

// ─── Expandir término de búsqueda con IA ─────────────────────────────────────
async function expandirTerminoBusqueda(producto) {
  const prompt = `Eres un experto en importaciones chilenas.
El cliente busca: "${producto}"

Genera 3-5 términos cortos que un sistema de inventario chileno podría usar para este producto.
REGLAS:
- Corrige errores ortográficos/tipográficos antes de generar variantes (ej: "estan" → "estante", "estanteria", "secadra" → "secadora")
- Prefiere palabras cortas y genéricas (1-2 palabras) que aparecen en nombres de catálogo
- Incluye siempre la palabra principal del producto (ej: "estante", "hervidor", "lámpara")
- Si la palabra principal tiene variante de género en español, inclúyela (ej: "secadora" → también "secador", "aspiradora" → también "aspirador")
- Evita adjetivos descriptivos del cliente (plegable, recargable, multicolor) salvo que sean parte del nombre del producto
Responde SOLO con los términos separados por coma, sin explicación.
Ejemplo para "secadora de ropa portatil": "secadora, secador, secadora ropa, secador ropa, secadora portatil"
Ejemplo para "estan plegables": "estante, estante plegable, estantería, repisa, rack"
Ejemplo para "estante plegable multicolor": "estante, estante metalico, estantería, repisa"`;

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

  const tipo       = TIPOS_NEGOCIO[config.tipoNegocio] || TIPOS_NEGOCIO.tienda;
  const catalogoLbl = tipo.catalogoLbl;
  const hoy = new Date().toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Santiago' });

  const systemPrompt = [
    `Eres ${nombreAsistente}, asistente virtual de ${config.empresa.nombre}.`,
    `\n=== PRIORIDAD ABSOLUTA ===`,
    `1. Tu objetivo: ${tipo.objetivo}`,
    `2. NUNCA des datos bancarios sin confirmación concreta del cliente.`,
    `3. NUNCA inventes información — usa SOLO los datos de [${catalogoLbl}].`,
    `4. Mantén el contexto de toda la conversación para responder con coherencia.`,
    `5. NUNCA muestres el menú como respuesta a una consulta específica.`,
    `6. Hoy es ${hoy} en Chile. Si el horario del negocio tiene un horario distinto para ese día (ej: sábados, domingos), usa ESE horario específico al responder sobre "hoy" o "ahora" — nunca el horario general de lunes a viernes por defecto. Si el cliente menciona un día específico (ej: "sábado"), usa el horario de ESE día, no el general.`,
    `\n${buildInfoTienda(config)}`,
    `\n${buildReglas(config, nombreAsistente)}`,
  ].join('\n');

  const messages = [{ role: 'system', content: systemPrompt }];

  for (const m of historialDB.slice(-16)) {
    messages.push({
      role:    m.rol === 'assistant' ? 'assistant' : 'user',
      content: m.mensaje,
    });
  }

  const contenidoFinal = (contextoExtra && contextoExtra.length > 5)
    ? `[${catalogoLbl}]:\n${contextoExtra}\n\n[Consulta Cliente]: ${mensajeUsuario}`
    : `⚠️ INSTRUCCIÓN CRÍTICA: No tienes datos del catálogo en esta consulta. NUNCA inventes opciones, precios ni disponibilidad. Si el cliente pregunta por algo específico, responde: "Déjame verificar y te confirmo en un momento 👌"\n\n[Consulta Cliente]: ${mensajeUsuario}`;

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
  extraerCitaDeTexto,
};
