// src/services/calendarService.js
const { google } = require('googleapis');
const db = require('../config/database');

function crearCliente(tenant) {
  const redirectUri = (process.env.APP_URL || 'http://localhost:3000') + '/panel/' + tenant.slug + '/api/google-callback';
  const auth = new google.auth.OAuth2(tenant.google_client_id, tenant.google_client_secret, redirectUri);
  if (tenant.google_refresh_token) auth.setCredentials({ refresh_token: tenant.google_refresh_token });
  return auth;
}

function tieneCalendario(tenant) {
  return !!(tenant?.google_client_id && tenant?.google_client_secret && tenant?.google_refresh_token);
}

function getAuthUrl(tenant) {
  const auth = crearCliente(tenant);
  return auth.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/calendar.events'],
    prompt: 'consent',
  });
}

async function intercambiarCodigo(tenant, code) {
  const auth = crearCliente(tenant);
  const { tokens } = await auth.getToken(code);
  return tokens;
}

async function crearEvento(tenant, { resumen, descripcion, fecha, hora, duracionMin = 60 }) {
  const auth = crearCliente(tenant);
  const calendar = google.calendar({ version: 'v3', auth });
  const inicio = new Date(`${fecha}T${hora || '10:00'}:00-03:00`);
  const fin    = new Date(inicio.getTime() + duracionMin * 60000);
  const event  = {
    summary:     resumen,
    description: descripcion || '',
    start: { dateTime: inicio.toISOString(), timeZone: 'America/Santiago' },
    end:   { dateTime: fin.toISOString(),    timeZone: 'America/Santiago' },
  };
  const res = await calendar.events.insert({
    calendarId: tenant.google_calendar_id || 'primary',
    resource: event,
  });
  return res.data;
}

module.exports = { tieneCalendario, getAuthUrl, intercambiarCodigo, crearEvento };
