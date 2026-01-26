// render.js
window.Render = window.Render || {};

Render.requestRender = function () {
  if (rafPending) return;
  rafPending = true;
  Util._syncGlobals();

  requestAnimationFrame(() => {
    rafPending = false;
    Util._syncGlobals();
    Render.drawOnce();
  });
};

Render.drawOnce = function () {
  // Background
  ctx.clearRect(0, 0, viewW, viewH);
  ctx.fillStyle = '#475770';
  ctx.fillRect(0, 0, viewW, viewH);

  // Visible abs bounds in grid units
  const leftA = camAX - (viewW / 2 + margin) / cell;
  const rightA = camAX + (viewW / 2 + margin) / cell;
  const topA = camAY - (viewH / 2 + margin) / cell;
  const bottomA = camAY + (viewH / 2 + margin) / cell;

  Render.drawGridAbs(leftA, rightA, topA, bottomA);
  
  const ph = Engine.getPhase && Engine.getPhase();
  if (ph === 'scoring' || ph === 'finished') {
    Render.drawTerritoryAbs(leftA, rightA, topA, bottomA);
  }

  Render.drawStonesAbs(leftA, rightA, topA, bottomA);

  // Hover/ghost indicator (absolute), repeated by +/-N
  const pm = (window.Util && Util.getPendingMove) ? Util.getPendingMove() : null;

  if (ph === 'play') {
    if (pm) Render.drawHoverAbs(pm.ax, pm.ay);
    else if (mouse.over) Render.drawHoverAbs(mouse.over.ax, mouse.over.ay);
  }


  // Subtle center crosshair
  ctx.strokeStyle = 'rgba(233,238,245,0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(viewW / 2 - 10, viewH / 2);
  ctx.lineTo(viewW / 2 + 10, viewH / 2);
  ctx.moveTo(viewW / 2, viewH / 2 - 10);
  ctx.lineTo(viewW / 2, viewH / 2 + 10);
  ctx.stroke();
};

Render.drawGridAbs = function (leftA, rightA, topA, bottomA) {
  const x0 = Math.floor(leftA);
  const x1 = Math.ceil(rightA);
  const y0 = Math.floor(topA);
  const y1 = Math.ceil(bottomA);

  // Regular grid (non-seam)
  ctx.strokeStyle = 'rgba(233,238,245,0.12)';
  ctx.lineWidth = 1;

  // Vertical regular lines: ax where ax % N != 0
  ctx.beginPath();
  for (let ax = x0; ax <= x1; ax++) {
    if (Util.mod(ax, N) === 0) continue; // seam lines drawn thicker below
    const p1 = Util.absToScreen(ax, y0);
    const p2 = Util.absToScreen(ax, y1);
    if (p1.x < -margin || p1.x > viewW + margin) continue;
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
  }
  ctx.stroke();

  // Horizontal regular lines: ay where ay % N != 0
  ctx.beginPath();
  for (let ay = y0; ay <= y1; ay++) {
    if (Util.mod(ay, N) === 0) continue;
    const p1 = Util.absToScreen(x0, ay);
    const p2 = Util.absToScreen(x1, ay);
    if (p1.y < -margin || p1.y > viewH + margin) continue;
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
  }
  ctx.stroke();

  // Tile seam lines (repeat edges / "real board edges")
  ctx.strokeStyle = 'rgba(233,238,245,0.22)';
  ctx.lineWidth = 2;

  // Vertical seams at ax ≡ 0 (mod N)
  ctx.beginPath();
  let ax0 = x0 - Util.mod(x0, N);
  for (let ax = ax0; ax <= x1; ax += N) {
    const p1 = Util.absToScreen(ax, y0);
    const p2 = Util.absToScreen(ax, y1);
    if (p1.x < -margin || p1.x > viewW + margin) continue;
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
  }
  ctx.stroke();

  // Horizontal seams at ay ≡ 0 (mod N)
  ctx.beginPath();
  let ay0 = y0 - Util.mod(y0, N);
  for (let ay = ay0; ay <= y1; ay += N) {
    const p1 = Util.absToScreen(x0, ay);
    const p2 = Util.absToScreen(x1, ay);
    if (p1.y < -margin || p1.y > viewH + margin) continue;
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
  }
  ctx.stroke();
};

Render.drawLastMovePlus = function(px, py, r, stoneV) {
  const pr = r * 0.35;       // plus half-length
  const lw = Math.max(1, Math.round(r * 0.18));

  ctx.strokeStyle = (stoneV === 1) ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.75)';
  ctx.lineWidth = lw;
  ctx.lineCap = 'round';

  ctx.beginPath();
  ctx.moveTo(px - pr, py);
  ctx.lineTo(px + pr, py);
  ctx.moveTo(px, py - pr);
  ctx.lineTo(px, py + pr);
  ctx.stroke();
};

