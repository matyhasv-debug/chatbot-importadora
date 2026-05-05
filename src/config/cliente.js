// src/config/cliente.js
module.exports = {

  empresa: {
    nombre:    'Velasquez Importaciones',
    direccion: 'Av. Francia 365, Valparaíso, Chile',
    web:       'www.velasquezimportaciones.cl',
    horario:   'Lunes a Viernes: 9:30–19:30 hrs | Sábados: 10:00–17:30 hrs',
    domingos:  false,
  },

  asistentes: ['Yanelly', 'Catalina', 'Kimberly', 'Jeremias'],

  pago: {
    banco:        'BCI / Mach Bank',
    tipoCuenta:   'Cuenta Corriente',
    numeroCuenta: '30670802',
    titular:      'Alberto Velásquez',
    rut:          '9.074.386-4',
    email:        'velasquez.importacioness@gmail.com',
  },

  envio: {
    courier:   'Blue Express',
    tiempo:    '24–48 horas hábiles',
    quienPaga: 'cliente',
  },

  mayorista: {
    minimoUnidades: 3,
  },

  garantia: {
    meses:     6,
    condicion: 'Se requiere boleta para hacer válida la garantía.',
  },

  desarrollador: {
    nombre: 'Matías Vidal',
    email:  'torresvidalmatias99@gmail.com',
  },

  embalajes: [
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
  ],

};
