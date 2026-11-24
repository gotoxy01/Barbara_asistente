import './setup.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as db from '../src/db.js';

const DAY = 24 * 60 * 60 * 1000;

describe('idempotencia por wamid', { concurrency: 1 }, () => {
  it('un id vacío no se marca ni se trata como duplicado', () => {
    assert.equal(db.markProcessed(''), false);
    assert.equal(db.markProcessed('   '), false);
    assert.equal(db.isDuplicateEvent(''), false);
    assert.equal(db.isDuplicateEvent(null), false);
  });

  it('marca el wamid solo cuando se registra, y caduca a las 24 h', () => {
    const id = 'wamid.H-fase1';
    const at = 1_700_000_000_000;
    assert.equal(db.isDuplicateEvent(id, at), false);
    assert.equal(db.markProcessed(id, at), true);
    assert.equal(db.isDuplicateEvent(id, at + 1000), true);
    assert.equal(db.isDuplicateEvent(id, at + DAY - 1), true);
    assert.equal(db.isDuplicateEvent(id, at + DAY), false);
    assert.equal(db.isDuplicateEvent(id, at + DAY + 1), false);
    assert.equal(db.markProcessed(id, at + DAY + 5), true);
    assert.equal(db.isDuplicateEvent(id, at + DAY + 6), true);
  });
});
