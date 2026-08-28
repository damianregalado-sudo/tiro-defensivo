// Non-bypassable 4-step safety gate — branches by what you're actually about
// to do. Dry fire gets the "certify the trainer is set up safely" checklist;
// live fire gets the 4 universal firearm-safety rules + PPE/range-rules
// reminder instead, since certifying "no live ammo" would be dishonest in a
// session where you're specifically loading live ammo. Each step still needs
// a drag-to-confirm gesture (dblclick kept as an accessibility/testing
// fallback). Only after all 4 in the chosen set are true does the app call
// onArmed(mode) to unlock the rest of the UI.
const Safety = (() => {
  const STATE = { DRY: [false, false, false, false], LIVE: [false, false, false, false] };
  let mode = null;
  let onArmed = () => {};

  function containerFor(modeKey) { return $(modeKey === 'DRY' ? '#safetyStepsDry' : '#safetyStepsLive'); }

  function attachSlider(track, idx, modeKey) {
    const thumb = $('.slider-thumb', track);
    const fill = $('.slider-fill', track);
    let dragging = false, startX = 0, thumbStartLeft = 0;
    const maxLeft = () => track.clientWidth - thumb.clientWidth - 6;

    function pointerDown(e) {
      if (track.classList.contains('locked') || track.classList.contains('done')) return;
      dragging = true;
      startX = e.touches ? e.touches[0].clientX : e.clientX;
      thumbStartLeft = thumb.offsetLeft;
    }
    function pointerMove(e) {
      if (!dragging) return;
      const x = e.touches ? e.touches[0].clientX : e.clientX;
      const left = clamp(thumbStartLeft + (x - startX), 3, maxLeft());
      thumb.style.left = left + 'px';
      const pct = (left / maxLeft()) * 100;
      fill.style.width = pct + '%';
      if (pct >= 92) confirmStep();
    }
    function pointerUp() {
      if (!dragging) return;
      dragging = false;
      if (!track.classList.contains('done')) { thumb.style.left = '3px'; fill.style.width = '0%'; }
    }
    function confirmStep() {
      dragging = false;
      track.classList.add('done');
      thumb.style.left = ''; fill.style.width = '';
      STATE[modeKey][idx] = true;
      onProgress(modeKey);
    }

    thumb.addEventListener('pointerdown', pointerDown);
    window.addEventListener('pointermove', pointerMove);
    window.addEventListener('pointerup', pointerUp);
    thumb.addEventListener('touchstart', pointerDown, { passive: true });
    window.addEventListener('touchmove', pointerMove, { passive: true });
    window.addEventListener('touchend', pointerUp);
    track.addEventListener('dblclick', () => {
      if (!track.classList.contains('locked') && !track.classList.contains('done')) confirmStep();
    });
  }

  function onProgress(modeKey) {
    if (modeKey !== mode) return; // ignore updates from the hidden/inactive checklist
    const container = containerFor(modeKey);
    const steps = $$('.safety-step', container);
    const state = STATE[modeKey];
    let completed = 0;
    state.forEach((done, i) => {
      // .collapsed shrinks a DONE step down to a one-line "checkmark + title"
      // row (description + slider hidden via CSS) — requested directly:
      // stepping through the 4-step checklist used to mean scrolling past
      // every earlier step's full card to reach the next one. Only the step
      // you're actively on now keeps its full card.
      if (done) { completed++; steps[i].classList.add('done', 'collapsed'); steps[i].classList.remove('locked'); $('.slider-track', steps[i]).classList.remove('locked'); }
    });
    for (let i = 0; i < 4; i++) {
      const step = steps[i];
      const track = $('.slider-track', step);
      if (i === 0 || state[i - 1]) { step.classList.remove('locked'); if (!state[i]) track.classList.remove('locked'); }
    }
    $('#gateState').textContent = `${completed} / 4 pasos completados — SafetyState.${completed === 4 ? 'ARMED (pendiente confirmar)' : 'LOCKED'}`;
    $('#gateDot').classList.toggle('on', completed === 4);
    $('#btnArm').disabled = completed !== 4;
    renderProgress(completed);
  }

  // "Paso X de 4" header + dots, shown above whichever checklist is active —
  // gives context back for what a collapsed/hidden step layout would
  // otherwise lose (at a glance, how far along you are and how much is
  // left) without needing every step visible at once.
  function renderProgress(completed) {
    const el = $('#safetyProgress');
    if (!el) return;
    const current = Math.min(completed + 1, 4);
    const dots = [0, 1, 2, 3].map(i => {
      const cls = i < completed ? 'dot done' : (i === completed && completed < 4 ? 'dot current' : 'dot');
      return `<span class="${cls}"></span>`;
    }).join('');
    el.innerHTML = `<span>${completed === 4 ? 'Los 4 pasos confirmados' : `Paso ${current} de 4`}</span><span class="dots">${dots}</span>`;
  }

  function resetModeState(modeKey) {
    STATE[modeKey] = [false, false, false, false];
    const container = containerFor(modeKey);
    $$('.safety-step', container).forEach((step, i) => {
      step.classList.toggle('locked', i !== 0);
      step.classList.remove('done', 'collapsed');
      const track = $('.slider-track', step);
      track.classList.toggle('locked', i !== 0);
      track.classList.remove('done');
      $('.slider-thumb', track).style.left = '';
      $('.slider-fill', track).style.width = '';
    });
  }

  function selectMode(m) {
    mode = m;
    resetModeState(m);
    $('#safetyModePicker').style.display = 'none';
    $('#safetyChecklistWrap').style.display = '';
    $('#safetyStepsDry').style.display = m === 'DRY' ? '' : 'none';
    $('#safetyStepsLive').style.display = m === 'LIVE' ? '' : 'none';
    $('#safetyModeLabel').textContent = m === 'DRY' ? '🔴 Fuego seco' : '🎯 Fuego real';
    onProgress(m);
  }

  function changeMode() {
    mode = null;
    $('#safetyModePicker').style.display = '';
    $('#safetyChecklistWrap').style.display = 'none';
  }

  function reset() {
    if (!mode) return;
    resetModeState(mode);
    onProgress(mode);
  }

  function init(onArmedCb) {
    onArmed = onArmedCb;
    $$('#safetyStepsDry .slider-track').forEach(track => attachSlider(track, parseInt(track.dataset.idx, 10), 'DRY'));
    $$('#safetyStepsLive .slider-track').forEach(track => attachSlider(track, parseInt(track.dataset.idx, 10), 'LIVE'));
    $('#modeDryBtn').addEventListener('click', () => selectMode('DRY'));
    $('#modeLiveBtn').addEventListener('click', () => selectMode('LIVE'));
    $('#btnChangeMode').addEventListener('click', changeMode);
    $('#btnArm').addEventListener('click', () => { if (mode) onArmed(mode); });
    $('#btnResetSafety').addEventListener('click', reset);
  }

  return { init, reset };
})();
