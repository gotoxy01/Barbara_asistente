// Prepara la PC: crea .env, lo abre, revisa los datos y crea la base.
// Uso: npm run setup
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { missingSettings } from './lib/settings.js';

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
