/**
 * Semilla fija de la caja de prueba. El generador no usa azar suelto:
 * el stock sale de esta función con la semilla 20261124.
 */

export const SEED = 20261124;

function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const random = rng(SEED);

function money(value) {
  return Math.round(value * 100) / 100;
}

function barcode(index) {
  return `759${String(1000000000 + index).padStart(10, '0')}`.slice(0, 13);
}

function stockFor(index, { inactive = false, low = false } = {}) {
  if (inactive) return 0;
  if (low || index % 23 === 0) return 1 + (index % 4);
  return 6 + Math.floor(random() * 72);
}

let serial = 1;
function row(nombre, precio, { inactive = false, low = false } = {}) {
  const index = serial++;
  return {
    nombre,
    precio: money(precio),
    stock: stockFor(index, { inactive, low }),
    codigo: barcode(index),
    activo: inactive ? 0 : 1,
  };
}

function expand(items, sizes) {
  const out = [];
  for (const item of items) {
    for (const [label, factor] of sizes) {
      const full = `${item.nombre} ${label}`;
      const abbr = item.abbr ? `${item.abbr} ${label.replace(/\s+/g, '')}` : null;
      const primary = abbr && out.length % 5 === 0 ? abbr : full;
      out.push(row(primary, item.precio * factor, item));
      if (abbr && item.alsoAbbr && primary !== abbr) out.push(row(abbr, item.precio * factor, item));
    }
  }
  return out;
}

const kg = [['1KG', 1], ['500G', 0.58]];
const drink = [['2L', 1], ['1.5L', 0.82], ['355ML', 0.28]];
const bottle = [['1L', 1], ['900ML', 0.9], ['500ML', 0.58]];

