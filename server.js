import { createServer } from 'node:http';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const { DATABASE_URL, APP_ADMIN_KEY, PORT = '3000', HOST = '0.0.0.0' } = process.env;
if (!DATABASE_URL || !APP_ADMIN_KEY || APP_ADMIN_KEY.length < 16) {
  throw new Error('Configura DATABASE_URL y APP_ADMIN_KEY (16 caracteres o más).');
}
const screenKey = createHmac('sha256', APP_ADMIN_KEY).update('pantalla').digest('base64url');
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 10, connectionTimeoutMillis: 5000 });
const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const audioTypes = new Map(Object.entries({
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', mp4: 'audio/mp4',
  ogg: 'audio/ogg', opus: 'audio/ogg', aac: 'audio/aac', webm: 'audio/webm', flac: 'audio/flac'
}));
const imageTypes = new Map(Object.entries({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }));
const files = new Map(await Promise.all(Object.entries({
  '/': ['home.html', 'text/html'], '/admin': ['admin.html', 'text/html'],
  '/pantalla': ['screen.html', 'text/html'], '/screen.js': ['screen.js', 'text/javascript'],
  '/admin.js': ['admin.js', 'text/javascript'], '/admin.css': ['admin.css', 'text/css'],
  '/wallpaper.webp': ['wallpaper.webp', 'image/webp'], '/ringtone.mp3': ['ringtone.mp3', 'audio/mpeg']
}).map(async ([path, [name, type]]) => [path, { type, bytes: await readFile(new URL('./public/' + name, import.meta.url)) }])));

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function hasKey(req, key) {
  const actual = Buffer.from(req.headers.authorization || '');
  const expected = Buffer.from('Bearer ' + key);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readBody(req, max) {
  if (Number(req.headers['content-length']) > max) {
    req.resume();
    throw new HttpError(413, 'El archivo supera el tamaño permitido.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > max) {
      req.resume();
      throw new HttpError(413, 'El archivo supera el tamaño permitido.');
    }
    chunks.push(chunk);
  }
  if (size === 0) throw new HttpError(400, 'El archivo está vacío.');
  return Buffer.concat(chunks, size);
}

async function readJson(req) {
  const data = await readBody(req, 4096);
  try {
    return JSON.parse(data.toString());
  } catch {
    throw new HttpError(400, 'Datos inválidos.');
  }
}

function nameFrom(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 100) throw new HttpError(400, 'Usa un nombre de 1 a 100 caracteres.');
  return name;
}

// Todas las acciones de la cola adquieren el mismo bloqueo. Dos clics simultáneos
// se resuelven en orden y una respuesta atrasada no afecta a otro intento.
async function withRoom(action) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT id FROM room WHERE id = 1 FOR UPDATE');
    await db.query(`
      UPDATE room SET phase = CASE phase WHEN 'snoozed' THEN 'ringing' ELSE 'interrupted' END,
        attempt = CASE phase WHEN 'snoozed' THEN gen_random_uuid() ELSE attempt END,
        deadline = NULL
      WHERE id = 1 AND deadline <= now() AND phase IN ('snoozed', 'playing')
    `);
    const { rows: [room] } = await db.query('SELECT * FROM room WHERE id = 1');
    const data = await action(db, room);
    await db.query('COMMIT');
    return data;
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    db.release();
  }
}

async function state(db, room, admin) {
  const { rows: [active] } = await db.query('SELECT name, media_id FROM tracks WHERE id = $1', [room.track_id]);
  const output = {
    phase: room.phase, attempt: room.attempt, deadline: room.deadline,
    name: active?.name ?? null,
    audio: active ? '/media/' + active.media_id : null,
    wallpaper: room.wallpaper ? '/media/' + room.wallpaper : null
  };
  if (admin) {
    const { rows } = await db.query('SELECT id, name, position, media_id, played_at FROM tracks ORDER BY position');
    output.tracks = rows;
    output.screenPath = '/pantalla#' + screenKey;
    output.activeId = room.track_id;
  }
  return output;
}

async function launch(db, room) {
  if (['ringing', 'playing', 'snoozed'].includes(room.phase)) {
    throw new HttpError(409, 'Ya hay una llamada en curso o pospuesta.');
  }
  const { rows: [next] } = await db.query('SELECT id FROM tracks WHERE played_at IS NULL ORDER BY position LIMIT 1');
  if (!next) throw new HttpError(409, 'Ya se reprodujeron todos los audios de la lista.');
  await db.query("UPDATE room SET track_id = $1, attempt = $2, phase = 'ringing', deadline = NULL WHERE id = 1",
    [next.id, randomUUID()]);
  return { ok: true };
}

