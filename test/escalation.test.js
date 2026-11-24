import './setup.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decideEscalation, replyForEscalation } from '../src/services/escalationPolicy.js';
import { parseSalesJson } from '../src/services/aiService.js';

const base = {
  catalogType: 'matches',
  catalogTerms: ['harina'],
  threshold: 85,
  cartCommitted: false,
};

describe('umbral de confianza y escalado', () => {
  it('escala en 85 y no en 86 cuando el dato está en catálogo', () => {
    const low = decideEscalation({ ...base, confianza: 85, customerText: 'hay harina?' });
    const ok = decideEscalation({ ...base, confianza: 86, customerText: 'hay harina?' });
    assert.equal(low.escalate, true);
    assert.match(low.reason, /85/);
    assert.equal(ok.escalate, false);
  });

  it('escala si pide una persona, se queja o quiere al mayor, aunque la confianza sea alta', () => {
    assert.equal(decideEscalation({ ...base, confianza: 99, customerText: 'quiero hablar con un asesor' }).escalate, true);
    assert.equal(decideEscalation({ ...base, confianza: 99, customerText: 'tengo un reclamo del pedido' }).escalate, true);
    assert.equal(decideEscalation({ ...base, confianza: 99, customerText: 'cotización al mayor de harina' }).reason, 'Cotización al mayor');
  });

  it('un producto que no está en el catálogo no pausa el chat: se verifica con el vendedor', () => {
    const decision = decideEscalation({
      ...base,
      catalogType: 'none',
      catalogTerms: ['tractor'],
      confianza: 26,
      requiereEspecialista: true,
      motivoEscalado: 'Consulta fuera de catálogo',
      customerText: 'cuánto cuesta un tractor',
    });
    assert.equal(decision.escalate, false);
  });

  it('un saludo sin producto no se escala si la confianza es alta', () => {
    const decision = decideEscalation({
      confianza: 100,
      customerText: 'hola',
      catalogType: 'none',
      catalogTerms: [],
      threshold: 85,
    });
    assert.equal(decision.escalate, false);
  });

  it('escala si la búsqueda híbrida queda por debajo del umbral', () => {
    const decision = decideEscalation({
      ...base,
      confianza: 99,
      retrievalScore: 0.4,
      customerText: 'hay harina?',
    });
    assert.equal(decision.escalate, true);
    assert.match(decision.reason, /búsqueda/);
  });

  it('“qué productos tienen para la venta” no se escala aunque el modelo pida especialista', () => {
    const decision = decideEscalation({
      ...base,
      confianza: 26,
      retrievalScore: 0.26,
      catalogType: 'none',
      catalogTerms: ['productos', 'venta'],
      requiereEspecialista: true,
      motivoEscalado: 'Consulta fuera de catálogo',
      customerText: 'Que productos tienen para la venta?',
    });
    assert.equal(decision.escalate, false);
  });

  it('una pregunta general del catálogo no se escala aunque la búsqueda de "venta" haya sido floja', () => {
    const decision = decideEscalation({
      ...base,
      confianza: 25,
      retrievalScore: 0.25,
      catalogTerms: ['venta'],
      catalogType: 'none',
      requiereEspecialista: true,
      motivoEscalado: 'La búsqueda del catálogo quedó en 25%, por debajo del 85%',
      customerText: 'Que tienes en la venta?',
    });
    assert.equal(decision.escalate, false);
  });

  it('un saludo no se escala aunque la búsqueda anterior haya sido floja', () => {
    const decision = decideEscalation({
      ...base,
      confianza: 90,
      retrievalScore: 0.1,
      catalogTerms: ['reanudar'],
      customerText: 'Hola',
    });
    assert.equal(decision.escalate, false);
  });

  it('no pisa una boleta ya calculada por el sistema', () => {
    const decision = decideEscalation({ ...base, confianza: 10, cartCommitted: true, customerText: 'es todo' });
    assert.equal(decision.escalate, false);
  });

  it('al escalar no reenvía un texto con precios', () => {
    assert.match(replyForEscalation('La harina sale en Bs. 40'), /asesor/);
    assert.equal(replyForEscalation('Enseguida lo revisa alguien del equipo.'), 'Enseguida lo revisa alguien del equipo.');
  });

  it('lee el JSON de ventas del modelo', () => {
    const parsed = parseSalesJson(`\`\`\`json
{"producto_identificado":"Harina PAN","sku":null,"confianza_porcentaje":92,"requiere_especialista":false,"motivo_escalado":null,"respuesta_cliente":"Sí, hay harina."}
\`\`\``);
    assert.equal(parsed.producto_identificado, 'Harina PAN');
    assert.equal(parsed.confianza_porcentaje, 92);
    assert.equal(parsed.respuesta_cliente, 'Sí, hay harina.');
    assert.equal(parsed.requiere_especialista, false);
  });
});
