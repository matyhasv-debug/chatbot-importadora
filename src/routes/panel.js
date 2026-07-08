// src/routes/panel.js
const express    = require('express');
const path       = require('path');
const axios      = require('axios');
const multer     = require('multer');
const db         = require('../config/database');
const jwt        = require('jsonwebtoken');
const bcrypt     = require('bcryptjs');
const { invalidarCacheByTenantId } = require('../services/tenantService');
const { MENSAJES_DEFAULT }          = require('../services/followUpService');
const pdfService  = require('../services/pdfService');
const calendarService = require('../services/calendarService');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const JWT_SECRET = process.env.JWT_SECRET || (() => {
  console.error('[Panel] ⚠️  JWT_SECRET no configurado. Define JWT_SECRET en .env para producción.');
  return 'fallback_secret_inseguro';
})();

// ─── Helper: verificar auth cliente (JWT o key legacy) ───────────────────────
function verificarAuthCliente(req, res, tenant) {
  // JWT: header o query param (SSE no puede enviar headers)
  const auth = req.headers.authorization || '';
  const rawToken = auth.startsWith('Bearer ') ? auth.slice(7) : (req.query.token || null);
  if (rawToken) {
    try { jwt.verify(rawToken, JWT_SECRET); return true; }
    catch (_) { res.status(401).json({ ok: false, error: 'Token inválido' }); return false; }
  }
  // Si el tenant tiene credenciales configuradas, siempre requiere JWT
  if (tenant.panel_usuario) {
    res.status(401).json({ ok: false, error: 'No autorizado' });
    return false;
  }
  // Autenticación legacy por panel_key (solo si no hay panel_usuario)
  const key = req.query.key || '';
  if (!tenant.panel_key || tenant.panel_key !== key) {
    res.status(401).json({ ok: false, error: 'No autorizado' });
    return false;
  }
  return true;
}

// ─── Helper: verificar auth admin (PANEL_SECRET) ─────────────────────────────
function verificarAdmin(req, res, next) {
  const secret = process.env.PANEL_SECRET;
  if (!secret) {
    return res.status(503).json({ ok: false, error: 'Panel no configurado. Define PANEL_SECRET en .env.' });
  }
  const key = req.query.key || req.headers['x-admin-key'] || '';
  if (key !== secret) {
    return res.status(401).json({ ok: false, error: 'No autorizado' });
  }
  next();
}

const router = express.Router();

// ─── Estados de pago ──────────────────────────────────────────────────────────
const ESTADOS = {
  sin_contacto:    { label: 'Sin contacto',    color: '#475569', emoji: '⚪' },
  en_conversacion: { label: 'En conversación', color: '#3b82f6', emoji: '💬' },
  consultando:     { label: 'Consultando',     color: '#06b6d4', emoji: '🔍' },
  cotizado:        { label: 'Cotizado',        color: '#f97316', emoji: '📋' },
  confirmado:      { label: 'Confirmado',      color: '#8b5cf6', emoji: '🎯' },
  pago_pendiente:  { label: 'Pago pendiente',  color: '#f59e0b', emoji: '⏳' },
  pagado:          { label: 'Pagado',          color: '#22c55e', emoji: '✅' },
  despachado:      { label: 'Despachado',      color: '#a855f7', emoji: '🚚' },
  abandono:        { label: 'Abandono',        color: '#ef4444', emoji: '👻' },
};

// ─── Inicializar columna estado ───────────────────────────────────────────────
try {
  db.prepare(`ALTER TABLE clientes ADD COLUMN estado TEXT DEFAULT 'en_conversacion'`).run();
} catch (_) {}

// ─── SSE clients ──────────────────────────────────────────────────────────────
const sseClients = new Set();
const sseClientesByTenant = new Map(); // tenantId -> Set<res>

// Cache phone→tenantId para evitar query en cada evento
const _tenantPorTelefono = new Map();
function _getTenantIdPorTelefono(telefono) {
  const c = _tenantPorTelefono.get(telefono);
  if (c && Date.now() - c.ts < 5 * 60 * 1000) return c.v;
  const row = db.prepare(`SELECT tenant_id FROM conversaciones WHERE telefono = ? ORDER BY creado_en DESC LIMIT 1`).get(telefono);
  const v = row?.tenant_id || null;
  _tenantPorTelefono.set(telefono, { v, ts: Date.now() });
  return v;
}

function emitirEvento(tipo, datos) {
  const payload = `data: ${JSON.stringify({ tipo, ...datos })}\n\n`;
  // Admin panel (ve todo)
  for (const res of sseClients) {
    try { res.write(payload); } catch (_) { sseClients.delete(res); }
  }
  // Tenant panels (solo los suyos)
  if (sseClientesByTenant.size > 0) {
    const telefono = datos.mensaje?.telefono || datos.telefono || null;
    if (telefono) {
      const tenantId = _getTenantIdPorTelefono(telefono);
      if (tenantId) {
        const set = sseClientesByTenant.get(tenantId);
        if (set) for (const res of set) {
          try { res.write(payload); } catch (_) { set.delete(res); }
        }
      }
    }
  }
}

// ─── Modo humano — persistido en BD para sobrevivir reinicios ─────────────────
const modoHumano = new Set();

// Restaurar conversaciones en modo humano al arrancar (ignorar las ya expiradas)
try {
  db.prepare(`UPDATE clientes SET modo_humano = 0 WHERE modo_humano = 1 AND modo_humano_hasta IS NOT NULL AND modo_humano_hasta <= datetime('now')`).run();
  const activos = db.prepare(`SELECT telefono FROM clientes WHERE modo_humano = 1`).all();
  activos.forEach(c => modoHumano.add(c.telefono));
  if (activos.length > 0) {
    console.log(`[Panel] ♻️ Modo humano restaurado para ${activos.length} conversación(es)`);
  }
} catch (_) {}

function esModoHumano(telefono) { return modoHumano.has(telefono); }

function setModoHumano(telefono, activo, tenantId = null) {
  if (activo) modoHumano.add(telefono);
  else        modoHumano.delete(telefono);

  try {
    db.prepare(`
      INSERT INTO clientes (telefono, modo_humano, tenant_id) VALUES (?, ?, ?)
      ON CONFLICT(telefono) DO UPDATE SET modo_humano = excluded.modo_humano
    `).run(telefono, activo ? 1 : 0, tenantId);
  } catch (err) {
    console.error('[Panel] Error persistiendo modo_humano:', err.message);
  }

  emitirEvento('modo_humano', { telefono, activo });
}

// ─── Actualizar estado de cliente ─────────────────────────────────────────────
function actualizarEstadoCliente(telefono, estado, tenantId = null) {
  if (!ESTADOS[estado]) return false;
  try {
    db.prepare(`
      INSERT INTO clientes (telefono, estado, tenant_id)
      VALUES (?, ?, ?)
      ON CONFLICT(telefono) DO UPDATE SET estado = excluded.estado
    `).run(telefono, estado, tenantId);
    emitirEvento('estado_cliente', { telefono, estado });
    return true;
  } catch (err) {
    console.error('[Panel] Error actualizando estado:', err.message);
    return false;
  }
}

function getEstadoCliente(telefono, tenantId = null) {
  try {
    const q = tenantId
      ? `SELECT estado FROM clientes WHERE telefono = ? AND tenant_id = ?`
      : `SELECT estado FROM clientes WHERE telefono = ?`;
    const params = tenantId ? [telefono, tenantId] : [telefono];
    return db.prepare(q).get(...params)?.estado || 'en_conversacion';
  } catch (_) { return 'en_conversacion'; }
}

// ─── API: Login cliente ───────────────────────────────────────────────────────
router.post('/api/login', express.json(), async (req, res) => {
  const { slug, usuario, password } = req.body;
  if (!slug || !usuario || !password)
    return res.status(400).json({ ok: false, error: 'Faltan datos' });
  const tenant = db.prepare(`SELECT * FROM tenants WHERE slug = ? AND activo = 1`).get(slug);
  if (!tenant)
    return res.status(404).json({ ok: false, error: 'Cliente no encontrado' });

  // 1. Intentar login con credenciales del dueño (panel_usuario en tenants)
  if (tenant.panel_usuario && tenant.panel_usuario === usuario && tenant.panel_password_hash) {
    const valida = await bcrypt.compare(password, tenant.panel_password_hash);
    if (valida) {
      const token = jwt.sign({ tenantId: tenant.id, slug: tenant.slug, empresa: tenant.empresa_nombre, rol: 'admin' }, JWT_SECRET, { expiresIn: '7d' });
      return res.json({ ok: true, token, slug: tenant.slug, empresa: tenant.empresa_nombre, rol: 'admin' });
    }
  }

  // 2. Intentar login con usuarios adicionales del tenant
  const usuarioExtra = db.prepare(`SELECT * FROM tenant_usuarios WHERE tenant_id = ? AND usuario = ? AND activo = 1`).get(tenant.id, usuario);
  if (usuarioExtra) {
    const valida = await bcrypt.compare(password, usuarioExtra.password_hash);
    if (valida) {
      const token = jwt.sign({ tenantId: tenant.id, slug: tenant.slug, empresa: tenant.empresa_nombre, rol: usuarioExtra.rol }, JWT_SECRET, { expiresIn: '7d' });
      return res.json({ ok: true, token, slug: tenant.slug, empresa: tenant.empresa_nombre, rol: usuarioExtra.rol });
    }
  }

  res.status(401).json({ ok: false, error: 'Credenciales incorrectas' });
});

