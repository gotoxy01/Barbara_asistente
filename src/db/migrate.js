import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');

/**
 * Aplica los SQL de migrations/ una sola vez.
 * @param {import('pg').Pool} pool
 * @param {number} embeddingDimensions
 */
export async function runMigrations(pool, embeddingDimensions) {
  const dim = Number(embeddingDimensions);
  if (!Number.isInteger(dim) || dim < 8 || dim > 4096) {
    throw new Error(`EMBEDDING_DIMENSIONS inválida: ${embeddingDimensions}`);
  }

  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const files = fs.readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort();
    for (const file of files) {
      const done = await client.query('SELECT 1 FROM schema_migrations WHERE id = $1', [file]);
      if (done.rowCount) continue;
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8')
        .replaceAll('__EMBED_DIM__', String(dim));
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        const hint = /vector|extension/i.test(String(err.message))
          ? ' Instale pgvector en este PostgreSQL y ejecute CREATE EXTENSION vector.'
          : '';
        throw new Error(`No se pudo aplicar ${file}: ${err.message}.${hint}`);
      }
    }
  } finally {
    client.release();
  }
}