const articulosVendibles = [
  ...expand([
    { nombre: 'Harina de Maíz PAN blanca', abbr: 'HAR PAN BCO', precio: 1.8, alsoAbbr: true },
    { nombre: 'Harina de Maíz PAN amarilla', abbr: 'HAR PAN AMA', precio: 1.8, alsoAbbr: true },
    { nombre: 'Harina de Maíz Juana', abbr: 'HAR JUANA', precio: 1.45, alsoAbbr: true },
    { nombre: 'Harina de Trigo Robin Hood', abbr: 'HAR ROBIN', precio: 2.1, alsoAbbr: true },
    { nombre: 'Harina de Trigo PAN', abbr: 'HAR PAN TRIGO', precio: 1.95 },
  ], kg),
  ...expand([
    { nombre: 'Arroz Blanco Mary', abbr: 'ARR MARY', precio: 1.9, alsoAbbr: true },
    { nombre: 'Arroz Blanco Primor', abbr: 'ARR PRIMOR', precio: 1.85, alsoAbbr: true },
    { nombre: 'Arroz Integral Mary', abbr: 'ARR INT MARY', precio: 2.4 },
  ], [['1KG', 1], ['800G', 0.86]]),
  ...expand([
    'Spaghetti', 'Tornillo', 'Pluma', 'Codito', 'Lazo', 'Letras', 'Cabello de ángel', 'Linguini',
  ].flatMap((forma) => ['Mary', 'Primor'].map((marca) => ({
    nombre: `Pasta ${forma} ${marca}`,
    abbr: `PST ${forma.slice(0, 4).toUpperCase()} ${marca.slice(0, 3).toUpperCase()}`,
    precio: 1.35,
  }))), [['1KG', 1], ['500G', 0.62]]),
  ...expand([
    { nombre: 'Aceite Vatel', abbr: 'ACE VATEL', precio: 4.2, alsoAbbr: true },
    { nombre: 'Aceite Mazeite', abbr: 'ACE MAZEITE', precio: 3.9, alsoAbbr: true },
    { nombre: 'Aceite El Rey', abbr: 'ACE REY', precio: 4.4 },
    { nombre: 'Aceite Diana', abbr: 'ACE DIANA', precio: 3.7 },
  ], bottle),
  ...expand([
    { nombre: 'Azúcar Refinada Montalbán', abbr: 'AZC MONTAL', precio: 2.05 },
    { nombre: 'Azúcar Morena', abbr: 'AZC MORENA', precio: 1.9 },
    { nombre: 'Papelón', abbr: 'PAPELON', precio: 1.6 },
  ], kg),
  ...expand([
    { nombre: 'Café Fama de América', abbr: 'CAF FAMA', precio: 3.2, alsoAbbr: true },
    { nombre: 'Café Madrid', abbr: 'CAF MADRID', precio: 2.9, alsoAbbr: true },
    { nombre: 'Café San Antonio', abbr: 'CAF SAN ANT', precio: 2.6 },
  ], [['500G', 1], ['250G', 0.55], ['100G', 0.28]]),
  ...expand([
    'Caraotas negras', 'Caraotas rojas', 'Lentejas', 'Arvejas', 'Garbanzos', 'Frijol bayo',
  ].map((nombre) => ({ nombre, abbr: nombre.slice(0, 8).toUpperCase(), precio: 1.7 })), [['500G', 1], ['1KG', 1.8]]),
  ...expand([
    'Atún Margarita', 'Sardinas Margarita', 'Diablitos Underwood', 'Maíz dulce', 'Guisantes',
    'Caraotas enlatadas', 'Salsa de tomate Heinz', 'Pasta de tomate', 'Mayonesa Mavesa', 'Mostaza Mavesa',
  ].map((nombre) => ({ nombre, abbr: nombre.split(' ')[0].slice(0, 6).toUpperCase(), precio: 1.5 })), [['140G', 0.7], ['400G', 1]]),
  ...expand([
    { nombre: 'Salsa de tomate Pampero', precio: 1.2 },
    { nombre: 'Ketchup Heinz', precio: 2.1 },
    { nombre: 'Salsa de ajo', precio: 1.1 },
    { nombre: 'Salsa inglesa', precio: 1.4 },
    { nombre: 'Salsa de soya', precio: 1.6 },
    { nombre: 'Vinagre de vino', precio: 1.3 },
  ], [['250ML', 1], ['500ML', 1.6]]),
  ...expand([
    'Pepito Toddy', 'Galletas Marías', 'Galletas Sultana', 'Galletas Club Social', 'Doritos',
    'Ruffles', 'Platanitos', 'Yuca frita', 'Maní japonés', 'Chocolates Savoy', 'Toronto', 'Pirulín',
    'Oreo', 'Galletas María Puig', 'Chokis',
  ].map((nombre) => ({ nombre, abbr: nombre.slice(0, 10).toUpperCase(), precio: 1.1 })), [['40G', 0.45], ['150G', 1]]),
  ...expand([
    { nombre: 'Leche en polvo La Campesina', abbr: 'LCH CAMPES', precio: 8.5, alsoAbbr: true },
    { nombre: 'Leche líquida Los Andes', abbr: 'LCH ANDES', precio: 1.6 },
    { nombre: 'Leche completa Parranda', abbr: 'LCH PARRAN', precio: 1.55 },
    { nombre: 'Yogurt Los Andes', abbr: 'YOG ANDES', precio: 1.4 },
    { nombre: 'Leche condensada', abbr: 'LCH COND', precio: 2.2 },
    { nombre: 'Suero de leche', abbr: 'SUERO', precio: 1.3 },
  ], [['800G', 1], ['400G', 0.55], ['1L', 0.7]].slice(0, 2)),
  ...expand([
    { nombre: 'Pepsi', abbr: 'PEPSI', precio: 1.8, alsoAbbr: true },
    { nombre: 'Coca-Cola', abbr: 'COCA', precio: 1.85, alsoAbbr: true },
    { nombre: 'Malta Polar', abbr: 'MALTA POL', precio: 2.1, alsoAbbr: true },
    { nombre: 'Agua Minalba', abbr: 'MINALBA', precio: 0.9, alsoAbbr: true },
    { nombre: 'Frescolita', abbr: 'FRESCOLITA', precio: 1.5 },
    { nombre: 'Chinotto', abbr: 'CHINOTTO', precio: 1.45 },
    { nombre: 'Hit naranja', abbr: 'HIT NAR', precio: 1.2 },
    { nombre: 'Jugo Yukery', abbr: 'YUKERY', precio: 1.15 },
  ], drink),
  ...expand([
    { nombre: 'Detergente Las Llaves', abbr: 'LLAVES', precio: 2.4, alsoAbbr: true },
    { nombre: 'Detergente Ace', abbr: 'ACE', precio: 3.1, alsoAbbr: true },
    { nombre: 'Cloro Nevex', abbr: 'CLORO NEV', precio: 1.4 },
    { nombre: 'Suavizante Suavitel', abbr: 'SUAVITEL', precio: 2.8 },
    { nombre: 'Jabón en polvo Las Llaves', abbr: 'JAB LLAVES', precio: 2.2 },
    { nombre: 'Lavaplatos Axion', abbr: 'AXION', precio: 1.3 },
    { nombre: 'Desinfectante Lysol', abbr: 'LYSOL', precio: 2.6 },
    { nombre: 'Ambientador', abbr: 'AMBIENT', precio: 1.7 },
  ], [['1KG', 1], ['500ML', 0.7], ['1L', 1.1]]),
  ...expand([
    { nombre: 'Crema dental Colgate', abbr: 'COLGATE', precio: 1.6, alsoAbbr: true },
    { nombre: 'Jabón Protex', abbr: 'PROTEX', precio: 1.2, alsoAbbr: true },
    { nombre: 'Papel higiénico Rosal', abbr: 'PAPEL ROSAL', precio: 2.5, alsoAbbr: true },
    { nombre: 'Shampoo Sedal', abbr: 'SEDAL', precio: 2.9 },
    { nombre: 'Desodorante Rexona', abbr: 'REXONA', precio: 2.4 },
    { nombre: 'Toallas sanitarias', abbr: 'TOALLAS', precio: 1.8 },
    { nombre: 'Cepillo dental', abbr: 'CEPILLO', precio: 0.9 },
  ], [['1UND', 1], ['3UND', 2.4]]),
  ...expand([
    { nombre: 'Atamel', abbr: 'ATAMEL', precio: 1.1, alsoAbbr: true },
    { nombre: 'Acetaminofén', abbr: 'ACETAMINOF', precio: 0.8, alsoAbbr: true },
    { nombre: 'Loratadina', abbr: 'LORATADINA', precio: 1.3, alsoAbbr: true },
    { nombre: 'Ibuprofeno', abbr: 'IBUPROFENO', precio: 1.2 },
    { nombre: 'Omeprazol', abbr: 'OMEPRAZOL', precio: 1.5 },
    { nombre: 'Suero oral', abbr: 'SUERO ORAL', precio: 1.4 },
    { nombre: 'Curitas', abbr: 'CURITAS', precio: 0.7 },
    { nombre: 'Alcohol antiséptico', abbr: 'ALCOHOL', precio: 1.0 },
  ], [['10UND', 1], ['20UND', 1.6]]),
  ...expand([
    { nombre: 'Bombillo LED', abbr: 'BOMBILLO', precio: 1.4 },
    { nombre: 'Cinta aislante', abbr: 'CINTA AISL', precio: 0.9 },
    { nombre: 'Clavos de acero', abbr: 'CLAVOS', precio: 1.8 },
    { nombre: 'Tornillos para madera', abbr: 'TORNILLOS', precio: 1.5 },
    { nombre: 'Candado', abbr: 'CANDADO', precio: 3.2 },
    { nombre: 'Pega loca', abbr: 'PEGA', precio: 0.8 },
    { nombre: 'Brocha', abbr: 'BROCHA', precio: 1.6 },
    { nombre: 'Destornillador', abbr: 'DESTORN', precio: 2.4 },
    { nombre: 'Pila AA', abbr: 'PILA AA', precio: 1.1 },
    { nombre: 'Extensión eléctrica', abbr: 'EXTENSION', precio: 4.5 },
  ], [['1UND', 1]]),
  ...expand([
    { nombre: 'Pan campesino', abbr: 'PAN CAMP', precio: 1.2 },
    { nombre: 'Pan de sándwich', abbr: 'PAN SANDW', precio: 1.8 },
    { nombre: 'Pan canilla', abbr: 'CANILLA', precio: 0.3 },
    { nombre: 'Galletas de soda', abbr: 'GAL SODA', precio: 0.9 },
    { nombre: 'Catalinas', abbr: 'CATALINAS', precio: 0.6 },
    { nombre: 'Golfeados', abbr: 'GOLFEADOS', precio: 1.0 },
  ], [['1UND', 1], ['4UND', 3.2]]),
  ...expand([
    'Sal', 'Pimienta', 'Comino', 'Ajo en polvo', 'Onza', 'Curry', 'Canela', 'Nutmeg',
    'Caldo de pollo', 'Caldo de costilla', 'Sazón completo', 'Azafrán criollo',
  ].map((nombre) => ({ nombre, abbr: nombre.slice(0, 8).toUpperCase(), precio: 0.7 })), [['50G', 1], ['100G', 1.5]]),
  ...expand([
    'Avena Quaker', 'Maicena', 'Mantequilla Mavesa', 'Margarina Nelly', 'Maíz pilado',
    'Harina de yuca', 'Avena en hojuelas', 'Leche de coco', 'Crema de leche', 'Flan Royal',
  ].map((nombre) => ({ nombre, abbr: nombre.slice(0, 10).toUpperCase(), precio: 1.8 })), [['500G', 1], ['200G', 0.5]]),
  ...expand([
    'Jugo Yukery manzana', 'Jugo Yukery uva', 'Jugo Yukery pera', 'Malta Regional', 'Seven Up',
    'Sprite', 'Agua mineral', 'Té frío', 'Jugo de naranja', 'Energizante',
  ].map((nombre) => ({ nombre, abbr: nombre.slice(0, 10).toUpperCase(), precio: 1.3 })), [['1L', 1], ['350ML', 0.4]]),
  ...expand([
    'Esponja', 'Coleto', 'Bolsa de basura', 'Papel aluminio', 'Papel envoltorio',
    'Servilletas', 'Guantes de limpieza', 'Trapo de piso', 'Jabón de panela Las Llaves', 'Desengrasante',
  ].map((nombre) => ({ nombre, abbr: nombre.slice(0, 10).toUpperCase(), precio: 1.1 })), [['1UND', 1], ['3UND', 2.2]]),
];

