// server.js
import express from "express";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "redis";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

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

const NOW = () => Math.floor(Date.now() / 1000);

export function rateLimit({ capacity, refillPerSec, keyFn }) {
  return async (req, res, next) => {
    const keyId = keyFn(req);
    const key = `rl:${keyId}`;
    const now = NOW();

    const data = await rdb.hGetAll(key);

    let tokens = data.tokens ? Number(data.tokens) : capacity;
    let lastTs = data.ts ? Number(data.ts) : now;

    if (!Number.isFinite(tokens)) tokens = capacity;
    if (!Number.isFinite(lastTs)) lastTs = now;

    const delta = Math.max(0, now - lastTs);
    tokens = Math.min(capacity, tokens + delta * refillPerSec);
    if (!Number.isFinite(tokens)) tokens = capacity;

    if (tokens < 1) {
      res.status(429).json({ error: "rate_limited" });
      return;
    }

    tokens -= 1;

    await rdb.hSet(key, { tokens: tokens.toString(), ts: now.toString() });
    await rdb.expire(key, Math.ceil(capacity / refillPerSec) + 10);

    next();
  };
}

// For local HTTP dev, Secure cookies won't set.
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

function requireSameOrigin(req, res, next) {
  const origin = req.headers.origin;
  if (!origin) return next();
  const expected = `${req.protocol}://${req.get("host")}`;
  if (origin !== expected) return res.status(403).json({ error: "bad origin" });
  return next();
}

const GUEST_COOKIE = "sg_guest";
const GUEST_EXPIRES_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

function guestCookieOptions(req) {
  const secure = isHttps(req) && process.env.NODE_ENV !== "development";
  return {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: GUEST_EXPIRES_MS,
  };
}

function ensureGuest(req, res, next) {
  if (req.user?.uid) return next();

  let g = req.cookies?.[GUEST_COOKIE];
  if (!g) {
    g = crypto.randomBytes(18).toString("base64url");
    res.cookie(GUEST_COOKIE, g, guestCookieOptions(req));
  }
  req.guestId = g;
  next();
}

app.use(ensureGuest);

async function authFromSessionCookie(req, res, next) {
  const cookie = req.cookies[SESSION_COOKIE_NAME];
  if (!cookie) {
    req.user = null;
    return next();
  }

  try {
    const decoded = await admin.auth().verifySessionCookie(cookie, true);
    req.user = { uid: decoded.uid, claims: decoded };
    return next();
  } catch {
    req.user = null;
    return next();
  }
}

app.use(authFromSessionCookie);

function rateLimitId(req) {
  if (req.user?.uid) return `u:${req.user.uid}`;
  if (req.cookies?.sg_guest) return `g:${req.cookies.sg_guest}`;
  return `ip:${req.ip}`;
}

