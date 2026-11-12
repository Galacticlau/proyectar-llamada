const get = id => document.getElementById(id);
const stage = get('stage');
const ringtone = get('ringtone');
const recording = get('recording');
const videoRecording = get('video-recording');
const status = get('status');
const notice = get('notice');
const enable = get('enable');
const courseCode = /^\/(4[abc])\/?$/i.exec(location.pathname)?.[1].toUpperCase();
const shortProjection = Boolean(courseCode);
const projectionPath = '/' + courseCode;
const projectionHint = get('projection-hint');
const pairProjector = get('pair-projector');
const sessionKey = 'llamada-proyeccion-' + courseCode;
let key;
let finishKey;
let pairingId;
const labels = {
  waiting: 'Esperando la siguiente llamada', ringing: 'Llamada entrante',
  playing: 'En llamada', snoozed: 'Volverá a sonar en 5 segundos',
  rejected: 'Llamada rechazada', interrupted: 'Audio pendiente'
};
let snapshot;
let unlocked = false;
let ringingAttempt;
let activeAttempt;
let activeMedia = recording;
let failedAttempt;
let pendingFinish;
let busy = false;
let polling = false;
let lastHeartbeat = 0;
const prepared = new Map();
let download;
let retryAfter = 0;
let confirmedMedia;
let confirmedAt = 0;

function screenHeaders() {
  const headers = key ? { Authorization: 'Bearer ' + key } : {};
  if (shortProjection) headers['X-Projection-Path'] = projectionPath;
  return headers;
}

async function request(path, options = {}) {
  const response = await fetch('/api/screen/' + path, {
    ...options, headers: { ...screenHeaders(), ...options.headers }
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error);
    error.status = response.status;
    throw error;
  }
  return data;
}

function send(action, attempt) {
  return request('action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, attempt }) });
}

async function checkPairing() {
  if (!pairingId) return;
  try {
    const result = await request(courseCode + '/pair', { headers: { Authorization: 'Bearer ' + pairingId } });
    if (!result.key) return;
    pairingId = undefined;
    projectionHint.textContent = '';
    connect(result.key);
  } catch (error) {
    if (error.status !== 410) throw error;
    pairingId = undefined;
    projectionHint.textContent = error.message;
  }
}

function prepare(mediaId) {
  if (download?.id !== mediaId) {
    download?.controller.abort();
    download = undefined;
  }
  if (!mediaId || prepared.has(mediaId) || download || Date.now() < retryAfter) return;
  const current = { id: mediaId, controller: new AbortController() };
  download = current;
  fetch('/api/screen/preload/' + mediaId, { headers: screenHeaders(), signal: current.controller.signal })
    .then(response => {
      if (!response.ok) throw new Error('Descarga no disponible');
      return response.blob();
    })
    .then(blob => {
      if (download !== current) return;
      if (!blob.size) throw new Error('Descarga vacía');
      prepared.set(mediaId, URL.createObjectURL(blob));
      for (const [id, url] of prepared) {
        if (prepared.size <= 2) break;
        if (id !== mediaId && (!activeAttempt || url !== activeMedia.src)) {
          URL.revokeObjectURL(url);
          prepared.delete(id);
        }
      }
    })
    .catch(() => {
      if (download === current) retryAfter = Date.now() + 3000;
    })
    .finally(() => {
      if (download !== current) return;
      download = undefined;
      poll();
    });
}

async function confirmPrepared(mediaId) {
  if (!prepared.has(mediaId) || (confirmedMedia === mediaId && Date.now() - confirmedAt < 4500)) return;
  try {
    await request('prepared', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mediaId }) });
    confirmedMedia = mediaId;
    confirmedAt = Date.now();
  } catch (error) {
    if (error.status !== 409) throw error;
  }
}

function showNotice(message) {
  notice.textContent = message;
  notice.hidden = !message;
}

function stopRing() {
  ringtone.pause();
  ringtone.currentTime = 0;
}

function updateTimer() {
  const seconds = Math.floor(activeMedia.currentTime);
  status.textContent = Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
}

