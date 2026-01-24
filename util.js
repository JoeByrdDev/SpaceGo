// util.js
window.Util = window.Util || {};

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

const turnPill = document.getElementById('turnPill');
const youPill = document.getElementById('youPill');
const statusPill = document.getElementById('statusPill');
const passBtn = document.getElementById('passBtn');
const gamesBtn = document.getElementById('gamesBtn');
const p1Btn = document.getElementById('p1Btn');
const p2Btn = document.getElementById('p2Btn');

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

// Lobby navigation
if (gamesBtn) {
  gamesBtn.addEventListener('click', () => {
    window.location.href = '/';
  });
}

// --- Player selection (cookie) ---
// player: 0 = observer, 1 = black, 2 = white
let player = 0;
let playerCookieKey = 'sg_player';

Util._cookieGet = function (name) {
  const needle = name + '=';
  const parts = (document.cookie || '').split(';');
  for (let p of parts) {
    p = p.trim();
    if (p.startsWith(needle)) return decodeURIComponent(p.slice(needle.length));
  }
  return null;
};

Util._cookieSet = function (name, value, days = 3650) {
  const maxAge = Math.max(0, Math.trunc(days * 86400));
  document.cookie = `${name}=${encodeURIComponent(String(value))}; Path=/; Max-Age=${maxAge}; SameSite=Lax`;
};