app.post("/api/sessionLogin", requireSameOrigin, async (req, res) => {
  const idToken = req.body?.idToken;
  if (!idToken) return res.status(400).json({ error: "missing idToken" });

  try {
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

app.post("/api/sessionLogout", requireSameOrigin, async (req, res) => {
  res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
  if (req.user?.uid) await admin.auth().revokeRefreshTokens(req.user.uid);
  return res.json({ ok: true });
});

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
  if (ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(JSON.stringify(obj)); } catch {}
}

function publishGame(g) {
  const set = wsSubs.get(g.id);
  if (!set || set.size === 0) return;
  for (const ws of set) {
    wsSend(ws, { type: "state", state: gamePublicState(g, ws._actor || null) });
  }
}

function parseCookies(h) {
  const out = {};
  (h || "").split(";").forEach(part => {
    const i = part.indexOf("=");
    if (i === -1) return;
    const k = part.slice(0, i).trim();
    const v = decodeURIComponent(part.slice(i + 1).trim());
    out[k] = v;
  });
  return out;
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

  const cookies = parseCookies(req.headers.cookie);
  let actor = null;

  const sess = cookies[SESSION_COOKIE_NAME];
  if (sess) {
    try {
      const decoded = await admin.auth().verifySessionCookie(sess, true);
      actor = { kind: "uid", id: decoded.uid };
    } catch {}
  }
  if (!actor && cookies[GUEST_COOKIE]) actor = { kind: "guest", id: cookies[GUEST_COOKIE] };

  ws._actor = actor;
  wsSend(ws, { type:"state", state: gamePublicState(g, actor) });

  ws.on("close", () => subDel(gameId, ws));
  ws.on("error", () => subDel(gameId, ws));

  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", async (buf) => {
    let m = null;
    try { m = JSON.parse(buf.toString("utf8")); } catch {}
    if (!m) return;

    if (m.type === "ping") {
      wsSend(ws, { type: "pong", t: m.t || Date.now() });
      return;
    }

    if (m.type === "hello") {
      wsSend(ws, { type: "pong", t: Date.now() });
      return;
    }

    if (m.type === "resync") {
      const fresh = await loadGameExact(gameId);
      if (fresh) wsSend(ws, { type: "state", state: gamePublicState(fresh, actor) });
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

  await rdb.hSet(hkey, clientActionId, JSON.stringify(payload));
  await rdb.lPush(lkey, clientActionId);
  await rdb.lTrim(lkey, 0, 299);

  const overflow = await rdb.lRange(lkey, 300, 400);
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

async function resolveGame(idOrPrefix) {
  if (!idOrPrefix) return { g: null, error: "Missing id" };

  const raw = String(idOrPrefix).trim();
  if (!raw) return { g: null, error: "Missing id" };

  const exact = await loadGameExact(raw);
  if (exact) return { g: exact };

  if (raw.length === 8) {
    const full = await rdb.get(K.short(raw));
    if (full) {
      const g = await loadGameExact(full);
      if (g) return { g };
    }
  }

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
  return crypto.randomBytes(9).toString("base64url");
}

function mod(a, n) {
  const r = a % n;
  return r < 0 ? r + n : r;
}

function newBoard(N) {
  const b = new Array(N);
  for (let y = 0; y < N; y++) b[y] = new Array(N).fill(0);
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

function seatKeyForSide(side) {
  return side === 1 ? "black" : side === 2 ? "white" : null;
}

function invalidateScoreAccept(g) {
  g.scoreAccept = { black: false, white: false };
  g.scoreDraftRev = (g.scoreDraftRev || 0) + 1;
}

function maybeFinishIfAccepted(g) {
  if (g.scoreAccept?.black && g.scoreAccept?.white) {
    g.phase = "finished";
    g.finishedAt = nowMs();
  }
}

const SEAT_GUEST_TTL_MS = 1000 * 60 * 60 * 6; // 6 hours

function actorFromReq(req) {
  if (req.user?.uid) return { kind: "uid", id: req.user.uid };
  if (req.guestId) return { kind: "guest", id: req.guestId };
  return null;
}

// Signed-in-only for lobby personalization
function actorSignedInFromReq(req) {
  if (req.user?.uid) return { kind: "uid", id: req.user.uid };
  return null;
}

function pruneExpiredSeats(g) {
  const now = nowMs();
  for (const k of ["black", "white"]) {
    const s = g.seats?.[k];
    if (!s) continue;
    if (s.kind === "guest" && s.expiresAt && s.expiresAt <= now) g.seats[k] = null;
  }
}

function sameOwner(a, b) {
  return a && b && a.kind === b.kind && a.id === b.id;
}

function viewerSide(g, actor) {
  if (!actor) return 0;
  if (g.seats?.black && sameOwner(g.seats.black, actor)) return 1;
  if (g.seats?.white && sameOwner(g.seats.white, actor)) return 2;
  return 0;
}

function claimSeat(g, side, actor) {
  pruneExpiredSeats(g);
  const key = seatKeyForSide(side);
  if (!key) return { ok: false, reason: "Bad side" };

  const otherKey = key === "black" ? "white" : "black";

  const cur = g.seats[key];
  if (cur && !sameOwner(cur, actor)) return { ok: false, reason: "Seat taken" };

  const other = g.seats[otherKey];
  if (other && sameOwner(other, actor)) {
    g.seats[otherKey] = null;
  }

  const seat = { kind: actor.kind, id: actor.id, claimedAt: nowMs() };
  if (actor.kind === "guest") seat.expiresAt = nowMs() + SEAT_GUEST_TTL_MS;

  g.seats[key] = seat;
  g.updatedAt = nowMs();
  return { ok: true };
}

function releaseSeat(g, side, actor) {
  pruneExpiredSeats(g);
  const key = seatKeyForSide(side);
  if (!key) return { ok: false, reason: "Bad side" };

  const cur = g.seats[key];
  if (!cur) return { ok: true };
  if (!sameOwner(cur, actor)) return { ok: false, reason: "Not owner" };

  g.seats[key] = null;
  g.updatedAt = nowMs();
  return { ok: true };
}

function requireTurnOwner(g, actor) {
  pruneExpiredSeats(g);
  const key = seatKeyForSide(g.toMove);
  const cur = key ? g.seats?.[key] : null;
  if (!cur) return { ok: false, reason: "Unclaimed side" };
  if (!sameOwner(cur, actor)) return { ok: false, reason: "Not your turn" };

  if (cur.kind === "guest") cur.expiresAt = nowMs() + SEAT_GUEST_TTL_MS;
  return { ok: true };
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
	lastMove: null,

    deadSet: [],
    scoreResult: null,
    rev: 0,
    seen: [],

    scoreAccept: { black: false, white: false },
    scoreDraftRev: 0,
    finishedAt: 0,

    seats: {
      black: null,
      white: null,
    },

    createdAt: nowMs(),
    updatedAt: nowMs(),
  };

  g.seen.push(hashPosition(g));
  return g;
}

function gamePublicState(g, actor = null) {
  pruneExpiredSeats(g);
  return {
    gameId: g.id,
    name: g.name,
    moveCount: g.moveCount,
    N: g.N,
    board: g.board,
    toMove: g.toMove,
    phase: g.phase,
    passStreak: g.passStreak,
	lastMove: g.lastMove || null,
    deadSet: g.deadSet || [],
    scoreResult: g.scoreResult,
    rev: g.rev,
    posHash: hashPosition(g),
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
    score: {
      draftRev: g.scoreDraftRev || 0,
      hasDraft: !!g.scoreResult,
      accept: {
        black: !!g.scoreAccept?.black,
        white: !!g.scoreAccept?.white,
      },
      finishedAt: g.finishedAt || 0,
    },
    seats: {
      blackTaken: !!(g.seats && g.seats.black),
      whiteTaken: !!(g.seats && g.seats.white),
    },
    you: {
      side: viewerSide(g, actor),
    },
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

  const myGroup = collectGroupAndLiberties(b, x, y, N);
  if (myGroup.liberties === 0) return { ok: false, reason: "Suicide" };

  const nextToMove = opp;
  const nextHash = hashPosition({ board: b, toMove: nextToMove });
  if (seenHas(g, nextHash)) return { ok: false, reason: "Superko" };

  g.lastMove = { bx: x, by: y };
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
  g.lastMove = null;

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
  g.lastMove = null;
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

function doToggleDead(g, ax, ay) {
  if (g.phase !== "scoring") return { ok: false, reason: "Not scoring" };

  const N = g.N;
  const x0 = mod(ax, N);
  const y0 = mod(ay, N);

  const color = g.board[y0][x0];
  if (color === 0) return { ok: false, reason: "Empty" };

  const key = (x, y) => x + "," + y;
  const neighbors = (x, y) => ([
    [mod(x + 1, N), y],
    [mod(x - 1, N), y],
    [x, mod(y + 1, N)],
    [x, mod(y - 1, N)],
  ]);

  const stack = [[x0, y0]];
  const seen = new Set([key(x0, y0)]);
  const stones = [];

  while (stack.length) {
    const [x, y] = stack.pop();
    stones.push([x, y]);

    for (const [nx, ny] of neighbors(x, y)) {
      if (g.board[ny][nx] !== color) continue;
      const k = key(nx, ny);
      if (seen.has(k)) continue;
      seen.add(k);
      stack.push([nx, ny]);
    }
  }

  let anyDead = false;
  for (const [sx, sy] of stones) {
    if (deadHas(g, key(sx, sy))) { anyDead = true; break; }
  }

  if (anyDead) {
    for (const [sx, sy] of stones) deadDel(g, key(sx, sy));
  } else {
    for (const [sx, sy] of stones) deadAdd(g, key(sx, sy));
  }

  g.scoreResult = null;
  g.updatedAt = nowMs();
  return { ok: true };
}

function computeScoreServer(g) {
  const N = g.N;
  const b = g.board;

  const dead = new Set((g.deadSet || []).map(String));
  const dkey = (x, y) => x + "," + y;

  const valueForScoring = (x, y) => (dead.has(dkey(x, y)) ? 0 : b[y][x]);

  let blackStones = 0, whiteStones = 0;
  let blackTerritory = 0, whiteTerritory = 0, neutral = 0;

  const ownership = Array.from({ length: N }, () => Array(N).fill(0));

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const v = valueForScoring(x, y);
      if (v === 1) blackStones++;
      else if (v === 2) whiteStones++;
    }
  }

  const key = (x, y) => x + "," + y;
  const neighbors = (x, y) => ([
    [mod(x + 1, N), y],
    [mod(x - 1, N), y],
    [x, mod(y + 1, N)],
    [x, mod(y - 1, N)],
  ]);

  const visited = new Set();

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (valueForScoring(x, y) !== 0) continue;
      const k0 = key(x, y);
      if (visited.has(k0)) continue;

      const stack = [[x, y]];
      visited.add(k0);

      const region = [];
      let regionSize = 0;
      const border = new Set();

      while (stack.length) {
        const [cx, cy] = stack.pop();
        region.push([cx, cy]);
        regionSize++;

        for (const [nx, ny] of neighbors(cx, cy)) {
          const v = valueForScoring(nx, ny);
          if (v === 0) {
            const kk = key(nx, ny);
            if (!visited.has(kk)) {
              visited.add(kk);
              stack.push([nx, ny]);
            }
          } else {
            border.add(v);
          }
        }
      }

      if (border.size === 1) {
        const owner = border.values().next().value;
        if (owner === 1) blackTerritory += regionSize;
        else if (owner === 2) whiteTerritory += regionSize;

        for (const [rx, ry] of region) ownership[ry][rx] = owner;
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
}

function doFinalizeScoring(g) {
  if (g.phase !== "scoring") return { ok: false, reason: "Not scoring" };

  g.scoreResult = computeScoreServer(g);
  g.updatedAt = nowMs();
  return { ok: true };
}

/* -----------------------------
   API
------------------------------ */

app.get("/api/health", async (req, res) => {
  const count = await rdb.zCard(K.updated);
  res.json({ ok: true, games: count });
});

app.get(
  "/api/games",
  rateLimit({ capacity: 60, refillPerSec: 5, keyFn: rateLimitId }),
  async (req, res) => {
    const scope = String(req.query?.scope || "all"); // "all" | "mine"
    const cursorRaw = req.query?.cursor;
    const limitRaw = req.query?.limit;

    const cursor = Math.max(0, Number.isFinite(Number(cursorRaw)) ? Math.trunc(Number(cursorRaw)) : 0);
    const limit = Math.max(1, Math.min(100, Number.isFinite(Number(limitRaw)) ? Math.trunc(Number(limitRaw)) : (scope === "mine" ? 200 : 50)));

    const actor = actorSignedInFromReq(req);

    // For "all", total is total games. For "mine", total is unknown without scanning; return total=null.
    const totalAll = scope === "all" ? await rdb.zCard(K.updated) : null;

    const ids = await rdb.zRange(K.updated, cursor, cursor + limit - 1, { REV: true });
    const out = [];

    // If scope=mine, we scan forward until we collect "limit" seated games (with a hard scan cap).
    const scanCap = scope === "mine" ? 2000 : ids.length;
    let scanned = 0;

    async function pushGame(id) {
      const g = await loadGameExact(id);
      if (!g) return;
      pruneExpiredSeats(g);

      const side = actor ? viewerSide(g, actor) : 0;
      if (scope === "mine" && !(side === 1 || side === 2)) return;

      const yourTurn = !!(side && g.phase === "play" && g.toMove === side);

      out.push({
        gameId: g.id,
        name: g.name,
        moveCount: g.moveCount,
        N: g.N,
        rev: g.rev,
        phase: g.phase,
        createdAt: g.createdAt,
        updatedAt: g.updatedAt,
        youSide: side,
        yourTurn,
      });
    }

    if (scope === "all") {
      for (const id of ids) await pushGame(id);
      const nextCursor = cursor + ids.length;
      return res.json({
        ok: true,
        games: out,
        cursor,
        limit,
        total: totalAll,
        nextCursor,
        hasMore: nextCursor < totalAll,
      });
    }

    // scope === "mine": scan starting at cursor until we fill "limit" or hit scanCap
    let scanCursor = cursor;
    while (out.length < limit && scanned < scanCap) {
      const batch = await rdb.zRange(K.updated, scanCursor, scanCursor + 49, { REV: true });
      if (!batch.length) break;
      for (const id of batch) {
        await pushGame(id);
        scanned++;
        if (out.length >= limit) break;
        if (scanned >= scanCap) break;
      }
      scanCursor += batch.length;
      if (batch.length < 50) break;
    }

    // Sort mine: yourTurn first, then newest
    out.sort((a, b) => {
      const at = a.yourTurn ? 1 : 0;
      const bt = b.yourTurn ? 1 : 0;
      if (bt !== at) return bt - at;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });

    return res.json({
      ok: true,
      games: out,
      cursor,
      limit,
      total: null,
      nextCursor: scanCursor,
      hasMore: false,
    });
  }
);



app.delete("/api/game/:gameId", async (req, res) => {
  const { g, error } = await resolveGame(req.params.gameId);
  if (!g) return res.status(404).json({ ok: false, error });

  await rdb.del(K.game(g.id));
  await rdb.zRem(K.updated, g.id);
  await rdb.del(K.short(g.id.slice(0, 8)));

  await rdb.del(K.actions(g.id));
  await rdb.del(K.actionsOrder(g.id));

  res.json({ ok: true, deleted: true, gameId: g.id });
});

app.post(
  "/api/game/new",
  rateLimit({ capacity: 3, refillPerSec: 1 / 60, keyFn: rateLimitId }),
  async (req, res) => {
    const Nraw = req.body?.N ?? 19;
    const name = req.body?.name ?? "";

    const N = Number(Nraw);
    const safeN = Number.isInteger(N) && N >= 3 && N <= 49 ? N : 19;

    const g = createGame(safeN, name);
    await saveGame(g);
    publishGame(g);

    res.json({ ok: true, gameId: g.id, state: gamePublicState(g) });
  }
);

app.get("/api/game/:gameId", async (req, res) => {
  const { g, error } = await resolveGame(req.params.gameId);
  if (!g) return res.status(404).json({ ok: false, error });

  const actor = actorFromReq(req);
  res.json({ ok: true, state: gamePublicState(g, actor) });
});

app.post(
  "/api/move",
  rateLimit({ capacity: 30, refillPerSec: 1, keyFn: rateLimitId }),
  async (req, res) => {
    const { gameId, action, rev, clientActionId } = req.body || {};
    if (!gameId || !action || !action.type) {
      return res.status(400).json({ ok: false, error: "Missing gameId/action" });
    }

    const actor = actorFromReq(req);
    if (!actor) return res.status(401).json({ ok: false, error: "No identity" });

    const cached = await getCachedAction(gameId, clientActionId);
    if (cached) return res.json(cached);

    const resolved = await resolveGame(gameId);
    if (!resolved.g) return res.status(404).json({ ok: false, error: resolved.error });
    const id = resolved.g.id;

    const key = K.game(id);
    await rdb.watch(key);

    let g = await rgetJson(key);
    if (!g) {
      await rdb.unwatch();
      return res.status(404).json({ ok: false, error: "Game not found" });
    }
	
	if (!Number.isInteger(g.rev)) g.rev = 0;

    if (!Number.isInteger(rev) || rev !== g.rev) {
      await rdb.unwatch();
      return res.status(409).json({ ok: false, error: "Out of date", state: gamePublicState(g, actor) });
    }

    let r;
    const t = action.type;

    if (t === "claim") {
      const side = Number(action.side);
      if (side !== 1 && side !== 2) {
        await rdb.unwatch();
        return res.status(400).json({ ok: false, error: "Bad side" });
      }
      r = claimSeat(g, side, actor);

    } else if (t === "release") {
      const side = Number(action.side);
      if (side !== 1 && side !== 2) {
        await rdb.unwatch();
        return res.status(400).json({ ok: false, error: "Bad side" });
      }
      r = releaseSeat(g, side, actor);

    } else if (t === "play") {
      const ax = Number.isFinite(action.ax) ? action.ax : action.bx;
      const ay = Number.isFinite(action.ay) ? action.ay : action.by;
      if (!Number.isFinite(ax) || !Number.isFinite(ay)) {
        await rdb.unwatch();
        return res.status(400).json({ ok: false, error: "Missing coordinates" });
      }

      const gate = requireTurnOwner(g, actor);
      if (!gate.ok) r = gate;
      else r = tryPlay(g, ax, ay);

    } else if (t === "pass") {
      const gate = requireTurnOwner(g, actor);
      if (!gate.ok) r = gate;
      else r = doPass(g);

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
      if (g.phase !== "scoring") {
        r = { ok: false, reason: "Not in scoring" };
      } else {
        r = doToggleDead(g, ax, ay);
        if (r.ok) {
          invalidateScoreAccept(g);
          g.scoreResult = null;
        }
      }

    } else if (t === "finalizeScore") {
      if (g.phase !== "scoring") {
        r = { ok: false, reason: "Not in scoring" };
      } else {
        r = doFinalizeScoring(g);
        if (r.ok) {
          invalidateScoreAccept(g);
          const k = seatKeyForSide(viewerSide(g, actor));
          if (k) g.scoreAccept[k] = true;
        }
      }

    } else if (t === "acceptScore") {
      if (g.phase !== "scoring") {
        r = { ok: false, reason: "Not in scoring" };
      } else if (!g.scoreResult) {
        r = { ok: false, reason: "No score draft" };
      } else {
        const side = viewerSide(g, actor);
        const k = seatKeyForSide(side);
        if (!k) {
          r = { ok: false, reason: "You don't own a seat" };
        } else {
          if (!g.scoreAccept) g.scoreAccept = { black: false, white: false };
          g.scoreAccept[k] = true;
          maybeFinishIfAccepted(g);
          r = { ok: true };
        }
      }

    } else if (t === "unacceptScore") {
      if (g.phase !== "scoring") r = { ok: false, reason: "Not in scoring" };
      else {
        const side = viewerSide(g, actor);
        const k = seatKeyForSide(side);
        if (!k) r = { ok: false, reason: "You don't own a seat" };
        else {
          if (!g.scoreAccept) g.scoreAccept = { black: false, white: false };
          g.scoreAccept[k] = false;
          r = { ok: true };
        }
      }

    } else if (t === "resign") {
      g.phase = "scoring";
      const who =
        actor.kind === "uid" ? `uid:${actor.id}` :
        actor.kind === "guest" ? "guest" :
        "player";
      g.scoreResult = { note: `${who} resigned` };
      g.updatedAt = nowMs();
      r = { ok: true };

    } else {
      await rdb.unwatch();
      return res.status(400).json({ ok: false, error: "Unknown action type" });
    }

    const countsAsMove = (t === "play" || t === "pass");

    let payload;
    if (!r.ok) {
      payload = {
        ok: true,
        accepted: false,
        reason: r.reason || "Rejected",
        state: gamePublicState(g, actor),
      };
    } else {
      if (countsAsMove) g.moveCount += 1;

      g.rev += 1;
      g.updatedAt = nowMs();

      payload = {
        ok: true,
        accepted: true,
        meta: { captured: r.captured || 0 },
        state: gamePublicState(g, actor),
      };
    }

    const multi = rdb.multi();
    multi.set(key, JSON.stringify(g));
    multi.zAdd(K.updated, [{ score: g.updatedAt || nowMs(), value: g.id }]);
    multi.set(K.short(g.id.slice(0, 8)), g.id);

    const execRes = await multi.exec();
    if (execRes === null) {
      const fresh = await rgetJson(key);
      return res.status(409).json({
        ok: false,
        error: "Out of date",
        state: gamePublicState(fresh || g, actor),
      });
    }

    publishGame(g);
    await cacheAction(g.id, clientActionId, payload);
    return res.json(payload);
  }
);

/* -----------------------------
   Startup
------------------------------ */

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Local server running at http://localhost:${PORT}`);
});
