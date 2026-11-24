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

  it('un reinicio no pierde el pedido, y el pago verificado descuenta una sola vez', async () => {
    const db = await import('../src/db.js');
    const { applyAction, loadProfileSummary } = await import('../src/services/orderBook.js');
    await db.initDb();
    const phone = `5877${Date.now().toString().slice(-8)}`;
    await db.upsertChat(phone, 'María Pérez');
    const item = { sku: 'harina-pan', nombre: 'Harina PAN blanca', cantidad: 2, precio: 1.8 };
    let step = await applyAction(phone, { type: 'add_item', item });
    const id = step.order.id;
    assert.equal((await db.listOpenOrders()).some((order) => order.id === id), true);
    step = await applyAction(phone, { type: 'boleta', totals: { totalUsd: 3.6, totalBs: 144, rate: 40 } });
    step = await applyAction(phone, { type: 'report_payment', reference: '12345678', mediaId: 'media-1' });
    assert.equal(step.order.lifecycle, 'pago_reportado');
    assert.equal((await db.ledgerActions(id)).length, 0);
    step = await applyAction(phone, { type: 'save_address', address: 'Torre La Noria, apto 4, Las Mercedes', name: 'María Pérez' });
    assert.equal(step.logistics, true);
    assert.match(step.notice, /pagó el pedido/);
    assert.equal((await db.getChat(phone)).status, 'LOGISTICA');
    const summary = await loadProfileSummary(phone, 'María Pérez');
    assert.match(summary, /Harina PAN blanca/);
    assert.match(summary, /Torre La Noria/);
    await applyAction(phone, { type: 'verify_payment', orderId: id, actor: 'operador' });
    const second = await applyAction(phone, { type: 'verify_payment', orderId: id, actor: 'operador' });
    assert.equal(second.ledger, null);
    assert.equal((await db.ledgerActions(id)).filter((row) => row.action === 'deduct').length, 1);
    await applyAction(phone, { type: 'cancel', orderId: id, actor: 'operador' });
    assert.ok((await db.ledgerActions(id)).some((row) => row.action === 'restore'));
    assert.equal((await db.getOrderById(id)).lifecycle, 'cancelado');
    await db.closeDb();
  });
});
