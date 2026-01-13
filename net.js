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

// Main entry: request an action. Ensures single-flight (drops/blocks spam).
Net.requestAction = async function (action) {
  if (inFlight) return { ok: false, reason: 'Busy' };

	console.log("requesting " + action)

  const ac = new AbortController();
  inFlight = ac;

  try {
    const payload = {
      gameId: Net.gameId || 'local-dev', // swap later
      action,
      // client-side hinting/debug (optional):
      client: {
        posHash: Util.hashPosition(toMove),
      },
    };

    const r = await Net._post('/api/move', payload, { signal: ac.signal });

    if (!r.ok) return { ok: false, reason: r.reason };

    // expected server response:
    // { ok:true, accepted:true/false, reason?, state? }
    const out = r.data;

    if (!out.ok || !out.accepted) {
      return { ok: false, reason: out.reason || 'Rejected' };
    }

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
