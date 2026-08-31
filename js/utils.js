const $  = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
const rand    = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const choice  = (arr) => arr[Math.floor(Math.random() * arr.length)];
const clamp   = (v, a, b) => Math.max(a, Math.min(b, v));
const nowMs   = () => performance.now();

// Full-screen color flash — used as a visual cue (green = "¡YA!"/orden de
// disparo, red = fin de sesión) on top of whatever panel is active. Fires
// on #screenFlash (see index.html / .screen-flash in css/style.css).
// `holdMs` is how long it stays fully visible before fading back out;
// pointer-events:none on the element means it never blocks a tap/shot
// underneath while it's showing.
let flashScreenTimer = null;
function flashScreen(color, holdMs = 220) {
  const el = $('#screenFlash');
  if (!el) return;
  if (flashScreenTimer) { clearTimeout(flashScreenTimer); flashScreenTimer = null; }
  el.style.background = color;
  el.classList.add('is-on');
  el.style.opacity = '0.55';
  flashScreenTimer = setTimeout(() => {
    el.classList.remove('is-on');
    el.style.opacity = '0';
    flashScreenTimer = null;
  }, holdMs);
}
