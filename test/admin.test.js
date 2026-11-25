import './setup.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { estimateCost, monthRange, usageCsv } from '../src/services/usage.js';

describe('costos del panel', () => {
  it('cobra el servicio después de 1000 y el modelo por millón de tokens', () => {
    const cost = estimateCost({
      outboundBot: 1004,
      outboundSeller: 6,
      template: 2,
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    }, {
      serviceFree: 1000,
      serviceUsd: 0.0113,
      marketingUsd: 0.074,
      inputPerMillion: 0.30,
      outputPerMillion: 2.50,
    });
    assert.equal(cost.billableService, 10);
    assert.equal(cost.whatsapp, Math.round((10 * 0.0113 + 2 * 0.074) * 1e6) / 1e6);
    assert.equal(cost.gemini, 2.8);
    assert.equal(cost.total, Math.round((cost.whatsapp + cost.gemini) * 1e6) / 1e6);
  });

  it('el mes de Caracas empieza a las 04:00 UTC', () => {
    const range = monthRange('2026-11', 'America/Caracas');
    assert.equal(new Date(range.start).toISOString(), '2026-11-01T04:00:00.000Z');
    assert.equal(new Date(range.end).toISOString(), '2026-12-01T04:00:00.000Z');
  });

  it('el CSV trae el total', () => {
    const csv = usageCsv({
      clients: [{
        phone: '580000000001', inbound: 1, outboundBot: 1, outboundSeller: 0, template: 0,
        geminiCalls: 0, inputTokens: 0, outputTokens: 0, embeddingCalls: 0,
        cost: { total: 0 },
      }],
      totals: {
        inbound: 1, outboundBot: 1, outboundSeller: 0, template: 0,
        geminiCalls: 0, inputTokens: 0, outputTokens: 0, embeddingCalls: 0,
        cost: { total: 0 },
      },
    });
    assert.match(csv, /^telefono,/);
    assert.match(csv, /TOTAL,1,1/);
  });
});

const skip = !process.env.DATABASE_URL;

describe('panel: simulador y uso', { skip }, () => {
  it('un saludo de prueba devuelve el menú y no cuenta como uso', async () => {
    const db = await import('../src/db.js');
    const { recordUsage, usageReport } = await import('../src/services/usage.js');
    const { createCrmApp } = await import('../src/crm/server.js');
    await db.initDb();
    const phone = `5811${Date.now().toString().slice(-8)}`;
    const app = createCrmApp();
    const server = await new Promise((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    try {
      const turn = await fetch(`${base}/api/simulator/turn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, name: 'Prueba panel', text: 'hola' }),
      });
      const body = await turn.json();
      assert.equal(turn.status, 200);
      assert.equal(body.prueba, true);
      assert.ok(body.menu?.options?.length);
      assert.match(body.reply, /1\./);

      await recordUsage({ phone, kind: 'outbound_bot', calls: 3 });
      const month = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Caracas', year: 'numeric', month: '2-digit' }).format(new Date());
      const report = await usageReport(month);
      const row = report.clients.find((item) => item.phone === phone);
      assert.equal(row.outboundBot, 3);
      assert.equal(row.inbound, 0);

      const listed = await fetch(`${base}/api/usage?month=${month}`);
      assert.equal(listed.status, 200);
      const products = await fetch(`${base}/api/products?q=harina`);
      const catalog = await products.json();
      assert.ok(catalog.products.some((product) => /harina/i.test(product.nombre)));
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await db.closeDb();
    }
  });
});
