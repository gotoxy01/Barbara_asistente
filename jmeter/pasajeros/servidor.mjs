// API local solo para practicar JMeter. No sale a internet.
// Uso: node servidor.mjs
import http from 'node:http';

const viajes = [
  { id: 'V1', origen: 'Caracas', destino: 'Valencia', salida: '08:00', asientos: 40, precio: 12 },
  { id: 'V2', origen: 'Caracas', destino: 'Maracay', salida: '09:30', asientos: 36, precio: 8 },
  { id: 'V3', origen: 'Valencia', destino: 'Barquisimeto', salida: '11:00', asientos: 42, precio: 15 },
  { id: 'V4', origen: 'Maracaibo', destino: 'Caracas', salida: '18:00', asientos: 38, precio: 28 },
];

const boletos = [];

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(json);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');

  if (req.method === 'GET' && url.pathname === '/pasajeros/viajes') {
    const origen = (url.searchParams.get('origen') || '').toLowerCase();
    const destino = (url.searchParams.get('destino') || '').toLowerCase();
    const lista = viajes.filter((v) =>
      (!origen || v.origen.toLowerCase() === origen) && (!destino || v.destino.toLowerCase() === destino));
    return send(res, 200, { viajes: lista });
  }

  if (req.method === 'POST' && url.pathname === '/pasajeros/boletos') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let pedido = {};
    try {
      pedido = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    } catch {
      return send(res, 400, { error: 'JSON inválido' });
    }
    if (!pedido.nombre || !pedido.origen || !pedido.destino) {
      return send(res, 400, { error: 'Faltan nombre, origen o destino' });
    }
    const boleto = { id: `B${boletos.length + 1}`, ...pedido };
    boletos.push(boleto);
    return send(res, 201, { boleto });
  }

  if (req.method === 'GET' && url.pathname === '/pasajeros/boletos') {
    return send(res, 200, { boletos });
  }

  send(res, 404, { error: 'No existe' });
});

server.listen(8089, '127.0.0.1', () => {
  console.log('API de pasajeros de prueba en http://127.0.0.1:8089');
  console.log('Deténgala con Ctrl+C cuando termine JMeter.');
});
