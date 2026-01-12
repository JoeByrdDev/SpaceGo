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

Util.clampInt = function(v, lo, hi) {
  v = Number.isFinite(v) ? v : lo;
  return Math.max(lo, Math.min(hi, Math.trunc(v)));
}
Util.wrap = function(i) {
  // wraps integer i into [0..N-1]
  return ((i % N) + N) % N;
}
Util.floorDiv = function(a, b) {
  // math.floor(a / b) for negatives
  return Math.floor(a / b);
}
Util.makeBoard = function(n) {
  const b = new Array(n);
  for (let y = 0; y < n; y++) b[y] = new Array(n).fill(0);
  return b;
}
Util.other = function(p) { return p === 1 ? 2 : 1; }

Util.resizeCanvas = function(cssW, cssH) {
  const dpr = window.devicePixelRatio || 1;
  viewW = cssW;
  viewH = cssH;

  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  Render.requestRender();
}

Util.setStatus = function(text) { statusPill.textContent = text; }
Util.setTurnUI = function() { turnPill.textContent = `Turn: ${toMove === 1 ? 'Black' : 'White'}`; }

// Hash board + toMove into a stable string
Util.hashPosition = function(nextPlayer = toMove) {
  let s = '' + nextPlayer + '|';
  for (let y = 0; y < N; y++) s += board[y].join('') + ';';
  return s;
}
Util.rememberPosition = function() { Util.seen.add(Util.hashPosition(toMove)); }

Util.screenToWorld = function(sx, sy) {
  const wx = (sx - viewW / 2) / cell + camWX;
  const wy = (sy - viewH / 2) / cell + camWY;
  return { x: wx, y: wy };
}

Util.worldToScreen = function(wx, wy) {
  return {
    x: (wx - camWX) * cell + viewW / 2,
    y: (wy - camWY) * cell + viewH / 2,
  };
}

Util.worldToNearestIntersection = function(wx, wy) {
  const gx = Math.round(wx);
  const gy = Math.round(wy);
  const tileX = Util.floorDiv(gx, N);
  const tileY = Util.floorDiv(gy, N);
  return { gx, gy, x: Util.wrap(gx), y: Util.wrap(gy), tileX, tileY };
}

let N = Util.clampInt(parseInt(sizeInput.value || '19', 10), 5, 49);

let cell = 34; // pixels per grid unit (intersection spacing)

// Camera in WORLD grid units (can grow without modulo; wrapping only for board lookup)
let camWX = (N - 1) / 2;
let camWY = (N - 1) / 2;

// Viewport cache (CSS pixels)
let viewW = 0;
let viewH = 0;
let toMove = 1;

// Interaction state
let dragging = false;
let dragStart = null;
let camStart = null;
let dragMode = 'idle'; // 'idle' | 'pending' | 'pan'
let mouse = { x: 0, y: 0, over: null };

// Render scheduling
let rafPending = false;