const inactivos = [
  row('Harina PAN blanca vencida 1KG', 1.8, { inactive: true }),
  row('Aceite Mazeite dañado 1L', 3.9, { inactive: true }),
  row('Pepsi sin gas 2L', 1.8, { inactive: true }),
  row('Atamel lote retirado 10UND', 1.1, { inactive: true }),
  row('Detergente Las Llaves húmedo 1KG', 2.4, { inactive: true }),
  row('Café Madrid húmedo 250G', 1.6, { inactive: true }),
].map((item) => ({ ...item, precio: item.precio, activo: 0 }));

const sinPrecio = [
  { nombre: 'Artículo descontinuado', precio: 0, stock: 4, codigo: barcode(9001), activo: 0 },
  { nombre: 'Muestra de feria', precio: 0, stock: 2, codigo: barcode(9002), activo: 0 },
];

const soloCodigo = [7591000000001, 7591000000002, 7591000000003, 7591000000004].map((codigo, index) => ({
  nombre: String(codigo),
  precio: 0.5,
  stock: 3,
  codigo: String(codigo),
  activo: 1,
  nota: index,
}));

const delivery = row('Delivery costo', 1.5, { inactive: true });

const pesables = (nombres, base) => nombres.map((nombre, index) => row(
  nombre,
  money(base + (index % 5) * 0.35),
  { low: index % 7 === 0 },
));

