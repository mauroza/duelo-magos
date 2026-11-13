// Cliente web de Duelo de Magos (sin dependencias). El servidor es autoritativo: este cliente
// solo envía intenciones y dibuja lo que el servidor le permite ver.
const $ = (id) => document.getElementById(id);
const EMOJI = { fuego: '🔥', agua: '💧', tierra: '🪨' };
const ACTION_TEXT = { attack: 'atacó', shield: 'levantó un escudo', channel: 'canalizó maná' };

const st = {
  access: null,
  refresh: sessionStorage.getItem('refresh'),
  user: null,
  ws: null,
  retry: 0,
  matchId: sessionStorage.getItem('matchId'),
  view: null,
  seq: 0,
  code: null,
  element: null,
  target: null,
  timer: null,
};
let msgId = 0;
const pending = new Map();

// ───────────── HTTP ─────────────
async function api(method, path, body, retry = true) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (st.access) headers.authorization = `Bearer ${st.access}`;
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 401 && retry && st.refresh && !path.startsWith('/v1/auth')) {
    if (await refreshTokens()) return api(method, path, body, false);
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw Object.assign(new Error(data?.detail ?? res.statusText), { code: data?.code, status: res.status });
  return data;
}

async function refreshTokens() {
  try {
    const t = await api('POST', '/v1/auth/refresh', { refreshToken: st.refresh }, false);
    setTokens(t);
    return true;
  } catch {
    logout();
    return false;
  }
}

function setTokens(t) {
  st.access = t.accessToken;
  st.refresh = t.refreshToken;
  sessionStorage.setItem('refresh', t.refreshToken);
}

