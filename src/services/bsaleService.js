// src/services/bsaleService.js
const axios = require('axios');

const BASE = 'https://api.bsale.io/v1';

const LISTAS = {
  unitario:   { id: 6, nombre: 'Precio unitario' },
  mayorista2: { id: 8, nombre: 'Precio mayorista' },
  mayorista3: { id: 7, nombre: 'Precio mayor 3' },
};

const MINIMO_MAYORISTA = 3;

const api = axios.create({ baseURL: BASE, timeout: 10000 });

// ─── Cache 5 minutos ──────────────────────────────────────────────────────────
const cache   = new Map();
const enVuelo = new Map();
const TTL     = 5 * 60 * 1000;

const getCache = k => {
  const i = cache.get(k);
  if (!i) return null;
  if (Date.now() - i.ts > TTL) { cache.delete(k); return null; }
  return i.v;
};
const setCache = (k, v) => cache.set(k, { v, ts: Date.now() });

// ─── Generar variantes de búsqueda ───────────────────────────────────────────
function generarVariantesBusqueda(query) {
  const variantes = new Set();
  const q = query.toLowerCase().trim();
  const palabras = q.split(/\s+/);

  variantes.add(q);

  if (palabras.length >= 2) {
    variantes.add(`${palabras[0]} ${palabras[1]}`);
  }

  // Genera variantes singulares de una palabra en español.
  // Agrega AMBAS formas cuando termina en 'es' para cubrir:
  //   "estantes" → "estante" (quitar 's') Y "estant" (quitar 'es')
  // Bsale ignora los términos que no existen, así que variantes extra no hacen daño.
  const procesarSingulares = (texto) => {
    const res = [];
    if (texto.endsWith('es') && texto.length > 4) {
      res.push(texto.slice(0, -1));  // quitar solo 's' → "estante"
      res.push(texto.slice(0, -2));  // quitar 'es'    → "estant" / "camion"
    } else if (texto.endsWith('s') && texto.length > 3) {
      res.push(texto.slice(0, -1));
    }
    return res;
  };

  for (const s of procesarSingulares(q)) variantes.add(s);

  // Agregar cada palabra significativa por separado (>3 chars) para ampliar búsqueda
  for (const p of palabras) {
    if (p.length > 3) {
      variantes.add(p);
      for (const s of procesarSingulares(p)) variantes.add(s);
    }
  }

  return [...variantes];
}

// ─── Buscar productos por nombre ──────────────────────────────────────────────
async function buscarProductos(query, limite = 4, token = null) {
  const bsaleToken = token || process.env.BSALE_TOKEN;
  const key = `prod_${bsaleToken}_${query}`;
  if (getCache(key)) return getCache(key);
  if (enVuelo.has(key)) return enVuelo.get(key);

  const promesa = (async () => {
    const variantes = generarVariantesBusqueda(query);
    console.log(`[Bsale] 🔎 Variantes: ${variantes.join(', ')}`);

    const idsVistos = new Set();
    const items     = [];

    for (const variante of variantes) {
      if (items.length >= limite) break;
      try {
        const { data } = await api.get('/products.json', {
          headers: { 'access_token': bsaleToken },
          params:  { name: variante, limit: limite, state: 0 },
        });
        for (const p of (data.items || [])) {
          if (!idsVistos.has(p.id)) {
            idsVistos.add(p.id);
            items.push({ id: p.id, nombre: p.name });
            if (items.length >= limite) break;
          }
        }
      } catch (e) {
        console.error(`[Bsale] buscarProductos (${variante}):`, e.message);
      }
    }

    setCache(key, items);
    return items;
  })().finally(() => {
    enVuelo.delete(key);
  });

  enVuelo.set(key, promesa);
  return promesa;
}

// ─── Obtener variantes de un producto ────────────────────────────────────────
async function obtenerVariantes(productoId, token = null) {
  const bsaleToken = token || process.env.BSALE_TOKEN;
  const key = `var_${bsaleToken}_${productoId}`;
  if (getCache(key)) return getCache(key);
  try {
    const { data } = await api.get(`/products/${productoId}/variants.json`, {
      headers: { 'access_token': bsaleToken },
    });
    const items = (data.items || []).map(v => ({
      id:          v.id,
      descripcion: v.description || '',
      codigo:      v.code || '',
    }));
    setCache(key, items);
    return items;
  } catch (e) {
    console.error('[Bsale] obtenerVariantes:', e.message);
    return [];
  }
}

