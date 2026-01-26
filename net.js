// net.js
window.Net = window.Net || {};

Net.baseUrl = ''; // same-origin by default. Set to 'http://localhost:3000' during dev.

let inFlight = null;

// seat availability from server
let seatState = { blackTaken: false, whiteTaken: false };

function setSeatStateFromServer(seats) {
  seatState = {
    blackTaken: !!seats?.blackTaken,
    whiteTaken: !!seats?.whiteTaken,
  };
  if (window.Util && Util.setSeatButtonsUI) Util.setSeatButtonsUI();
}

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

Net.claim = (side) => Net.requestAction({ type: "claim", side });
Net.release = (side) => Net.requestAction({ type: "release", side });
Net.getSeatState = () => seatState;
Net.setPhase = (phase) => Net.requestAction({ type: "setPhase", phase });
Net.toggleDead = (ax, ay) => Net.requestAction({ type: "toggleDead", ax, ay });
Net.finalizeScore = () => Net.requestAction({ type: "finalizeScore" });
Net.acceptScore = () => Net.requestAction({ type: "acceptScore" });
Net.unacceptScore = () => Net.requestAction({ type: "unacceptScore" });
Net.proposeScore = () => Net.requestAction({ type: "finalizeScore" }); // keep existing endpoint action name

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

// Server revision (authoritative). Updated on every Net.applyState.
Net.rev = 0;

Net.applyState = function (state) {
  const oldToMove = window.toMove;
  if (typeof state.rev === 'number') Net.rev = state.rev;
  if (state.N && state.N !== N) Util.setBoardSize(state.N);

  if (state.board) board = state.board;
  if (state.toMove) Util.setToMove(state.toMove);
  if (state.seen) Util.seen = new Set(state.seen);

  if (Engine && Engine._setServerPhase) Engine._setServerPhase(state);

  if (state.you && typeof state.you.side === 'number') {
    Util.setPlayerServer(state.you.side); // updates Util’s internal player
  }
  
  if (state.seats) setSeatStateFromServer(state.seats);
  if (state.you && typeof state.you.side === "number" && window.Util?.setPlayerServer) {
    Util.setPlayerServer(state.you.side);
  }
  
  window.phase = state.phase;
  window.lastMove = state.lastMove || null;
  window.deadSet = state.deadSet || [];
  window.scoreResult = state.scoreResult || null;
  window.score = state.score || null;
  
  if (window.Util?.getPendingMove && window.Util?.setPendingMove) {
    const pm = Util.getPendingMove();
    if (pm) {
      // any turn/phase change invalidates the preview
      if (state.phase !== 'play' || (typeof state.toMove === 'number' && state.toMove !== oldToMove)) {
        Util.setPendingMove(null);
      }
    }
  }

  Util.setScoringUI?.();
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
// --- WebSocket live updates (read-path) ---
let ws = null;
let wsGameId = null;
let wsRetry = 0;
let wsClosedByUs = false;

let wsLastMsgAt = 0;
let wsWatchdog = null;
let wsHeartbeat = null;
let wsNonce = 0;

function markWsAlive() { wsLastMsgAt = Date.now(); }

function startHeartbeat(myNonce) {
  stopHeartbeat();
  wsHeartbeat = setInterval(() => {
    if (wsClosedByUs) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (myNonce !== wsNonce) return;
    try { ws.send(JSON.stringify({ type: 'ping', t: Date.now() })); } catch {}
  }, 25_000);
}

function stopHeartbeat() {
  if (wsHeartbeat) clearInterval(wsHeartbeat);
  wsHeartbeat = null;
}

function startWatchdog(myNonce) {
  stopWatchdog();
  wsLastMsgAt = Date.now();
  wsWatchdog = setInterval(() => {
    if (wsClosedByUs) return;
    if (!wsGameId) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (myNonce !== wsNonce) return;

    const age = Date.now() - wsLastMsgAt;

    // If we haven't received *any* app-level traffic (pong/state/etc), force reconnect.
    if (age > 70_000) {
      try { ws.close(); } catch {}
    }
  }, 15_000);
}

function stopWatchdog() {
  if (wsWatchdog) clearInterval(wsWatchdog);
  wsWatchdog = null;
}

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

  // bump generation so old handlers become no-ops
  wsNonce++;

  // drop any prior socket without letting it schedule reconnects
  try { ws?.close(); } catch {}
  ws = null;

  const myNonce = wsNonce;
  const url = wsUrlFor(gameId);
  const sock = new WebSocket(url);
  ws = sock;

  sock.onopen = () => {
    if (myNonce !== wsNonce) return;
    wsRetry = 0;
    markWsAlive();
    startHeartbeat(myNonce);
    startWatchdog(myNonce);
    try { sock.send(JSON.stringify({ type: 'hello', rev: Net.rev })); } catch {}
  };

  sock.onmessage = (ev) => {
    if (myNonce !== wsNonce) return;
    markWsAlive();

    let msg = null;
    try { msg = JSON.parse(ev.data); } catch {}
    if (!msg) return;

    if (msg.type === 'pong') return;

    if (msg.type === 'state' && msg.state) {
      Net.applyState(msg.state);
      return;
    }

    if (msg.type === 'deleted') {
      Util.setStatus('Game deleted');
      window.location.href = '/';
      return;
    }

    if (msg.type === 'error') {
      Util.setStatus(msg.error || 'WS error');
      return;
    }
  };

  sock.onclose = () => {
    if (myNonce !== wsNonce) return;
    stopHeartbeat();
    stopWatchdog();
    ws = null;

    if (wsClosedByUs) return;
    wsRetry++;
    setTimeout(() => {
      if (!wsClosedByUs && wsGameId) Net.connect(wsGameId);
    }, wsBackoffMs());
  };

  sock.onerror = () => {
    if (myNonce !== wsNonce) return;
    try { sock.close(); } catch {}
  };
};

Net.disconnect = function () {
  wsClosedByUs = true;
  wsGameId = null;
  wsNonce++; // invalidate handlers
  stopHeartbeat();
  stopWatchdog();
  if (ws) {
    try { ws.close(); } catch {}
    ws = null;
  }
};

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (!wsClosedByUs && wsGameId) Net.connect(wsGameId);
  }
});

window.addEventListener('online', () => {
  if (!wsClosedByUs && wsGameId) Net.connect(wsGameId);
});