// ───────────── tiempo real ─────────────
async function connect() {
  const { ticket } = await api('POST', '/v1/realtime/ticket');
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/v1/ws?ticket=${encodeURIComponent(ticket)}`);
  st.ws = ws;
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  ws.onopen = () => {
    st.retry = 0;
    $('conn').classList.add('on');
  };
  ws.onclose = (e) => {
    $('conn').classList.remove('on');
    if (st.ws !== ws) return;
    st.ws = null;
    if (e.code === 4010) return logout('Tu cuenta fue suspendida');
    if (!st.user) return;
    // Reconexión con espera exponencial (4012 = el servidor se reinicia: reconectar ya).
    const wait = e.code === 4012 ? 300 : Math.min(8000, 500 * 2 ** st.retry++);
    setTimeout(() => st.user && connect().catch(() => undefined), wait);
  };
}

function send(type, payload) {
  const id = `w${++msgId}`;
  return new Promise((resolve, reject) => {
    if (!st.ws || st.ws.readyState !== WebSocket.OPEN) return reject(new Error('Sin conexión, reintentando…'));
    pending.set(id, { resolve, reject });
    st.ws.send(JSON.stringify({ v: 1, type, id, payload }));
    setTimeout(() => pending.delete(id) && reject(new Error('Sin respuesta del servidor')), 10000);
  });
}

function onMessage(msg) {
  if (msg.replyTo && pending.has(msg.replyTo)) {
    const p = pending.get(msg.replyTo);
    pending.delete(msg.replyTo);
    msg.type === 'error' ? p.reject(Object.assign(new Error(msg.payload.message), { code: msg.payload.code })) : p.resolve(msg.payload);
  }
  switch (msg.type) {
    case 'welcome':
      if (st.matchId) subscribe(st.matchId);
      break;
    case 'match.sync':
      if (msg.payload.matchId !== st.matchId) return;
      st.view = msg.payload.view;
      st.seq = msg.payload.seq;
      renderGame();
      break;
    case 'match.update':
      onUpdate(msg.payload);
      break;
    case 'matchmaking.matched':
      $('queueInfo').textContent = '';
      toggleQueue(false);
      enterMatch(msg.payload.matchId);
      break;
    case 'matchmaking.timeout':
      toggleQueue(false);
      $('queueInfo').textContent = 'No encontramos rival a tiempo. Intenta de nuevo.';
      break;
  }
}

function subscribe(matchId) {
  send('match.subscribe', { matchId }).catch((e) => {
    if (e.code === 'NOT_A_PARTICIPANT' || e.code === 'NOT_FOUND') leaveGameView();
  });
}

// Aplica cambios mínimos. Si falta una secuencia, se resincroniza.
function onUpdate({ matchId, fromSeq, toSeq, events }) {
  if (matchId !== st.matchId || !st.view) return;
  if (toSeq <= st.seq) return;
  if (fromSeq > st.seq + 1) return subscribe(matchId);
  st.seq = toSeq;
  const v = st.view;
  const name = (id) => v.players.find((p) => p.id === id)?.name ?? '¿?';
  for (const e of events) {
    switch (e.type) {
      case 'lobby.updated':
        v.players = e.players.map((p) => ({ hp: 0, mana: 0, alive: true, connected: true, hasActed: false, ...v.players.find((x) => x.id === p.id), ...p }));
        break;
      case 'match.started':
        Object.assign(v, { status: 'active', round: e.round, roundDeadline: e.deadline });
        v.players = e.players.map((p) => ({ ...p, ready: true, hasActed: false }));
        log('<strong>¡Comienza el duelo!</strong>');
        break;
      case 'affinity.assigned':
        if (v.you) v.you.affinity = e.affinity;
        break;
      case 'action.accepted': {
        const p = v.players.find((x) => x.id === e.playerId);
        if (p) p.hasActed = true;
        break;
      }
      case 'round.resolved':
        for (const o of e.outcomes) {
          const p = v.players.find((x) => x.id === o.playerId);
          if (p) Object.assign(p, { hp: o.hp, mana: o.mana, alive: o.alive, hasActed: false });
          if (v.you && o.playerId === v.you.id) v.you.shieldAvailable = o.action.kind !== 'shield';
          const act = o.action.kind === 'attack' ? `atacó a ${name(o.action.target)} con ${EMOJI[o.action.element]} ${o.action.element}` : ACTION_TEXT[o.action.kind];
          log(`R${e.round}: <strong>${esc(name(o.playerId))}</strong> ${esc(act)}${o.defaulted ? ' (tiempo agotado)' : ''}${o.damageTaken ? ` · recibió ${o.damageTaken} de daño` : ''}${o.alive ? '' : ' · ☠ eliminado'}`);
        }
        if (v.you) v.you.pendingAction = null;
        v.round = e.round + 1;
        v.roundDeadline = e.nextDeadline;
        st.target = null;
        st.animate = e.outcomes;
        break;
      case 'player.presence': {
        const p = v.players.find((x) => x.id === e.playerId);
        if (p) p.connected = e.connected;
        if (!e.connected && v.status === 'active') log(`${esc(name(e.playerId))} se desconectó; tiene un periodo de gracia.`);
        break;
      }
      case 'player.abandoned': {
        const p = v.players.find((x) => x.id === e.playerId);
        if (p) Object.assign(p, { alive: false, hp: 0 });
        log(`${esc(name(e.playerId))} abandonó el duelo.`);
        break;
      }
      case 'match.ended':
        Object.assign(v, { status: 'finished', result: e.result, affinities: e.affinities });
        break;
      case 'match.expired':
        v.status = 'aborted';
        break;
    }
  }
  renderGame();
  if (st.animate) {
    const outcomes = st.animate;
    st.animate = null;
    playRound(outcomes);
  }
}

// ───────────── vistas ─────────────
function show(section) {
  for (const id of ['auth', 'lobby', 'game']) $(id).hidden = id !== section;
}

async function enterLobby() {
  show('lobby');
  st.matchId = null;
  sessionStorage.removeItem('matchId');
  await Promise.all([loadRooms(), loadHistory()]).catch(() => undefined);
}

function enterMatch(matchId, code = null) {
  st.matchId = matchId;
  st.code = code;
  st.view = null;
  st.seq = 0;
  sessionStorage.setItem('matchId', matchId);
  $('log').innerHTML = '';
  show('game');
  subscribe(matchId);
}

function leaveGameView() {
  clearInterval(st.timer);
  enterLobby();
}

async function loadRooms() {
  const { items } = await api('GET', '/v1/matches?limit=20');
  $('rooms').innerHTML = items.length ? '' : '<li class="muted">No hay salas abiertas. ¡Crea una!</li>';
  for (const r of items) {
    const li = document.createElement('li');
    li.innerHTML = `<span><strong>${esc(r.hostName)}</strong> <span class="muted">${r.players}/${r.maxPlayers} magos</span></span>`;
    const b = document.createElement('button');
    b.className = 'secondary';
    b.textContent = 'Unirme';
    b.onclick = () => api('POST', `/v1/matches/${r.id}/join`).then(() => enterMatch(r.id)).catch(alertError);
    li.append(b);
    $('rooms').append(li);
  }
}

async function loadHistory() {
  const { items } = await api('GET', '/v1/history?limit=10');
  $('history').innerHTML = items.length ? '' : '<li class="muted">Aún no tienes duelos terminados.</li>';
  for (const h of items) {
    const li = document.createElement('li');
    const outcome = h.status === 'aborted' ? 'Cancelada' : h.won ? '🏆 Victoria' : h.result?.draw ? 'Empate' : 'Derrota';
    li.innerHTML = `<span>${outcome}</span><span class="muted small">${h.finishedAt ? new Date(h.finishedAt).toLocaleString() : ''}</span>`;
    $('history').append(li);
  }
}

function renderGame() {
  const v = st.view;
  if (!v) return;
  const me = v.players.find((p) => p.id === v.you?.id);
  $('round').textContent = v.status === 'lobby' ? 'sala' : v.round;
  $('code').textContent = st.code ? `Código: ${st.code}` : '';
  $('players').innerHTML = '';
  v.players.forEach((p, i) => {
    const el = document.createElement('div');
    const targetable = v.status === 'active' && me?.alive && p.alive && p.id !== me.id && !v.you?.pendingAction;
    const winner = v.result?.winners?.includes(p.id);
    el.className = `mage${p.id === me?.id ? ' me' : ''}${p.alive ? '' : ' dead'}${targetable ? ' targetable' : ''}${st.target === p.id ? ' target' : ''}${winner ? ' winner' : ''}`;
    el.dataset.id = p.id;
    const ended = v.status === 'finished' || v.status === 'aborted';
    const bubble = ended ? (winner ? '🏆' : '') : v.status === 'lobby' ? (p.ready ? '✓' : '…') : !p.alive ? '' : p.hasActed ? '✓' : '…';
    const aff = v.affinities?.[p.id] ? `<span class="aff ${v.affinities[p.id]}">${EMOJI[v.affinities[p.id]]}</span>` : '';
    el.innerHTML = `
      <div class="bubble${bubble === '✓' || bubble === '🏆' ? ' ok' : ''}"${bubble ? '' : ' hidden'}>${bubble}</div>
      <div class="avatar">${mageSVG(i, p.alive)}${aff}</div>
      <div class="plate">
        <div class="name">${esc(p.name)}${p.id === me?.id ? ' <span class="you">tú</span>' : ''}${p.connected ? '' : ' <span title="desconectado">⚡</span>'}</div>
        <div class="bar hp"><div style="width:${(p.hp / 12) * 100}%"></div></div>
        <div class="stat"><span>❤ ${p.hp}</span><span>✦ ${p.mana}</span></div>
        <div class="bar mana"><div style="width:${(p.mana / (v.config?.maxMana ?? 6)) * 100}%"></div></div>
      </div>`;
    if (targetable) el.onclick = () => { st.target = p.id; renderGame(); };
    $('players').append(el);
  });
  $('lobbyActions').hidden = v.status !== 'lobby';
  $('ready').textContent = me?.ready ? 'Ya no estoy listo' : 'Estoy listo';
  const playing = v.status === 'active' && me?.alive;
  $('actions').hidden = !playing;
  if (playing) {
    const aff = v.you?.affinity;
    $('affinity').textContent = aff ? `${EMOJI[aff]} ${aff}` : '—';
    $('affinity').className = `el ${aff ?? ''}`;
    const acted = Boolean(v.you?.pendingAction);
    for (const b of document.querySelectorAll('.elements button')) {
      b.disabled = acted || me.mana < 1;
      b.classList.toggle('selected', b.dataset.el === st.element);
    }
    $('attack').disabled = acted || me.mana < 1 || !st.element || !st.target;
    $('shield').disabled = acted || me.mana < 1 || v.you?.shieldAvailable === false;
    $('channel').disabled = acted;
    $('waiting').textContent = acted ? 'Jugada enviada. Esperando a los demás magos…' : '';
  }
  const ended = v.status === 'finished' || v.status === 'aborted';
  $('result').hidden = !ended;
  if (ended) {
    clearInterval(st.timer);
    const r = v.result;
    const won = r?.winners?.includes(v.you?.id);
    $('resultTitle').textContent = v.status === 'aborted' ? 'Partida cancelada' : r?.draw ? 'Empate' : won ? '🏆 ¡Victoria!' : 'Derrota';
    const reasons = { last_standing: 'Último mago en pie.', max_rounds: 'Se alcanzó el máximo de rondas.', all_eliminated: 'Todos cayeron a la vez.', abandonment: 'Victoria por abandono.', terminated: 'Un administrador terminó la partida.' };
    $('resultDetail').textContent = reasons[r?.reason] ?? '';
    sessionStorage.removeItem('matchId');
  }
  startTimer();
}

function startTimer() {
  clearInterval(st.timer);
  const tick = () => {
    const v = st.view;
    if (!v?.roundDeadline || v.status !== 'active') return ($('timerFill').style.width = '0');
    const total = v.config?.roundMs ?? 20000;
    const left = Math.max(0, v.roundDeadline - Date.now());
    $('timerFill').style.width = `${(left / total) * 100}%`;
  };
  tick();
  st.timer = setInterval(tick, 250);
}

async function act(action) {
  $('actionError').textContent = '';
  try {
    const round = st.view.round;
    await send('action.submit', { matchId: st.matchId, clientMoveId: crypto.randomUUID(), round, action });
    // La confirmación puede llegar después del resultado de la ronda (si esta jugada la cerró):
    // solo se marca como pendiente si seguimos en la misma ronda.
    if (st.view.round === round && st.view.status === 'active') st.view.you.pendingAction = action;
    renderGame();
  } catch (e) {
    $('actionError').textContent = e.message;
  }
}

function log(html) {
  const li = document.createElement('li');
  li.innerHTML = html;
  $('log').prepend(li);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ───────────── arte: magos como esferas con sombrero (SVG) ─────────────
const PALETTE = [
  { body: '#a259ff', light: '#d7b4ff', dark: '#5b1fb5', hat: '#4b1d8f', hatLight: '#7a3fd1' },
  { body: '#22c7b8', light: '#a7f3ea', dark: '#0b6f68', hat: '#1d4f8f', hatLight: '#3b78c9' },
  { body: '#ff8a3d', light: '#ffd0a8', dark: '#b2470b', hat: '#8f1d3b', hatLight: '#c93b62' },
  { body: '#ff5fa2', light: '#ffc2dc', dark: '#a8155a', hat: '#3b1d8f', hatLight: '#6a45d6' },
];

function mageSVG(i, alive) {
  const c = PALETTE[i % PALETTE.length];
  const id = `m${i}`;
  return `<svg viewBox="0 0 140 160" class="mage-svg" aria-hidden="true">
    <defs>
      <radialGradient id="${id}b" cx="38%" cy="32%" r="70%">
        <stop offset="0" stop-color="${c.light}"/><stop offset=".45" stop-color="${c.body}"/><stop offset="1" stop-color="${c.dark}"/>
      </radialGradient>
      <linearGradient id="${id}h" x1="0" x2="1" y1="0" y2="1">
        <stop offset="0" stop-color="${c.hatLight}"/><stop offset="1" stop-color="${c.hat}"/>
      </linearGradient>
      <linearGradient id="${id}g" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0" stop-color="#ffe08a"/><stop offset="1" stop-color="#d99a1e"/>
      </linearGradient>
    </defs>
    <ellipse class="shadow" cx="70" cy="150" rx="40" ry="7" fill="#000" opacity=".45"/>
    <g class="body">
      <circle cx="70" cy="104" r="44" fill="url(#${id}b)"/>
      <ellipse cx="54" cy="86" rx="12" ry="7" fill="#fff" opacity=".28" transform="rotate(-30 54 86)"/>
      ${alive ? `<g class="eyes"><ellipse cx="57" cy="108" rx="4.5" ry="6" fill="#1a1030"/><ellipse cx="83" cy="108" rx="4.5" ry="6" fill="#1a1030"/>
        <circle cx="58.5" cy="105.5" r="1.6" fill="#fff"/><circle cx="84.5" cy="105.5" r="1.6" fill="#fff"/></g>`
        : `<g stroke="#1a1030" stroke-width="3" stroke-linecap="round"><path d="M52 103l9 9M61 103l-9 9M78 103l9 9M87 103l-9 9"/></g>`}
    </g>
    <g class="hat">
      <ellipse cx="70" cy="66" rx="60" ry="13" fill="url(#${id}h)"/>
      <path d="M38 64 C46 40 58 18 82 6 C92 1 104 4 110 14 C100 10 92 14 90 22 C88 36 96 52 102 64 Z" fill="url(#${id}h)"/>
      <path d="M38 64 C40 57 42 52 44 48 L98 48 C99 53 101 58 102 64 C80 70 60 70 38 64 Z" fill="url(#${id}g)"/>
      <path d="M68 30a9 9 0 1 0 9 -11a7 7 0 1 1 -9 11z" fill="#ffd45e"/>
      <path d="M56 40l1.6 3.4 3.7.4-2.8 2.5.8 3.7-3.3-1.9-3.3 1.9.8-3.7-2.8-2.5 3.7-.4z" fill="#ffd45e"/>
      <path d="M88 32l1.2 2.6 2.8.3-2.1 1.9.6 2.8-2.5-1.4-2.5 1.4.6-2.8-2.1-1.9 2.8-.3z" fill="#ffd45e"/>
      <path d="M82 14l1 2.1 2.3.3-1.7 1.5.5 2.3-2.1-1.2-2.1 1.2.5-2.3-1.7-1.5 2.3-.3z" fill="#ffd45e"/>
    </g>
  </svg>`;
}

const ELEMENT_COLOR = { fuego: '#ff7a45', agua: '#4cc3ff', tierra: '#c9a46b' };

function center(el) {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2 + window.scrollX, y: r.top + r.height * 0.55 + window.scrollY };
}

/** Anima la ronda resuelta: hechizos que vuelan, escudos, maná y daño flotante. */
function playRound(outcomes) {
  const node = (id) => document.querySelector(`.mage[data-id="${id}"]`);
  for (const o of outcomes) {
    const from = node(o.playerId);
    if (!from) continue;
    if (o.action.kind === 'shield') {
      const s = document.createElement('div');
      s.className = 'shield-fx';
      from.querySelector('.avatar').append(s);
      setTimeout(() => s.remove(), 1600);
    } else if (o.action.kind === 'channel') {
      for (let k = 0; k < 7; k++) {
        const sp = document.createElement('span');
        sp.className = 'spark';
        sp.style.left = `${20 + Math.random() * 60}%`;
        sp.style.animationDelay = `${Math.random() * 0.4}s`;
        from.querySelector('.avatar').append(sp);
        setTimeout(() => sp.remove(), 1500);
      }
    } else if (o.action.kind === 'attack') {
      const to = node(o.action.target);
      if (!to) continue;
      const a = center(from), b = center(to);
      const orb = document.createElement('div');
      orb.className = `orb ${o.action.element}`;
      orb.style.left = `${a.x}px`;
      orb.style.top = `${a.y}px`;
      document.body.append(orb);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        orb.style.transform = `translate(${b.x - a.x}px, ${b.y - a.y}px) scale(1.3)`;
      }));
      setTimeout(() => {
        orb.classList.add('burst');
        to.classList.add('hit');
        setTimeout(() => { orb.remove(); to.classList.remove('hit'); }, 450);
      }, 650);
    }
  }
  setTimeout(() => {
    for (const o of outcomes) {
      const el = node(o.playerId);
      if (!el || !o.damageTaken) continue;
      const d = document.createElement('div');
      d.className = 'dmg';
      d.textContent = `-${o.damageTaken}`;
      el.querySelector('.avatar').append(d);
      setTimeout(() => d.remove(), 1300);
    }
  }, 700);
}

function alertError(e) {
  alert(e.message);
}

function toggleQueue(on) {
  $('quick').hidden = on;
  $('cancelQuick').hidden = !on;
}

async function startSession(data) {
  setTokens(data);
  st.user = data.user ?? (await api('GET', '/v1/users/me'));
  $('who').textContent = st.user.name ?? st.user.displayName;
  $('session').hidden = false;
  await connect();
  if (st.matchId) enterMatch(st.matchId);
  else await enterLobby();
}

function logout(reason) {
  if (st.refresh) fetch('/v1/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: st.refresh }) });
  Object.assign(st, { access: null, refresh: null, user: null, matchId: null });
  sessionStorage.clear();
  const ws = st.ws;
  st.ws = null;
  ws?.close(1000);
  $('session').hidden = true;
  show('auth');
  if (reason) $('authError').textContent = reason;
}

// ───────────── eventos ─────────────
$('authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const mode = e.submitter?.dataset.mode ?? 'login';
  const f = new FormData(e.target);
  $('authError').textContent = '';
  try {
    const data = await api('POST', `/v1/auth/${mode}`, { username: f.get('username'), password: f.get('password') });
    await startSession(data);
  } catch (err) {
    $('authError').textContent = err.status === 429 ? 'Demasiados intentos; espera un momento.' : err.message;
  }
});
$('logout').onclick = () => logout();
$('quick').onclick = async () => {
  try {
    const r = await api('POST', '/v1/matchmaking/queue');
    toggleQueue(true);
    $('queueInfo').textContent = `Buscando rival… (posición ${r.position})`;
  } catch (e) {
    alertError(e);
  }
};
$('cancelQuick').onclick = async () => {
  await api('DELETE', '/v1/matchmaking/queue').catch(() => undefined);
  toggleQueue(false);
  $('queueInfo').textContent = '';
};
$('createPublic').onclick = () => api('POST', '/v1/matches', { visibility: 'public' }).then((r) => enterMatch(r.matchId)).catch(alertError);
$('createPrivate').onclick = () => api('POST', '/v1/matches', { visibility: 'private' }).then((r) => enterMatch(r.matchId, r.inviteCode)).catch(alertError);
$('codeForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = new FormData(e.target).get('code');
  api('POST', '/v1/matches/join-by-code', { code }).then((v) => enterMatch(v.matchId)).catch(alertError);
});
$('refreshRooms').onclick = () => loadRooms().catch(alertError);
$('ready').onclick = () => {
  const me = st.view.players.find((p) => p.id === st.view.you?.id);
  send('match.ready', { matchId: st.matchId, ready: !me?.ready }).catch(alertError);
};
$('leave').onclick = async () => {
  if (st.view?.status === 'active' && !confirm('Abandonar cuenta como derrota. ¿Seguro?')) return;
  await api('POST', `/v1/matches/${st.matchId}/leave`).catch(() => undefined);
  leaveGameView();
};
$('back').onclick = () => leaveGameView();
for (const b of document.querySelectorAll('.elements button')) {
  b.onclick = () => { st.element = b.dataset.el; renderGame(); };
}
$('attack').onclick = () => act({ kind: 'attack', element: st.element, target: st.target });
$('shield').onclick = () => act({ kind: 'shield' });
$('channel').onclick = () => act({ kind: 'channel' });

// Restaurar sesión tras recargar la página.
if (st.refresh) {
  api('POST', '/v1/auth/refresh', { refreshToken: st.refresh }, false)
    .then((t) => startSession(t))
    .catch(() => logout());
} else {
  show('auth');
}
