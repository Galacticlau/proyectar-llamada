import { createServer } from 'node:http';
import { createHash, createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import pg from 'pg';
import { videoStorage } from './video-storage.js';

const { DATABASE_URL, APP_ADMIN_KEY, PORT = '3000', HOST = '0.0.0.0' } = process.env;
if (!DATABASE_URL || !APP_ADMIN_KEY || APP_ADMIN_KEY.length < 16) {
  throw new Error('Configura DATABASE_URL y APP_ADMIN_KEY (16 caracteres o más).');
}
const rooms = [
  { id: 1, name: 'Sala anterior', adminKey: APP_ADMIN_KEY },
  ...['A', 'B', 'C'].map((letter, index) => ({
    id: index + 2, name: '4° Medio ' + letter, projectionPath: '/4' + letter,
    adminKey: process.env['APP_ADMIN_KEY_4' + letter]
  }))
].filter(room => room.adminKey);
const adminKeys = new Set(rooms.map(room => room.adminKey));
if (adminKeys.size !== rooms.length || rooms.some(room => room.adminKey.length < 16)) {
  throw new Error('Cada sala debe tener una clave distinta de al menos 16 caracteres.');
}
for (const room of rooms) {
  room.screenKey = createHmac('sha256', room.adminKey).update('pantalla').digest('base64url');
}
const roomsById = new Map(rooms.map(room => [room.id, room]));
const roomsByProjectionPath = new Map(rooms.filter(room => room.projectionPath).map(room => [room.projectionPath, room]));
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 10, connectionTimeoutMillis: 5000 });
const maxVideoBytes = 300 * 1024 * 1024;
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

async function* bodyChunks(req, max, tooLarge = 'El archivo supera el tamaño permitido.') {
  if (Number(req.headers['content-length']) > max) {
    req.resume();
    throw new HttpError(413, tooLarge);
  }
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > max) {
      req.resume();
      throw new HttpError(413, tooLarge);
    }
    yield chunk;
  }
  if (size === 0) throw new HttpError(400, 'El archivo está vacío.');
}

