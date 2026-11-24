// Prepara la PC: crea .env, lo abre, revisa los datos y crea la base.
// Uso: npm run setup
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { fillDatabaseSecrets, isBlank, missingSettings, parsePostgresUrl } from './lib/settings.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env');
const examplePath = path.join(root, '.env.example');

function openEnvFile() {
  if (process.argv.includes('--no-edit') || process.env.BARBARA_SETUP_NO_EDIT === '1') return;
  console.log('Se abre .env. Complete los datos, guarde y cierre el editor para continuar.');
  const editor = process.env.EDITOR;
  if (editor) {
    spawnSync(editor, [envPath], { stdio: 'inherit' });
    return;
  }
  if (process.platform === 'win32') {
    spawnSync('notepad', [envPath], { stdio: 'inherit' });
    return;
  }
  if (!process.stdout.isTTY) {
    console.log(`Edite ${envPath} y vuelva a ejecutar npm run setup.`);
    return;
  }
  const nano = spawnSync('nano', [envPath], { stdio: 'inherit' });
  if (nano.error) console.log(`Abra ${envPath} con el Bloc de notas, guárdelo y vuelva a ejecutar npm run setup.`);
}

if (!fs.existsSync(examplePath)) {
  console.error('No está .env.example. Vuelva a descargar el programa.');
  process.exit(1);
}

if (!fs.existsSync(envPath)) {
  fs.copyFileSync(examplePath, envPath);
  console.log('Se creó .env. Ahí van todos los datos de la tienda.');
} else {
  console.log('Ya existe .env. Puede corregir los datos ahora.');
}

function askHidden(question) {
  if (process.argv.includes('--no-edit') || process.env.BARBARA_SETUP_NO_EDIT === '1' || !process.stdin.isTTY) {
    return Promise.resolve('');
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(String(answer || '').trim());
    });
    rl._writeToOutput = function writeHidden(stringToWrite) {
      if (stringToWrite.includes('\n') || stringToWrite.includes('\r')) rl.output.write(stringToWrite);
      else rl.output.write('*');
    };
  });
}

function hostFrom(url) {
  try {
    const parsed = parsePostgresUrl(url);
    return { host: parsed.host, port: parsed.port };
  } catch {
    return { host: '127.0.0.1', port: '5432' };
  }
}

let envText = fs.readFileSync(envPath, 'utf8');
dotenv.config({ path: envPath, override: true });

const dbPassword = isBlank(process.env.DATABASE_URL) ? crypto.randomBytes(18).toString('base64url') : '';
const crmToken = isBlank(process.env.CRM_TOKEN) ? crypto.randomBytes(18).toString('base64url') : '';
let adminPassword = '';
if (isBlank(process.env.POSTGRES_ADMIN_URL)) {
  adminPassword = await askHidden('Clave del usuario postgres (la que eligió al instalar PostgreSQL): ');
  if (!adminPassword) {
    console.error('Sin la clave de PostgreSQL no puedo crear la base. Ejecute de nuevo configurar-barbara.bat y escríbala.');
    process.exit(1);
  }
}
if (adminPassword || dbPassword || crmToken) {
  const where = hostFrom(process.env.POSTGRES_ADMIN_URL || process.env.DATABASE_URL);
  envText = fillDatabaseSecrets(envText, { adminPassword, dbPassword, crmToken, ...where });
  fs.writeFileSync(envPath, envText);
  dotenv.config({ path: envPath, override: true });
  console.log('Guardé en .env la clave de la base de la tienda y la frase del panel. No hace falta copiarlas a otro lado.');
}

openEnvFile();
dotenv.config({ path: envPath, override: true });

const missing = missingSettings(process.env);
if (missing.length) {
  console.error('');
  console.error('Faltan datos en .env:');
  for (const item of missing) console.error(`  - ${item.name}: ${item.label}`);
  console.error('');
  console.error('Abra .env, complételos, guarde y vuelva a ejecutar npm run setup.');
  process.exit(1);
}

const { createAppDatabase } = await import('./db-create.js');
try {
  await createAppDatabase(process.env);
} catch (err) {
  console.error('');
  console.error(err.message || err);
  process.exit(1);
}

console.log('');
console.log('Listo. Ejecute npm run doctor y, si todo dice OK, npm start.');
