window.Engine = window.Engine || {};

Engine.neighbors = function(x, y) {
  return [
    [Util.wrap(x + 1), y],
    [Util.wrap(x - 1), y],
    [x, Util.wrap(y + 1)],
    [x, Util.wrap(y - 1)],
  ];
}

Engine.collectGroupAndLiberties = function(x, y) {
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
}

Engine.removeStones = function(stones) {
  for (const [x, y] of stones) board[y][x] = 0;
}

Engine.tryPlay = function(x, y) {
  x = Util.wrap(x); y = Util.wrap(y);
  if (board[y][x] !== 0) return { ok: false, reason: 'Occupied' };

  // Snapshot for rollback
  const prevBoard = board.map(row => row.slice());
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
    return { ok: false, reason: 'Suicide' };
  }

  // Switch player
  toMove = Util.other(toMove);

  // Superko check (position *with next player to move*)
  const h = Util.hashPosition(toMove);
  if (Util.seen.has(h)) {
    board = prevBoard;
    toMove = prevToMove;
    Util.seen = prevSeen;
    return { ok: false, reason: 'Superko' };
  }

  Util.seen.add(h);
  return { ok: true, captured };
}

Engine.pass = function() {
  toMove = Util.other(toMove);
  Util.seen.add(Util.hashPosition(toMove));
  Util.setTurnUI();
  Util.setStatus('Pass');
  Render.requestRender();
}

Engine.reset = function(n = N) {
  N = n;
  board = Util.makeBoard(N);
  toMove = 1;
  camWX = (N - 1) / 2;
  camWY = (N - 1) / 2;
  Util.seen = new Set();
  Util.rememberPosition();
  Util.setTurnUI();
  Util.setStatus('Ready');
  Render.requestRender();
}