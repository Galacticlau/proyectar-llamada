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
const projectionLogin = get('projection-login');
const sessionKey = 'llamada-proyeccion-' + courseCode;
let key;
let finishKey;
let pairingId;
let passwordEnabled = false;
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
let activePreview;
let previewReport;
let previewNeedsGesture = false;
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

function reportPreview(id, action) {
  return request('preview', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, action }) });
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
      if (download !== current) return;
      retryAfter = Date.now() + 3000;
      if (snapshot?.preview?.mediaId === mediaId && snapshot.preview.status === 'queued') {
        previewReport = { id: snapshot.preview.id, action: 'failed' };
        showNotice('No se pudo cargar la grabación de prueba.');
      }
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
  const testing = Boolean(activePreview && data.preview?.id === activePreview.id);
  const ringing = data.phase === 'ringing';
  const ready = ringing && prepared.has(data.mediaId);
  const playing = ['playing', 'interrupted'].includes(data.phase) && activeAttempt === data.attempt;
  const videoPlaying = testing ? data.preview.kind === 'video' : playing && data.kind === 'video';
  stage.dataset.mode = ringing ? 'ringing' : playing || testing ? 'active' : data.phase;
  stage.dataset.videoPlaying = videoPlaying;
  videoRecording.hidden = !videoPlaying;
  get('caller').textContent = testing ? data.preview.name : data.name || data.roomName || 'En espera';
  if (playing || testing) updateTimer();
  else if (data.preview?.status === 'queued') status.textContent = unlocked ? 'Preparando prueba…' : 'Pulsa Activar sonido para probar';
  else if (ringing && !ready) status.textContent = 'Preparando grabación…';
  else status.textContent = ringing && data.kind === 'video' ? 'Videollamada entrante' : labels[data.phase];
  get('ring-actions').hidden = !ringing;
  get('answer').disabled = !ready;
  get('dots').hidden = !ringing;
  get('wave').hidden = !(playing || testing) || videoPlaying;
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

function playMedia(kind, localUrl, data) {
  activeMedia = kind === 'video' ? videoRecording : recording;
  render(data);
  activeMedia.src = localUrl;
  return activeMedia.play();
}

function stopPreview() {
  if (!activePreview) return;
  activePreview = undefined;
  previewNeedsGesture = false;
  activeMedia.pause();
  activeMedia.removeAttribute('src');
  activeMedia.load();
}

function finishPreview(action) {
  previewReport = { id: activePreview.id, action };
  stopPreview();
  render({ ...snapshot, preview: null });
  if (action === 'failed') showNotice('No se pudo reproducir la prueba. Activa el sonido y vuelve a probar.');
  poll();
}

function watchPreviewPlayback(playback, id) {
  playback.then(() => {
    if (activePreview?.id !== id) return;
    previewNeedsGesture = false;
    previewReport = { id, action: 'playing' };
    poll();
  }).catch(error => {
    if (activePreview?.id !== id) return;
    if (error.name === 'NotAllowedError') {
      previewNeedsGesture = true;
      enable.hidden = false;
      showNotice('Pulsa Activar sonido en esta pantalla para reproducir la prueba.');
    } else {
      finishPreview('failed');
    }
  });
}

async function handlePreview(data) {
  const preview = data.preview;
  if (activePreview && activePreview.id !== preview?.id) stopPreview();
  if (activePreview && Date.now() - lastHeartbeat >= 10000) {
    try {
      await reportPreview(activePreview.id, 'heartbeat');
      lastHeartbeat = Date.now();
    } catch (error) {
      if (error.status !== 409) throw error;
      stopPreview();
    }
  }
  if (preview?.status !== 'queued' || !unlocked || !prepared.has(preview.mediaId)) return;
  try {
    await reportPreview(preview.id, 'start');
  } catch (error) {
    if (error.status !== 409) throw error;
    return;
  }
  showNotice('');
  activePreview = preview;
  lastHeartbeat = Date.now();
  const playback = playMedia(preview.kind, prepared.get(preview.mediaId), data);
  watchPreviewPlayback(playback, preview.id);
}

async function poll() {
  if ((!key && !shortProjection) || polling || busy) return;
  polling = true;
  try {
    if (!key) await checkPairing();
    if (!key) {
      const { phase, passwordEnabled: enabled } = await request(courseCode + '/status');
      if (key) return;
      passwordEnabled = Boolean(enabled);
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
    if (previewReport) {
      const report = previewReport;
      try {
        await reportPreview(report.id, report.action);
      } catch (error) {
        if (error.status !== 409) throw error;
      }
      if (previewReport === report) previewReport = undefined;
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
      projectionLogin.hidden = true;
      enable.hidden = unlocked && !previewNeedsGesture;
    }
    if (!busy) {
      if (activePreview && next.preview?.id !== activePreview.id) stopPreview();
      render(next);
      if (next.preview) {
        prepare(next.preview.mediaId);
        await handlePreview(next);
      } else {
        prepare(next.phase === 'ringing' ? next.mediaId : next.nextMedia);
        await confirmPrepared(next.nextMedia);
      }
    }
    if (notice.dataset.connection === 'true') {
      showNotice('');
      delete notice.dataset.connection;
    }
  } catch (error) {
    if (shortProjection && error.status === 401 && !activeAttempt) {
      stopPreview();
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
      lastHeartbeat = Date.now();
      try {
        await playMedia(kind, localUrl, { ...snapshot, phase: 'playing' });
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
  if (activePreview && previewNeedsGesture) {
    showNotice('');
    enable.hidden = true;
    watchPreviewPlayback(activeMedia.play(), activePreview.id);
    return;
  }
  try {
    await ringtone.play();
    unlocked = true;
    enable.hidden = true;
    if (snapshot?.phase === 'ringing' && prepared.has(snapshot.mediaId)) ringingAttempt = snapshot.attempt;
    else stopRing();
    poll();
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
    if ((activeAttempt || activePreview) && player === activeMedia) updateTimer();
  });
  player.addEventListener('ended', () => {
    if (player !== activeMedia) return;
    if (activePreview) finishPreview('ended');
    else if (activeAttempt) finishPlayback();
  });
  player.addEventListener('error', () => {
    if (player !== activeMedia) return;
    if (activePreview) finishPreview('failed');
    else if (activeAttempt) failPlayback();
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
projectionLogin.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || key) return;
  busy = true;
  const input = get('projection-password');
  try {
    const result = await request(courseCode + '/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: input.value })
    });
    input.value = '';
    pairingId = undefined;
    projectionHint.textContent = '';
    projectionHint.hidden = true;
    projectionLogin.hidden = true;
    connect(result.key);
  } catch (error) {
    projectionHint.textContent = error.message;
    projectionHint.hidden = false;
  } finally {
    busy = false;
    poll();
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
  projectionLogin.hidden = !passwordEnabled;
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
