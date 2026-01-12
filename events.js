window.Events = window.Events || {};

Events.onPointerDown = function(e) {
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

Events.onPointerMove = function(e) {
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;

  // Hover updates even without left down
  mouse.x = sx;
  mouse.y = sy;
  const wpos = Util.screenToWorld(sx, sy);
  const near = Util.worldToNearestIntersection(wpos.x, wpos.y);

  const prevOver = mouse.over;
  mouse.over = { gx: near.gx, gy: near.gy, x: near.x, y: near.y, tileX: near.tileX, tileY: near.tileY };
  if (!prevOver || prevOver.gx !== mouse.over.gx || prevOver.gy !== mouse.over.gy) Render.requestRender();

  if (!dragging) return;

  const moved = Math.hypot(sx - dragStart.x, sy - dragStart.y);
  if (dragMode === 'pending' && moved > 6) dragMode = 'pan';

  if (dragMode !== 'pan') return;

  const dx = (sx - dragStart.x) / cell;
  const dy = (sy - dragStart.y) / cell;

  // Dragging the mouse right should move camera left (world follows hand)
  camWX = camStart.x - dx;
  camWY = camStart.y - dy;
  Render.requestRender();
}

Events.onPointerUp = function(e) {
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
    const wpos = Util.screenToWorld(sx, sy);
    const near = Util.worldToNearestIntersection(wpos.x, wpos.y);
    const r = Engine.tryPlay(near.x, near.y);
    if (!r.ok) {
      Util.setStatus(r.reason);
    } else {
      Util.setTurnUI();
      Util.setStatus(r.captured ? `Captured ${r.captured}` : 'Placed');
    }
    Render.requestRender();
  }

  try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
}

Events.onPointerLeave = function() {
  if (mouse.over) {
    mouse.over = null;
    Render.requestRender();
  }
}

Events.onWheel = function(e) {
  e.preventDefault();
  const delta = Math.sign(e.deltaY);
  const factor = delta > 0 ? 0.92 : 1.08;
  cell = Math.max(18, Math.min(70, cell * factor));
  Render.requestRender();
}

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
canvas.addEventListener('wheel', Events.onWheel, { passive: false });

// Disable default context menu on right click
canvas.addEventListener('contextmenu', e => e.preventDefault());

// Resize
const shell = document.getElementById('game-shell');
const ro = new ResizeObserver(entries => {
  for (const entry of entries) {
    const { width, height } = entry.contentRect;
    Util.resizeCanvas(width, height);
  }
});
ro.observe(shell);