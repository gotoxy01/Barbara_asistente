import './setup.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { catalogOverviewText, searchProducts } from '../src/services/catalogService.js';
import { isGeneralCatalogAsk, isLightTurn } from '../src/services/customerText.js';
import { scopeHistoryForTurn } from '../src/services/orderService.js';
import { runToolCalls, salesCallConfig, thinkingConfigFor } from '../src/services/aiService.js';

const STALE = '❌ Harina Pan: por ahora no la tenemos disponible';

describe('preguntas generales y contexto del turno', () => {
  it('clasifica el catálogo en general y deja pasar un producto concreto', () => {
    assert.equal(isGeneralCatalogAsk('Que tienes en la venta?'), true);
    assert.equal(isGeneralCatalogAsk('¿Qué venden?'), true);
    assert.equal(isGeneralCatalogAsk('catálogo'), true);
    assert.equal(isGeneralCatalogAsk('categorías'), true);
    assert.equal(isGeneralCatalogAsk('ofertas'), true);
    assert.equal(isGeneralCatalogAsk('¿Qué tienes de harina?'), false);
    assert.equal(isLightTurn('Hola'), true);
    assert.equal(isLightTurn('Que tienes en la venta?'), true);
    assert.equal(isLightTurn('hay harina pan?'), false);
  });

  it('no busca la palabra venta ni arma un puntaje de catálogo', async () => {
    const found = await searchProducts('Que tienes en la venta?');
    assert.equal(found.terms.includes('venta'), false);
    assert.equal(found.retrievalScore ?? null, null);
    const overview = catalogOverviewText();
    assert.match(overview, /Víveres/);
    assert.match(overview, /Charcutería/);
    assert.match(overview, /Ferretería/);
    assert.match(overview, /Harina de Maíz Blanca/);
  });

  it('una conversación nueva no arrastra la respuesta vieja de la harina', () => {
    const history = [
      { role: 'user', content: 'cuanto cuesta la harina pan' },
      { role: 'model', content: STALE },
      { role: 'user', content: 'Que tienes en la venta?' },
    ];
    const fresh = scopeHistoryForTurn(history, true);
    assert.deepEqual(fresh.map((message) => message.content), ['Que tienes en la venta?']);
    assert.equal(fresh.some((message) => message.content.includes('Harina Pan')), false);
    const same = scopeHistoryForTurn(history, false);
    assert.equal(same.some((message) => message.content === STALE), true);
  });

  it('recorta el razonamiento de gemini-3.5-flash y el texto de salida', () => {
    assert.equal(thinkingConfigFor('gemini-3.5-flash').thinkingLevel, 'MINIMAL');
    assert.equal(thinkingConfigFor('gemini-2.5-flash').thinkingBudget, 0);
    const light = salesCallConfig('gemini-3.5-flash');
    assert.equal(light.maxOutputTokens, 512);
    assert.equal(light.responseMimeType, 'application/json');
    assert.equal(light.thinkingConfig.thinkingLevel, 'MINIMAL');
    const withTools = salesCallConfig('gemini-3.5-flash', { declarations: [{ name: 'get_price' }] });
    assert.equal(withTools.toolConfig.functionCallingConfig.mode, 'AUTO');
    assert.equal(withTools.responseMimeType, undefined);
  });

  it('ejecuta las herramientas de un mismo turno en paralelo', async () => {
    const started = Date.now();
    const batch = await runToolCalls(
      [{ id: 'a', name: 'get_price' }, { id: 'b', name: 'get_stock' }],
      async (name) => {
        await new Promise((resolve) => setTimeout(resolve, 80));
        return { name };
      },
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 150, `tardó ${elapsed} ms, como si fueran una detrás de otra`);
    assert.deepEqual(batch.calls.map((call) => call.name), ['get_price', 'get_stock']);
    assert.equal(batch.calls[0].response.functionResponse.id, 'a');
    assert.equal(batch.calls[1].response.functionResponse.id, 'b');
  });
});
