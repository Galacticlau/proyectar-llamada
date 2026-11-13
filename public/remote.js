const get = id => document.getElementById(id);
const course = /^\/(4[ABC])-admin\/?$/i.exec(location.pathname)[1].toUpperCase();
const sessionKey = 'llamada-control-' + course;
get('course').textContent = course;
document.title = 'Control de llamadas · ' + course;
document.querySelector('h1').setAttribute('aria-label', document.title);
const labels = {
  ringing: 'Sonando', playing: 'En reproducción', snoozed: 'Pospuesta',
  rejected: 'Rechazada', interrupted: 'Interrumpida'
};
let token = sessionStorage.getItem(sessionKey) || '';
let state;
let busy = false;
let polling = false;
let connected = false;
let queueSignature;

async function request(path, body) {
  const headers = { Authorization: 'Bearer ' + token };
  if (body) headers['Content-Type'] = 'application/json';
  const response = await fetch('/api/' + course + '-admin/' + path, {
    headers, method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) {
    const error = new Error(data?.error || 'No se pudo conectar con el control.');
    error.status = response.status;
    throw error;
  }
  return data;
}

function message(text = '') {
  get('error').textContent = text;
  get('error').hidden = !text;
}

function showSession() {
  get('login').hidden = Boolean(token);
  get('controls').hidden = !token;
  get('logout').hidden = !token;
}

function logout() {
  token = '';
  state = undefined;
  connected = false;
  sessionStorage.removeItem(sessionKey);
  showSession();
  message();
}

function render() {
  if (!state) return;
  const { active, next, pending, phase, testing } = state;
  const inCall = ['ringing', 'playing', 'snoozed'].includes(phase);
  get('next').textContent = next?.name || 'Sin grabaciones pendientes';
  get('detail').textContent = !connected ? 'Reconectando…'
    : inCall ? labels[phase] + (active ? ' · ' + active : '')
    : testing ? 'Hay una prueba en el proyector'
    : !next ? '' : next.ready ? 'Lista en el proyector' : 'Esperando al proyector';
  get('launch').textContent = ['rejected', 'interrupted'].includes(phase) && active === next?.name
    ? 'Volver a llamar' : 'Lanzar llamada';
  get('launch').disabled = busy || !connected || inCall || testing || !next?.ready;
  const signature = JSON.stringify(pending);
  if (signature === queueSignature) return;
  queueSignature = signature;
  get('empty').hidden = pending.length > 0;
  get('queue').replaceChildren(...pending.map(track => {
    const item = document.createElement('li');
    item.textContent = track.name;
    return item;
  }));
}

async function poll() {
  if (!token || busy || polling) return;
  polling = true;
  const currentToken = token;
  try {
    const result = await request('state');
    if (currentToken !== token || busy) return;
    state = result;
    connected = true;
    render();
  } catch (error) {
    if (currentToken !== token) return;
    if (error.status === 401) {
      logout();
      message('La sesión terminó. Vuelve a ingresar.');
    } else {
      connected = false;
      if (!state) get('detail').textContent = 'Reconectando…';
      render();
    }
  } finally {
    polling = false;
  }
}

get('login').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  busy = true;
  message();
  try {
    ({ token } = await request('login', { password: get('password').value }));
    sessionStorage.setItem(sessionKey, token);
    get('password').value = '';
    get('next').textContent = 'Conectando…';
    showSession();
  } catch (error) {
    message(error.message);
  } finally {
    busy = false;
    poll();
  }
});

get('logout').addEventListener('click', logout);
get('launch').addEventListener('click', async () => {
  if (busy || !state?.next || get('launch').disabled) return;
  const currentToken = token;
  busy = true;
  render();
  message();
  try {
    const result = await request('launch', { id: state.next.id });
    if (currentToken === token) state = result;
  } catch (error) {
    if (currentToken !== token) return;
    if (error.status === 401) logout();
    message(error.message);
  } finally {
    busy = false;
    if (currentToken === token) render();
    poll();
  }
});

showSession();
if (token) get('next').textContent = 'Conectando…';
poll();
setInterval(poll, 1500);
