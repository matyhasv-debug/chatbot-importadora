// src/config/database.js
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/chatbot.db');
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS conversaciones (
    id          INTEGER PRIMARY KEY AUTOINCREMENT, 
    telefono    TEXT NOT NULL,
    nombre      TEXT,
    rol         TEXT NOT NULL CHECK(rol IN ('user','assistant')),
    mensaje     TEXT NOT NULL,
    creado_en   DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS tenant_productos (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id       INTEGER NOT NULL REFERENCES tenants(id),
  nombre          TEXT NOT NULL,
  descripcion     TEXT,
  precio_unitario REAL DEFAULT 0,
  precio_mayorista REAL DEFAULT 0,
  stock           INTEGER DEFAULT 0,
  activo          INTEGER DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_productos_tenant ON tenant_productos(tenant_id);

  CREATE TABLE IF NOT EXISTS pedidos (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    telefono       TEXT NOT NULL,
    nombre_cliente TEXT,
    estado         TEXT DEFAULT 'pendiente'
                   CHECK(estado IN ('pendiente','confirmado','preparando','listo','entregado','cancelado')),
    productos      TEXT NOT NULL,
    total          REAL,
    notas          TEXT,
    creado_en      DATETIME DEFAULT CURRENT_TIMESTAMP,
    actualizado_en DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS clientes (
    telefono      TEXT PRIMARY KEY,
    nombre        TEXT,
    total_pedidos INTEGER DEFAULT 0,
    primer_pedido DATETIME,
    ultimo_pedido DATETIME
  );

  CREATE TABLE IF NOT EXISTS seguimientos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    telefono    TEXT NOT NULL,
    tipo        TEXT NOT NULL,
    enviado     INTEGER DEFAULT 0,
    creado_en   DATETIME DEFAULT CURRENT_TIMESTAMP,
    enviar_en   DATETIME NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tenants (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    slug             TEXT NOT NULL UNIQUE,
    activo           INTEGER DEFAULT 1,
    empresa_nombre   TEXT NOT NULL,
    empresa_dir      TEXT,
    empresa_web      TEXT,
    empresa_horario  TEXT,
    empresa_domingos INTEGER DEFAULT 0,
    asistentes       TEXT DEFAULT '[]',
    pago_banco       TEXT,
    pago_tipo        TEXT,
    pago_cuenta      TEXT,
    pago_titular     TEXT,
    pago_rut         TEXT,
    pago_email       TEXT,
    envio_courier    TEXT,
    envio_tiempo     TEXT,
    envio_quien_paga TEXT DEFAULT 'cliente',
    mayorista_minimo INTEGER DEFAULT 3,
    garantia_meses   INTEGER DEFAULT 6,
    garantia_cond    TEXT,
    bsale_token          TEXT,
    whatsapp_phone_id    TEXT UNIQUE,
    whatsapp_token       TEXT,
    notif_telefono       TEXT,
    creado_en        DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS tenant_embalajes (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id       INTEGER NOT NULL REFERENCES tenants(id),
    nombre          TEXT NOT NULL,
    unidades        INTEGER,
    precio_unitario REAL,
    total_caja      REAL
  );

  CREATE INDEX IF NOT EXISTS idx_conv_telefono    ON conversaciones(telefono);
  CREATE INDEX IF NOT EXISTS idx_pedidos_telefono ON pedidos(telefono);
  CREATE INDEX IF NOT EXISTS idx_pedidos_estado   ON pedidos(estado);
  CREATE INDEX IF NOT EXISTS idx_seg_telefono     ON seguimientos(telefono);
  CREATE INDEX IF NOT EXISTS idx_seg_enviar       ON seguimientos(enviar_en, enviado);
  CREATE INDEX IF NOT EXISTS idx_tenants_slug     ON tenants(slug);
  CREATE INDEX IF NOT EXISTS idx_embalajes_tenant ON tenant_embalajes(tenant_id);
`);

// ─── Migraciones ──────────────────────────────────────────────────────────────
const migraciones = [
  `ALTER TABLE tenants ADD COLUMN panel_usuario TEXT`,
  `ALTER TABLE tenants ADD COLUMN panel_password_hash TEXT`,
  `ALTER TABLE clientes ADD COLUMN etapa_conversacion TEXT DEFAULT 'explorando'`,
  `ALTER TABLE clientes ADD COLUMN estado TEXT DEFAULT 'nuevo'`,
  `ALTER TABLE clientes ADD COLUMN ultimo_contacto DATETIME`,
  `ALTER TABLE conversaciones ADD COLUMN tenant_id INTEGER REFERENCES tenants(id)`,
  `ALTER TABLE pedidos        ADD COLUMN tenant_id INTEGER REFERENCES tenants(id)`,
  `ALTER TABLE clientes       ADD COLUMN tenant_id INTEGER REFERENCES tenants(id)`,
  `ALTER TABLE tenants ADD COLUMN modo_catalogo TEXT DEFAULT 'bsale'`,
  `ALTER TABLE tenants ADD COLUMN panel_key TEXT`,
  `ALTER TABLE seguimientos ADD COLUMN tenant_id INTEGER REFERENCES tenants(id)`,
  `ALTER TABLE clientes ADD COLUMN modo_humano INTEGER DEFAULT 0`,
];

for (const sql of migraciones) {
  try {
    db.prepare(sql).run();
    console.log(`[DB] ✅ Migración: ${sql.slice(0, 60)}`);
  } catch (_) {
    // columna ya existe, ignorar
  }
}
// ─── Migrar registros sin tenant_id a Velásquez ───────────────────────────────
try {
  const tmp = db.prepare("SELECT id FROM tenants WHERE slug = 'velasquez'").get();
  if (tmp) {
    const tid = tmp.id;
    const a = db.prepare("UPDATE conversaciones SET tenant_id = ? WHERE tenant_id IS NULL").run(tid);
    const b = db.prepare("UPDATE clientes SET tenant_id = ? WHERE tenant_id IS NULL").run(tid);
    const c = db.prepare("UPDATE pedidos SET tenant_id = ? WHERE tenant_id IS NULL").run(tid);
    console.log("[DB] Migracion conv:" + a.changes + " clientes:" + b.changes + " pedidos:" + c.changes);
  }
} catch(e) { console.error("[DB] Error:", e.message); }
module.exports = db;
