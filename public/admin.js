const get = id => document.getElementById(id);
const labels = {
  waiting: 'En espera', ringing: 'Sonando', playing: 'Reproduciendo',
  snoozed: 'Pospuesta', rejected: 'Rechazada. El audio sigue pendiente.',
  interrupted: 'Reproducción interrumpida. El audio sigue pendiente.'
};
let key = sessionStorage.getItem('llamada-admin') || '';
let running = false;
let busy = false;
let lastView = '';

async function api(path, options = {}) {
  const response = await fetch('/api/admin/' + path, {
    ...options, headers: { Authorization: 'Bearer ' + key, ...options.headers }
  });
  const isJson = response.headers.get('content-type')?.includes('application/json');
  const data = isJson ? await response.json().catch(() => null) : null;
  if (!response.ok) {
    const fallback = response.status === 413
      ? 'El servidor rechazó la carga por el tamaño del archivo.'
      : 'El servidor respondió con un error (' + response.status + '). Vuelve a intentar.';
    const error = new Error(data?.error || fallback);
    error.status = response.status;
    throw error;
  }
  if (!data) throw new Error('La respuesta del servidor no se pudo leer. Vuelve a intentar.');
  return data;
}

function feedback(message, isError = false) {
  const notice = get('feedback');
  notice.textContent = message;
  notice.classList.toggle('error', isError);
  notice.hidden = !message;
}

function togglePanel(show) {
  get('panel').hidden = !show;
  get('logout').hidden = !show;
  get('login').hidden = show;
}

function logout() {
  key = '';
  sessionStorage.removeItem('llamada-admin');
  lastView = '';
  get('title').textContent = 'Llamada para proyectar';
  togglePanel(false);
}

function makeButton(text, onClick, disabled = false, title = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = text;
  button.disabled = disabled;
  if (title) button.setAttribute('aria-label', title);
  button.addEventListener('click', onClick);
  return button;
}

function post(path, data) {
  return api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
}

function render(data) {
  togglePanel(true);
  get('title').textContent = data.roomName;
  get('screen').href = data.screenPath;
  get('pair-projector').hidden = !data.canPairProjection;
  get('video-upload').hidden = !data.videoEnabled;
  const signature = JSON.stringify(data);
  if (signature === lastView) return;
  lastView = signature;
  const playing = ['ringing', 'playing', 'snoozed'].includes(data.phase);
  const pending = data.tracks.filter(track => !track.played_at);
  get('status').textContent = data.name ? labels[data.phase] + ' · ' + data.name
    : data.tracks.length && !pending.length ? 'Se reprodujeron todas las grabaciones.' : labels[data.phase];
  get('progress').textContent = (data.tracks.length - pending.length) + ' de ' + data.tracks.length + ' reproducidos';
  const prep = data.preparation;
  const preparation = get('preparation');
  preparation.hidden = !prep || ['ringing', 'snoozed'].includes(data.phase);
  preparation.textContent = prep ? (prep.ready ? 'Lista en el proyector: ' : 'Esperando descarga en el proyector: ') + prep.name : '';
  get('launch').disabled = playing || !prep?.ready;
  get('reset').disabled = playing || (!data.activeId && pending.length === data.tracks.length);
  get('launch').textContent = ['rejected', 'interrupted'].includes(data.phase) && pending[0]?.id === data.activeId
    ? 'Volver a llamar' : 'Lanzar siguiente llamada';
  get('empty').hidden = data.tracks.length > 0;
  get('queue').hidden = data.tracks.length === 0;
  get('tracks').replaceChildren(...data.tracks.map((track, index) => {
    const row = document.createElement('tr');
    const active = data.activeId === track.id;
    row.dataset.active = active;
    row.insertCell().textContent = index + 1;
    const nameCell = row.insertCell();
    nameCell.textContent = track.name;
    if (track.kind === 'video') {
      const type = document.createElement('small');
      type.textContent = ' · Video';
      nameCell.append(type);
    }
    row.insertCell().textContent = track.played_at ? 'Reproducido' : active ? labels[data.phase] : 'Pendiente';
    const controls = row.insertCell();
    const group = document.createElement('div');
    group.className = 'actions';
    const pendingIndex = pending.findIndex(item => item.id === track.id);
    const move = direction => task(() => post('move', { id: track.id, direction }));
    group.append(
      makeButton('↑', () => move('up'), playing || pendingIndex <= 0, 'Subir ' + track.name),
      makeButton('↓', () => move('down'), playing || pendingIndex < 0 || pendingIndex >= pending.length - 1, 'Bajar ' + track.name),
      makeButton('Editar nombre', () => {
        const name = window.prompt('Nombre en pantalla', track.name);
        if (name?.trim() && name.trim() !== track.name) task(() => post('rename', { id: track.id, name }));
      }),
      makeButton('Copiar enlace', () => task(async () => {
        await navigator.clipboard.writeText(new URL('/media/' + track.media_id, location.origin).href);
        feedback('Enlace copiado.');
      }))
    );
    controls.append(group);
    return row;
  }));
}

