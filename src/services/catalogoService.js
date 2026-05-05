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

module.exports = { buscarProductos, formatearParaBot, agregarProducto, actualizarStock, listarProductos };
