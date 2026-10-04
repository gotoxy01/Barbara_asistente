// Chat de prueba en consola: conversa con Bárbara sin necesidad de WhatsApp.
// Uso: npm run chat   (escriba "salir" para terminar, "reanudar" si el chat quedó escalado)
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { assertGeminiConfig } from '../src/config.js';
import { resumeChat } from '../src/db.js';
import { getCatalogInfo } from '../src/services/catalogService.js';
import { handleCustomerMessage } from '../src/services/chatService.js';

assertGeminiConfig();

const phone = process.env.TEST_PHONE || '580000000000';
const name = process.env.TEST_NAME || 'Cliente de Prueba';
const rl = readline.createInterface({ input, output });
const catalog = getCatalogInfo();

console.log(`Catálogo: ${catalog.count} productos (${catalog.source})`);
console.log(`Chat de prueba con Bárbara (cliente: ${name}, +${phone}). Escriba "salir" para terminar.\n`);

const printNotice = async (text) => console.log(`\n  [Aviso al asesor]\n  ${text.split('\n').join('\n  ')}\n`);

while (true) {
  const text = (await rl.question('Usted: ')).trim();
  if (!text) continue;
  if (text.toLowerCase() === 'salir') break;
  if (text.toLowerCase() === 'reanudar') {
    resumeChat(phone);
    console.log('(Bárbara reactivada)\n');
    continue;
  }

  const started = performance.now();
  const result = await handleCustomerMessage({ phone, name, text }, { notify: printNotice });
  const elapsed = ((performance.now() - started) / 1000).toFixed(1);
  if (result.error) console.error(`\n  (Error de Gemini [${result.error.kind ?? '?'} ${result.error.status ?? ''}]: ${result.error.hint ?? result.error.message})`);
  if (result.productContext) console.log(`\n  ┌ Contexto de catálogo\n  │ ${result.productContext.split('\n').join('\n  │ ')}\n  └`);
  for (const call of result.toolCalls ?? []) {
    console.log(`  ⚙ ${call.name}(${JSON.stringify(call.args)}) → ${JSON.stringify(call.result).slice(0, 160)}`);
  }
  if (result.reply) console.log(`\nBárbara (${elapsed} s${result.model ? `, ${result.model}` : ''}): ${result.reply}\n`);
  if (result.escalated) console.log('>>> [ESCALADO A HUMANO] Escriba "reanudar" para seguir probando.\n');
  else if (result.paused) console.log('(Chat pausado: un asesor lo atiende. Escriba "reanudar" para reactivar a Bárbara.)\n');
}

rl.close();
