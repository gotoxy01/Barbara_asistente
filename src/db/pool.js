import pg from 'pg';
import { config } from '../config.js';

const { Pool } = pg;

/** @type {pg.Pool | null} */
let pool = null;

export function getPool() {
  return pool;
}

export function setPool(next) {
  pool = next;
}

export async function openPool(connectionString = config.databaseUrl) {
  if (!connectionString) {
    throw new Error('Falta DATABASE_URL (PostgreSQL local de la tienda).');
  }
  if (pool) return pool;
  pool = new Pool({ connectionString });
  return pool;
}

export async function closePool() {
  if (!pool) return;
  await pool.end();
  pool = null;
}

export async function query(text, params = [], client = null) {
  const runner = client || pool;
  if (!runner) throw new Error('Postgres no está iniciado. Arranque con initDb().');
  return runner.query(text, params);
}

/** Una sola transacción. El callback recibe el cliente de pg. */
export async function withTransaction(fn) {
  if (!pool) throw new Error('Postgres no está iniciado. Arranque con initDb().');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ya estaba cerrada */ }
    throw err;
  } finally {
    client.release();
  }
}
