import './setup.js';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertWhatsAppConfig } from '../src/config.js';
import { verifyHubSignature } from '../src/whatsapp.js';

const secret = 'test-app-secret';
const body = Buffer.from('{"hello":1}');

function sign(buf, key = secret) {
  return `sha256=${crypto.createHmac('sha256', key).update(buf).digest('hex')}`;
}

describe('firma del webhook', () => {
  it('acepta el HMAC correcto del cuerpo crudo', () => {
    assert.equal(verifyHubSignature(body, sign(body), secret), true);
  });

  it('rechaza firma inválida, ausente, de otro largo o sin secreto', () => {
    assert.equal(verifyHubSignature(body, sign(body, 'otra-clave'), secret), false);
    assert.equal(verifyHubSignature(body, undefined, secret), false);
    assert.equal(verifyHubSignature(body, 'sha256=abc', secret), false);
    assert.equal(verifyHubSignature(body, sign(body), ''), false);
    assert.equal(verifyHubSignature(null, sign(body), secret), false);
  });

  it('el arranque Cloud exige WHATSAPP_APP_SECRET', () => {
    const prev = process.env.WHATSAPP_APP_SECRET;
    delete process.env.WHATSAPP_APP_SECRET;
    try {
      assert.throws(() => assertWhatsAppConfig(), /WHATSAPP_APP_SECRET/);
    } finally {
      process.env.WHATSAPP_APP_SECRET = prev;
    }
  });
});
