import './setup.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getProducts } from '../src/services/catalogService.js';
import { reduceMenu } from '../src/services/menuFlow.js';
import {
  LIMITS,
  choiceFromText,
  mainMenu,
  menuSpeech,
  parseInteractive,
  productMenu,
  quantityMenu,
  validateMenu,
} from '../src/menus.js';

const products = getProducts().filter((product) => product.categoria !== 'politica');
const rate = 40;

function walk(start, steps) {
  let session = start;
  let order = { items: [], address: null, fulfillment: null };
  const seen = [];
  for (const input of steps) {
    const step = reduceMenu(session, input, { products, rate, order, savedAddress: order.address });
    assert.ok(step?.handled, `no entendió ${input}`);
    assert.equal(validateMenu(step.menu || { kind: 'buttons', options: [{ id: 'x', title: 'ok' }] }).length >= 0, true);
    if (step.menu) assert.deepEqual(validateMenu(step.menu), []);
    session = step.session;
    order = step.order;
    seen.push(step);
  }
  return { session, order, seen };
}

describe('menús de WhatsApp', () => {
  it('lee el id del botón y de la lista', () => {
    assert.equal(parseInteractive({ interactive: { button_reply: { id: 'menu:todo', title: 'Es todo' } } }).id, 'menu:todo');
    assert.equal(parseInteractive({ interactive: { list_reply: { id: 'menu:sku:harina', title: 'Harina' } } }).id, 'menu:sku:harina');
    assert.equal(parseInteractive({ type: 'text', text: { body: 'hola' } }), null);
  });

  it('el número corresponde a la última opción mostrada', () => {
    const menu = mainMenu();
    assert.equal(choiceFromText('1', menu), 'menu:productos');
    assert.equal(choiceFromText('4', menu), 'menu:asesor');
    assert.equal(choiceFromText('9', menu), null);
    assert.equal(choiceFromText('quiero harina', menu), null);
  });

  it('los textos caben en los límites de Meta', () => {
    assert.deepEqual(validateMenu(mainMenu()), []);
    assert.deepEqual(validateMenu(quantityMenu('Harina PAN')), []);
    const many = Array.from({ length: 12 }, (_, index) => ({
      sku: `sku-${index}`,
      nombre: `Producto con un nombre bastante largo número ${index}`,
      presentacion: '1 kg',
      precio: 1,
      categoria: 'Víveres',
    }));
    const page = productMenu(many, 'Víveres', 0, rate);
    assert.equal(page.options.length, LIMITS.maxRows);
    assert.ok(page.options.some((row) => row.id === 'menu:page:viveres:1'));
    assert.ok(page.options.some((row) => row.id === 'menu:todo'));
    assert.equal(page.options.at(-1).id, 'menu:back');
    assert.deepEqual(validateMenu(page), []);
    assert.ok(page.options[0].title.length <= LIMITS.listTitle);
    assert.ok(page.options[0].description.length <= LIMITS.listDescription);
  });

  it('el recorrido completo no llama al modelo', () => {
    const blanca = products.find((product) => /blanca/i.test(product.nombre));
    const { order, seen } = walk({ menu: mainMenu(), awaiting: null, sku: null }, [
      '1',
      'menu:cat:harinas',
      `menu:sku:${blanca.sku}`,
      '2',
      '3',
      '1',
      'Torre La Noria, apto 4, Las Mercedes',
      '1',
      '12345678',
    ]);
    assert.equal(order.items.length, 1);
    assert.equal(order.items[0].cantidad, 2);
    assert.match(order.items[0].nombre, /blanca/i);
    assert.match(order.address, /Torre La Noria/);
    assert.equal(order.payment_reference, '12345678');
    assert.match(seen[6].text, /TOTAL A PAGAR/);
    assert.match(seen[6].text, /Torre La Noria/);
    assert.equal(seen.some((step) => step.text.includes('[BOLETA]')), false);
    assert.equal(seen.filter((step) => step.text.includes('¿Cómo lo entregamos?')).length, 1);
  });

  it('pedir busca por nombre, mi pedido no cobra antes de la boleta, y modificar reemplaza', () => {
    const opened = reduceMenu({ menu: mainMenu(), awaiting: null }, 'menu:pedido', { products, rate, order: { items: [] } });
    assert.match(opened.text, /víveres/i);
    assert.match(opened.text, /varios a la vez/i);
    assert.equal(opened.session.awaiting, 'buscar');
    assert.equal(opened.menu.options.some((row) => String(row.id).startsWith('menu:page')), false);
    assert.equal(opened.menu.options.some((row) => String(row.id).startsWith('menu:cat')), false);
    assert.equal((opened.text.match(/Puede escribir varios/gi) || []).length, 1);

    const draft = { items: [{ sku: 'arroz', nombre: 'Arroz', presentacion: '1 kg', precio: 1.9, cantidad: 1 }], lifecycle: 'borrador', address: null };
    const mine = reduceMenu({ menu: mainMenu(), awaiting: null }, 'menu:mipedido', { products, rate, order: draft });
    assert.equal(mine.menu.options.some((row) => row.id === 'menu:pague'), false);
    assert.ok(mine.menu.options.some((row) => row.id === 'menu:pedido'));
    assert.ok(mine.menu.options.some((row) => row.title.includes('Volver')));
    const tooSoon = reduceMenu(mine.session, 'menu:pague', { products, rate, order: mine.order });
    assert.notEqual(tooSoon.session.awaiting, 'referencia');

    const closed = reduceMenu({ menu: mainMenu(), awaiting: null }, 'menu:retiro', { products, rate, order: draft });
    assert.equal(closed.order.lifecycle, 'boleta_enviada');
    assert.ok(closed.menu.options.some((row) => row.id === 'menu:pague'));
    const speech = menuSpeech(closed.text);
    assert.equal(speech.includes('[menu:'), false);
    assert.equal(speech.includes('Responda con el número'), false);
    const paid = reduceMenu(closed.session, '1', { products, rate, order: closed.order });
    assert.equal(paid.session.awaiting, 'referencia');
    assert.match(paid.text, /referencia/i);

    const several = reduceMenu({ awaiting: 'buscar', menu: null }, 'aceite, azúcar', { products, rate, order: { items: [] } });
    assert.equal(several.order.items.length, 2);
    assert.match(several.text, /Aceite/);
    assert.match(several.text, /Azúcar/);
    assert.equal((several.text.match(/¿Busca otra cosa o ya es todo\?/g) || []).length, 1);

    const missing = reduceMenu({ awaiting: 'buscar', menu: null }, 'qqqqzzzz-no-existe', { products, rate, order: { items: [] } });
    assert.match(missing.text, /verificando si lo tenemos/i);
    assert.ok(missing.stockCheck?.length);

    const harina = { sku: 'harina-ama', nombre: 'Harina PAN amarilla', presentacion: '1 kg', precio: 1.8, categoria: 'Víveres' };
    let order = { items: [{ ...harina, cantidad: 1 }], address: null };
    const edit = reduceMenu({ menu: boletaMenuSafe(), awaiting: null, mode: 'add' }, 'menu:modificar', { products: [harina], rate, order });
    const changed = reduceMenu(edit.session, 'menu:edit:0', { products: [harina], rate, order: edit.order });
    const replaced = reduceMenu(changed.session, 'menu:qty:1', { products: [harina], rate, order: changed.order });
    assert.equal(replaced.order.items.length, 1);
    assert.equal(replaced.order.items[0].cantidad, 1);
    assert.match(replaced.text, /ahora lleva 1/);

    const summed = reduceMenu({ ...replaced.session, mode: 'add', sku: harina.sku }, 'menu:qty:1', { products: [harina], rate, order: replaced.order });
    assert.equal(summed.order.items[0].cantidad, 2);
    assert.match(summed.text, /Ya tenía 1, ahora lleva 2/);
  });
});

function boletaMenuSafe() {
  return { kind: 'buttons', body: 'boleta', options: [{ id: 'menu:modificar', title: 'Modificar pedido' }] };
}
