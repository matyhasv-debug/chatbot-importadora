// src/services/backupService.js
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');

const DB_PATH   = process.env.DB_PATH || path.join(__dirname, '../../data/chatbot.db');
const FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;

async function getDriveClient() {
  const credenciales = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials: credenciales,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return google.drive({ version: 'v3', auth });
}

async function subirBackupDrive() {
  try {
    const drive = await getDriveClient();
    const ahora = new Date().toISOString().replace(/[:.]/g, '-');
    const nombreArchivo = `backup-${ahora}.db`;

    const res = await drive.files.create({
      supportsAllDrives: true,
      requestBody: {
        name: nombreArchivo,
        parents: [FOLDER_ID],
      },
      media: {
        mimeType: 'application/octet-stream',
        body: fs.createReadStream(DB_PATH),
      },
    });

    console.log(`[Backup] ✅ Subido: ${nombreArchivo} (ID: ${res.data.id})`);

    // Conservar solo los últimos 7 backups
    const lista = await drive.files.list({
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      q: `'${FOLDER_ID}' in parents and trashed = false`,
      orderBy: 'createdTime desc',
      fields: 'files(id, name)',
    });

    const archivos = lista.data.files || [];
    if (archivos.length > 7) {
      for (const archivo of archivos.slice(7)) {
        await drive.files.delete({ fileId: archivo.id, supportsAllDrives: true });
        console.log(`[Backup] 🗑️ Eliminado: ${archivo.name}`);
      }
    }

    return true;
  } catch (err) {
    console.error('[Backup] ❌ Error:', err.message);
    return false;
  }
}

function iniciarBackupAutomatico() {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON || !FOLDER_ID) {
    console.log('[Backup] ⏭️ Backup a Drive no configurado (GOOGLE_SERVICE_ACCOUNT_JSON / GOOGLE_DRIVE_FOLDER_ID ausentes)');
    return;
  }
  const INTERVALO = 24 * 60 * 60 * 1000;
  console.log('[Backup] 🗄️ Backup automático activado (cada 24h)');
  subirBackupDrive();
  setInterval(subirBackupDrive, INTERVALO);
}

module.exports = { iniciarBackupAutomatico, subirBackupDrive };
