import './setup.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createDemoDatabase, summarizeDatabase } from '../scripts/crear-caja-demo.js';

describe('caja de prueba', () => {
  it('genera el esquema de la caja y el importador deja fuera lo que no se vende', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caja-demo-'));
    const file = path.join(dir, 'database.db');
    createDemoDatabase(file);
    const summary = summarizeDatabase(file);
    assert.deepEqual(summary.tables, [
      'articulos', 'charcuteria_rapida', 'limpieza_rapida', 'mascotas_rapida', 'verduras_rapidas',
    ]);
    assert.ok(summary.imported >= 400 && summary.imported <= 600, `importados ${summary.imported}`);
    assert.ok(summary.stockCero >= 5);
    assert.ok(summary.soloCodigo >= 3);
    assert.equal(summary.deliveryUsd, 1.5);

    const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const { readSourceCatalog } = await import('./src/services/catalogService.js');
      const source = readSourceCatalog();
      const names = source.products.map((product) => product.nombre);
      const byKilo = source.products.filter((product) => product.presentacion === 'por kilo');
      console.log(JSON.stringify({
        count: source.products.length,
        delivery: source.deliveryUsd,
        pan: names.some((name) => /HAR PAN BCO/i.test(name) || /PAN blanca/i.test(name)),
        juana: names.some((name) => /juana/i.test(name)),
        porKilo: byKilo.length,
        barcodeName: names.some((name) => /^\\d+$/.test(name)),
      }));
    `], {
      cwd: root,
      env: {
        ...process.env,
        CATALOG_SOURCE: 'db',
        CATALOG_DB_PATH: file,
      },
      encoding: 'utf8',
    });
    assert.equal(probe.status, 0, probe.stderr);
    const parsed = JSON.parse(probe.stdout.trim().split('\n').at(-1));
    assert.equal(parsed.count, summary.imported);
    assert.equal(parsed.delivery, 1.5);
    assert.equal(parsed.pan, true);
    assert.equal(parsed.juana, true);
    assert.ok(parsed.porKilo >= 30);
    assert.equal(parsed.barcodeName, false);
  });
});
