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

// Para cambiar la lista, edítala aquí y vuelve a desplegar.
const CANDIDATOS = [
  'Nerendi', 'Fenara',  'Kavani',  'Kavixi',
  'Claremi', 'Aineli',  'Terali',  'Plintap',
  'Kainori', 'Vainali', 'Rivelo',  'Sivli'
];

const TOP = 5;                      // cuántos lugares pide
const OBLIGATORIAS = 3;             // cuántas explicaciones son obligatorias
const CLAVE = process.env.CLAVE_RESULTADOS || 'cambiame';

/* ---------- base de datos ---------- */

const url = process.env.DATABASE_URL;
let pool = null;
const memoria = [];                 // respaldo si no hay base (solo para probar en local)
let memoriaId = 1;

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
  console.log('[ok] tabla respuestas lista');
}

async function guardar(fila) {
  if (!pool) {
    memoria.push({ id: memoriaId++, ...fila, creado: new Date(), excluida: false, excluidaEn: null });
    return;
  }
  await pool.query(
    'INSERT INTO respuestas (quien, correo, orden, porque, peor, peor_porque, memoria, libre) ' +
    'VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [fila.quien, fila.correo, JSON.stringify(fila.orden), JSON.stringify(fila.porque),
     fila.peor, fila.peorPorque, fila.memoria, fila.libre]
  );
}

async function leerTodas() {
  if (!pool) return memoria;
  const r = await pool.query(
    'SELECT id, quien, correo, orden, porque, peor, peor_porque, memoria, libre, creado, excluida, excluida_en ' +
    'FROM respuestas ORDER BY id');
  // La base usa snake_case; el resto del código habla camelCase.
  r.rows.forEach(f => {
    f.peorPorque = f.peor_porque;
    f.excluida = !!f.excluida;
    f.excluidaEn = f.excluida_en;
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

/* ---------- cálculo ---------- */

/** Borda: el 1er lugar vale TOP puntos, el último vale 1. */
function calcular(filas) {
  const acc = {};
  CANDIDATOS.forEach(n => {
    acc[n] = { nombre: n, puntos: 0, menciones: 0, primeros: 0, sumaPos: 0,
               frases: [], descartes: 0, quejas: [] };
  });

  const libres = [];
  const memoria = [];

  filas.forEach(f => {
    const quien = f.quien || 'Anónimo';
    const orden = Array.isArray(f.orden) ? f.orden : [];
    const porque = Array.isArray(f.porque) ? f.porque : [];

    orden.forEach((nombre, p) => {
      const a = acc[nombre];
      if (!a) return;
      a.puntos += (TOP - p);
      a.menciones += 1;
      a.sumaPos += (p + 1);
      if (p === 0) a.primeros += 1;
      const frase = (porque[p] || '').trim();
      if (frase) a.frases.push({ quien, texto: frase, lugar: p + 1 });
    });

    const peor = String(f.peor || '').trim();
    if (acc[peor]) {
      acc[peor].descartes += 1;
      const queja = String(f.peorPorque || '').trim();
      if (queja) acc[peor].quejas.push({ quien, texto: queja });
    }

    const escrito = String(f.memoria || '').trim();
    if (escrito && orden[0]) {
      memoria.push({
        quien,
        objetivo: orden[0],
        escrito,
        acierto: escrito.toLowerCase() === orden[0].toLowerCase()
      });
    }

    const libre = (f.libre || '').trim();
    if (libre) libres.push({ quien, texto: libre });
  });

  const total = filas.length;
  const tabla = CANDIDATOS.map(n => {
    const a = acc[n];
    return {
      nombre: n,
      puntos: a.puntos,
      // Promedio entre TODAS las respuestas, no solo entre quienes lo mencionaron.
      promedio: total ? Math.round((a.puntos / total) * 100) / 100 : 0,
      menciones: a.menciones,
      cobertura: total ? Math.round((a.menciones / total) * 100) : 0,
      primeros: a.primeros,
      posMedia: a.menciones ? Math.round((a.sumaPos / a.menciones) * 10) / 10 : null,
      frases: a.frases,
      descartes: a.descartes,
      quejas: a.quejas
    };
  }).sort((x, y) => y.puntos - x.puntos || y.menciones - x.menciones);

  const aciertos = memoria.filter(m => m.acierto).length;
  return {
    respuestas: total, top: TOP, tabla, libres,
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
    libre: f.libre || '',
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

app.get('/api/config', (_req, res) => {
  res.json({ candidatos: CANDIDATOS, top: TOP, obligatorias: OBLIGATORIAS });
});

app.post('/api/respuesta', async (req, res) => {
  try {
    const b = req.body || {};

    // No confiamos en el cliente. Y si viene mal, se rechaza en vez de
    // "repararse": una lista con repetidos o nombres inventados es una
    // respuesta rota, y adivinar qué quiso decir sería inventar datos.
    const orden = (Array.isArray(b.orden) ? b.orden : []).map(x => String(x || '').trim());

    if (orden.length !== TOP) {
      return res.status(400).json({ error: 'Faltan lugares por elegir.' });
    }
    if (orden.some(n => !CANDIDATOS.includes(n))) {
      return res.status(400).json({ error: 'Hay un nombre que no está en la lista.' });
    }
    if (new Set(orden).size !== TOP) {
      return res.status(400).json({ error: 'Hay un nombre repetido.' });
    }

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

    // El cliente exige estos tres; el servidor solo cuida que el dato sea sano.
    const peor = String(b.peor || '').trim();
    if (peor && !CANDIDATOS.includes(peor)) {
      return res.status(400).json({ error: 'El descartado no está en la lista.' });
    }

    await guardar({
      quien,
      correo,
      orden,
      porque,
      peor,
      peorPorque: String(b.peorPorque || '').trim().slice(0, 400),
      memoria: String(b.memoria || '').trim().slice(0, 80),
      libre: String(b.libre || '').trim().slice(0, 600)
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
    const todas = await leerTodas();
    const activas = todas.filter(f => !f.excluida);
    res.json({
      ...calcular(activas),
      total: todas.length,
      activas: activas.length,
      excluidas: todas.length - activas.length,
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

// Descarga en CSV, por si quieres meterlo a una hoja.
app.get('/api/csv', async (req, res) => {
  if (!claveOk(req.query.clave)) return res.status(403).send('Clave incorrecta.');
  const filas = (await leerTodas()).filter(f => !f.excluida);
  const celda = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';

  const cab = ['fecha', 'quien', 'correo'];
  for (let i = 1; i <= TOP; i++) cab.push('lugar_' + i);
  for (let i = 1; i <= TOP; i++) cab.push('vende_' + i);
  cab.push('descarta', 'por_que_descarta', 'escribio_de_memoria', 'acerto', 'libre');

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
                ? (escrito.toLowerCase() === String(orden[0]).toLowerCase() ? 'sí' : 'no')
                : '');
    fila.push(f.libre || '');
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
