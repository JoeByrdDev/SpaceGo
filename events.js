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

    const r = Engine.tryPlayAbs(near.ax, near.ay);
    if (!r.ok) {
      Util.setStatus(r.reason);
    } else {
      Util.setTurnUI();
      Util.setStatus(r.captured ? `Captured ${r.captured}` : 'Placed');
    }
    Render.requestRender();
  } else {
    Util._syncGlobals();
  }

  try {
    canvas.releasePointerCapture(e.pointerId);
  } catch (_) {}
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
passBtn.addEventListener('click', () => Engine.pass());
resetBtn.addEventListener('click', () => Engine.reset(N));
applySizeBtn.addEventListener('click', () => {
  const n = Util.clampInt(parseInt(sizeInput.value || '19', 10), 5, 49);
  Engine.reset(n);
});

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
