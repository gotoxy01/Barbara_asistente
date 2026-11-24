import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Convierte una URL file:// en ruta del sistema.
 * En Windows `new URL(...).pathname` deja un `/C:/...` y path.resolve arma `C:\C:\...`.
 */
export function fileUrlToPath(metaUrl, platform = process.platform) {
  const url = metaUrl instanceof URL ? metaUrl : new URL(metaUrl);
  let pathname = decodeURIComponent(url.pathname);
  if (platform === 'win32') {
    if (/^\/[A-Za-z]:\//.test(pathname)) pathname = pathname.slice(1);
    return pathname.replaceAll('/', '\\');
  }
  return fileURLToPath(url);
}

export function projectRootFromScript(metaUrl, platform = process.platform) {
  const file = platform === 'win32' ? fileUrlToPath(metaUrl, 'win32') : fileURLToPath(metaUrl);
  const pathImpl = platform === 'win32' ? path.win32 : path;
  return pathImpl.resolve(pathImpl.dirname(file), '..');
}

/** Verdadero si este archivo es el que arrancó Node. `import.meta.main` existe en Node 26. */
export function isDirectRun(metaUrl, invokedAsMain = false) {
  if (invokedAsMain === true) return true;
  const here = fileURLToPath(metaUrl);
  const argv = process.argv[1];
  if (!argv) return false;
  return path.resolve(argv) === path.resolve(here);
}