async function refresh() {
  if (!key || running) return;
  const currentKey = key;
  running = true;
  try {
    const data = await api('state');
    if (currentKey === key) render(data);
  } catch (error) {
    if (currentKey !== key) return;
    if (error.status === 401) logout();
    feedback(error.message, true);
  } finally {
    running = false;
  }
}

async function task(action) {
  if (busy) return;
  busy = true;
  feedback('');
  try {
    await action();
  } catch (error) {
    feedback(error.message, true);
  } finally {
    busy = false;
    await refresh();
  }
}

function fileParts(file) {
  const dot = file.name.lastIndexOf('.');
  return { extension: file.name.slice(dot + 1), name: file.name.slice(0, dot).trim() || file.name };
}

get('login').addEventListener('submit', event => {
  event.preventDefault();
  key = get('key').value.trim();
  if (!key) return;
  sessionStorage.setItem('llamada-admin', key);
  get('key').value = '';
  feedback('');
  refresh();
});
get('logout').addEventListener('click', () => { logout(); feedback(''); });
get('launch').addEventListener('click', () => task(() => post('launch')));
get('pair-projector').addEventListener('click', () => {
  if (busy) return;
  const code = window.prompt('Escribe los seis dígitos que aparecen en el proyector.');
  if (!code?.trim()) return;
  task(async () => {
    await post('pair', { code: code.trim() });
    feedback('Proyector autorizado. Espera a que la grabación esté lista para lanzar la llamada.');
  });
});
get('reset').addEventListener('click', () => {
  if (busy || !window.confirm('¿Volver a empezar? Todas las grabaciones quedarán pendientes en el orden actual.')) return;
  task(async () => {
    await post('reset');
    feedback('Todas las grabaciones están pendientes. La próxima llamada será la primera de la lista.');
  });
});
function setupUpload(kind, form, input, nameInput) {
  input.addEventListener('change', () => {
    const count = input.files.length;
    nameInput.disabled = count !== 1;
    nameInput.value = count === 1 ? fileParts(input.files[0]).name.slice(0, 100) : '';
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (busy) {
      uploadFeedback(form, 'Hay otra acción en curso. Vuelve a pulsar el botón cuando termine.');
      return;
    }
    const files = Array.from(input.files);
    const custom = nameInput.value.trim();
    task(() => uploadFiles(kind, files, custom, form, nameInput));
  });
}

function uploadFeedback(form, message, isError = false) {
  const notice = form.querySelector('[role="status"]');
  notice.textContent = message;
  notice.classList.toggle('error', isError);
  notice.hidden = !message;
}

async function uploadFiles(kind, files, custom, form, nameInput) {
  const added = [];
  const duplicates = [];
  const failures = [];
  for (const [index, file] of files.entries()) {
    uploadFeedback(form, 'Subiendo ' + (index + 1) + ' de ' + files.length + '…');
    const { extension, name } = fileParts(file);
    const params = new URLSearchParams({ extension, name: (files.length === 1 && custom ? custom : name).slice(0, 100) });
    try {
      const result = await api(kind + '?' + params, { method: 'POST', body: file });
      const track = result.track;
      if (result.alreadyAdded) {
        const state = track.played_at ? 'reproducido' : 'pendiente';
        duplicates.push('El mismo archivo ya está en la fila ' + track.position + ' como «' + track.name + '» (' + state + ').');
      } else {
        added.push('«' + track.name + '» quedó en la fila ' + track.position + '.');
      }
    } catch (error) {
      failures.push(file.name + ' · ' + error.message);
    }
  }
  if (!failures.length) {
    form.reset();
    nameInput.disabled = true;
  }
  const success = added.length > 1 ? 'Se agregaron ' + added.length + ' grabaciones a la lista.' : added[0];
  uploadFeedback(form, [success, ...duplicates, ...failures].filter(Boolean).join(' '), failures.length > 0);
}

setupUpload('audio', get('upload'), get('audio'), get('name'));
setupUpload('video', get('video-upload'), get('video'), get('video-name'));
get('background').addEventListener('submit', event => {
  event.preventDefault();
  const [file] = get('image').files;
  if (!file) return;
  task(async () => {
    await api('background?' + new URLSearchParams({ extension: fileParts(file).extension }), { method: 'POST', body: file });
    event.target.reset();
    feedback('Fondo actualizado.');
  });
});

refresh();
setInterval(refresh, 1500);
