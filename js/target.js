// Target generation, canvas rendering (shared by the print preview and the
// live camera overlay) and vector PDF export.
const Target = (() => {

  // Corner fiducial centers, in grid units — see FIDUCIAL_MARGIN/SIZE in
  // constants.js. Used below to keep shapes clear of the corner markers
  // regardless of how big a given shape is (a fixed cx/cy threshold doesn't
  // work once shapes get big enough to reach a corner from further away).
  const FIDUCIAL_CORNERS = [
    { x: FIDUCIAL_MARGIN, y: FIDUCIAL_MARGIN },
    { x: GRID - FIDUCIAL_MARGIN, y: FIDUCIAL_MARGIN },
    { x: FIDUCIAL_MARGIN, y: GRID - FIDUCIAL_MARGIN },
    { x: GRID - FIDUCIAL_MARGIN, y: GRID - FIDUCIAL_MARGIN },
  ];

  // count = how many shapes were asked for; pageSize picks the physical
  // 5-8cm target size (see shapeRadiusRangeGrid in constants.js) — bigger
  // shapes mean fewer of them can actually fit without overlapping, so this
  // may return fewer than `count` if it runs out of room. That's intentional
  // (silently stopping early beats an infinite/slow retry loop or shapes
  // crammed edge-to-edge); the caller just gets however many actually fit.
  function generateShapes(count, pageSize) {
    const { rMin, rMax } = shapeRadiusRangeGrid(pageSize);
    const shapes = [];
    let attempts = 0;
    while (shapes.length < count && attempts < count * 150) {
      attempts++;
      const r = rand(rMin, rMax);
      const pad = Math.max(12, r * 0.12);
      const cx = rand(r + pad, GRID - r - pad);
      const cy = rand(r + pad, GRID - r - pad);
      // bounding-circle avoidance (with padding) — works for wherever
      // METATAG_ZONE actually is, not just a corner placement
      const nearMeta = cx + r > METATAG_ZONE.x0 - 40 && cx - r < METATAG_ZONE.x1 + 40 && cy + r > METATAG_ZONE.y0 - 40;
      // Distance-to-corner-center test instead of a fixed cx/cy box: a fixed
      // box only kept small shapes clear of the fiducials — a big shape
      // whose center sits outside a small box can still reach into the
      // corner with its edge. FIDUCIAL_SIZE/2 (23 units) is the fiducial's
      // own half-width; the extra 20 is breathing room.
      const nearCorner = FIDUCIAL_CORNERS.some(fc => Math.hypot(cx - fc.x, cy - fc.y) < r + FIDUCIAL_SIZE / 2 + 20);
      const overlap = shapes.some(s => Math.hypot(s.cx - cx, s.cy - cy) < (s.r + r + 16));
      if (nearMeta || nearCorner || overlap) continue;
      shapes.push({
        id: 's' + shapes.length,
        type: choice(SHAPE_TYPES).id,
        color: choice(SHAPE_COLORS).id,
        cx, cy, r,
      });
    }
    // unique shuffled numbers — used by "fast math" drill prompts
    const numbers = Array.from({ length: shapes.length }, (_, i) => i + 1);
    for (let i = numbers.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [numbers[i], numbers[j]] = [numbers[j], numbers[i]];
    }
    shapes.forEach((s, i) => { s.number = numbers[i]; });
    return shapes;
  }

  function equationForNumber(n) {
    if (Math.random() < 0.5) {
      const b = randInt(1, Math.min(9, n + 9));
      const a = n + b;
      return `${a} - ${b}`;
    } else {
      const b = randInt(0, n);
      const a = n - b;
      return `${a} + ${b}`;
    }
  }

  function build(config) {
    const { pageSize, mode, distDesigned, distSimulated, shapeCount } = config;
    return {
      // 16-bit id, printed into the metatag, is how the camera later
      // recognizes WHICH saved target it's looking at — see encodeBits/
      // decodeBits below.
      id: randInt(1, 65535),
      pageSize, mode,
      distDesigned,
      distSimulated: mode === 'DRY' ? distSimulated : distDesigned,
      shapes: generateShapes(clamp(shapeCount, 3, 16), pageSize),
      createdAt: Date.now(),
    };
  }

  // ---- Target Metatag: a real (if simple) identifying code, not just
  // decoration -----------------------------------------------------------
  // 36 bits laid out in a 6x6 grid, row-major:
  //   [0-1]   pageSize   (00=A4, 01=A3, 10=Oficio)
  //   [2]     mode       (0=DRY, 1=LIVE)
  //   [3-6]   distBucket (round(distSimulated), 0-15m — coarse, informational)
  //   [7-22]  targetId   (16 bits — matched against the saved-targets library)
  //   [23-30] checksum   (8 bits — catches a bad optical read before trusting it)
  //   [31-35] sync       (fixed 1,0,1,0,1 — sanity-checked first, cheap reject)
  function bitsFromInt(value, nBits) {
    const arr = [];
    for (let i = nBits - 1; i >= 0; i--) arr.push((value >> i) & 1);
    return arr;
  }
  function intFromBits(bits) {
    let v = 0;
    for (const b of bits) v = (v << 1) | (b & 1);
    return v >>> 0;
  }
  function checksum8(dataValue) {
    // multiplicative hash (Knuth) truncated to a byte — not cryptographic,
    // just enough to reject a misread frame before we act on it.
    let h = Math.imul(dataValue, 2654435761) >>> 0;
    h ^= h >>> 15;
    return h & 0xff;
  }

  function encodeBits(t) {
    const sizeIdx = { A4: 0, A3: 1, OFICIO: 2 }[t.pageSize];
    const modeBit = t.mode === 'LIVE' ? 1 : 0;
    const distBucket = clamp(Math.round(t.distSimulated), 0, 15);
    const id = t.id || 0;
    const dataBits = [
      ...bitsFromInt(sizeIdx, 2),
      modeBit,
      ...bitsFromInt(distBucket, 4),
      ...bitsFromInt(id, 16),
    ]; // 23 bits
    const dataValue = intFromBits(dataBits);
    const checksumBits = bitsFromInt(checksum8(dataValue), 8);
    return [...dataBits, ...checksumBits, 1, 0, 1, 0, 1]; // 36 bits
  }

  function decodeBits(bits) {
    if (!bits || bits.length !== 36) return { valid: false, reason: 'length' };
    const sync = bits.slice(31, 36).join('');
    if (sync !== '10101') return { valid: false, reason: 'sync' };
    const dataBits = bits.slice(0, 23);
    const dataValue = intFromBits(dataBits);
    const checksum = intFromBits(bits.slice(23, 31));
    if (checksum8(dataValue) !== checksum) return { valid: false, reason: 'checksum' };
    const sizeIdx = intFromBits(bits.slice(0, 2));
    const pageSize = ['A4', 'A3', 'OFICIO'][sizeIdx];
    if (!pageSize) return { valid: false, reason: 'pageSize' };
    return {
      valid: true,
      pageSize,
      mode: bits[2] ? 'LIVE' : 'DRY',
      distBucket: intFromBits(bits.slice(3, 7)),
      targetId: intFromBits(bits.slice(7, 23)),
    };
  }

  // kept for the drawing code below, which historically called this name
  function metatagBits(t) {
    return encodeBits(t);
  }

  function drawFiducial(ctx, x, y, s) {
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = '#111';
    ctx.fillRect(-s / 2, -s / 2, s, s);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = s * 0.12;
    ctx.strokeRect(-s / 2 + s * 0.14, -s / 2 + s * 0.14, s - s * 0.28, s - s * 0.28);
    ctx.fillStyle = '#111';
    ctx.fillRect(-s * 0.14, -s * 0.14, s * 0.28, s * 0.28);
    ctx.restore();
  }

  // outline=true draws a stroke-only version (no fill) for overlaying on top
  // of the live camera feed — see drawGrid below for why.
  function drawShape(ctx, shape, scaleX, scaleY, originX, originY, outline) {
    const px = originX + shape.cx * scaleX;
    const py = originY + shape.cy * scaleY;
    const r = shape.r * ((scaleX + scaleY) / 2);
    const c = COLOR_MAP[shape.color].css;
    ctx.save();
    if (outline) {
      ctx.fillStyle = 'transparent';
      ctx.strokeStyle = c;
      ctx.lineWidth = 3;
    } else {
      ctx.fillStyle = c;
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 2;
    }
    if (shape.type === 'circle') {
      ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); if (!outline) ctx.fill(); ctx.stroke();
    } else if (shape.type === 'square') {
      ctx.beginPath(); ctx.rect(px - r * 0.85, py - r * 0.85, r * 1.7, r * 1.7); if (!outline) ctx.fill(); ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.moveTo(px, py - r);
      ctx.lineTo(px + r * 0.95, py + r * 0.8);
      ctx.lineTo(px - r * 0.95, py + r * 0.8);
      ctx.closePath(); if (!outline) ctx.fill(); ctx.stroke();
    }
    if (shape.number !== undefined) {
      const ty = shape.type === 'triangle' ? py + r * 0.18 : py;
      ctx.font = `700 ${Math.max(10, Math.round(r * 0.85))}px 'JetBrains Mono', monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (outline) {
        // small filled badge behind the number so it stays legible over
        // whatever busy real-world background is showing through the
        // now-transparent shape interior.
        const badgeR = Math.max(9, r * 0.32);
        ctx.beginPath(); ctx.arc(px, ty, badgeR, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.fillText(String(shape.number), px, ty);
      } else {
        ctx.lineWidth = Math.max(2, r * 0.12);
        ctx.strokeStyle = 'rgba(0,0,0,.55)';
        ctx.strokeText(String(shape.number), px, ty);
        ctx.fillStyle = '#fff';
        ctx.fillText(String(shape.number), px, ty);
      }
    }
    ctx.restore();
  }

  // Draws the target already-warped-to-grid (the camera/live view case): no
  // paper, no margin — just the 1000x1000 normalized square.
  //
  // `outline`: the live camera overlay used to be a fully opaque fill,
  // which completely hid the real printed target underneath it — you could
  // never actually SEE whether the projected shapes lined up with the real
  // ones on the paper, only trust that they did. That's exactly the kind of
  // thing that hides a residual calibration offset: a hit can visibly land
  // inside the real printed shape but compute to a grid point just outside
  // the (invisible, slightly-off) zone the app is actually checking against
  // — registering as a miss even though you hit the target. Outline mode
  // draws only the shape edges (transparent interior) so the real target
  // photo shows through and any misalignment between "where the app thinks
  // the shape is" and "where it actually is" is visible directly on screen.
  function drawGrid(ctx, w, h, target, alpha, outline) {
    ctx.save();
    if (alpha !== undefined) ctx.globalAlpha = alpha;
    const sx = w / GRID, sy = h / GRID;
    const fid = FIDUCIAL_SIZE * Math.min(sx, sy);
    drawFiducial(ctx, FIDUCIAL_MARGIN * sx, FIDUCIAL_MARGIN * sy, fid);
    drawFiducial(ctx, w - FIDUCIAL_MARGIN * sx, FIDUCIAL_MARGIN * sy, fid);
    drawFiducial(ctx, FIDUCIAL_MARGIN * sx, h - FIDUCIAL_MARGIN * sy, fid);
    drawFiducial(ctx, w - FIDUCIAL_MARGIN * sx, h - FIDUCIAL_MARGIN * sy, fid);
    target.shapes.forEach(s => drawShape(ctx, s, sx, sy, 0, 0, outline));
    ctx.restore();
  }

  // Draws the full printable page: paper, 10mm margin guide, safe canvas with
  // fiducials/shapes/metatag mapped onto it.
  function drawPrintPreview(canvas, target) {
    const spec = PAGE_SPECS[target.pageSize];
    const maxDim = 340;
    const scale = maxDim / Math.max(spec.pageW, spec.pageH);
    const pw = spec.pageW * scale, ph = spec.pageH * scale;
    canvas.width = pw; canvas.height = ph;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--paper').trim() || '#efe9dc';
    ctx.fillRect(0, 0, pw, ph);
    ctx.strokeStyle = 'rgba(0,0,0,.18)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, pw - 1, ph - 1);

    const marginMm = 10;
    const safeX = marginMm * scale, safeY = marginMm * scale;
    const safeW = spec.safeW * scale, safeH = spec.safeH * scale;
    ctx.save();
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = 'rgba(0,0,0,.35)';
    ctx.strokeRect(safeX, safeY, safeW, safeH);
    ctx.restore();

    const sx = safeW / GRID, sy = safeH / GRID;
    const fid = FIDUCIAL_SIZE * Math.min(sx, sy);
    const fm = FIDUCIAL_MARGIN;
    drawFiducial(ctx, safeX + fm * sx, safeY + fm * sy, fid);
    drawFiducial(ctx, safeX + safeW - fm * sx, safeY + fm * sy, fid);
    drawFiducial(ctx, safeX + fm * sx, safeY + safeH - fm * sy, fid);
    drawFiducial(ctx, safeX + safeW - fm * sx, safeY + safeH - fm * sy, fid);

    target.shapes.forEach(s => drawShape(ctx, s, sx, sy, safeX, safeY));

    const bits = metatagBits(target);
    const mz = METATAG_ZONE;
    const zx = safeX + mz.x0 * sx, zy = safeY + mz.y0 * sy;
    const zw = (mz.x1 - mz.x0) * sx, zh = (mz.y1 - mz.y0) * sy;
    ctx.fillStyle = '#111';
    ctx.fillRect(zx, zy, zw, zh);
    const cell = zw / 6;
    for (let row = 0; row < 6; row++) {
      for (let col = 0; col < 6; col++) {
        ctx.fillStyle = bits[row * 6 + col] ? '#fff' : '#111';
        ctx.fillRect(zx + col * cell + 1, zy + row * (zh / 6) + 1, cell - 2, (zh / 6) - 2);
      }
    }
    // Human-readable fallback: if the camera ever can't read the metatag
    // (bad light, damaged sheet), the shooter can just read this number off
    // the paper and pick the matching saved target by ID instead.
    ctx.fillStyle = 'rgba(0,0,0,.55)';
    ctx.font = `${Math.max(9, zh * 0.11)}px monospace`;
    ctx.textAlign = 'center';
    ctx.fillText(`ID ${target.id}`, zx + zw / 2, zy + zh + Math.max(11, zh * 0.14));
  }

  function toJson(t) {
    const spec = PAGE_SPECS[t.pageSize];
    return {
      metatag: {
        targetId: t.id,
        pageSize: t.pageSize,
        safeCanvasMm: { w: spec.safeW, h: spec.safeH },
        mode: t.mode,
        designedDistanceM: t.distDesigned,
        simulatedDistanceM: t.mode === 'DRY' ? t.distSimulated : null,
      },
      grid: '1000x1000 normalized (post-homography)',
      zones: t.shapes.map(s => ({
        id: s.id, type: s.type, color: s.color, number: s.number,
        center: [Math.round(s.cx), Math.round(s.cy)],
        radius: Math.round(s.r),
      })),
    };
  }

  // Real vector PDF export (jsPDF) at true physical scale — this is the file
  // you actually print. mm units throughout, matches drawPrintPreview 1:1.
  function exportPdf(target) {
    if (!window.jspdf) {
      alert('jsPDF no cargó (sin conexión a internet). Conectate a internet y volvé a intentar — la app funciona offline salvo esta librería.');
      return;
    }
    const { jsPDF } = window.jspdf;
    const spec = PAGE_SPECS[target.pageSize];
    const doc = new jsPDF({ unit: 'mm', format: [spec.pageW, spec.pageH], orientation: spec.pageH >= spec.pageW ? 'portrait' : 'landscape' });

    const marginMm = 10;
    const safeX = marginMm, safeY = marginMm;
    const sx = spec.safeW / GRID, sy = spec.safeH / GRID;

    doc.setDrawColor(120); doc.setLineDashPattern([1.2, 1], 0);
    doc.rect(safeX, safeY, spec.safeW, spec.safeH);
    doc.setLineDashPattern([], 0);

    function fiducialPdf(x, y, s) {
      doc.setFillColor(17, 17, 17);
      doc.rect(x - s / 2, y - s / 2, s, s, 'F');
      doc.setFillColor(255, 255, 255);
      doc.rect(x - s / 2 + s * 0.14, y - s / 2 + s * 0.14, s - s * 0.28, s - s * 0.28, 'F');
      doc.setFillColor(17, 17, 17);
      doc.rect(x - s * 0.14, y - s * 0.14, s * 0.28, s * 0.28, 'F');
    }
    const fid = FIDUCIAL_SIZE * Math.min(sx, sy);
    const fm = FIDUCIAL_MARGIN;
    fiducialPdf(safeX + fm * sx, safeY + fm * sy, fid);
    fiducialPdf(safeX + spec.safeW - fm * sx, safeY + fm * sy, fid);
    fiducialPdf(safeX + fm * sx, safeY + spec.safeH - fm * sy, fid);
    fiducialPdf(safeX + spec.safeW - fm * sx, safeY + spec.safeH - fm * sy, fid);

    const colorRgb = {
      red: [229, 72, 77], blue: [74, 159, 224], yellow: [244, 196, 48], green: [69, 178, 107],
    };
    target.shapes.forEach(s => {
      const px = safeX + s.cx * sx, py = safeY + s.cy * sy;
      const r = s.r * ((sx + sy) / 2);
      const rgb = colorRgb[s.color];
      doc.setFillColor(rgb[0], rgb[1], rgb[2]);
      if (s.type === 'circle') {
        doc.circle(px, py, r, 'F');
      } else if (s.type === 'square') {
        doc.rect(px - r * 0.85, py - r * 0.85, r * 1.7, r * 1.7, 'F');
      } else {
        doc.triangle(px, py - r, px + r * 0.95, py + r * 0.8, px - r * 0.95, py + r * 0.8, 'F');
      }
      doc.setFontSize(r * 1.6);
      doc.setTextColor(255, 255, 255);
      doc.text(String(s.number), px, py + r * 0.12, { align: 'center' });
    });

    const bits = metatagBits(target);
    const mz = METATAG_ZONE;
    const zx = safeX + mz.x0 * sx, zy = safeY + mz.y0 * sy;
    const zw = (mz.x1 - mz.x0) * sx, zh = (mz.y1 - mz.y0) * sy;
    doc.setFillColor(17, 17, 17);
    doc.rect(zx, zy, zw, zh, 'F');
    const cell = zw / 6;
    for (let row = 0; row < 6; row++) {
      for (let col = 0; col < 6; col++) {
        if (bits[row * 6 + col]) {
          doc.setFillColor(255, 255, 255);
          doc.rect(zx + col * cell, zy + row * (zh / 6), cell, zh / 6, 'F');
        }
      }
    }
    // Same human-readable fallback ID as the on-screen preview.
    doc.setFontSize(8);
    doc.setTextColor(90);
    doc.text(`ID ${target.id}`, zx + zw / 2, zy + zh + 4, { align: 'center' });

    doc.setFontSize(7);
    doc.setTextColor(140);
    doc.text(`TargetMind · ${spec.label} · ${target.mode} · dist. ${target.mode === 'DRY' ? target.distSimulated + 'm sim (' + target.distDesigned + 'm real)' : target.distDesigned + 'm'}`, spec.pageW / 2, spec.pageH - 4, { align: 'center' });

    doc.save(`targetmind_${target.pageSize.toLowerCase()}_${target.mode.toLowerCase()}.pdf`);
  }

  return {
    generateShapes, equationForNumber, build, metatagBits, encodeBits, decodeBits,
    drawFiducial, drawShape, drawGrid, drawPrintPreview, toJson, exportPdf,
  };
})();
