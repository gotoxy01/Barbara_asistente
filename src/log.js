import { config } from './config.js';

/** Log detallado solo con LOG_VERBOSE=true (depuración). */
export function verbose(...args) {
  if (config.logVerbose) console.log(...args);
}

/** Eventos importantes: arranque, errores, pesaje, escalado, CRM. */
export function info(...args) {
  console.log(...args);
}

export function warn(...args) {
  console.warn(...args);
}

export function error(...args) {
  console.error(...args);
}
