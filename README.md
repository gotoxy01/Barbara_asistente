# Bárbara – Abasto Los Cuchos

Asistente de WhatsApp de la bodega. El canal principal es la **WhatsApp Cloud API oficial** de Meta. Responde con Google Gemini, consulta precios en PostgreSQL local al momento de responder y arma la boleta en código (no se la inventa el modelo).

El modo con código QR (`whatsapp-web.js`) queda como respaldo.

Todos los datos (número de WhatsApp, asesor, pago móvil, claves) se cambian en un solo archivo: **`.env`**.

## Primeros pasos

1. Instale Node.js 22 y PostgreSQL 16 con pgvector. El detalle está en [docs/instalacion-windows.md](docs/instalacion-windows.md).
2. Doble clic en `configurar-barbara.bat`, o en una consola: `npm run setup`.
3. Le pide la clave del usuario `postgres` (no se ve al escribir). La clave de la base `barbara` y la frase del panel las inventa y las guarda en `.env`. Después se abre el archivo para el token de Meta, el Phone number ID y Gemini.
4. El mismo paso crea la base si aún no existe.
5. `npm run doctor` debe mostrar OK en cada línea.
6. `npm start`.

Para cambiar el número del negocio o el del asesor, edite `.env` y vuelva a iniciar. No hace falta modificar el programa.

Si la base ya está instalada y solo quiere crearla de nuevo: `npm run db:create`.

## 1. Instalación

```powershell
npm install
copy .env.example .env
```

Complete `.env`. Estas variables son obligatorias:

- Cloud: `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_TEMPLATE_NAME`
- Siempre: `DATABASE_URL`, `GEMINI_API_KEY`, `PAGO_MOVIL_TELEFONO`, `PAGO_MOVIL_CEDULA`, `PAGO_MOVIL_BANCO`, `CRM_TOKEN`

Sin ellas el proceso no arranca. No escriba teléfonos, cédulas ni tokens en el código.

## 1b. En la PC de la tienda

La base es **PostgreSQL instalado en esa PC**, con pgvector. Los datos del negocio no van a Supabase. El paso a paso (Postgres, túnel de Cloudflare, servicio de Windows y Redis opcional) está en [docs/instalacion-windows.md](docs/instalacion-windows.md).

Si venía de `barbara.db`:

```powershell
npm run migrate:sqlite
```

## 2. WhatsApp Cloud API

1. En [Meta for Developers](https://developers.facebook.com/apps) cree una app tipo **Business** y agregue el producto **WhatsApp**.
2. En el administrador de negocios cree un **usuario de sistema** con un token **permanente** y péguelo en `WHATSAPP_TOKEN`. El token temporal del panel de pruebas se vence.
3. Copie el **Phone number ID** a `WHATSAPP_PHONE_NUMBER_ID`.
4. En la configuración de la app, **App Secret** va en `WHATSAPP_APP_SECRET`. Bárbara rechaza con `401` cualquier `POST /webhook` cuya cabecera `X-Hub-Signature-256` no coincida.
5. Invente un `WHATSAPP_VERIFY_TOKEN` (una frase larga) y use el mismo valor en Meta.
6. Cree y haga aprobar una **plantilla** de mensaje (por ejemplo para retomar la conversación). El nombre exacto va en `WHATSAPP_TEMPLATE_NAME` y el idioma en `WHATSAPP_TEMPLATE_LANG` (por defecto `es`). Fuera de las 24 horas desde el último mensaje del cliente, Bárbara no manda texto libre: manda esa plantilla. Si Meta responde con el error `131047`, hace lo mismo.
7. Arranque: `npm start`. La versión de la API por defecto es `v26.0` (`WHATSAPP_API_VERSION`).
8. Publique el puerto con HTTPS (en pruebas, `ngrok http 3000` o `cloudflared tunnel --url http://localhost:3000`).
9. En WhatsApp > Configuración > Webhook:
   - URL: `https://SU-DOMINIO/webhook`
   - Token de verificación: el de `WHATSAPP_VERIFY_TOKEN`
   - Suscríbase al campo **messages**

Al arrancar también abre el panel en `http://127.0.0.1:3847` y reintenta, durante la última hora, los mensajes que Gemini no pudo contestar.

Si el catálogo en uso es `data/products.json`, la consola avisa en grande: esos precios son de prueba, no los de la caja. Copie `database.db` o defina `CATALOG_DB_PATH`.

## 3. Cómo atiende

1. Varios mensajes seguidos del mismo número se juntan en un solo turno (`DEBOUNCE_WINDOW_MS`, 3,5 s) y se responden en orden.
2. El catálogo se busca por palabras (acentos, plurales, sinónimos, errores de tipeo). Los totales de la boleta los calcula el programa.
3. Gemini debe devolver un JSON con producto, confianza y la respuesta al cliente. Si la confianza es menor o igual a `CONFIDENCE_THRESHOLD` (85), si piden una persona, si hay una queja, o si es al mayor o fuera de catálogo, el chat pasa a **especialista**.
4. En especialista, Bárbara no vuelve a escribir hasta que alguien use `#reanudar`. No se reactiva sola a las 12 horas. Para que sí lo haga, ponga `SPECIALIST_AUTO_RESUME_HOURS` en un número mayor que 0.
5. El aviso al asesor incluye el contacto, un resumen, el producto tentativo y el motivo. También queda en el panel.
6. Una foto solo abre ticket de pago si el contexto es un comprobante. Una foto de producto no se toma como pago (la visión del producto llega en una fase posterior).
7. Cada `wamid` se marca como atendido recién cuando el turno termina bien, y esa marca caduca a las 24 horas. Un id vacío se ignora. La respuesta del bot se guarda en el historial después de que WhatsApp acepta el envío.

Comandos del asesor (al número del negocio o, en el modo QR, en Mensajes para mí):

| Comando | Acción |
|---|---|
| `#r 584121234567 mensaje` | Responder al cliente |
| `#pausar 584121234567` | Dejar el chat con el especialista |
| `#reanudar 584121234567` | Devolver el chat a Bárbara |
| `#precio 1.50` | Precio en USD de lo que se pesó |
| `#nohay` | Avisar que no hay |
| `#b` | Ver o borrar pedidos pendientes |
| `#ayuda` | Lista de comandos |

## 4. Probar sin WhatsApp

Con `GEMINI_API_KEY` y los datos de pago móvil y del panel en `.env`:

```powershell
npm run chat
npm run check
npm test
```

## 5. Respaldo con código QR

`npm run start:qr` abre WhatsApp Web. No es la API oficial: el teléfono del negocio debe quedar vinculado y la PC encendida. Úselo si Cloud todavía no está listo. El panel y el catálogo funcionan igual. La ventana de 24 horas y las plantillas aplican al canal Cloud.

## 6. Lo que falta

Visión de fotos, el recontacto automático del tipo “déjame lo pienso” y un CRM con etiquetas y embudo. Postgres local y la cola Redis opcional ya están.
