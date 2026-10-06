/**
 * Encuesta de nombres — servicio independiente para Render.
 *
 * NO comparte nada con Negocio360: su propio servicio, su propia base.
 * Si DATABASE_URL apunta a la base de producción, el arranque se detiene.
 */

const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

/* ---------- configuración ---------- */

// La lista con la que arrancó la encuesta. Ya no se edita aquí: los nombres
// viven en la tabla `candidatos` y se administran desde /resultados. Esta lista
// solo siembra la tabla la primera vez y dice qué vieron las respuestas que
// llegaron antes de que se guardara la columna `vistos`.
const ORIGINALES = [
  'Nerendi', 'Fenara',  'Kavani',  'Kavixi',
  'Claremi', 'Aineli',  'Terali',  'Plintap',
  'Kainori', 'Vainali', 'Rivelo',  'Sivli'
];

// A qué se dedica quien contesta. `pregunta` es el detalle opcional que aparece
// al elegir; sin pregunta, no se pide detalle.
const OCUPACIONES = [
  { id: 'negocio',       nombre: 'Dueño/a de negocio',          pregunta: '¿De qué es tu negocio o qué vendes?',
    ejemplo: 'Por ejemplo: una estética, ropa por Instagram, un taller…' },
  { id: 'empleado',      nombre: 'Empleado/a',                  pregunta: '¿En qué trabajas?',
    ejemplo: 'Por ejemplo: ventas en una farmacéutica' },
  { id: 'independiente', nombre: 'Profesionista independiente', pregunta: '¿Cuál es tu profesión?',
    ejemplo: 'Por ejemplo: contadora, diseñador, abogada' },
  { id: 'hogar',         nombre: 'Ama/o de casa',               pregunta: '', ejemplo: '' },
  { id: 'estudiante',    nombre: 'Estudiante',                  pregunta: '¿Qué estudias?',
    ejemplo: 'Por ejemplo: administración' },
  { id: 'otro',          nombre: 'Otro',                        pregunta: '¿A qué te dedicas?', ejemplo: '' }
];
const nombreOcupacion = id => (OCUPACIONES.find(o => o.id === id) || {}).nombre || '';

// Lo que se le cuenta a la persona DESPUÉS de opinar a ciegas, justo antes de
// pedirle un solo finalista. Describe, no vende. El primer párrafo va en grande;
// los demás, abajo, en texto normal.
const PROYECTO = [
  'Es una app para administrar un negocio pequeño o mediano, de cualquier giro: ' +
  'una tienda, una cafetería, una estética, un taller.',
  'Sirve para cobrar en efectivo o con tarjeta y registrar cada venta, llevar el ' +
  'inventario, las compras y los gastos, y hacer el corte de caja. El dueño ve ' +
  'desde su celular o su computadora cómo va el negocio: cuánto vendió, cuánto ' +
  'gastó y cuánto le quedó.'
];

const TOP = 5;                      // cuántos lugares pide
const OBLIGATORIAS = 3;             // cuántas explicaciones son obligatorias
const CLAVE = process.env.CLAVE_RESULTADOS || 'cambiame';

/* ---------- base de datos ---------- */

const url = process.env.DATABASE_URL;
let pool = null;
const memoria = [];                 // respaldo si no hay base (solo para probar en local)
let memoriaId = 1;
const memCandidatos = ORIGINALES.map((nombre, i) => ({ id: i + 1, nombre, activo: true, alias: [] }));

if (url) {
  pool = new Pool({
    connectionString: url,
    ssl: url.includes('localhost') ? false : { rejectUnauthorized: false },
    max: 4
  });
} else {
  console.warn('[aviso] Sin DATABASE_URL: las respuestas se guardan en memoria ' +
               'y se pierden al reiniciar. Úsalo solo para probar en local.');
}