async function screenAction(db, room, body) {
  const { action, attempt } = body ?? {};
  if (!uuid.test(attempt || '')) throw new HttpError(400, 'Identificador de llamada inválido.');
  if (action === 'ended') {
    const { rowCount } = await db.query('SELECT 1 FROM tracks WHERE played_attempt = $1', [attempt]);
    if (rowCount) return { ok: true };
  }
  if (room.attempt !== attempt) throw new HttpError(409, 'La llamada cambió.');
  if (room.phase === 'ringing') {
    if (action === 'answer') {
      await db.query("UPDATE room SET phase = 'playing', deadline = now() + interval '45 seconds' WHERE id = 1");
    } else if (action === 'reject') {
      await db.query("UPDATE room SET phase = 'rejected', deadline = NULL WHERE id = 1");
    } else if (action === 'snooze') {
      await db.query("UPDATE room SET phase = 'snoozed', deadline = now() + interval '5 seconds' WHERE id = 1");
    } else {
      throw new HttpError(409, 'La llamada está sonando.');
    }
  } else if (room.phase === 'playing' && action === 'heartbeat') {
    await db.query("UPDATE room SET deadline = now() + interval '45 seconds' WHERE id = 1");
  } else if (['playing', 'interrupted'].includes(room.phase) && action === 'ended') {
    await db.query('UPDATE tracks SET played_at = now(), played_attempt = $2 WHERE id = $1 AND played_at IS NULL',
      [room.track_id, attempt]);
    await db.query("UPDATE room SET phase = 'waiting', track_id = NULL, attempt = NULL, deadline = NULL WHERE id = 1");
  } else if (room.phase === 'playing' && action === 'failed') {
    await db.query("UPDATE room SET phase = 'interrupted', deadline = NULL WHERE id = 1");
  } else {
    throw new HttpError(409, 'Esta acción ya no está disponible.');
  }
  return { ok: true };
}

async function moveTrack(db, room, id, direction) {
  if (!uuid.test(id || '') || !['up', 'down'].includes(direction)) throw new HttpError(400, 'Movimiento inválido.');
  if (['ringing', 'playing', 'snoozed'].includes(room.phase)) throw new HttpError(409, 'Espera a que termine la llamada.');
  const { rows } = await db.query('SELECT id, position FROM tracks WHERE played_at IS NULL ORDER BY position');
  const index = rows.findIndex(track => track.id === id);
  const other = rows[index + (direction === 'up' ? -1 : 1)];
  if (index < 0 || !other) throw new HttpError(409, 'No se puede mover este audio.');
  const current = rows[index];
  await db.query('UPDATE tracks SET position = (SELECT max(position) + 1 FROM tracks) WHERE id = $1', [current.id]);
  await db.query('UPDATE tracks SET position = $2 WHERE id = $1', [other.id, current.position]);
  await db.query('UPDATE tracks SET position = $2 WHERE id = $1', [current.id, other.position]);
  return { ok: true };
}

async function upload(req, url, kind) {
  const extension = url.searchParams.get('extension')?.toLowerCase();
  const audio = kind === 'audio';
  const mime = (audio ? audioTypes : imageTypes).get(extension);
  if (!mime) throw new HttpError(415, audio ? 'Formato de audio inválido. Prueba con MP3 o WAV.' : 'Usa una imagen JPG, PNG o WebP.');
  const name = audio ? nameFrom(url.searchParams.get('name')) : null;
  const bytes = await readBody(req, (audio ? 32 : 10) * 1024 * 1024);
  const digest = createHash('sha256').update(mime).update(bytes).digest('hex');
  return withRoom(async db => {
    await db.query('INSERT INTO media VALUES ($1, $2, $3, $4) ON CONFLICT (digest) DO NOTHING',
      [randomUUID(), mime, bytes, digest]);
    const { rows: [{ id }] } = await db.query('SELECT id FROM media WHERE digest = $1', [digest]);
    if (!audio) {
      await db.query('UPDATE room SET wallpaper = $1 WHERE id = 1', [id]);
      return { url: '/media/' + id };
    }
    const { rowCount } = await db.query(`
      INSERT INTO tracks (id, media_id, name, position)
      SELECT $1, $2, $3, coalesce(max(position), 0) + 1 FROM tracks
      ON CONFLICT (media_id) DO NOTHING
    `, [randomUUID(), id, name]);
    return { url: '/media/' + id, alreadyAdded: rowCount === 0 };
  });
}

