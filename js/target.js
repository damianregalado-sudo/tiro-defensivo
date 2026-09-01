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
  function generateShapes(count, pageSize, includeQr) {
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
      // Same avoidance, but only when this target actually carries the
      // "compartir blanco" QR (build .18) — no point reserving the space
      // for shapes to dodge a block that won't be drawn.
      const nearQr = includeQr && cx + r > QR_ZONE.x0 - 40 && cx - r < QR_ZONE.x1 + 40 && cy + r > QR_ZONE.y0 - 40;
      // Distance-to-corner-center test instead of a fixed cx/cy box: a fixed
      // box only kept small shapes clear of the fiducials — a big shape
      // whose center sits outside a small box can still reach into the
      // corner with its edge. FIDUCIAL_SIZE/2 (23 units) is the fiducial's
      // own half-width; the extra 20 is breathing room.
      const nearCorner = FIDUCIAL_CORNERS.some(fc => Math.hypot(cx - fc.x, cy - fc.y) < r + FIDUCIAL_SIZE / 2 + 20);
      const overlap = shapes.some(s => Math.hypot(s.cx - cx, s.cy - cy) < (s.r + r + 16));
      if (nearMeta || nearQr || nearCorner || overlap) continue;
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
    const { pageSize, mode, distDesigned, distSimulated, shapeCount, family, includeQr } = config;
    const fam = family === 'ipsc' ? 'ipsc' : 'reaction';
    return {
      // 16-bit id, printed into the metatag, is how the camera later
      // recognizes WHICH saved target it's looking at — see encodeBits/
      // decodeBits below.
      id: randInt(1, 65535),
      pageSize, mode, family: fam,
      distDesigned,
      distSimulated: mode === 'DRY' ? distSimulated : distDesigned,
      // Solo la familia "reacción" sortea figuras — "puntería" usa la
      // silueta/zonas A/C/D fijas definidas en constants.js (ver
      // drawIpscSilhouette/zoneAt más abajo), así que no necesita nada acá.
      shapes: fam === 'reaction' ? generateShapes(clamp(shapeCount, 3, 16), pageSize, !!includeQr) : [],
      // Build .18: si el generador tenía tildado "Incluir código QR", este
      // blanco lleva además un bloque QR impreso (ver encodeShareCode/
      // qrPhysicalBox más abajo) — un enlace que, escaneado con la cámara
      // normal del teléfono (no la de esta app), abre el navegador con este
      // blanco YA cargado y guardado, aunque ese celular nunca lo haya
      // generado. Se guarda en el propio blanco (no solo en el momento de
      // generarlo) para que "Re-tirar figuras" y el reimport sepan si deben
      // seguir reservando/dibujando ese espacio.
      qr: !!includeQr,
      createdAt: Date.now(),
    };
  }

  // ---- Compartir blanco (código QR / enlace) — build .18 --------------------
  // Distinto del código óptico de 36 bits (metatagBits/encodeBits/decodeBits
  // más abajo): ESE código solo sirve para RECONOCER un blanco que la app ya
  // tiene guardado en ESTE dispositivo (la cámara lo lee y busca el ID en
  // "Blancos guardados" — si no está ahí, no sirve de nada). Este código en
  // cambio lleva la geometría COMPLETA adentro, así que funciona en un
  // celular que nunca generó ni guardó este blanco — el caso de alguien que
  // compra un blanco ya impreso. Para la familia "reacción" eso incluye las
  // figuras exactas (son aleatorias, no hay otra forma de reproducirlas); la
  // familia "puntería" no necesita mandarlas porque su silueta es siempre la
  // misma (ver constants.js).
  //
  // Formato compacto (no JSON) para que entre cómodo en un QR chico y
  // confiable de escanear: campos separados por "~", y — solo en "reacción"
  // — un campo final con las figuras separadas por ";", cada una
  // "tipoIdx,colorIdx,cx,cy,r,número" separada por ",". El resultado se
  // codifica en base64url (variante segura para URL de base64) para viajar
  // como fragmento de URL (#t=...) sin necesitar escapar nada.
  const SHARE_VERSION = '1';
  function encodeShareCode(t) {
    const parts = [
      SHARE_VERSION,
      t.family === 'ipsc' ? 'i' : 'r',
      t.id,
      t.pageSize,
      t.mode,
      t.distDesigned,
      t.distSimulated,
    ];
    let s = parts.join('~');
    if (t.family !== 'ipsc') {
      s += '~' + t.shapes.map(sh => {
        const typeIdx = SHAPE_TYPES.findIndex(x => x.id === sh.type);
        const colorIdx = SHAPE_COLORS.findIndex(x => x.id === sh.color);
        return [typeIdx, colorIdx, Math.round(sh.cx), Math.round(sh.cy), Math.round(sh.r), sh.number].join(',');
      }).join(';');
    }
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // Devuelve un blanco completo (mismo shape que Target.build() produce) o
  // null si el código está roto/truncado/es de una versión futura — nunca
  // tira una excepción hacia afuera, para que el que llama solo tenga que
  // chequear "¿vino null?" en vez de armar un try/catch propio.
  function decodeShareCode(code) {
    try {
      let b64 = String(code).replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      const parts = atob(b64).split('~');
      if (parts[0] !== SHARE_VERSION) return null;
      const [, famChar, idStr, pageSize, mode, distDesignedStr, distSimulatedStr, shapeStr] = parts;
      if (!PAGE_SPECS[pageSize]) return null;
      if (mode !== 'DRY' && mode !== 'LIVE') return null;
      const id = parseInt(idStr, 10);
      if (!Number.isFinite(id) || id < 1 || id > 65535) return null;
      const distDesigned = parseFloat(distDesignedStr);
      const distSimulated = parseFloat(distSimulatedStr);
      if (!Number.isFinite(distDesigned) || !Number.isFinite(distSimulated)) return null;
      const family = famChar === 'i' ? 'ipsc' : 'reaction';
      let shapes = [];
      if (family === 'reaction') {
        if (!shapeStr) return null;
        shapes = shapeStr.split(';').filter(Boolean).map((chunk, i) => {
          const [typeIdx, colorIdx, cx, cy, r, number] = chunk.split(',').map(Number);
          const type = SHAPE_TYPES[typeIdx], color = SHAPE_COLORS[colorIdx];
          if (!type || !color || !Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(r)) {
            throw new Error('figura inválida en el código');
          }
          return { id: 's' + i, type: type.id, color: color.id, cx, cy, r, number };
        });
        if (!shapes.length) return null;
      }
      return { id, pageSize, mode, family, distDesigned, distSimulated, shapes, qr: true, createdAt: Date.now() };
    } catch (e) {
      return null;
    }
  }

  // location.origin+pathname (sin query ni hash) + el código como fragmento
  // — así el mismo enlace sirve sin importar en qué carpeta/dominio esté
  // desplegada esta copia de la app (GitHub Pages del comprador, un
  // dominio propio, etc.), y abrirlo no dispara ninguna carga de red extra
  // (el fragmento nunca viaja al servidor).
  function buildShareUrl(t) {
    return location.origin + location.pathname + '#t=' + encodeShareCode(t);
  }

  // Matriz de módulos (true = oscuro) de un QR que codifica `url`, usando la
  // librería vendoreada qrcode-generator (Kazuhiko Arase, MIT — ver
  // index.html). null si la librería no llegó a cargar (sin conexión la
  // primera vez, CDN caído) — quien dibuja debe animarse a mostrar un
  // aviso en ese caso en vez de dejar un hueco en blanco sin explicación.
  // typeNumber=0 dej que la librería elija automáticamente el tamaño de QR
  // más chico que entra el contenido — el string crece con la cantidad de
  // figuras, así que un blanco con pocas figuras saca un QR más chico
  // (más fácil de escanear) que uno con muchas.
  function computeQrModules(url) {
    if (typeof qrcode !== 'function') return null;
    try {
      const qr = qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      const n = qr.getModuleCount();
      const modules = [];
      for (let r = 0; r < n; r++) {
        const row = [];
        for (let c = 0; c < n; c++) row.push(qr.isDark(r, c));
        modules.push(row);
      }
      return modules;
    } catch (e) {
      return null;
    }
  }

  // El QR tiene que ser físicamente CUADRADO — pero QR_ZONE está en
  // unidades de grilla, y sx/sy (unidades de grilla → mm o px de canvas)
  // son DISTINTOS en un papel no cuadrado (A4: 190×277mm de área segura),
  // así que el rectángulo que resulta de escalar QR_ZONE tal cual no es
  // cuadrado. Esta función inscribe el cuadrado más grande posible,
  // centrado, dentro de ese rectángulo — funciona igual para el canvas
  // (sx/sy en px/unidad) que para el PDF (sx/sy en mm/unidad), mismo
  // patrón que el resto de este archivo usa para reusar geometría entre
  // ambos.
  function qrPhysicalBox(sx, sy, originX, originY) {
    const z = QR_ZONE;
    const rectX = originX + z.x0 * sx, rectY = originY + z.y0 * sy;
    const rectW = (z.x1 - z.x0) * sx, rectH = (z.y1 - z.y0) * sy;
    const size = Math.min(rectW, rectH);
    return { x: rectX + (rectW - size) / 2, y: rectY + (rectH - size) / 2, size };
  }

  function drawQrCanvas(ctx, target, box) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(box.x, box.y, box.size, box.size);
    const modules = computeQrModules(buildShareUrl(target));
    if (!modules) {
      ctx.strokeStyle = '#c00'; ctx.lineWidth = Math.max(1, box.size * 0.01);
      ctx.strokeRect(box.x + 1, box.y + 1, box.size - 2, box.size - 2);
      ctx.fillStyle = '#c00';
      ctx.font = `${Math.max(8, box.size * 0.09)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText('QR no', box.x + box.size / 2, box.y + box.size / 2 - 4);
      ctx.fillText('disponible', box.x + box.size / 2, box.y + box.size / 2 + 10);
      return;
    }
    // "quiet zone": margen en blanco alrededor de los módulos, requerido
    // por el estándar QR — sin esto, un escáner puede confundir el borde
    // del código con el resto del dibujo del blanco y fallar la lectura.
    const n = modules.length, quiet = 4;
    const cell = box.size / (n + quiet * 2);
    ctx.fillStyle = '#111';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (modules[r][c]) ctx.fillRect(box.x + (c + quiet) * cell, box.y + (r + quiet) * cell, cell + 0.5, cell + 0.5);
      }
    }
  }

  function drawQrPdf(doc, target, box) {
    doc.setFillColor(255, 255, 255);
    doc.rect(box.x, box.y, box.size, box.size, 'F');
    const modules = computeQrModules(buildShareUrl(target));
    if (!modules) {
      doc.setDrawColor(200, 0, 0);
      doc.rect(box.x, box.y, box.size, box.size, 'D');
      doc.setFontSize(7);
      doc.setTextColor(200, 0, 0);
      doc.text('QR no disponible (sin conexión al exportar)', box.x + box.size / 2, box.y + box.size / 2, { align: 'center', maxWidth: box.size - 2 });
      return;
    }
    const n = modules.length, quiet = 4;
    const cell = box.size / (n + quiet * 2);
    doc.setFillColor(17, 17, 17);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (modules[r][c]) doc.rect(box.x + (c + quiet) * cell, box.y + (r + quiet) * cell, cell, cell, 'F');
      }
    }
  }

  // ---- Puntería (estilo IPSC): geometría fija + hit-test de zonas ---------
  // Los cuadros de zona (A/C, torso y cabeza) son rectángulos con las
  // esquinas redondeadas SOLO para dibujarlos — el hit-test usa el
  // rectángulo completo (sin redondear), una simplificación deliberada: el
  // radio de esquina es chico comparado con el cuadro, así que la
  // diferencia práctica en el borde es mínima.
  function pointInRect(x, y, r) {
    return Math.abs(x - r.cx) <= r.w / 2 && Math.abs(y - r.cy) <= r.h / 2;
  }
  function pointInCircle(x, y, c) {
    return (x - c.cx) * (x - c.cx) + (y - c.cy) * (y - c.cy) <= c.r * c.r;
  }
  function pointInPolygon(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
      const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }
  // Devuelve 'A' | 'C' | 'D' | null (null = fuera del blanco por completo).
  // La cabeza tiene su propia sub-zona A (el cuadro chico) y cuenta como 'C'
  // si el disparo cayó en el círculo de la cabeza pero fuera de ese cuadro —
  // no hay una zona D separada para la cabeza en esta versión (simplificación
  // deliberada: un blanco real de competencia sí la tiene, pero no encontré
  // una medida oficial publicada para copiarla).
  function zoneAt(gx, gy) {
    if (pointInRect(gx, gy, IPSC_HEAD_ZONE_A)) return 'A';
    if (pointInCircle(gx, gy, IPSC_HEAD)) return 'C';
    if (pointInRect(gx, gy, IPSC_ZONE_A)) return 'A';
    if (pointInRect(gx, gy, IPSC_ZONE_C)) return 'C';
    if (pointInPolygon(gx, gy, IPSC_TORSO_POLY)) return 'D';
    return null;
  }

  // sx/sy/originX/originY: same convention as drawShape — scale from grid
  // units to canvas pixels, plus an origin offset (0,0 for the live/warped
  // view, safeX/safeY for the print-preview canvas). outline=true draws
  // stroke-only (silueta transparente) for overlaying on the live camera
  // feed, same rationale as drawShape's outline mode.
  function drawIpscSilhouette(ctx, sx, sy, originX, originY, outline) {
    const toPx = (gx, gy) => [originX + gx * sx, originY + gy * sy];
    const scale = (sx + sy) / 2;
    ctx.save();
    ctx.beginPath();
    IPSC_TORSO_POLY.forEach((p, i) => {
      const [px, py] = toPx(p.x, p.y);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    ctx.closePath();
    const [hx, hy] = toPx(IPSC_HEAD.cx, IPSC_HEAD.cy);
    const headR = IPSC_HEAD.r * scale;
    if (outline) {
      ctx.fillStyle = 'transparent';
      ctx.strokeStyle = '#ff7a1a';
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.beginPath(); ctx.arc(hx, hy, headR, 0, Math.PI * 2); ctx.stroke();
    } else {
      ctx.fillStyle = '#c9a876';
      ctx.strokeStyle = '#3a3126';
      ctx.lineWidth = 2;
      ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.arc(hx, hy, headR, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    // Líneas de zona A/C — punteadas, siempre visibles (aun en modo outline)
    // para que el tirador vea contra qué zona se está evaluando cada
    // disparo mientras entrena. Un blanco real de competencia no siempre
    // las muestra así, pero para entrenar es más útil verlas.
    const drawZoneRect = (r, dash, color) => {
      const [rx, ry] = toPx(r.cx - r.w / 2, r.cy - r.h / 2);
      const w = r.w * sx, h = r.h * sy, rad = r.r * scale;
      ctx.save();
      ctx.setLineDash(dash);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(rx, ry, w, h, rad);
      else ctx.rect(rx, ry, w, h); // fallback si el navegador no soporta roundRect
      ctx.stroke();
      ctx.restore();
    };
    const zoneLineColor = outline ? 'rgba(255,255,255,.55)' : 'rgba(0,0,0,.4)';
    const zoneLineColorA = outline ? 'rgba(255,255,255,.8)' : 'rgba(0,0,0,.6)';
    drawZoneRect(IPSC_ZONE_C, [6, 4], zoneLineColor);
    drawZoneRect(IPSC_ZONE_A, [3, 3], zoneLineColorA);
    drawZoneRect(IPSC_HEAD_ZONE_A, [3, 3], zoneLineColorA);
    ctx.restore();
  }

  function ipscPdf(doc, safeX, safeY, sx, sy) {
    const toXY = (gx, gy) => [safeX + gx * sx, safeY + gy * sy];
    const scale = (sx + sy) / 2;
    const pts = IPSC_TORSO_POLY.map(p => toXY(p.x, p.y));
    const deltas = [];
    for (let i = 1; i < pts.length; i++) deltas.push([pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]]);
    doc.setFillColor(201, 168, 118);
    doc.setDrawColor(58, 49, 38);
    doc.lines(deltas, pts[0][0], pts[0][1], [1, 1], 'FD', true);
    const [hx, hy] = toXY(IPSC_HEAD.cx, IPSC_HEAD.cy);
    doc.circle(hx, hy, IPSC_HEAD.r * scale, 'FD');
    doc.setDrawColor(120);
    const drawRect = (r, dash) => {
      doc.setLineDashPattern(dash, 0);
      doc.roundedRect(safeX + (r.cx - r.w / 2) * sx, safeY + (r.cy - r.h / 2) * sy, r.w * sx, r.h * sy, r.r * scale, r.r * scale, 'D');
    };
    drawRect(IPSC_ZONE_C, [3, 2]);
    drawRect(IPSC_ZONE_A, [1.5, 1.5]);
    drawRect(IPSC_HEAD_ZONE_A, [1.5, 1.5]);
    doc.setLineDashPattern([], 0);
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
    if (target.family === 'ipsc') {
      drawIpscSilhouette(ctx, sx, sy, 0, 0, outline);
    } else {
      target.shapes.forEach(s => drawShape(ctx, s, sx, sy, 0, 0, outline));
    }
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

    if (target.family === 'ipsc') {
      drawIpscSilhouette(ctx, sx, sy, safeX, safeY, false);
    } else {
      target.shapes.forEach(s => drawShape(ctx, s, sx, sy, safeX, safeY));
    }

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

    // QR "compartir blanco" (build .18) — solo si este blanco lo tiene
    // habilitado. Ver qrPhysicalBox() para por qué no es simplemente
    // QR_ZONE escalado tal cual.
    if (target.qr) {
      const box = qrPhysicalBox(sx, sy, safeX, safeY);
      drawQrCanvas(ctx, target, box);
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      ctx.font = `${Math.max(8, box.size * 0.085)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText('Escaneá para vincular', box.x + box.size / 2, box.y + box.size + Math.max(10, box.size * 0.11));
    }
  }

  function toJson(t) {
    const spec = PAGE_SPECS[t.pageSize];
    const base = {
      metatag: {
        targetId: t.id,
        pageSize: t.pageSize,
        safeCanvasMm: { w: spec.safeW, h: spec.safeH },
        mode: t.mode,
        designedDistanceM: t.distDesigned,
        simulatedDistanceM: t.mode === 'DRY' ? t.distSimulated : null,
      },
      grid: '1000x1000 normalized (post-homography)',
    };
    if (t.family === 'ipsc') {
      base.targetType = 'puntería (silueta con zonas A/C/D, estilo competencia — no es un blanco oficial licenciado)';
      base.zones = { head: IPSC_HEAD, headZoneA: IPSC_HEAD_ZONE_A, zoneA: IPSC_ZONE_A, zoneC: IPSC_ZONE_C, silhouette: IPSC_TORSO_POLY };
    } else {
      base.targetType = 'reacción (formas/colores/números)';
      base.zones = t.shapes.map(s => ({
        id: s.id, type: s.type, color: s.color, number: s.number,
        center: [Math.round(s.cx), Math.round(s.cy)],
        radius: Math.round(s.r),
      }));
    }
    return base;
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

    if (target.family === 'ipsc') {
      ipscPdf(doc, safeX, safeY, sx, sy);
    } else {
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
    }

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

    if (target.qr) {
      const box = qrPhysicalBox(sx, sy, safeX, safeY);
      drawQrPdf(doc, target, box);
      doc.setFontSize(7);
      doc.setTextColor(90);
      doc.text('Escaneá para vincular', box.x + box.size / 2, box.y + box.size + 4, { align: 'center' });
    }

    doc.setFontSize(7);
    doc.setTextColor(140);
    doc.text(`Entrena Tiro · ${spec.label} · ${target.mode === 'DRY' ? 'FUEGO SECO' : 'FUEGO REAL'} · dist. ${target.mode === 'DRY' ? target.distSimulated + 'm sim (' + target.distDesigned + 'm real)' : target.distDesigned + 'm'}`, spec.pageW / 2, spec.pageH - 4, { align: 'center' });

    doc.save(`entrenatiro_${target.pageSize.toLowerCase()}_${target.mode.toLowerCase()}.pdf`);
  }

  return {
    generateShapes, equationForNumber, build, metatagBits, encodeBits, decodeBits,
    drawFiducial, drawShape, drawGrid, drawPrintPreview, toJson, exportPdf,
    zoneAt, drawIpscSilhouette,
    encodeShareCode, decodeShareCode, buildShareUrl,
  };
})();
