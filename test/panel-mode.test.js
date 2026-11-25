import './setup.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertWhatsAppConfig, isPanelMode } from '../src/config.js';
import { sendText } from '../src/whatsapp.js';

describe('modo panel', () => {
  it('npm start sin token de Meta sugiere npm run panel', () => {
    const keys = [
      'WHATSAPP_TOKEN',
      'WHATSAPP_PHONE_NUMBER_ID',
      'WHATSAPP_VERIFY_TOKEN',
      'WHATSAPP_APP_SECRET',
      'WHATSAPP_TEMPLATE_NAME',
    ];
    const prev = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    for (const key of keys) delete process.env[key];
    try {
      assert.throws(() => assertWhatsAppConfig(), /WHATSAPP_TOKEN/);
      assert.throws(() => assertWhatsAppConfig(), /npm run panel/);
    } finally {
      for (const key of keys) {
        if (prev[key] == null) delete process.env[key];
        else process.env[key] = prev[key];
      }
    }
  });

  it('BARBARA_MODO=prueba no llama a la API de Meta', async () => {
    const prev = process.env.BARBARA_MODO;
    process.env.BARBARA_MODO = 'prueba';
    try {
      assert.equal(isPanelMode(), true);
      const result = await sendText('580000000000', 'hola desde el panel');
      assert.equal(result.skipped, true);
    } finally {
      if (prev == null) delete process.env.BARBARA_MODO;
      else process.env.BARBARA_MODO = prev;
    }
  });
});
