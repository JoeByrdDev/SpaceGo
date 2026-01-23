// net.js
window.Net = window.Net || {};

Net.baseUrl = ''; // same-origin by default. Set to 'http://localhost:3000' during dev.

let inFlight = null;

Net._post = async function (path, body, { signal } = {}) {
  const res = await fetch(Net.baseUrl + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  let data = null;
  try { data = await res.json(); } catch (_) {}

  if (!res.ok) {
    const msg = (data && data.error) || `HTTP ${res.status}`;
    return { ok: false, reason: msg, status: res.status, data };
  }
  return { ok: true, data };
};

Net._get = async function (path, { signal } = {}) {
  const res = await fetch(Net.baseUrl + path, { method: 'GET', signal });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) {
    const msg = (data && data.error) || `HTTP ${res.status}`;
    return { ok: false, reason: msg, status: res.status, data };
  }
  return { ok: true, data };
};

Net.listGames = async function () {
  const r = await Net._get('/api/games');
  if (!r.ok) return r;
  return { ok: true, games: r.data.games || [] };
};

Net.loadGame = async function (gameId) {
  const r = await Net._get(`/api/game/${encodeURIComponent(gameId)}`);
  if (!r.ok) return { ok: false, reason: r.reason };
  const out = r.data;
  if (!out.ok || !out.state) return { ok: false, reason: out.error || 'Bad response' };

  Net.gameId = gameId;
  Net.applyState(out.state);
  return { ok: true };
};

// Apply server-authoritative state into globals
Net.applyState = function (state) {
  // expected: { N, board, toMove, seen, phase, passStreak, deadSet, scoreResult }
  if (state.N && state.N !== N) Util.setBoardSize(state.N);

  if (state.board) board = state.board;
  if (state.toMove) Util.setToMove(state.toMove);

  if (state.seen) Util.seen = new Set(state.seen);

  if (Engine && Engine._setServerPhase) Engine._setServerPhase(state);

  Util.setTurnUI();
  Render.requestRender();
};

// Server revision (authoritative). Updated on every Net.applyState.
Net.rev = 0;

Net.applyState = function (state) {
  if (typeof state.rev === 'number') Net.rev = state.rev;
  if (state.N && state.N !== N) Util.setBoardSize(state.N);

  if (state.board) board = state.board;
  if (state.toMove) Util.setToMove(state.toMove);
  if (state.seen) Util.seen = new Set(state.seen);

  if (Engine && Engine._setServerPhase) Engine._setServerPhase(state);

  Util.setTurnUI();
  Render.requestRender();
};

Net.requestAction = async function (action) {
  if (inFlight) return { ok: false, reason: 'Busy' };

  const ac = new AbortController();
  inFlight = ac;

  try {
    const clientActionId = action.clientActionId || Util.newActionId();

    const payload = {
      gameId: Net.gameId || 'local-dev',
      rev: Net.rev,
      clientActionId,
      action,
      client: { posHash: Util.hashPosition(toMove), player: Util.getPlayer ? Util.getPlayer() : 0 },
    };

    const r = await Net._post('/api/move', payload, { signal: ac.signal });

    // Stale/out-of-date: server returns 409 + authoritative state.
    if (!r.ok && r.status === 409 && r.data && r.data.state) {
      Net.applyState(r.data.state);
      return { ok: false, reason: 'Out of date' };
    }

    if (!r.ok) return { ok: false, reason: r.reason };

    const out = r.data;
    if (!out.ok || !out.accepted) return { ok: false, reason: out.reason || 'Rejected' };
    if (out.state) Net.applyState(out.state);

    return { ok: true };
  } catch (e) {
    if (e && e.name === 'AbortError') return { ok: false, reason: 'Aborted' };
    return { ok: false, reason: e?.message || 'Network error' };
  } finally {
    inFlight = null;
  }
};

Net.cancel = function () {
  if (inFlight) inFlight.abort();
};

// --- WebSocket live updates (read-path) ---
let ws = null;
let wsGameId = null;
let wsRetry = 0;
let wsClosedByUs = false;

function wsUrlFor(gameId) {
  const proto = (location.protocol === 'https:') ? 'wss:' : 'ws:';
  // Net.baseUrl '' means same origin; if you set Net.baseUrl, we still connect same origin for now.
  const host = location.host;
  return `${proto}//${host}/ws?gameId=${encodeURIComponent(gameId)}`;
}

function wsBackoffMs() {
  // 250ms, 500ms, 1s, 2s, 4s, 8s cap
  const ms = 250 * Math.pow(2, Math.min(5, wsRetry));
  return Math.min(8000, ms);
}

Net.connect = function (gameId) {
  if (!gameId) return;
  wsGameId = gameId;
  wsClosedByUs = false;

  // already connected to same game
  if (ws && ws.readyState === WebSocket.OPEN && wsGameId === gameId) return;

  // drop any prior socket
  try { ws?.close(); } catch {}
  ws = null;

  const url = wsUrlFor(gameId);
  ws = new WebSocket(url);

  ws.onopen = () => {
    wsRetry = 0;
    // optional: tell server we want a resync (server already pushes on connect)
    try { ws.send(JSON.stringify({ type: 'hello', rev: Net.rev })); } catch {}
  };

  ws.onmessage = (ev) => {
    let msg = null;
    try { msg = JSON.parse(ev.data); } catch {}
    if (!msg) return;

    if (msg.type === 'state' && msg.state) {
      // authoritative update from server
      Net.applyState(msg.state);
      return;
    }

    if (msg.type === 'deleted') {
      Util.setStatus('Game deleted');
      // bounce to lobby
      window.location.href = '/';
      return;
    }

    if (msg.type === 'error') {
      Util.setStatus(msg.error || 'WS error');
      return;
    }
  };

  ws.onclose = () => {
    ws = null;
    if (wsClosedByUs) return;
    wsRetry++;
    setTimeout(() => {
      if (!wsClosedByUs && wsGameId) Net.connect(wsGameId);
    }, wsBackoffMs());
  };

  ws.onerror = () => {
    // close triggers reconnect
    try { ws?.close(); } catch {}
  };
};

Net.disconnect = function () {
  wsClosedByUs = true;
  wsGameId = null;
  if (ws) {
    try { ws.close(); } catch {}
    ws = null;
  }
};
