import './setup.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const skip = !process.env.DATABASE_URL;

describe('repositorio Postgres', { skip, concurrency: 1 }, () => {
  it('guarda un contacto, un mensaje y lo reconoce como duplicado', async () => {
    const db = await import('../src/db.js');
    await db.initDb();
    const phone = `5899${Date.now().toString().slice(-8)}`;
    const chat = await db.upsertChat(phone, 'Cliente Prueba');
    assert.equal(chat.phone, phone);
    assert.equal(chat.status, 'BOT');
    const wamid = `wamid.repo.${Date.now()}`;
    assert.equal(await db.addMessage(phone, 'user', 'hola', wamid), true);
    assert.equal(await db.addMessage(phone, 'user', 'hola otra vez', wamid), false);
    assert.equal(await db.hasInbound(wamid), true);
    const history = await db.getHistory(phone);
    assert.equal(history.at(-1).content, 'hola');
    await db.addMessage(phone, 'model', '❌ Harina Pan: por ahora no la tenemos disponible');
    const removed = await db.clearCustomerThread(phone);
    assert.ok(removed >= 2);
    assert.equal((await db.getHistory(phone)).length, 0);
    const again = await db.getChat(phone);
    assert.equal(again.status, 'BOT');
    await db.closeDb();
  });
});
