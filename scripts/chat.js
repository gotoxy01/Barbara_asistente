// Chat de prueba en consola: conversa con Bárbara sin necesidad de WhatsApp.
// Uso: npm run chat
//      npm run chat -- --nuevo   (borra el hilo del cliente de prueba antes de empezar)
// Escriba "salir" para terminar, "borrar" para limpiar el hilo, "reanudar" o "#reanudar" si quedó escalado.
import dotenv from 'dotenv';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

dotenv.config();
process.env.LOG_VERBOSE = '1';

if (!process.env.PAGO_MOVIL_TELEFONO || !process.env.PAGO_MOVIL_CEDULA || !process.env.PAGO_MOVIL_BANCO) {
  process.env.PAGO_MOVIL_TELEFONO ||= '04120000000';
  process.env.PAGO_MOVIL_CEDULA ||= 'V00000000';
  process.env.PAGO_MOVIL_BANCO ||= 'Banco de prueba';
  console.warn('Aviso: pago móvil de prueba. Complete PAGO_MOVIL_TELEFONO, PAGO_MOVIL_CEDULA y PAGO_MOVIL_BANCO en .env antes de atender clientes.\n');
}

const { assertDatabaseConfig, assertGeminiConfig } = await import('../src/config.js');
const { addMessage, clearCustomerThread, initDb, resumeChat } = await import('../src/db.js');
const { syncCatalog } = await import('../src/services/productSync.js');
const { getCatalogInfo } = await import('../src/services/catalogService.js');
const { finalizeHandoff, handleCustomerMessage } = await import('../src/services/chatService.js');

assertGeminiConfig();
assertDatabaseConfig();
await initDb();
await syncCatalog();

const phone = process.env.TEST_PHONE || '580000000000';
const name = process.env.TEST_NAME || 'Cliente de Prueba';
const rl = readline.createInterface({ input, output });
const catalog = getCatalogInfo();

console.log(`Catálogo: ${catalog.count} productos (${catalog.source})`);
console.log('Chat de prueba con Bárbara (cliente: ' + name + ', +' + phone + ').');
console.log('Sin la espera de 3,5 s de WhatsApp: aquí cada mensaje se responde al momento.');
console.log('Escriba "salir" para terminar, "borrar" para limpiar el hilo, o "reanudar" / "#reanudar" si quedó con el especialista.\n');

if (process.argv.includes('--nuevo')) {
  const removed = await clearCustomerThread(phone);
  console.log(`Conversación de prueba borrada (${removed} mensajes). Empieza limpia.\n`);
}

function formatTimings(timings) {
  if (!timings?.length) return '';
  return timings.map((item) => (item.skipped ? `${item.step} omitido` : `${item.step} ${item.ms} ms`)).join(', ');
}

const printNotice = async (text) => console.log(`\n  [Aviso al asesor]\n  ${text.split('\n').join('\n  ')}\n`);

while (true) {
  const text = (await rl.question('Usted: ')).trim();
  if (!text) continue;
  const command = text.replace(/^#/, '').toLowerCase();
  if (command === 'salir') break;
  if (command === 'borrar' || command === 'nuevo') {
    const removed = await clearCustomerThread(phone);
    console.log(`Listo: se borraron ${removed} mensajes de +${phone}. La próxima pregunta no ve el historial anterior.\n`);
    continue;
  }
  if (command === 'reanudar') {
    await resumeChat(phone);
    console.log('(Bárbara reactivada. Escriba "reanudar" o "#reanudar" si vuelve a quedar en pausa.)\n');
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
  const steps = formatTimings(result.timings);
  if (steps) console.log(`  Tiempos: ${steps}`);
  if (result.reply) {
    console.log(`\nBárbara (${elapsed} s${result.model ? `, ${result.model}` : ''}): ${result.reply}\n`);
    await addMessage(phone, 'model', result.historyText || result.reply);
  }
  if (result.escalated && result.handoff) {
    await finalizeHandoff({ phone, name, handoff: result.handoff, notify: printNotice });
    console.log('>>> [ESPECIALISTA] Escriba "reanudar" o "#reanudar" para seguir probando.\n');
  } else if (result.paused) console.log('(Chat pausado: un asesor lo atiende. Escriba "reanudar" o "#reanudar" para reactivar a Bárbara.)\n');
}

rl.close();
