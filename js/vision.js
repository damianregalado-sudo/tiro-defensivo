/*
  Vision.js — camera capture + OpenCV.js pipeline.

  Pipeline, mirroring the spec:
    1. getUserMedia -> raw video frames.
    2. Search every frame for the 4 black/white fiducial corner markers.
    3. Once 4 good corners are found and stable for a few frames, compute the
       homography and warp the safe-canvas into a fixed-size canvas shaped to
       match the actual printed page's aspect ratio (see setPageAspect/
       WARP_W/WARP_H below) — this is the "1000x1000 normalized grid"
       referenced everywhere else (GRID stays a square 1000x1000 abstract
       coordinate space regardless; only the pixel canvas it's warped into
       matches the real page's proportions).
    4. Run a short automatic luma calibration (Otsu threshold) — no manual
       sensitivity sliders, per spec.
    5. From then on, every frame is warped live and handed to whoever is
       listening (drill.js for laser-dot detection, livefire.js for bullet
       hole detection via frame differencing).

  IMPORTANT — this was written without a physical camera/printed target to
  tune against (this dev environment has no camera). The corner-detection and
  HSV thresholds below are standard, defensible starting points, but WILL
  likely need real-world tuning (lighting, paper stock, laser strength). The
  constants block at the top is where you do that tuning; both the dry-fire
  and live-fire screens also expose a manual click/tap fallback that bypasses
  detection entirely, so the app is always usable even before CV is dialed in.
*/
const Vision = (() => {
  // ---- tunable constants -----------------------------------------------
  // WARP_W / WARP_H: dimensions of the warped/calibrated output canvas.
  // This used to be a single WARP_SIZE, forcing a SQUARE destination no
  // matter what page was printed — but every PAGE_SPECS entry is a portrait
  // RECTANGLE (A4: 190x277mm, A3: 277x400mm, Oficio: 195.9x335.6mm), none of
  // them square. Warping a real rectangular page into a square destination
  // forces an anisotropic (different-per-axis) stretch on everything in the
  // photo: real printed CIRCLES come out as horizontally-squashed ELLIPSES
  // in the locked/warped view. This is the actual, camera-confirmed root
  // cause of the "achatado" bug — reproduced by feeding the shooter's own
  // footage through this exact pipeline (see README): the corner detection
  // and homography math were both already correct, the destination shape
  // just didn't match the source's real proportions. setPageAspect() below
  // sizes WARP_W/WARP_H to match the actual selected page's aspect ratio
  // (long side pinned to WARP_LONG_SIDE px) so a round printed shape stays
  // visually round after warping too, and defaults to square only until the
  // page size is known.
  const WARP_LONG_SIDE = 600;
  let WARP_W = WARP_LONG_SIDE, WARP_H = WARP_LONG_SIDE;
  function setPageAspect(pageSize) {
    const spec = (typeof PAGE_SPECS !== 'undefined' && PAGE_SPECS[pageSize]) || (typeof PAGE_SPECS !== 'undefined' ? PAGE_SPECS.A4 : null);
    if (!spec) { WARP_W = WARP_H = WARP_LONG_SIDE; return; }
    if (spec.safeH >= spec.safeW) {
      WARP_H = WARP_LONG_SIDE;
      WARP_W = Math.max(1, Math.round(WARP_LONG_SIDE * spec.safeW / spec.safeH));
    } else {
      WARP_W = WARP_LONG_SIDE;
      WARP_H = Math.max(1, Math.round(WARP_LONG_SIDE * spec.safeH / spec.safeW));
    }
  }
  // Fiducials get small in-frame fast at typical dry-fire distances (2-3m)
  // with a phone's default (wide) field of view — this threshold, plus the
  // digital zoom below, is what lets auto-lock work without walking up to
  // the target. Lower this further if lock still only happens up close.
  const MIN_QUAD_AREA_FRAC = 0.00018; // fraction of frame area
  const MAX_QUAD_AREA_FRAC = 0.08;
  const LOCK_STABLE_FRAMES = 5;       // consecutive good detections before locking
  const CORNER_JITTER_TOL = 18;       // px, how much corners may move and still count as "stable" (handheld @ zoom)
  // MUST stay well below the printed shapes' own area, or a red/green shape
  // on the target itself can pass as "a red/green blob of plausible size"
  // and register as a false hit — which is exactly what was happening at
  // 2500: a target shape's radius (35-60 grid units) works out to roughly
  // 1385-4070 px^2 in the warp canvas, so 2500 overlapped the smaller
  // half of that range. A real laser dot at typical dry-fire distance,
  // even blooming from overexposure, should be much smaller than an aimable
  // printed shape — 800 leaves comfortable room for bloom while staying
  // clearly under the smallest shape's ~1385.
  const LASER_MIN_AREA = 3, LASER_MAX_AREA = 800;     // px^2 in the warp canvas
  const LASER_BLUR_KERNEL = 31; // px, must be odd — shared by the destello local-contrast blur below
  // "Destello" (flash) detection — GRAYSCALE, not color. Added directly from
  // the user's own idea after repeated real-footage evidence (an entire 0/8
  // drill where every false positive landed on the same red printed circle,
  // with the live "crudo" marker confirming it, no laser visible): the
  // color-ratio approach above (LASER_CHANNEL_MARGIN) has to treat a red or
  // yellow printed shape's OWN color as close to its own pass/fail line,
  // which makes it simultaneously weaker at finding a real dot there AND
  // noisier (small random pixel variation on a background that's already
  // near-threshold crosses it easily) — a red background is bad in BOTH
  // directions at once, not just one. The user's insight: the app already
  // KNOWS which shape is which color from the target's own metadata, so it
  // never actually needs to classify a pixel's hue to know "is this red or
  // green" — it only needs to know "is this a laser dot at all", and a
  // laser dot's real distinguishing trait is being a small, extremely
  // bright, sharply localized hotspot — true regardless of what color
  // happens to be printed underneath it. So detection below is now PRIMARILY
  // grayscale brightness + local contrast (see mDestello in detectLaserInMat),
  // with the color-ratio test demoted to a loose sanity check (just "isn't
  // obviously the wrong color entirely") instead of the main gate. The
  // trade-off, stated plainly: without a strict color gate, a very bright,
  // very localized non-laser glint (light reflecting off glossy laminate,
  // a phone flashlight, a stray LED) could now also register — something
  // the old approach's color check was there to filter out, even though in
  // practice it wasn't filtering out the red-background false positives
  // this was built to fix. Worth testing for specifically.
  const LASER_DESTELLO_BRIGHTNESS_MIN = 200; // grayscale luma (0-255), near-saturated
  const LASER_DESTELLO_CONTRAST_MIN = 38;    // vs. LASER_LOCAL_CONTRAST_MIN=22 — higher bar since color no longer helps discriminate.
  // Tuned down from an initial 45 after synthetic testing showed a real dot
  // over a bright YELLOW background (itself already close to the dot's own
  // peak brightness, so less local contrast than over a darker background)
  // fell just short — 43 vs 45. Yellow/cream backgrounds are the genuinely
  // hard case for a brightness-based detector for exactly this reason
  // (nothing to do with hue, just: bright-on-bright has lower contrast),
  // so this constant deliberately leaves some margin for that case rather
  // than being tuned to the easiest backgrounds.
  const LASER_LOOSE_COLOR_MARGIN = 8;        // vs. LASER_CHANNEL_MARGIN=28 — just rejects an obviously wrong-hue flash
  const HOLE_MIN_AREA = 15, HOLE_MAX_AREA = 700;
  const HOLE_STABILITY_FRAMES = 3;
  const ZOOM_MIN = 1, ZOOM_MAX = 4, ZOOM_STEP = 0.25;

  let cvReadyResolve;
  let cvIsReadyFlag = false;
  const cvReady = new Promise(res => { cvReadyResolve = res; });
  window.__onOpenCvReady = () => { cvIsReadyFlag = true; cvReadyResolve(true); };

  let stream = null, videoEl = null;
  let state = 'IDLE'; // IDLE | SEARCHING | LOCKED
  let rafId = null;
  let corners = null;         // ordered [tl,tr,bl,br] in (zoomed) video pixel coords
  let stableCount = 0;
  let calibration = null;
  let warpCanvas = null, warpCtx = null;
  let previewCanvas = null, previewCtx = null; // visible pre-lock feed — same crop the detector sees
  let onFrameCb = null, onStateCb = null;
  let zoomFactor = 1;
  let lockedAspect = null; // videoWidth/videoHeight recorded at lock time — see orientation guard in frameLoop
  let lockedTrackCounter = 0; // throttles continuous corner re-tracking while LOCKED (see frameLoop)
  // Buffer of recent re-tracked corner readings while LOCKED, used to
  // require several CONSECUTIVE, mutually-agreeing readings before actually
  // moving the locked corners — see the big comment above the tracking
  // block in frameLoop for why single-frame updates turned out to be a
  // real problem on a tripod (the normal case this app is used in).
  let trackCandidateBuffer = [];
  // Tightened after real footage (build 2026-08-25.13/.14 testing) showed a
  // visible double-exposure "ghost" of every printed shape in the warped
  // frame — the locked corners still nudging themselves by a few pixels
  // often enough to be visible, even with the 3-reading confirmation added
  // in build .12. On a tripod the correct answer is closer to "basically
  // never move once locked": require twice as many consecutive agreeing
  // readings, require them to agree with each other more tightly, and apply
  // a gentler correction even once confirmed (see `smoothing` below) so any
  // update that does go through is small enough not to visibly jump.
  const TRACK_CONFIRM_READINGS = 6; // consecutive agreeing re-checks required before applying a shift
  const TRACK_AGREE_TOL = 4;        // px, how tightly consecutive readings must match EACH OTHER

  // Best-effort exposure nudge. A laser dot is a small, very bright spot
  // hitting a sensor that's otherwise auto-exposing for the whole scene —
  // strong ambient light can push the camera's auto-exposure down enough
  // that the dot stops clearing LASER_DESTELLO_BRIGHTNESS_MIN, or push it up enough
  // that everything (including printed shapes) blooms toward white and the
  // dot stops standing out. `exposureCompensation` (negative = darker) is
  // the one control with meaningfully broad browser/device support; full
  // manual ISO/shutter (`exposureMode: 'manual'`) exists on very few Android
  // Chrome builds, so it's not attempted here — this only touches the one
  // lever likely to actually work, and only nudges it partway, not to an
  // extreme, so normal color/shape visibility isn't sacrificed for it.
  // NOTE: unverified against real hardware (no camera in this dev sandbox) —
  // exposed via getExposureInfo() so the diagnostic panel can show whether
  // it actually engaged on a given phone.
  let exposureInfo = { supported: false, applied: false, value: null, error: null };
  function tryAdjustExposure(track) {
    exposureInfo = { supported: false, applied: false, value: null, error: null };
    try {
      if (!track.getCapabilities) return;
      const caps = track.getCapabilities();
      if (!caps || !('exposureCompensation' in caps)) return;
      const range = caps.exposureCompensation;
      exposureInfo.supported = true;
      // Move 25% of the way from the midpoint toward the minimum (darker) —
      // conservative on purpose, see note above.
      const mid = (range.min + range.max) / 2;
      const target = mid - (mid - range.min) * 0.25;
      const step = range.step || 1;
      const value = Math.round(target / step) * step;
      track.applyConstraints({ advanced: [{ exposureCompensation: value }] })
        .then(() => { exposureInfo.applied = true; exposureInfo.value = value; })
        .catch(err => { exposureInfo.error = String(err && err.message || err); });
    } catch (err) {
      exposureInfo.error = String(err && err.message || err);
    }
  }
  function getExposureInfo() { return exposureInfo; }

  function setState(s) { state = s; if (onStateCb) onStateCb(s); }

  // The ONLY manual control the shooter needs (per spec): a zoom so a target
  // that's small in-frame at a few meters' distance still fills enough of
  // the image for the fiducials to be detectable. This was software-only
  // (crop the center of the raw frame, scale it up) because real hardware
  // zoom support varies wildly across phones — but "varies" isn't "never
  // there", and a pure digital crop throws away real sensor resolution the
  // whole time it's active (worse at higher zoom), which likely made the
  // blurry/low-detail look reported at 3.5x zoom worse than it needed to be.
  // Chrome on Android exposes real optical/hybrid zoom through the same
  // MediaStreamTrack constraints API as exposureCompensation above, on
  // phones/browsers that support it — `getCapabilities().zoom` gives a
  // {min,max,step} range, and `applyConstraints({advanced:[{zoom}]})` drives
  // the actual camera hardware. detectZoomCapability() below feature-detects
  // this once per stream; when it's there, our 1x-4x UI slider maps onto the
  // camera's own real zoom range and drawZoomed() below skips the digital
  // crop entirely (no need to also crop when the hardware already zoomed) —
  // when it's not there (most phones, still), everything falls back to
  // exactly the digital-crop behavior this always had. Either way it's
  // feature-detected per-device and never assumed, same pattern as the
  // exposure nudge. NOTE: unverified against real hardware that actually
  // supports it — the zoom slider testing so far has only exercised the
  // digital-crop fallback path (the "no real zoom capability" case). Exposed
  // via getZoomInfo() so the diagnostic panel can show which path is active.
  let currentTrack = null;
  let zoomCapability = { supported: false, min: 1, max: 1, step: 0.1 };
  let hardwareZoomApplied = false;
  function detectZoomCapability(track) {
    zoomCapability = { supported: false, min: 1, max: 1, step: 0.1 };
    hardwareZoomApplied = false;
    try {
      if (!track.getCapabilities) return;
      const caps = track.getCapabilities();
      if (!caps || !('zoom' in caps)) return;
      zoomCapability = { supported: true, min: caps.zoom.min, max: caps.zoom.max, step: caps.zoom.step || 0.1 };
    } catch (err) { /* leave unsupported */ }
  }
  function applyHardwareZoom() {
    if (!zoomCapability.supported || !currentTrack) { hardwareZoomApplied = false; return; }
    // Map our abstract ZOOM_MIN-ZOOM_MAX UI range onto the camera's own
    // real zoom range.
    const frac = (zoomFactor - ZOOM_MIN) / (ZOOM_MAX - ZOOM_MIN);
    const raw = zoomCapability.min + frac * (zoomCapability.max - zoomCapability.min);
    const stepped = Math.round(raw / zoomCapability.step) * zoomCapability.step;
    currentTrack.applyConstraints({ advanced: [{ zoom: stepped }] })
      .then(() => { hardwareZoomApplied = true; })
      .catch(() => { hardwareZoomApplied = false; });
  }
  function getZoomInfo() { return { supported: zoomCapability.supported, applied: hardwareZoomApplied, range: zoomCapability.supported ? { min: zoomCapability.min, max: zoomCapability.max } : null }; }

  // Changing zoom mid-search invalidates whatever "stable" streak was
  // building: cornersStable() only compares raw pixel positions between
  // consecutive search-canvas frames, with no idea that the zoom crop itself
  // just shifted — a real, static target can look "stable" across a couple
  // of frames spanning a zoom change purely by coincidence (jitter tolerance
  // is generous, 18px, specifically to survive handheld tremor), while the
  // corners those frames actually reported may belong to two DIFFERENT crops
  // of the source video. If that mismatched pair sneaks past the stability
  // check, the final full-res warp is computed from a corner set that never
  // consistently described any single frame — producing a warped image that
  // looks like a blurry, wrong sub-region of the target stretched to fill
  // the canvas (structured enough to slip past the flat-color WARP_STD_MIN
  // reject, but visually wrong) instead of a clean crop. This showed up in
  // real footage right after the zoom slider was dragged from 1.0x to 3.5x
  // during the search phase, immediately before a bad lock. Fix: any zoom
  // change while still searching drops the current streak and starts over
  // at the new zoom level, so a locked frame's corners always come from
  // frames captured at one single, unchanging zoom.
  function setZoom(z) {
    zoomFactor = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
    if (state === 'SEARCHING') { corners = null; stableCount = 0; }
    applyHardwareZoom();
    return zoomFactor;
  }
  function getZoom() { return zoomFactor; }
  function drawZoomed(ctx, destW, destH) {
    const vw = videoEl.videoWidth, vh = videoEl.videoHeight;
    // Hardware zoom already narrowed the sensor's field of view, so cropping
    // again on top of that would double-zoom (and double-crop resolution
    // away for nothing) — only apply the digital crop when hardware zoom
    // isn't actually engaged.
    const digitalFactor = hardwareZoomApplied ? 1 : zoomFactor;
    const cw = vw / digitalFactor, ch = vh / digitalFactor;
    const sx = (vw - cw) / 2, sy = (vh - ch) / 2;
    ctx.drawImage(videoEl, sx, sy, cw, ch, 0, 0, destW, destH);
  }

  // --- keep the screen awake during a training session --------------------
  // A shooter's hands are full (gun in one, trigger discipline, etc.) — the
  // phone screen dimming/locking mid-drill because nobody touched it for a
  // while would kill the camera preview (and on some browsers, the camera
  // stream itself) right when it's needed. The Wake Lock API is the
  // standard way to prevent that; it's supported in Chrome/Brave for
  // Android (what this app targets) but feature-detected regardless since
  // support isn't universal — if it's missing, this silently no-ops and the
  // phone's normal screen-timeout behavior applies, same as before. The
  // browser also force-releases any wake lock when the tab is backgrounded/
  // hidden (there's nothing a page can do about that — that's Android
  // putting the whole browser to sleep, not just dimming the screen), so
  // this re-acquires it automatically when the tab becomes visible again
  // while the camera is still meant to be active.
  let wakeLock = null;
  async function acquireWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        wakeLock = await navigator.wakeLock.request('screen');
      }
    } catch (err) { wakeLock = null; }
  }
  function releaseWakeLock() {
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && stream && (state === 'SEARCHING' || state === 'LOCKED')) {
        acquireWakeLock();
      }
    });
  }

  async function start(video, { facingMode = 'environment' } = {}) {
    videoEl = video;
    zoomFactor = 1;
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    const track = stream.getVideoTracks()[0];
    currentTrack = track || null;
    if (track) { tryAdjustExposure(track); detectZoomCapability(track); applyHardwareZoom(); }
    acquireWakeLock();
    warpCanvas = document.createElement('canvas');
    warpCanvas.width = WARP_W; warpCanvas.height = WARP_H;
    warpCtx = warpCanvas.getContext('2d', { willReadFrequently: true });
    previewCanvas = document.createElement('canvas');
    previewCanvas.width = 480; previewCanvas.height = Math.round(480 * video.videoHeight / video.videoWidth) || 360;
    previewCtx = previewCanvas.getContext('2d', { willReadFrequently: true });
    startPreviewOnlyLoop();
  }

  // Draws the live (zoomed) camera feed into previewCanvas without touching
  // OpenCV at all. Runs from the instant the camera turns on, independent of
  // whether OpenCV.js has finished downloading yet. Without this, the only
  // thing that ever drew into previewCanvas was frameLoop() (search/lock),
  // which never starts until lock() is called — and lock()'s caller
  // (startLock() in drill.js/livefire.js) waits on OpenCV.js to finish
  // loading first. On a slow connection that's a real gap of a second or
  // more with camera permission granted and a stream running, but nothing
  // visible on screen — reported as "activo la cámara y queda en negro
  // hasta que uso auto lock". This loop closes that gap: the raw feed (and
  // therefore the zoom control acting on it) is visible immediately: cv
  // hasn't loaded yet, but there's nothing about drawing a video frame to a
  // canvas that needs it. frameLoop() takes over the same canvas once
  // corner search actually starts (see the cancel at the top of frameLoop).
  let previewRafId = null;
  function startPreviewOnlyLoop() {
    function step() {
      previewRafId = requestAnimationFrame(step);
      if (!videoEl || videoEl.readyState < 2 || !previewCtx) return;
      const vw = videoEl.videoWidth, vh = videoEl.videoHeight;
      if (!vw || !vh) return;
      const pw = 480, ph = Math.round(480 * vh / vw);
      if (previewCanvas.width !== pw || previewCanvas.height !== ph) {
        previewCanvas.width = pw; previewCanvas.height = ph;
      }
      drawZoomed(previewCtx, pw, ph);
    }
    if (previewRafId) cancelAnimationFrame(previewRafId);
    step();
  }

  function stop() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    if (previewRafId) cancelAnimationFrame(previewRafId);
    previewRafId = null;
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    state = 'IDLE'; corners = null; stableCount = 0; calibration = null; zoomFactor = 1;
    lockedAspect = null; lockedTrackCounter = 0; trackCandidateBuffer = [];
    exposureInfo = { supported: false, applied: false, value: null, error: null };
    currentTrack = null;
    zoomCapability = { supported: false, min: 1, max: 1, step: 0.1 };
    hardwareZoomApplied = false;
    releaseWakeLock();
  }

  // order 4 arbitrary points into [top-left, top-right, bottom-left, bottom-right]
  function orderCorners(pts) {
    const sum = pts.map(p => p.x + p.y);
    const diff = pts.map(p => p.y - p.x);
    const tl = pts[sum.indexOf(Math.min(...sum))];
    const br = pts[sum.indexOf(Math.max(...sum))];
    const tr = pts[diff.indexOf(Math.min(...diff))];
    const bl = pts[diff.indexOf(Math.max(...diff))];
    return [tl, tr, bl, br];
  }

  function findFiducialCandidates(gray, frameArea) {
    const bin = new cv.Mat();
    cv.threshold(gray, bin, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(bin, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    const candidates = [];
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const area = cv.contourArea(c);
      const frac = area / frameArea;
      if (frac > MIN_QUAD_AREA_FRAC && frac < MAX_QUAD_AREA_FRAC) {
        const approx = new cv.Mat();
        const peri = cv.arcLength(c, true);
        cv.approxPolyDP(c, approx, 0.05 * peri, true);
        if (approx.rows === 4) {
          const rect = cv.boundingRect(approx);
          const aspect = rect.width / rect.height;
          // Was 0.6-1.6, which only tolerates a nearly head-on view. Widening
          // it all the way to 0.28-3.6 (a prior pass) let real fiducials at
          // an angle through, but also let through enough noise (skin
          // creases, wood-grain edges, shadows) that pickBestFourCorners
          // sometimes "locked" onto garbage — producing a corrupted
          // homography that warps to a flat, meaningless block of color
          // instead of the actual target. 0.4-2.5 is the compromise: still
          // clearly looser than the original for oblique angles, but the
          // real backstop against a bad lock is isWarpDegenerate() below,
          // which now refuses to accept a LOCKED frame that doesn't
          // actually look like a photo.
          if (aspect > 0.4 && aspect < 2.5) {
            // Centroid of the 4 actual vertices, NOT the bounding-box
            // center — those only coincide for an axis-aligned square. Once
            // a fiducial is viewed at an angle (which the widened aspect
            // filter above now allows through, on purpose) its quad is a
            // skewed trapezoid, and the bounding-box center can sit visibly
            // off from where the corner actually is. That few-pixel error
            // gets amplified by the perspective transform into the "shapes
            // are ghosted/offset from the photo" misalignment reported after
            // locking at anything but a very square-on angle.
            let sumX = 0, sumY = 0;
            for (let k = 0; k < 4; k++) { sumX += approx.data32S[k * 2]; sumY += approx.data32S[k * 2 + 1]; }
            candidates.push({ x: sumX / 4, y: sumY / 4, area });
          }
        }
        approx.delete();
      }
      c.delete();
    }
    bin.delete(); contours.delete(); hierarchy.delete();
    return candidates;
  }

  function pickBestFourCorners(candidates, w, h) {
    if (candidates.length < 4) return null;
    // score by proximity to each of the 4 image quadrant-corners — the
    // fiducials are always near the corners of the frame once roughly aligned
    const targets = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: 0, y: h }, { x: w, y: h }];
    const picked = [];
    for (const t of targets) {
      let best = null, bestD = Infinity;
      for (const c of candidates) {
        const d = Math.hypot(c.x - t.x, c.y - t.y);
        if (d < bestD) { bestD = d; best = c; }
      }
      if (!best || bestD > Math.hypot(w, h) * 0.55) return null; // too far from any corner
      picked.push(best);
    }
    const ordered = orderCorners(picked);
    if (!isConvexQuad(ordered)) return null; // self-intersecting/bowtie -> would corrupt the homography
    return ordered;
  }

  // 4 corners with a consistent turn direction all the way around = a proper
  // (convex or at worst simple) quadrilateral. If a noisy/false candidate got
  // matched to one of the 4 corner slots, the quad can come out self-
  // intersecting ("bowtie") instead — feeding that into getPerspectiveTransform
  // produces a folded, meaningless mapping, which is one of the ways the
  // warped view can end up as a flat block of one color instead of the photo.
  function isConvexQuad(pts) {
    const poly = [pts[0], pts[1], pts[3], pts[2]]; // tl,tr,br,bl -> proper winding order
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = poly[i], b = poly[(i + 1) % 4], c = poly[(i + 2) % 4];
      const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      const s = Math.sign(cross);
      if (s === 0) continue;
      if (sign === 0) sign = s;
      else if (s !== sign) return false;
    }
    return true;
  }

  // Second, independent backstop: even a geometrically valid quad can be
  // wrong (matched to the wrong 4 features), which shows up as a warp that
  // doesn't look like an actual photo — usually a near-uniform flat color,
  // because the transform sampled a tiny sliver of the source frame and
  // stretched it across the whole warp canvas. A real printed target photo
  // always has real variance (paper texture, shapes, camera sensor noise);
  // a degenerate one doesn't. This is what actually stops a bad lock from
  // ever reaching the screen, regardless of why the corners were wrong.
  const WARP_STD_MIN = 12;
  // Returns the raw std value (not just pass/fail) so callers can both check
  // it against WARP_STD_MIN and, in debug mode, show the shooter the actual
  // number instead of a silent reject.
  function warpStdDev(mat) {
    const meanMat = new cv.Mat(), stdMat = new cv.Mat();
    cv.meanStdDev(mat, meanMat, stdMat);
    let maxStd = 0;
    for (let i = 0; i < stdMat.data64F.length; i++) maxStd = Math.max(maxStd, stdMat.data64F[i]);
    meanMat.delete(); stdMat.delete();
    return maxStd;
  }

  function cornersStable(a, b, tol) {
    if (!a || !b) return false;
    const t = tol === undefined ? CORNER_JITTER_TOL : tol;
    for (let i = 0; i < 4; i++) {
      if (Math.hypot(a[i].x - b[i].x, a[i].y - b[i].y) > t) return false;
    }
    return true;
  }

  function computeHomographyAndWarp(src, ordered) {
    const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
      ordered[0].x, ordered[0].y, ordered[1].x, ordered[1].y,
      ordered[2].x, ordered[2].y, ordered[3].x, ordered[3].y,
    ]);
    // destination = the fiducial CENTER positions in grid units, scaled
    // per-axis to WARP_W/WARP_H (NOT a single shared factor — see the
    // WARP_W/WARP_H comment above for why a single square scale was wrong).
    const sx = WARP_W / GRID, sy = WARP_H / GRID;
    const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
      FIDUCIAL_MARGIN * sx, FIDUCIAL_MARGIN * sy,
      (GRID - FIDUCIAL_MARGIN) * sx, FIDUCIAL_MARGIN * sy,
      FIDUCIAL_MARGIN * sx, (GRID - FIDUCIAL_MARGIN) * sy,
      (GRID - FIDUCIAL_MARGIN) * sx, (GRID - FIDUCIAL_MARGIN) * sy,
    ]);
    const M = cv.getPerspectiveTransform(srcTri, dstTri);
    const dst = new cv.Mat();
    cv.warpPerspective(src, dst, M, new cv.Size(WARP_W, WARP_H));
    srcTri.delete(); dstTri.delete(); M.delete();
    return dst;
  }

  function runLumaCalibration(warpedRgba) {
    const gray = new cv.Mat();
    cv.cvtColor(warpedRgba, gray, cv.COLOR_RGBA2GRAY);
    const bin = new cv.Mat();
    const t = cv.threshold(gray, bin, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    gray.delete(); bin.delete();
    return { threshold: t, calibratedAt: Date.now() };
  }

  function frameLoop() {
    if (previewRafId) { cancelAnimationFrame(previewRafId); previewRafId = null; }
    rafId = requestAnimationFrame(frameLoop);
    if (!videoEl || videoEl.readyState < 2) return;

    const w = videoEl.videoWidth, h = videoEl.videoHeight;
    if (!w || !h) return;

    if (!frameLoop._canvas) {
      frameLoop._canvas = document.createElement('canvas');
      frameLoop._ctx = frameLoop._canvas.getContext('2d', { willReadFrequently: true });
    }
    const fc = frameLoop._canvas, fctx = frameLoop._ctx;
    // downscale search frame for perf — drawZoomed applies the digital zoom
    // crop, so this is the SAME view the detector reasons over as what the
    // user sees in the preview canvas below.
    const searchW = 480, searchH = Math.round(480 * h / w);
    fc.width = searchW; fc.height = searchH;
    drawZoomed(fctx, searchW, searchH);

    if (previewCtx) {
      previewCanvas.width = searchW; previewCanvas.height = searchH;
      previewCtx.drawImage(fc, 0, 0);
    }

    if (state !== 'LOCKED') {
      const src = cv.imread(fc);
      const gray = new cv.Mat();
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      cv.GaussianBlur(gray, gray, new cv.Size(3, 3), 0);
      const candidates = findFiducialCandidates(gray, searchW * searchH);
      const found = pickBestFourCorners(candidates, searchW, searchH);
      gray.delete(); src.delete();

      if (found) {
        if (cornersStable(corners, found)) stableCount++; else stableCount = 1;
        corners = found;
        setState('SEARCHING');
        if (onFrameCb) onFrameCb({ state: 'SEARCHING', progress: stableCount / LOCK_STABLE_FRAMES, previewCanvas, corners: found, searchW, searchH, debug: debugMode ? { candidateCount: candidates.length, videoW: w, videoH: h } : null });
        if (stableCount >= LOCK_STABLE_FRAMES) {
          // scale corners up to the full (zoomed) frame before warping
          const scaleX = w / searchW, scaleY = h / searchH;
          const scaled = corners.map(c => ({ x: c.x * scaleX, y: c.y * scaleY }));
          fc.width = w; fc.height = h;
          drawZoomed(fctx, w, h);
          const fullSrc = cv.imread(fc);
          const warped = computeHomographyAndWarp(fullSrc, scaled);
          fullSrc.delete();
          const std = warpStdDev(warped);
          if (std < WARP_STD_MIN) {
            // Geometrically "4 corners found", but the resulting image isn't
            // a real photo — reject this lock attempt instead of showing a
            // flat colored block. Reset and keep searching; a different
            // frame/angle will usually pick different (correct) candidates.
            warped.delete();
            corners = null; stableCount = 0;
            if (onFrameCb) onFrameCb({ state: 'SEARCHING', progress: 0, previewCanvas, corners: null, searchW, searchH, debug: debugMode ? { rejectedWarpStd: std, required: WARP_STD_MIN } : null });
          } else {
            calibration = runLumaCalibration(warped);
            cv.imshow(warpCanvas, warped);
            warped.delete();
            lockedAspect = w / h;
            setState('LOCKED');
            if (onFrameCb) onFrameCb({ state: 'LOCKED', calibration, canvas: warpCanvas });
          }
        }
      } else {
        corners = null; stableCount = 0;
        setState('SEARCHING');
        if (onFrameCb) onFrameCb({ state: 'SEARCHING', progress: 0, previewCanvas, corners: null, searchW, searchH, debug: debugMode ? { candidateCount: candidates.length, videoW: w, videoH: h } : null });
      }
      return;
    }

    // LOCKED.
    // Guard: `corners` are stored in raw video-pixel coordinates from the
    // frame at lock time. If the video's own aspect ratio changes mid-lock
    // (phone physically rotated, or the browser swaps camera resolution),
    // those pixel coordinates no longer point at the same physical spot in
    // the new frame — same underlying issue as a fixed rotationDegrees on
    // Android. Cheap fix: if the aspect ratio drifts meaningfully, drop back
    // to SEARCHING instead of silently warping from stale corners.
    if (lockedAspect && Math.abs(w / h - lockedAspect) / lockedAspect > 0.12) {
      corners = null; stableCount = 0; calibration = null; lockedAspect = null; trackCandidateBuffer = [];
      setState('SEARCHING');
      if (onFrameCb) onFrameCb({ state: 'SEARCHING', progress: 0, previewCanvas, corners: null, searchW, searchH, debug: debugMode ? { reason: 'orientation-changed' } : null });
      return;
    }

    // Continuous corner tracking, NOT a one-shot lock. This used to just
    // re-warp every frame from the exact corner pixel-positions found at the
    // moment of lock, forever — fine on a tripod, but a handheld phone drifts
    // a few pixels between frames from ordinary hand tremor. That meant the
    // projected overlay only lined up with the live camera image at the
    // instant of lock; every frame after that kept warping from a
    // increasingly stale position while the real target (and the real laser
    // hit on it) moved on with the hand. Fix: re-run the same cheap low-res
    // corner search SEARCHING already does, every other LOCKED frame too.
    //
    // BUT: applying every single one of those re-checks directly (blended in
    // at 40%, one frame at a time) turned out to cause a NEW problem, seen
    // on real footage from a shooter who — like most people actually using
    // this app — has the phone on a tripod, perfectly static. On a tripod,
    // the true corners never need to move at all, so any small movement this
    // re-check reports is pure detector noise (a slightly different quad
    // picked due to a lighting flicker, motion blur from someone walking by,
    // compression artifacts) — not a real position change. Blending 40%
    // toward that noise, repeatedly, every ~4 frames, is a random walk: the
    // locked corners drift on their own even though nothing in the scene
    // moved, which is exactly "sigue recalibrando todo el tiempo... pierde
    // una de las esquinas y se mueve" — and since hit-detection tests the
    // laser position against the CURRENT (possibly noise-drifted) grid, that
    // drift produces false misses/wrong-shape hits with nothing wrong in the
    // shooter's aim.
    //
    // Fix: require several CONSECUTIVE re-checks that agree closely with
    // EACH OTHER (not just with the old corners) before actually moving
    // anything. Single-frame noise essentially never repeats itself closely
    // 3 times in a row, so it gets filtered out; a REAL, persistent change
    // (the tripod actually got bumped) does repeat and still gets applied
    // within a handful of frames — just no longer on every noisy blip.
    lockedTrackCounter++;
    if (lockedTrackCounter % 2 === 0) {
      fc.width = searchW; fc.height = searchH;
      drawZoomed(fctx, searchW, searchH);
      const trackSrc = cv.imread(fc);
      const trackGray = new cv.Mat();
      cv.cvtColor(trackSrc, trackGray, cv.COLOR_RGBA2GRAY);
      cv.GaussianBlur(trackGray, trackGray, new cv.Size(3, 3), 0);
      const trackCandidates = findFiducialCandidates(trackGray, searchW * searchH);
      const trackFound = pickBestFourCorners(trackCandidates, searchW, searchH);
      trackGray.delete(); trackSrc.delete();
      if (trackFound) {
        const lastBuffered = trackCandidateBuffer[trackCandidateBuffer.length - 1];
        if (lastBuffered && cornersStable(lastBuffered, trackFound, TRACK_AGREE_TOL)) {
          trackCandidateBuffer.push(trackFound);
        } else {
          trackCandidateBuffer = [trackFound]; // doesn't match the streak — start a new one
        }
        if (trackCandidateBuffer.length >= TRACK_CONFIRM_READINGS && corners) {
          const maxJumpPerCorner = Math.hypot(searchW, searchH) * 0.15;
          const plausible = corners.every((c, i) => Math.hypot(c.x - trackFound[i].x, c.y - trackFound[i].y) < maxJumpPerCorner);
          if (plausible) {
            const smoothing = 0.25; // 0 = ignore new detection, 1 = snap fully to it
            corners = corners.map((c, i) => ({
              x: c.x + (trackFound[i].x - c.x) * smoothing,
              y: c.y + (trackFound[i].y - c.y) * smoothing,
            }));
          }
          trackCandidateBuffer = []; // acted on it (or rejected as implausible) — start fresh
        }
      } else {
        // No 4 good candidates this check — an incomplete/ambiguous reading
        // shouldn't count toward (or silently continue) a confirmation
        // streak either way, so it just resets, same graceful degrade as
        // before: keep the last known corners and try again next check.
        trackCandidateBuffer = [];
      }
    }

    const scaleX = w / searchW, scaleY = h / searchH;
    fc.width = w; fc.height = h;
    drawZoomed(fctx, w, h);
    const fullSrc = cv.imread(fc);
    const scaled = corners.map(c => ({ x: c.x * scaleX, y: c.y * scaleY }));
    const warped = computeHomographyAndWarp(fullSrc, scaled);
    fullSrc.delete();
    const lockedStd = warpStdDev(warped);
    if (lockedStd < WARP_STD_MIN) {
      // Was fine at lock time but has gone bad since (phone moved, zoom
      // changed, lighting shifted) — don't keep showing a flat block of
      // color as if it were LOCKED. Drop back to searching automatically.
      warped.delete();
      corners = null; stableCount = 0; calibration = null; trackCandidateBuffer = [];
      setState('SEARCHING');
      if (onFrameCb) onFrameCb({ state: 'SEARCHING', progress: 0, previewCanvas, corners: null, searchW, searchH, debug: debugMode ? { rejectedWarpStd: lockedStd, required: WARP_STD_MIN } : null });
      return;
    }
    cv.imshow(warpCanvas, warped);
    if (onFrameCb) onFrameCb({ state: 'LOCKED', calibration, canvas: warpCanvas, mat: warped });
    else warped.delete();
  }

  function lock(onFrame, onStateChange, pageSize) {
    onFrameCb = onFrame; onStateCb = onStateChange;
    if (pageSize) setPageAspect(pageSize);
    corners = null; stableCount = 0; calibration = null; lockedTrackCounter = 0; trackCandidateBuffer = [];
    setState('SEARCHING');
    if (rafId) cancelAnimationFrame(rafId);
    frameLoop();
  }

  function relock() {
    corners = null; stableCount = 0; calibration = null; lockedTrackCounter = 0; trackCandidateBuffer = [];
    setState('SEARCHING');
  }

  // --- diagnostics ---------------------------------------------------------
  // No real camera in this dev environment to tune the constants above
  // against, so instead of guessing blind: this surfaces the ACTUAL numbers
  // the detector is computing, live, on the shooter's own screen. Off by
  // default (skips the extra minMaxLoc/countNonZero calls — cheap, but no
  // reason to pay them when nobody's looking); toggled on from the Dry Fire
  // screen's "Diagnóstico" button.
  let debugMode = false;
  let lastLaserDebug = null;
  function setDebug(v) { debugMode = !!v; if (!debugMode) lastLaserDebug = null; }
  function getLastLaserDebug() { return lastLaserDebug; }

  // --- laser dot detection (dry fire) -------------------------------------
  // Switched from absolute HSV range-matching to a channel-RATIO test: does
  // R clearly beat both G and B (for red), or G clearly beat both R and B
  // (for green)? This is the standard trick for laser-dot detection because
  // a laser hitting a phone's sensor is usually so bright it overexposes —
  // the pixel blooms toward white, which TANKS its saturation and can push
  // it clean out of a fixed HSV "red" band even though it's obviously a red
  // dot to the eye. A relative test survives that, and also survives unequal
  // lighting/white-balance across the frame (e.g. one side of the target
  // sitting in more shadow than the other), which a fixed absolute threshold
  // does not — that mismatch is the most likely reason detection worked in
  // one region of a locked frame but silently missed an equally obvious dot
  // in another.
  function detectLaserInMat(rgbaMat, colorId) {
    const rgb = new cv.Mat();
    cv.cvtColor(rgbaMat, rgb, cv.COLOR_RGBA2RGB);
    const planes = new cv.MatVector();
    cv.split(rgb, planes);
    const R = planes.get(0), G = planes.get(1), B = planes.get(2);
    const primary = colorId === 'green' ? G : R;
    const other1 = colorId === 'green' ? R : G;
    const other2 = B;

    // Color-ratio numbers — kept ONLY for the debug panel's reference
    // display now (see LASER_DESTELLO_* comment above for why they're no
    // longer the detection gate itself).
    const diff1 = new cv.Mat(), diff2 = new cv.Mat();
    cv.subtract(primary, other1, diff1); // uint8 subtract clamps negatives to 0
    cv.subtract(primary, other2, diff2);

    // PRIMARY detector: grayscale "destello" (flash) — a laser dot is a
    // small, extremely bright, sharply-localized hotspot, regardless of what
    // color happens to be printed underneath it. See the big comment on
    // LASER_DESTELLO_BRIGHTNESS_MIN above for the full reasoning and the
    // real-footage evidence (a full 0/8 drill, every false positive on the
    // same red printed circle) that motivated dropping the color-ratio test
    // as the primary gate.
    const gray = new cv.Mat();
    cv.cvtColor(rgbaMat, gray, cv.COLOR_RGBA2GRAY);
    const mBrightG = new cv.Mat();
    cv.threshold(gray, mBrightG, LASER_DESTELLO_BRIGHTNESS_MIN, 255, cv.THRESH_BINARY);
    const blurredG = new cv.Mat();
    cv.GaussianBlur(gray, blurredG, new cv.Size(LASER_BLUR_KERNEL, LASER_BLUR_KERNEL), 0);
    const contrastG = new cv.Mat();
    cv.subtract(gray, blurredG, contrastG); // uint8 subtract clamps negatives to 0
    const mContrastG = new cv.Mat();
    cv.threshold(contrastG, mContrastG, LASER_DESTELLO_CONTRAST_MIN, 255, cv.THRESH_BINARY);
    const mDestello = new cv.Mat();
    cv.bitwise_and(mBrightG, mContrastG, mDestello);

    // Loose color sanity check — NOT a precision gate like the old
    // LASER_CHANNEL_MARGIN=28. Just rejects a flash that's obviously the
    // wrong hue entirely (e.g. a blue-white glare when the selected laser is
    // red); tolerant enough that a real dot sitting on ITS OWN matching or
    // even an opposite-colored printed background still passes easily.
    const mLooseColor = new cv.Mat();
    cv.threshold(diff1, mLooseColor, LASER_LOOSE_COLOR_MARGIN, 255, cv.THRESH_BINARY);

    const mask = new cv.Mat();
    cv.bitwise_and(mDestello, mLooseColor, mask);

    if (debugMode) {
      // The single brightest-margin pixel in the WHOLE frame, whether or not
      // it cleared threshold — this is what answers "how close was it?"
      // instead of just pass/fail.
      lastLaserDebug = {
        colorId,
        maxMargin1: cv.minMaxLoc(diff1).maxVal,
        maxMargin2: cv.minMaxLoc(diff2).maxVal,
        maxBrightness: cv.minMaxLoc(gray).maxVal,
        maxLocalContrast: cv.minMaxLoc(contrastG).maxVal,
        maskPixels: cv.countNonZero(mask),
        requiredMargin: LASER_LOOSE_COLOR_MARGIN,
        requiredBrightness: LASER_DESTELLO_BRIGHTNESS_MIN,
        requiredLocalContrast: LASER_DESTELLO_CONTRAST_MIN,
      };
    }

    diff1.delete(); diff2.delete();
    gray.delete(); mBrightG.delete(); blurredG.delete(); contrastG.delete(); mContrastG.delete();
    mDestello.delete(); mLooseColor.delete();
    R.delete(); G.delete(); B.delete(); planes.delete(); rgb.delete();

    // NOTE: this used to be an OPEN (erode-then-dilate) to strip single-pixel
    // noise, inherited from the old color-margin mask which was much looser
    // and needed that cleanup. The destello mask above is already
    // double-gated (bright AND locally-contrasty AND roughly-right-hue), so
    // stray noise pixels essentially can't pass it alone — but that same
    // selectivity means a genuine hit is often only a handful of pixels
    // wide, and erosion was wiping those out entirely before they ever
    // reached findContours (confirmed: a real synthetic dot producing a
    // 4px mask was being erased to 0px by a 3x3 erode). A light DILATE
    // instead consolidates a real hit's pixels into one contour without
    // discarding it; LASER_MIN_AREA/LASER_MAX_AREA below still bound how
    // big the result is allowed to be.
    const kernel = cv.Mat.ones(3, 3, cv.CV_8U);
    cv.dilate(mask, mask, kernel);
    kernel.delete();
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(mask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    let best = null, bestArea = 0, largestAnyArea = 0;
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const area = cv.contourArea(c);
      if (area > largestAnyArea) largestAnyArea = area;
      if (area > LASER_MIN_AREA && area < LASER_MAX_AREA && area > bestArea) {
        const mo = cv.moments(c);
        if (mo.m00 > 0) { best = { x: mo.m10 / mo.m00, y: mo.m01 / mo.m00 }; bestArea = area; }
      }
      c.delete();
    }
    mask.delete(); contours.delete(); hierarchy.delete();

    if (debugMode && lastLaserDebug) {
      // Fills in the part the pixel-level checks above can't answer: was
      // there actually a properly-SIZED blob, not just a bright pixel
      // somewhere in frame?
      lastLaserDebug.detected = !!best;
      lastLaserDebug.largestBlobArea = largestAnyArea;
      lastLaserDebug.requiredAreaMin = LASER_MIN_AREA;
      lastLaserDebug.requiredAreaMax = LASER_MAX_AREA;
    }
    if (!best) return null;
    return { gx: best.x * (GRID / WARP_W), gy: best.y * (GRID / WARP_H) };
  }

  // --- bullet-hole detection via frame diff (live fire) -------------------
  function grayFromMat(rgbaMat) {
    const gray = new cv.Mat();
    cv.cvtColor(rgbaMat, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(3, 3), 0);
    return gray;
  }

  function detectNewHole(currentGray, referenceGray, ignoreMaskCanvasCtx) {
    const diff = new cv.Mat();
    cv.absdiff(currentGray, referenceGray, diff);
    const bin = new cv.Mat();
    cv.threshold(diff, bin, 45, 255, cv.THRESH_BINARY);
    diff.delete();

    if (ignoreMaskCanvasCtx) {
      const maskMat = cv.imread(ignoreMaskCanvasCtx.canvas);
      const maskGray = new cv.Mat();
      cv.cvtColor(maskMat, maskGray, cv.COLOR_RGBA2GRAY);
      const notMask = new cv.Mat();
      cv.bitwise_not(maskGray, notMask);
      cv.bitwise_and(bin, notMask, bin);
      maskMat.delete(); maskGray.delete(); notMask.delete();
    }

    const kernel = cv.Mat.ones(2, 2, cv.CV_8U);
    cv.morphologyEx(bin, bin, cv.MORPH_OPEN, kernel);
    kernel.delete();

    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(bin, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    let best = null, bestArea = 0;
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const area = cv.contourArea(c);
      if (area > HOLE_MIN_AREA && area < HOLE_MAX_AREA && area > bestArea) {
        const m = cv.moments(c);
        if (m.m00 > 0) { best = { x: m.m10 / m.m00, y: m.m01 / m.m00 }; bestArea = area; }
      }
      c.delete();
    }
    bin.delete(); contours.delete(); hierarchy.delete();
    if (!best) return null;
    return { px: best.x, py: best.y, gx: best.x * (GRID / WARP_W), gy: best.y * (GRID / WARP_H) };
  }

  // --- metatag optical decode (auto target recognition) ------------------
  // Reads the printed 6x6 metatag straight off the already-warped/locked
  // frame: sample the center of each cell (avoiding edges, where anti-
  // aliasing/print bleed is worst) and threshold its mean luma against the
  // same Otsu value computed at lock time (`calibration.threshold`) — no
  // extra manual calibration step, consistent with the rest of the pipeline.
  // Returns raw 36 bits, or null if calibration isn't ready yet.
  function decodeMetatagFromWarped(warpedRgba) {
    if (!calibration) return null;
    const gray = new cv.Mat();
    cv.cvtColor(warpedRgba, gray, cv.COLOR_RGBA2GRAY);
    const sx = WARP_W / GRID, sy = WARP_H / GRID;
    const mz = METATAG_ZONE;
    const zx = mz.x0 * sx, zy = mz.y0 * sy;
    const zw = (mz.x1 - mz.x0) * sx, zh = (mz.y1 - mz.y0) * sy;
    const cellW = zw / 6, cellH = zh / 6;
    const inset = 0.25; // sample only the center ~50% of each cell
    const bits = [];
    for (let row = 0; row < 6; row++) {
      for (let col = 0; col < 6; col++) {
        const rx = Math.max(0, Math.min(gray.cols - 1, Math.round(zx + col * cellW + cellW * inset)));
        const ry = Math.max(0, Math.min(gray.rows - 1, Math.round(zy + row * cellH + cellH * inset)));
        const rw = Math.max(1, Math.min(gray.cols - rx, Math.round(cellW * (1 - 2 * inset))));
        const rh = Math.max(1, Math.min(gray.rows - ry, Math.round(cellH * (1 - 2 * inset))));
        const roi = gray.roi(new cv.Rect(rx, ry, rw, rh));
        const mean = cv.mean(roi)[0];
        roi.delete();
        bits.push(mean > calibration.threshold ? 1 : 0);
      }
    }
    gray.delete();
    return bits;
  }

  // Decode + validate (sync pattern, checksum) in one call. Returns whatever
  // Target.decodeBits returns ({valid:false,...} on a bad/unreadable read,
  // or {valid:true, pageSize, mode, distBucket, targetId} on a clean one).
  function decodeMetatag(warpedRgba) {
    const bits = decodeMetatagFromWarped(warpedRgba);
    if (!bits) return { valid: false, reason: 'no-calibration' };
    return Target.decodeBits(bits);
  }

  return {
    cvReady, cvIsReady: () => cvIsReadyFlag, start, stop, lock, relock, setPageAspect,
    get state() { return state; },
    get warpCanvas() { return warpCanvas; },
    get previewCanvas() { return previewCanvas; },
    get WARP_W() { return WARP_W; },
    get WARP_H() { return WARP_H; },
    setZoom, getZoom, ZOOM_MIN, ZOOM_MAX, ZOOM_STEP,
    detectLaserInMat, grayFromMat, detectNewHole, decodeMetatag,
    HOLE_STABILITY_FRAMES,
    setDebug, getLastLaserDebug, getExposureInfo, getZoomInfo,
  };
})();
