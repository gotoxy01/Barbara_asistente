// Crea el usuario, la base y pgvector, y aplica las migraciones.
// Uso: npm run db:create
import 'dotenv/config';
import pg from 'pg';
import { initDb, closeDb } from '../src/db.js';
import {
  explainPgError,
  isBlank,
  missingSettings,
  parsePostgresUrl,
  assertSafeIdent,
  quoteLiteral,
} from './lib/settings.js';

export async function createAppDatabase(env = process.env) {
  if (isBlank(env.POSTGRES_ADMIN_URL) || isBlank(env.DATABASE_URL)) {
    throw new Error('Complete POSTGRES_ADMIN_URL y DATABASE_URL en .env antes de crear la base.');
  }
  const app = parsePostgresUrl(env.DATABASE_URL);
  const userSql = assertSafeIdent(app.user, 'El usuario de DATABASE_URL');
  const dbSql = assertSafeIdent(app.database, 'El nombre de la base en DATABASE_URL');
  if (!app.password) {
    throw new Error('DATABASE_URL no tiene contraseña. Póngala en .env y vuelva a intentar.');
  }

  const adminInfo = parsePostgresUrl(env.POSTGRES_ADMIN_URL);
  if (!adminInfo.password) {
    throw new Error('POSTGRES_ADMIN_URL no tiene contraseña. Escriba la clave que eligió al instalar PostgreSQL.');
  }
  const admin = new pg.Client({ connectionString: env.POSTGRES_ADMIN_URL, connectionTimeoutMillis: 8000 });
  try {
    await admin.connect();
  } catch (err) {
    throw new Error(explainPgError(err));
  }

  try {
    const role = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [app.user]);
    if (role.rowCount) {
      await admin.query(`ALTER USER ${userSql} WITH PASSWORD ${quoteLiteral(app.password)}`);
      console.log(`El usuario ${app.user} ya existía. Se actualizó su clave con la de .env.`);
    } else {
      await admin.query(`CREATE USER ${userSql} WITH PASSWORD ${quoteLiteral(app.password)}`);
      console.log(`Usuario ${app.user} creado.`);
    }

    const database = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [app.database]);
    if (!database.rowCount) {
      await admin.query(`CREATE DATABASE ${dbSql} OWNER ${userSql}`);
      console.log(`Base ${app.database} creada.`);
    } else {
      console.log(`La base ${app.database} ya existía.`);
    }
  } catch (err) {
    throw new Error(explainPgError(err));
  } finally {
    await admin.end().catch(() => {});
  }

  const adminOnApp = new URL(env.POSTGRES_ADMIN_URL);
  adminOnApp.pathname = `/${app.database}`;
  const owner = new pg.Client({ connectionString: adminOnApp.toString(), connectionTimeoutMillis: 8000 });
  try {
    await owner.connect();
    await owner.query('CREATE EXTENSION IF NOT EXISTS vector');
    await owner.query(`GRANT ALL ON SCHEMA public TO ${userSql}`);
    console.log('pgvector está activo.');
  } catch (err) {
    throw new Error(explainPgError(err));
  } finally {
    await owner.end().catch(() => {});
  }

  await initDb();
  await closeDb();
  console.log('Tablas de Bárbara listas.');
}

const isDirect = process.argv[1] && process.argv[1].endsWith('db-create.js');
if (isDirect) {
  const missing = missingSettings(process.env).filter((item) => item.name === 'DATABASE_URL' || item.name === 'POSTGRES_ADMIN_URL');
  if (missing.length) {
    console.error('Faltan datos en .env:');
    for (const item of missing) console.error(`  - ${item.name}: ${item.label}`);
    process.exit(1);
  }
  createAppDatabase().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
