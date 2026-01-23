// server.js
import express from "express";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "redis";
import http from "http";
import { WebSocketServer } from "ws";

import cookieParser from "cookie-parser";
import admin from "firebase-admin";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 8080;





app.use(express.json());
app.use(cookieParser());

app.set("trust proxy", 1);

const SESSION_COOKIE_NAME = "sg_session";
const SESSION_EXPIRES_MS = 1000 * 60 * 60 * 24 * 7; // 7 days (Firebase session cookies support up to 14 days)


const PROJECT_ID =
  process.env.FIREBASE_PROJECT_ID ||
  process.env.GOOGLE_CLOUD_PROJECT ||
  process.env.GCLOUD_PROJECT ||
  "spacego-fff13";

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  ...(PROJECT_ID ? { projectId: PROJECT_ID } : {}),
});


const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const rdb = createClient({ url: REDIS_URL });

rdb.on("error", (err) => console.error("redis error", err));

await rdb.connect(); // node ESM top-level await is fine


// For local HTTP dev, Secure cookies won't set.
// Either run local HTTPS, or allow insecure cookies only on localhost.
function isHttps(req) {
  return (
    req.secure ||
    req.headers["x-forwarded-proto"] === "https" ||
    req.headers["x-forwarded-ssl"] === "on"
  );
}

function sessionCookieOptions(req) {
  const secure = isHttps(req) && process.env.NODE_ENV !== "development";
  return {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_EXPIRES_MS,
  };
}

// Basic CSRF guard for cookie-authenticated POST/PUT/DELETE.
// Works well when frontend + API are same-origin.
function requireSameOrigin(req, res, next) {
  const origin = req.headers.origin;
  if (!origin) return next();
  const expected = `${req.protocol}://${req.get("host")}`;
  if (origin !== expected) return res.status(403).json({ error: "bad origin" });
  return next();
}

async function authFromSessionCookie(req, res, next) {
  const cookie = req.cookies[SESSION_COOKIE_NAME];
  if (!cookie) {
    req.user = null;
    return next();
  }

  try {
    // checkRevoked=true is safest; costs an extra lookup.
    const decoded = await admin.auth().verifySessionCookie(cookie, true);
    req.user = {
      uid: decoded.uid,
      claims: decoded,
    };
    return next();
  } catch {
    req.user = null;
    return next();
  }
}

app.use(authFromSessionCookie);


// Client sends Firebase ID token after email/password sign-in.
// Server verifies token and sets HttpOnly session cookie.
app.post("/api/sessionLogin", requireSameOrigin, async (req, res) => {
  const idToken = req.body?.idToken;
  if (!idToken) return res.status(400).json({ error: "missing idToken" });

  try {
    // Optional: verify first so you can reject disabled users, etc.
    const decoded = await admin.auth().verifyIdToken(idToken);

    const sessionCookie = await admin.auth().createSessionCookie(idToken, {
      expiresIn: SESSION_EXPIRES_MS,
    });

    res.cookie(SESSION_COOKIE_NAME, sessionCookie, sessionCookieOptions(req));
    return res.json({ ok: true, uid: decoded.uid });
  } catch (e) {
    return res.status(401).json({ error: "invalid token" });
  }
});

// Clears cookie. If you want "log out everywhere", revoke refresh tokens too.
app.post("/api/sessionLogout", requireSameOrigin, async (req, res) => {
  res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });

  // Optional: global sign-out (forces session invalidation after revocation is checked)
  if (req.user?.uid) await admin.auth().revokeRefreshTokens(req.user.uid);

  return res.json({ ok: true });
});

// Convenience: see who server thinks you are
app.get("/api/whoami", (req, res) => {
  if (!req.user) return res.json({ authed: false });
  return res.json({ authed: true, uid: req.user.uid });
});





// serve lobby on /
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "lobby.html"));
});