async function media(req, res, id) {
  if (!uuid.test(id)) throw new HttpError(404, 'Archivo no encontrado.');
  const { rows: [file] } = await pool.query('SELECT mime, octet_length(bytes) AS size FROM media WHERE id = $1', [id]);
  if (!file) throw new HttpError(404, 'Archivo no encontrado.');
  let start = 0;
  let end = file.size - 1;
  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match && (match[1] || match[2])) {
      start = match[1] ? Number(match[1]) : Math.max(0, file.size - Number(match[2]));
      if (match[1] && match[2]) end = Math.min(end, Number(match[2]));
    }
    if (!match || (!match[1] && !match[2]) || start >= file.size || end < start) {
      res.writeHead(416, { 'Content-Range': 'bytes */' + file.size }).end();
      return;
    }
  }
  const length = end - start + 1;
  const headers = { 'Content-Type': file.mime, 'Accept-Ranges': 'bytes', 'Content-Length': length,
    'Cache-Control': 'private, max-age=3600', 'Content-Security-Policy': "default-src 'none'; sandbox" };
  if (range) headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + file.size;
  if (req.method === 'HEAD') {
    res.writeHead(range ? 206 : 200, headers).end();
    return;
  }
  const { rows: [part] } = await pool.query('SELECT substring(bytes FROM $2 FOR $3) AS bytes FROM media WHERE id = $1',
    [id, start + 1, length]);
  res.writeHead(range ? 206 : 200, headers).end(part.bytes);
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const { pathname: path } = url;
  const method = req.method;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");

  if (method === 'GET' && path === '/health') {
    await pool.query('SELECT 1');
    return json(res, 200, { ok: true });
  }
  if (method === 'GET' && files.has(path)) {
    const file = files.get(path);
    const type = file.type.startsWith('text/') ? file.type + '; charset=utf-8' : file.type;
    return res.writeHead(200, { 'Content-Type': type, 'Content-Length': file.bytes.length }).end(file.bytes);
  }
  if ((method === 'GET' || method === 'HEAD') && path.startsWith('/media/')) {
    return media(req, res, path.slice('/media/'.length));
  }
  if (path.startsWith('/api/admin/')) {
    if (!hasKey(req, APP_ADMIN_KEY)) throw new HttpError(401, 'Clave de administración incorrecta.');
    if (method === 'GET' && path === '/api/admin/state') return json(res, 200, await withRoom((db, room) => state(db, room, true)));
    if (method === 'POST' && path === '/api/admin/launch') return json(res, 200, await withRoom(launch));
    if (method === 'POST' && path === '/api/admin/move') {
      const { id, direction } = await readJson(req) ?? {};
      return json(res, 200, await withRoom((db, room) => moveTrack(db, room, id, direction)));
    }
    if (method === 'POST' && path === '/api/admin/rename') {
      const { id, name } = await readJson(req) ?? {};
      if (!uuid.test(id || '')) throw new HttpError(400, 'Identificador inválido.');
      const updated = await pool.query('UPDATE tracks SET name = $2 WHERE id = $1', [id, nameFrom(name)]);
      if (!updated.rowCount) throw new HttpError(404, 'Audio no encontrado.');
      return json(res, 200, { ok: true });
    }
    if (method === 'POST' && path === '/api/admin/audio') return json(res, 201, await upload(req, url, 'audio'));
    if (method === 'POST' && path === '/api/admin/background') return json(res, 201, await upload(req, url, 'background'));
  }
  if (path.startsWith('/api/screen/')) {
    if (!hasKey(req, screenKey)) throw new HttpError(401, 'Abre el enlace de proyección desde Administración.');
    if (method === 'GET' && path === '/api/screen/state') return json(res, 200, await withRoom((db, room) => state(db, room, false)));
    if (method === 'POST' && path === '/api/screen/action') {
      const body = await readJson(req);
      return json(res, 200, await withRoom((db, room) => screenAction(db, room, body)));
    }
  }
  throw new HttpError(404, 'Página no encontrada.');
}

const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
for (let attempt = 0; ; attempt++) {
  try {
    await pool.query(schema);
    break;
  } catch (error) {
    if (attempt === 19) throw error;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}

createServer((req, res) => route(req, res).catch(error => {
  if (res.headersSent || res.destroyed) return res.end();
  if (!error.status) console.error('Error del servidor:', error.code || error.name);
  json(res, error.status || 500, { error: error.status ? error.message : 'Error del servidor. Vuelve a intentar.' });
})).listen(Number(PORT), HOST, () => console.log('Llamada para proyectar lista.'));
