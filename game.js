const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

const turnPill = document.getElementById('turnPill');
const statusPill = document.getElementById('statusPill');
const passBtn = document.getElementById('passBtn');
const resetBtn = document.getElementById('resetBtn');
const sizeInput = document.getElementById('sizeInput');
const applySizeBtn = document.getElementById('applySizeBtn');

// --- Config ---
let N = clampInt(parseInt(sizeInput.value || '19', 10), 5, 49);
let cell = 34; // pixels per grid unit (intersection spacing)
const margin = 50; // extra grid drawn around viewport

// Camera in WORLD grid units (can grow without modulo; wrapping only for board lookup)
let camWX = (N - 1) / 2;
let camWY = (N - 1) / 2;

// Viewport cache (CSS pixels)
let viewW = 0;
let viewH = 0;

// Game state
// 0 empty, 1 black, 2 white
let board = makeBoard(N);
let toMove = 1;

// Superko: store hashes of (board + player to move)
let seen = new Set();
rememberPosition();

// Interaction state
let dragging = false;
let dragStart = null;
let camStart = null;
let dragMode = 'idle'; // 'idle' | 'pending' | 'pan'
let mouse = { x: 0, y: 0, over: null };

// Render scheduling
let rafPending = false;

// --- Utilities ---
function clampInt(v, lo, hi) {
  v = Number.isFinite(v) ? v : lo;
  return Math.max(lo, Math.min(hi, Math.trunc(v)));
}
function wrap(i) {
  // wraps integer i into [0..N-1]
  return ((i % N) + N) % N;
}
function floorDiv(a, b) {
  // math.floor(a / b) for negatives
  return Math.floor(a / b);
}
function makeBoard(n) {
  const b = new Array(n);
  for (let y = 0; y < n; y++) b[y] = new Array(n).fill(0);
  return b;
}
function other(p) { return p === 1 ? 2 : 1; }

function resizeCanvas(cssW, cssH) {
  const dpr = window.devicePixelRatio || 1;
  viewW = cssW;
  viewH = cssH;

  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  requestRender();
}

function setStatus(text) { statusPill.textContent = text; }
function setTurnUI() { turnPill.textContent = `Turn: ${toMove === 1 ? 'Black' : 'White'}`; }

// Hash board + toMove into a stable string
function hashPosition(nextPlayer = toMove) {
  let s = '' + nextPlayer + '|';
  for (let y = 0; y < N; y++) s += board[y].join('') + ';';
  return s;
}
function rememberPosition() { seen.add(hashPosition(toMove)); }

// --- Toroidal Go engine ---
function neighbors(x, y) {
  return [
    [wrap(x + 1), y],
    [wrap(x - 1), y],
    [x, wrap(y + 1)],
    [x, wrap(y - 1)],
  ];
}

function collectGroupAndLiberties(x, y) {
  const color = board[y][x];
  const stack = [[x, y]];
  const visited = new Set();
  const stones = [];

  const key = (a, b) => a + ',' + b;
  visited.add(key(x, y));

  while (stack.length) {
    const [cx, cy] = stack.pop();
    stones.push([cx, cy]);
    for (const [nx, ny] of neighbors(cx, cy)) {
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
    for (const [nx, ny] of neighbors(sx, sy)) {
      if (board[ny][nx] === 0) libset.add(nx + ',' + ny);
    }
  }

  return { color, stones, liberties: libset.size };
}

function removeStones(stones) {
  for (const [x, y] of stones) board[y][x] = 0;
}

function tryPlay(x, y) {
  x = wrap(x); y = wrap(y);
  if (board[y][x] !== 0) return { ok: false, reason: 'Occupied' };

  // Snapshot for rollback
  const prev = board[y].map((_, yy) => board[yy].slice());
  const prevToMove = toMove;

  board[y][x] = toMove;

  // Capture adjacent opponent groups with 0 liberties
  let captured = 0;
  const opp = other(toMove);
  const checked = new Set();

  for (const [nx, ny] of neighbors(x, y)) {
    if (board[ny][nx] !== opp) continue;
    const k = nx + ',' + ny;
    if (checked.has(k)) continue;

    const g = collectGroupAndLiberties(nx, ny);
    for (const [sx, sy] of g.stones) checked.add(sx + ',' + sy);

    if (g.liberties === 0) {
      captured += g.stones.length;
      removeStones(g.stones);
    }
  }

  // Suicide check
  const myGroup = collectGroupAndLiberties(x, y);
  if (myGroup.liberties === 0) {
    board = prev;
    toMove = prevToMove;
    return { ok: false, reason: 'Suicide' };
  }

  // Switch player
  toMove = other(toMove);

  // Superko check
  const h = hashPosition(toMove);
  if (seen.has(h)) {
    board = prev;
    toMove = prevToMove;
    return { ok: false, reason: 'Superko' };
  }

  seen.add(h);
  return { ok: true, captured };
}

function pass() {
  toMove = other(toMove);
  seen.add(hashPosition(toMove));
  setTurnUI();
  setStatus('Pass');
  requestRender();
}

function reset(n = N) {
  N = n;
  board = makeBoard(N);
  toMove = 1;
  camWX = (N - 1) / 2;
  camWY = (N - 1) / 2;
  seen = new Set();
  rememberPosition();
  setTurnUI();
  setStatus('Ready');
  requestRender();
}

// --- Coordinate transforms ---
function screenToWorld(sx, sy) {
  const wx = (sx - viewW / 2) / cell + camWX;
  const wy = (sy - viewH / 2) / cell + camWY;
  return { x: wx, y: wy };
}

function worldToScreen(wx, wy) {
  return {
    x: (wx - camWX) * cell + viewW / 2,
    y: (wy - camWY) * cell + viewH / 2,
  };
}

function worldToNearestIntersection(wx, wy) {
  const gx = Math.round(wx);
  const gy = Math.round(wy);
  const tileX = floorDiv(gx, N);
  const tileY = floorDiv(gy, N);
  return { gx, gy, x: wrap(gx), y: wrap(gy), tileX, tileY };
}

// --- Rendering ---
function requestRender() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    drawOnce();
  });
}