const charcuteria = pesables([
  'Queso blanco duro', 'Queso llanero', 'Queso amarillo', 'Queso guayanés', 'Queso de mano',
  'Queso paisa', 'Queso mozzarella', 'Jamón de pierna', 'Jamón de pavo', 'Jamón ahumado',
  'Mortadela', 'Mortadela con pistacho', 'Chorizo ahumado', 'Chorizo criollo', 'Salchicha',
  'Tocineta', 'Queso pecorino', 'Queso gouda', 'QS BCO DURO', 'JAMON PIERNA',
  'MORTADELA', 'CHORIZO AHUM', 'Salchichón', 'Butifarra', 'Queso telita',
  'Queso de búfala', 'Jamón planchado', 'Tocineta ahumada', 'Chuleta ahumada', 'Costilla de cerdo',
], 6.4);

const verduras = pesables([
  'Tomate', 'Papa', 'Cebolla', 'Cebolla morada', 'Zanahoria', 'Plátano', 'Cambur',
  'Lechuga', 'Pimentón', 'Ajo', 'Cilantro', 'Yuca', 'Ñame', 'Auyama', 'Pepino',
  'Repollo', 'Remolacha', 'Apio', 'Perejil', 'Vainita', 'Berenjena', 'Calabacín',
  'Limón', 'Naranja', 'Parchita', 'Lechosa', 'Patilla', 'Melón', 'Aguacate', 'Ocumo',
], 0.8);

const limpiezaGranel = pesables([
  'Cloro a granel', 'Detergente a granel', 'Jabón azul a granel', 'Desinfectante a granel',
  'Suavizante a granel', 'Jabón en panela', 'Bicarbonato a granel', 'Ácido muriático',
], 1.1);

const mascotas = pesables([
  'Dog Chow adultos', 'Dog Chow cachorro', 'Gatsy', 'Arena para gato', 'Huesos masticables',
  'Alimento de perro económico', 'Alimento de gato', 'Snacks para perro',
], 2.2);

export function buildSeed() {
  return {
    articulos: [...articulosVendibles, ...inactivos, ...sinPrecio, ...soloCodigo, delivery],
    charcuteria,
    verduras,
    limpieza: limpiezaGranel,
    mascotas,
  };
}
