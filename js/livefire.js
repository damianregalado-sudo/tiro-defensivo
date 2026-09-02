/*
  LiveFire — real-scale (1:1) range mode. Detects new bullet holes by
  differencing the current warped frame against a reference frame captured
  when the group starts, masking out already-registered holes ("virtual
  patching" — old holes don't re-trigger). Same manual-tap fallback as dry
  fire, since frame-diff hole detection is the single hardest part of this
  whole pipeline to get right without a live range to tune it on.
*/
const LiveFire = (() => {
  let target = null;
  let cameraOn = false;
  let referenceGray = null;
  let shots = []; // {px,py} in warp-canvas pixel space
  // Solo se usa cuando target.family==='ipsc' — tally de en qué zona (A/C/D)
  // cayó cada impacto detectado, además del cálculo de MOA/agrupamiento que
  // ya corre igual para cualquier familia de blanco (ver currentMoaStats).
  let zoneTally = null;
  let holeCandidate = null; // {gx,gy,count} — requires N stable frames before committing
  let ignoreCanvas = null, ignoreCtx = null;
  let currentFrameMat = null;

  // Same auto-recognition as dry fire — see drill.js for the rationale.
  // Only runs before a group is started (referenceGray null): once a group
  // is underway the target must not change under the shooter's feet.
  const RECOGNIZE_BUDGET = 45;
  let recognizeAttempts = 0;
  let recognizeDone = false;

  // app.js has its own escapeHtml, but it's private to App's closure and
  // livefire.js loads before app.js anyway — small local copy rather than
  // exposing a new global just for this one label.
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function ensureScope() {
    target = App.currentTarget();
    if (!target) return;
    $('#liveEmpty').style.display = 'none';
    $('#liveSide').style.display = 'flex';
    shots = []; referenceGray = null; holeCandidate = null;
    zoneTally = target.family === 'ipsc' ? { A: 0, C: 0, D: 0, miss: 0 } : null;
    $('#liveStatsReaction').style.display = target.family === 'ipsc' ? 'none' : '';
    $('#liveStatsIpsc').style.display = target.family === 'ipsc' ? '' : 'none';
    const wrap = $('#liveScopeWrap');
    wrap.innerHTML = `
      <div class="scope-hud">
        <span class="pill" id="liveHudCam">CÁMARA: APAGADA</span>
        <span class="pill mono" id="liveHudTarget">${target.pageSize} · 1:1 · #${target.id}</span>
        <span class="pill" id="liveRecogState" style="display:none;"></span>
        <button class="pill" id="liveTorchBtn" style="display:none;cursor:pointer;border:1px solid var(--border);background:none;pointer-events:auto;">🔦 Flash</button>
        <select class="pill" id="liveTargetPicker" style="cursor:pointer;pointer-events:auto;"></select>
      </div>
      <video id="liveVideo" autoplay playsinline muted style="display:none;"></video>
      <div style="position:relative; display:none;" id="liveSearchWrap">
        <canvas id="liveSearchPreview" class="overlay" style="position:static; cursor:default;"></canvas>
        <canvas id="liveSearchGuide" class="overlay" style="top:0; left:0;"></canvas>
      </div>
      <div style="position:relative; display:none;" id="liveLockedWrap">
        <canvas id="liveOverlay" class="overlay"></canvas>
      </div>
      <div class="empty-hint" id="liveCamHint">
        <span class="big">📷</span>
        Activá la cámara apuntando al blanco impreso en el rango.
      </div>
      <div class="zoom-ctrl" id="liveZoomCtrl" style="display:none;">
        <button class="zoom-btn" id="liveZoomOut">－</button>
        <input type="range" id="liveZoomSlider" min="1" max="4" step="0.25" value="1">
        <button class="zoom-btn" id="liveZoomIn">＋</button>
        <span class="zoom-val" id="liveZoomVal">1.0×</span>
      </div>
    `;
    // Set the warp destination's aspect ratio to match THIS target's actual
    // (non-square) page size before sizing anything off Vision.WARP_W/H —
    // see the WARP_W/WARP_H comment in vision.js. Also passed into
    // Vision.lock() below in case it changes again before then, but doing it
    // here too means ignoreCanvas (sized right after) already matches.
    Vision.setPageAspect(target.pageSize);
    ignoreCanvas = document.createElement('canvas');
    ignoreCanvas.width = Vision.WARP_W; ignoreCanvas.height = Vision.WARP_H;
    ignoreCtx = ignoreCanvas.getContext('2d');
    ignoreCtx.fillStyle = '#000'; ignoreCtx.fillRect(0, 0, ignoreCanvas.width, ignoreCanvas.height);
    updateStats();
    wireZoomControls('live');
    populateTargetPicker();
    // Also refresh the option list right as the shooter opens the dropdown
    // (not just once at ensureScope time) — a target saved from the
    // Generador de Blanco tab AFTER this screen was set up (a common case:
    // print one target, keep this screen open, print another as backup)
    // would otherwise never show up here until something re-triggers
    // ensureScope. mousedown fires before the native option list opens, so
    // the refreshed list is what the shooter actually sees.
    $('#liveTargetPicker').addEventListener('mousedown', populateTargetPicker);
    $('#liveTargetPicker').addEventListener('change', onTargetPickerChange);
    $('#liveTorchBtn').addEventListener('click', toggleTorch);
  }

  // Flash/torch toggle (build .21) — same rationale and feature-detected
  // pattern as drill.js's version (used at range to light up a corner of the
  // target that's hard to lock onto in low light, then turned back off
  // before shooting so its own reflection can't be mistaken for a hit).
  // Kept as its own local copy rather than shared code, matching how
  // wireZoomControls is already duplicated per-file in this codebase.
  async function toggleTorch() {
    const info = Vision.getTorchInfo();
    const applied = await Vision.setTorch(!info.on);
    const btn = $('#liveTorchBtn');
    if (!btn) return;
    btn.classList.toggle('accent', applied);
    btn.textContent = applied ? '🔦 Flash ENCENDIDO' : '🔦 Flash';
  }

  // Reported directly (with screenshots): at range, the metatag optical
  // read often fails ("No se pudo leer el metatag — usando el blanco
  // actual") and live fire silently keeps whatever target happened to
  // already be loaded — which, unlike dry fire (generated and sent to the
  // screen seconds earlier), may well be a DIFFERENT target than the one
  // physically printed and taped up at the range (printed in an earlier
  // session, a different sheet, etc.). That's not a calibration/warp bug —
  // the corner-detection and homography code is the exact same Vision.lock()
  // dry fire uses, byte for byte — it's a target-IDENTITY bug: the overlay
  // was correctly drawn for the WRONG target, so shape outlines don't match
  // shape types in the photo at all (a square box over a round shape, etc).
  // This picker is the fix: always-visible, lets you manually pick the
  // correct saved target by name/ID right here, without depending on the
  // optical read succeeding — the same certainty dry fire gets "for free"
  // by construction.
  function populateTargetPicker() {
    const sel = $('#liveTargetPicker');
    if (!sel) return;
    const list = Storage.get('tm_saved_targets', []);
    const opts = ['<option value="">Cambiar blanco…</option>'].concat(
      list.map(r => `<option value="${r.id}" ${target && r.target && r.target.id === target.id ? 'selected' : ''}>${escapeHtml(r.name)} (#${r.target.id})</option>`)
    );
    sel.innerHTML = opts.join('');
  }

  function onTargetPickerChange() {
    const sel = $('#liveTargetPicker');
    const recId = sel.value;
    if (!recId) return;
    const rec = Storage.get('tm_saved_targets', []).find(r => r.id === recId);
    if (!rec) return;
    // Manually confirmed by the shooter — stop the optical auto-recognition
    // loop (same as a successful decode would) and switch straight to this
    // target, exactly like recognizeTarget() does on a good metatag read.
    // Goes through App.setActiveTarget (not just this file's local `target`)
    // so the Generador de Blanco tab stays in sync too, same as an optical
    // recognition success already does.
    App.setActiveTarget(JSON.parse(JSON.stringify(rec.target)));
    target = App.currentTarget();
    recognizeDone = true;
    Vision.setPageAspect(target.pageSize);
    const pill = $('#liveRecogState');
    if (pill) { pill.style.display = ''; pill.className = 'pill success'; pill.textContent = `Blanco elegido a mano: ${rec.name}`; }
    $('#liveHudTarget') && ($('#liveHudTarget').textContent = `${target.pageSize} · 1:1 · #${target.id}`);
    drawOverlay();
    updateStats();
  }

  function wireZoomControls(prefix) {
    const slider = $(`#${prefix}ZoomSlider`);
    const val = $(`#${prefix}ZoomVal`);
    const apply = (z) => { const applied = Vision.setZoom(z); slider.value = applied; val.textContent = applied.toFixed(2) + '×'; };
    slider.addEventListener('input', () => apply(parseFloat(slider.value)));
    $(`#${prefix}ZoomOut`).addEventListener('click', () => apply(Vision.getZoom() - Vision.ZOOM_STEP));
    $(`#${prefix}ZoomIn`).addEventListener('click', () => apply(Vision.getZoom() + Vision.ZOOM_STEP));
  }

  async function toggleCamera() {
    if (cameraOn) { stopCamera(); return; }
    const video = $('#liveVideo');
    // Same rationale as dry fire: don't block the camera stream (and the
    // zoom control) behind the OpenCV.js download — start it immediately.
    try {
      await Vision.start(video);
    } catch (e) {
      alert('No se pudo acceder a la cámara: ' + e.message);
      return;
    }
    cameraOn = true;
    $('#liveCamHint').style.display = 'none';
    $('#liveSearchWrap').style.display = 'block';
    $('#liveZoomCtrl').style.display = '';
    $('#liveZoomSlider').min = Vision.ZOOM_MIN; $('#liveZoomSlider').max = Vision.ZOOM_MAX; $('#liveZoomSlider').step = Vision.ZOOM_STEP;
    const torchBtn = $('#liveTorchBtn');
    if (torchBtn) {
      const torchInfo = Vision.getTorchInfo();
      torchBtn.style.display = torchInfo.supported ? '' : 'none';
      torchBtn.classList.remove('accent');
      torchBtn.textContent = '🔦 Flash';
    }
    if (!Vision.cvIsReady()) {
      $('#liveHudCam').textContent = 'CÁMARA: EN VIVO — cargando motor de visión…';
      await Vision.cvReady;
    }
    $('#liveHudCam').textContent = 'CÁMARA: EN VIVO — BUSCANDO ANCLAJES';
    Vision.lock(onVisionFrame, () => {}, target && target.pageSize);
  }

  function stopCamera() {
    Vision.stop();
    cameraOn = false;
    $('#liveLockedWrap') && ($('#liveLockedWrap').style.display = 'none');
    $('#liveSearchWrap') && ($('#liveSearchWrap').style.display = 'none');
    $('#liveZoomCtrl') && ($('#liveZoomCtrl').style.display = 'none');
    $('#liveHudCam') && ($('#liveHudCam').textContent = 'CÁMARA: APAGADA');
    $('#liveRecogState') && ($('#liveRecogState').style.display = 'none');
    $('#liveTorchBtn') && ($('#liveTorchBtn').style.display = 'none');
    recognizeAttempts = 0; recognizeDone = false;
  }

  function drawSearchPreview(frame) {
    const previewC = $('#liveSearchPreview');
    if (!previewC || !frame.previewCanvas) return;
    previewC.width = frame.previewCanvas.width; previewC.height = frame.previewCanvas.height;
    previewC.getContext('2d').drawImage(frame.previewCanvas, 0, 0);
    const guide = $('#liveSearchGuide');
    guide.width = previewC.width; guide.height = previewC.height;
    const gctx = guide.getContext('2d');
    gctx.clearRect(0, 0, guide.width, guide.height);
    gctx.save();
    gctx.strokeStyle = 'rgba(255,122,26,.5)';
    gctx.lineWidth = 2;
    gctx.setLineDash([6, 5]);
    const m = Math.min(guide.width, guide.height) * 0.08;
    gctx.strokeRect(m, m, guide.width - 2 * m, guide.height - 2 * m);
    gctx.restore();
    if (frame.corners) {
      gctx.save();
      gctx.fillStyle = '#45b26b';
      frame.corners.forEach(c => { gctx.beginPath(); gctx.arc(c.x, c.y, 6, 0, Math.PI * 2); gctx.fill(); });
      gctx.restore();
    }
  }

  function onVisionFrame(frame) {
    if (frame.state === 'SEARCHING') {
      $('#liveHudCam').textContent = `BUSCANDO… ${Math.round((frame.progress || 0) * 100)}%`;
      drawSearchPreview(frame);
      return;
    }
    if ($('#liveLockedWrap').style.display !== 'block') {
      $('#liveLockedWrap').style.display = 'block';
      $('#liveSearchWrap').style.display = 'none';
      $('#liveZoomCtrl').style.display = 'none';
      const base = Vision.warpCanvas;
      $('#liveLockedWrap').prepend(base);
      const overlay = $('#liveOverlay');
      overlay.width = Vision.WARP_W; overlay.height = Vision.WARP_H;
      overlay.addEventListener('click', onManualClick);
      $('#liveHudCam').textContent = 'BLOQUEADO';
      $('#liveHudCam').className = 'pill success';
      recognizeAttempts = 0;
      recognizeDone = false;
      const pill = $('#liveRecogState');
      pill.style.display = '';
      pill.className = 'pill';
      pill.textContent = 'Reconociendo blanco…';
    }
    if (currentFrameMat) { currentFrameMat.delete(); currentFrameMat = null; }
    currentFrameMat = frame.mat || null;
    if (!currentFrameMat) return;

    attemptRecognition();

    const gray = Vision.grayFromMat(currentFrameMat);
    if (referenceGray) {
      const hole = Vision.detectNewHole(gray, referenceGray, ignoreCtx);
      if (hole) {
        if (holeCandidate && Math.hypot(holeCandidate.gx - hole.gx, holeCandidate.gy - hole.gy) < 20) {
          holeCandidate.count++;
          holeCandidate.gx = hole.gx; holeCandidate.gy = hole.gy;
          holeCandidate.px = hole.px; holeCandidate.py = hole.py;
        } else {
          holeCandidate = { ...hole, count: 1 };
        }
        if (holeCandidate.count >= Vision.HOLE_STABILITY_FRAMES) {
          registerShot(holeCandidate.px, holeCandidate.py, 'camera');
          holeCandidate = null;
        }
      } else {
        holeCandidate = null;
      }
    }
    gray.delete();
    drawOverlay();
  }

  // Only attempts while no group is running yet (referenceGray null) — once
  // a group has started the active target must stay fixed for the duration.
  function attemptRecognition() {
    if (recognizeDone || !currentFrameMat || referenceGray) return;
    recognizeAttempts++;
    const decoded = Vision.decodeMetatag(currentFrameMat);
    const pill = $('#liveRecogState');
    if (decoded && decoded.valid) {
      const result = App.recognizeTarget(decoded);
      recognizeDone = true;
      if (result.status === 'recognized') {
        target = App.currentTarget();
        drawOverlay();
        pill.className = 'pill success';
        pill.textContent = `Blanco reconocido: ${result.rec.name}`;
      } else if (result.status === 'unsaved') {
        pill.className = 'pill info';
        pill.textContent = 'Código óptico leído, pero este blanco no está guardado — usando el actual';
      }
      return;
    }
    if (recognizeAttempts >= RECOGNIZE_BUDGET) {
      recognizeDone = true;
      pill.className = 'pill';
      pill.textContent = 'No se pudo leer el código óptico — usando el blanco actual';
    }
  }

  function drawOverlay() {
    const overlay = $('#liveOverlay');
    if (!overlay) return;
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    if (target) Target.drawGrid(ctx, overlay.width, overlay.height, target, 0.9, true);
    shots.forEach(hole => {
      ctx.save();
      ctx.fillStyle = '#111';
      ctx.beginPath(); ctx.arc(hole.px, hole.py, 5, 0, Math.PI * 2); ctx.fill();
      // Anillo coloreado por zona (A/C/D/fuera) cuando el blanco es
      // family==='ipsc' — mismo esquema de color que usa drill.js para que
      // sea consistente entre Fuego Seco y Fuego Real.
      if (hole.zone !== undefined) {
        ctx.strokeStyle = hole.zone === 'A' ? '#45b26b' : hole.zone === 'C' ? '#f4c430' : hole.zone === 'D' ? '#ff7a1a' : '#e5484d';
        ctx.lineWidth = 2;
      } else {
        ctx.strokeStyle = 'rgba(255,255,255,.6)'; ctx.lineWidth = 1;
      }
      ctx.stroke();
      ctx.restore();
    });
    if (shots.length) {
      const mpi = mpiOf(shots);
      ctx.save();
      ctx.strokeStyle = 'rgba(74,159,224,.9)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(mpi.px - 10, mpi.py); ctx.lineTo(mpi.px + 10, mpi.py);
      ctx.moveTo(mpi.px, mpi.py - 10); ctx.lineTo(mpi.px, mpi.py + 10);
      ctx.stroke(); ctx.restore();
    }
  }

  function onManualClick(e) {
    const overlay = $('#liveOverlay');
    const rect = overlay.getBoundingClientRect();
    const px = (e.clientX - rect.left) * (overlay.width / rect.width);
    const py = (e.clientY - rect.top) * (overlay.height / rect.height);
    registerShot(px, py, 'manual');
  }

  function registerShot(px, py, source) {
    const shot = { px, py, source };
    if (zoneTally) {
      const gx = px / Vision.WARP_W * GRID, gy = py / Vision.WARP_H * GRID;
      const zone = Target.zoneAt(gx, gy);
      shot.zone = zone;
      const key = zone || 'miss';
      zoneTally[key] = (zoneTally[key] || 0) + 1;
    }
    shots.push(shot);
    // mark this spot in the ignore mask so camera detection won't re-fire on it
    ignoreCtx.fillStyle = '#fff';
    ignoreCtx.beginPath(); ignoreCtx.arc(px, py, 16, 0, Math.PI * 2); ignoreCtx.fill();
    drawOverlay();
    updateStats();
  }

  function startGroup() {
    if (!currentFrameMat) { alert('Esperá a que la cámara esté BLOQUEADA sobre el blanco.'); return; }
    referenceGray = Vision.grayFromMat(currentFrameMat);
    recognizeDone = true; // lock the target for the duration of the group
    const pill = $('#liveRecogState');
    if (pill) pill.style.display = 'none';
  }

  function mpiOf(pts) {
    const sx = pts.reduce((a, s) => a + s.px, 0) / pts.length;
    const sy = pts.reduce((a, s) => a + s.py, 0) / pts.length;
    return { px: sx, py: sy };
  }

  function currentMoaStats() {
    if (shots.length < 2) return null;
    let maxDist = 0;
    for (let i = 0; i < shots.length; i++) for (let j = i + 1; j < shots.length; j++) {
      const d = Math.hypot(shots[i].px - shots[j].px, shots[i].py - shots[j].py);
      if (d > maxDist) maxDist = d;
    }
    const spec = PAGE_SPECS[target.pageSize];
    // Used to be an approximation (assumed the safe canvas mapped ~1:1 onto
    // a square warp canvas, which it never actually did — see the
    // WARP_W/WARP_H comment in vision.js). Now that the warp destination is
    // sized to match this page's real aspect ratio, safeW/WARP_W and
    // safeH/WARP_H are equal by construction, so this is exact regardless of
    // which axis a given shot pair's distance leans on.
    const mmPerPx = spec.safeW / Vision.WARP_W;
    const spreadMm = maxDist * mmPerPx;
    const distanceM = parseFloat($('#liveDistance').value) || 15;
    const moa = spreadMm / (MOA_MM_PER_METER * distanceM);
    return { spreadMm, moa, distanceM };
  }

  function updateStats() {
    const stats = currentMoaStats();
    if (zoneTally) {
      $('#statShotsIpsc').textContent = shots.length;
      $('#statLiveA').textContent = zoneTally.A;
      $('#statLiveC').textContent = zoneTally.C;
      $('#statLiveD').textContent = zoneTally.D;
      $('#statLiveMiss').textContent = zoneTally.miss;
      $('#statMoaIpsc').textContent = stats ? stats.moa.toFixed(2) + ' MOA' : '—';
      return;
    }
    $('#statShots').textContent = shots.length;
    if (!stats) {
      $('#statSpread').textContent = shots.length ? '1 impacto' : '—';
      $('#statMpi').textContent = '—';
      $('#statMoa').textContent = '—';
      return;
    }
    $('#statSpread').textContent = stats.spreadMm.toFixed(1) + ' mm';
    const mpi = mpiOf(shots);
    $('#statMpi').textContent = `(${mpi.px.toFixed(0)}, ${mpi.py.toFixed(0)}) px`;
    $('#statMoa').textContent = stats.moa.toFixed(2) + ' MOA';
  }

  function newGroup() {
    const stats = currentMoaStats();
    if (shots.length) {
      const distance = parseFloat($('#liveDistance').value) || 15;
      if (zoneTally) {
        const hist = Storage.get('tm_punteria_history', []);
        hist.unshift({ date: new Date().toISOString(), mode: 'LIVE', shots: shots.length, a: zoneTally.A, c: zoneTally.C, d: zoneTally.D, miss: zoneTally.miss, moa: stats ? stats.moa : 0, distance });
        Storage.set('tm_punteria_history', hist.slice(0, 100));
        App.renderHistory();
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${Storage.get('tm_punteria_history', []).length}</td><td>${distance}m</td><td>${shots.length}</td><td>${zoneTally.A}</td><td>${zoneTally.C}</td><td>${zoneTally.D}</td><td>${zoneTally.miss}</td>`;
        $('#punteriaLiveLogBody').prepend(tr);
      } else {
        const hist = Storage.get('tm_live_history', []);
        hist.unshift({ date: new Date().toISOString(), distance, shots: shots.length, moa: stats ? stats.moa : 0 });
        Storage.set('tm_live_history', hist.slice(0, 100));
        App.renderHistory();
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${Storage.get('tm_live_history', []).length}</td><td>${distance}m</td><td>${shots.length}</td><td>${stats ? stats.moa.toFixed(2) : '—'}</td>`;
        $('#liveLogBody').prepend(tr);
      }
    }
    shots = [];
    if (zoneTally) zoneTally = { A: 0, C: 0, D: 0, miss: 0 };
    ignoreCtx.fillStyle = '#000'; ignoreCtx.fillRect(0, 0, ignoreCanvas.width, ignoreCanvas.height);
    if (currentFrameMat) referenceGray = Vision.grayFromMat(currentFrameMat);
    drawOverlay();
    updateStats();
  }

  return { ensureScope, toggleCamera, startGroup, newGroup, stopCamera, updateStats };
})();
