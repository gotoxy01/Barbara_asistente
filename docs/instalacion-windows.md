# Instalar Bárbara en la PC de la tienda

Todo queda en la computadora del abasto. Los pedidos, chats y precios no van a Supabase. Supabase, si se usa, es solo para la licencia y este programa no lo toca.

Hace falta Windows 10 u 11, Node.js 22 y una conexión a internet para WhatsApp y Gemini.

## 1. PostgreSQL con pgvector

1. Instale **PostgreSQL 16** desde [el instalador de EDB](https://www.enterprisedb.com/downloads/postgres-postgresql-downloads). Anote la contraseña del usuario `postgres` y deje el puerto **5432**.
2. Instale la extensión **pgvector** de la misma versión de PostgreSQL. En el sitio de [pgvector](https://github.com/pgvector/pgvector) hay un paquete para Windows: copie `vector.dll` a `C:\Program Files\PostgreSQL\16\lib` y los archivos de `share\extension` a `C:\Program Files\PostgreSQL\16\share\extension`.
3. Abra **SQL Shell (psql)** y ejecute:

```sql
CREATE USER barbara WITH PASSWORD 'una-clave-larga';
CREATE DATABASE barbara OWNER barbara;
\c barbara
CREATE EXTENSION vector;
```

4. Doble clic en `configurar-barbara.bat`. Ese paso crea `.env`, lo abre y crea la base. Si prefiere la consola: `npm run setup`. Las direcciones quedan así en `.env`:

```env
DATABASE_URL=postgresql://barbara:una-clave-larga@127.0.0.1:5432/barbara
EMBEDDING_MODEL=gemini-embedding-001
EMBEDDING_DIMENSIONS=768
```

No cambie `EMBEDDING_DIMENSIONS` después de crear la base. Si lo cambia, hay que recrear la columna `embedding`.

5. Si ya tenía `barbara.db` de la versión anterior:

```powershell
npm run migrate:sqlite
```

Eso copia chats, mensajes, pedidos y alertas. Se puede ejecutar de nuevo sin duplicar.

## 2. Catálogo de la caja

Deje `database.db` de la caja en la carpeta del proyecto, o indique la ruta:

```env
CATALOG_DB_PATH=C:\caja\database.db
CATALOG_SOURCE=auto
```

Bárbara lo lee nada más (no escribe en la caja) y copia productos a Postgres cada pocos minutos. El precio que ve el cliente sale de una consulta en ese momento, no de un texto fijo.

## 3. Redis, si quiere cola entre reinicios

Sin `REDIS_URL`, la cola vive en la memoria de este proceso y se pierde si se apaga a mitad de un mensaje.

En Windows puede usar uno de estos:

- **Memurai** (Redis para Windows): `REDIS_URL=redis://127.0.0.1:6379`
- **Redis en WSL o Docker**: el mismo `REDIS_URL` apuntando a esa máquina

## 4. Túnel para el webhook de Meta

Meta tiene que llegar a esta PC. Con Cloudflare Tunnel y un nombre fijo:

```powershell
cloudflared tunnel login
cloudflared tunnel create barbara
cloudflared tunnel route dns barbara whatsapp.su-dominio.com
```

Archivo `C:\Users\TIENDA\.cloudflared\config.yml`:

```yaml
tunnel: barbara
credentials-file: C:\Users\TIENDA\.cloudflared\<ID>.json
ingress:
  - hostname: whatsapp.su-dominio.com
    service: http://127.0.0.1:3000
  - service: http_status:404
```

Instálelo como servicio para que vuelva después de un reinicio:

```powershell
cloudflared service install
```

En Meta, la URL del webhook es `https://whatsapp.su-dominio.com/webhook`.

ngrok también sirve para una prueba (`ngrok http 3000`), pero la dirección cambia si no tiene un dominio reservado.

## 5. Dejar Bárbara encendida

En la carpeta del proyecto, con el `.env` completo:

```powershell
npm install
npm start
```

Para que arranque sola al prender la PC, use **NSSM**:

```powershell
nssm install Barbara "C:\Program Files\nodejs\node.exe"
```

En la ventana de NSSM:

- Argumentos: `--use-system-ca src\server.js`
- Directorio: la carpeta de Bárbara
- Inicio: automático

O, si prefiere pm2:

```powershell
npm install -g pm2
pm2 start src/server.js --name barbara --node-args="--use-system-ca"
pm2 save
pm2-startup install
```

`iniciar-barbara.bat` sigue sirviendo para abrirla a mano en una ventana.

El código QR (`npm run start:qr`) queda solo de respaldo. También usa la base local.
