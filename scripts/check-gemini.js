// Verifica que la clave genere texto de verdad. Listar modelos no alcanza:
// un modelo puede aparecer en la lista y fallar al usarlo (404 o 503).
// Uso: npm run check
import { assertGeminiConfig, config } from '../src/config.js';
import { generateBarbaraReply } from '../src/services/aiService.js';

assertGeminiConfig();

const key = config.gemini.apiKey;
console.log(`Modelo principal: ${config.gemini.model}`);
console.log(`Respaldo:         ${config.gemini.fallbackModel || '(ninguno)'}`);
console.log(`Clave:            ${key.slice(0, 4)}… (${key.length} caracteres)`);
console.log('\nLlamando a generateContent (si el principal falla, se prueba el respaldo)...');

try {
  const result = await generateBarbaraReply(
    'Responde solo el JSON de ventas. respuesta_cliente debe ser exactamente OK. confianza_porcentaje 100. requiere_especialista false. producto_identificado null. sku null. motivo_escalado null.',
    [{ role: 'user', content: 'hola' }],
  );
  const used = result.model || config.gemini.model;
  console.log(`\nGeneración: OK con "${used}" ("${result.text}")`);
  if (used !== config.gemini.model) {
    console.log(`El principal "${config.gemini.model}" no respondió. El que funcionó fue "${used}".`);
    console.log('Puede dejar GEMINI_MODEL con ese nombre en .env.');
  }
  console.log('\nTodo listo: Bárbara puede responder.');
} catch (err) {
  console.log(`\nGeneración: FALLÓ [${err.kind ?? '?'} ${err.status ?? ''}]`);
  console.log(err.hint ?? err.message);
  process.exit(1);
}