// ─── Obtener precio de una lista específica ───────────────────────────────────
async function obtenerPrecioLista(variantId, listaId, token = null) {
  const bsaleToken = token || process.env.BSALE_TOKEN;
  const key = `precio_${bsaleToken}_${listaId}_${variantId}`;
  if (getCache(key)) return getCache(key);
  try {
    const { data } = await api.get(`/price_lists/${listaId}/details.json`, {
      headers: { 'access_token': bsaleToken },
      params:  { variantid: variantId },
    });
    const precio = data.items?.[0]?.variantValueWithTaxes || 0;
    setCache(key, precio);
    return precio;
  } catch (e) {
    return 0;
  }
}

// ─── Obtener stock de la variante ─────────────────────────────────────────────
async function obtenerStock(variantId, token = null) {
  const bsaleToken = token || process.env.BSALE_TOKEN;
  try {
    const { data } = await api.get('/stocks.json', {
      headers: { 'access_token': bsaleToken },
      params:  { variantid: variantId },
    });
    return (data.items || []).reduce((acc, item) => acc + (item.quantityAvailable ?? item.quantity ?? 0), 0);
  } catch (e) {
    return 0;
  }
}

// ─── Obtener todos los datos de una variante ──────────────────────────────────
async function obtenerDatosVariante(variantId, token = null) {
  const [unitario, mayorista2, mayorista3, stock] = await Promise.all([
    obtenerPrecioLista(variantId, LISTAS.unitario.id,   token),
    obtenerPrecioLista(variantId, LISTAS.mayorista2.id, token),
    obtenerPrecioLista(variantId, LISTAS.mayorista3.id, token),
    obtenerStock(variantId, token),
  ]);
  return { unitario, mayorista2, mayorista3, stock };
}

// ─── Búsqueda completa ────────────────────────────────────────────────────────
async function buscarConPreciosYStock(query, incluirMayorista = false, token = null) {
  const productos = await buscarProductos(query, 5, token);
  if (!productos.length) return [];

  const resultadosCompletos = await Promise.all(productos.map(async prod => {
    const variantes = await obtenerVariantes(prod.id, token);
    const variantesConDatos = await Promise.all(variantes.slice(0, 3).map(async v => {
      const datos = await obtenerDatosVariante(v.id, token);
      return { ...v, precios: datos, stock: datos.stock };
    }));
    return { ...prod, variantes: variantesConDatos, incluirMayorista };
  }));

  return resultadosCompletos.filter(r => r !== null).slice(0, 3);
}

// ─── Formatear para WhatsApp ──────────────────────────────────────────────────
function formatearParaBot(resultados) {
  if (!resultados || !resultados.length) {
    return 'Lo siento, no tenemos ese producto con stock disponible actualmente 😐. ¿Te gustaría consultar por otro?';
  }

  return resultados.map(prod => {
    const lineas = [`📦 *${prod.nombre}*`];

    prod.variantes.forEach(v => {
      const desc = v.descripcion && v.descripcion !== prod.nombre
        ? `*${v.descripcion}*\n  ` : '  ';

      if (v.stock > 0) {
        const precioUnit = v.precios.unitario > 0
          ? `💵 Precio unitario: $${Math.round(v.precios.unitario).toLocaleString('es-CL')}`
          : '💵 Precio unitario: Consultar';

        lineas.push(`${desc}${precioUnit}`);

        if (prod.incluirMayorista) {
          const precioMay2 = v.precios.mayorista2 > 0
            ? `📦 Precio mayorista (+${MINIMO_MAYORISTA} u.): $${Math.round(v.precios.mayorista2).toLocaleString('es-CL')}`
            : null;
          if (precioMay2) lineas.push(`  ${precioMay2}`);
        } else {
          lineas.push(`  _(Para +${MINIMO_MAYORISTA} unidades consulta precio mayorista)_`);
        }
      } else {
        lineas.push(`${desc}⏳ *SIN STOCK*`);
        lineas.push(`  Actualmente no tenemos unidades disponibles.`);
      }
    });

    return lineas.join('\n');
  }).join('\n\n');
}

function tieneStock(resultados) {
  return Array.isArray(resultados) && resultados.some(p => p.variantes?.some(v => v.stock > 0));
}

module.exports = {
  buscarProductos,
  obtenerVariantes,
  obtenerPrecios: obtenerDatosVariante,
  buscarConPreciosYStock,
  formatearParaBot,
  tieneStock,
  MINIMO_MAYORISTA,
};
