// Verifica en segundos que la clave, el modelo y la facturación de Gemini funcionan.
// Uso: npm run check
import { GoogleGenAI } from '@google/genai';
import { assertGeminiConfig, config } from '../src/config.js';
import { generateBarbaraReply } from '../src/services/aiService.js';

assertGeminiConfig();

const key = config.gemini.apiKey;
console.log(`Modelo:  ${config.gemini.model}`);
console.log(`Clave:   ${key.slice(0, 4)}… (${key.length} caracteres)`);

const ai = new GoogleGenAI({ apiKey: key });

try {
  const available = [];
  for await (const m of await ai.models.list({ config: { pageSize: 200 } })) available.push(m.name.replace('models/', ''));
  const found = available.includes(config.gemini.model);
  console.log(`\n1) Clave válida para la Gemini API: ✅`);
  console.log(`2) Modelo "${config.gemini.model}" disponible: ${found ? '✅' : '❌'}`);
  if (!found) console.log(`   Modelos flash disponibles: ${available.filter((n) => /flash/.test(n) && !/tts|image|audio|live/.test(n)).join(', ')}`);
} catch (err) {
  console.log(`\n1) Clave válida para la Gemini API: ❌\n   ${err.message.slice(0, 300)}`);
  process.exit(1);
}

try {
  const { text } = await generateBarbaraReply('Eres un asistente de prueba.', [{ role: 'user', content: 'Responde solo: OK' }]);
  console.log(`3) Generación de respuesta: ✅ ("${text}")\n\nTodo listo: Bárbara puede responder.`);
} catch (err) {
  console.log(`3) Generación de respuesta: ❌ [${err.kind ?? '?'} ${err.status ?? ''}]\n   ${err.hint ?? err.message}`);
  process.exit(1);
}
