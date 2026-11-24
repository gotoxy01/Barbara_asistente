/** Revisa el archivo .env y traduce los errores de Postgres a español. */

export const REQUIRED_SETTINGS = [
  ['WHATSAPP_TOKEN', 'token permanente de WhatsApp'],
  ['WHATSAPP_PHONE_NUMBER_ID', 'Phone number ID de Meta'],
  ['WHATSAPP_VERIFY_TOKEN', 'frase de verificación del webhook'],
  ['WHATSAPP_APP_SECRET', 'clave secreta de la app de Meta'],
  ['WHATSAPP_TEMPLATE_NAME', 'nombre de la plantilla aprobada'],
  ['GEMINI_API_KEY', 'clave de Gemini'],
  ['POSTGRES_ADMIN_URL', 'dirección del administrador de PostgreSQL'],
  ['DATABASE_URL', 'dirección de la base de la tienda'],
  ['PAGO_MOVIL_TELEFONO', 'teléfono de pago móvil'],
  ['PAGO_MOVIL_CEDULA', 'cédula de pago móvil'],
  ['PAGO_MOVIL_BANCO', 'banco de pago móvil'],
  ['CRM_TOKEN', 'frase secreta del panel'],
];

const PLACEHOLDER = /CAMBIE|PEGUE_AQUI|CLAVE_DEL_INSTALADOR|REEMPLACE|TU_TOKEN|SU_TOKEN|elija-una-frase/i;

export function isBlank(value) {
  const text = String(value ?? '').trim();
  return !text || PLACEHOLDER.test(text);
}

/** @returns {{ name: string, label: string }[]} */
export function missingSettings(env = process.env) {
  return REQUIRED_SETTINGS.filter(([name]) => isBlank(env[name])).map(([name, label]) => ({ name, label }));
}

export function parsePostgresUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url || ''));
  } catch {
    throw new Error('La dirección de Postgres no se entiende. Debe empezar por postgresql://');
  }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error('La dirección de Postgres debe empezar por postgresql://');
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  const user = decodeURIComponent(parsed.username || '');
  const password = decodeURIComponent(parsed.password || '');
  if (!user || !database) {
    throw new Error('La dirección de Postgres necesita usuario y nombre de base. Ejemplo: postgresql://barbara:clave@127.0.0.1:5432/barbara');
  }
  return {
    user,
    password,
    host: parsed.hostname || '127.0.0.1',
    port: parsed.port || '5432',
    database,
  };
}

export function assertSafeIdent(name, label) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`${label} solo puede tener letras, números y _. Revise el nombre en .env.`);
  }
  return `"${name}"`;
}

export function quoteLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function postgresUrl({ user, password, host = '127.0.0.1', port = '5432', database }) {
  const url = new URL('postgresql://127.0.0.1');
  url.username = user;
  url.password = password;
  url.hostname = host || '127.0.0.1';
  url.port = String(port || '5432');
  url.pathname = `/${database}`;
  return url.toString();
}

export function setEnvLine(text, key, value) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  if (pattern.test(text)) return text.replace(pattern, line);
  return `${text.replace(/\s*$/, '')}\n${line}\n`;
}

/** Arma las direcciones de Postgres y la frase del panel. Codifica la clave en la URL. */
export function fillDatabaseSecrets(envText, { adminPassword, dbPassword, crmToken, host = '127.0.0.1', port = '5432' }) {
  let text = envText;
  if (adminPassword) {
    text = setEnvLine(text, 'POSTGRES_ADMIN_URL', postgresUrl({
      user: 'postgres', password: adminPassword, host, port, database: 'postgres',
    }));
  }
  if (dbPassword) {
    text = setEnvLine(text, 'DATABASE_URL', postgresUrl({
      user: 'barbara', password: dbPassword, host, port, database: 'barbara',
    }));
  }
  if (crmToken) text = setEnvLine(text, 'CRM_TOKEN', crmToken);
  return text;
}

export function explainPgError(err) {
  const code = err?.code;
  const message = String(err?.message || err || '');
  if (code === 'ECONNREFUSED' || /ECONNREFUSED|connect ECONNREFUSED|timeout expired|Connection terminated/i.test(message)) {
    return 'PostgreSQL no está instalado o no está encendido. Instálelo, déjelo en el puerto 5432 y vuelva a intentar.';
  }
  if (code === 'ENOTFOUND') {
    return 'No se encontró el equipo de Postgres. En DATABASE_URL y POSTGRES_ADMIN_URL use 127.0.0.1.';
  }
  if (code === '28P01' || /password authentication failed|client password must be a string|SASL/i.test(message)) {
    return 'La contraseña de Postgres no coincide. Revise POSTGRES_ADMIN_URL (clave del instalador) y DATABASE_URL en .env.';
  }
  if (code === '28000' || /role .* does not exist/i.test(message)) {
    return 'Ese usuario de Postgres no existe. Revise POSTGRES_ADMIN_URL en .env.';
  }
  if (code === '3D000' || /database .* does not exist/i.test(message)) {
    return 'La base todavía no existe. Ejecute npm run setup para crearla.';
  }
  if (/extension "vector"|could not open extension control file|pgvector/i.test(message)) {
    return 'Falta pgvector en este PostgreSQL. Instale la extensión de la misma versión (16) y vuelva a correr npm run setup.';
  }
  return `Postgres respondió: ${message}`;
}
