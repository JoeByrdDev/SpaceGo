// util.js
window.Util = window.Util || {};

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

const turnPill = document.getElementById('turnPill');
const statusPill = document.getElementById('statusPill');
const passBtn = document.getElementById('passBtn');
const resetBtn = document.getElementById('resetBtn');
const sizeInput = document.getElementById('sizeInput');
const applySizeBtn = document.getElementById('applySizeBtn');

const margin = 10; // extra grid drawn around viewport

Util.seen = new Set();

Util.clampInt = function (v, lo, hi) {
  v = Number.isFinite(v) ? v : lo;
  return Math.max(lo, Math.min(hi, Math.trunc(v)));
};

Util.mod = function (a, n) {
  return ((a % n) + n) % n;
};

Util.wrap = function (i) {
  // wraps integer i into [0..N-1]
  return Util.mod(i, N);
};

Util.floorDiv = function (a, b) {
  // math.floor(a / b) for negatives
  return Math.floor(a / b);
};

Util.makeBoard = function (n) {
  const b = new Array(n);
  for (let y = 0; y < n; y++) b[y] = new Array(n).fill(0);
  return b;
};

Util.other = function (p) {
  return p === 1 ? 2 : 1;
};

// --- Absolute grid coordinate API ---
// Absolute integer intersection: (ax, ay) on infinite plane.
// Base board lookup: (bx, by) = wrap(ax), wrap(ay) in [0..N-1].
// Tile index: (tx, ty) = floorDiv(ax, N), floorDiv(ay, N).

Util.absToBase = function (ax, ay) {
  const bx = Util.wrap(ax);
  const by = Util.wrap(ay);
  const tx = Util.floorDiv(ax, N);
  const ty = Util.floorDiv(ay, N);
  return { ax, ay, bx, by, tx, ty };
};

Util.baseToAbs = function (bx, by, tx = 0, ty = 0) {
  const ax = bx + tx * N;
  const ay = by + ty * N;
  return { ax, ay, bx, by, tx, ty };
};

// Viewport cache (CSS pixels)
let viewW = 0;
let viewH = 0;

// Board size
let N = Util.clampInt(parseInt(sizeInput.value || '19', 10), 5, 49);

// Zoom
let cell = 34; // pixels per grid unit (intersection spacing)

// Camera in ABSOLUTE grid units (float)
let camAX = (N - 1) / 2;
let camAY = (N - 1) / 2;

// Game state
let toMove = 1;

// Interaction state
let dragging = false;
let dragStart = null;
let camStart = null;
let dragMode = 'idle'; // 'idle' | 'pending' | 'pan'
let mouse = { x: 0, y: 0, over: null };

// Render scheduling
let rafPending = false;

// Expose a few globals used by other files (classic script pattern)
window.canvas = canvas;
window.ctx = ctx;

window.margin = margin;

window.viewW = viewW;
window.viewH = viewH;

window.N = N;
window.cell = cell;
window.camAX = camAX;
window.camAY = camAY;

window.toMove = toMove;

window.dragging = dragging;
window.dragStart = dragStart;
window.camStart = camStart;
window.dragMode = dragMode;
window.mouse = mouse;

window.rafPending = rafPending;

// Keep exported globals in sync when we mutate local bindings
Util._syncGlobals = function () {
  window.viewW = viewW;
  window.viewH = viewH;

  window.N = N;
  window.cell = cell;
  window.camAX = camAX;
  window.camAY = camAY;

  window.toMove = toMove;

  window.dragging = dragging;
  window.dragStart = dragStart;
  window.camStart = camStart;
  window.dragMode = dragMode;
  window.mouse = mouse;

  window.rafPending = rafPending;
};

Util.resizeCanvas = function (cssW, cssH) {
  const dpr = window.devicePixelRatio || 1;
  viewW = cssW;
  viewH = cssH;

  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  Util._syncGlobals();
  Render.requestRender();
};

Util.setStatus = function (text) {
  statusPill.textContent = text;
};

Util.setTurnUI = function () {
  turnPill.textContent = `Turn: ${toMove === 1 ? 'Black' : 'White'}`;
};

// Hash board + toMove into a stable string
Util.hashPosition = function (nextPlayer = toMove) {
  let s = '' + nextPlayer + '|';
  for (let y = 0; y < N; y++) s += board[y].join('') + ';';
  return s;
};

Util.rememberPosition = function () {
  Util.seen.add(Util.hashPosition(toMove));
};

Util.screenToAbs = function (sx, sy) {
  const ax = (sx - viewW / 2) / cell + camAX;
  const ay = (sy - viewH / 2) / cell + camAY;
  return { ax, ay };
};

Util.absToScreen = function (ax, ay) {
  return {
    x: (ax - camAX) * cell + viewW / 2,
    y: (ay - camAY) * cell + viewH / 2,
  };
};

Util.absFloatToNearest = function (axf, ayf) {
  const ax = Math.round(axf);
  const ay = Math.round(ayf);
  return Util.absToBase(ax, ay);
};

// Mutators that affect exported globals
Util.setBoardSize = function (n) {
  N = n;
  Util._syncGlobals();
};

Util.setCell = function (v) {
  cell = v;
  Util._syncGlobals();
};

Util.setCameraAbs = function (ax, ay) {
  camAX = ax;
  camAY = ay;
  Util._syncGlobals();
};

Util.setToMove = function (p) {
  toMove = p;
  Util._syncGlobals();
};

// Client action id for idempotent server actions
Util.newActionId = function () {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  // fallback: 16 random bytes -> hex
  const buf = new Uint8Array(16);
  if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
    window.crypto.getRandomValues(buf);
  } else {
    for (let i = 0; i < buf.length; i++) buf[i] = (Math.random() * 256) | 0;
  }
  let hex = '';
  for (let i = 0; i < buf.length; i++) hex += buf[i].toString(16).padStart(2, '0');
  return hex;
};

// Export UI elements for Events.js
window.turnPill = turnPill;
window.statusPill = statusPill;
window.passBtn = passBtn;
window.resetBtn = resetBtn;
window.sizeInput = sizeInput;
window.applySizeBtn = applySizeBtn;

// Initial sync
Util._syncGlobals();