Util._cookieDel = function (name) {
  document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax`;
};

Util._playerLabel = function (p) {
  if (p === 1) return 'Black';
  if (p === 2) return 'White';
  return 'Observer';
};

/*
Util.setPlayerCookieKey = function (key) {
  playerCookieKey = key || 'sg_player';
  const raw = Util._cookieGet(playerCookieKey);
  const n = raw == null ? 0 : Number(raw);
  player = (n === 1 || n === 2) ? n : 0;
  Util._syncGlobals();
  Util.setPlayerUI();
};
*/

Util.getPlayer = function () {
  return player;
};

Util.setPlayer = function (p) {
  const v = (p === 1 || p === 2) ? p : 0;
  player = v;
  if (v === 0) Util._cookieDel(playerCookieKey);
  else Util._cookieSet(playerCookieKey, v);
  Util._syncGlobals();
  Util.setPlayerUI();
  if (window.Render && Render.requestRender) Render.requestRender();
};

// add near Util.setPlayer (right after it is fine)
Util.setPlayerServer = function (p) {
  const v = (p === 1 || p === 2) ? p : 0;
  player = v;
  Util._syncGlobals();
  Util.setPlayerUI(); // also refresh seat buttons
};

Util.canActNow = function () {
  // Observer can never place/pass.
  return player !== 0 && player === toMove;
};

// --- Absolute grid coordinate API ---
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

// Board size (authoritative value comes from server in net mode)
let N = 19;

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

// Expose globals
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
window.player = player;

window.dragging = dragging;
window.dragStart = dragStart;
window.camStart = camStart;
window.dragMode = dragMode;
window.mouse = mouse;

window.rafPending = rafPending;

Util._syncGlobals = function () {
  window.viewW = viewW;
  window.viewH = viewH;

  window.N = N;
  window.cell = cell;
  window.camAX = camAX;
  window.camAY = camAY;

  window.toMove = toMove;
  window.player = player;

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

Util.setScoringUI = function () {
  const scoreBtn = document.getElementById("scoreBtn");
  const finalizeBtn = document.getElementById("finalizeScoreBtn");
  const acceptBtn = document.getElementById("acceptScoreBtn");
  if (!scoreBtn || !finalizeBtn || !acceptBtn) return;

  const netMode = window.Engine?.isNetMode && Engine.isNetMode();
  if (!netMode) return;

  const inScoring = (window.phase === "scoring");
  const finished = (window.phase === "finished");
  const hasDraft = !!window.scoreResult;

  scoreBtn.style.display = (inScoring || finished) ? "" : "";
  scoreBtn.disabled = finished;
  scoreBtn.textContent = finished ? "Final Score" : (inScoring ? "Back to Play" : "Score");

  finalizeBtn.style.display = inScoring ? "" : "none";
  finalizeBtn.disabled = false;

  acceptBtn.style.display = inScoring ? "" : (finished ? "" : "none");
  acceptBtn.disabled = true;

  if (finished && hasDraft) {
    acceptBtn.textContent = "Finalized";
  } else if (inScoring) {
    const acc = window.score?.accept || { black: false, white: false };
    const youKey = (window.player === 1) ? "black" : (window.player === 2) ? "white" : null;
    const youAccepted = youKey ? !!acc[youKey] : false;
    acceptBtn.disabled = !hasDraft;
    acceptBtn.textContent = youAccepted ? "Accepted (waiting…)" : "Accept Scoring";
  }

};

Util.setTurnUI = function () {
  turnPill.textContent = `Turn: ${toMove === 1 ? 'Black' : 'White'}`;
  Util.setScoringUI();
  Util.setPlayerUI();
};

Util.setSeatButtonsUI = function () {
  const p1Btn = document.getElementById("p1Btn"); // Black button
  const p2Btn = document.getElementById("p2Btn"); // White button
  if (!p1Btn || !p2Btn) return;

  const netMode = window.Engine?.isNetMode && Engine.isNetMode();
  if (!netMode) return;

  const seats = window.Net?.getSeatState ? Net.getSeatState() : { blackTaken:false, whiteTaken:false };

  // compute ownership
  const youBlack = (player === 1);
  const youWhite = (player === 2);

  // availability (taken by someone else)
  const blackTakenOther = seats.blackTaken && !youBlack;
  const whiteTakenOther = seats.whiteTaken && !youWhite;

  // text
  p1Btn.textContent = youBlack ? "Black (You)" : (blackTakenOther ? "Black (Taken)" : "Play as Black");
  p2Btn.textContent = youWhite ? "White (You)" : (whiteTakenOther ? "White (Taken)" : "Play as White");

  // disable if taken by other
  p1Btn.disabled = blackTakenOther;
  p2Btn.disabled = whiteTakenOther;

  // classes for styling
  p1Btn.classList.toggle("seat-taken", blackTakenOther);
  p2Btn.classList.toggle("seat-taken", whiteTakenOther);
  p1Btn.classList.toggle("seat-you", youBlack);
  p2Btn.classList.toggle("seat-you", youWhite);
};

Util.setPlayerUI = function () {
  if (!youPill) return;
  const label = Util._playerLabel(player);
  const suffix = (player !== 0 && player === toMove) ? ' (your turn)' : '';
  youPill.textContent = `You: ${label}${suffix}`;
  if (Util.setSeatButtonsUI) Util.setSeatButtonsUI();
  if (p1Btn) p1Btn.disabled = player === 1;
  if (p2Btn) p2Btn.disabled = player === 2;
};

const scoreBtn = document.getElementById("scoreBtn");
const finalizeBtn = document.getElementById("finalizeScoreBtn");
const acceptBtn = document.getElementById("acceptScoreBtn");

if (scoreBtn) scoreBtn.addEventListener("click", async () => {
  if (!(window.Engine?.isNetMode && Engine.isNetMode())) return;

  // If not in scoring, enter scoring. If in scoring, leave back to play.
  if (window.phase !== "scoring") await Net.setPhase("scoring");
  else await Net.setPhase("play");
});

if (finalizeBtn) finalizeBtn.addEventListener("click", async () => {
  if (!(window.Engine?.isNetMode && Engine.isNetMode())) return;
  if (window.phase !== "scoring") return;
  await Net.finalizeScore();
});

if (acceptBtn) acceptBtn.addEventListener("click", async () => {
  if (!(window.Engine?.isNetMode && Engine.isNetMode())) return;
  if (window.phase !== "scoring") return;
  await Net.acceptScore();
});

// Player picker bindings
if (p1Btn) p1Btn.addEventListener("click", async () => {
  if (window.Engine?.isNetMode && Engine.isNetMode()) {
    if (window.Net?.release && player === 1) await Net.release(1);
    else if (window.Net?.claim) await Net.claim(1);
  } else {
    Util.setPlayer(1);
  }
});

if (p2Btn) p2Btn.addEventListener("click", async () => {
  if (window.Engine?.isNetMode && Engine.isNetMode()) {
    if (window.Net?.release && player === 2) await Net.release(2);
    else if (window.Net?.claim) await Net.claim(2);
  } else {
    Util.setPlayer(2);
  }
});

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

Util.newActionId = function () {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
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
window.youPill = youPill;
window.statusPill = statusPill;
window.passBtn = passBtn;
window.gamesBtn = gamesBtn;
window.p1Btn = p1Btn;
window.p2Btn = p2Btn;

// Initial sync
Util._syncGlobals();
Util.setPlayerUI();