function render(data) {
  snapshot = data;
  const ringing = data.phase === 'ringing';
  const ready = ringing && prepared.has(data.mediaId);
  const playing = ['playing', 'interrupted'].includes(data.phase) && activeAttempt === data.attempt;
  const videoPlaying = playing && data.kind === 'video';
  stage.dataset.mode = ringing ? 'ringing' : playing ? 'active' : data.phase;
  stage.dataset.videoPlaying = videoPlaying;
  videoRecording.hidden = !videoPlaying;
  get('caller').textContent = data.name || data.roomName || 'En espera';
  if (playing) updateTimer();
  else if (ringing && !ready) status.textContent = 'Preparando grabación…';
  else status.textContent = ringing && data.kind === 'video' ? 'Videollamada entrante' : labels[data.phase];
  get('ring-actions').hidden = !ringing;
  get('answer').disabled = !ready;
  get('dots').hidden = !ringing;
  get('wave').hidden = !playing || videoPlaying;
  get('snooze').hidden = !ringing;
  if (data.wallpaper) {
    stage.style.setProperty('--wallpaper', 'url("' + data.wallpaper + '")');
  } else {
    stage.style.removeProperty('--wallpaper');
  }
  if (ready && unlocked && ringingAttempt !== data.attempt) {
    ringingAttempt = data.attempt;
    ringtone.play().catch(() => {
      unlocked = false;
      enable.hidden = false;
      ringingAttempt = undefined;
    });
  } else if (!ready) {
    stopRing();
    ringingAttempt = undefined;
  }
  if (activeAttempt && !playing && !busy) {
    activeMedia.pause();
    activeAttempt = undefined;
  }
}

async function poll() {
  if ((!key && !shortProjection) || polling || busy) return;
  polling = true;
  try {
    if (!key) await checkPairing();
    if (!key) {
      const { phase } = await request(courseCode + '/status');
      renderPreview(phase);
      showNotice('');
      return;
    }
    if (pendingFinish) {
      try {
        await send('ended', pendingFinish);
      } catch (error) {
        if (error.status !== 409) throw error;
      }
      pendingFinish = null;
      sessionStorage.removeItem(finishKey);
    }
    if (failedAttempt) {
      try {
        await send('failed', failedAttempt);
      } catch (error) {
        if (error.status !== 409) throw error;
      }
      failedAttempt = undefined;
    }
    if (activeAttempt && Date.now() - lastHeartbeat >= 10000) {
      try {
        await send('heartbeat', activeAttempt);
        lastHeartbeat = Date.now();
      } catch (error) {
        if (error.status !== 409) throw error;
      }
    }
    const next = await request('state');
    if (shortProjection) {
      if (sessionStorage.getItem(sessionKey) !== key) sessionStorage.setItem(sessionKey, key);
      if (location.hash) history.replaceState(null, '', projectionPath);
      projectionHint.hidden = true;
      pairProjector.hidden = true;
      enable.hidden = unlocked;
    }
    if (!busy) {
      render(next);
      prepare(next.phase === 'ringing' ? next.mediaId : next.nextMedia);
      await confirmPrepared(next.nextMedia);
    }
    if (notice.dataset.connection === 'true') {
      showNotice('');
      delete notice.dataset.connection;
    }
  } catch (error) {
    if (shortProjection && error.status === 401 && !activeAttempt) {
      key = '';
      sessionStorage.removeItem(sessionKey);
      if (location.hash) history.replaceState(null, '', projectionPath);
      stopRing();
      renderPreview('waiting');
      return;
    }
    if (!activeAttempt) {
      notice.dataset.connection = 'true';
      showNotice(error.status === 401 ? error.message : 'Conexión interrumpida. Reconectando…');
    }
  } finally {
    polling = false;
  }
}

async function respond(action) {
  if (busy || snapshot?.phase !== 'ringing') return;
  busy = true;
  showNotice('');
  const { attempt, mediaId, kind } = snapshot;
  const localUrl = prepared.get(mediaId);
  if (action === 'answer' && !localUrl) {
    busy = false;
    return;
  }
  if (action === 'answer') stopRing();
  try {
    await send(action, attempt);
    if (action === 'answer') {
      activeAttempt = attempt;
      activeMedia = kind === 'video' ? videoRecording : recording;
      lastHeartbeat = Date.now();
      render({ ...snapshot, phase: 'playing' });
      activeMedia.src = localUrl;
      try {
        await activeMedia.play();
      } catch {
        if (activeAttempt === attempt) failPlayback();
      }
    }
  } catch (error) {
    showNotice(error.message);
    if (action === 'answer') ringingAttempt = undefined;
  } finally {
    busy = false;
    await poll();
  }
}

