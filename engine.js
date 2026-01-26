// engine.js
window.Engine = window.Engine || {};

let scoreResult = null;
Engine.getScoreResult = () => scoreResult;







// Network mode flag
let netMode = true; // when true: do not mutate on click; request server
Engine.setNetMode = (v) => { netMode = !!v; };
Engine.isNetMode = () => netMode;

// Simple “busy” gate so you can block input while waiting
let netBusy = false;
Engine.isNetBusy = () => netBusy;
Engine._setNetBusy = (v) => { netBusy = !!v; };

// Server phase sync hook (called by Net.applyState)
Engine._setServerPhase = function (state) {
  if (state.phase) phase = state.phase;
  if (typeof state.passStreak === 'number') passStreak = state.passStreak;

  if (state.deadSet) {
    deadSet = new Set(state.deadSet);
  } else {
    deadSet.clear();
  }

  scoreResult = state.scoreResult || null;

  // keep status text consistent
  if ((phase === 'scoring' || phase === 'finished') && scoreResult) {
    const s = scoreResult;
    Util.setStatus(
      `${phase === 'finished' ? 'Final' : 'Scoring'} — ` +
      `B:${s.blackTotal} (S${s.blackStones}+T${s.blackTerritory}) ` +
      `W:${s.whiteTotal} (S${s.whiteStones}+T${s.whiteTerritory})`
    );
  } else {
    Util.setStatus('Ready');
  }
};

Engine._cloneBoard = function (b) {
  return b.map((row) => row.slice());
};

// Pure: simulate a play on provided state, return next state or rejection.
Engine.simulatePlayBase = function (x, y, state) {
  const { N: n, board: b0, toMove: p0, seen: seen0, phase: ph0, passStreak: ps0 } = state;

  if (ph0 !== 'play') return { ok: false, reason: 'Scoring' };

  x = Util.mod(x, n);
  y = Util.mod(y, n);

  if (b0[y][x] !== 0) return { ok: false, reason: 'Occupied' };

  const b = Engine._cloneBoard(b0);
  const seen = new Set(seen0);

  b[y][x] = p0;

  const other = (p) => (p === 1 ? 2 : 1);
  const opp = other(p0);

  const neighbors = (xx, yy) => ([
    [Util.mod(xx + 1, n), yy],
    [Util.mod(xx - 1, n), yy],
    [xx, Util.mod(yy + 1, n)],
    [xx, Util.mod(yy - 1, n)],
  ]);

  const collectGroupAndLibertiesOn = (xx, yy) => {
    const color = b[yy][xx];
    const stack = [[xx, yy]];
    const visited = new Set();
    const stones = [];
    const key = (a, c) => a + ',' + c;
    visited.add(key(xx, yy));

    while (stack.length) {
      const [cx, cy] = stack.pop();
      stones.push([cx, cy]);
      for (const [nx, ny] of neighbors(cx, cy)) {
        if (b[ny][nx] !== color) continue;
        const k = key(nx, ny);
        if (visited.has(k)) continue;
        visited.add(k);
        stack.push([nx, ny]);
      }
    }

    const libset = new Set();
    for (const [sx, sy] of stones) {
      for (const [nx, ny] of neighbors(sx, sy)) {
        if (b[ny][nx] === 0) libset.add(nx + ',' + ny);
      }
    }
    return { color, stones, liberties: libset.size };
  };

  const removeStonesOn = (stones) => {
    for (const [sx, sy] of stones) b[sy][sx] = 0;
  };

  // capture
  let captured = 0;
  const checked = new Set();
  for (const [nx, ny] of neighbors(x, y)) {
    if (b[ny][nx] !== opp) continue;
    const k = nx + ',' + ny;
    if (checked.has(k)) continue;

    const g = collectGroupAndLibertiesOn(nx, ny);
    for (const [sx, sy] of g.stones) checked.add(sx + ',' + sy);

    if (g.liberties === 0) {
      captured += g.stones.length;
      removeStonesOn(g.stones);
    }
  }

  // suicide
  const myGroup = collectGroupAndLibertiesOn(x, y);
  if (myGroup.liberties === 0) return { ok: false, reason: 'Suicide' };

  // next player
  const p1 = other(p0);

  // superko: hash with next player
  const hashPositionOn = (nextPlayer) => {
    let s = '' + nextPlayer + '|';
    for (let yy = 0; yy < n; yy++) s += b[yy].join('') + ';';
    return s;
  };

  const h = hashPositionOn(p1);
  if (seen.has(h)) return { ok: false, reason: 'Superko' };

  seen.add(h);

  return {
    ok: true,
    captured,
    next: {
      N: n,
      board: b,
      toMove: p1,
      seen: Array.from(seen),
      phase: 'play',
      passStreak: 0,
	  lastMove: { bx: x, by: y },
    },
  };
};

