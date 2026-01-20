// events.js
window.Events = window.Events || {};

Events.onPointerDown = function (e) {
  if (e.button !== 0) return; // left only

  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;

  dragging = true;
  dragMode = 'pending';
  dragStart = { x: sx, y: sy };
  camStart = { ax: camAX, ay: camAY };

  Util._syncGlobals();
  canvas.setPointerCapture(e.pointerId);
};

Events.onPointerMove = function (e) {
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;

  // Hover updates even without left down
  mouse.x = sx;
  mouse.y = sy;

  const absf = Util.screenToAbs(sx, sy);
  const near = Util.absFloatToNearest(absf.ax, absf.ay);

  const prevOver = mouse.over;
  mouse.over = near;

  if (!prevOver || prevOver.ax !== near.ax || prevOver.ay !== near.ay) {
    Util._syncGlobals();
    Render.requestRender();
  }

  if (!dragging) return;

  const moved = Math.hypot(sx - dragStart.x, sy - dragStart.y);
  if (dragMode === 'pending' && moved > 6) dragMode = 'pan';

  if (dragMode !== 'pan') {
    Util._syncGlobals();
    return;
  }

  const dx = (sx - dragStart.x) / cell;
  const dy = (sy - dragStart.y) / cell;

  // Dragging the mouse right should move camera left (world follows hand)
  camAX = camStart.ax - dx;
  camAY = camStart.ay - dy;

  Util._syncGlobals();
  Render.requestRender();
};

Events.onPointerUp = function (e) {
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
    const absf = Util.screenToAbs(sx, sy);
const near = Util.absFloatToNearest(absf.ax, absf.ay);

if (Engine.getPhase && Engine.getPhase() === 'scoring') {
  const r = Engine.toggleDeadAtAbs(near.ax, near.ay);

  // Clicking empty space during scoring is a no-op; keep the scoring status text.
  if (!r.ok) {
    if (r.reason !== 'Empty') Util.setStatus(r.reason);
    // else do nothing
  }

  Render.requestRender();
  return;
}

// normal play path (unchanged)
const r0 = (() => {
  // local pre-validate using simulate, no mutation
  const s0 = { N, board, toMove, seen: Util.seen, phase: Engine.getPhase(), passStreak: 0 };
  const { bx, by } = near;
  return Engine.simulatePlayBase(bx, by, s0);
})();

if (!r0.ok) {
  Util.setStatus(r0.reason);
  Render.requestRender();
  return;
}

// If net mode is OFF: commit locally (old behavior, but via applyStateLocal)
if (!Engine.isNetMode || !Engine.isNetMode()) {
  Engine.applyStateLocal(r0.next);
  Util.setTurnUI();
  Util.setStatus(r0.captured ? `Captured ${r0.captured}` : 'Placed');
  Render.requestRender();
  return;
}

// Net mode ON: ask server, apply authoritative state
if (Engine.isNetBusy && Engine.isNetBusy()) return;

Engine._setNetBusy(true);
Util.setStatus('Sending…');
Render.requestRender();

Net.requestAction({
  type: 'play',
  ax: near.ax,
  ay: near.ay,
  // optional: include base coords too
  bx: near.bx,
  by: near.by,
}).then((rr) => {
  if (!rr.ok) Util.setStatus(rr.reason);
  else Util.setStatus('Placed');
  Util.setTurnUI();
  Render.requestRender();
}).finally(() => {
  Engine._setNetBusy(false);
});
  }
};


Events.onPointerLeave = function () {
  if (mouse.over) {
    mouse.over = null;
    Util._syncGlobals();
    Render.requestRender();
  }
};

Events.onWheel = function (e) {
  e.preventDefault();
  const delta = Math.sign(e.deltaY);
  const factor = delta > 0 ? 0.92 : 1.08;
  cell = Math.max(18, Math.min(70, cell * factor));
  Util._syncGlobals();
  Render.requestRender();
};

// Optional: handle pointercancel cleanly (mobile / OS interruptions)
Events.onPointerCancel = function () {
  dragging = false;
  dragMode = 'idle';
  dragStart = null;
  camStart = null;
  Util._syncGlobals();
  Render.requestRender();
};

// Bindings
passBtn.addEventListener('click', async () => {
  if (Engine.isNetMode && Engine.isNetMode()) {
    if (Engine.isNetBusy && Engine.isNetBusy()) return;
    Engine._setNetBusy(true);
    Util.setStatus('Sending…');
    Render.requestRender();
    try {
      const r = await Net.requestAction({ type: 'pass' });
      if (!r.ok) Util.setStatus(r.reason);
    } finally {
      Engine._setNetBusy(false);
      Render.requestRender();
    }
  } else {
    Engine.pass();
  }
});

resetBtn.addEventListener('click', async () => {
  if (Engine.isNetMode && Engine.isNetMode()) {
    Util.setStatus('New game…');
    Render.requestRender();
    const r = await Engine.newGame(N);
    if (!r.ok) Util.setStatus(r.reason);
    Render.requestRender();
    return;
  }
  Engine.reset(N);
});

applySizeBtn.addEventListener('click', () => {
  const n = Util.clampInt(parseInt(sizeInput.value || '19', 10), 5, 49);

  if (Engine.isNetMode && Engine.isNetMode()) {
    Util.setStatus('New board…');
    Render.requestRender();
    Engine.newGame(n).then((r) => {
      if (!r.ok) Util.setStatus(r.reason);
      Render.requestRender();
    });
    return;
  }

  Engine.reset(n);
});

Util.initGamePicker();

async function refreshGameListAndSelectCurrent() {
  if (!Engine.isNetMode || !Engine.isNetMode()) return;

  const r = await Net.listGames();
  if (!r.ok) {
    Util.setStatus(r.reason);
    return;
  }

  Util.setGameList(r.games, Net.gameId);
}

if (window.refreshGamesBtn) {
  refreshGamesBtn.addEventListener('click', async () => {
    await refreshGameListAndSelectCurrent();
    Render.requestRender();
  });
}

if (window.gameSelect) {
  gameSelect.addEventListener('change', async () => {
    if (!Engine.isNetMode || !Engine.isNetMode()) return;
    if (Engine.isNetBusy && Engine.isNetBusy()) return;

    const id = gameSelect.value;
    if (!id) return;

    Engine._setNetBusy(true);
    Util.setStatus('Loading…');
    Render.requestRender();

    try {
      const r = await Net.loadGame(id);
      if (!r.ok) Util.setStatus(r.reason);
      else Util.setStatus('Ready');
    } finally {
      Engine._setNetBusy(false);
      Render.requestRender();
    }
  });
}

canvas.addEventListener('pointerdown', Events.onPointerDown);
canvas.addEventListener('pointermove', Events.onPointerMove);
canvas.addEventListener('pointerup', Events.onPointerUp);
canvas.addEventListener('pointerleave', Events.onPointerLeave);
canvas.addEventListener('pointercancel', Events.onPointerCancel);
canvas.addEventListener('wheel', Events.onWheel, { passive: false });

// Disable default context menu on right click
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// Resize
const shell = document.getElementById('game-shell');
const ro = new ResizeObserver((entries) => {
  for (const entry of entries) {
    const { width, height } = entry.contentRect;
    Util.resizeCanvas(width, height);
  }
});
ro.observe(shell);