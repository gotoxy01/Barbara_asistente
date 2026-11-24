// Revisa que la PC pueda atender: Node, .env, Gemini, Postgres y Meta.
// Uso: npm run doctor
import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import pg from 'pg';
import { explainPgError, isBlank, missingSettings } from './lib/settings.js';

const lines = [];
let failed = 0;

function mark(ok, label, detail = '') {
  lines.push(`${ok ? 'OK   ' : 'FALTA'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
}

function nodeOk() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const good = major > 22 || (major === 22 && minor >= 13);
  mark(good, 'Node.js', good ? process.versions.node : `${process.versions.node} (instale Node.js 22 o más nuevo)`);
}

function envOk() {
  const missing = missingSettings(process.env);
  if (!missing.length) {
    mark(true, 'Archivo .env', 'los datos obligatorios están completos');
    if (isBlank(process.env.ADVISOR_PHONE)) {
      lines.push('AVISO  ADVISOR_PHONE está vacío: los avisos quedan en el panel.');
    }
    return;
  }
  mark(false, 'Archivo .env', missing.map((item) => item.name).join(', '));
}

async function geminiOk() {
  if (isBlank(process.env.GEMINI_API_KEY)) {
    mark(false, 'Clave de Gemini', 'complétela en .env');
    return;
  }
  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const timer = setTimeout(() => {}, 1);
    clearTimeout(timer);
    await Promise.race([
      ai.models.list({ config: { pageSize: 1 } }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('tiempo agotado')), 20000)),
    ]);
    mark(true, 'Clave de Gemini', 'Google aceptó la clave');
  } catch (err) {
    const text = String(err?.message || err);
    const hint = /API key|401|403|PERMISSION/i.test(text)
      ? 'la clave no sirve. Cree otra en aistudio.google.com/apikey'
      : 'no se pudo hablar con Google. Revise el internet.';
    mark(false, 'Clave de Gemini', hint);
  }
}

async function postgresOk() {
  if (isBlank(process.env.DATABASE_URL)) {
    mark(false, 'PostgreSQL', 'falta DATABASE_URL');
    mark(false, 'pgvector', 'primero tiene que existir la base');
    return;
  }
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 8000 });
  try {
    await client.connect();
    await client.query('SELECT 1');
    mark(true, 'PostgreSQL', 'la base de la tienda responde');
    const ext = await client.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
    mark(Boolean(ext.rowCount), 'pgvector', ext.rowCount ? 'activo' : 'falta. Instálelo y corra npm run setup');
  } catch (err) {
    mark(false, 'PostgreSQL', explainPgError(err));
    mark(false, 'pgvector', 'no se pudo revisar');
  } finally {
    await client.end().catch(() => {});
  }
}

async function metaOk() {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const version = process.env.WHATSAPP_API_VERSION || 'v26.0';
  if (isBlank(token) || isBlank(phoneId)) {
    mark(false, 'WhatsApp de Meta', 'faltan el token o el Phone number ID');
    return;
  }
  try {
    const response = await fetch(`https://graph.facebook.com/${version}/${phoneId}?fields=display_phone_number,verified_name`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const code = data?.error?.code;
      const hint = code === 190
        ? 'el token venció. Use un token permanente de usuario de sistema'
        : 'el token o el Phone number ID no coinciden con la app de Meta';
      mark(false, 'WhatsApp de Meta', hint);
      return;
    }
    const name = data.verified_name || 'número reconocido';
    const shown = data.display_phone_number ? ` (${data.display_phone_number})` : '';
    mark(true, 'WhatsApp de Meta', `${name}${shown}`);
  } catch {
    mark(false, 'WhatsApp de Meta', 'no hay internet o Meta no respondió');
  }
}

nodeOk();
envOk();
await geminiOk();
await postgresOk();
await metaOk();

console.log('');
console.log('Revisión de Bárbara');
console.log('--------------------');
for (const line of lines) console.log(line);
console.log('');
if (failed) {
  console.log(`${failed} punto(s) por corregir. Edite .env y, si la base no existe, ejecute npm run setup.`);
  process.exit(1);
}
console.log('Todo en orden. Puede ejecutar npm start.');
