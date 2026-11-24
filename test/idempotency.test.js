import './setup.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const databaseUrl = process.env.DATABASE_URL;
const skip = !databaseUrl;

describe('idempotencia por wamid', { skip, concurrency: 1 }, () => {
  let db;

  it('un id vacío no se marca ni se trata como duplicado', async () => {
    db = await import('../src/db.js');
    await db.initDb();
    assert.equal(await db.markProcessed(''), false);
    assert.equal(await db.markProcessed('   '), false);
    assert.equal(await db.isDuplicateEvent(''), false);
    assert.equal(await db.isDuplicateEvent(null), false);
  });

  it('marca el wamid solo cuando se registra, y caduca a las 24 h', async () => {
    const DAY = 24 * 60 * 60 * 1000;
    const id = `wamid.H-${Date.now()}`;
    const at = 1_700_000_000_000;
    assert.equal(await db.isDuplicateEvent(id, at), false);
    assert.equal(await db.markProcessed(id, at), true);
    assert.equal(await db.isDuplicateEvent(id, at + 1000), true);
    assert.equal(await db.isDuplicateEvent(id, at + DAY - 1), true);
    assert.equal(await db.isDuplicateEvent(id, at + DAY), false);
    await db.closeDb();
  });
});