// ─── API: Crear/actualizar credenciales de tenant (solo admin) ────────────────
router.post('/api/tenants/:id/credenciales', express.json(), async (req, res) => {
  const key = req.query.key || '';
  if (key !== process.env.PANEL_SECRET)
    return res.status(401).json({ ok: false, error: 'No autorizado' });
  const { usuario, password } = req.body;
  if (!usuario || !password)
    return res.status(400).json({ ok: false, error: 'Faltan usuario y password' });
  const hash = await bcrypt.hash(password, 10);
  db.prepare(`UPDATE tenants SET panel_usuario = ?, panel_password_hash = ? WHERE id = ?`)
    .run(usuario, hash, req.params.id);
  res.json({ ok: true, mensaje: 'Credenciales actualizadas' });
});

// ─── Servir panel admin ───────────────────────────────────────────────────────
router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/panel.html'));
});

// ─── SSE ──────────────────────────────────────────────────────────────────────
router.get('/eventos', verificarAdmin, (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();
  sseClients.add(res);
  res.write(`data: ${JSON.stringify({ tipo: 'init', humanosActivos: [...modoHumano] })}\n\n`);
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) { clearInterval(ping); }
  }, 25000);
  req.on('close', () => { sseClients.delete(res); clearInterval(ping); });
});

// ─── SSE por tenant (panel cliente) ──────────────────────────────────────────
router.get('/:slug/api/eventos', (req, res) => {
  const { slug } = req.params;
  const tenant = db.prepare(`SELECT * FROM tenants WHERE slug = ? AND activo = 1`).get(slug);
  if (!tenant) return res.status(404).end();
  if (!verificarAuthCliente(req, res, tenant)) return;

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  if (!sseClientesByTenant.has(tenant.id)) sseClientesByTenant.set(tenant.id, new Set());
  sseClientesByTenant.get(tenant.id).add(res);

  // Enviar estado inicial (humanosActivos del tenant)
  const humanosDelTenant = [...modoHumano].filter(tel => {
    const row = db.prepare(`SELECT tenant_id FROM clientes WHERE telefono = ?`).get(tel);
    return row?.tenant_id === tenant.id;
  });
  res.write(`data: ${JSON.stringify({ tipo: 'init', humanosActivos: humanosDelTenant })}\n\n`);

  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) { clearInterval(ping); }
  }, 25000);
  req.on('close', () => {
    sseClientesByTenant.get(tenant.id)?.delete(res);
    clearInterval(ping);
  });
});