Render.drawStonesAbs = function(leftA, rightA, topA, bottomA) {
  const x0 = Math.floor(leftA);
  const x1 = Math.ceil(rightA);
  const y0 = Math.floor(topA);
  const y1 = Math.ceil(bottomA);

  const r = cell * 0.43;

  const ph = Engine.getPhase && Engine.getPhase();
  const isScoring = (ph === 'scoring' || ph === 'finished');

  for (let ax = x0; ax <= x1; ax++) {
    for (let ay = y0; ay <= y1; ay++) {
      const c = Util.absToBase(ax, ay);
      const v = board[c.by][c.bx];
      if (v === 0) continue;

      const p = Util.absToScreen(ax, ay);
      if (p.x < -r || p.x > viewW + r || p.y < -r || p.y > viewH + r) continue;

      const isDead = isScoring && Engine.isDeadBase && Engine.isDeadBase(c.bx, c.by);

      ctx.save();
      if (isDead) ctx.globalAlpha = 0.35;

      // Stone fill
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = v === 1 ? '#0a0b0d' : '#f2f5f9';
      ctx.fill();

      // Highlight
      const hl = ctx.createRadialGradient(
        p.x - r * 0.35, p.y - r * 0.35, r * 0.1,
        p.x, p.y, r
      );

      if (v === 1) {
        hl.addColorStop(0, 'rgba(255,255,255,0.10)');
        hl.addColorStop(1, 'rgba(255,255,255,0.00)');
      } else {
        hl.addColorStop(0, 'rgba(0,0,0,0.10)');
        hl.addColorStop(1, 'rgba(0,0,0,0.00)');
      }

      ctx.fillStyle = hl;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();

      // Outline
      ctx.strokeStyle = v === 1 ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.12)';
      ctx.lineWidth = 1;
      ctx.stroke();
	  
	  const lm = window.lastMove;
      if (lm && lm.bx === c.bx && lm.by === c.by) {
        Render.drawLastMovePlus(p.x, p.y, r, v);
      }

      ctx.restore();

      // Dead marker cross (after restore so it stays visible)
      if (isDead) {
        const rr = r * 0.65;
        ctx.strokeStyle = v === 1 ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.35)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(p.x - rr, p.y - rr);
        ctx.lineTo(p.x + rr, p.y + rr);
        ctx.moveTo(p.x - rr, p.y + rr);
        ctx.lineTo(p.x + rr, p.y - rr);
        ctx.stroke();
      }
    }
  }
};

Render.drawHoverAbs = function (ax, ay) {
  const r = cell * 0.42;
  const stroke = toMove === 1 ? 'rgba(40, 40, 40, 0.6)' : 'rgba(220, 220, 220, 0.7)';
  const fill = toMove === 1 ? 'rgba(40, 40, 40, 0.5)' : 'rgba(220, 220, 220, 0.4)';

  ctx.lineWidth = 2;

  // Draw hover at equivalent repeated intersections in a 3x3 tile neighborhood.
  for (let ty = -1; ty <= 1; ty++) {
    for (let tx = -1; tx <= 1; tx++) {
      const px = ax + tx * N;
      const py = ay + ty * N;
      const p = Util.absToScreen(px, py);

      if (p.x < -r || p.x > viewW + r || p.y < -r || p.y > viewH + r) continue;

      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.strokeStyle = stroke;
      ctx.stroke();
    }
  }
};

Render.drawTerritoryAbs = function(leftA, rightA, topA, bottomA) {
  const score = Engine.getScoreResult && Engine.getScoreResult();
  if (!score || !score.ownership) return;

  const x0 = Math.floor(leftA);
  const x1 = Math.ceil(rightA);
  const y0 = Math.floor(topA);
  const y1 = Math.ceil(bottomA);

  const r = cell * 0.45;

  for (let ax = x0; ax <= x1; ax++) {
    for (let ay = y0; ay <= y1; ay++) {
      const { bx, by } = Util.absToBase(ax, ay);
      const owner = score.ownership[by][bx];
      if (owner === 0) continue;

      const p = Util.absToScreen(ax, ay);
      if (p.x < -r || p.x > viewW + r || p.y < -r || p.y > viewH + r) continue;

      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle =
        owner === 1 ? 'rgba(30,30,30,0.18)' : 'rgba(235,235,235,0.22)';
      ctx.fill();
    }
  }
};