async function readBody(req, max) {
  const chunks = [];
  for await (const chunk of bodyChunks(req, max)) chunks.push(chunk);
  return Buffer.concat(chunks);
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

// Las acciones de una sala adquieren el bloqueo de su cola. Dos clics simultáneos
// se resuelven en orden y una respuesta atrasada no afecta a otro intento.
async function withRoom(roomId, action) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT id FROM room WHERE id = $1 FOR UPDATE', [roomId]);
    await db.query(`
      UPDATE room SET phase = CASE phase WHEN 'snoozed' THEN 'ringing' ELSE 'interrupted' END,
        attempt = CASE phase WHEN 'snoozed' THEN gen_random_uuid() ELSE attempt END,
        deadline = NULL
      WHERE id = $1 AND deadline <= now() AND phase IN ('snoozed', 'playing')
    `, [roomId]);
    await db.query(`
      UPDATE room SET preview_status = 'expired', preview_until = NULL
      WHERE id = $1 AND preview_until <= now()
    `, [roomId]);
    const { rows: [room] } = await db.query('SELECT * FROM room WHERE id = $1', [roomId]);
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

async function nextTrack(db, room) {
  const { rows: [track] } = await db.query(`
    SELECT id, media_id, name FROM tracks
    WHERE room_id = $1 AND played_at IS NULL AND id IS DISTINCT FROM $2::uuid
    ORDER BY position LIMIT 1
  `, [room.id, room.phase === 'playing' ? room.track_id : null]);
  return track;
}

function isPrepared(room, track) {
  return Boolean(track && room.prepared_media === track.media_id && room.prepared_until > new Date());
}

async function state(db, room, admin) {
  const { rows: [active] } = await db.query(
    'SELECT tracks.name, tracks.media_id, media.object_key FROM tracks JOIN media ON media.id = tracks.media_id WHERE tracks.id = $1 AND tracks.room_id = $2',
    [room.track_id, room.id]);
  const next = await nextTrack(db, room);
  const config = roomsById.get(room.id);
  const { rows: [previewTrack] } = room.preview_track ? await db.query(`
    SELECT tracks.name, tracks.media_id, media.object_key FROM tracks
    JOIN media ON media.id = tracks.media_id WHERE tracks.id = $1 AND tracks.room_id = $2
  `, [room.preview_track, room.id]) : { rows: [] };
  const preview = previewTrack ? {
    id: room.preview_id, name: previewTrack.name, mediaId: previewTrack.media_id,
    kind: previewTrack.object_key ? 'video' : 'audio', status: room.preview_status
  } : null;
  const output = {
    roomName: config.name,
    phase: room.phase, attempt: room.attempt, deadline: room.deadline,
    name: active?.name ?? null,
    audio: active ? '/media/' + active.media_id : null,
    mediaId: active?.media_id ?? null,
    nextMedia: next?.media_id ?? null,
    kind: active ? (active.object_key ? 'video' : 'audio') : null,
    wallpaper: room.wallpaper ? '/media/' + room.wallpaper : null,
    preview: admin || room.preview_until ? preview : null
  };
  if (admin) {
    const { rows } = await db.query(`
      SELECT tracks.id, name, position, media_id, played_at,
        CASE WHEN media.object_key IS NULL THEN 'audio' ELSE 'video' END AS kind
      FROM tracks JOIN media ON media.id = tracks.media_id WHERE tracks.room_id = $1 ORDER BY position
    `, [room.id]);
    output.tracks = rows;
    output.videoEnabled = Boolean(videoStorage);
    output.screenPath = (config.projectionPath || '/pantalla') + '#' + config.screenKey;
    output.canPairProjection = Boolean(config.projectionPath);
    output.activeId = room.track_id;
    output.preparation = next ? { name: next.name, ready: isPrepared(room, next) } : null;
  }
  return output;
}

async function launch(db, room) {
  if (room.preview_until) throw new HttpError(409, 'Detén la prueba en el proyector antes de llamar.');
  if (['ringing', 'playing', 'snoozed'].includes(room.phase)) {
    throw new HttpError(409, 'Ya hay una llamada en curso o pospuesta.');
  }
  const next = await nextTrack(db, room);
  if (!next) throw new HttpError(409, 'Ya se reprodujeron todas las grabaciones de la lista.');
  if (!isPrepared(room, next)) throw new HttpError(409, 'La pantalla de proyección todavía está preparando la próxima grabación.');
  await db.query(`
    UPDATE room SET track_id = $1, attempt = $2, phase = 'ringing', deadline = NULL,
      preview_id = NULL, preview_track = NULL, preview_status = NULL
    WHERE id = $3
  `,
    [next.id, randomUUID(), room.id]);
  return { ok: true };
}

async function startPreview(db, room, id) {
  if (!uuid.test(id || '')) throw new HttpError(400, 'Grabación inválida.');
  if (['ringing', 'playing', 'snoozed'].includes(room.phase)) {
    throw new HttpError(409, 'Espera a que termine la llamada antes de probar una grabación.');
  }
  const { rowCount } = await db.query('SELECT 1 FROM tracks WHERE id = $1 AND room_id = $2', [id, room.id]);
  if (!rowCount) throw new HttpError(404, 'Grabación no encontrada.');
  await db.query(`
    UPDATE room SET preview_id = $1, preview_track = $2, preview_status = 'queued',
      preview_until = now() + interval '5 minutes' WHERE id = $3
  `, [randomUUID(), id, room.id]);
  return { ok: true };
}

async function previewAction(db, room, body, admin) {
  const { id, action } = body ?? {};
  if (!uuid.test(id || '') || room.preview_id !== id || !room.preview_until) {
    throw new HttpError(409, 'La prueba ya cambió o terminó.');
  }
  if (admin) {
    if (action !== 'stop') throw new HttpError(400, 'Acción de prueba inválida.');
  } else {
    const allowed = room.preview_status === 'queued' ? ['start', 'failed'] : ['playing', 'heartbeat', 'ended', 'failed'];
    if (!allowed.includes(action)) throw new HttpError(409, 'La prueba ya cambió o está abierta en otra pantalla.');
  }
  if (['start', 'playing', 'heartbeat'].includes(action)) {
    const status = action === 'start' ? 'starting' : action === 'playing' ? 'playing' : room.preview_status;
    await db.query("UPDATE room SET preview_status = $1, preview_until = now() + interval '45 seconds' WHERE id = $2", [status, room.id]);
  } else {
    const status = action === 'stop' ? 'stopped' : action;
    await db.query('UPDATE room SET preview_status = $1, preview_until = NULL WHERE id = $2', [status, room.id]);
  }
  return { ok: true };
}

async function resetQueue(db, room) {
  if (room.preview_until) throw new HttpError(409, 'Detén la prueba en el proyector antes de volver a empezar.');
  if (['ringing', 'playing', 'snoozed'].includes(room.phase)) {
    throw new HttpError(409, 'Espera a que termine la llamada para volver a empezar.');
  }
  await db.query('UPDATE tracks SET played_at = NULL, played_attempt = NULL WHERE room_id = $1 AND played_at IS NOT NULL', [room.id]);
  await db.query(`
    UPDATE room SET track_id = NULL, attempt = NULL, phase = 'waiting',
      deadline = NULL, prepared_media = NULL, prepared_until = NULL
    WHERE id = $1
  `, [room.id]);
  return { ok: true };
}

async function screenAction(db, room, body) {
  const { action, attempt } = body ?? {};
  if (!uuid.test(attempt || '')) throw new HttpError(400, 'Identificador de llamada inválido.');
  if (action === 'ended') {
    const { rowCount } = await db.query('SELECT 1 FROM tracks WHERE played_attempt = $1 AND room_id = $2', [attempt, room.id]);
    if (rowCount) return { ok: true };
  }
  if (room.attempt !== attempt) throw new HttpError(409, 'La llamada cambió.');
  if (room.phase === 'ringing') {
    if (action === 'answer') {
      await db.query("UPDATE room SET phase = 'playing', deadline = now() + interval '45 seconds' WHERE id = $1", [room.id]);
    } else if (action === 'reject') {
      await db.query("UPDATE room SET phase = 'rejected', deadline = NULL WHERE id = $1", [room.id]);
    } else if (action === 'snooze') {
      await db.query("UPDATE room SET phase = 'snoozed', deadline = now() + interval '5 seconds' WHERE id = $1", [room.id]);
    } else {
      throw new HttpError(409, 'La llamada está sonando.');
    }
  } else if (['playing', 'interrupted'].includes(room.phase) && action === 'heartbeat') {
    await db.query("UPDATE room SET phase = 'playing', deadline = now() + interval '45 seconds' WHERE id = $1", [room.id]);
  } else if (['playing', 'interrupted'].includes(room.phase) && action === 'ended') {
    await db.query('UPDATE tracks SET played_at = now(), played_attempt = $2 WHERE id = $1 AND room_id = $3 AND played_at IS NULL',
      [room.track_id, attempt, room.id]);
    await db.query("UPDATE room SET phase = 'waiting', track_id = NULL, attempt = NULL, deadline = NULL WHERE id = $1", [room.id]);
  } else if (room.phase === 'playing' && action === 'failed') {
    await db.query("UPDATE room SET phase = 'interrupted', deadline = NULL WHERE id = $1", [room.id]);
  } else {
    throw new HttpError(409, 'Esta acción ya no está disponible.');
  }
  return { ok: true };
}

async function moveTrack(db, room, id, direction) {
  if (!uuid.test(id || '') || !['up', 'down'].includes(direction)) throw new HttpError(400, 'Movimiento inválido.');
  if (['ringing', 'playing', 'snoozed'].includes(room.phase)) throw new HttpError(409, 'Espera a que termine la llamada.');
  const { rows } = await db.query('SELECT id, position FROM tracks WHERE room_id = $1 AND played_at IS NULL ORDER BY position', [room.id]);
  const index = rows.findIndex(track => track.id === id);
  const other = rows[index + (direction === 'up' ? -1 : 1)];
  if (index < 0 || !other) throw new HttpError(409, 'No se puede mover este audio.');
  const current = rows[index];
  await db.query('UPDATE tracks SET position = (SELECT max(position) + 1 FROM tracks WHERE room_id = $2) WHERE id = $1', [current.id, room.id]);
  await db.query('UPDATE tracks SET position = $2 WHERE id = $1', [other.id, current.position]);
  await db.query('UPDATE tracks SET position = $2 WHERE id = $1', [current.id, other.position]);
  return { ok: true };
}

async function storeVideo(req, hash) {
  const chunks = bodyChunks(req, maxVideoBytes, 'El video supera el máximo de 300 MiB.');
  const directory = await mkdtemp(join(tmpdir(), 'llamada-video-'));
  const path = join(directory, 'upload.mp4');
  const header = Buffer.alloc(12);
  let size = 0;
  async function* writeChunks() {
    for await (const chunk of chunks) {
      if (size < header.length) chunk.copy(header, size);
      size += chunk.length;
      hash.update(chunk);
      yield chunk;
    }
  }
  try {
    await pipeline(writeChunks(), createWriteStream(path, { mode: 0o600 }));
    if (size < header.length || header.toString('ascii', 4, 8) !== 'ftyp') {
      throw new HttpError(415, 'El archivo debe ser un video MP4 válido.');
    }
    const digest = hash.digest('hex');
    const objectKey = 'videos/' + digest + '.mp4';
    const { rowCount } = await pool.query('SELECT 1 FROM media WHERE digest = $1', [digest]);
    if (!rowCount) {
      const stream = createReadStream(path);
      try {
        await videoStorage.put(objectKey, stream, size);
      } finally {
        stream.destroy();
      }
    }
    return { digest, objectKey, bytes: Buffer.alloc(0) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function upload(req, url, kind, roomId) {
  const extension = url.searchParams.get('extension')?.toLowerCase();
  const audio = kind === 'audio';
  const video = kind === 'video';
  if (video && !videoStorage) throw new HttpError(503, 'El almacenamiento de videos no está disponible.');
  const mime = video ? (extension === 'mp4' ? 'video/mp4' : null) : (audio ? audioTypes : imageTypes).get(extension);
  if (!mime) {
    const formats = { audio: 'Prueba con MP3 o WAV.', video: 'Usa un video MP4.', background: 'Usa una imagen JPG, PNG o WebP.' };
    throw new HttpError(415, formats[kind]);
  }
  const name = audio || video ? nameFrom(url.searchParams.get('name')) : null;
  const hash = createHash('sha256');
  if (roomId !== 1) hash.update('room:' + roomId + '\0');
  hash.update(mime);
  let mediaFile;
  if (video) {
    mediaFile = await storeVideo(req, hash);
  } else {
    const bytes = await readBody(req, (audio ? 32 : 10) * 1024 * 1024);
    mediaFile = { bytes, digest: hash.update(bytes).digest('hex'), objectKey: null };
  }
  const { bytes, digest, objectKey } = mediaFile;
  return withRoom(roomId, async db => {
    await db.query('INSERT INTO media (id, mime, bytes, digest, object_key) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (digest) DO NOTHING',
      [randomUUID(), mime, bytes, digest, objectKey]);
    const { rows: [{ id }] } = await db.query('SELECT id FROM media WHERE digest = $1', [digest]);
    if (!audio && !video) {
      await db.query('UPDATE room SET wallpaper = $1 WHERE id = $2', [id, roomId]);
      return { url: '/media/' + id };
    }
    const { rows: [created] } = await db.query(`
      INSERT INTO tracks (id, media_id, name, position, room_id)
      SELECT $1, $2, $3, coalesce(max(position), 0) + 1, $4 FROM tracks WHERE room_id = $4
      ON CONFLICT (media_id) DO NOTHING
      RETURNING name, position, played_at
    `, [randomUUID(), id, name, roomId]);
    const track = created ?? (await db.query(
      'SELECT name, position, played_at FROM tracks WHERE media_id = $1 AND room_id = $2', [id, roomId]
    )).rows[0];
    return { url: '/media/' + id, alreadyAdded: !created, track };
  });
}

async function media(req, res, id) {
  if (!uuid.test(id)) throw new HttpError(404, 'Archivo no encontrado.');
  const { rows: [file] } = await pool.query('SELECT mime, octet_length(bytes) AS size, object_key FROM media WHERE id = $1', [id]);
  if (!file) throw new HttpError(404, 'Archivo no encontrado.');
  if (file.object_key) {
    if (!videoStorage) throw new HttpError(503, 'El almacenamiento de videos no está disponible.');
    res.writeHead(307, { Location: await videoStorage.url(file.object_key, req.method) }).end();
    return;
  }
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

async function preload(req, res, id, roomId) {
  if (!uuid.test(id)) throw new HttpError(404, 'Grabación no encontrada.');
  const { rows: [file] } = await pool.query(`
    SELECT media.mime, media.object_key, media.bytes
    FROM media JOIN tracks ON tracks.media_id = media.id
    JOIN room ON room.id = tracks.room_id
    WHERE media.id = $1 AND tracks.room_id = $2
      AND (tracks.played_at IS NULL OR (room.preview_track = tracks.id AND room.preview_until > now()))
  `, [id, roomId]);
  if (!file) throw new HttpError(404, 'Grabación no encontrada.');
  if (!file.object_key) {
    res.writeHead(200, { 'Content-Type': file.mime, 'Content-Length': file.bytes.length }).end(file.bytes);
    return;
  }
  if (!videoStorage) throw new HttpError(503, 'El almacenamiento de videos no está disponible.');
  const controller = new AbortController();
  res.once('close', () => { if (!res.writableFinished) controller.abort(); });
  const object = await videoStorage.get(file.object_key, controller.signal);
  const headers = { 'Content-Type': file.mime };
  if (object.ContentLength !== undefined) headers['Content-Length'] = object.ContentLength;
  res.writeHead(200, headers);
  await pipeline(object.Body, res, { signal: controller.signal });
}

async function markPrepared(db, room, id) {
  if (!uuid.test(id || '')) throw new HttpError(400, 'Grabación inválida.');
  const next = await nextTrack(db, room);
  if (next?.media_id !== id) throw new HttpError(409, 'La próxima grabación cambió.');
  await db.query("UPDATE room SET prepared_media = $1, prepared_until = now() + interval '15 seconds' WHERE id = $2", [id, room.id]);
  return { ok: true };
}

async function createProjectionPairing(roomId) {
  await pool.query('DELETE FROM projection_pairing WHERE expires_at <= now()');
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = randomUUID();
    const code = String(randomInt(100000, 1000000));
    const { rowCount } = await pool.query(`
      INSERT INTO projection_pairing (id, code, expires_at, room_id)
      VALUES ($1, $2, now() + interval '5 minutes', $3)
      ON CONFLICT (code) DO NOTHING
    `, [id, code, roomId]);
    if (rowCount) return { id, code };
  }
  throw new HttpError(503, 'Vuelve a intentar conectar el proyector.');
}

async function projectionPairingStatus(req, config) {
  const id = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!uuid.test(id)) throw new HttpError(400, 'Solicitud de conexión inválida.');
  const { rows: [pairing] } = await pool.query(
    'SELECT approved FROM projection_pairing WHERE id = $1 AND room_id = $2 AND expires_at > now()', [id, config.id]);
  if (!pairing) throw new HttpError(410, 'El código venció. Genera otro en el proyector.');
  return { key: pairing.approved ? config.screenKey : null };
}

async function approveProjectionPairing(req, roomId) {
  const { code } = await readJson(req) ?? {};
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) {
    throw new HttpError(400, 'Escribe los seis dígitos que aparecen en el proyector.');
  }
  const { rowCount } = await pool.query(
    'UPDATE projection_pairing SET approved = true WHERE code = $1 AND room_id = $2 AND expires_at > now()', [code, roomId]);
  if (!rowCount) throw new HttpError(404, 'El código no está disponible para este curso. Revisa el curso y el código del proyector.');
  return { ok: true };
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const { pathname: path } = url;
  const method = req.method;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  const videoOrigin = videoStorage ? ' ' + videoStorage.origin : '';
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' data: blob:" + videoOrigin + "; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");

  if (method === 'GET' && path === '/health') {
    await pool.query('SELECT 1');
    return json(res, 200, { ok: true });
  }
  const projectionPath = path.replace(/\/$/, '').toUpperCase();
  const pagePath = roomsByProjectionPath.has(projectionPath) ? '/pantalla' : path;
  if (method === 'GET' && files.has(pagePath)) {
    const file = files.get(pagePath);
    const type = file.type.startsWith('text/') ? file.type + '; charset=utf-8' : file.type;
    return res.writeHead(200, { 'Content-Type': type, 'Content-Length': file.bytes.length }).end(file.bytes);
  }
  if ((method === 'GET' || method === 'HEAD') && path.startsWith('/media/')) {
    return media(req, res, path.slice('/media/'.length));
  }
  if (path.startsWith('/api/admin/')) {
    const config = rooms.find(room => hasKey(req, room.adminKey));
    if (!config) throw new HttpError(401, 'Clave de administración incorrecta.');
    const roomId = config.id;
    if (method === 'GET' && path === '/api/admin/state') return json(res, 200, await withRoom(roomId, (db, room) => state(db, room, true)));
    if (method === 'POST' && path === '/api/admin/launch') return json(res, 200, await withRoom(roomId, launch));
    if (method === 'POST' && path === '/api/admin/preview') {
      const body = await readJson(req);
      return json(res, 200, await withRoom(roomId, (db, room) => startPreview(db, room, body?.id)));
    }
    if (method === 'POST' && path === '/api/admin/preview/stop') {
      const body = await readJson(req);
      return json(res, 200, await withRoom(roomId, (db, room) => previewAction(db, room, { id: body?.id, action: 'stop' }, true)));
    }
    if (method === 'POST' && path === '/api/admin/reset') return json(res, 200, await withRoom(roomId, resetQueue));
    if (method === 'POST' && path === '/api/admin/pair') {
      if (!config.projectionPath) throw new HttpError(403, 'Esta sala se abre desde Administración.');
      return json(res, 200, await approveProjectionPairing(req, roomId));
    }
    if (method === 'POST' && path === '/api/admin/move') {
      const { id, direction } = await readJson(req) ?? {};
      return json(res, 200, await withRoom(roomId, (db, room) => moveTrack(db, room, id, direction)));
    }
    if (method === 'POST' && path === '/api/admin/rename') {
      const { id, name } = await readJson(req) ?? {};
      if (!uuid.test(id || '')) throw new HttpError(400, 'Identificador inválido.');
      const updated = await pool.query('UPDATE tracks SET name = $2 WHERE id = $1 AND room_id = $3', [id, nameFrom(name), roomId]);
      if (!updated.rowCount) throw new HttpError(404, 'Audio no encontrado.');
      return json(res, 200, { ok: true });
    }
    if (method === 'POST' && path === '/api/admin/audio') return json(res, 201, await upload(req, url, 'audio', roomId));
    if (method === 'POST' && path === '/api/admin/video') return json(res, 201, await upload(req, url, 'video', roomId));
    if (method === 'POST' && path === '/api/admin/background') return json(res, 201, await upload(req, url, 'background', roomId));
  }
  if (path.startsWith('/api/screen/')) {
    const courseRoute = /^\/api\/screen(\/4[ABC])\/(status|pair)$/.exec(path);
    if (courseRoute) {
      const [, coursePath, action] = courseRoute;
      const config = roomsByProjectionPath.get(coursePath);
      if (!config) throw new HttpError(404, 'Sala no disponible.');
      if (method === 'GET' && action === 'status') {
        const { rows: [room] } = await pool.query('SELECT phase FROM room WHERE id = $1', [config.id]);
        return json(res, 200, { phase: room.phase });
      }
      if (action === 'pair' && method === 'POST') return json(res, 201, await createProjectionPairing(config.id));
      if (action === 'pair' && method === 'GET') return json(res, 200, await projectionPairingStatus(req, config));
    }
    const config = rooms.find(room => hasKey(req, room.screenKey));
    if (!config) throw new HttpError(401, 'Abre el enlace de proyección desde Administración.');
    const requestedPath = req.headers['x-projection-path'];
    if (requestedPath && requestedPath !== config.projectionPath) {
      throw new HttpError(401, 'Este enlace no corresponde al curso de esta pantalla.');
    }
    const roomId = config.id;
    if (method === 'GET' && path === '/api/screen/state') return json(res, 200, await withRoom(roomId, (db, room) => state(db, room, false)));
    if (method === 'GET' && path.startsWith('/api/screen/preload/')) return preload(req, res, path.slice('/api/screen/preload/'.length), roomId);
    if (method === 'POST' && path === '/api/screen/prepared') {
      const body = await readJson(req);
      return json(res, 200, await withRoom(roomId, (db, room) => markPrepared(db, room, body?.mediaId)));
    }
    if (method === 'POST' && path === '/api/screen/action') {
      const body = await readJson(req);
      return json(res, 200, await withRoom(roomId, (db, room) => screenAction(db, room, body)));
    }
    if (method === 'POST' && path === '/api/screen/preview') {
      const body = await readJson(req);
      return json(res, 200, await withRoom(roomId, (db, room) => previewAction(db, room, body, false)));
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
})).listen(Number(PORT), HOST, () => {
  console.log('Llamada para proyectar lista.');
  console.log('Salas disponibles: ' + rooms.map(room => room.name).join(', '));
  videoStorage?.check()
    .then(() => console.log('Bucket de videos accesible.'))
    .catch(error => console.warn('No se pudo verificar el bucket de videos:', error.name));
});