// serve the actual game page at /game.html (backed by index.html)
app.get("/game.html", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});
app.get("/game", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// IMPORTANT: disable static index fallback so "/" doesn't auto-serve index.html
app.use(express.static(__dirname, { index: false }));

// --- WebSocket fanout (read-path) ---
const server = http.createServer(app);

// gameId -> Set(ws)
const wsSubs = new Map();

function subAdd(gameId, ws) {
  if (!wsSubs.has(gameId)) wsSubs.set(gameId, new Set());
  wsSubs.get(gameId).add(ws);
}
function subDel(gameId, ws) {
  const set = wsSubs.get(gameId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) wsSubs.delete(gameId);
}

function wsSend(ws, obj) {
  if (ws.readyState !== ws.OPEN) return;
  try { ws.send(JSON.stringify(obj)); } catch {}
}

function publishGame(g) {
  const set = wsSubs.get(g.id);
  if (!set || set.size === 0) return;
  const state = gamePublicState(g);
  const msg = { type: "state", state };
  for (const ws of set) wsSend(ws, msg);
}

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", async (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const idOrPrefix = url.searchParams.get("gameId") || "";
  const { g } = await resolveGame(idOrPrefix);

  if (!g) {
    wsSend(ws, { type: "error", error: "Game not found" });
    ws.close();
    return;
  }

  const gameId = g.id;
  subAdd(gameId, ws);

  // immediately send authoritative state snapshot
  wsSend(ws, { type: "state", state: gamePublicState(g) });

  ws.on("close", () => subDel(gameId, ws));
  ws.on("error", () => subDel(gameId, ws));

  // keepalive
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  // (optional) allow client to request a resync
  ws.on("message", async (buf) => {
    let m = null;
    try { m = JSON.parse(buf.toString("utf8")); } catch {}
    if (!m) return;
    if (m.type === "resync") {
      const fresh = await loadGameExact(gameId);
      if (fresh) wsSend(ws, { type: "state", state: gamePublicState(fresh) });
    }
  });
});

// heartbeat
const hb = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 30_000);

wss.on("close", () => clearInterval(hb));


/* -----------------------------
   In-memory game store (dev)
------------------------------ */

const K = {
  game: (id) => `sg:game:${id}`,
  updated: `sg:games:updated`,
  short: (shortId) => `sg:short:${shortId}`,
  actions: (id) => `sg:actions:${id}`,
  actionsOrder: (id) => `sg:actions_order:${id}`,
};

async function rgetJson(key) {
  const raw = await rdb.get(key);
  return raw ? JSON.parse(raw) : null;
}

async function rsetJson(key, obj) {
  await rdb.set(key, JSON.stringify(obj));
}

async function cacheAction(gameId, clientActionId, payload) {
  if (!clientActionId) return;

  const hkey = K.actions(gameId);
  const lkey = K.actionsOrder(gameId);

  // write payload
  await rdb.hSet(hkey, clientActionId, JSON.stringify(payload));

  // cap at 300 (mirror your old behavior)
  await rdb.lPush(lkey, clientActionId);
  await rdb.lTrim(lkey, 0, 299);

  // best-effort cleanup: anything beyond 300 gets removed from hash
  const overflow = await rdb.lRange(lkey, 300, 400); // small slice is enough
  if (overflow.length) {
    await rdb.lTrim(lkey, 0, 299);
    await rdb.hDel(hkey, overflow);
  }
}

async function getCachedAction(gameId, clientActionId) {
  if (!clientActionId) return null;
  const raw = await rdb.hGet(K.actions(gameId), clientActionId);
  return raw ? JSON.parse(raw) : null;
}


async function saveGame(g) {
  await rsetJson(K.game(g.id), g);
  await rdb.zAdd(K.updated, [{ score: g.updatedAt || nowMs(), value: g.id }]);
  await rdb.set(K.short(g.id.slice(0, 8)), g.id);
}

async function loadGameExact(id) {
  return await rgetJson(K.game(id));
}

// Keep your “open by prefix” behavior from resolveGame() :contentReference[oaicite:4]{index=4}.
// Fast path: 8-char short id. Fallback: scan known ids (fine at this stage).
async function resolveGame(idOrPrefix) {
  if (!idOrPrefix) return { g: null, error: "Missing id" };

  const raw = String(idOrPrefix).trim();
  if (!raw) return { g: null, error: "Missing id" };

  // exact
  const exact = await loadGameExact(raw);
  if (exact) return { g: exact };

  // short id mapping (8 chars)
  if (raw.length === 8) {
    const full = await rdb.get(K.short(raw));
    if (full) {
      const g = await loadGameExact(full);
      if (g) return { g };
    }
  }

  // fallback: prefix scan against ids in zset
  if (raw.length < 4) return { g: null, error: "Id too short" };

  const ids = await rdb.zRange(K.updated, 0, 500, { REV: true });
  const matches = [];
  for (const id of ids) if (id.startsWith(raw)) matches.push(id);

  if (matches.length === 1) return { g: await loadGameExact(matches[0]) };
  if (matches.length === 0) return { g: null, error: "Game not found" };
  return { g: null, error: "Ambiguous id (multiple matches)" };
}



