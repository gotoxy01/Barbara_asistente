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

  it('escala una cotización que no está en el catálogo', () => {
    const decision = decideEscalation({
      ...base,
      catalogType: 'none',
      catalogTerms: ['tractor'],
      confianza: 96,
      customerText: 'cuánto cuesta un tractor',
    });
    assert.equal(decision.escalate, true);
    assert.equal(decision.reason, 'Consulta fuera de catálogo');
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
