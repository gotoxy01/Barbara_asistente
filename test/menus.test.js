import './setup.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getProducts } from '../src/services/catalogService.js';
import { reduceMenu } from '../src/services/menuFlow.js';
import {
  LIMITS,
  choiceFromText,
  mainMenu,
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
    assert.equal(page.options.at(-1).id, 'menu:page:viveres:1');
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
  });
});
