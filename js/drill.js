/*
  DryFire — camera-driven (or manual-click fallback) mind-and-action drill.

  Works two ways at once, on purpose: while the camera is locked, every frame
  is scanned for a laser dot; you can also just tap/click the warped canvas.
  Whichever happens first for a round counts as the shot. That means the app
  is fully usable stand-alone (like the in-browser simulator you already
  tried) even before a real laser trainer + camera pair is dialed in.
*/
const DryFire = (() => {
  let target = null;
  let laserColor = 'red';
  let drill = null;
  let cameraOn = false;
  let currentFrameMat = null; // last LOCKED frame's cv.Mat, owned by us — must delete() each frame

  // Rising-edge tracking for the laser detector during a drill round. These
  // are laser TRAINER cartridges, not single-pulse triggers — the beam stays
  // lit for as long as the shooter holds the trigger down. Without this, a
  // round that starts AWAIT while the beam is already resting somewhere
  // (finishing the previous round, or just re-settling the aim as "¡YA!"
  // appears) registers a "shot" on whatever it happens to be pointed at that
  // instant — often before the shooter has even moved to the new target.
  // That's the concrete mechanism behind the reported "falsos positivos":
  // physically-impossible reaction times (~150ms) and hits landing on the
  // wrong shape that the shooter never consciously fired at. The fix is to
  // require the beam go OFF then back ON while in AWAIT before a hit counts
  // — tracked continuously from PROMPT onward so a beam already lit when
  // AWAIT begins doesn't look like a fresh edge. "Off" needs LASER_ARM_OFF_FRAMES
  // consecutive not-detected frames to "arm" (rather than a single frame),
  // so a one-frame detector flicker on an otherwise-steady beam can't look
  // like a genuine release-and-refire.
  let laserOffStreak = 0;
  const LASER_ARM_OFF_FRAMES = 2;

  // Second, independent layer, added after real footage showed the debug
  // panel reporting "DETECTARÍA UN DISPARO" (a 13px² color blob passing every
  // threshold) on a frame with NO laser dot visible anywhere on the target —
  // a single-frame false positive, almost certainly video/compression noise
  // or a stray highlight on the printed shapes, not the OFF→ON held-beam
  // issue above (which is about WHEN a real detection counts, not whether a
  // detection is real to begin with). At the time, that meant requiring the
  // beam ON for LASER_CONFIRM_ON_FRAMES (2) consecutive frames — the weak
  // color-margin detector of that era could false-positive on a single
  // frame easily, but a real held laser dot lands on the same spot for
  // several frames in a row, so 2-in-a-row filtered out the noise.
  //
  // Real footage since then (build 2026-08-26.6, the "destello"/grayscale
  // redesign) showed this now backfires for its own original purpose: an
  // actual laser CARTRIDGE round is a genuine physical flash lasting a few
  // milliseconds — much shorter than a person holding a pointer steady — so
  // in practice it only ever lands in ONE processed camera frame, never two
  // in a row. Requiring 2 consecutive frames meant real shots were being
  // rejected outright, forcing the shooter to hold the beam far longer than
  // any real gun-mounted laser would ever stay lit. The destello mask is
  // also a much stronger single-frame signal than the old color-margin one
  // (bright AND locally-contrasty AND right-ish hue AND right-sized area —
  // four independent conditions, not one loose color ratio), so a single
  // frame that clears all of it is no longer the flimsy signal it used to
  // be. LASER_CONFIRM_ON_FRAMES is now 1: a single qualifying frame counts,
  // as long as it's still armed (OFF→ON edge, below) — that's the layer now
  // doing the noise-rejection work, not frame-persistence.
  let laserOnStreak = 0;
  let laserArmed = false; // true once we've seen enough OFF frames since the last hit
  const LASER_CONFIRM_ON_FRAMES = 1;

  // Live raw-detection position, debug mode only — updated every LOCKED
  // frame to wherever the single-frame detector's blob is THIS frame (or
  // null when nothing passed). Drawn on the overlay as a small live dot,
  // separate from the persistent hit marker. Added directly for the false
  // positives the user kept finding where the debug panel said "DETECTARÍA"
  // with no visible laser dot anywhere in a screen recording — the text
  // alone never said WHERE that phantom blob was, so there was no way to
  // tell if it kept landing on the same spot (a fixed noise/print-texture
  // source) or moved around with wherever the real laser currently was
  // (reflection/margin sensitivity that varies by the shape's color, per
  // the user's own "apagué el láser y fui notando que el reflejo depende
  // del color" test). Now every raw reading is visible in place, live, on
  // the same recording the panel text comes from.
  let lastRawHit = null;

  // --- audio cues -----------------------------------------------------------
  // Each round now announces WHAT to shoot out loud (speech synthesis) and
  // marks WHEN to react with a beep, instead of only showing text — a real
  // stress-drill shouldn't require reading a screen. The two cues can come
  // in either order, since both are legitimate drill styles:
  //   'nameFirst' — say the target, THEN beep. The beep is the actual
  //                 go/reflex trigger (same timing semantics this app
  //                 always had): reaction time is measured from the beep.
  //   'beepFirst' — beep first (a "get ready, ID incoming" cue), THEN say
  //                 the target. Reaction time is measured from the moment
  //                 the shooter actually has enough information to act —
  //                 i.e. once the spoken name finishes — not from the beep,
  //                 since they can't react to a target they don't know yet.
  // Persisted across sessions since it's a training-style preference, not a
  // per-round setting.
  let audioCuesOn = Storage.get('tm_audio_cues_on', true);
  let cueOrder = Storage.get('tm_cue_order', 'nameFirst'); // 'nameFirst' | 'beepFirst'
  let audioCtx = null;

  function setAudioCuesOn(on) { audioCuesOn = !!on; Storage.set('tm_audio_cues_on', audioCuesOn); }
  function setCueOrder(order) { cueOrder = order === 'beepFirst' ? 'beepFirst' : 'nameFirst'; Storage.set('tm_cue_order', cueOrder); }

  // Difficulty level for what the prompt asks the shooter to identify —
  // requested directly: instead of always doing arithmetic, make the
  // cognitive load itself the difficulty knob. 1=figura sola, 2=figura+color
  // (the old default non-math clue), 3=figura+color+número, 4=cuentas (the
  // old math clue, kept as the hardest tier instead of a random 35% chance
  // every round). See buildPromptForLevel() below for how a level is turned
  // into an actual, UNAMBIGUOUS clue — level 1/2 aren't always safe to use
  // as-is (see that function's comment) so this is the requested level, not
  // necessarily the one actually used for a given round.
  let difficulty = clamp(parseInt(Storage.get('tm_difficulty', 1), 10) || 1, 1, 4);
  function setDifficulty(d) { difficulty = clamp(parseInt(d, 10) || 1, 1, 4); Storage.set('tm_difficulty', difficulty); }
  function getDifficulty() { return difficulty; }

  // Short synthesized beep via Web Audio — no audio file to ship/load, and
  // it's the actual timing-critical cue so it needs to fire the instant we
  // ask, not after a network/decode round-trip. AudioContext is created
  // lazily from a real user gesture (Iniciar Drill), satisfying browser
  // autoplay policies.
  function beep(freq = 880, durMs = 180) {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine'; osc.frequency.value = freq;
      const t0 = audioCtx.currentTime;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.35, t0 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + durMs / 1000);
      osc.connect(gain); gain.connect(audioCtx.destination);
      osc.start(t0); osc.stop(t0 + durMs / 1000 + 0.02);
    } catch (err) { /* no Web Audio support — silently skip the beep */ }
  }

  // Speaks `text` in Spanish and calls onDone once it's actually finished
  // (not just "started") — the whole point of measuring reaction time from
  // this callback in 'beepFirst' mode is knowing exactly when the shooter
  // had the full instruction. `onend` is the real signal, but it's known to
  // occasionally never fire on some Android Chrome/TTS-engine combinations
  // (unverified here — no real device to test against), so a length-based
  // fallback timeout guarantees onDone always fires eventually and the drill
  // can never freeze on a broken speech engine.
  function speak(text, onDone) {
    try {
      if (!('speechSynthesis' in window)) { onDone && onDone(); return; }
      speechSynthesis.cancel(); // clear any straggler from a fast previous round
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'es-AR';
      u.rate = 1.05;
      let done = false;
      const finish = () => { if (done) return; done = true; onDone && onDone(); };
      u.onend = finish;
      u.onerror = finish;
      setTimeout(finish, Math.max(600, text.length * 90) + 400);
      speechSynthesis.speak(u);
    } catch (err) {
      onDone && onDone();
    }
  }

  // "12 - 5" / "3 + 4" (Target.equationForNumber's format) -> spoken form.
  // Digits are left as Arabic numerals — Spanish TTS engines read those
  // natively — only the operator symbols get spelled out, since not every
  // engine pronounces a bare "+"/"-" naturally.
  function spokenEquation(eq) {
    return eq.replace(/\s*\+\s*/, ' más ').replace(/\s*-\s*/, ' menos ');
  }

  // Auto-recognition: once locked, try to optically read the printed
  // metatag for a bounded number of frames and auto-load the matching saved
  // target — so the shooter doesn't have to tap "Cargar" first. Manual load
  // still works exactly as before and simply gets overridden if/when a scan
  // succeeds.
  const RECOGNIZE_BUDGET = 45; // ~1.5s at 30fps before giving up and showing "no leído"
  let recognizeAttempts = 0;
  let recognizeDone = false;

  // Diagnostic mode: no real camera/laser in the dev environment this app
  // was built in, so instead of guessing at HSV/RGB thresholds blind, this
  // shows the ACTUAL live numbers the detector is computing right on the
  // shooter's phone — candidate anchor count while searching, why a lock
  // attempt got rejected, and (continuously, laser color vs. required
  // margins) exactly how close the current brightest spot is to counting as
  // a hit. Read the numbers off the screen (or screenshot them) and report
  // back — that's the closest thing to "giving the app eyes" without an
  // actual live video connection into this dev session.
  let debugOn = false;

  function ensureScope() {
    target = App.currentTarget();
    if (!target) return;
    $('#dryEmpty').style.display = 'none';
    $('#drySide').style.display = 'flex';
    const wrap = $('#dryScopeWrap');
    wrap.innerHTML = `
      <div class="scope-hud">
        <span class="pill" id="dryHudCam">CÁMARA: APAGADA</span>
        <span class="pill mono">${target.pageSize} · ${target.mode} · #${target.id}</span>
        <span class="pill" id="dryRecogState" style="display:none;"></span>
        <button class="pill" id="dryDebugToggle" style="cursor:pointer;border:1px solid var(--border);background:none;pointer-events:auto;">🔧 Diagnóstico</button>
      </div>
      <!-- margin-top clears the .scope-hud pills, which float
           position:absolute over the top-left of the camera view (by
           design, so camera state is visible over the live feed) — without
           this the debug panel's first lines used to render right under
           those pills, unreadable behind the "Diagnóstico" button. Sized
           for the worst case (state + pageSize + recognition pill + the
           debug button itself, all 4 stacked — see .scope-hud
           flex-direction:column in css/style.css). -->
      <pre class="mono" id="dryDebugPanel" style="display:none;margin:132px 0 10px;font-size:12px;color:var(--text-dim);white-space:pre-wrap;background:rgba(0,0,0,.25);border-radius:6px;padding:8px;"></pre>
      <video id="dryVideo" autoplay playsinline muted style="display:none;"></video>
      <div style="position:relative; display:none;" id="drySearchWrap">
        <canvas id="drySearchPreview" class="overlay" style="position:static; cursor:default;"></canvas>
        <canvas id="drySearchGuide" class="overlay" style="top:0; left:0;"></canvas>
      </div>
      <div style="position:relative; display:none;" id="dryLockedWrap">
        <canvas id="dryOverlay" class="overlay"></canvas>
      </div>
      <div class="empty-hint" id="dryCamHint">
        <span class="big">📷</span>
        Activá la cámara y encuadrá el blanco impreso completo dentro del cuadro.
      </div>
      <div class="prompt-banner" id="dryPrompt" style="display:none;"></div>
      <div class="zoom-ctrl" id="dryZoomCtrl" style="display:none;">
        <button class="zoom-btn" id="dryZoomOut">－</button>
        <input type="range" id="dryZoomSlider" min="1" max="4" step="0.25" value="1">
        <button class="zoom-btn" id="dryZoomIn">＋</button>
        <span class="zoom-val" id="dryZoomVal">1.0×</span>
      </div>
    `;
    $('#btnLock').disabled = false;
    $('#btnLock').textContent = 'Activar cámara';
    $('#btnStartDrill').disabled = true;
    wireZoomControls('dry');
    $('#dryDebugToggle').addEventListener('click', toggleDebug);
  }

  function toggleDebug() {
    debugOn = !debugOn;
    Vision.setDebug(debugOn);
    $('#dryDebugToggle').classList.toggle('accent', debugOn);
    $('#dryDebugPanel').style.display = debugOn ? '' : 'none';
    if (!debugOn) { $('#dryDebugPanel').textContent = ''; lastRawHit = null; drawOverlay(); }
  }

  function renderDebugPanel(text) {
    if (!debugOn) return;
    const el = $('#dryDebugPanel');
    if (el) el.textContent = text;
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
    const video = $('#dryVideo');
    // Camera permission/stream never needs OpenCV — start it immediately so
    // the zoom control and preview show up right away, instead of stalling
    // behind the (large, sometimes slow-to-download) OpenCV.js fetch.
    try {
      await Vision.start(video);
    } catch (e) {
      alert('No se pudo acceder a la cámara: ' + e.message + '\n\nRevisá los permisos del navegador (necesita HTTPS o localhost).');
      return;
    }
    cameraOn = true;
    $('#dryCamHint').style.display = 'none';
    $('#dryZoomCtrl').style.display = '';
    $('#dryZoomSlider').min = Vision.ZOOM_MIN; $('#dryZoomSlider').max = Vision.ZOOM_MAX; $('#dryZoomSlider').step = Vision.ZOOM_STEP;
    $('#dryHudCam').textContent = Vision.cvIsReady() ? 'CÁMARA: EN VIVO' : 'CÁMARA: EN VIVO — cargando motor de visión…';
    $('#btnLock').disabled = false;
    $('#btnLock').textContent = 'Re-calibrar';
    // Used to require a second, separate tap ("Iniciar Auto-Lock") before
    // anything appeared — the live feed only got drawn once the search loop
    // started, and that loop only started on that second tap. That left the
    // screen solid black in between, with no way to see the target (or use
    // the zoom slider that was already visible) until you pressed the
    // second button — right up until it locked, at which point the window
    // for adjusting zoom against the live feed was already gone. Livefire's
    // camera button never had this gap (it always chained straight into
    // search), so dry-fire now matches that: starting the camera goes
    // straight into the live search/preview loop, no extra tap needed.
    startLock();
  }

  function stopCamera() {
    Vision.stop();
    cameraOn = false;
    $('#dryLockedWrap') && ($('#dryLockedWrap').style.display = 'none');
    $('#drySearchWrap') && ($('#drySearchWrap').style.display = 'none');
    $('#dryZoomCtrl') && ($('#dryZoomCtrl').style.display = 'none');
    $('#dryHudCam') && ($('#dryHudCam').textContent = 'CÁMARA: APAGADA');
    $('#btnLock') && ($('#btnLock').textContent = 'Activar cámara');
    $('#dryRecogState') && ($('#dryRecogState').style.display = 'none');
    recognizeAttempts = 0; recognizeDone = false;
    $('#btnStartDrill').disabled = true;
    $('#dryDebugPanel') && ($('#dryDebugPanel').textContent = '');
  }

  async function startLock() {
    if (!cameraOn) { toggleCamera(); return; }
    // Show the live preview immediately — it doesn't need OpenCV (see
    // Vision's preview-only loop), only the actual corner search below does.
    // Doing this before the cvReady gate is what lets the feed (and zoom)
    // show up right away instead of waiting on OpenCV.js to finish loading.
    $('#dryLockedWrap').style.display = 'none';
    $('#drySearchWrap').style.display = 'block';
    // Re-show the zoom control every time a (re-)lock starts, not just the
    // very first camera activation. Before this, toggleCamera() was the
    // ONLY place that un-hid #dryZoomCtrl — once LOCKED hid it (see
    // onVisionFrame below), pressing "Re-calibrar" while the camera stayed
    // on (the normal way to fix a bad lock, per the user directly: "vas a
    // tener que permitir si por alguna razón tengo que recalibrar que
    // aparezca el zoom... y en ocasiones calibra cualquier cosa") went
    // straight back into the search loop with zoom stuck invisible — no way
    // to zoom in/out to help it find the right anchors on a re-try. Synced
    // to the CURRENT zoom (not reset to 1.0×) since the camera stream keeps
    // whatever zoom was already applied.
    $('#dryZoomCtrl').style.display = '';
    if (Vision.getZoom) {
      const z = Vision.getZoom();
      const slider = $('#dryZoomSlider'), val = $('#dryZoomVal');
      if (slider) slider.value = z;
      if (val) val.textContent = z.toFixed(2) + '×';
    }
    if (!Vision.cvIsReady()) {
      $('#dryHudCam').textContent = 'CÁMARA: EN VIVO — cargando motor de visión (OpenCV.js)…';
      $('#btnLock').disabled = true;
      await Vision.cvReady;
      $('#btnLock').disabled = false;
    }
    $('#dryHudCam').textContent = 'BUSCANDO 4 ANCLAJES…';
    // Pass the actual selected page size so the warp destination matches its
    // real (non-square) aspect ratio instead of forcing a square — see the
    // WARP_W/WARP_H comment in vision.js for why this fixes the "achatado"
    // (squashed circles) look.
    Vision.lock(onVisionFrame, onVisionState, target && target.pageSize);
  }

  function onVisionState(state) {
    if (state === 'SEARCHING') $('#dryHudCam').textContent = 'BUSCANDO ANCLAJES…';
  }

  function drawSearchPreview(frame) {
    const previewC = $('#drySearchPreview');
    if (!previewC || !frame.previewCanvas) return;
    previewC.width = frame.previewCanvas.width; previewC.height = frame.previewCanvas.height;
    previewC.getContext('2d').drawImage(frame.previewCanvas, 0, 0);
    const guide = $('#drySearchGuide');
    guide.width = previewC.width; guide.height = previewC.height;
    const gctx = guide.getContext('2d');
    gctx.clearRect(0, 0, guide.width, guide.height);
    // reticle showing the 4 corners the target's fiducials need to land near
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
      $('#dryHudCam').textContent = `BUSCANDO… ${Math.round((frame.progress || 0) * 100)}%`;
      drawSearchPreview(frame);
      if (frame.debug) {
        if ('candidateCount' in frame.debug) {
          const resNote = frame.debug.videoW && frame.debug.videoH
            ? `\nresolución de cámara: ${frame.debug.videoW}×${frame.debug.videoH} (${frame.debug.videoW > frame.debug.videoH ? 'horizontal/apaisada' : 'vertical'})`
            : '';
          renderDebugPanel(`Buscando anclajes — candidatos cuadrados detectados este cuadro: ${frame.debug.candidateCount} (necesita 4 cerca de las 4 esquinas)${resNote}`);
        } else if ('rejectedWarpStd' in frame.debug) {
          renderDebugPanel(`Encontró 4 candidatos pero la imagen resultante salió CHATA (variación=${frame.debug.rejectedWarpStd.toFixed(1)}, necesita ≥${frame.debug.required}) — rechazado, re-buscando. Esto es lo que antes se veía como pantalla en negro/rosa/lisa.`);
        }
      }
      return;
    }
    // LOCKED
    if (!$('#dryLockedWrap').style.display || $('#dryLockedWrap').style.display === 'none') {
      $('#dryLockedWrap').style.display = 'block';
      $('#drySearchWrap').style.display = 'none';
      $('#dryZoomCtrl').style.display = 'none';
      const base = Vision.warpCanvas;
      base.className = '';
      base.style.borderRadius = '4px';
      const lockedWrap = $('#dryLockedWrap');
      lockedWrap.prepend(base);
      const overlay = $('#dryOverlay');
      overlay.width = Vision.WARP_W; overlay.height = Vision.WARP_H;
      overlay.addEventListener('click', onManualClick);
      $('#dryHudCam').textContent = 'BLOQUEADO · calibrado';
      $('#dryHudCam').className = 'pill success';
      $('#btnStartDrill').disabled = false;
      $('#btnLock').textContent = 'Re-calibrar';
      recognizeAttempts = 0;
      recognizeDone = false;
      const pill = $('#dryRecogState');
      pill.style.display = '';
      pill.className = 'pill';
      pill.textContent = 'Reconociendo blanco…';
    }
    if (currentFrameMat) { currentFrameMat.delete(); currentFrameMat = null; }
    currentFrameMat = frame.mat || null;

    attemptRecognition();

    if (drill && (drill.state === 'PROMPT' || drill.state === 'AWAIT') && currentFrameMat) {
      const hit = Vision.detectLaserInMat(currentFrameMat, laserColor);
      lastRawHit = debugOn && hit ? { gx: hit.gx, gy: hit.gy } : null;
      const isOn = !!hit;
      if (isOn) {
        laserOnStreak++;
      } else {
        laserOnStreak = 0;
        laserOffStreak++;
        if (laserOffStreak >= LASER_ARM_OFF_FRAMES) laserArmed = true;
      }
      // A shot counts only when BOTH are true: (1) armed — the beam went
      // off for a couple of frames at some point since the last hit (so a
      // beam already lit from the previous round, or still settling during
      // PROMPT, doesn't fire on its own), and (2) confirmed — the beam has
      // now been seen on for LASER_CONFIRM_ON_FRAMES frame(s) (currently
      // just 1 — see the comment above on why requiring more than that
      // rejects real single-flash laser rounds). See the two comments above.
      if (drill.state === 'AWAIT' && !drill.hitRegistered && laserArmed && isOn && laserOnStreak >= LASER_CONFIRM_ON_FRAMES) {
        registerHit(hit.gx, hit.gy, 'camera');
        laserArmed = false;
      }
      if (isOn) laserOffStreak = 0;
    } else if (debugOn && currentFrameMat) {
      // No active drill round, but debug mode is on: run the detector
      // anyway (result discarded except for its position) purely so
      // getLastLaserDebug() has fresh numbers — lets you point the laser
      // and watch live readings without needing to start a drill first.
      const rawHit = Vision.detectLaserInMat(currentFrameMat, laserColor);
      lastRawHit = rawHit ? { gx: rawHit.gx, gy: rawHit.gy } : null;
    } else {
      lastRawHit = null;
    }

    if (debugOn) {
      const d = Vision.getLastLaserDebug();
      if (d) {
        // Detection is now PRIMARILY grayscale brightness + local contrast
        // ("destello"/flash), not color — see the big comment on
        // LASER_DESTELLO_BRIGHTNESS_MIN in vision.js. "margen canal" below is
        // now just a loose sanity check ("isn't obviously the wrong color"),
        // not the main gate, so it's shown after brightness/contrast and
        // labeled accordingly.
        const passB = d.maxBrightness >= d.requiredBrightness;
        const passC = d.maxLocalContrast >= d.requiredLocalContrast;
        const pass1 = d.maxMargin1 >= d.requiredMargin, pass2 = d.maxMargin2 >= d.requiredMargin;
        const areaNote = d.largestBlobArea > 0
          ? `  mancha más grande: ${d.largestBlobArea.toFixed(0)}px² (válido: ${d.requiredAreaMin}-${d.requiredAreaMax})${d.largestBlobArea >= d.requiredAreaMax ? ' ← demasiado grande, probablemente una figura del blanco, no el láser' : ''}`
          : '  ninguna mancha encontrada';
        const exp = Vision.getExposureInfo ? Vision.getExposureInfo() : null;
        const expNote = exp
          ? (exp.supported
              ? `exposición: ajuste automático ${exp.applied ? `aplicado (${exp.value})` : (exp.error ? 'falló (' + exp.error + ')' : 'pendiente')}`
              : 'exposición: el teléfono no soporta ajuste manual')
          : '';
        const zoomInfo = Vision.getZoomInfo ? Vision.getZoomInfo() : null;
        const zoomNote = zoomInfo
          ? (zoomInfo.supported
              ? `zoom: ÓPTICO/hardware ${zoomInfo.applied ? 'aplicado' : 'soportado pero no aplicado aún'} (rango real del teléfono: ${zoomInfo.range.min}×-${zoomInfo.range.max}×)`
              : 'zoom: DIGITAL (recorte) — este teléfono no expone zoom óptico controlable')
          : '';
        // IMPORTANT: everything above is the raw, SINGLE-FRAME detector
        // reading — "DETECTARÍA UN DISPARO" only means this one frame's
        // blob passed the brightness/contraste/área thresholds. It does
        // NOT mean a shot actually got registered: registerHit() also
        // requires the multi-frame gate below (armed by a prior OFF streak,
        // confirmed by 2 consecutive ON frames — see the big comments near
        // the top of this file). A screen recording that shows "DETECTARÍA
        // UN DISPARO" with no hit marker appearing is the gate correctly
        // rejecting single-frame noise, not a bug — this line exists so
        // that's visible in the recording itself instead of ambiguous.
        const gateNote = drill
          ? `condición para contar el disparo: armado=${laserArmed ? 'sí' : 'no'} · racha encendido=${laserOnStreak}/${LASER_CONFIRM_ON_FRAMES} · racha apagado=${laserOffStreak}/${LASER_ARM_OFF_FRAMES}${drill.hitRegistered ? ' · ronda YA registró disparo' : ''}`
          : 'condición para contar el disparo: sin drill activo — este panel solo muestra la lectura cruda';
        renderDebugPanel(
          (expNote ? expNote + '\n' : '') +
          (zoomNote ? zoomNote + '\n' : '') +
          `BLOQUEADO — láser ${d.colorId === 'green' ? 'verde' : 'rojo'} · apuntá y mirá estos valores en vivo:\n` +
          `  brillo máximo (escala de grises): ${d.maxBrightness.toFixed(0)} / necesita ≥${d.requiredBrightness}  ${passB ? '✓' : '✗'}\n` +
          `  contraste local (destello): ${d.maxLocalContrast.toFixed(0)} / necesita ≥${d.requiredLocalContrast}  ${passC ? '✓' : '✗'}\n` +
          `  color (chequeo suelto, no decide solo): canal 1 ${d.maxMargin1.toFixed(0)}/≥${d.requiredMargin} ${pass1 ? '✓' : '✗'} · canal 2 ${d.maxMargin2.toFixed(0)}/≥${d.requiredMargin} ${pass2 ? '✓' : '✗'}\n` +
          `${areaNote}\n` +
          `${d.detected ? '  → este cuadro DETECTARÍA (crudo, sin confirmar)' : '  → no dispararía'}\n` +
          `${gateNote}`
        );
      }
    }
    drawOverlay();
  }

  // Tries an optical read on the current locked/warped frame; on a clean
  // decode it looks the target up in the saved-targets library and, if
  // found, swaps it in automatically (no "Cargar" tap needed). Gives up
  // silently after RECOGNIZE_BUDGET frames — the manual "Cargar" button in
  // the target-generator tab remains the fallback either way.
  function attemptRecognition() {
    if (recognizeDone || !currentFrameMat) return;
    if (drill) return; // don't swap the target mid-drill
    recognizeAttempts++;
    const decoded = Vision.decodeMetatag(currentFrameMat);
    const pill = $('#dryRecogState');
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
      pill.textContent = 'No se pudo leer el código óptico — usando el blanco actual (podés cargar uno manualmente)';
    }
  }

  function drawOverlay() {
    const overlay = $('#dryOverlay');
    if (!overlay) return;
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    if (target) Target.drawGrid(ctx, overlay.width, overlay.height, target, 1, true);
    if (debugOn && lastRawHit) {
      const px = lastRawHit.gx / GRID * overlay.width, py = lastRawHit.gy / GRID * overlay.height;
      drawRawDetectionMarker(ctx, px, py);
    }
    // Every registered hit this session, not just the last one — requested
    // directly: "me gustaria que los impactos queden puesto o dibujados
    // hasta terminar la sesion para poder evaluar donde pegaron". Stored in
    // GRID (normalized 0-1000) coordinates and converted to pixels here at
    // draw time (same pattern as lastRawHit above) rather than once at hit
    // time, so they stay correctly placed even if the overlay canvas gets
    // resized (e.g. after a re-calibration) mid-session. Only the MOST
    // RECENT marker gets its full debug-numbers box — drawing that box for
    // every past hit too would bury the target under text after a few
    // rounds; the compact round-number badge is enough to tell older shots
    // apart.
    if (drill && drill.markers && drill.markers.length) {
      const lastIdx = drill.markers.length - 1;
      drill.markers.forEach((m, i) => {
        const px = m.gx / GRID * overlay.width, py = m.gy / GRID * overlay.height;
        drawHitMarker(ctx, px, py, m.color, m.ok, i === lastIdx ? m.snapshot : null, m.round);
      });
    }
  }

  // Small, live, one-frame-at-a-time marker showing exactly where the RAW
  // single-frame detector's blob is THIS frame — separate from (and drawn
  // under) the persistent gated hit marker above. Deliberately plain (a
  // thin dashed circle, no "correcto/incorrecto" ring) so it reads as "this
  // is just a raw reading" at a glance, distinct from an actual registered
  // shot. See the big comment on `lastRawHit` above for why this exists.
  function drawRawDetectionMarker(ctx, px, py) {
    ctx.save();
    ctx.strokeStyle = '#ffb84d';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.arc(px, py, 10, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#ffb84d';
    ctx.font = 'bold 11px monospace';
    ctx.textBaseline = 'top';
    ctx.fillText('crudo', Math.min(Math.max(px + 12, 2), ctx.canvas.width - 40), py - 6);
    ctx.restore();
  }

  function drawHitMarker(ctx, px, py, color, ok, snapshot, round) {
    ctx.save();
    ctx.strokeStyle = color === 'red' ? '#ff3b3b' : '#33ff8a';
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(px, py, 14, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(px - 20, py); ctx.lineTo(px + 20, py);
    ctx.moveTo(px, py - 20); ctx.lineTo(px, py + 20);
    ctx.stroke();
    if (ok !== undefined) {
      ctx.strokeStyle = ok ? '#45b26b' : '#e5484d';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(px, py, 22, 0, Math.PI * 2); ctx.stroke();
    }
    // Small round-number badge so, once several hits are on screen at once
    // (the whole point of keeping them all drawn), you can still tell which
    // shot was which without needing the debug numbers box.
    if (round !== undefined) {
      ctx.fillStyle = 'rgba(0,0,0,.75)';
      ctx.beginPath(); ctx.arc(px + 17, py - 17, 9, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 10px monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(round), px + 17, py - 16);
      ctx.textAlign = 'left';
    }
    // Draw the exact detector numbers that triggered THIS registered hit,
    // right on the target photo next to where it landed — so a screen
    // recording shows, in the same frame, both whether a real laser dot is
    // visible AND what the app actually measured there. Camera-sourced hits
    // only (a manual tap has no laser numbers to show).
    if (snapshot) {
      const lines = [
        `m1:${snapshot.maxMargin1.toFixed(0)} m2:${snapshot.maxMargin2.toFixed(0)} br:${snapshot.maxBrightness.toFixed(0)} c:${snapshot.maxLocalContrast.toFixed(0)}`,
        `área:${snapshot.largestBlobArea.toFixed(0)}px²`,
      ];
      ctx.font = 'bold 13px monospace';
      ctx.textBaseline = 'top';
      const boxX = Math.min(Math.max(px - 70, 4), ctx.canvas.width - 144);
      const boxY = py + 26;
      ctx.fillStyle = 'rgba(0,0,0,0.72)';
      ctx.fillRect(boxX, boxY, 140, 34);
      ctx.fillStyle = '#fff';
      lines.forEach((line, i) => ctx.fillText(line, boxX + 4, boxY + 3 + i * 15));
    }
    ctx.restore();
  }

  function onManualClick(e) {
    if (!drill || drill.state !== 'AWAIT' || drill.hitRegistered) return;
    const overlay = $('#dryOverlay');
    const rect = overlay.getBoundingClientRect();
    const px = (e.clientX - rect.left) * (overlay.width / rect.width);
    const py = (e.clientY - rect.top) * (overlay.height / rect.height);
    const gx = px / overlay.width * GRID, gy = py / overlay.height * GRID;
    registerHit(gx, gy, 'manual');
  }

  function findShapeAt(gx, gy) {
    for (const s of target.shapes) {
      if (Math.hypot(s.cx - gx, s.cy - gy) <= s.r * 1.05) return s;
    }
    return null;
  }

  function registerHit(gx, gy, source) {
    if (!drill || drill.state !== 'AWAIT' || drill.hitRegistered) return;
    drill.hitRegistered = true;
    const hitShape = findShapeAt(gx, gy);
    // Snapshot the raw detector numbers for THIS exact registered hit (not
    // just a live preview) so a shot can be reviewed after the fact — see
    // the big comment on the debug-panel "gate" line above. Requested
    // directly: "dejaras el impacto dibujado así podés observar si lo que
    // captura como disparo en realidad fue el láser o no".
    const laserSnapshot = source === 'camera' && Vision.getLastLaserDebug ? Vision.getLastLaserDebug() : null;
    evaluateHit(gx, gy, hitShape, source, laserSnapshot);
  }

  $('#btnLock') && null; // (listener attached in App.init)

  function startDrill() {
    const rounds = clamp(parseInt($('#drillRounds').value, 10) || 8, 1, 30);
    drill = { rounds, idx: 0, hits: 0, miss: 0, rts: [], state: 'IDLE', log: [], hitRegistered: false, markers: [] };
    $('#btnStartDrill').style.display = 'none';
    $('#btnStopDrill').style.display = '';
    $('#drillLogBody').innerHTML = '';
    updateStats();
    nextPrompt();
  }

  function stopDrill() {
    if (drill && drill.idx > 0) { persistSession(drill); flashScreen('var(--danger)', 450); }
    drill = null;
    $('#btnStartDrill').style.display = '';
    $('#btnStopDrill').style.display = 'none';
    $('#dryPrompt').style.display = 'none';
  }

  // Turns a requested difficulty level (1-4) into an actual clue for this
  // round, plus a matchFn deciding which shape(s) on the target count as a
  // correct hit. Earlier versions tried to guarantee a single unambiguous
  // shape per clue (silently escalating "figura sola" to "figura+color" when
  // 2+ shapes shared a type, etc.) — but that meant the level actually shown
  // didn't always match the requested level, which is confusing (reported
  // directly: asking for nivel 1 and getting a clue that still named a
  // color). Instead, a clue that matches MULTIPLE shapes is not a bug to
  // route around — ANY shape satisfying it is a correct hit. So level 1
  // ("Disparar: Triángulo") is correct whichever triangle gets hit, level 2
  // ("Disparar: Círculo Azul") is correct for either blue circle if there
  // are two, etc. Levels 3 (plain number) and 4 (cuentas) are keyed off the
  // shape's printed number, which target.js always assigns uniquely per
  // target, so those two are naturally unambiguous — exactly one shape ever
  // matches. This also means every level works off the SAME printed target,
  // no per-level target needed.
  function buildPromptForLevel(level, shapes) {
    const shape = choice(shapes);
    let matchFn;
    if (level === 1) {
      matchFn = s => s.type === shape.type;
    } else if (level === 2) {
      matchFn = s => s.type === shape.type && s.color === shape.color;
    } else {
      // Level 3 (just the number) and level 4 (equation) both key off the
      // shape's own unique printed number.
      matchFn = s => s.number === shape.number;
    }
    return { shape, matchFn };
  }

  function nextPrompt() {
    if (!drill) return;
    if (drill.idx >= drill.rounds) { finish(); return; }
    drill.idx++;
    drill.hitRegistered = false;
    // Reset laser edge/persistence tracking fresh for this round (see the
    // two declarations above).
    laserOffStreak = 0;
    laserOnStreak = 0;
    laserArmed = false;
    updateStats();
    const banner = $('#dryPrompt');
    banner.style.display = '';

    const { shape, matchFn } = buildPromptForLevel(difficulty, target.shapes);
    drill.promptShape = shape;
    drill.matchFn = matchFn;
    drill.state = 'PROMPT';
    const isMath = difficulty === 4;
    drill.isMath = isMath;
    let label, spokenText;
    if (difficulty === 4) {
      const eq = Target.equationForNumber(shape.number);
      drill.clueText = `Disparar la figura con el resultado de: <b>${eq}</b>`;
      label = `Calc ${eq}`;
      spokenText = spokenEquation(eq);
    } else if (difficulty === 3) {
      // Just the number — no shape name, no color, per the explicit request
      // ("capas solo nombrar el numero sin decir ni cuadrado ni color").
      drill.clueText = `Disparar el número: <b>${shape.number}</b>`;
      label = `#${shape.number}`;
      spokenText = `Número ${shape.number}`;
    } else if (difficulty === 2) {
      const shapeLabel = `${TYPE_MAP[shape.type].name} ${COLOR_MAP[shape.color].name}`;
      drill.clueText = `Disparar: ${shapeLabel}`;
      label = shapeLabel;
      spokenText = shapeLabel;
    } else {
      const shapeLabel = TYPE_MAP[shape.type].name;
      drill.clueText = `Disparar: ${shapeLabel}`;
      label = shapeLabel;
      spokenText = shapeLabel;
    }
    drill.currentLabel = label;

    const showClue = () => {
      if (!drill) return;
      banner.innerHTML = drill.clueText;
      banner.style.borderColor = isMath ? 'var(--info)' : 'var(--accent)';
      banner.style.color = isMath ? 'var(--info)' : 'var(--accent)';
    };
    const startAwait = () => {
      if (!drill) return;
      drill.state = 'AWAIT';
      drill.awaitStart = nowMs();
      banner.innerHTML = `${drill.clueText}<span class="rt">¡YA!</span>`;
      flashScreen('var(--success)');
    };

    if (!audioCuesOn) {
      // Original text-only flow: show the clue, then a fixed random delay
      // before the visual "¡YA!" go signal.
      showClue();
      setTimeout(startAwait, 700 + Math.random() * 500);
      return;
    }

    banner.innerHTML = 'Preparate…';
    banner.style.borderColor = 'var(--text-dim)'; banner.style.color = 'var(--text-dim)';
    const readyDelay = 500 + Math.random() * 400;
    setTimeout(() => {
      if (!drill) return;
      if (cueOrder === 'beepFirst') {
        beep();
        // A short gap after the beep before naming the target — an
        // immediate name would step on the beep's own tail.
        setTimeout(() => {
          if (!drill) return;
          showClue();
          speak(spokenText, startAwait);
        }, 250);
      } else {
        showClue();
        speak(spokenText, () => {
          if (!drill) return;
          setTimeout(() => { beep(); startAwait(); }, 150);
        });
      }
    }, readyDelay);
  }

  function evaluateHit(gx, gy, hitShape, source, laserSnapshot) {
    const rt = nowMs() - drill.awaitStart;
    // Any shape satisfying the round's matchFn counts as correct — see the
    // comment on buildPromptForLevel for why this isn't a single-shape-id
    // check any more (a clue like "Círculo Azul" can legitimately match more
    // than one shape on the target).
    const ok = !!(hitShape && drill.matchFn && drill.matchFn(hitShape));
    // Pushed onto drill.markers, not replacing a single lastMarker — kept
    // (and drawn, see drawOverlay) for the rest of the SESSION, not just
    // until the next round, so every shot stays visible to review where it
    // landed once the drill is done.
    drill.markers.push({ gx, gy, color: laserColor, ok, snapshot: laserSnapshot, round: drill.idx });
    drawOverlay();
    logRound({ label: drill.currentLabel, rt, ok, source, hitShapeLabel: hitShape ? `${hitShape.type}#${hitShape.number}` : 'ninguna', snapshot: laserSnapshot });
    drill.state = 'EVAL';
    const banner = $('#dryPrompt');
    banner.innerHTML = `${ok ? '✔ Correcto' : '✘ Incorrecto'} <span class="rt">${rt.toFixed(0)} ms · ${source === 'camera' ? 'láser' : 'manual'}</span>`;
    banner.style.borderColor = ok ? 'var(--success)' : 'var(--danger)';
    banner.style.color = ok ? 'var(--success)' : 'var(--danger)';
    // Was 900ms — extended so the impact marker (and its diagnostic numbers,
    // drawn by drawHitMarker below) stay on screen long enough to actually
    // catch on a screen recording, per the request to be able to see what
    // triggered each registered shot instead of it flashing past. The
    // marker itself no longer gets cleared after this delay (see above) —
    // only the round actually advances.
    setTimeout(() => { nextPrompt(); }, 2200);
  }

  function logRound(entry) {
    drill.rts.push(entry.rt);
    if (entry.ok) drill.hits++; else drill.miss++;
    drill.log.push(entry);
    updateStats();
    // "Detalle" carries what actually triggered this row's shot — which
    // shape (if any) the hit landed on, and for camera-sourced hits, the
    // raw blob numbers captured at that exact frame (same numbers drawn
    // next to the impact marker). This is what makes a shot reviewable
    // after the fact — no need to catch the marker live on screen, it's
    // saved here as long as the drill log is visible/exported.
    let detail = entry.hitShapeLabel ? `→ ${entry.hitShapeLabel}` : '→ ninguna figura';
    if (entry.snapshot) {
      const s = entry.snapshot;
      detail += ` · br:${s.maxBrightness.toFixed(0)} c:${s.maxLocalContrast.toFixed(0)} color1:${s.maxMargin1.toFixed(0)} color2:${s.maxMargin2.toFixed(0)} área:${s.largestBlobArea.toFixed(0)}px²`;
    } else if (entry.source === 'manual') {
      detail += ' · toque manual';
    }
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${drill.idx}</td><td>${entry.label}</td><td>${entry.rt.toFixed(0)}ms</td><td class="${entry.ok ? 'success-txt' : 'danger-txt'}">${entry.ok ? '✔' : '✘'}</td><td style="font-size:11px; color:var(--text-dim); white-space:nowrap;">${detail}</td>`;
    $('#drillLogBody').prepend(tr);
  }

  function updateStats() {
    if (!drill) return;
    $('#statRound').textContent = `${drill.idx} / ${drill.rounds}`;
    $('#statHits').textContent = drill.hits;
    $('#statMiss').textContent = drill.miss;
    const avg = drill.rts.length ? drill.rts.reduce((a, b) => a + b, 0) / drill.rts.length : 0;
    $('#statAvgRt').textContent = drill.rts.length ? avg.toFixed(0) + ' ms' : '—';
  }

  function finish() {
    const banner = $('#dryPrompt');
    banner.innerHTML = `Drill completo — ${drill.hits}/${drill.rounds} aciertos`;
    banner.style.borderColor = 'var(--accent)'; banner.style.color = 'var(--accent)';
    flashScreen('var(--danger)', 450);
    persistSession(drill);
    setTimeout(() => {
      $('#btnStartDrill').style.display = '';
      $('#btnStopDrill').style.display = 'none';
      banner.style.display = 'none';
      drill = null;
    }, 1600);
  }

  function persistSession(d) {
    if (!d || d.log.length === 0) return;
    const avg = d.rts.length ? d.rts.reduce((a, b) => a + b, 0) / d.rts.length : 0;
    const hist = Storage.get('tm_drill_history', []);
    // `rts`/`log` (per-round reaction time + hit/miss + prompt label) are
    // saved alongside the existing summary fields — not surfaced in the UI
    // yet (today's history table only shows the summary row), but recording
    // them now means a future "ver mejoras" trend view can use real
    // historical per-round data instead of only session averages.
    hist.unshift({ date: new Date().toISOString(), rounds: d.idx, hits: d.hits, avgRt: avg, rts: d.rts, log: d.log });
    Storage.set('tm_drill_history', hist.slice(0, 100));
    App.renderHistory();
  }

  function setLaserColor(c) { laserColor = c; }

  // Fixed bottom action bar (see .cta-bar in css/style.css) — mirrors
  // whichever of #btnLock/#btnStartDrill/#btnStopDrill is currently the
  // relevant next action, so it's always reachable without scrolling.
  // Rather than threading an extra call through every place that toggles
  // those buttons' visibility (easy to miss one), a MutationObserver just
  // watches the real buttons and #drySide and re-syncs whenever anything
  // about them changes — one place to get right, can't drift out of sync.
  let ctaObserverSet = false;
  function ctaSync() {
    const bar = $('#dryCtaBar'), btn = $('#dryCtaBtn');
    const side = $('#drySide');
    if (!bar || !btn || !side) return;
    // offsetParent is null both when #drySide itself is display:none AND
    // when an ancestor (the panel-dry tab, hidden while another tab is
    // active) is display:none — a plain style-attribute check only catches
    // the first case, and left the bar showing on every OTHER tab too.
    if (side.style.display === 'none' || side.offsetParent === null) { bar.style.display = 'none'; return; }
    const stopBtn = $('#btnStopDrill'), startBtn = $('#btnStartDrill'), lockBtn = $('#btnLock');
    // #btnStartDrill stays visible (just disabled) the whole time the
    // camera isn't locked yet — style.display alone can't tell "ready to
    // start a drill" apart from "still need to activate/calibrate the
    // camera first". Only treat it as the current action once it's actually
    // enabled; otherwise the real next step is still #btnLock.
    let mirror = null;
    if (stopBtn && stopBtn.style.display !== 'none') mirror = stopBtn;
    else if (startBtn && startBtn.style.display !== 'none' && !startBtn.disabled) mirror = startBtn;
    else if (lockBtn) mirror = lockBtn;
    if (!mirror) { bar.style.display = 'none'; return; }
    // NOT '' — the bar's CSS default is display:none (see .cta-bar in
    // style.css), so clearing the inline style would just fall back to that
    // same none instead of actually showing it.
    bar.style.display = 'block';
    btn.textContent = mirror.textContent;
    btn.disabled = mirror.disabled;
    btn.className = 'btn ' + (mirror.classList.contains('btn-ghost') ? 'btn-ghost' : 'btn-accent');
    btn.onclick = () => mirror.click();
  }
  function setupCtaBar() {
    if (ctaObserverSet) { ctaSync(); return; }
    const targets = [$('#btnLock'), $('#btnStartDrill'), $('#btnStopDrill'), $('#drySide')].filter(Boolean);
    if (!targets.length) return;
    const obs = new MutationObserver(ctaSync);
    targets.forEach(t => obs.observe(t, { attributes: true, attributeFilter: ['style', 'disabled', 'class'] }));
    ctaObserverSet = true;
    ctaSync();
  }

  return {
    ensureScope, toggleCamera, startLock, startDrill, stopDrill, setLaserColor, stopCamera,
    setAudioCuesOn, setCueOrder, setDifficulty,
    getAudioCuesOn: () => audioCuesOn, getCueOrder: () => cueOrder, getDifficulty,
    setupCtaBar,
  };
})();
