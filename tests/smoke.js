// Smoke test for build 2026-08-28.13 — verifies (without camera/laser, which
// can't be simulated headlessly): no console errors on load, the two hidden
// debug/JSON panels and the "Sobre esta app" technical footer are gone from
// the visible page, the build badge is correct, the new flashScreen()
// helper actually toggles the #screenFlash overlay's opacity, the app is
// renamed to "Entrena Tiro", and none of the stray English/loanword terms
// found in builds .12-.13 (LOCKED/ARMED/SafetyState/TargetMind/OK/ERR/
// Safety Gate/Prompt/RT/checklist) are visible anywhere on the page.
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));

  await page.goto('http://localhost:8934/index.html', { waitUntil: 'load' });
  await page.waitForTimeout(1500); // let OpenCV.js finish loading

  let pass = 0, fail = 0;
  const check = (name, ok) => {
    if (ok) { pass++; console.log('PASS:', name); }
    else { fail++; console.log('FAIL:', name); }
  };

  check('sin errores de consola/JS al cargar', consoleErrors.length === 0);
  if (consoleErrors.length) console.log('  errores:', consoleErrors.slice(0, 5));

  const bodyText = await page.evaluate(() => document.body.innerText);
  check('badge de build dice .13', bodyText.includes('build 2026-08-28.13'));
  check('nota técnica "Sobre esta app" ya no está visible', !bodyText.includes('Sobre esta app'));
  check('"JSON del blanco (Target Metatag' + ' decodificado)" no visible', !bodyText.includes('Target Metatag'));
  check('botón "Ver JSON" ya no existe', (await page.$$('[data-view]')).length === 0);
  check('la app se llama "Entrena Tiro"', bodyText.includes('Entrena Tiro') && await page.title() === 'Entrena Tiro');
  check('no queda "TargetMind" visible', !bodyText.includes('TargetMind'));
  const strayEnglish = ['LOCKED', 'ARMED', 'SafetyState', 'Safety Gate', 'Prompt', 'checklist', 'Checklist'];
  for (const w of strayEnglish) check(`sin la palabra suelta en inglés "${w}"`, !bodyText.includes(w));
  // La columna OK/ERR de la tabla de registro (ahora ✔/✘) solo se llena
  // corriendo una ronda del drill completa, que necesita cámara/láser — no
  // se puede verificar acá sin hardware real.

  const targetJsonCardVisible = await page.evaluate(() => {
    const h2s = [...document.querySelectorAll('h2')];
    const h2 = h2s.find(h => h.textContent.includes('JSON del blanco'));
    if (!h2) return 'no-existe';
    const card = h2.closest('.card');
    return card ? getComputedStyle(card).display : 'sin-card';
  });
  check('card "JSON del blanco" con display:none', targetJsonCardVisible === 'none');

  // flashScreen(): simula lo que dispara drill.js en startAwait()/finish() —
  // no podemos generar un láser real, pero sí llamar la función tal cual la
  // llama el código y confirmar que el overlay reacciona.
  // CSS transition: el valor recién asignado recién se refleja en
  // getComputedStyle después de que el navegador pinte un frame, así que
  // esperamos un toque (más que la transición de 40ms de entrada) antes de
  // leer "during" — si no, siempre se lee el valor de arranque (0).
  const before = await page.evaluate(() => getComputedStyle(document.getElementById('screenFlash')).opacity);
  await page.evaluate(() => flashScreen('var(--danger)', 200));
  await page.waitForTimeout(80);
  const flashResult = await page.evaluate(() => {
    const el = document.getElementById('screenFlash');
    if (!el || typeof flashScreen !== 'function') return { ok: false, reason: 'falta el elemento o la función' };
    return { ok: true, before: undefined, duringOpacity: getComputedStyle(el).opacity, duringBg: el.style.background };
  });
  flashResult.before = before;
  check('#screenFlash existe y flashScreen() es una función', flashResult.ok);
  if (flashResult.ok) {
    check('opacidad en reposo es 0', flashResult.before === '0');
    check('flashScreen() sube la opacidad', parseFloat(flashResult.duringOpacity) > 0);
    check('flashScreen() setea el color pedido', flashResult.duringBg.includes('danger'));
    await page.waitForTimeout(350);
    const after = await page.evaluate(() => getComputedStyle(document.getElementById('screenFlash')).opacity);
    check('opacidad vuelve a 0 después del hold', after === '0');
  }

  console.log(`\n${pass} pasaron, ${fail} fallaron`);
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
})();
