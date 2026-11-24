import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileUrlToPath, projectRootFromScript } from '../scripts/lib/script-path.js';
import { embedPace, requestBatchEmbeddings } from '../src/services/embeddings.js';

describe('rutas de script en Windows', () => {
  it('no duplica la unidad C: al salir de una URL file', () => {
    const url = 'file:///C:/Users/Roni/Barbara_asistente/scripts/crear-caja-demo.js';
    const file = fileUrlToPath(url, 'win32');
    assert.equal(file, 'C:\\Users\\Roni\\Barbara_asistente\\scripts\\crear-caja-demo.js');
    const root = projectRootFromScript(url, 'win32');
    assert.equal(root, 'C:\\Users\\Roni\\Barbara_asistente');
    assert.equal(root.includes('C:\\C:'), false);
  });
});

describe('embeddings por lote', () => {
  it('parte 451 productos en lotes de 100 y deja margen bajo 100 por minuto', () => {
    const pace = embedPace(451);
    assert.equal(pace.batches, 5);
    assert.equal(pace.batchSize, 100);
    assert.ok(pace.gapMs >= 600);
    assert.ok(60_000 / pace.gapMs <= 100);
  });

  it('ante un 429 reintenta el mismo lote y no aborta', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) {
        return { status: 429, headers: { get: () => '0' }, text: async () => 'quota' };
      }
      return {
        status: 200,
        headers: { get: () => null },
        json: async () => ({ embeddings: [{ values: [0.1, 0.2] }, { values: [0.3, 0.4] }] }),
      };
    };
    const vectors = await requestBatchEmbeddings(['harina pan', 'aceite vatel'], {
      fetchImpl,
      sleepFn: async () => {},
      gapMs: 0,
      apiKey: 'test',
      dimensions: 2,
      attempts: 3,
    });
    assert.equal(calls, 2);
    assert.equal(vectors.length, 2);
    assert.deepEqual(vectors[0], [0.1, 0.2]);
  });
});
