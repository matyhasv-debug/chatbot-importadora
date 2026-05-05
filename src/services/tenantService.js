// src/services/tenantService.js
const db = require('../config/database');

const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function getConfigByPhoneId(phoneNumberId) {
  const cached = cache.get(phoneNumberId);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.config;

  const tenant = db.prepare(`
    SELECT * FROM tenants WHERE whatsapp_phone_id = ? AND activo = 1
  `).get(phoneNumberId);

  if (!tenant) return null;

  const config = buildConfig(tenant);
  cache.set(phoneNumberId, { config, ts: Date.now() });
  return config;
}

function getConfigBySlug(slug) {
  const tenant = db.prepare(`
    SELECT * FROM tenants WHERE slug = ? AND activo = 1
  `).get(slug);
  if (!tenant) return null;
  return buildConfig(tenant);
}

function buildConfig(tenant) {
  const embalajes = db.prepare(`
    SELECT nombre, unidades, precio_unitario AS precioUnitario, total_caja AS totalCaja
    FROM tenant_embalajes WHERE tenant_id = ?
  `).all(tenant.id);

  return {
    tenantId: tenant.id,
    modoCatalogo: tenant.modo_catalogo || 'bsale',
    empresa: {
      nombre:    tenant.empresa_nombre,
      direccion: tenant.empresa_dir,
      web:       tenant.empresa_web,
      horario:   tenant.empresa_horario,
      domingos:  !!tenant.empresa_domingos,
    },
    asistentes: JSON.parse(tenant.asistentes || '[]'),
    pago: {
      banco:        tenant.pago_banco,
      tipoCuenta:   tenant.pago_tipo,
      numeroCuenta: tenant.pago_cuenta,
      titular:      tenant.pago_titular,
      rut:          tenant.pago_rut,
      email:        tenant.pago_email,
    },
    envio: {
      courier:   tenant.envio_courier,
      tiempo:    tenant.envio_tiempo,
      quienPaga: tenant.envio_quien_paga,
    },
    mayorista: { minimoUnidades: tenant.mayorista_minimo },
    garantia: {
      meses:     tenant.garantia_meses,
      condicion: tenant.garantia_cond,
    },
    credenciales: {
      bsaleToken:      tenant.bsale_token,
      whatsappPhoneId: tenant.whatsapp_phone_id,
      whatsappToken:   tenant.whatsapp_token,
      notifTelefono:   tenant.notif_telefono,
    },
    embalajes,
  };
}

function invalidarCache(phoneNumberId) {
  cache.delete(phoneNumberId);
}

function invalidarCacheByTenantId(tenantId) {
  for (const [phoneId, entry] of cache.entries()) {
    if (entry.config.tenantId === tenantId) {
      cache.delete(phoneId);
      return;
    }
  }
}

function listarTenants() {
  return db.prepare(`SELECT id, slug, empresa_nombre, activo, creado_en FROM tenants`).all();
}

module.exports = { getConfigByPhoneId, getConfigBySlug, invalidarCache, invalidarCacheByTenantId, listarTenants };