function nowMs() {
  return Date.now();
}

function newGameId() {
  // short + readable
  return crypto.randomBytes(9).toString("base64url");
}

function mod(a, n) {
  const r = a % n;
  return r < 0 ? r + n : r;
}

function newBoard(N) {
  const b = new Array(N);
  for (let y = 0; y < N; y++) {
    b[y] = new Array(N).fill(0);
  }
  return b;
}

function cloneBoard(board) {
  return board.map((row) => row.slice());
}

function other(p) {
  return p === 1 ? 2 : 1;
}

function neighborsWrap(x, y, N) {
  return [
    [mod(x + 1, N), y],
    [mod(x - 1, N), y],
    [x, mod(y + 1, N)],
    [x, mod(y - 1, N)],
  ];
}

// 64-bit FNV-1a hash using BigInt (deterministic, fast enough for dev)
function fnv1a64(str) {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < str.length; i++) {
    hash ^= BigInt(str.charCodeAt(i));
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

function hashPosition({ board, toMove }) {
  // compact-ish stable encoding: toMove|rows separated by ;
  let s = "" + toMove + "|";
  for (let y = 0; y < board.length; y++) {
    for (let x = 0; x < board.length; x++) s += board[y][x];
    s += ";";
  }
  return fnv1a64(s);
}

function deadHas(g, k) {
  return (g.deadSet || []).includes(k);
}
function deadAdd(g, k) {
  if (!g.deadSet) g.deadSet = [];
  if (!g.deadSet.includes(k)) g.deadSet.push(k);
}
function deadDel(g, k) {
  if (!g.deadSet) return;
  g.deadSet = g.deadSet.filter((x) => x !== k);
}

function seenHas(g, h) {
  return (g.seen || []).includes(h);
}
function seenAdd(g, h) {
  if (!g.seen) g.seen = [];
  if (!g.seen.includes(h)) g.seen.push(h);
}

function cleanName(name, fallback) {
  const s = (name || "").toString().trim().replace(/\s+/g, " ");
  if (!s) return fallback;
  return s.slice(0, 60);
}

function createGame(N = 19, name = "") {
  const id = newGameId();
  const shortId = id.slice(0, 8);

  const g = {
    id,
    name: cleanName(name, `Game ${shortId}`),
    moveCount: 0,

    N,
    board: newBoard(N),
    toMove: 1,
    phase: "play",
    passStreak: 0,

    deadSet: [],        // array of "x,y"
    scoreResult: null,
    rev: 0,

    seen: [],           // array of position hashes

    createdAt: nowMs(),
    updatedAt: nowMs(),
  };

  g.seen.push(hashPosition(g));
  return g;
}

function gamePublicState(g) {
  return {
    gameId: g.id,
    name: g.name,
    moveCount: g.moveCount,
    N: g.N,
    board: g.board,
    toMove: g.toMove,
    phase: g.phase,
    passStreak: g.passStreak,
    deadSet: g.deadSet || [],
    scoreResult: g.scoreResult,
    rev: g.rev,
    posHash: hashPosition(g),
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
  };
}


/* -----------------------------
   Rules: play + superko
------------------------------ */

function collectGroupAndLiberties(board, x, y, N) {
  const color = board[y][x];
  const stack = [[x, y]];
  const visited = new Set();
  const stones = [];

  const key = (a, b) => a + "," + b;
  visited.add(key(x, y));

  while (stack.length) {
    const [cx, cy] = stack.pop();
    stones.push([cx, cy]);

    for (const [nx, ny] of neighborsWrap(cx, cy, N)) {
      if (board[ny][nx] !== color) continue;
      const k = key(nx, ny);
      if (visited.has(k)) continue;
      visited.add(k);
      stack.push([nx, ny]);
    }
  }

  const libs = new Set();
  for (const [sx, sy] of stones) {
    for (const [nx, ny] of neighborsWrap(sx, sy, N)) {
      if (board[ny][nx] === 0) libs.add(nx + "," + ny);
    }
  }

  return { color, stones, liberties: libs.size };
}

function removeStones(board, stones) {
  for (const [x, y] of stones) board[y][x] = 0;
}

function tryPlay(g, ax, ay) {
  if (g.phase !== "play") return { ok: false, reason: "Scoring" };

  const N = g.N;
  const x = mod(ax, N);
  const y = mod(ay, N);

  if (g.board[y][x] !== 0) return { ok: false, reason: "Occupied" };

  const b = cloneBoard(g.board);
  const me = g.toMove;
  const opp = other(me);

  b[y][x] = me;

  // capture adjacent opponent groups with 0 liberties
  let captured = 0;
  const checked = new Set();
  for (const [nx, ny] of neighborsWrap(x, y, N)) {
    if (b[ny][nx] !== opp) continue;
    const k0 = nx + "," + ny;
    if (checked.has(k0)) continue;

    const grp = collectGroupAndLiberties(b, nx, ny, N);
    for (const [sx, sy] of grp.stones) checked.add(sx + "," + sy);

    if (grp.liberties === 0) {
      captured += grp.stones.length;
      removeStones(b, grp.stones);
    }
  }

  // suicide check (after captures)
  const myGroup = collectGroupAndLiberties(b, x, y, N);
  if (myGroup.liberties === 0) return { ok: false, reason: "Suicide" };

  // superko: check resulting position with next player to move
  const nextToMove = opp;
  const nextHash = hashPosition({ board: b, toMove: nextToMove });
  if (seenHas(g, nextHash)) return { ok: false, reason: "Superko" };

  // commit
  g.board = b;
  g.toMove = nextToMove;
  g.passStreak = 0;
  g.deadSet = [];
  g.scoreResult = null;

  seenAdd(g, nextHash);
  g.updatedAt = nowMs();

  return { ok: true, captured };
}

function doPass(g) {
  if (g.phase !== "play") return { ok: false, reason: "Scoring" };

  g.toMove = other(g.toMove);
  g.passStreak += 1;

  if (g.passStreak >= 2) {
    g.phase = "scoring";
  }

  const h = hashPosition(g);
  seenAdd(g, h);

  g.updatedAt = nowMs();
  return { ok: true };
}

function doReset(g, N) {
  const n = Number.isFinite(N) ? N : g.N;
  g.N = n;
  g.board = newBoard(n);
  g.toMove = 1;
  g.phase = "play";
  g.passStreak = 0;
  g.deadSet = [];
  g.scoreResult = null;
  g.seen = [hashPosition(g)];
  g.updatedAt = nowMs();
  return { ok: true };
}

function doSetPhase(g, phase) {
  if (phase !== "play" && phase !== "scoring") return { ok: false, reason: "Bad phase" };
  g.phase = phase;
  if (phase === "play") {
    g.passStreak = 0;
    g.deadSet = [];
    g.scoreResult = null;
  }
  g.updatedAt = nowMs();
  return { ok: true };
}

// scoring toggles (server-side bookkeeping only for now)
function doToggleDead(g, ax, ay) {
  if (g.phase !== "scoring") return { ok: false, reason: "Not scoring" };

  const N = g.N;
  const x = mod(ax, N);
  const y = mod(ay, N);

  const v = g.board[y][x];
  if (v === 0) return { ok: false, reason: "Empty" };

  const k = x + "," + y;
  if (deadHas(g, k)) deadDel(g, k);
  else deadAdd(g, k);

  g.updatedAt = nowMs();
  return { ok: true };
}


function doFinalizeScoring(g) {
  if (g.phase !== "scoring") return { ok: false, reason: "Not scoring" };

  g.scoreResult = {
    blackStones: 0,
    whiteStones: 0,
    blackTerritory: 0,
    whiteTerritory: 0,
    blackTotal: 0,
    whiteTotal: 0,
    note: "Server scoring not implemented yet",
  };

  g.updatedAt = nowMs();
  return { ok: true };
}

/* -----------------------------
   API
------------------------------ */

// health
app.get("/api/health", async (req, res) => {
  const count = await rdb.zCard(K.updated);
  res.json({ ok: true, games: count });
});


app.get("/api/games", async (req, res) => {
  const ids = await rdb.zRange(K.updated, 0, 200, { REV: true });
  const out = [];

  for (const id of ids) {
    const g = await loadGameExact(id);
    if (!g) continue;
    out.push({
      gameId: g.id,
      name: g.name,
      moveCount: g.moveCount,
      N: g.N,
      rev: g.rev,
      phase: g.phase,
      createdAt: g.createdAt,
      updatedAt: g.updatedAt,
    });
  }

  res.json({ ok: true, games: out });
});


app.delete("/api/game/:gameId", async (req, res) => {
  const { g, error } = await resolveGame(req.params.gameId);
  if (!g) return res.status(404).json({ ok: false, error });

  await rdb.del(K.game(g.id));
  await rdb.zRem(K.updated, g.id);
  await rdb.del(K.short(g.id.slice(0, 8)));

  // cleanup action cache
  await rdb.del(K.actions(g.id));
  await rdb.del(K.actionsOrder(g.id));

  res.json({ ok: true, deleted: true, gameId: g.id });
});

// create new game (now accepts { N, name })
app.post("/api/game/new", async (req, res) => {
  const Nraw = req.body?.N ?? 19;
  const name = req.body?.name ?? "";

  const N = Number(Nraw);
  const safeN = Number.isInteger(N) && N >= 3 && N <= 49 ? N : 19;

  const g = createGame(safeN, name);
  await saveGame(g);
  publishGame(g);

  res.json({ ok: true, gameId: g.id, state: gamePublicState(g) });
});

// get game state
app.get("/api/game/:gameId", async (req, res) => {
  const { g, error } = await resolveGame(req.params.gameId);
  if (!g) return res.status(404).json({ ok: false, error });
  res.json({ ok: true, state: gamePublicState(g) });
});

// single action endpoint
app.post("/api/move", async (req, res) => {
  const { gameId, action, rev, clientActionId } = req.body || {};
  if (!gameId || !action || !action.type) {
    return res.status(400).json({ ok: false, error: "Missing gameId/action" });
  }

  // idempotency
  const cached = await getCachedAction(gameId, clientActionId);
  if (cached) return res.json(cached);

  // resolve
  const resolved = await resolveGame(gameId);
  if (!resolved.g) return res.status(404).json({ ok: false, error: resolved.error });
  const id = resolved.g.id;

  const key = K.game(id);

  // WATCH for concurrent writers
  await rdb.watch(key);

  let g = await rgetJson(key);
  if (!g) {
    await rdb.unwatch();
    return res.status(404).json({ ok: false, error: "Game not found" });
  }

  if (!Number.isInteger(rev) || rev !== g.rev) {
    await rdb.unwatch();
    return res.status(409).json({ ok: false, error: "Out of date", state: gamePublicState(g) });
  }

  let r;
  const t = action.type;

  if (t === "play") {
    const ax = Number.isFinite(action.ax) ? action.ax : action.bx;
    const ay = Number.isFinite(action.ay) ? action.ay : action.by;
    if (!Number.isFinite(ax) || !Number.isFinite(ay)) {
      await rdb.unwatch();
      return res.status(400).json({ ok: false, error: "Missing coordinates" });
    }
    r = tryPlay(g, ax, ay);
  } else if (t === "pass") {
    r = doPass(g);
  } else if (t === "reset") {
    const N = action.N ?? g.N;
    r = doReset(g, Number(N));
  } else if (t === "setPhase") {
    r = doSetPhase(g, action.phase);
  } else if (t === "toggleDead") {
    const ax = action.ax, ay = action.ay;
    if (!Number.isFinite(ax) || !Number.isFinite(ay)) {
      await rdb.unwatch();
      return res.status(400).json({ ok: false, error: "Missing coordinates" });
    }
    r = doToggleDead(g, ax, ay);
  } else if (t === "finalizeScore") {
    r = doFinalizeScoring(g);
  } else if (t === "resign") {
    g.phase = "scoring";
    g.scoreResult = { note: `${action.player || "A player"} resigned` };
    g.updatedAt = nowMs();
    r = { ok: true };
  } else {
    await rdb.unwatch();
    return res.status(400).json({ ok: false, error: "Unknown action type" });
  }

  const countsAsMove = (t === "play" || t === "pass");

  let payload;
  if (!r.ok) {
    payload = { ok: true, accepted: false, reason: r.reason || "Rejected", state: gamePublicState(g) };
  } else {
    if (countsAsMove) g.moveCount += 1;
    g.rev += 1;
    g.updatedAt = nowMs();

    payload = { ok: true, accepted: true, meta: { captured: r.captured || 0 }, state: gamePublicState(g) };
  }

  // transaction commit
  const multi = rdb.multi();
  multi.set(key, JSON.stringify(g));
  multi.zAdd(K.updated, [{ score: g.updatedAt || nowMs(), value: g.id }]);
  multi.set(K.short(g.id.slice(0, 8)), g.id);

  const execRes = await multi.exec(); // null => watched key changed
  if (execRes === null) {
    // someone else wrote first; return authoritative
    const fresh = await rgetJson(key);
    return res.status(409).json({ ok: false, error: "Out of date", state: gamePublicState(fresh || g) });
  }

  publishGame(g);
  await cacheAction(g.id, clientActionId, payload);
  return res.json(payload);
});


/* -----------------------------
   Startup
------------------------------ */

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Local server running at http://localhost:${PORT}`);
});