// Commit helper (offline/local authoritative)
Engine.applyStateLocal = function (next) {
  if (next.N && next.N !== N) Util.setBoardSize(next.N);
  board = next.board;
  window.lastMove = next.lastMove || null;
  Util.setToMove(next.toMove);
  Util.seen = new Set(next.seen || []);
  phase = next.phase || 'play';
  passStreak = typeof next.passStreak === 'number' ? next.passStreak : 0;
  Util._syncGlobals();
};








Engine.neighbors = function (x, y) {
  return [
    [Util.wrap(x + 1), y],
    [Util.wrap(x - 1), y],
    [x, Util.wrap(y + 1)],
    [x, Util.wrap(y - 1)],
  ];
};

Engine.collectGroupAndLiberties = function (x, y) {
  const color = board[y][x];
  const stack = [[x, y]];
  const visited = new Set();
  const stones = [];

  const key = (a, b) => a + ',' + b;
  visited.add(key(x, y));

  while (stack.length) {
    const [cx, cy] = stack.pop();
    stones.push([cx, cy]);
    for (const [nx, ny] of Engine.neighbors(cx, cy)) {
      const v = board[ny][nx];
      if (v !== color) continue;
      const k = key(nx, ny);
      if (visited.has(k)) continue;
      visited.add(k);
      stack.push([nx, ny]);
    }
  }

  // Dedupe liberties exactly
  const libset = new Set();
  for (const [sx, sy] of stones) {
    for (const [nx, ny] of Engine.neighbors(sx, sy)) {
      if (board[ny][nx] === 0) libset.add(nx + ',' + ny);
    }
  }

  return { color, stones, liberties: libset.size };
};

Engine.removeStones = function (stones) {
  for (const [x, y] of stones) board[y][x] = 0;
};

// Absolute wrapper (UI speaks absolute)
Engine.tryPlayAbs = function (ax, ay) {
  const { bx, by } = Util.absToBase(ax, ay);
  return Engine.tryPlayBase(bx, by);
};

// Base engine (rules speak wrapped base coords)
Engine.tryPlayBase = function (x, y) {
  if (phase !== 'play') return { ok: false, reason: 'Scoring' };
  x = Util.wrap(x);
  y = Util.wrap(y);

  if (board[y][x] !== 0) return { ok: false, reason: 'Occupied' };

  // Snapshot for rollback
  const prevBoard = board.map((row) => row.slice());
  const prevToMove = toMove;
  const prevSeen = new Set(Util.seen);

  board[y][x] = toMove;

  // Capture adjacent opponent groups with 0 liberties
  let captured = 0;
  const opp = Util.other(toMove);
  const checked = new Set();

  for (const [nx, ny] of Engine.neighbors(x, y)) {
    if (board[ny][nx] !== opp) continue;
    const k = nx + ',' + ny;
    if (checked.has(k)) continue;

    const g = Engine.collectGroupAndLiberties(nx, ny);
    for (const [sx, sy] of g.stones) checked.add(sx + ',' + sy);

    if (g.liberties === 0) {
      captured += g.stones.length;
      Engine.removeStones(g.stones);
    }
  }

  // Suicide check
  const myGroup = Engine.collectGroupAndLiberties(x, y);
  if (myGroup.liberties === 0) {
    board = prevBoard;
    toMove = prevToMove;
    Util.seen = prevSeen;
    Util._syncGlobals();
    return { ok: false, reason: 'Suicide' };
  }

  // Switch player
  toMove = Util.other(toMove);
  Util._syncGlobals();

  // Superko check (position with next player to move)
  const h = Util.hashPosition(toMove);
  if (Util.seen.has(h)) {
    board = prevBoard;
    toMove = prevToMove;
    Util.seen = prevSeen;
    Util._syncGlobals();
    return { ok: false, reason: 'Superko' };
  }

  Util.seen.add(h);
  
  // if move succeeds:
  passStreak = 0;
  return { ok: true, captured };
};