function drawOnce() {
  // Background
  ctx.clearRect(0, 0, viewW, viewH);
  ctx.fillStyle = '#0b0d10';
  ctx.fillRect(0, 0, viewW, viewH);

  // Visible world bounds in grid units
  const left = camWX - (viewW / 2 + margin) / cell;
  const right = camWX + (viewW / 2 + margin) / cell;
  const top = camWY - (viewH / 2 + margin) / cell;
  const bottom = camWY + (viewH / 2 + margin) / cell;

  drawGrid(left, right, top, bottom);
  drawStones(left, right, top, bottom);

  // Hover indicator, repeated like stones (cheap 3x3)
  if (mouse.over) drawHover(mouse.over.gx, mouse.over.gy);

  // Subtle center crosshair
  ctx.strokeStyle = 'rgba(233,238,245,0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(viewW / 2 - 10, viewH / 2);
  ctx.lineTo(viewW / 2 + 10, viewH / 2);
  ctx.moveTo(viewW / 2, viewH / 2 - 10);
  ctx.lineTo(viewW / 2, viewH / 2 + 10);
  ctx.stroke();
}

function drawGrid(left, right, top, bottom) {
  const x0 = Math.floor(left);
  const x1 = Math.ceil(right);
  const y0 = Math.floor(top);
  const y1 = Math.ceil(bottom);

  // Regular grid
  ctx.strokeStyle = 'rgba(233,238,245,0.12)';
  ctx.lineWidth = 1;

  // Vertical regular lines
  ctx.beginPath();
  for (let gx = x0; gx <= x1; gx++) {
    if (gx % N === 0) continue; // seam lines drawn thicker below
    const p1 = worldToScreen(gx, y0);
    const p2 = worldToScreen(gx, y1);
    if (p1.x < -margin || p1.x > viewW + margin) continue;
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
  }
  ctx.stroke();

  // Horizontal regular lines
  ctx.beginPath();
  for (let gy = y0; gy <= y1; gy++) {
    if (gy % N === 0) continue;
    const p1 = worldToScreen(x0, gy);
    const p2 = worldToScreen(x1, gy);
    if (p1.y < -margin || p1.y > viewH + margin) continue;
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
  }
  ctx.stroke();

  // Tile seam lines (repeat edges / "real board edges")
  ctx.strokeStyle = 'rgba(233,238,245,0.22)';
  ctx.lineWidth = 2;

  // Vertical seams at gx ≡ 0 (mod N)
  ctx.beginPath();
  // find first multiple of N >= x0
  let gx0 = x0 - ((x0 % N) + N) % N;
  for (let gx = gx0; gx <= x1; gx += N) {
    const p1 = worldToScreen(gx, y0);
    const p2 = worldToScreen(gx, y1);
    if (p1.x < -margin || p1.x > viewW + margin) continue;
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
  }
  ctx.stroke();

  // Horizontal seams at gy ≡ 0 (mod N)
  ctx.beginPath();
  let gy0 = y0 - ((y0 % N) + N) % N;
  for (let gy = gy0; gy <= y1; gy += N) {
    const p1 = worldToScreen(x0, gy);
    const p2 = worldToScreen(x1, gy);
    if (p1.y < -margin || p1.y > viewH + margin) continue;
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
  }
  ctx.stroke();
}

