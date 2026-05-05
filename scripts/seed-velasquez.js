// scripts/seed-velasquez.js
// Uso: node scripts/seed-velasquez.js
require('dotenv').config();
const db = require('../src/config/database');

const result = db.prepare(`
  INSERT OR IGNORE INTO tenants (
    slug, empresa_nombre, empresa_dir, empresa_web, empresa_horario, empresa_domingos,
    asistentes,
    pago_banco, pago_tipo, pago_cuenta, pago_titular, pago_rut, pago_email,
    envio_courier, envio_tiempo, envio_quien_paga,
    mayorista_minimo, garantia_meses, garantia_cond,
    bsale_token, whatsapp_phone_id, whatsapp_token, notif_telefono
  ) VALUES (
    'velasquez',
    'Velasquez Importaciones',
    'Av. Francia 365, Valparaíso, Chile',
    'www.velasquezimportaciones.cl',
    'Lunes a Viernes: 9:30–19:30 hrs | Sábados: 10:00–17:30 hrs',
    0,
    '["Yanelly","Catalina","Kimberly","Jeremias"]',
    'BCI / Mach Bank', 'Cuenta Corriente', '30670802', 'Alberto Velásquez', '9.074.386-4', 'velasquez.importacioness@gmail.com',
    'Blue Express', '24–48 horas hábiles', 'cliente',
    3, 6, 'Se requiere boleta para hacer válida la garantía.',
    ?, ?, ?, ?
  )
`).run(
  process.env.BSALE_TOKEN,
  process.env.WHATSAPP_PHONE_ID,
  process.env.WHATSAPP_TOKEN,
  process.env.DUENO_WHATSAPP
);

const tenantId = result.lastInsertRowid;

if (!tenantId) {
  console.log('⚠️  El tenant Velásquez ya existe en la BD — no se insertó de nuevo.');
  process.exit(0);
}

const embalajes = [
  { nombre: 'Zapatero plegable',   unidades: 6,   precioUnitario: 12000,  totalCaja: 72000  },
  { nombre: 'Parlante Bazuca RGB', unidades: 100, precioUnitario: 1800,   totalCaja: 180000 },
  { nombre: 'Pisos plegables',     unidades: 20,  precioUnitario: 3500,   totalCaja: 70000  },
  { nombre: 'Control PS4',         unidades: 100, precioUnitario: 7500,   totalCaja: 750000 },
  { nombre: 'Kit de grabación',    unidades: 60,  precioUnitario: 3000,   totalCaja: 180000 },
  { nombre: 'Alexa Spot',          unidades: 80,  precioUnitario: 9000,   totalCaja: 720000 },
  { nombre: 'Audífonos Ultrapods', unidades: 100, precioUnitario: 1900,   totalCaja: 190000 },
  { nombre: 'Hervidor 2L',         unidades: 16,  precioUnitario: 3300,   totalCaja: 52800  },
  { nombre: 'Freidora de Aire 6L', unidades: 4,   precioUnitario: 18000,  totalCaja: 72000  },
  { nombre: 'Licuadora',           unidades: 10,  precioUnitario: 8500,   totalCaja: 85000  },
  { nombre: 'Cafetera',            unidades: 12,  precioUnitario: 11000,  totalCaja: 132000 },
  { nombre: 'Set contenedores',    unidades: 6,   precioUnitario: 13500,  totalCaja: 81000  },
];

const insertEmbalaje = db.prepare(`
  INSERT INTO tenant_embalajes (tenant_id, nombre, unidades, precio_unitario, total_caja)
  VALUES (?, ?, ?, ?, ?)
`);

const insertarTodos = db.transaction(() => {
  for (const e of embalajes) {
    insertEmbalaje.run(tenantId, e.nombre, e.unidades, e.precioUnitario, e.totalCaja);
  }
});

insertarTodos();
console.log(`✅ Tenant Velásquez creado con ID ${tenantId}`);
console.log(`✅ ${embalajes.length} embalajes insertados`);
console.log(`✅ WhatsApp Phone ID: ${process.env.WHATSAPP_PHONE_ID}`);
console.log(`✅ Bsale Token: ${process.env.BSALE_TOKEN ? 'presente' : 'FALTA'}`);
