import './setup.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decideEscalation } from '../src/services/escalationPolicy.js';
import { buildSystemPrompt } from '../src/services/aiService.js';
import {
  isOperationalTurn,
  isProtectedFromExpiry,
  logisticsNotice,
  parseLocation,
  parsePaymentReport,
  reduceOrder,
  renderProfileSummary,
} from '../src/services/orderLifecycle.js';

const item = { sku: 'harina-pan', nombre: 'Harina PAN blanca', cantidad: 2, precio: 1.8 };

function book() {
  const orders = new Map();
  const ledger = [];
  let seq = 1;
  return {
    orders,
    ledger,
    apply(phone, action) {
      const current = [...orders.values()].reverse().find((order) => order.phone === phone && !['cancelado', 'entregado'].includes(order.lifecycle)) || null;
      const reduced = reduceOrder(action.orderId ? orders.get(action.orderId) : current, { ...action, phone });
      if (reduced.error) return reduced;
      if (!reduced.order.id) reduced.order.id = seq++;
      if (reduced.ledger) {
        const dup = ledger.some((row) => row.order_id === reduced.order.id && row.action === reduced.ledger.action);
        if (dup) reduced.ledger = null;
        else ledger.push({ order_id: reduced.order.id, ...reduced.ledger });
      }
      orders.set(reduced.order.id, structuredClone(reduced.order));
      return reduced;
    },
    reload() {
      return [...orders.values()];
    },
  };
}

describe('pedido durable, pago y memoria', () => {
  it('una dirección no se escala por el puntaje del catálogo', () => {
    assert.equal(isOperationalTurn('Torre La Noria, Las Mercedes'), true);
    assert.equal(isOperationalTurn('pagué referencia 12345678'), true);
    assert.equal(isOperationalTurn('/ubicacion 10.48,-66.90'), true);
    const decision = decideEscalation({
      confianza: 90,
      retrievalScore: 0.25,
      catalogType: 'none',
      catalogTerms: ['torre', 'noria', 'mercedes'],
      customerText: 'Torre La Noria, Las Mercedes',
      threshold: 85,
    });
    assert.equal(decision.escalate, false);
  });

  it('al reiniciar, el pedido sigue; el pago reportado no descuenta; verificar descuenta una vez; cancelar devuelve', () => {
    const store = book();
    const phone = '580000000001';
    let step = store.apply(phone, { type: 'add_item', item });
    const id = step.order.id;
    assert.equal(store.reload().some((order) => order.id === id && order.lifecycle === 'borrador'), true);
    step = store.apply(phone, { type: 'boleta', totals: { totalUsd: 3.6, totalBs: 144, rate: 40 } });
    step = store.apply(phone, { type: 'report_payment', reference: '12345678', mediaId: 'media-1' });
    assert.equal(step.order.lifecycle, 'pago_reportado');
    assert.equal(step.ledger, null);
    assert.equal(store.ledger.length, 0);
    assert.equal(isProtectedFromExpiry(step.order), true);
    step = store.apply(phone, { type: 'save_address', address: 'Torre La Noria, apto 4, Las Mercedes', name: 'María' });
    assert.equal(step.logistics, true);
    assert.match(step.notice, /El cliente María pagó el pedido #/);
    assert.match(logisticsNotice(step.order, 'María'), /referencia 12345678/);
    const verified = store.apply(phone, { type: 'verify_payment', orderId: id, actor: 'operador' });
    const second = store.apply(phone, { type: 'verify_payment', orderId: id, actor: 'operador' });
    assert.equal(store.ledger.filter((row) => row.action === 'deduct').length, 1);
    assert.equal(second.ledger, null);
    assert.match(verified.customerReply, /confirmó/);
    const canceled = store.apply(phone, { type: 'cancel', orderId: id });
    assert.equal(canceled.order.lifecycle, 'cancelado');
    assert.equal(store.ledger.filter((row) => row.action === 'restore').length, 1);
  });

  it('la ubicación más el pago avisan al vendedor y el perfil vuelve en el contexto', () => {
    const store = book();
    const phone = '580000000002';
    let step = store.apply(phone, { type: 'add_item', item });
    step = store.apply(phone, { type: 'boleta', totals: { totalUsd: 3.6, totalBs: 144, rate: 40 } });
    step = store.apply(phone, { type: 'report_payment', reference: '998877' });
    const loc = parseLocation('/ubicacion 10.4806,-66.9036');
    step = store.apply(phone, { type: 'save_location', ...loc, name: 'María Pérez' });
    assert.equal(step.logistics, true);
    assert.match(step.notice, /envió la ubicación/);
    const payment = parsePaymentReport('pagué referencia 998877');
    assert.equal(payment.reference, '998877');
    const summary = renderProfileSummary(
      { display_name: 'María Pérez', addresses: [{ text: 'Torre La Noria, apto 4' }], fulfillment: 'delivery' },
      [step.order],
    );
    assert.match(summary, /María Pérez/);
    assert.match(summary, /Harina PAN blanca/);
    assert.match(summary, /Torre La Noria/);
    const prompt = buildSystemPrompt({
      name: 'María Pérez',
      phone,
      productContext: 'sin búsqueda',
      customerProfile: summary,
    });
    assert.match(prompt, /última compra: 2 Harina PAN blanca/);
    assert.match(prompt, /Lo mismo de la vez pasada/);
  });
});
