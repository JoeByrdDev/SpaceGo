window.Render = window.Render || {};

Render.requestRender = function() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    Render.drawOnce();
  });
}

Render.drawOnce = function() {
  // Background
  ctx.clearRect(0, 0, viewW, viewH);
  ctx.fillStyle = '#475770';
  ctx.fillRect(0, 0, viewW, viewH);

  // Visible world bounds in grid units
  const left = camWX - (viewW / 2 + margin) / cell;
  const right = camWX + (viewW / 2 + margin) / cell;
  const top = camWY - (viewH / 2 + margin) / cell;
  const bottom = camWY + (viewH / 2 + margin) / cell;

  Render.drawGrid(left, right, top, bottom);
  Render.drawStones(left, right, top, bottom);

  // Hover indicator, repeated like stones (cheap 3x3)
  if (mouse.over) Render.drawHover(mouse.over.gx, mouse.over.gy);

  // Subtle center crosshair
  ctx.strokeStyle = 'rgba(233,238,245,0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(viewW / 2 - 10, viewH / 2);
  ctx.lineTo(viewW / 2 + 10, viewH / 2);
  ctx.moveTo(viewW / 2, viewH / 2 - 10);
  ctx.lineTo(viewW / 2, viewH / 2 + 10);
  ctx.stroke();
}

Render.drawGrid = function(left, right, top, bottom) {
  const x0 = Math.floor(left);
  const x1 = Math.ceil(right);
  const y0 = Math.floor(top);
  const y1 = Math.ceil(bottom);

  // Regular grid
  ctx.strokeStyle = 'rgba(233,238,245,0.12)';
  ctx.lineWidth = 1;

  // Vertical regular lines
  ctx.beginPath();
  for (let gx = x0; gx <= x1; gx++) {
    if (gx % N === 0) continue; // seam lines drawn thicker below
    const p1 = Util.worldToScreen(gx, y0);
    const p2 = Util.worldToScreen(gx, y1);
    if (p1.x < -margin || p1.x > viewW + margin) continue;
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
  }
  ctx.stroke();

  // Horizontal regular lines
  ctx.beginPath();
  for (let gy = y0; gy <= y1; gy++) {
    if (gy % N === 0) continue;
    const p1 = Util.worldToScreen(x0, gy);
    const p2 = Util.worldToScreen(x1, gy);
    if (p1.y < -margin || p1.y > viewH + margin) continue;
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
  }
  ctx.stroke();

  // Tile seam lines (repeat edges / "real board edges")
  ctx.strokeStyle = 'rgba(233,238,245,0.22)';
  ctx.lineWidth = 2;

  // Vertical seams at gx ≡ 0 (mod N)
  ctx.beginPath();
  // find first multiple of N >= x0
  let gx0 = x0 - ((x0 % N) + N) % N;
  for (let gx = gx0; gx <= x1; gx += N) {
    const p1 = Util.worldToScreen(gx, y0);
    const p2 = Util.worldToScreen(gx, y1);
    if (p1.x < -margin || p1.x > viewW + margin) continue;
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
  }
  ctx.stroke();

  // Horizontal seams at gy ≡ 0 (mod N)
  ctx.beginPath();
  let gy0 = y0 - ((y0 % N) + N) % N;
  for (let gy = gy0; gy <= y1; gy += N) {
    const p1 = Util.worldToScreen(x0, gy);
    const p2 = Util.worldToScreen(x1, gy);
    if (p1.y < -margin || p1.y > viewH + margin) continue;
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
  }
  ctx.stroke();
}

Render.drawStones = function(left, right, top, bottom) {
  const x0 = Math.floor(left);
  const x1 = Math.ceil(right);
  const y0 = Math.floor(top);
  const y1 = Math.ceil(bottom);

  const r = cell * 0.43;
  for (let gx = x0; gx <= x1; gx++) {
    const bx = Util.wrap(gx);
    for (let gy = y0; gy <= y1; gy++) {
      const by = Util.wrap(gy);
      const v = board[by][bx];
      if (v === 0) continue;

      const p = Util.worldToScreen(gx, gy);
      if (p.x < -r || p.x > viewW + r || p.y < -r || p.y > viewH + r) continue;

      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = v === 1 ? '#0a0b0d' : '#f2f5f9';
      ctx.fill();

      const hl = ctx.createRadialGradient(p.x - r * 0.35, p.y - r * 0.35, r * 0.1, p.x, p.y, r);
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

      ctx.strokeStyle = v === 1 ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.12)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
}

Render.drawHover = function(gx, gy) {
  const r = cell * 0.42;

  const stroke = toMove === 1 ? 'rgba(40, 40, 40, 0.6)' : 'rgba(220, 220, 220, 0.7)';
  const fill = toMove === 1 ? 'rgba(40, 40, 40, 0.5)' : 'rgba(220, 220, 220, 0.4)';

  ctx.lineWidth = 2;

  for (let ty = -1; ty <= 1; ty++) {
    for (let tx = -1; tx <= 1; tx++) {
      const px = gx + tx * N;
      const py = gy + ty * N;
      const p = Util.worldToScreen(px, py);

      if (p.x < -r || p.x > viewW + r || p.y < -r || p.y > viewH + r) continue;

      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.strokeStyle = stroke;
      ctx.stroke();
    }
  }
}