Engine.pass = function() {
  if (phase !== 'play') return;

  toMove = Util.other(toMove);
  window.lastMove = null;
  Util.seen.add(Util.hashPosition(toMove));
  Util.setTurnUI();

  passStreak++;
  if (passStreak >= 2) {
    Engine.enterScoring();
    return;
  }

  Util.setStatus('Pass');
  Render.requestRender();
};

Engine.reset = function(n = N) {
  Util.setBoardSize(n);
  board = Util.makeBoard(N);
  Util.setToMove(1);
  Util.setCameraAbs((N - 1) / 2, (N - 1) / 2);

  Util.seen = new Set();
  Util.rememberPosition();

  phase = 'play';
  passStreak = 0;
  deadSet.clear();
  window.lastMove = null;
  scoreResult = null;

  Util.setTurnUI();
  Util.setStatus('Ready');
  Render.requestRender();
};

// ---- scoring state ----
let phase = 'play';     // 'play' | 'scoring'
let passStreak = 0;

// dead stones are tracked in BASE coords (x,y in 0..N-1)
let deadSet = new Set();
const dkey = (x, y) => x + ',' + y;

Engine.getPhase = () => phase;
Engine.getScoreResult = () => scoreResult;
Engine.isDeadBase = (x, y) => deadSet.has(dkey(x, y));
Engine.clearDead = () => { deadSet.clear(); };

// helper: board value with dead stones treated as empty (for scoring)
Engine.valueForScoring = function(x, y) {
  return deadSet.has(dkey(x, y)) ? 0 : board[y][x];
};

Engine.enterScoring = function() {
  phase = 'scoring';
  scoreResult = Engine.computeScore(); // uses valueForScoring
  const s = scoreResult;
  Util.setStatus(
    `Scoring — B:${s.blackTotal} (S${s.blackStones}+T${s.blackTerritory}) ` +
    `W:${s.whiteTotal} (S${s.whiteStones}+T${s.whiteTerritory})`
  );
  Render.requestRender();
};

Engine.exitScoring = function() {
  phase = 'play';
  passStreak = 0;
  deadSet.clear();
  scoreResult = null;
  Util.setStatus('Ready');
  Render.requestRender();
};

// Toggle dead for the entire connected group at base (x,y)
Engine.toggleDeadGroupBase = function(x, y) {
  x = Util.wrap(x); y = Util.wrap(y);
  const v = board[y][x];
  if (v === 0) return { ok: false, reason: 'Empty' };
  if (phase !== 'scoring') return { ok: false, reason: 'Not scoring' };

  const g = Engine.collectGroupStonesOnly(x, y); // new helper below

  // if ANY stone is dead => revive whole group; else kill whole group
  let anyDead = false;
  for (const [sx, sy] of g.stones) {
    if (deadSet.has(dkey(sx, sy))) { anyDead = true; break; }
  }

  if (anyDead) {
    for (const [sx, sy] of g.stones) deadSet.delete(dkey(sx, sy));
  } else {
    for (const [sx, sy] of g.stones) deadSet.add(dkey(sx, sy));
  }

  // recompute score + territory shading immediately
  scoreResult = Engine.computeScore();
  const s = scoreResult;
  Util.setStatus(
    `Scoring — B:${s.blackTotal} (S${s.blackStones}+T${s.blackTerritory}) ` +
    `W:${s.whiteTotal} (S${s.whiteStones}+T${s.whiteTerritory})`
  );

  return { ok: true };
};