async function prepararBase() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS respuestas (
      id       SERIAL PRIMARY KEY,
      creado   TIMESTAMPTZ NOT NULL DEFAULT now(),
      quien    TEXT NOT NULL,
      correo   TEXT,
      orden    JSONB NOT NULL,
      porque   JSONB NOT NULL,
      peor     TEXT,
      peor_porque TEXT,
      memoria  TEXT,
      libre    TEXT,
      excluida BOOLEAN NOT NULL DEFAULT FALSE,
      excluida_en TIMESTAMPTZ
    )
  `);
  await pool.query('ALTER TABLE respuestas ADD COLUMN IF NOT EXISTS excluida BOOLEAN NOT NULL DEFAULT FALSE');
  await pool.query('ALTER TABLE respuestas ADD COLUMN IF NOT EXISTS excluida_en TIMESTAMPTZ');
  await pool.query('ALTER TABLE respuestas ADD COLUMN IF NOT EXISTS ocupacion TEXT');
  await pool.query('ALTER TABLE respuestas ADD COLUMN IF NOT EXISTS ocupacion_detalle TEXT');
  await pool.query('ALTER TABLE respuestas ADD COLUMN IF NOT EXISTS acepta_info BOOLEAN NOT NULL DEFAULT FALSE');
  await pool.query('ALTER TABLE respuestas ADD COLUMN IF NOT EXISTS vistos JSONB');
  // El finalista que eligen ya sabiendo de qué es el proyecto. Vacío en las
  // respuestas que llegaron antes de que existiera ese paso.
  await pool.query('ALTER TABLE respuestas ADD COLUMN IF NOT EXISTS finalista TEXT');
  await pool.query('ALTER TABLE respuestas ADD COLUMN IF NOT EXISTS finalista_porque TEXT');
  // Otro nombre que se le ocurra a la persona. Opcional y sin filtro: son ideas.
  await pool.query('ALTER TABLE respuestas ADD COLUMN IF NOT EXISTS sugerencia TEXT');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS candidatos (
      id     SERIAL PRIMARY KEY,
      nombre TEXT NOT NULL UNIQUE,
      activo BOOLEAN NOT NULL DEFAULT TRUE,
      alias  JSONB NOT NULL DEFAULT '[]'::jsonb,
      creado TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  // La primera vez se siembra con la lista original, en su orden.
  const r = await pool.query('SELECT count(*)::int AS n FROM candidatos');
  if (!r.rows[0].n) {
    for (const nombre of ORIGINALES) {
      await pool.query('INSERT INTO candidatos (nombre) VALUES ($1) ON CONFLICT (nombre) DO NOTHING', [nombre]);
    }
  }
  console.log('[ok] tablas respuestas y candidatos listas');
}

async function guardar(fila) {
  if (!pool) {
    memoria.push({ id: memoriaId++, ...fila, creado: new Date(), excluida: false, excluidaEn: null });
    return;
  }
  await pool.query(
    'INSERT INTO respuestas (quien, correo, orden, porque, peor, peor_porque, memoria, libre, ' +
    'ocupacion, ocupacion_detalle, acepta_info, vistos, finalista, finalista_porque, sugerencia) ' +
    'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)',
    [fila.quien, fila.correo, JSON.stringify(fila.orden), JSON.stringify(fila.porque),
     fila.peor, fila.peorPorque, fila.memoria, fila.libre,
     fila.ocupacion, fila.ocupacionDetalle, fila.aceptaInfo, JSON.stringify(fila.vistos),
     fila.finalista, fila.finalistaPorque, fila.sugerencia]
  );
}

async function leerTodas() {
  if (!pool) return memoria;
  const r = await pool.query(
    'SELECT id, quien, correo, orden, porque, peor, peor_porque, memoria, libre, creado, excluida, excluida_en, ' +
    'ocupacion, ocupacion_detalle, acepta_info, vistos, finalista, finalista_porque, sugerencia ' +
    'FROM respuestas ORDER BY id');
  // La base usa snake_case; el resto del código habla camelCase.
  r.rows.forEach(f => {
    f.peorPorque = f.peor_porque;
    f.excluida = !!f.excluida;
    f.excluidaEn = f.excluida_en;
    f.ocupacionDetalle = f.ocupacion_detalle;
    f.aceptaInfo = !!f.acepta_info;
    f.finalistaPorque = f.finalista_porque;
  });
  return r.rows;
}

async function cambiarExclusion(id, excluida) {
  if (!pool) {
    const fila = memoria.find(f => f.id === id);
    if (!fila) return null;
    fila.excluida = excluida;
    fila.excluidaEn = excluida ? new Date() : null;
    return fila;
  }
  const r = await pool.query(
    'UPDATE respuestas SET excluida = $1, excluida_en = CASE WHEN $1 THEN now() ELSE NULL END ' +
    'WHERE id = $2 RETURNING id, excluida, excluida_en',
    [excluida, id]
  );
  return r.rows[0] || null;
}

// Para siempre: a diferencia de excluir, esto no se puede deshacer.
async function borrar(id) {
  if (!pool) {
    const i = memoria.findIndex(f => f.id === id);
    if (i === -1) return false;
    memoria.splice(i, 1);
    return true;
  }
  const r = await pool.query('DELETE FROM respuestas WHERE id = $1', [id]);
  return r.rowCount > 0;
}

/* ---------- candidatos ---------- */

async function leerCandidatos() {
  if (!pool) return memCandidatos;
  const r = await pool.query('SELECT id, nombre, activo, alias FROM candidatos ORDER BY id');
  r.rows.forEach(c => { c.alias = Array.isArray(c.alias) ? c.alias : []; });
  return r.rows;
}

async function agregarCandidato(nombre) {
  if (!pool) {
    const c = { id: Math.max(0, ...memCandidatos.map(x => x.id)) + 1, nombre, activo: true, alias: [] };
    memCandidatos.push(c);
    return c;
  }
  const r = await pool.query(
    'INSERT INTO candidatos (nombre) VALUES ($1) RETURNING id, nombre, activo, alias', [nombre]);
  return r.rows[0];
}

// Renombrar conserva los votos: el nombre anterior queda como alias y las
// respuestas que lo traen se cuentan para el nombre nuevo.
async function renombrarCandidato(c, nombre) {
  const alias = c.alias.filter(a => a.toLowerCase() !== nombre.toLowerCase());
  if (c.nombre.toLowerCase() !== nombre.toLowerCase() &&
      !alias.some(a => a.toLowerCase() === c.nombre.toLowerCase())) {
    alias.push(c.nombre);
  }
  if (!pool) { c.nombre = nombre; c.alias = alias; return; }
  await pool.query('UPDATE candidatos SET nombre = $1, alias = $2 WHERE id = $3',
                   [nombre, JSON.stringify(alias), c.id]);
}

async function cambiarActivo(c, activo) {
  if (!pool) { c.activo = activo; return; }
  await pool.query('UPDATE candidatos SET activo = $1 WHERE id = $2', [activo, c.id]);
}

// Cada nombre actual y cada alias (sin importar mayúsculas) apuntan al nombre
// actual. Primero los actuales, para que un alias nunca le gane a un nombre vivo.
function mapaNombres(candidatos) {
  const m = new Map();
  candidatos.forEach(c => m.set(c.nombre.toLowerCase(), c.nombre));
  candidatos.forEach(c => c.alias.forEach(a => {
    if (!m.has(a.toLowerCase())) m.set(a.toLowerCase(), c.nombre);
  }));
  return n => m.get(String(n || '').trim().toLowerCase()) || null;
}

// Para la prueba de memoria: sin acentos ni mayúsculas. Quien escribe «Kavixi»
// por «Kávixi» sí se acordó del nombre; en el celular casi nadie pone acentos.
const llano = v => String(v || '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

const NOMBRE_OK = /^\p{L}[\p{L}\p{M}' -]{1,29}$/u;
const limpiarNombre = v => String(v || '').trim().replace(/\s+/g, ' ');

// Un nombre nuevo no puede repetir uno actual ni uno que otro candidato tuvo antes.
function choca(candidatos, nombre, propioId) {
  const n = nombre.toLowerCase();
  return candidatos.some(c => c.id !== propioId &&
    (c.nombre.toLowerCase() === n || c.alias.some(a => a.toLowerCase() === n)));
}

/* ---------- cálculo ---------- */

/** Borda: el 1er lugar vale TOP puntos, el último vale 1. */
function calcular(filas, candidatos) {
  const canon = mapaNombres(candidatos);
  const acc = {};
  candidatos.forEach(c => {
    acc[c.nombre] = { nombre: c.nombre, activo: c.activo, vistos: 0, puntos: 0, menciones: 0,
                      primeros: 0, sumaPos: 0, frases: [], descartes: 0, quejas: [],
                      finalistas: 0, razones: [] };
  });

  // Segunda vuelta: el único nombre que eligen ya sabiendo de qué es el proyecto.
  const final = { contestaron: 0, mismos: 0, cambios: [] };
  const sugerencias = [];

  const libres = [];
  const memoria = [];

  filas.forEach(f => {
    const quien = f.quien || 'Anónimo';
    const orden = Array.isArray(f.orden) ? f.orden : [];
    const porque = Array.isArray(f.porque) ? f.porque : [];
    const peor = canon(f.peor);

    // A quién le apareció cada nombre. Las respuestas viejas no lo guardaban:
    // vieron la lista original.
    const vistos = new Set((Array.isArray(f.vistos) ? f.vistos : ORIGINALES).map(canon));
    orden.forEach(n => vistos.add(canon(n)));
    vistos.add(peor);
    vistos.forEach(n => { if (acc[n]) acc[n].vistos += 1; });

    orden.forEach((nombre, p) => {
      const a = acc[canon(nombre)];
      if (!a) return;
      a.puntos += (TOP - p);
      a.menciones += 1;
      a.sumaPos += (p + 1);
      if (p === 0) a.primeros += 1;
      const frase = (porque[p] || '').trim();
      if (frase) a.frases.push({ quien, texto: frase, lugar: p + 1 });
    });

    if (acc[peor]) {
      acc[peor].descartes += 1;
      const queja = String(f.peorPorque || '').trim();
      if (queja) acc[peor].quejas.push({ quien, texto: queja });
    }

    // La memoria se compara con el nombre como lo vio la persona, aunque
    // después se haya renombrado.
    const escrito = String(f.memoria || '').trim();
    if (escrito && orden[0]) {
      memoria.push({
        quien,
        objetivo: orden[0],
        escrito,
        acierto: llano(escrito) === llano(orden[0])
      });
    }

    // lugar = dónde tenía ese nombre a ciegas (0: no estaba en su podio).
    const fin = canon(f.finalista);
    if (fin && acc[fin]) {
      const lugar = orden.map(canon).indexOf(fin) + 1;
      const razon = String(f.finalistaPorque || '').trim();
      acc[fin].finalistas += 1;
      acc[fin].razones.push({ quien, texto: razon, lugar });
      final.contestaron += 1;
      if (lugar === 1) final.mismos += 1;
      else final.cambios.push({ quien, de: canon(orden[0]) || orden[0] || '', a: fin, lugar, texto: razon });
    }

    const libre = (f.libre || '').trim();
    if (libre) libres.push({ quien, texto: libre });

    const idea = String(f.sugerencia || '').trim();
    if (idea) sugerencias.push({ quien, texto: idea });
  });

  const tabla = candidatos.map(c => {
    const a = acc[c.nombre];
    return {
      nombre: a.nombre,
      activo: a.activo,
      vistos: a.vistos,
      puntos: a.puntos,
      // Promedio entre quienes lo vieron: un nombre agregado a media encuesta
      // no se castiga por las respuestas que llegaron antes de que existiera.
      promedio: a.vistos ? Math.round((a.puntos / a.vistos) * 100) / 100 : 0,
      menciones: a.menciones,
      cobertura: a.vistos ? Math.round((a.menciones / a.vistos) * 100) : 0,
      primeros: a.primeros,
      posMedia: a.menciones ? Math.round((a.sumaPos / a.menciones) * 10) / 10 : null,
      frases: a.frases,
      descartes: a.descartes,
      quejas: a.quejas,
      finalistas: a.finalistas,
      razones: a.razones
    };
  }).sort((x, y) => y.promedio - x.promedio || y.puntos - x.puntos || y.menciones - x.menciones);

  const aciertos = memoria.filter(m => m.acierto).length;
  return {
    respuestas: filas.length, top: TOP, tabla, libres, final, sugerencias,
    memoria: {
      intentos: memoria.length,
      aciertos,
      // El dato que importa: cuántos NO supieron escribir su propio favorito.
      fallos: memoria.filter(m => !m.acierto),
      // Y la lista completa, para ver qué escribió cada quien.
      lista: memoria
    }
  };
}

function respuestaPublica(f) {
  return {
    id: f.id,
    creado: f.creado,
    quien: f.quien || 'Anónimo',
    correo: f.correo || '',
    orden: Array.isArray(f.orden) ? f.orden : [],
    porque: Array.isArray(f.porque) ? f.porque : [],
    peor: f.peor || '',
    peorPorque: f.peorPorque || '',
    memoria: f.memoria || '',
    finalista: f.finalista || '',
    finalistaPorque: f.finalistaPorque || '',
    sugerencia: f.sugerencia || '',
    libre: f.libre || '',
    ocupacion: f.ocupacion || '',
    ocupacionNombre: nombreOcupacion(f.ocupacion),
    ocupacionDetalle: f.ocupacionDetalle || '',
    aceptaInfo: !!f.aceptaInfo,
    excluida: !!f.excluida,
    excluidaEn: f.excluidaEn || null
  };
}

/* ---------- rutas ---------- */

app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

const pagina = (_req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html'));
app.get('/', pagina);
app.get('/resultados', pagina);

app.get('/api/config', async (_req, res) => {
  try {
    const candidatos = (await leerCandidatos()).filter(c => c.activo).map(c => c.nombre);
    res.json({ candidatos, top: TOP, obligatorias: OBLIGATORIAS, ocupaciones: OCUPACIONES,
               proyecto: PROYECTO });
  } catch (err) {
    console.error('[error] al leer candidatos:', err.message);
    res.status(500).json({ error: 'No se pudo cargar la lista.' });
  }
});

app.post('/api/respuesta', async (req, res) => {
  try {
    const b = req.body || {};
    const candidatos = await leerCandidatos();
    const canon = mapaNombres(candidatos);

    // No confiamos en el cliente. Y si viene mal, se rechaza en vez de
    // "repararse": una lista con repetidos o nombres inventados es una
    // respuesta rota, y adivinar qué quiso decir sería inventar datos.
    const crudo = (Array.isArray(b.orden) ? b.orden : []).map(x => String(x || '').trim());

    if (crudo.length !== TOP) {
      return res.status(400).json({ error: 'Faltan lugares por elegir.' });
    }
    // Se acepta cualquier nombre conocido, aunque lo hayan ocultado o renombrado
    // mientras la persona contestaba. Se guarda como lo vio: la prueba de memoria
    // compara contra eso, y el conteo lo lleva al nombre actual por su alias.
    const actuales = crudo.map(canon);
    if (actuales.some(n => !n)) {
      return res.status(400).json({ error: 'Hay un nombre que no está en la lista.' });
    }
    if (new Set(actuales).size !== TOP) {
      return res.status(400).json({ error: 'Hay un nombre repetido.' });
    }
    const orden = crudo;

    const quien = String(b.quien || '').trim().slice(0, 80);
    if (!quien) return res.status(400).json({ error: 'Falta tu nombre.' });

    // Opcional, pero si viene tiene que parecer un correo.
    const correo = String(b.correo || '').trim().slice(0, 120);
    if (correo && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(correo)) {
      return res.status(400).json({ error: 'Ese correo no se ve bien.' });
    }

    const porque = orden.map((_, i) =>
      String((Array.isArray(b.porque) ? b.porque[i] : '') || '').slice(0, 400));

    for (let i = 0; i < OBLIGATORIAS; i++) {
      if (!porque[i].trim()) {
        return res.status(400).json({ error: `Falta decir qué vende «${orden[i]}».` });
      }
    }

    // El cliente exige estos; el servidor solo cuida que el dato sea sano.
    const peor = String(b.peor || '').trim();
    if (peor && !canon(peor)) {
      return res.status(400).json({ error: 'El descartado no está en la lista.' });
    }

    // Opcional para el servidor: quien tenía la encuesta abierta desde antes de
    // este paso manda sin finalista, y su respuesta sigue valiendo.
    const finalista = String(b.finalista || '').trim();
    if (finalista && !canon(finalista)) {
      return res.status(400).json({ error: 'El finalista no está en la lista.' });
    }

    const ocupacion = String(b.ocupacion || '').trim();
    if (ocupacion && !OCUPACIONES.some(o => o.id === ocupacion)) {
      return res.status(400).json({ error: 'Esa ocupación no está en la lista.' });
    }

    // Permiso explícito para mandar información: sin correo no hay a dónde.
    const aceptaInfo = b.aceptaInfo === true;
    if (aceptaInfo && !correo) {
      return res.status(400).json({ error: 'Para mandarte información necesito tu correo.' });
    }

    // Qué nombres le aparecieron; si no llega, los visibles en este momento.
    const vistos = [...new Set((Array.isArray(b.vistos) ? b.vistos : []).map(canon).filter(Boolean))];

    await guardar({
      quien,
      correo,
      orden,
      porque,
      peor,
      peorPorque: String(b.peorPorque || '').trim().slice(0, 400),
      memoria: String(b.memoria || '').trim().slice(0, 80),
      finalista,
      finalistaPorque: finalista ? String(b.finalistaPorque || '').trim().slice(0, 400) : '',
      sugerencia: String(b.sugerencia || '').trim().replace(/\s+/g, ' ').slice(0, 60),
      libre: String(b.libre || '').trim().slice(0, 600),
      ocupacion,
      ocupacionDetalle: String(b.ocupacionDetalle || '').trim().slice(0, 160),
      aceptaInfo,
      vistos: vistos.length ? vistos : candidatos.filter(c => c.activo).map(c => c.nombre)
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('[error] al guardar:', err.message);
    res.status(500).json({ error: 'No se pudo guardar. Intenta otra vez.' });
  }
});

// La clave que genera Render trae '+', '/' y '=' (es base64). En una query
// string el '+' se decodifica como espacio, así que una clave pegada tal cual
// nunca coincidía. Aceptamos las dos formas: la literal y la que trae espacios
// donde iban los '+'.
function claveOk(cruda) {
  const v = String(cruda || '');
  return v === CLAVE || v.replace(/ /g, '+') === CLAVE;
}

app.get('/api/resultados', async (req, res) => {
  if (!claveOk(req.query.clave)) {
    return res.status(403).json({ error: 'Clave incorrecta.' });
  }
  try {
    const [todasSinFiltro, candidatos] = await Promise.all([leerTodas(), leerCandidatos()]);

    // Cuántas respuestas activas hay de cada ocupación, para el filtro.
    const porOcupacion = {};
    todasSinFiltro.filter(f => !f.excluida).forEach(f => {
      const k = f.ocupacion || 'sin';
      porOcupacion[k] = (porOcupacion[k] || 0) + 1;
    });

    // Con filtro, toda la página habla solo de esa ocupación.
    const filtro = String(req.query.ocupacion || '');
    const todas = filtro
      ? todasSinFiltro.filter(f => (f.ocupacion || 'sin') === filtro)
      : todasSinFiltro;
    const activas = todas.filter(f => !f.excluida);

    res.json({
      ...calcular(activas, candidatos),
      total: todas.length,
      activas: activas.length,
      excluidas: todas.length - activas.length,
      filtro,
      ocupaciones: OCUPACIONES.map(o => ({ id: o.id, nombre: o.nombre })),
      porOcupacion,
      candidatos: candidatos.map(c => ({ id: c.id, nombre: c.nombre, activo: c.activo, alias: c.alias })),
      respuestasIndividuales: todas.map(respuestaPublica).reverse()
    });
  } catch (err) {
    console.error('[error] al leer:', err.message);
    res.status(500).json({ error: 'No se pudieron leer las respuestas.' });
  }
});

app.post('/api/respuesta/:id/exclusion', async (req, res) => {
  if (!claveOk(req.query.clave)) return res.status(403).json({ error: 'Clave incorrecta.' });
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Respuesta inválida.' });
  }
  const excluida = !!(req.body && req.body.excluida);
  try {
    const fila = await cambiarExclusion(id, excluida);
    if (!fila) return res.status(404).json({ error: 'Respuesta no encontrada.' });
    res.json({ ok: true, id, excluida: !!fila.excluida });
  } catch (err) {
    console.error('[error] al cambiar exclusion:', err.message);
    res.status(500).json({ error: 'No se pudo actualizar la respuesta.' });
  }
});

app.delete('/api/respuesta/:id', async (req, res) => {
  if (!claveOk(req.query.clave)) return res.status(403).json({ error: 'Clave incorrecta.' });
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Respuesta inválida.' });
  }
  try {
    if (!(await borrar(id))) return res.status(404).json({ error: 'Respuesta no encontrada.' });
    res.json({ ok: true, id });
  } catch (err) {
    console.error('[error] al borrar:', err.message);
    res.status(500).json({ error: 'No se pudo borrar la respuesta.' });
  }
});

// Agregar un nombre a la encuesta.
app.post('/api/candidatos', async (req, res) => {
  if (!claveOk(req.query.clave)) return res.status(403).json({ error: 'Clave incorrecta.' });
  const nombre = limpiarNombre(req.body && req.body.nombre);
  if (!NOMBRE_OK.test(nombre)) {
    return res.status(400).json({ error: 'El nombre debe tener de 2 a 30 letras.' });
  }
  try {
    const candidatos = await leerCandidatos();
    if (choca(candidatos, nombre, null)) {
      return res.status(409).json({ error: `«${nombre}» ya está (o estuvo) en la lista.` });
    }
    const c = await agregarCandidato(nombre);
    res.json({ ok: true, candidato: c });
  } catch (err) {
    console.error('[error] al agregar candidato:', err.message);
    res.status(500).json({ error: 'No se pudo agregar el nombre.' });
  }
});

// Renombrar ({ nombre }) u ocultar / mostrar ({ activo }).
app.post('/api/candidatos/:id', async (req, res) => {
  if (!claveOk(req.query.clave)) return res.status(403).json({ error: 'Clave incorrecta.' });
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Nombre inválido.' });
  }
  const b = req.body || {};
  try {
    const candidatos = await leerCandidatos();
    const c = candidatos.find(x => x.id === id);
    if (!c) return res.status(404).json({ error: 'Ese nombre no existe.' });

    if (typeof b.nombre === 'string') {
      const nombre = limpiarNombre(b.nombre);
      if (!NOMBRE_OK.test(nombre)) {
        return res.status(400).json({ error: 'El nombre debe tener de 2 a 30 letras.' });
      }
      if (choca(candidatos, nombre, c.id)) {
        return res.status(409).json({ error: `«${nombre}» ya está (o estuvo) en la lista.` });
      }
      if (nombre !== c.nombre) await renombrarCandidato(c, nombre);
    }

    if (typeof b.activo === 'boolean' && b.activo !== c.activo) {
      // Hacen falta TOP para el podio y uno más para poder descartar.
      if (!b.activo && candidatos.filter(x => x.activo).length <= TOP + 1) {
        return res.status(400).json({ error: `Deben quedar al menos ${TOP + 1} nombres visibles.` });
      }
      await cambiarActivo(c, b.activo);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[error] al cambiar candidato:', err.message);
    res.status(500).json({ error: 'No se pudo cambiar el nombre.' });
  }
});

// Descarga en CSV, por si quieres meterlo a una hoja.
app.get('/api/csv', async (req, res) => {
  if (!claveOk(req.query.clave)) return res.status(403).send('Clave incorrecta.');
  const filas = (await leerTodas()).filter(f => !f.excluida);
  const celda = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';

  const cab = ['fecha', 'quien', 'correo'];
  for (let i = 1; i <= TOP; i++) cab.push('lugar_' + i);
  for (let i = 1; i <= TOP; i++) cab.push('vende_' + i);
  cab.push('descarta', 'por_que_descarta', 'escribio_de_memoria', 'acerto', 'libre');
  // Al final, para no mover las columnas de quien ya importaba el CSV.
  cab.push('ocupacion', 'a_que_se_dedica', 'acepta_info');
  cab.push('finalista', 'por_que_finalista', 'finalista_era_su_1', 'sugiere_otro_nombre');

  const lineas = [cab.join(',')];
  filas.forEach(f => {
    const orden = Array.isArray(f.orden) ? f.orden : [];
    const porque = Array.isArray(f.porque) ? f.porque : [];
    const fila = [f.creado ? new Date(f.creado).toISOString() : '', f.quien, f.correo];
    for (let i = 0; i < TOP; i++) fila.push(orden[i] || '');
    for (let i = 0; i < TOP; i++) fila.push(porque[i] || '');
    const escrito = String(f.memoria || '').trim();
    fila.push(f.peor || '', f.peorPorque || '', escrito,
              escrito && orden[0]
                ? (llano(escrito) === llano(orden[0]) ? 'sí' : 'no')
                : '');
    fila.push(f.libre || '');
    fila.push(nombreOcupacion(f.ocupacion), f.ocupacionDetalle || '', f.aceptaInfo ? 'sí' : 'no');
    const fin = String(f.finalista || '').trim();
    fila.push(fin, f.finalistaPorque || '',
              fin && orden[0]
                ? (fin.toLowerCase() === String(orden[0]).toLowerCase() ? 'sí' : 'no')
                : '');
    fila.push(f.sugerencia || '');
    lineas.push(fila.map(celda).join(','));
  });

  res.type('text/csv').attachment('respuestas.csv').send('﻿' + lineas.join('\n'));
});

app.get('/salud', (_req, res) => res.json({ ok: true, base: !!pool }));

/* ---------- arranque ---------- */

module.exports = app;
prepararBase()
  .catch(err => { console.error('[error] preparando la base:', err.message); })
  .finally(() => {
    app.listen(PORT, () => console.log(`Encuesta escuchando en :${PORT}`));
  });
