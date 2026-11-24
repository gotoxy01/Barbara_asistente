import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { shouldOpenPaymentTicket } from '../src/services/paymentIntent.js';

describe('fotos y comprobantes', () => {
  it('una foto de producto no abre ticket de pago', () => {
    assert.equal(shouldOpenPaymentTicket({
      text: '[El cliente adjuntó una imagen]',
      history: [{ role: 'user', content: 'tienen harina pan?' }],
      order: null,
    }), false);
  });

  it('abre ticket si el texto o el pedido hablan de un pago', () => {
    assert.equal(shouldOpenPaymentTicket({
      text: '[El cliente adjuntó una imagen con el texto: "comprobante"]',
    }), true);
    assert.equal(shouldOpenPaymentTicket({
      text: '[El cliente adjuntó una imagen]',
      history: [{ role: 'model', content: '📲 Datos para Pago Móvil' }],
      order: { status: 'boleta' },
    }), true);
  });
});