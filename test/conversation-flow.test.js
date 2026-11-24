import './setup.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isAddIntent, isGeneralCatalogAsk, isOrderStatusQuestion } from '../src/services/customerText.js';
import { isCheckoutClose } from '../src/services/orderLifecycle.js';
import { expandCustomerReply, planPurchase } from '../src/services/orderService.js';

describe('decisiones del mostrador', () => {
  it('qué más tienen es catálogo general y más nada cierra', () => {
    assert.equal(isGeneralCatalogAsk('Que más tienen?'), true);
    assert.equal(isCheckoutClose('mas nada'), true);
    assert.equal(isCheckoutClose('Solo eso'), true);
    assert.equal(isOrderStatusQuestion('Y mi harina?'), true);
    assert.equal(isAddIntent('Y mi harina?'), false);
    assert.equal(isAddIntent('quiero una harina pan'), true);
  });

  it('una harina pan anota una sola, la pregunta del pedido no anota', async () => {
    const add = await planPurchase('quiero una harina pan');
    assert.equal(add.action, 'add');
    assert.equal(add.qty, 1);
    assert.match(add.product.nombre, /blanca/i);
    assert.equal((await planPurchase('Y mi harina?')).action, 'none');
    assert.equal((await planPurchase('tienen harina?')).action, 'none');
  });

  it('la boleta deja de ser el marcador y no repite la pregunta', () => {
    const state = {
      boleta: '🧾 RESUMEN\nTOTAL',
      boletaForCustomer: () => '🧾 *RESUMEN DE SU PEDIDO*\n💰 *TOTAL A PAGAR:* Bs. 10.00',
      savedAddress: 'Torre La Noria, apto 4, Las Mercedes',
    };
    const rendered = expandCustomerReply('[BOLETA]\n\n¿Desea agregar algo más? 🛒\n¿Desea agregar algo más? 🛒', state);
    assert.equal(rendered.includes('[BOLETA]'), false);
    assert.match(rendered, /TOTAL A PAGAR/);
    assert.match(rendered, /Torre La Noria/);
    assert.equal((rendered.match(/Desea agregar algo más/gi) || []).length, 1);
  });
});

const skip = !process.env.DATABASE_URL;

describe('conversación de punta a punta', { skip }, () => {
  it('saludo, una harina, pregunta, cierre y boleta con dirección', async () => {
    const db = await import('../src/db.js');
    const { handleCustomerMessage } = await import('../src/services/chatService.js');
    await db.initDb();
    const phone = `5866${Date.now().toString().slice(-8)}`;
    const name = 'Cliente de Prueba';
    const say = (text) => handleCustomerMessage({ phone, name, text }, { notify: async () => {} });

    const hello = await say('Hola');
    assert.match(hello.reply, /^¡Buen/);
    assert.match(hello.reply, /Le saluda \*Bárbara\*/);
    assert.equal(hello.reply.includes('Cliente'), false);
    assert.equal(hello.reply.includes('🙏'), false);
    assert.equal(hello.reply.includes(',,'), false);

    const listed = await say('tienen harina?');
    assert.match(listed.reply, /Harina/);
    assert.equal((await db.getActiveOrder(phone))?.items?.length || 0, 0);

    const added = await say('quiero una harina pan');
    assert.match(added.reply, /Anoté/);
    assert.equal((added.reply.match(/Desea agregar algo más/gi) || []).length, 1);
    let order = await db.getActiveOrder(phone);
    assert.equal(order.items.length, 1);
    assert.equal(Number(order.items[0].cantidad), 1);

    const more = await say('Que más tienen?');
    assert.match(more.reply, /categorías|Víveres/i);
    assert.equal(more.escalated, false);

    const status = await say('Y mi harina?');
    assert.match(status.reply, /En su pedido/);
    order = await db.getActiveOrder(phone);
    assert.equal(order.items.length, 1);
    assert.equal(Number(order.items[0].cantidad), 1);

    const done = await say('mas nada');
    assert.equal(done.reply.includes('[BOLETA]'), false);
    assert.match(done.reply, /TOTAL A PAGAR/);
    assert.match(done.reply, /Pago Móvil|direcci[oó]n/i);

    const address = await say('Torre La Noria, apto 4, Las Mercedes');
    order = await db.getCommercialOrder(phone);
    assert.match(order.address, /Torre La Noria/);
    assert.equal(address.reply.includes('cuando cerremos'), false);

    const boleta = await say('Solo eso');
    assert.equal(boleta.reply.includes('[BOLETA]'), false);
    assert.match(boleta.reply, /TOTAL A PAGAR/);
    assert.match(boleta.reply, /Torre La Noria/);
    assert.equal(/ind[ií]quenos su direcci[oó]n/i.test(boleta.reply), false);
    order = await db.getCommercialOrder(phone);
    assert.equal(order.items.length, 1);
    assert.equal(Number(order.items[0].cantidad), 1);

    await db.closeDb();
  });
});