function drawStones(left, right, top, bottom) {
  const x0 = Math.floor(left);
  const x1 = Math.ceil(right);
  const y0 = Math.floor(top);
  const y1 = Math.ceil(bottom);

  const r = cell * 0.43;
  for (let gx = x0; gx <= x1; gx++) {
    const bx = wrap(gx);
    for (let gy = y0; gy <= y1; gy++) {
      const by = wrap(gy);
      const v = board[by][bx];
      if (v === 0) continue;

      const p = worldToScreen(gx, gy);
      if (p.x < -r || p.x > viewW + r || p.y < -r || p.y > viewH + r) continue;

      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = v === 1 ? '#0a0b0d' : '#f2f5f9';
      ctx.fill();

      const hl = ctx.createRadialGradient(p.x - r * 0.35, p.y - r * 0.35, r * 0.1, p.x, p.y, r);
      if (v === 1) {
        hl.addColorStop(0, 'rgba(255,255,255,0.10)');
        hl.addColorStop(1, 'rgba(255,255,255,0.00)');
      } else {
        hl.addColorStop(0, 'rgba(0,0,0,0.10)');
        hl.addColorStop(1, 'rgba(0,0,0,0.00)');
      }
      ctx.fillStyle = hl;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = v === 1 ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.12)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
}

function drawHover(gx, gy) {
  const r = cell * 0.42;

  const stroke = toMove === 1 ? 'rgba(40, 40, 40, 0.6)' : 'rgba(220, 220, 220, 0.7)';
  const fill = toMove === 1 ? 'rgba(40, 40, 40, 0.5)' : 'rgba(220, 220, 220, 0.4)';

  ctx.lineWidth = 2;

  for (let ty = -1; ty <= 1; ty++) {
    for (let tx = -1; tx <= 1; tx++) {
      const px = gx + tx * N;
      const py = gy + ty * N;
      const p = worldToScreen(px, py);

      if (p.x < -r || p.x > viewW + r || p.y < -r || p.y > viewH + r) continue;

      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.strokeStyle = stroke;
      ctx.stroke();
    }
  }
}

// --- Events ---
function onPointerDown(e) {
  if (e.button !== 0) return; // left only

  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;

  dragging = true;
  dragMode = 'pending';
  dragStart = { x: sx, y: sy };
  camStart = { x: camWX, y: camWY };
  canvas.setPointerCapture(e.pointerId);
}

function onPointerMove(e) {
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;

  // Hover updates even without left down
  mouse.x = sx;
  mouse.y = sy;
  const wpos = screenToWorld(sx, sy);
  const near = worldToNearestIntersection(wpos.x, wpos.y);

  const prevOver = mouse.over;
  mouse.over = { gx: near.gx, gy: near.gy, x: near.x, y: near.y, tileX: near.tileX, tileY: near.tileY };
  if (!prevOver || prevOver.gx !== mouse.over.gx || prevOver.gy !== mouse.over.gy) requestRender();

  if (!dragging) return;

  const moved = Math.hypot(sx - dragStart.x, sy - dragStart.y);
  if (dragMode === 'pending' && moved > 6) dragMode = 'pan';

  if (dragMode !== 'pan') return;

  const dx = (sx - dragStart.x) / cell;
  const dy = (sy - dragStart.y) / cell;

  // Dragging the mouse right should move camera left (world follows hand)
  camWX = camStart.x - dx;
  camWY = camStart.y - dy;
  requestRender();
}

function onPointerUp(e) {
  if (e.button !== 0) return;

  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;

  const moved = dragStart ? Math.hypot(sx - dragStart.x, sy - dragStart.y) : 0;
  const wasDrag = dragMode === 'pan' || moved > 6;

  dragging = false;
  dragMode = 'idle';
  dragStart = null;
  camStart = null;

  if (!wasDrag) {
    const wpos = screenToWorld(sx, sy);
    const near = worldToNearestIntersection(wpos.x, wpos.y);
    const r = tryPlay(near.x, near.y);
    if (!r.ok) {
      setStatus(r.reason);
    } else {
      setTurnUI();
      setStatus(r.captured ? `Captured ${r.captured}` : 'Placed');
    }
    requestRender();
  }

  try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
}

function onPointerLeave() {
  if (mouse.over) {
    mouse.over = null;
    requestRender();
  }
}

function onWheel(e) {
  e.preventDefault();
  const delta = Math.sign(e.deltaY);
  const factor = delta > 0 ? 0.92 : 1.08;
  cell = Math.max(18, Math.min(70, cell * factor));
  requestRender();
}

// Buttons
passBtn.addEventListener('click', () => pass());
resetBtn.addEventListener('click', () => reset(N));
applySizeBtn.addEventListener('click', () => {
  const n = clampInt(parseInt(sizeInput.value || '19', 10), 5, 49);
  reset(n);
});

// Canvas events
canvas.addEventListener('pointerdown', onPointerDown);
canvas.addEventListener('pointermove', onPointerMove);
canvas.addEventListener('pointerup', onPointerUp);
canvas.addEventListener('pointerleave', onPointerLeave);
canvas.addEventListener('wheel', onWheel, { passive: false });

// Disable default context menu on right click
canvas.addEventListener('contextmenu', e => e.preventDefault());

// Resize
const shell = document.getElementById('game-shell');
const ro = new ResizeObserver(entries => {
  for (const entry of entries) {
    const { width, height } = entry.contentRect;
    resizeCanvas(width, height);
  }
});
ro.observe(shell);

// Start
setTurnUI();
setStatus('Ready');
requestRender();
