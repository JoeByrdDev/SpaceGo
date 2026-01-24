// events.js (only kept pass; removed reset/new-game UI + game dropdown wiring)
window.Events = window.Events || {};

const touchPts = new Map(); // pointerId -> { sx, sy }

let pinchActive = false;
let pinchStartDist = 0;
let pinchStartCell = 0;
let pinchAnchorAbs = null;
let pinchMoved = false;
let suppressNextTap = false;

function _touchMidAndDist() {
  const pts = Array.from(touchPts.values());
  if (pts.length < 2) return null;
  const a = pts[0], b = pts[1];
  const midX = (a.sx + b.sx) / 2;
  const midY = (a.sy + b.sy) / 2;
  const dist = Math.hypot(a.sx - b.sx, a.sy - b.sy);
  return { midX, midY, dist };
}

Events.onPointerDown = function (e) {
  if (e.pointerType !== 'touch' && e.button !== 0) return; // left only unless touch

  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;

  if (e.pointerType === 'touch') {
    e.preventDefault();
    touchPts.set(e.pointerId, { sx, sy });
    canvas.setPointerCapture(e.pointerId);

    if (touchPts.size >= 2) {
      const md = _touchMidAndDist();
      if (md) {
        pinchActive = true;
        pinchMoved = false;
        pinchStartDist = Math.max(1, md.dist);
        pinchStartCell = cell;
        pinchAnchorAbs = Util.screenToAbs(md.midX, md.midY);

        dragging = false;
        dragMode = 'idle';
        dragStart = null;
        camStart = null;
      }
      Util._syncGlobals();
      Render.requestRender();
      return;
    }
  }

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

  if (e.pointerType === 'touch') e.preventDefault();
  if (e.pointerType === 'touch' && touchPts.has(e.pointerId)) {
    touchPts.set(e.pointerId, { sx, sy });
  }

  if (e.pointerType === 'touch' && pinchActive && touchPts.size >= 2 && pinchAnchorAbs) {
    const md = _touchMidAndDist();
    if (md) {
      const scale = md.dist / Math.max(1, pinchStartDist);
      const newCell = Math.max(18, Math.min(70, pinchStartCell * scale));

      if (Math.abs(newCell - cell) > 0.05) pinchMoved = true;

      cell = newCell;

      camAX = pinchAnchorAbs.ax - (md.midX - viewW / 2) / cell;
      camAY = pinchAnchorAbs.ay - (md.midY - viewH / 2) / cell;

      Util._syncGlobals();
      Render.requestRender();
    }
    return;
  }
  
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

  camAX = camStart.ax - dx;
  camAY = camStart.ay - dy;

  Util._syncGlobals();
  Render.requestRender();
};

Events.onPointerUp = function (e) {
  if (e.pointerType !== 'touch' && e.button !== 0) return;
  if (e.pointerType === 'touch') e.preventDefault();
  if (e.pointerType === 'touch') {
    touchPts.delete(e.pointerId);

    if (pinchActive && touchPts.size < 2) {
      pinchActive = false;
      pinchStartDist = 0;
      pinchStartCell = 0;
      pinchAnchorAbs = null;
      suppressNextTap = pinchMoved;
      pinchMoved = false;

      dragging = false;
      dragMode = 'idle';
      dragStart = null;
      camStart = null;

      Util._syncGlobals();
      Render.requestRender();
      return;
    }
  }

  if (suppressNextTap) {
    suppressNextTap = false;
    Util._syncGlobals();
    Render.requestRender();
    return;
  }

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
      // In scoring, clicks toggle dead stones. In net mode this MUST go through server
      // so both players see the same dead set via websocket/state updates.
      if (Engine.isNetMode && Engine.isNetMode()) {
        if (Engine.isNetBusy && Engine.isNetBusy()) return;

        Engine._setNetBusy(true);
        Util.setStatus('Sending…');
        Render.requestRender();

        Net.requestAction({
          type: 'toggleDead',
          ax: near.ax,
          ay: near.ay,
          bx: near.bx,
          by: near.by,
        }).then((rr) => {
          if (!rr.ok) {
            if (rr.reason !== 'Empty') Util.setStatus(rr.reason);
          } else {
            Util.setStatus('Marked');
          }
          Util.setTurnUI();
          Render.requestRender();
        }).finally(() => {
          Engine._setNetBusy(false);
        });

        return;
      }

      // Local/offline scoring
      const r = Engine.toggleDeadAtAbs(near.ax, near.ay);
      if (!r.ok) {
        if (r.reason !== 'Empty') Util.setStatus(r.reason);
      }
      Render.requestRender();
      return;
    }


    // Turn gate (insecure on purpose for now): only the selected side can move on its turn.
    if (!Util.canActNow()) {
      Util.setStatus(Util.getPlayer() === 0 ? 'Select Black or White' : 'Not your turn');
      Render.requestRender();
      return;
    }

    const r0 = (() => {
      const s0 = { N, board, toMove, seen: Util.seen, phase: Engine.getPhase(), passStreak: 0 };
      const { bx, by } = near;
      return Engine.simulatePlayBase(bx, by, s0);
    })();

    if (!r0.ok) {
      Util.setStatus(r0.reason);
      Render.requestRender();
      return;
    }

    if (!Engine.isNetMode || !Engine.isNetMode()) {
      Engine.applyStateLocal(r0.next);
      Util.setTurnUI();
      Util.setStatus(r0.captured ? `Captured ${r0.captured}` : 'Placed');
      Render.requestRender();
      return;
    }

    if (Engine.isNetBusy && Engine.isNetBusy()) return;

    Engine._setNetBusy(true);
    Util.setStatus('Sending…');
    Render.requestRender();

    Net.requestAction({
      type: 'play',
      ax: near.ax,
      ay: near.ay,
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

Events.onPointerCancel = function () {
  touchPts.clear();

  pinchActive = false;
  pinchStartDist = 0;
  pinchStartCell = 0;
  pinchAnchorAbs = null;
  pinchMoved = false;
  suppressNextTap = false;

  dragging = false;
  dragMode = 'idle';
  dragStart = null;
  camStart = null;

  Util._syncGlobals();
  Render.requestRender();
};


// Bindings
passBtn.addEventListener('click', async () => {
  if (!Util.canActNow()) {
    Util.setStatus(Util.getPlayer() === 0 ? 'Select Black or White' : 'Not your turn');
    Render.requestRender();
    return;
  }
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

canvas.addEventListener('pointerleave', Events.onPointerLeave);
canvas.addEventListener('pointerdown', Events.onPointerDown, { passive: false });
canvas.addEventListener('pointermove', Events.onPointerMove, { passive: false });
canvas.addEventListener('pointerup', Events.onPointerUp, { passive: false });
canvas.addEventListener('pointercancel', Events.onPointerCancel, { passive: false });
canvas.addEventListener('wheel', Events.onWheel, { passive: false });

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

const shell = document.getElementById('game-shell');
const ro = new ResizeObserver((entries) => {
  for (const entry of entries) {
    const { width, height } = entry.contentRect;
    Util.resizeCanvas(width, height);
  }
});
ro.observe(shell);
