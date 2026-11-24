import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.env.BARBARA_TEST_SETUP) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'barbara-test-'));
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  process.env.BARBARA_TEST_SETUP = '1';
  process.env.DB_PATH = path.join(dir, 'test.db');
  process.env.CATALOG_SOURCE = 'json';
  process.env.CATALOG_JSON_PATH = path.join(root, 'data', 'products.json');
  process.env.GEMINI_API_KEY = 'test-key';
  process.env.CRM_TOKEN = 'test-crm-token';
  process.env.PAGO_MOVIL_TELEFONO = '04120000000';
  process.env.PAGO_MOVIL_CEDULA = 'V00000000';
  process.env.PAGO_MOVIL_BANCO = 'Banco de Prueba';
  process.env.WHATSAPP_APP_SECRET = 'test-app-secret';
  process.env.WHATSAPP_TOKEN = 'test-token';
  process.env.WHATSAPP_PHONE_NUMBER_ID = '123456';
  process.env.WHATSAPP_VERIFY_TOKEN = 'verify-token';
  process.env.WHATSAPP_TEMPLATE_NAME = 'recontacto_barbara';
  process.env.WHATSAPP_TEMPLATE_LANG = 'es';
  process.env.CONFIDENCE_THRESHOLD = '85';
  process.env.DEBOUNCE_WINDOW_MS = '3500';
  process.env.OPERATOR_TICKETS_PERSIST = 'false';
  process.env.SPECIALIST_AUTO_RESUME_HOURS = '0';
}
