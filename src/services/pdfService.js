// src/services/pdfService.js
const pdfParse = require('pdf-parse');
const db       = require('../config/database');

// ─── Tablas PDF ───────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS catalogo_pdf_chunks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id   INTEGER NOT NULL,
    pagina      INTEGER DEFAULT 0,
    chunk_text  TEXT    NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_pdf_chunks_tenant ON catalogo_pdf_chunks(tenant_id);
`);

try {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS catalogo_pdf_fts USING fts5(
      chunk_text,
      content=catalogo_pdf_chunks,
      content_rowid=id,
      tokenize='unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER IF NOT EXISTS pdf_chunks_ai AFTER INSERT ON catalogo_pdf_chunks BEGIN
      INSERT INTO catalogo_pdf_fts(rowid, chunk_text) VALUES (new.id, new.chunk_text);
    END;
    CREATE TRIGGER IF NOT EXISTS pdf_chunks_ad AFTER DELETE ON catalogo_pdf_chunks BEGIN
      INSERT INTO catalogo_pdf_fts(catalogo_pdf_fts, rowid, chunk_text) VALUES ('delete', old.id, old.chunk_text);
    END;
  `);
} catch (_) {}

// ─── Parsear y indexar PDF ────────────────────────────────────────────────────
async function procesarPDF(buffer, tenantId) {
  const data  = await pdfParse(buffer);
  const texto = data.text || '';

  // Dividir en chunks de ~700 chars respetando saltos de párrafo
  const parrafos = texto.split(/\n{2,}/).map(p => p.trim()).filter(p => p.length > 25);
  const chunks = [];
  let actual = '';

  for (const p of parrafos) {
    if (actual && (actual + '\n' + p).length > 700) {
      chunks.push(actual.trim());
      actual = p;
    } else {
      actual = actual ? actual + '\n' + p : p;
    }
  }
  if (actual.trim()) chunks.push(actual.trim());

  // Eliminar catálogo anterior del tenant
  db.prepare(`DELETE FROM catalogo_pdf_chunks WHERE tenant_id = ?`).run(tenantId);

  // Insertar nuevos chunks (triggers sincronizan FTS5)
  const ins = db.prepare(`INSERT INTO catalogo_pdf_chunks (tenant_id, pagina, chunk_text) VALUES (?, ?, ?)`);
  const insertarTodos = db.transaction((chunks) => {
    chunks.forEach((c, i) => ins.run(tenantId, i + 1, c));
  });
  insertarTodos(chunks);

  console.log(`[PDF] ✅ ${chunks.length} chunks indexados para tenant ${tenantId} (${data.numpages} págs)`);
  return { chunks: chunks.length, paginas: data.numpages };
}

// ─── Buscar en PDF ────────────────────────────────────────────────────────────
function buscarEnPDF(query, tenantId, limite = 4) {
  if (!query || query.length < 2) return '';
  try {
    const terminos = query
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(t => t.length > 1)
      .map(t => `"${t.replace(/["*^]/g, '')}"*`)
      .join(' OR ');

    const rows = db.prepare(`
      SELECT c.chunk_text
      FROM catalogo_pdf_fts f
      JOIN catalogo_pdf_chunks c ON c.id = f.rowid
      WHERE catalogo_pdf_fts MATCH ? AND c.tenant_id = ?
      ORDER BY rank LIMIT ?
    `).all(terminos, tenantId, limite);

    return rows.map(r => r.chunk_text).join('\n\n');
  } catch (err) {
    console.error('[PDF] Error FTS:', err.message);
    // Fallback a LIKE
    try {
      const q = `%${query}%`;
      const rows = db.prepare(`
        SELECT chunk_text FROM catalogo_pdf_chunks
        WHERE tenant_id = ? AND chunk_text LIKE ? LIMIT ?
      `).all(tenantId, q, limite);
      return rows.map(r => r.chunk_text).join('\n\n');
    } catch (_) { return ''; }
  }
}

// ─── ¿Tiene PDF cargado? ──────────────────────────────────────────────────────
function tienePDF(tenantId) {
  try {
    return (db.prepare(`SELECT COUNT(*) as n FROM catalogo_pdf_chunks WHERE tenant_id = ?`).get(tenantId)?.n || 0) > 0;
  } catch (_) { return false; }
}

// ─── Info del PDF actual ──────────────────────────────────────────────────────
function infoPDF(tenantId) {
  try {
    const r = db.prepare(`
      SELECT COUNT(*) as chunks, MAX(pagina) as paginas
      FROM catalogo_pdf_chunks WHERE tenant_id = ?
    `).get(tenantId);
    return r?.chunks > 0 ? { chunks: r.chunks, paginas: r.paginas } : null;
  } catch (_) { return null; }
}

module.exports = { procesarPDF, buscarEnPDF, tienePDF, infoPDF };