ringtone.volume = .55;
enable.addEventListener('click', async () => {
  try {
    await ringtone.play();
    unlocked = true;
    enable.hidden = true;
    if (snapshot?.phase === 'ringing' && prepared.has(snapshot.mediaId)) ringingAttempt = snapshot.attempt;
    else stopRing();
  } catch {
    showNotice('El navegador bloqueó el sonido. Vuelve a pulsar Activar sonido.');
  }
});
get('answer').addEventListener('click', () => respond('answer'));
get('reject').addEventListener('click', () => respond('reject'));
get('snooze').addEventListener('click', () => respond('snooze'));
function finishPlayback() {
  pendingFinish = activeAttempt;
  activeAttempt = undefined;
  sessionStorage.setItem(finishKey, pendingFinish);
  render({ ...snapshot, phase: 'waiting', name: null, attempt: null });
  poll();
}

function failPlayback() {
  failedAttempt = activeAttempt;
  activeAttempt = undefined;
  videoRecording.hidden = true;
  stage.dataset.videoPlaying = 'false';
  const type = activeMedia === videoRecording ? 'video' : 'audio';
  showNotice('No se pudo reproducir el ' + type + '. Pide al admin que vuelva a llamar.');
  poll();
}

for (const player of [recording, videoRecording]) {
  player.addEventListener('timeupdate', () => {
    if (activeAttempt && player === activeMedia) updateTimer();
  });
  player.addEventListener('ended', () => {
    if (activeAttempt && player === activeMedia) finishPlayback();
  });
  player.addEventListener('error', () => {
    if (activeAttempt && player === activeMedia) failPlayback();
  });
}
const fullscreen = get('fullscreen');
fullscreen.addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    fullscreen.textContent = 'Pantalla completa con F11';
  }
});
pairProjector.addEventListener('click', async () => {
  pairProjector.disabled = true;
  try {
    const { id, code } = await request(courseCode + '/pair', { method: 'POST' });
    pairingId = id;
    projectionHint.textContent = 'Código ' + code + ' · Escríbelo en «Conectar proyector» en Administración.';
    pairProjector.hidden = true;
  } catch {
    projectionHint.textContent = 'No se pudo generar el código. Vuelve a intentar.';
  } finally {
    pairProjector.disabled = false;
    projectionHint.hidden = false;
  }
});
document.addEventListener('fullscreenchange', () => {
  fullscreen.textContent = document.fullscreenElement ? 'Salir de pantalla completa' : 'Pantalla completa';
});
function connect(token) {
  key = token;
  finishKey = 'llamada-fin:' + key;
  pendingFinish = sessionStorage.getItem(finishKey);
  poll();
}

function renderPreview(phase) {
  snapshot = undefined;
  stage.dataset.mode = phase;
  stage.dataset.videoPlaying = 'false';
  videoRecording.hidden = true;
  get('ring-actions').hidden = true;
  get('snooze').hidden = true;
  get('dots').hidden = phase !== 'ringing';
  get('wave').hidden = true;
  stage.style.removeProperty('--wallpaper');
  enable.hidden = true;
  pairProjector.hidden = Boolean(pairingId);
  projectionHint.hidden = !projectionHint.textContent;
  get('caller').textContent = '4° Medio ' + courseCode.slice(1);
  status.textContent = labels[phase] || labels.waiting;
}

const initialKey = location.hash.slice(1) || (shortProjection ? sessionStorage.getItem(sessionKey) : '');
if (initialKey) {
  connect(initialKey);
} else if (shortProjection) {
  renderPreview('waiting');
  poll();
} else {
  enable.hidden = true;
  showNotice('Abre el enlace de proyección desde Administración.');
}
if (initialKey || shortProjection) setInterval(poll, initialKey ? 900 : 2000);