// Absolute wrapper for toggling
Engine.toggleDeadAtAbs = function(ax, ay) {
  const { bx, by } = Util.absToBase(ax, ay);
  return Engine.toggleDeadGroupBase(bx, by);
};

// Replace your collectGroupAndLiberties with a stones-only helper for dead marking
Engine.collectGroupStonesOnly = function(x, y) {
  const color = board[y][x];
  const stack = [[x, y]];
  const visited = new Set();
  const stones = [];
  const key = (a, b) => a + ',' + b;
  visited.add(key(x, y));

  while (stack.length) {
    const [cx, cy] = stack.pop();
    stones.push([cx, cy]);
    for (const [nx, ny] of Engine.neighbors(cx, cy)) {
      if (board[ny][nx] !== color) continue;
      const k = key(nx, ny);
      if (visited.has(k)) continue;
      visited.add(k);
      stack.push([nx, ny]);
    }
  }
  return { color, stones };
};

// Create a brand-new server game with board size n, then swap Net.gameId + state
Engine.newGame = async function (n = N) {
  const safeN = Util.clampInt(parseInt(n, 10), 5, 49);

  if (!Engine.isNetMode || !Engine.isNetMode()) {
    Engine.reset(safeN);
    return { ok: true };
  }

  if (Engine.isNetBusy && Engine.isNetBusy()) return { ok: false, reason: 'Busy' };

  Engine._setNetBusy(true);
  try {
    const r = await Net._post('/api/game/new', { N: safeN });
    if (!r.ok) return { ok: false, reason: r.reason };

    const out = r.data;
    if (!out.ok || !out.gameId || !out.state) return { ok: false, reason: out.error || 'Bad response' };

    Net.gameId = out.gameId;
    Net.applyState(out.state);
    Util.setStatus('Ready');
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e?.message || 'Network error' };
  } finally {
    Engine._setNetBusy(false);
  }
};


// --- scoring: modify computeScore to use Engine.valueForScoring and to emit ownership ---
Engine.computeScore = function() {
  let blackStones = 0, whiteStones = 0;
  let blackTerritory = 0, whiteTerritory = 0, neutral = 0;

  // ownership[y][x] = 0 neutral, 1 black terr, 2 white terr
  const ownership = Array.from({ length: N }, () => Array(N).fill(0));

  // count stones (excluding dead)
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const v = Engine.valueForScoring(x, y);
      if (v === 1) blackStones++;
      else if (v === 2) whiteStones++;
    }
  }

  // territory via empty-region flood fill (wrapped adjacency)
  const visited = new Set();
  const key = (x, y) => x + ',' + y;

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (Engine.valueForScoring(x, y) !== 0) continue;
      const k0 = key(x, y);
      if (visited.has(k0)) continue;

      const q = [[x, y]];
      const region = [];
      visited.add(k0);

      let regionSize = 0;
      const border = new Set(); // 1/2

      while (q.length) {
        const [cx, cy] = q.pop();
        region.push([cx, cy]);
        regionSize++;

        for (const [nx, ny] of Engine.neighbors(cx, cy)) {
          const v = Engine.valueForScoring(nx, ny);
          if (v === 0) {
            const k = key(nx, ny);
            if (!visited.has(k)) {
              visited.add(k);
              q.push([nx, ny]);
            }
          } else {
            border.add(v);
          }
        }
      }

      if (border.size === 1) {
        const only = border.values().next().value;
        if (only === 1) blackTerritory += regionSize;
        else if (only === 2) whiteTerritory += regionSize;

        for (const [rx, ry] of region) ownership[ry][rx] = only;
      } else {
        neutral += regionSize;
      }
    }
  }

  return {
    blackStones, whiteStones,
    blackTerritory, whiteTerritory,
    neutral,
    ownership,
    blackTotal: blackStones + blackTerritory,
    whiteTotal: whiteStones + whiteTerritory,
  };
};