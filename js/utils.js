const $  = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
const rand    = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const choice  = (arr) => arr[Math.floor(Math.random() * arr.length)];
const clamp   = (v, a, b) => Math.max(a, Math.min(b, v));
const nowMs   = () => performance.now();