// ─── API admin: mensajes ──────────────────────────────────────────────────────
router.get('/api/mensajes', verificarAdmin, (req, res) => {
  try {
    const limite   = parseInt(req.query.limite) || 150;
    const telefono = req.query.telefono || null;
    const query    = telefono
      ? `SELECT * FROM conversaciones WHERE telefono = ? ORDER BY creado_en DESC LIMIT ?`
      : `SELECT * FROM conversaciones ORDER BY creado_en DESC LIMIT ?`;
    const params = telefono ? [telefono, limite] : [limite];
    res.json({ ok: true, mensajes: db.prepare(query).all(...params).reverse() });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── API admin: followups ─────────────────────────────────────────────────────
router.get('/api/followups', verificarAdmin, (req, res) => {
  const followups = db.prepare(`
    SELECT s.*, c.nombre FROM seguimientos s
    LEFT JOIN clientes c ON c.telefono = s.telefono
    WHERE s.enviado = 0 ORDER BY s.enviar_en ASC LIMIT 50
  `).all();
  res.json({ ok: true, followups });
});

// ─── API admin: contactos ─────────────────────────────────────────────────────
router.get('/api/contactos', verificarAdmin, (req, res) => {
  try {
    const filtroEstado = req.query.estado || null;
    const contactos = db.prepare(`
      SELECT c.telefono, c.nombre,
        COALESCE(cl.estado, 'en_conversacion') as estado,
        COUNT(c.id) as total_mensajes,
        MAX(c.creado_en) as ultimo_mensaje
      FROM conversaciones c
      LEFT JOIN clientes cl ON cl.telefono = c.telefono
      GROUP BY c.telefono
      ORDER BY ultimo_mensaje DESC LIMIT 200
    `).all();
    const resultado = contactos
      .filter(c => !filtroEstado || c.estado === filtroEstado)
      .map(c => ({ ...c, modo_humano: modoHumano.has(c.telefono) }));
    res.json({ ok: true, contactos: resultado });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── API admin: stats ─────────────────────────────────────────────────────────
router.get('/api/stats', verificarAdmin, (req, res) => {
  try {
    const hoy = new Date().toISOString().split('T')[0];
    const porEstado = {};
    for (const estado of Object.keys(ESTADOS)) {
      try {
        porEstado[estado] = db.prepare(
          `SELECT COUNT(*) as n FROM clientes cl
           INNER JOIN conversaciones c ON c.telefono = cl.telefono
           WHERE cl.estado = ?`
        ).get(estado)?.n || 0;
      } catch (_) { porEstado[estado] = 0; }
    }
    res.json({
      ok: true,
      stats: {
        mensajesHoy:    db.prepare(`SELECT COUNT(*) as n FROM conversaciones WHERE DATE(creado_en) = ?`).get(hoy).n,
        contactosHoy:   db.prepare(`SELECT COUNT(DISTINCT telefono) as n FROM conversaciones WHERE DATE(creado_en) = ?`).get(hoy).n,
        totalMensajes:  db.prepare(`SELECT COUNT(*) as n FROM conversaciones`).get().n,
        totalContactos: db.prepare(`SELECT COUNT(DISTINCT telefono) as n FROM conversaciones`).get().n,
        modoHumanoCount: modoHumano.size,
        sseConectados:  sseClients.size,
        porEstado,
      },
    });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── API admin: cambiar estado ────────────────────────────────────────────────
router.post('/api/estado-cliente', verificarAdmin, express.json(), async (req, res) => {
  const { telefono, estado } = req.body;
  if (!telefono || !estado) return res.status(400).json({ ok: false, error: 'Faltan datos' });
  if (!ESTADOS[estado]) return res.status(400).json({ ok: false, error: 'Estado inválido' });
  const ok = actualizarEstadoCliente(telefono, estado);
  if (ok && (estado === 'pagado' || estado === 'despachado')) {
    const conv    = db.prepare(`SELECT tenant_id FROM conversaciones WHERE telefono = ? ORDER BY creado_en DESC LIMIT 1`).get(telefono);
    const tenant  = conv?.tenant_id ? db.prepare(`SELECT * FROM tenants WHERE id = ?`).get(conv.tenant_id) : db.prepare(`SELECT * FROM tenants WHERE activo = 1 LIMIT 1`).get();
    const DUENO_TEL = tenant?.notif_telefono || process.env.DUENO_WHATSAPP;
    console.log(`[Panel] Estado → ${estado} | tenant_id: ${conv?.tenant_id} | notif_tel: ${DUENO_TEL || 'NO CONFIGURADO'}`);
    if (DUENO_TEL) {
      const phoneId = tenant?.whatsapp_phone_id || process.env.WHATSAPP_PHONE_ID;
      const tok     = tenant?.whatsapp_token    || process.env.WHATSAPP_TOKEN;
      const cliente = db.prepare(`SELECT nombre FROM clientes WHERE telefono = ?`).get(telefono);
      const nombre  = cliente?.nombre || telefono;
      try {
        await axios.post(
          `https://graph.facebook.com/v18.0/${phoneId}/messages`,
          { messaging_product: 'whatsapp', recipient_type: 'individual', to: DUENO_TEL,
            type: 'text', text: { preview_url: false, body: `${ESTADOS[estado].emoji} *Estado actualizado*\nCliente: ${nombre} (${telefono})\nNuevo estado: *${ESTADOS[estado].label}*` } },
          { headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' } }
        );
        console.log(`[Panel] ✅ Notificación enviada a ${DUENO_TEL}`);
      } catch (err) { console.error('[Panel] ❌ Error notificando dueño:', err.message); }
    }
  }
  res.json({ ok, estados: ESTADOS });
});

// ─── API admin: toggle modo humano ────────────────────────────────────────────
router.post('/api/modo-humano', verificarAdmin, express.json(), (req, res) => {
  const { telefono, activo } = req.body;
  if (!telefono) return res.status(400).json({ ok: false, error: 'Falta telefono' });
  setModoHumano(telefono, !!activo);
  res.json({ ok: true, telefono, activo: !!activo });
});

// ─── API admin: responder manualmente ────────────────────────────────────────
router.post('/api/responder', verificarAdmin, express.json(), async (req, res) => {
  const { telefono, mensaje } = req.body;
  if (!telefono || !mensaje) return res.status(400).json({ ok: false, error: 'Faltan datos' });
  try {
    // Buscar tenant de la conversación para usar credenciales correctas
    const conv   = db.prepare(`SELECT tenant_id, nombre FROM conversaciones WHERE telefono = ? ORDER BY creado_en DESC LIMIT 1`).get(telefono);
    const tenant = conv?.tenant_id ? db.prepare(`SELECT * FROM tenants WHERE id = ?`).get(conv.tenant_id) : null;
    const phoneId = tenant?.whatsapp_phone_id || process.env.WHATSAPP_PHONE_ID;
    const tok     = tenant?.whatsapp_token    || process.env.WHATSAPP_TOKEN;
    const nombre  = conv?.nombre || 'Cliente';

    await axios.post(
      `https://graph.facebook.com/v18.0/${phoneId}/messages`,
      { messaging_product: 'whatsapp', recipient_type: 'individual', to: telefono,
        type: 'text', text: { preview_url: false, body: mensaje } },
      { headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' } }
    );
    db.prepare(`INSERT INTO conversaciones (telefono, nombre, rol, mensaje, tenant_id) VALUES (?, ?, ?, ?, ?)`)
      .run(telefono, nombre, 'assistant', `[HUMANO] ${mensaje}`, conv?.tenant_id || null);
    emitirEvento('mensaje', {
      mensaje: { telefono, nombre, rol: 'assistant', mensaje: `[HUMANO] ${mensaje}`, creado_en: new Date().toISOString() },
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.response?.data?.error?.message || err.message }); }
});

// ─── API admin: proxy media ───────────────────────────────────────────────────
router.get('/api/media/:mediaId', verificarAdmin, async (req, res) => {
  try {
    const { data } = await axios.get(`https://graph.facebook.com/v18.0/${req.params.mediaId}`,
      { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } });
    const mediaRes = await axios.get(data.url, {
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
      responseType: 'stream',
    });
    res.setHeader('Content-Type', mediaRes.headers['content-type'] || 'application/octet-stream');
    mediaRes.data.pipe(res);
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── API admin: estados disponibles ──────────────────────────────────────────
router.get('/api/estados', (req, res) => {
  res.json({ ok: true, estados: ESTADOS });
});

// ─── API admin: tenants ───────────────────────────────────────────────────────
router.get('/api/tenants', verificarAdmin, (req, res) => {
  try {
    const tenants = db.prepare(`SELECT id, slug, empresa_nombre, activo, modo_catalogo, creado_en FROM tenants`).all();
    res.json({ ok: true, tenants });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/api/tenants/:id', verificarAdmin, (req, res) => {
  try {
    const t = db.prepare(`SELECT * FROM tenants WHERE id = ?`).get(req.params.id);
    if (!t) return res.status(404).json({ ok: false, error: 'No encontrado' });
    res.json({ ok: true, tenant: t });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/api/tenants', express.json(), (req, res) => {
  if ((req.query.key || req.headers['x-admin-key']) !== process.env.PANEL_SECRET)
    return res.status(401).json({ ok: false, error: 'No autorizado' });
  try {
    const { slug, empresa_nombre, empresa_dir, empresa_web, empresa_horario, empresa_domingos,
      asistentes, pago_banco, pago_tipo, pago_cuenta, pago_titular, pago_rut, pago_email,
      envio_courier, envio_tiempo, envio_quien_paga, mayorista_minimo, garantia_meses, garantia_cond,
      bsale_token, whatsapp_phone_id, whatsapp_token, notif_telefono, modo_catalogo, panel_key,
      tipo_negocio, prompt_extra, pasarela_tipo, pasarela_api_key, pasarela_api_secret } = req.body;
    if (!slug || !empresa_nombre || !whatsapp_phone_id || !whatsapp_token)
      return res.status(400).json({ ok: false, error: 'Faltan campos obligatorios' });
    const r = db.prepare(`
      INSERT INTO tenants (slug, empresa_nombre, empresa_dir, empresa_web, empresa_horario, empresa_domingos,
        asistentes, pago_banco, pago_tipo, pago_cuenta, pago_titular, pago_rut, pago_email,
        envio_courier, envio_tiempo, envio_quien_paga, mayorista_minimo, garantia_meses, garantia_cond,
        bsale_token, whatsapp_phone_id, whatsapp_token, notif_telefono, modo_catalogo, panel_key,
        tipo_negocio, prompt_extra, pasarela_tipo, pasarela_api_key, pasarela_api_secret)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(slug, empresa_nombre, empresa_dir||'', empresa_web||'', empresa_horario||'', empresa_domingos?1:0,
      JSON.stringify(asistentes||[]), pago_banco||'', pago_tipo||'', pago_cuenta||'', pago_titular||'',
      pago_rut||'', pago_email||'', envio_courier||'', envio_tiempo||'', envio_quien_paga||'cliente',
      mayorista_minimo||3, garantia_meses||6, garantia_cond||'', bsale_token||'',
      whatsapp_phone_id, whatsapp_token, notif_telefono||'', modo_catalogo||'bsale', panel_key||'',
      tipo_negocio||'tienda', prompt_extra||'',
      pasarela_tipo||'', pasarela_api_key||'', pasarela_api_secret||'');
    res.json({ ok: true, tenantId: r.lastInsertRowid });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── API admin: info del tenant actual (para el modal de config) ─────────────
router.get('/api/tenant-info', verificarAdmin, (req, res) => {
  try {
    const key    = req.query.key || req.headers['x-admin-key'] || '';
    const tenant = db.prepare(`SELECT id, empresa_nombre, empresa_dir, empresa_horario, empresa_web, notif_telefono, envio_internacional_activo, envio_internacional_minimo_usd, envio_internacional_couriers FROM tenants WHERE activo = 1 LIMIT 1`).get();
    if (!tenant) return res.status(404).json({ ok: false });
    res.json({ ok: true, ...tenant });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── API admin: editar configuración de un tenant ────────────────────────────
router.put('/api/tenants/:id/config', express.json(), (req, res) => {
  if ((req.query.key || req.headers['x-admin-key']) !== process.env.PANEL_SECRET)
    return res.status(401).json({ ok: false, error: 'No autorizado' });
  try {
    const tenant = db.prepare(`SELECT id FROM tenants WHERE id = ?`).get(req.params.id);
    if (!tenant) return res.status(404).json({ ok: false, error: 'Tenant no encontrado' });

    const campos = ['notif_telefono','empresa_nombre','empresa_dir','empresa_horario','empresa_web','empresa_domingos','pago_banco','pago_tipo','pago_cuenta','pago_titular','pago_rut','pago_email','envio_courier','envio_tiempo','envio_quien_paga','garantia_meses','garantia_cond','garantia_email','prompt_extra','envio_internacional_activo','envio_internacional_minimo_usd','envio_internacional_couriers'];
    const updates = [];
    const vals    = [];
    for (const c of campos) {
      if (req.body[c] !== undefined) { updates.push(`${c} = ?`); vals.push(req.body[c]); }
    }
    if (!updates.length) return res.status(400).json({ ok: false, error: 'Sin campos a actualizar' });
    vals.push(req.params.id);
    db.prepare(`UPDATE tenants SET ${updates.join(', ')} WHERE id = ?`).run(...vals);
    invalidarCacheByTenantId(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/api/tenants/:id/toggle', express.json(), (req, res) => {
  if ((req.query.key || req.headers['x-admin-key']) !== process.env.PANEL_SECRET)
    return res.status(401).json({ ok: false, error: 'No autorizado' });
  try {
    const tenant = db.prepare(`SELECT id, activo FROM tenants WHERE id = ?`).get(req.params.id);
    if (!tenant) return res.status(404).json({ ok: false, error: 'Tenant no encontrado' });
    db.prepare(`UPDATE tenants SET activo = ? WHERE id = ?`).run(tenant.activo ? 0 : 1, tenant.id);
    invalidarCacheByTenantId(tenant.id);
    res.json({ ok: true, activo: !tenant.activo });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Login cliente ────────────────────────────────────────────────────────────
router.get('/:slug/login', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/login.html'));
});

// ─── Onboarding ───────────────────────────────────────────────────────────────
router.get('/onboarding', (req, res) => {
  const key = req.query.key || '';
  if (key !== process.env.PANEL_SECRET)
    return res.status(401).send('⛔ No autorizado');
  res.sendFile(path.join(__dirname, '../public/onboarding.html'));
});

// ─── API cliente: stats ───────────────────────────────────────────────────────
router.get('/:slug/api/stats', (req, res) => {
  const { slug } = req.params;
  const tenant = db.prepare(`SELECT * FROM tenants WHERE slug = ? AND activo = 1`).get(slug);
  if (!tenant) return res.status(404).json({ ok: false });
  if (!verificarAuthCliente(req, res, tenant)) return;

  const hoy     = new Date().toISOString().split('T')[0];
  const ts7d    = new Date(Date.now() - 7  * 86400000).toISOString();
  const ts30d   = new Date(Date.now() - 30 * 86400000).toISOString();
  const tid     = tenant.id;

  const porEstado = {};
  for (const estado of Object.keys(ESTADOS)) {
    try {
      porEstado[estado] = db.prepare(
        `SELECT COUNT(*) as n FROM clientes cl
         INNER JOIN conversaciones c ON c.telefono = cl.telefono
         WHERE cl.estado = ? AND cl.tenant_id = ?`
      ).get(estado, tid)?.n || 0;
    } catch (_) { porEstado[estado] = 0; }
  }

  // Actividad por día — últimos 7 días
  const mensajesPorDia = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const fecha = d.toISOString().split('T')[0];
    const dia   = d.toLocaleDateString('es-CL', { weekday: 'short' });
    const count = db.prepare(`SELECT COUNT(*) as n FROM conversaciones WHERE DATE(creado_en) = ? AND tenant_id = ?`).get(fecha, tid).n;
    mensajesPorDia.push({ fecha, dia, count });
  }

  // Eficiencia del bot (mensajes respondidos sin intervención humana)
  const totalBot    = db.prepare(`SELECT COUNT(*) as n FROM conversaciones WHERE rol='assistant' AND mensaje NOT LIKE '[HUMANO]%' AND tenant_id=?`).get(tid).n;
  const totalHumano = db.prepare(`SELECT COUNT(*) as n FROM conversaciones WHERE rol='assistant' AND mensaje LIKE '[HUMANO]%' AND tenant_id=?`).get(tid).n;
  const totalResp   = totalBot + totalHumano;
  const pctBot      = totalResp > 0 ? Math.round(totalBot / totalResp * 100) : 0;

  // Revenue via pasarela de pago
  let revenueFlow = 0, revenueFlowMes = 0;
  try {
    revenueFlow    = db.prepare(`SELECT COALESCE(SUM(monto),0) as n FROM pagos_pendientes WHERE tenant_id=? AND estado='pagado'`).get(tid)?.n || 0;
    revenueFlowMes = db.prepare(`SELECT COALESCE(SUM(monto),0) as n FROM pagos_pendientes WHERE tenant_id=? AND estado='pagado' AND creado_en>=?`).get(tid, ts30d)?.n || 0;
  } catch(_) {}

  // Top productos consultados
  let topProductos = [];
  try {
    topProductos = db.prepare(`SELECT carrito_producto as nombre, COUNT(*) as n FROM clientes WHERE tenant_id=? AND carrito_producto IS NOT NULL AND carrito_producto != '' GROUP BY carrito_producto ORDER BY n DESC LIMIT 5`).all(tid);
  } catch(_) {}

  // Actividad por hora — últimos 7 días
  let actividadPorHora = [];
  try {
    actividadPorHora = db.prepare(`SELECT CAST(strftime('%H', creado_en) AS INT) as hora, COUNT(*) as n FROM conversaciones WHERE tenant_id=? AND creado_en>=? AND rol='user' GROUP BY hora ORDER BY hora`).all(tid, ts7d);
  } catch(_) {}

  const stats = {
    mensajesHoy:    db.prepare(`SELECT COUNT(*) as n FROM conversaciones WHERE DATE(creado_en) = ? AND tenant_id = ?`).get(hoy, tid).n,
    contactosHoy:   db.prepare(`SELECT COUNT(DISTINCT telefono) as n FROM conversaciones WHERE DATE(creado_en) = ? AND tenant_id = ?`).get(hoy, tid).n,
    mensajesSemana: db.prepare(`SELECT COUNT(*) as n FROM conversaciones WHERE creado_en >= ? AND tenant_id = ?`).get(ts7d, tid).n,
    contactosSemana:db.prepare(`SELECT COUNT(DISTINCT telefono) as n FROM conversaciones WHERE creado_en >= ? AND tenant_id = ?`).get(ts7d, tid).n,
    mensajesMes:    db.prepare(`SELECT COUNT(*) as n FROM conversaciones WHERE creado_en >= ? AND tenant_id = ?`).get(ts30d, tid).n,
    contactosMes:   db.prepare(`SELECT COUNT(DISTINCT telefono) as n FROM conversaciones WHERE creado_en >= ? AND tenant_id = ?`).get(ts30d, tid).n,
    totalMensajes:  db.prepare(`SELECT COUNT(*) as n FROM conversaciones WHERE tenant_id = ?`).get(tid).n,
    totalContactos: db.prepare(`SELECT COUNT(DISTINCT telefono) as n FROM conversaciones WHERE tenant_id = ?`).get(tid).n,
    empresa:        tenant.empresa_nombre,
    porEstado,
    mensajesPorDia,
    eficienciaBot: { pctBot, totalBot, totalHumano },
    revenueFlow, revenueFlowMes, topProductos, actividadPorHora,
  };
  res.json({ ok: true, stats });
});

// ─── API cliente: contactos ───────────────────────────────────────────────────
router.get('/:slug/api/contactos', (req, res) => {
  const { slug } = req.params;
  const tenant = db.prepare(`SELECT * FROM tenants WHERE slug = ? AND activo = 1`).get(slug);
  if (!tenant) return res.status(404).json({ ok: false });
  if (!verificarAuthCliente(req, res, tenant)) return;
  // Helper para enriquecer contactos con tags
  function enriquecerConTags(rows) {
    const tagsRows = db.prepare(`SELECT telefono, id, tag, color FROM cliente_tags WHERE tenant_id=?`).all(tenant.id);
    const tagsMap = {};
    for (const t of tagsRows) {
      if (!tagsMap[t.telefono]) tagsMap[t.telefono] = [];
      tagsMap[t.telefono].push({ id: t.id, tag: t.tag, color: t.color });
    }
    return rows.map(c => ({ ...c, tags: tagsMap[c.telefono] || [] }));
  }

  const filtroEstado = req.query.estado || null;
  if (filtroEstado) {
    const contactos = db.prepare(`
      SELECT cl.telefono, cl.nombre,
        COALESCE(cl.estado, 'en_conversacion') as estado,
        COUNT(c.id) as total_mensajes,
        MAX(c.creado_en) as ultimo_mensaje
      FROM clientes cl
      LEFT JOIN conversaciones c ON c.telefono = cl.telefono AND c.tenant_id = ?
      WHERE cl.tenant_id = ? AND COALESCE(cl.estado, 'en_conversacion') = ?
      GROUP BY cl.telefono
      ORDER BY ultimo_mensaje DESC LIMIT 200
    `).all(tenant.id, tenant.id, filtroEstado);
    return res.json({ ok: true, contactos: enriquecerConTags(contactos) });
  }
  const mostrarArchivados = req.query.archivados === '1';
  const contactos = db.prepare(`
    SELECT c.telefono, c.nombre,
      COALESCE(cl.estado, 'en_conversacion') as estado,
      COALESCE(cl.archivado, 0) as archivado,
      COUNT(c.id) as total_mensajes,
      MAX(c.creado_en) as ultimo_mensaje
    FROM conversaciones c
    LEFT JOIN clientes cl ON cl.telefono = c.telefono AND cl.tenant_id = ?
    WHERE c.tenant_id = ? AND COALESCE(cl.archivado, 0) = ?
    GROUP BY c.telefono
    ORDER BY ultimo_mensaje DESC LIMIT 200
  `).all(tenant.id, tenant.id, mostrarArchivados ? 1 : 0);
  res.json({ ok: true, contactos: enriquecerConTags(contactos) });
});

// ─── API cliente: mensajes ────────────────────────────────────────────────────
router.get('/:slug/api/mensajes', (req, res) => {
  const { slug } = req.params;
  const tenant = db.prepare(`SELECT * FROM tenants WHERE slug = ? AND activo = 1`).get(slug);
  if (!tenant) return res.status(404).json({ ok: false });
  if (!verificarAuthCliente(req, res, tenant)) return;
  const { telefono } = req.query;
  if (!telefono) return res.status(400).json({ ok: false, error: 'Falta telefono' });
  const mensajes = db.prepare(`
    SELECT * FROM conversaciones WHERE telefono = ? AND tenant_id = ?
    ORDER BY creado_en ASC LIMIT 100
  `).all(telefono, tenant.id);
  res.json({ ok: true, mensajes });
});

// ─── API cliente: modo humano ─────────────────────────────────────────────────
router.post('/:slug/api/modo-humano', express.json(), (req, res) => {
  const { slug } = req.params;
  const tenant = db.prepare(`SELECT * FROM tenants WHERE slug = ? AND activo = 1`).get(slug);
  if (!tenant) return res.status(404).json({ ok: false });
  if (!verificarAuthCliente(req, res, tenant)) return;
  const { telefono, activo } = req.body;
  if (!telefono) return res.status(400).json({ ok: false });
  setModoHumano(telefono, !!activo, tenant.id);
  res.json({ ok: true, activo: !!activo });
});

// ─── API cliente: responder ───────────────────────────────────────────────────
router.post('/:slug/api/responder', express.json(), async (req, res) => {
  const { slug } = req.params;
  const tenant = db.prepare(`SELECT * FROM tenants WHERE slug = ? AND activo = 1`).get(slug);
  if (!tenant) return res.status(404).json({ ok: false });
  if (!verificarAuthCliente(req, res, tenant)) return;
  const { telefono, mensaje } = req.body;
  if (!telefono || !mensaje) return res.status(400).json({ ok: false });
  if (!tenant.whatsapp_phone_id || !tenant.whatsapp_token) {
    console.error(`[Panel/${slug}] Faltan credenciales de WhatsApp — phone_id:${tenant.whatsapp_phone_id ? 'OK' : 'FALTA'} token:${tenant.whatsapp_token ? 'OK' : 'FALTA'}`);
    return res.status(500).json({ ok: false, error: 'Tenant sin credenciales de WhatsApp configuradas (phone_id o token faltante)' });
  }
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${tenant.whatsapp_phone_id}/messages`,
      { messaging_product: 'whatsapp', recipient_type: 'individual', to: telefono,
        type: 'text', text: { preview_url: false, body: mensaje } },
      { headers: { Authorization: `Bearer ${tenant.whatsapp_token}`, 'Content-Type': 'application/json' } }
    );
    const nombre = db.prepare(`SELECT nombre FROM conversaciones WHERE telefono = ? AND tenant_id = ? LIMIT 1`).get(telefono, tenant.id)?.nombre || 'Cliente';
    db.prepare(`INSERT INTO conversaciones (telefono, nombre, rol, mensaje, tenant_id) VALUES (?, ?, ?, ?, ?)`)
      .run(telefono, nombre, 'assistant', `[HUMANO] ${mensaje}`, tenant.id);
    res.json({ ok: true });
  } catch (err) {
    const fbError = err.response?.data?.error;
    console.error(`[Panel/${slug}] Error enviando WhatsApp:`, JSON.stringify(fbError || err.message));
    const detalle = fbError
      ? `${fbError.message || 'Sin mensaje'} (type=${fbError.type || '?'} code=${fbError.code || '?'} subcode=${fbError.error_subcode || '?'})`
      : err.message;
    res.status(500).json({ ok: false, error: detalle });
  }
});

// ─── Helper: enviar notificación WhatsApp al dueño ───────────────────────────
async function enviarNotifDueno(tenant, slug, body) {
  const DUENO_TEL = tenant.notif_telefono || process.env.DUENO_WHATSAPP;
  const phoneId   = tenant.whatsapp_phone_id || process.env.WHATSAPP_PHONE_ID;
  const tok       = tenant.whatsapp_token    || process.env.WHATSAPP_TOKEN;
  console.log(`[Notif/${slug}] tel:${DUENO_TEL || 'SIN_TEL'} phoneId:${phoneId || 'SIN_ID'} token:${tok ? 'OK' : 'SIN_TOKEN'}`);
  if (!DUENO_TEL) return { ok: false, razon: 'Sin notif_telefono configurado' };
  if (!phoneId)   return { ok: false, razon: 'Sin whatsapp_phone_id' };
  if (!tok)       return { ok: false, razon: 'Sin whatsapp_token' };
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${phoneId}/messages`,
      { messaging_product: 'whatsapp', recipient_type: 'individual', to: DUENO_TEL, type: 'text', text: { preview_url: false, body } },
      { headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' } }
    );
    console.log(`[Notif/${slug}] ✅ Enviada a ${DUENO_TEL}`);
    return { ok: true };
  } catch (err) {
    const detalle = JSON.stringify(err.response?.data || err.message);
    console.error(`[Notif/${slug}] ❌ Error:`, detalle);
    return { ok: false, razon: detalle };
  }
}

// ─── API cliente: test de notificación ───────────────────────────────────────
router.get('/:slug/api/test-bsale', async (req, res) => {
  const { slug } = req.params;
  const { q, variantid } = req.query;
  const tenant = db.prepare(`SELECT id, slug, bsale_token FROM tenants WHERE slug = ? AND activo = 1`).get(slug);
  if (!tenant) return res.status(404).json({ ok: false, error: `Tenant '${slug}' no encontrado` });
  const token = tenant.bsale_token || process.env.BSALE_TOKEN;
  try {
    // Modo: ver stock crudo de una variante específica
    if (variantid) {
      const { data } = await axios.get(`https://api.bsale.io/v1/stocks.json`, {
        headers: { 'access_token': token },
        params: { variantid },
      });
      return res.json({ ok: true, variantid, stock_raw: data.items });
    }
    if (!q) return res.status(400).json({ ok: false, error: 'Falta ?q=termino o ?variantid=ID' });
    const bsaleService = require('../services/bsaleService');
    const resultados = await bsaleService.buscarConPreciosYStock(q, false, token);
    res.json({ ok: true, query: q, token_origen: tenant.bsale_token ? 'tenant-db' : 'env-variable', total: resultados?.length || 0, resultados });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

router.post('/:slug/api/test-notificacion', express.json(), async (req, res) => {
  const { slug } = req.params;
  const tenant = db.prepare(`SELECT * FROM tenants WHERE slug = ? AND activo = 1`).get(slug);
  if (!tenant) return res.status(404).json({ ok: false });
  if (!verificarAuthCliente(req, res, tenant)) return;
  const resultado = await enviarNotifDueno(tenant, slug, `🧪 *Test de notificación*\nSi ves este mensaje, las notificaciones están funcionando correctamente ✅`);
  res.json(resultado);
});

// ─── API cliente: cambiar estado ──────────────────────────────────────────────
router.post('/:slug/api/estado-cliente', express.json(), async (req, res) => {
  const { slug } = req.params;
  const tenant = db.prepare(`SELECT * FROM tenants WHERE slug = ? AND activo = 1`).get(slug);
  if (!tenant) return res.status(404).json({ ok: false });
  if (!verificarAuthCliente(req, res, tenant)) return;
  const { telefono, estado } = req.body;
  if (!telefono || !estado) return res.status(400).json({ ok: false, error: 'Faltan datos' });
  if (!ESTADOS[estado]) return res.status(400).json({ ok: false, error: 'Estado inválido' });
  const ok = actualizarEstadoCliente(telefono, estado);
  let notifResultado = null;
  if (ok && (estado === 'pagado' || estado === 'despachado')) {
    const cliente = db.prepare(`SELECT nombre FROM clientes WHERE telefono = ?`).get(telefono);
    const nombre  = cliente?.nombre || telefono;
    notifResultado = await enviarNotifDueno(tenant, slug,
      `${ESTADOS[estado].emoji} *Estado actualizado*\nCliente: ${nombre} (${telefono})\nNuevo estado: *${ESTADOS[estado].label}*`
    );
  }
  res.json({ ok, estados: ESTADOS, notif: notifResultado });
});

// ─── API cliente: info del tenant (config modal) ─────────────────────────────
router.get('/:slug/api/tenant-info', (req, res) => {
  const { slug } = req.params;
  const tenant = db.prepare(`SELECT id, empresa_nombre, empresa_dir, empresa_horario, empresa_web, notif_telefono, envio_internacional_activo, envio_internacional_minimo_usd, envio_internacional_couriers, panel_logo_url, panel_color, panel_titulo, google_client_id, google_client_secret, CASE WHEN google_refresh_token IS NOT NULL AND google_refresh_token != '' THEN 1 ELSE 0 END as google_conectado, google_calendar_id, modo_catalogo, garantia_email FROM tenants WHERE slug = ? AND activo = 1`).get(slug);
  if (!tenant) return res.status(404).json({ ok: false });
  res.json({ ok: true, ...tenant });
});

// ─── API cliente: actualizar config propia ────────────────────────────────────
router.put('/:slug/api/tenant-config', express.json(), (req, res) => {
  const { slug } = req.params;
  const tenant = db.prepare(`SELECT * FROM tenants WHERE slug = ? AND activo = 1`).get(slug);
  if (!tenant) return res.status(404).json({ ok: false });
  if (!verificarAuthCliente(req, res, tenant)) return;
  const campos = ['notif_telefono','empresa_nombre','empresa_dir','empresa_horario','empresa_web','envio_internacional_activo','envio_internacional_minimo_usd','envio_internacional_couriers','pasarela_tipo','pasarela_api_key','pasarela_api_secret','modo_catalogo','modo_catalogo_pdf','panel_logo_url','panel_color','panel_titulo','google_client_id','google_client_secret','google_calendar_id'];
  const updates = [], vals = [];
  for (const c of campos) {
    if (req.body[c] !== undefined) { updates.push(`${c} = ?`); vals.push(req.body[c]); }
  }
  if (!updates.length) return res.status(400).json({ ok: false, error: 'Sin campos' });
  vals.push(tenant.id);
  db.prepare(`UPDATE tenants SET ${updates.join(', ')} WHERE id = ?`).run(...vals);
  invalidarCacheByTenantId(tenant.id);
  res.json({ ok: true });
});

// ─── API cliente: templates de follow-up ─────────────────────────────────────
const TIPOS_FOLLOWUP = ['follow_up_precio', 'pago_recordatorio', 'post_venta', 'carrito_abandonado'];

router.get('/:slug/api/followup-templates', (req, res) => {
  const { slug } = req.params;
  const tenant = db.prepare(`SELECT * FROM tenants WHERE slug = ? AND activo = 1`).get(slug);
  if (!tenant) return res.status(404).json({ ok: false });
  if (!verificarAuthCliente(req, res, tenant)) return;

  const templates = {};
  for (const tipo of TIPOS_FOLLOWUP) {
    const row = db.prepare(`SELECT mensaje FROM tenant_followups WHERE tenant_id = ? AND tipo = ?`).get(tenant.id, tipo);
    const defOpts = MENSAJES_DEFAULT[tipo] || [];
    templates[tipo] = {
      custom:       row?.mensaje || null,
      predeterminado: defOpts[0]?.replace(/\{\{nombre\}\}/g, 'Cliente') || '',
    };
  }
  res.json({ ok: true, templates });
});

router.put('/:slug/api/followup-templates/:tipo', express.json(), (req, res) => {
  const { slug, tipo } = req.params;
  if (!TIPOS_FOLLOWUP.includes(tipo)) return res.status(400).json({ ok: false, error: 'Tipo inválido' });
  const tenant = db.prepare(`SELECT * FROM tenants WHERE slug = ? AND activo = 1`).get(slug);
  if (!tenant) return res.status(404).json({ ok: false });
  if (!verificarAuthCliente(req, res, tenant)) return;

  const { mensaje } = req.body;
  if (!mensaje || !mensaje.trim()) {
    db.prepare(`DELETE FROM tenant_followups WHERE tenant_id = ? AND tipo = ?`).run(tenant.id, tipo);
    return res.json({ ok: true, revertido: true });
  }
  db.prepare(`
    INSERT INTO tenant_followups (tenant_id, tipo, mensaje) VALUES (?, ?, ?)
    ON CONFLICT(tenant_id, tipo) DO UPDATE SET mensaje = excluded.mensaje
  `).run(tenant.id, tipo, mensaje.trim());
  res.json({ ok: true });
});

// ─── API cliente: embalajes ───────────────────────────────────────────────────
router.get('/:slug/api/embalajes', (req, res) => {
  const { slug } = req.params;
  const tenant = db.prepare(`SELECT * FROM tenants WHERE slug = ? AND activo = 1`).get(slug);
  if (!tenant) return res.status(404).json({ ok: false });
  if (!verificarAuthCliente(req, res, tenant)) return;
  const embalajes = db.prepare(`SELECT * FROM tenant_embalajes WHERE tenant_id = ?`).all(tenant.id);
  res.json({ ok: true, embalajes });
});

router.post('/:slug/api/embalajes', express.json(), (req, res) => {
  const { slug } = req.params;
  const tenant = db.prepare(`SELECT * FROM tenants WHERE slug = ? AND activo = 1`).get(slug);
  if (!tenant) return res.status(404).json({ ok: false });
  if (!verificarAuthCliente(req, res, tenant)) return;
  const { nombre, unidades, precio_unitario, total_caja } = req.body;
  if (!nombre) return res.status(400).json({ ok: false, error: 'Falta nombre' });
  const r = db.prepare(`INSERT INTO tenant_embalajes (tenant_id, nombre, unidades, precio_unitario, total_caja) VALUES (?,?,?,?,?)`)
    .run(tenant.id, nombre, unidades||0, precio_unitario||0, total_caja||0);
  invalidarCacheByTenantId(tenant.id);
  res.json({ ok: true, id: r.lastInsertRowid });
});

router.put('/:slug/api/embalajes/:id', express.json(), (req, res) => {
  const { slug } = req.params;
  const tenant = db.prepare(`SELECT * FROM tenants WHERE slug = ? AND activo = 1`).get(slug);
  if (!tenant) return res.status(404).json({ ok: false });
  if (!verificarAuthCliente(req, res, tenant)) return;
  const { nombre, unidades, precio_unitario, total_caja } = req.body;
  db.prepare(`UPDATE tenant_embalajes SET nombre=?, unidades=?, precio_unitario=?, total_caja=? WHERE id=? AND tenant_id=?`)
    .run(nombre, unidades||0, precio_unitario||0, total_caja||0, req.params.id, tenant.id);
  invalidarCacheByTenantId(tenant.id);
  res.json({ ok: true });
});

router.delete('/:slug/api/embalajes/:id', (req, res) => {
  const { slug } = req.params;
  const tenant = db.prepare(`SELECT * FROM tenants WHERE slug = ? AND activo = 1`).get(slug);
  if (!tenant) return res.status(404).json({ ok: false });
  if (!verificarAuthCliente(req, res, tenant)) return;
  db.prepare(`DELETE FROM tenant_embalajes WHERE id=? AND tenant_id=?`).run(req.params.id, tenant.id);
  invalidarCacheByTenantId(tenant.id);
  res.json({ ok: true });
});

// ─── API cliente: productos catálogo manual ───────────────────────────────────
router.get('/:slug/api/productos', (req, res) => {
  const { slug } = req.params;
  const tenant = db.prepare(`SELECT * FROM tenants WHERE slug = ? AND activo = 1`).get(slug);
  if (!tenant) return res.status(404).json({ ok: false });
  if (!verificarAuthCliente(req, res, tenant)) return;
  const productos = db.prepare(`SELECT * FROM tenant_productos WHERE tenant_id = ? ORDER BY nombre`).all(tenant.id);
  res.json({ ok: true, productos });
});

router.post('/:slug/api/productos', express.json(), (req, res) => {
  const { slug } = req.params;
  const tenant = db.prepare(`SELECT * FROM tenants WHERE slug = ? AND activo = 1`).get(slug);
  if (!tenant) return res.status(404).json({ ok: false });
  if (!verificarAuthCliente(req, res, tenant)) return;
  const { nombre, descripcion, precio_unitario, precio_mayorista, stock } = req.body;
  if (!nombre) return res.status(400).json({ ok: false, error: 'Falta nombre' });
  const r = db.prepare(`INSERT INTO tenant_productos (tenant_id, nombre, descripcion, precio_unitario, precio_mayorista, stock) VALUES (?,?,?,?,?,?)`)
    .run(tenant.id, nombre, descripcion||'', precio_unitario||0, precio_mayorista||0, stock||0);
  invalidarCacheByTenantId(tenant.id);
  res.json({ ok: true, id: r.lastInsertRowid });
});

router.put('/:slug/api/productos/:id', express.json(), (req, res) => {
  const { slug } = req.params;
  const tenant = db.prepare(`SELECT * FROM tenants WHERE slug = ? AND activo = 1`).get(slug);
  if (!tenant) return res.status(404).json({ ok: false });
  if (!verificarAuthCliente(req, res, tenant)) return;
  const { nombre, descripcion, precio_unitario, precio_mayorista, stock, activo } = req.body;
  db.prepare(`UPDATE tenant_productos SET nombre=?, descripcion=?, precio_unitario=?, precio_mayorista=?, stock=?, activo=? WHERE id=? AND tenant_id=?`)
    .run(nombre, descripcion||'', precio_unitario||0, precio_mayorista||0, stock||0, activo?1:0, req.params.id, tenant.id);
  invalidarCacheByTenantId(tenant.id);
  res.json({ ok: true });
});

router.delete('/:slug/api/productos/:id', (req, res) => {
  const { slug } = req.params;
  const tenant = db.prepare(`SELECT * FROM tenants WHERE slug = ? AND activo = 1`).get(slug);
  if (!tenant) return res.status(404).json({ ok: false });
  if (!verificarAuthCliente(req, res, tenant)) return;
  db.prepare(`DELETE FROM tenant_productos WHERE id=? AND tenant_id=?`).run(req.params.id, tenant.id);
  invalidarCacheByTenantId(tenant.id);
  res.json({ ok: true });
});
// ─── API cliente: exportar CSV ────────────────────────────────────────────────
router.get('/:slug/api/exportar-csv', (req, res) => {
  const { slug } = req.params;
  const tenant = db.prepare(`SELECT * FROM tenants WHERE slug = ? AND activo = 1`).get(slug);
  if (!tenant) return res.status(404).json({ ok: false });
  if (!verificarAuthCliente(req, res, tenant)) return;

  const rows = db.prepare(`
    SELECT c.telefono, c.nombre, c.estado, c.carrito_producto,
           c.primer_pedido, c.ultimo_contacto,
           (SELECT mensaje FROM conversaciones WHERE telefono = c.telefono AND tenant_id = ? ORDER BY creado_en DESC LIMIT 1) as ultimo_mensaje
    FROM clientes c
    WHERE c.tenant_id = ?
    ORDER BY COALESCE(c.ultimo_contacto, c.primer_pedido) DESC
  `).all(tenant.id, tenant.id);

  const escape = v => `"${String(v || '').replace(/"/g, '""')}"`;
  const header = 'Teléfono,Nombre,Estado,Último producto,Fecha primer contacto,Último contacto,Último mensaje\n';
  const body   = rows.map(r => [r.telefono, r.nombre, r.estado, r.carrito_producto, r.primer_pedido, r.ultimo_contacto, r.ultimo_mensaje].map(escape).join(',')).join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${slug}-clientes.csv"`);
  res.send('﻿' + header + body);
});

// ─── API cliente: gestión de usuarios adicionales ────────────────────────────
router.get('/:slug/api/usuarios', (req, res) => {
  const { slug } = req.params;
  const tenant = db.prepare(`SELECT * FROM tenants WHERE slug = ? AND activo = 1`).get(slug);
  if (!tenant) return res.status(404).json({ ok: false });
  if (!verificarAuthCliente(req, res, tenant)) return;
  const usuarios = db.prepare(`SELECT id, usuario, rol, activo, creado_en FROM tenant_usuarios WHERE tenant_id = ? ORDER BY creado_en ASC`).all(tenant.id);
  res.json({ ok: true, usuarios });
});

router.post('/:slug/api/usuarios', express.json(), async (req, res) => {
  const { slug } = req.params;
  const tenant = db.prepare(`SELECT * FROM tenants WHERE slug = ? AND activo = 1`).get(slug);
  if (!tenant) return res.status(404).json({ ok: false });
  if (!verificarAuthCliente(req, res, tenant)) return;
  const { usuario, password, rol = 'vendedor' } = req.body;
  if (!usuario || !password) return res.status(400).json({ ok: false, error: 'Faltan usuario y contraseña' });
  if (!['vendedor', 'admin'].includes(rol)) return res.status(400).json({ ok: false, error: 'Rol inválido' });
  try {
    const hash = await bcrypt.hash(password, 10);
    db.prepare(`INSERT INTO tenant_usuarios (tenant_id, usuario, password_hash, rol) VALUES (?, ?, ?, ?)`).run(tenant.id, usuario.trim(), hash, rol);
    res.json({ ok: true });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ ok: false, error: 'Ya existe ese usuario' });
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.delete('/:slug/api/usuarios/:id', (req, res) => {
  const { slug } = req.params;
  const tenant = db.prepare(`SELECT * FROM tenants WHERE slug = ? AND activo = 1`).get(slug);
  if (!tenant) return res.status(404).json({ ok: false });
  if (!verificarAuthCliente(req, res, tenant)) return;
  db.prepare(`DELETE FROM tenant_usuarios WHERE id = ? AND tenant_id = ?`).run(req.params.id, tenant.id);
  res.json({ ok: true });
});

// ─── API cliente: follow-up manual ───────────────────────────────────────────
router.post('/:slug/api/followup-manual', express.json(), async (req, res) => {
  const { slug } = req.params;
  const tenant = db.prepare(`SELECT * FROM tenants WHERE slug = ? AND activo = 1`).get(slug);
  if (!tenant) return res.status(404).json({ ok: false });
  if (!verificarAuthCliente(req, res, tenant)) return;
  const { telefono, tipo = 'follow_up_precio' } = req.body;
  if (!telefono) return res.status(400).json({ ok: false, error: 'Falta telefono' });

  try {
    const { programarSeguimiento } = require('../services/followUpService');
    programarSeguimiento(telefono, tipo, 0, tenant.id); // delay 0 = enviar en próximo ciclo
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── API cliente: subir catálogo PDF ─────────────────────────────────────────
router.post('/:slug/api/subir-pdf', upload.single('pdf'), async (req, res) => {
  const { slug } = req.params;
  const tenant = db.prepare(`SELECT * FROM tenants WHERE slug = ? AND activo = 1`).get(slug);
  if (!tenant) return res.status(404).json({ ok: false });
  if (!verificarAuthCliente(req, res, tenant)) return;
  if (!req.file) return res.status(400).json({ ok: false, error: 'No se recibió ningún archivo' });
  if (!req.file.originalname.toLowerCase().endsWith('.pdf'))
    return res.status(400).json({ ok: false, error: 'Solo se aceptan archivos PDF' });
  try {
    const resultado = await pdfService.procesarPDF(req.file.buffer, tenant.id);
    db.prepare(`UPDATE tenants SET modo_catalogo_pdf = 1 WHERE id = ?`).run(tenant.id);
    invalidarCacheByTenantId(tenant.id);
    res.json({ ok: true, ...resultado });
  } catch (err) {
    console.error('[Panel] Error procesando PDF:', err.message);
    res.status(500).json({ ok: false, error: 'Error procesando el PDF: ' + err.message });
  }
});

// ─── API cliente: info del PDF actual ────────────────────────────────────────
router.get('/:slug/api/pdf-info', (req, res) => {
  const { slug } = req.params;
  const tenant = db.prepare(`SELECT * FROM tenants WHERE slug = ? AND activo = 1`).get(slug);
  if (!tenant) return res.status(404).json({ ok: false });
  if (!verificarAuthCliente(req, res, tenant)) return;
  const info = pdfService.infoPDF(tenant.id);
  res.json({ ok: true, tienePDF: !!info, ...info });
});

// ─── API cliente: eliminar PDF ────────────────────────────────────────────────
router.delete('/:slug/api/pdf', (req, res) => {
  const { slug } = req.params;
  const tenant = db.prepare(`SELECT * FROM tenants WHERE slug = ? AND activo = 1`).get(slug);
  if (!tenant) return res.status(404).json({ ok: false });
  if (!verificarAuthCliente(req, res, tenant)) return;
  db.prepare(`DELETE FROM catalogo_pdf_chunks WHERE tenant_id = ?`).run(tenant.id);
  db.prepare(`UPDATE tenants SET modo_catalogo_pdf = 0 WHERE id = ?`).run(tenant.id);
  invalidarCacheByTenantId(tenant.id);
  res.json({ ok: true });
});

// ─── API cliente: archivar / restaurar conversación ──────────────────────────
router.post('/:slug/api/archivar-conversacion', express.json(), (req, res) => {
  const { slug } = req.params;
  const tenant = db.prepare(`SELECT * FROM tenants WHERE slug = ? AND activo = 1`).get(slug);
  if (!tenant) return res.status(404).json({ ok: false });
  if (!verificarAuthCliente(req, res, tenant)) return;
  const { telefono, archivado = true } = req.body;
  if (!telefono) return res.status(400).json({ ok: false, error: 'Falta telefono' });
  db.prepare(`UPDATE clientes SET archivado = ? WHERE telefono = ? AND tenant_id = ?`)
    .run(archivado ? 1 : 0, telefono, tenant.id);
  emitirEvento('conversacion_archivada', { telefono, archivado: !!archivado });
  res.json({ ok: true });
});

// ─── API cliente: citas ───────────────────────────────────────────────────────
router.get('/:slug/api/citas', (req, res) => {
  const { slug } = req.params;
  const tenant = db.prepare(`SELECT * FROM tenants WHERE slug = ? AND activo = 1`).get(slug);
  if (!tenant) return res.status(404).json({ ok: false });
  if (!verificarAuthCliente(req, res, tenant)) return;
  const { desde, hasta } = req.query;
  let q = `SELECT * FROM citas WHERE tenant_id=?`;
  const p = [tenant.id];
  if (desde) { q += ` AND fecha >= ?`; p.push(desde); }
  if (hasta) { q += ` AND fecha <= ?`; p.push(hasta); }
  q += ` ORDER BY fecha ASC, hora ASC LIMIT 100`;
  res.json({ ok: true, citas: db.prepare(q).all(...p) });
});

router.post('/:slug/api/citas', express.json(), async (req, res) => {
  const { slug } = req.params;
  const tenant = db.prepare(`SELECT * FROM tenants WHERE slug = ? AND activo = 1`).get(slug);
  if (!tenant) return res.status(404).json({ ok: false });
  if (!verificarAuthCliente(req, res, tenant)) return;
  const { telefono, nombre, servicio, fecha, hora, notas } = req.body;
  if (!fecha) return res.status(400).json({ ok: false, error: 'Falta fecha' });
  const r = db.prepare(`INSERT INTO citas (tenant_id,telefono,nombre,servicio,fecha,hora,notas) VALUES (?,?,?,?,?,?,?)`)
    .run(tenant.id, telefono||'', nombre||'', servicio||'Consulta', fecha, hora||'10:00', notas||'');
  let googleEventId = null;
  if (calendarService.tieneCalendario(tenant)) {
    try {
      const ev = await calendarService.crearEvento(tenant, { resumen: (servicio||'Cita') + ' — ' + (nombre||telefono), descripcion: telefono, fecha, hora: hora||'10:00' });
      googleEventId = ev.id || null;
      if (googleEventId) db.prepare(`UPDATE citas SET google_event_id=? WHERE id=?`).run(googleEventId, r.lastInsertRowid);
    } catch(_) {}
  }
  res.json({ ok: true, id: r.lastInsertRowid, googleEventId });
});

router.put('/:slug/api/citas/:id', express.json(), (req, res) => {
  const { slug, id } = req.params;
  const tenant = db.prepare(`SELECT * FROM tenants WHERE slug = ? AND activo = 1`).get(slug);
  if (!tenant) return res.status(404).json({ ok: false });
  if (!verificarAuthCliente(req, res, tenant)) return;
  const { estado, notas, hora, servicio } = req.body;
  const campos = [], vals = [];
  if (estado   !== undefined) { campos.push('estado=?');   vals.push(estado); }
  if (notas    !== undefined) { campos.push('notas=?');    vals.push(notas); }
  if (hora     !== undefined) { campos.push('hora=?');     vals.push(hora); }
  if (servicio !== undefined) { campos.push('servicio=?'); vals.push(servicio); }
  if (!campos.length) return res.status(400).json({ ok: false });
  vals.push(id, tenant.id);
  db.prepare(`UPDATE citas SET ${campos.join(',')} WHERE id=? AND tenant_id=?`).run(...vals);
  res.json({ ok: true });
});

router.delete('/:slug/api/citas/:id', (req, res) => {
  const { slug, id } = req.params;
  const tenant = db.prepare(`SELECT * FROM tenants WHERE slug = ? AND activo = 1`).get(slug);
  if (!tenant) return res.status(404).json({ ok: false });
  if (!verificarAuthCliente(req, res, tenant)) return;
  db.prepare(`DELETE FROM citas WHERE id=? AND tenant_id=?`).run(id, tenant.id);
  res.json({ ok: true });
});

// ─── API cliente: Google Calendar OAuth ──────────────────────────────────────
router.get('/:slug/api/google-auth', (req, res) => {
  const { slug } = req.params;
  const tenant = db.prepare(`SELECT * FROM tenants WHERE slug = ? AND activo = 1`).get(slug);
  if (!tenant) return res.status(404).json({ ok: false });
  if (!verificarAuthCliente(req, res, tenant)) return;
  if (!tenant.google_client_id || !tenant.google_client_secret)
    return res.status(400).json({ ok: false, error: 'Configura primero Client ID y Client Secret' });
  const url = calendarService.getAuthUrl(tenant);
  res.json({ ok: true, url });
});

router.get('/:slug/api/google-callback', async (req, res) => {
  const { slug } = req.params;
  const { code, error } = req.query;
  if (error) return res.send(`<h2>❌ Error: ${error}</h2>`);
  const tenant = db.prepare(`SELECT * FROM tenants WHERE slug = ? AND activo = 1`).get(slug);
  if (!tenant) return res.status(404).send('Tenant no encontrado');
  try {
    const tokens = await calendarService.intercambiarCodigo(tenant, code);
    if (tokens.refresh_token) {
      db.prepare(`UPDATE tenants SET google_refresh_token=? WHERE id=?`).run(tokens.refresh_token, tenant.id);
      invalidarCacheByTenantId(tenant.id);
    }
    res.send(`<h2>✅ Google Calendar conectado correctamente</h2><p>Puedes cerrar esta ventana.</p><script>window.close()</script>`);
  } catch(err) {
    res.send(`<h2>❌ Error al conectar: ${err.message}</h2>`);
  }
});

// ─── API cliente: campañas broadcast ─────────────────────────────────────────
router.get('/:slug/api/campanas', (req, res) => {
  const { slug } = req.params;
  const tenant = db.prepare(`SELECT * FROM tenants WHERE slug = ? AND activo = 1`).get(slug);
  if (!tenant) return res.status(404).json({ ok: false });
  if (!verificarAuthCliente(req, res, tenant)) return;
  const campanas = db.prepare(`SELECT * FROM campanas WHERE tenant_id=? ORDER BY creado_en DESC LIMIT 50`).all(tenant.id);
  res.json({ ok: true, campanas });
});

router.get('/:slug/api/campanas/preview', (req, res) => {
  const { slug } = req.params;
  const tenant = db.prepare(`SELECT * FROM tenants WHERE slug = ? AND activo = 1`).get(slug);
  if (!tenant) return res.status(404).json({ ok: false });
  if (!verificarAuthCliente(req, res, tenant)) return;
  const { filtro_estado, filtro_tag } = req.query;

  let query = `SELECT COUNT(DISTINCT c.telefono) as n FROM clientes c WHERE c.tenant_id=? AND COALESCE(c.archivado,0)=0`;
  const params = [tenant.id];
  if (filtro_estado) { query += ` AND COALESCE(c.estado,'en_conversacion')=?`; params.push(filtro_estado); }
  if (filtro_tag)    { query += ` AND EXISTS(SELECT 1 FROM cliente_tags WHERE tenant_id=? AND telefono=c.telefono AND tag=?)`; params.push(tenant.id, filtro_tag); }

  try {
    const n = db.prepare(query).get(...params)?.n || 0;
    res.json({ ok: true, total: n });
  } catch(err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/:slug/api/campanas', express.json(), (req, res) => {
  const { slug } = req.params;
  const tenant = db.prepare(`SELECT * FROM tenants WHERE slug = ? AND activo = 1`).get(slug);
  if (!tenant) return res.status(404).json({ ok: false });
  if (!verificarAuthCliente(req, res, tenant)) return;
  const { nombre, mensaje, filtro_estado, filtro_tag } = req.body;
  if (!nombre?.trim() || !mensaje?.trim()) return res.status(400).json({ ok: false, error: 'Faltan nombre y mensaje' });
  const r = db.prepare(`INSERT INTO campanas (tenant_id,nombre,mensaje,filtro_estado,filtro_tag) VALUES (?,?,?,?,?)`)
    .run(tenant.id, nombre.trim(), mensaje.trim(), filtro_estado||null, filtro_tag||null);
  res.json({ ok: true, id: r.lastInsertRowid });
});

router.delete('/:slug/api/campanas/:id', (req, res) => {
  const { slug, id } = req.params;
  const tenant = db.prepare(`SELECT * FROM tenants WHERE slug = ? AND activo = 1`).get(slug);
  if (!tenant) return res.status(404).json({ ok: false });
  if (!verificarAuthCliente(req, res, tenant)) return;
  const c = db.prepare(`SELECT estado FROM campanas WHERE id=? AND tenant_id=?`).get(id, tenant.id);
  if (!c) return res.status(404).json({ ok: false });
  if (c.estado === 'enviando') return res.status(409).json({ ok: false, error: 'No se puede eliminar mientras se envía' });
  db.prepare(`DELETE FROM campanas WHERE id=? AND tenant_id=?`).run(id, tenant.id);
  res.json({ ok: true });
});

router.post('/:slug/api/campanas/:id/enviar', express.json(), async (req, res) => {
  const { slug, id } = req.params;
  const tenant = db.prepare(`SELECT * FROM tenants WHERE slug = ? AND activo = 1`).get(slug);
  if (!tenant) return res.status(404).json({ ok: false });
  if (!verificarAuthCliente(req, res, tenant)) return;

  const campana = db.prepare(`SELECT * FROM campanas WHERE id=? AND tenant_id=?`).get(id, tenant.id);
  if (!campana) return res.status(404).json({ ok: false, error: 'No encontrada' });
  if (campana.estado === 'enviando')   return res.status(409).json({ ok: false, error: 'Ya se está enviando' });
  if (campana.estado === 'completada') return res.status(409).json({ ok: false, error: 'Ya fue enviada' });

  // Construir lista de destinatarios
  let query = `SELECT DISTINCT c.telefono, c.nombre FROM clientes c WHERE c.tenant_id=? AND COALESCE(c.archivado,0)=0`;
  const params = [tenant.id];
  if (campana.filtro_estado) { query += ` AND COALESCE(c.estado,'en_conversacion')=?`; params.push(campana.filtro_estado); }
  if (campana.filtro_tag)    { query += ` AND EXISTS(SELECT 1 FROM cliente_tags WHERE tenant_id=? AND telefono=c.telefono AND tag=?)`; params.push(tenant.id, campana.filtro_tag); }

  let destinatarios = [];
  try { destinatarios = db.prepare(query).all(...params); } catch(e) { return res.status(500).json({ ok: false, error: e.message }); }
  if (!destinatarios.length) return res.status(400).json({ ok: false, error: 'Sin destinatarios con este filtro' });

  db.prepare(`UPDATE campanas SET estado='enviando', total=?, enviado_en=CURRENT_TIMESTAMP WHERE id=?`).run(destinatarios.length, id);
  res.json({ ok: true, total: destinatarios.length });

  // Enviar en background
  const phoneId = tenant.whatsapp_phone_id;
  const tok     = tenant.whatsapp_token;
  let enviadas = 0, errores = 0;
  for (const dest of destinatarios) {
    const body = campana.mensaje.replace(/\{\{nombre\}\}/g, dest.nombre || 'Cliente');
    try {
      await axios.post(
        `https://graph.facebook.com/v18.0/${phoneId}/messages`,
        { messaging_product: 'whatsapp', recipient_type: 'individual', to: dest.telefono, type: 'text', text: { preview_url: false, body } },
        { headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' } }
      );
      enviadas++;
    } catch(_) { errores++; }
    await new Promise(r => setTimeout(r, 200)); // respetar rate limit
  }
  db.prepare(`UPDATE campanas SET estado='completada', enviadas=?, errores=? WHERE id=?`).run(enviadas, errores, id);
  console.log(`[Campaña ${id}] ✅ ${enviadas}/${destinatarios.length} enviados, ${errores} errores`);
});

// ─── API cliente: CRM — perfil completo ──────────────────────────────────────
router.get('/:slug/api/crm/:telefono', (req, res) => {
  const { slug, telefono } = req.params;
  const tenant = db.prepare(`SELECT * FROM tenants WHERE slug = ? AND activo = 1`).get(slug);
  if (!tenant) return res.status(404).json({ ok: false });
  if (!verificarAuthCliente(req, res, tenant)) return;

  const tags   = db.prepare(`SELECT * FROM cliente_tags  WHERE tenant_id=? AND telefono=? ORDER BY creado_en ASC`).all(tenant.id, telefono);
  const notas  = db.prepare(`SELECT * FROM cliente_notas WHERE tenant_id=? AND telefono=? ORDER BY creado_en DESC`).all(tenant.id, telefono);
  const cliente = db.prepare(`SELECT * FROM clientes WHERE telefono=? AND tenant_id=?`).get(telefono, tenant.id);

  let pedidos = [];
  try { pedidos = db.prepare(`SELECT id, estado, productos, total, creado_en FROM pedidos WHERE telefono=? AND tenant_id=? ORDER BY creado_en DESC LIMIT 10`).all(telefono, tenant.id); } catch(_) {}

  let pagos = [];
  try { pagos = db.prepare(`SELECT orden_id, monto, descripcion, estado, creado_en FROM pagos_pendientes WHERE telefono=? AND tenant_id=? ORDER BY creado_en DESC LIMIT 5`).all(telefono, tenant.id); } catch(_) {}

  res.json({ ok: true, tags, notas, cliente, pedidos, pagos });
});

// ─── API cliente: CRM — agregar tag ──────────────────────────────────────────
router.post('/:slug/api/crm/:telefono/tags', express.json(), (req, res) => {
  const { slug, telefono } = req.params;
  const tenant = db.prepare(`SELECT * FROM tenants WHERE slug = ? AND activo = 1`).get(slug);
  if (!tenant) return res.status(404).json({ ok: false });
  if (!verificarAuthCliente(req, res, tenant)) return;
  const { tag, color = '#1D4ED8' } = req.body;
  if (!tag?.trim()) return res.status(400).json({ ok: false, error: 'Falta tag' });
  try {
    const r = db.prepare(`INSERT OR IGNORE INTO cliente_tags (tenant_id, telefono, tag, color) VALUES (?,?,?,?)`).run(tenant.id, telefono, tag.trim(), color);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── API cliente: CRM — eliminar tag ─────────────────────────────────────────
router.delete('/:slug/api/crm/:telefono/tags/:id', (req, res) => {
  const { slug, telefono, id } = req.params;
  const tenant = db.prepare(`SELECT * FROM tenants WHERE slug = ? AND activo = 1`).get(slug);
  if (!tenant) return res.status(404).json({ ok: false });
  if (!verificarAuthCliente(req, res, tenant)) return;
  db.prepare(`DELETE FROM cliente_tags WHERE id=? AND tenant_id=? AND telefono=?`).run(id, tenant.id, telefono);
  res.json({ ok: true });
});

// ─── API cliente: CRM — agregar nota ─────────────────────────────────────────
router.post('/:slug/api/crm/:telefono/notas', express.json(), (req, res) => {
  const { slug, telefono } = req.params;
  const tenant = db.prepare(`SELECT * FROM tenants WHERE slug = ? AND activo = 1`).get(slug);
  if (!tenant) return res.status(404).json({ ok: false });
  if (!verificarAuthCliente(req, res, tenant)) return;
  const { nota, autor = 'Panel' } = req.body;
  if (!nota?.trim()) return res.status(400).json({ ok: false, error: 'Falta nota' });
  const r = db.prepare(`INSERT INTO cliente_notas (tenant_id, telefono, nota, autor) VALUES (?,?,?,?)`).run(tenant.id, telefono, nota.trim(), autor);
  res.json({ ok: true, id: r.lastInsertRowid });
});

// ─── API cliente: CRM — eliminar nota ────────────────────────────────────────
router.delete('/:slug/api/crm/:telefono/notas/:id', (req, res) => {
  const { slug, telefono, id } = req.params;
  const tenant = db.prepare(`SELECT * FROM tenants WHERE slug = ? AND activo = 1`).get(slug);
  if (!tenant) return res.status(404).json({ ok: false });
  if (!verificarAuthCliente(req, res, tenant)) return;
  db.prepare(`DELETE FROM cliente_notas WHERE id=? AND tenant_id=? AND telefono=?`).run(id, tenant.id, telefono);
  res.json({ ok: true });
});

// ─── Panel cliente — DEBE IR AL FINAL ────────────────────────────────────────
router.get('/:slug', (req, res) => {
  const { slug } = req.params;
  const tenant = db.prepare(`SELECT * FROM tenants WHERE slug = ? AND activo = 1`).get(slug);
  if (!tenant) return res.status(404).send('Cliente no encontrado');

  if (req.query.auth === 'jwt') {
    return res.sendFile(path.join(__dirname, '../public/panel.html'));
  }

  const key = req.query.key || '';
  if (tenant.panel_key && tenant.panel_key === key) {
    return res.sendFile(path.join(__dirname, '../public/panel.html'));
  }

  // Sin JWT ni key válida → siempre redirigir al login
  return res.redirect(`/panel/${slug}/login`);
});

module.exports = { router, emitirEvento, esModoHumano, setModoHumano, actualizarEstadoCliente, getEstadoCliente, ESTADOS };
