import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  explainPgError,
  isBlank,
  missingSettings,
  parsePostgresUrl,
  quoteLiteral,
} from '../scripts/lib/settings.js';

describe('archivo .env', () => {
  it('detecta huecos y textos de ejemplo', () => {
    assert.equal(isBlank(''), true);
    assert.equal(isBlank('CAMBIE_ESTA_CLAVE'), true);
    assert.equal(isBlank('postgresql://barbara:CAMBIE_ESTA_CLAVE@127.0.0.1:5432/barbara'), true);
    assert.equal(isBlank('una-clave-real'), false);
    const missing = missingSettings({
      WHATSAPP_TOKEN: 'tok',
      DATABASE_URL: 'postgresql://barbara:CAMBIE_ESTA_CLAVE@127.0.0.1:5432/barbara',
    });
    assert.ok(missing.some((item) => item.name === 'DATABASE_URL'));
    assert.ok(missing.some((item) => item.name === 'GEMINI_API_KEY'));
    assert.equal(missing.some((item) => item.name === 'WHATSAPP_TOKEN'), false);
  });

  it('lee usuario, clave y base de la dirección', () => {
    const parsed = parsePostgresUrl('postgresql://barbara:cla%20ve@127.0.0.1:5432/barbara');
    assert.equal(parsed.user, 'barbara');
    assert.equal(parsed.password, 'cla ve');
    assert.equal(parsed.database, 'barbara');
    assert.equal(parsed.port, '5432');
  });

  it('explica en español si Postgres está apagado, la clave falla o falta pgvector', () => {
    assert.match(explainPgError({ code: 'ECONNREFUSED' }), /no está instalado o no está encendido/i);
    assert.match(explainPgError({ code: '28P01', message: 'password authentication failed' }), /contraseña/i);
    assert.match(explainPgError({ message: 'could not open extension control file "vector"' }), /pgvector/i);
    assert.equal(quoteLiteral("o'hara"), "'o''hara'");
  });
});
