// src/services/catalogoService.js
const db = require('../config/database');

/**
 * Busca productos en el catálogo manual del tenant.
 * Reemplaza a bsaleService cuando modo_catalogo = 'manual'
 */
function buscarProductos(query, tenantId, mayorista = false) {
  if (!query || query.length < 2) return [];

  const q = `%${query.toLowerCase()}%`;

  const productos = db.prepare(`
    SELECT * FROM tenant_productos
    WHERE tenant_id = ?
      AND activo = 1
      AND LOWER(nombre) LIKE ?
    LIMIT 5
  `).all(tenantId, q);

  return productos;
}

/**
 * Formatea productos del catálogo manual para WhatsApp.
 * Misma firma que bsaleService.formatearParaBot para ser intercambiable.
 */
function formatearParaBot(productos, mayorista = false, minimoMayorista = 3) {
  if (!productos || !productos.length) {
    return 'Lo siento, no tenemos ese producto disponible actualmente 😐. ¿Te gustaría consultar por otro?';
  }

  return productos.map(prod => {
    const lineas = [`📦 *${prod.nombre}*`];

    if (prod.descripcion) {
      lineas.push(`  ${prod.descripcion}`);
    }

    if (prod.stock > 0) {
      if (prod.precio_unitario > 0) {
        lineas.push(`  💵 Precio unitario: $${Math.round(prod.precio_unitario).toLocaleString('es-CL')}`);
      }

      if (mayorista && prod.precio_mayorista > 0) {
        lineas.push(`  📦 Precio mayorista (+${minimoMayorista} u.): $${Math.round(prod.precio_mayorista).toLocaleString('es-CL')}`);
      } else if (prod.precio_mayorista > 0) {
        lineas.push(`  _(Para +${minimoMayorista} unidades consulta precio mayorista)_`);
      }

      lineas.push(`  ✅ Stock disponible: ${prod.stock} unidades`);
    } else {
      lineas.push(`  ⏳ *PRONTO VOLVERÁ*`);
      lineas.push(`  Actualmente sin stock, ¡pero viene en camino! 😊`);
    }

    return lineas.join('\n');
  }).join('\n\n');
}

/**
 * Agrega un producto al catálogo manual.
 * Para usar desde el panel de onboarding.
 */
function agregarProducto(tenantId, { nombre, descripcion, precioUnitario, precioMayorista, stock }) {
  return db.prepare(`
    INSERT INTO tenant_productos (tenant_id, nombre, descripcion, precio_unitario, precio_mayorista, stock)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(tenantId, nombre, descripcion || '', precioUnitario || 0, precioMayorista || 0, stock || 0);
}

/**
 * Actualiza stock de un producto.
 */
function actualizarStock(productoId, tenantId, nuevoStock) {
  return db.prepare(`
    UPDATE tenant_productos SET stock = ? WHERE id = ? AND tenant_id = ?
  `).run(nuevoStock, productoId, tenantId);
}

/**
 * Lista todos los productos de un tenant.
 */
function listarProductos(tenantId) {
  return db.prepare(`
    SELECT * FROM tenant_productos WHERE tenant_id = ? ORDER BY nombre
  `).all(tenantId);
}

/**
 * Lista los productos marcados como "no reservables" (solo venta en tienda) de un tenant.
 */
function listarNoReservables(tenantId) {
  return db.prepare(`
    SELECT * FROM productos_no_reservables WHERE tenant_id = ? ORDER BY nombre
  `).all(tenantId);
}

function agregarNoReservable(tenantId, nombre) {
  return db.prepare(`
    INSERT INTO productos_no_reservables (tenant_id, nombre) VALUES (?, ?)
  `).run(tenantId, String(nombre).trim());
}

function eliminarNoReservable(id, tenantId) {
  return db.prepare(`
    DELETE FROM productos_no_reservables WHERE id = ? AND tenant_id = ?
  `).run(id, tenantId);
}

/**
 * Indica si un texto de producto coincide con alguno de los productos no reservables del tenant.
 * Comparación por inclusión de substring (case-insensitive) en ambos sentidos.
 */
function esNoReservable(tenantId, textoProducto, listaCache = null) {
  if (!textoProducto) return false;
  const lista = listaCache || listarNoReservables(tenantId);
  if (!lista.length) return false;
  const texto = textoProducto.toLowerCase();
  return lista.some(p => {
    const nombre = p.nombre.toLowerCase();
    return texto.includes(nombre) || nombre.includes(texto);
  });
}

module.exports = {
  buscarProductos, formatearParaBot, agregarProducto, actualizarStock, listarProductos,
  listarNoReservables, agregarNoReservable, eliminarNoReservable, esNoReservable,
};
