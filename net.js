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
      client: { posHash: Util.hashPosition(toMove) },
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
