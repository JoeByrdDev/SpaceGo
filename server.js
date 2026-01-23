// server.js
import express from "express";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

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

/* -----------------------------
   In-memory game store (dev)
------------------------------ */

const games = new Map(); // gameId -> Game

function resolveGame(idOrPrefix) {
  if (!idOrPrefix) return { g: null, error: "Missing id" };

  // exact match first
  const exact = games.get(idOrPrefix);
  if (exact) return { g: exact };

  // allow short prefix (like the 8-char lobby display)
  const prefix = String(idOrPrefix).trim();
  if (prefix.length < 4) return { g: null, error: "Id too short" };

  const matches = [];
  for (const g of games.values()) {
    if (g.id.startsWith(prefix)) matches.push(g);
  }

  if (matches.length === 1) return { g: matches[0] };
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
    deadSet: Array.from(g.deadSet),
    scoreResult: g.scoreResult,
    rev: g.rev,
    posHash: hashPosition(g),
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
  };
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
    deadSet: new Set(),
    scoreResult: null,
    rev: 0,
    clientActions: new Map(), // clientActionId -> response payload
    seen: new Set(),
    createdAt: nowMs(),
    updatedAt: nowMs(),
  };

  g.seen.add(hashPosition(g));
  return g;
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
  if (g.seen.has(nextHash)) return { ok: false, reason: "Superko" };

  // commit
  g.board = b;
  g.toMove = nextToMove;
  g.passStreak = 0;
  g.deadSet.clear();
  g.scoreResult = null;

  g.seen.add(nextHash);
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
  g.seen.add(h);

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
  g.deadSet.clear();
  g.scoreResult = null;
  g.seen = new Set();
  g.seen.add(hashPosition(g));
  g.updatedAt = nowMs();
  return { ok: true };
}

function doSetPhase(g, phase) {
  if (phase !== "play" && phase !== "scoring") return { ok: false, reason: "Bad phase" };
  g.phase = phase;
  if (phase === "play") {
    g.passStreak = 0;
    g.deadSet.clear();
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
  if (g.deadSet.has(k)) g.deadSet.delete(k);
  else g.deadSet.add(k);

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
app.get("/api/health", (req, res) => {
  res.json({ ok: true, games: games.size });
});

app.get("/api/games", (req, res) => {
  const out = [];
  for (const g of games.values()) {
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
  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  res.json({ ok: true, games: out });
});

app.delete("/api/game/:gameId", (req, res) => {
  const { g, error } = resolveGame(req.params.gameId);
  if (!g) return res.status(404).json({ ok: false, error });

  const existed = games.delete(g.id);
  res.json({ ok: true, deleted: existed, gameId: g.id });
});

// create new game (now accepts { N, name })
app.post("/api/game/new", (req, res) => {
  const Nraw = req.body?.N ?? 19;
  const name = req.body?.name ?? "";

  const N = Number(Nraw);
  const safeN = Number.isInteger(N) && N >= 3 && N <= 49 ? N : 19;

  const g = createGame(safeN, name);
  games.set(g.id, g);

  res.json({ ok: true, gameId: g.id, state: gamePublicState(g) });
});

// get game state
app.get("/api/game/:gameId", (req, res) => {
  const { g, error } = resolveGame(req.params.gameId);
  if (!g) return res.status(404).json({ ok: false, error });
  res.json({ ok: true, state: gamePublicState(g) });
});

// single action endpoint
app.post("/api/move", (req, res) => {
  const { gameId, action, rev, clientActionId } = req.body || {};
  if (!gameId || !action || !action.type) {
    return res.status(400).json({ ok: false, error: "Missing gameId/action" });
  }

  const { g, error } = resolveGame(gameId);
if (!g) return res.status(404).json({ ok: false, error });

  if (clientActionId && g.clientActions.has(clientActionId)) {
    return res.json(g.clientActions.get(clientActionId));
  }

  if (!Number.isInteger(rev) || rev !== g.rev) {
    return res.status(409).json({
      ok: false,
      error: "Out of date",
      state: gamePublicState(g),
    });
  }

  let r;
  const t = action.type;

  if (t === "play") {
    const ax = Number.isFinite(action.ax) ? action.ax : action.bx;
    const ay = Number.isFinite(action.ay) ? action.ay : action.by;
    if (!Number.isFinite(ax) || !Number.isFinite(ay)) {
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
    const ax = action.ax;
    const ay = action.ay;
    if (!Number.isFinite(ax) || !Number.isFinite(ay)) {
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
    return res.status(400).json({ ok: false, error: "Unknown action type" });
  }

  const countsAsMove = (t === "play" || t === "pass");

  let payload;
  if (!r.ok) {
    payload = {
      ok: true,
      accepted: false,
      reason: r.reason || "Rejected",
      state: gamePublicState(g),
    };
  } else {
    if (countsAsMove) g.moveCount += 1;

    g.rev += 1;
    g.updatedAt = nowMs();

    payload = {
      ok: true,
      accepted: true,
      meta: { captured: r.captured || 0 },
      state: gamePublicState(g),
    };
  }

  if (clientActionId) {
    g.clientActions.set(clientActionId, payload);
    while (g.clientActions.size > 300) {
      const oldestKey = g.clientActions.keys().next().value;
      g.clientActions.delete(oldestKey);
    }
  }

  return res.json(payload);
});

/* -----------------------------
   Startup
------------------------------ */

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Local server running at http://localhost:${PORT}`);
});
