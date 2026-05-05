// ============================================================
// TEMPLATE DE CONFIGURACIÓN — COPIAR Y RENOMBRAR POR CLIENTE
// Ejemplo: clienteFlores.js, clienteTecnoShop.js, etc.
// ============================================================

module.exports = {

  empresa: {
    nombre:    'Nombre del Negocio',
    direccion: 'Dirección física',
    web:       'www.tunegocio.cl',
    horario:   'Lun-Vie 9:00–19:00 | Sáb 10:00–15:00',
    domingos:  false,
  },

  asistentes: ['Nombre1', 'Nombre2'], // Nombres del bot

  pago: {
    banco:        'Nombre del banco',
    tipoCuenta:   'Cuenta Corriente',
    numeroCuenta: '00000000',
    titular:      'Nombre Titular',
    rut:          '0.000.000-0',
    email:        'pagos@negocio.cl',
  },

  envio: {
    courier:    'Blue Express',
    tiempo:     '24–48 horas hábiles',
    quienPaga:  'cliente', // 'cliente' o 'negocio'
  },

  mayorista: {
    minimoUnidades: 3,
  },

  embalajes: [
    // { nombre: 'Producto', unidades: 10, precioUnitario: 5000, totalCaja: 50000 },
  ],

  garantia: {
    meses:      6,
    condicion:  'Se requiere boleta para hacer válida la garantía.',
  },

  desarrollador: {
    nombre: 'Matías Vidal',
    email:  'torresvidalmatias99@gmail.com',
  },

};
