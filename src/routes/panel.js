// src/routes/panel.js
const express    = require('express');
const path       = require('path');
const axios      = require('axios');
const db         = require('../config/database');
const jwt        = require('jsonwebtoken');
const bcrypt     = require('bcryptjs');
const { invalidarCacheByTenantId } = require('../services/tenantService');
const { MENSAJES_DEFAULT }          = require('../services/followUpService');
const JWT_SECRET = process.env.JWT_SECRET || (() => {
  console.error('[Panel] ⚠️  JWT_SECRET no configurado. Define JWT_SECRET en .env para producción.');
  return 'fallback_secret_inseguro';
})();

// ─── Helper: verificar auth cliente (JWT o key legacy) ───────────────────────
function verificarAuthCliente(req, res, tenant) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (token) {
    try { jwt.verify(token, JWT_SECRET); return true; }
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
function emitirEvento(tipo, datos) {
  const payload = `data: ${JSON.stringify({ tipo, ...datos })}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch (_) { sseClients.delete(res); }
  }
}

// ─── Modo humano — persistido en BD para sobrevivir reinicios ─────────────────
const modoHumano = new Set();

// Restaurar conversaciones en modo humano al arrancar
try {
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
  if (!tenant.panel_usuario || tenant.panel_usuario !== usuario)
    return res.status(401).json({ ok: false, error: 'Credenciales incorrectas' });
  if (!tenant.panel_password_hash)
    return res.status(401).json({ ok: false, error: 'Credenciales no configuradas' });
  const valida = await bcrypt.compare(password, tenant.panel_password_hash);
  if (!valida)
    return res.status(401).json({ ok: false, error: 'Credenciales incorrectas' });
  const token = jwt.sign(
    { tenantId: tenant.id, slug: tenant.slug, empresa: tenant.empresa_nombre },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
  res.json({ ok: true, token, slug: tenant.slug, empresa: tenant.empresa_nombre });
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
      tipo_negocio, prompt_extra } = req.body;
    if (!slug || !empresa_nombre || !whatsapp_phone_id || !whatsapp_token)
      return res.status(400).json({ ok: false, error: 'Faltan campos obligatorios' });
    const r = db.prepare(`
      INSERT INTO tenants (slug, empresa_nombre, empresa_dir, empresa_web, empresa_horario, empresa_domingos,
        asistentes, pago_banco, pago_tipo, pago_cuenta, pago_titular, pago_rut, pago_email,
        envio_courier, envio_tiempo, envio_quien_paga, mayorista_minimo, garantia_meses, garantia_cond,
        bsale_token, whatsapp_phone_id, whatsapp_token, notif_telefono, modo_catalogo, panel_key,
        tipo_negocio, prompt_extra)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(slug, empresa_nombre, empresa_dir||'', empresa_web||'', empresa_horario||'', empresa_domingos?1:0,
      JSON.stringify(asistentes||[]), pago_banco||'', pago_tipo||'', pago_cuenta||'', pago_titular||'',
      pago_rut||'', pago_email||'', envio_courier||'', envio_tiempo||'', envio_quien_paga||'cliente',
      mayorista_minimo||3, garantia_meses||6, garantia_cond||'', bsale_token||'',
      whatsapp_phone_id, whatsapp_token, notif_telefono||'', modo_catalogo||'bsale', panel_key||'',
      tipo_negocio||'tienda', prompt_extra||'');
    res.json({ ok: true, tenantId: r.lastInsertRowid });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── API admin: info del tenant actual (para el modal de config) ─────────────
router.get('/api/tenant-info', verificarAdmin, (req, res) => {
  try {
    const key    = req.query.key || req.headers['x-admin-key'] || '';
    const tenant = db.prepare(`SELECT id, empresa_nombre, empresa_dir, empresa_horario, empresa_web, notif_telefono FROM tenants WHERE activo = 1 LIMIT 1`).get();
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

    const campos = ['notif_telefono','empresa_nombre','empresa_dir','empresa_horario','empresa_web','empresa_domingos','pago_banco','pago_tipo','pago_cuenta','pago_titular','pago_rut','pago_email','envio_courier','envio_tiempo','envio_quien_paga','garantia_meses','garantia_cond','prompt_extra'];
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
  };
  res.json({ ok: true, stats });
});

// ─── API cliente: contactos ───────────────────────────────────────────────────
router.get('/:slug/api/contactos', (req, res) => {
  const { slug } = req.params;
  const tenant = db.prepare(`SELECT * FROM tenants WHERE slug = ? AND activo = 1`).get(slug);
  if (!tenant) return res.status(404).json({ ok: false });
  if (!verificarAuthCliente(req, res, tenant)) return;
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
    return res.json({ ok: true, contactos });
  }
  const contactos = db.prepare(`
    SELECT c.telefono, c.nombre,
      COALESCE(cl.estado, 'en_conversacion') as estado,
      COUNT(c.id) as total_mensajes,
      MAX(c.creado_en) as ultimo_mensaje
    FROM conversaciones c
    LEFT JOIN clientes cl ON cl.telefono = c.telefono AND cl.tenant_id = ?
    WHERE c.tenant_id = ?
    GROUP BY c.telefono
    ORDER BY ultimo_mensaje DESC LIMIT 200
  `).all(tenant.id, tenant.id);
  res.json({ ok: true, contactos });
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
  } catch (err) { res.status(500).json({ ok: false, error: err.response?.data?.error?.message || err.message }); }
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
  if (ok && (estado === 'pagado' || estado === 'despachado')) {
    const DUENO_TEL = tenant.notif_telefono || process.env.DUENO_WHATSAPP;
    if (DUENO_TEL) {
      const cliente = db.prepare(`SELECT nombre FROM clientes WHERE telefono = ?`).get(telefono);
      const nombre = cliente?.nombre || telefono;
      try {
        await axios.post(
          `https://graph.facebook.com/v18.0/${tenant.whatsapp_phone_id}/messages`,
          { messaging_product: 'whatsapp', recipient_type: 'individual', to: DUENO_TEL,
            type: 'text', text: { preview_url: false, body: `${ESTADOS[estado].emoji} *Estado actualizado*\nCliente: ${nombre} (${telefono})\nNuevo estado: *${ESTADOS[estado].label}*` } },
          { headers: { Authorization: `Bearer ${tenant.whatsapp_token}`, 'Content-Type': 'application/json' } }
        );
      } catch (err) { console.error('[Panel] Error notificando:', err.message); }
    }
  }
  res.json({ ok, estados: ESTADOS });
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
