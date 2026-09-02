// Smoke test for build 2026-08-28.21 — verifies (without camera/laser, which
// can't be simulated headlessly): no console errors on load, the two hidden
// debug/JSON panels and the "Sobre esta app" technical footer are gone from
// the visible page, the build badge is correct, the new flashScreen()
// helper actually toggles the #screenFlash overlay's opacity, the app is
// renamed to "Entrena Tiro", none of the stray English/loanword terms found
// in builds .12-.13 (LOCKED/ARMED/SafetyState/TargetMind/OK/ERR/Safety Gate/
// Prompt/RT/checklist) are visible anywhere on the page, and (new in .14)
// the "puntería estilo IPSC" target family: Target.zoneAt()'s A/C/D/miss
// hit-test, that switching the generator to that family swaps the visible
// UI (hides the shape-count field, shows the IPSC note) without any console
// error, and that a generated IPSC target's print preview actually draws
// something (a non-blank canvas) instead of silently rendering empty. New
// in .16: a regression check that mandar un blanco a Fuego Seco por primera
// vez en la sesión efectivamente crea #dryVideo sin tirar errores (bug real
// reportado en un celular — ver drill.js ensureScope()). New in .18: el
// encode/decode del código "compartir blanco" (round-trip completo,
// reacción y puntería, código roto → null) y que abrir la app con #t=...
// importa y guarda ese blanco — NO se puede probar el dibujo del QR en sí
// (la librería se carga de una CDN bloqueada acá, igual que jsPDF). New in
// .19: el cartel de "actualización disponible" no aparece en la instalación
// inicial, sí aparece ante un controllerchange posterior, y el botón
// "Actualizar ahora" efectivamente recarga la página. New in .20: arrancar
// una sesión de Puntería oculta el cartel "Drill completo" que hubiera
// quedado de una sesión de Reacción anterior sobre el mismo blanco, y ese
// cartel nunca bloquea toques (pointer-events:none) — bug real reportado:
// "me sale el resultado del anterior sesión... no me registra los
// impactos". No se puede probar acá, sin cámara real, que attemptRecognition()
// ya no cambie el blanco activo en medio de una sesión de puntería (el otro
// fix de este build) — queda verificado por revisión de código. New in .21:
// el botón de flash/linterna (Vision.getTorchInfo/setTorch) — sin cámara
// real en este entorno no se puede probar que efectivamente prenda la luz,
// pero sí que el feature-detection no rompe nada cuando el dispositivo no
// expone torch (el caso de este entorno) y que el botón queda oculto en vez
// de mostrarse roto/sin hacer nada. New in .22: bug real reportado con video
// ("no hace nada al disparar en el blanco") — #dryPrompt/#dryZoomCtrl
// (position:absolute, bottom:12px) vivían directo dentro de .scope junto a
// #dryDebugPanel; como .scope es un flex-row que se estira a su hijo más
// alto, prender el panel de Diagnóstico (un <pre> que crece con cada línea)
// empujaba el cartel de consigna/resultado muy por debajo del video, fuera
// de la vista — reproducido acá sin cámara real (se puede: es puro CSS/DOM,
// no depende de láser) comparando la posición de #dryPrompt relativa al
// cuadro de video con Diagnóstico apagado vs. prendido con mucho texto.
// New in .23: bug real reportado con captura de pantalla — en un blanco de
// Puntería (IPSC) la barra flotante inferior mostraba "Iniciar Drill Mente-
// Acción" en vez de "Iniciar sesión de puntería". Dos causas, una arriba de
// la otra: (1) la de fondo, más grave — DryFire.ensureScope() (y su gemela
// en livefire.js) buscaban `#dryEmpty`/`#liveEmpty`, un cartel que solo
// existe en el HTML estático antes del primer blanco enviado; la PRIMERA
// vez que corre, `wrap.innerHTML` lo borra, así que la SEGUNDA vez (y todas
// las siguientes, o sea prácticamente cualquier sesión real) tiraba un
// TypeError que cortaba la función en la primera línea, sin ningún error
// visible — el toggle Reacción/Puntería, entre otras cosas, nunca se volvía
// a ejecutar en toda la sesión. (2) encima, ctaSync() (la barra flotante)
// miraba el style.display del BOTÓN en vez de si su contenedor padre estaba
// oculto, así que aunque (1) no hubiera pasado, igual habría elegido mal.
// Ambas se reproducen sin cámara real (puro DOM/CSS): la (1) mandando un
// SEGUNDO blanco a Fuego Seco en la misma sesión y confirmando que no tira
// error de consola; la (2) simulando ambos botones de arranque habilitados
// en un blanco de Puntería y mirando qué texto termina en la barra.
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
  check('badge de build dice .23', bodyText.includes('build 2026-08-28.23'));
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

  // ---- Puntería estilo IPSC (nuevo en build .14) -------------------------
  // zoneAt(): probamos un punto en cada zona esperada usando la geometría
  // real de constants.js (no valores inventados) — cabeza/centro → 'A',
  // borde del torso → 'D', bien afuera → null.
  const zoneResults = await page.evaluate(() => {
    return {
      centro: Target.zoneAt(500, 150),       // adentro de IPSC_HEAD
      pechoAlto: Target.zoneAt(500, 335),    // centro de IPSC_ZONE_A
      torsoBorde: Target.zoneAt(500, 650),   // dentro del polígono, afuera de C
      fuera: Target.zoneAt(50, 50),          // esquina, bien afuera de todo
    };
  });
  check('zoneAt() en el centro de la cabeza da "A"', zoneResults.centro === 'A');
  check('zoneAt() en el pecho (zona A) da "A"', zoneResults.pechoAlto === 'A');
  check('zoneAt() cerca del borde del torso da "D"', zoneResults.torsoBorde === 'D');
  check('zoneAt() bien afuera del blanco da null', zoneResults.fuera === null);

  // Selector de familia: cambiar a "Puntería (estilo IPSC)" debe ocultar la
  // cantidad de figuras (no aplica a esa familia) y mostrar la nota
  // aclaratoria, sin tirar ningún error de consola.
  const consoleErrorsBeforeIpsc = consoleErrors.length;
  // Fuerza la pestaña del generador visible sin pasar por todo el checklist
  // de seguridad (ya cubierto por el smoke test original y por las capturas
  // de pantalla) — este bloque solo verifica el toggle de UI del generador.
  await page.evaluate(() => {
    document.querySelectorAll('.tab-btn').forEach(b => b.disabled = false);
    App.setTab('target');
  });
  await page.click('.family-btn[data-family="ipsc"]');
  await page.waitForTimeout(50);
  const ipscUi = await page.evaluate(() => ({
    noteVisible: getComputedStyle($('#ipscNote')).display !== 'none',
    shapeCountHidden: getComputedStyle($('#shapeCountWrap')).display === 'none',
  }));
  check('elegir "Puntería (estilo IPSC)" muestra la nota aclaratoria', ipscUi.noteVisible);
  check('elegir "Puntería (estilo IPSC)" oculta "Cantidad de figuras"', ipscUi.shapeCountHidden);
  check('cambiar de familia no tira errores de consola', consoleErrors.length === consoleErrorsBeforeIpsc);

  // Generar un blanco IPSC y confirmar que el preview realmente dibuja algo
  // (no una vista previa en blanco) — un chequeo de píxeles simple: cuenta
  // cuántos píxeles del canvas NO son el color de fondo del papel.
  await page.click('#btnGenerate');
  await page.waitForTimeout(200);
  const drewSomething = await page.evaluate(() => {
    const canvas = document.getElementById('previewCanvas');
    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let nonBgPixels = 0;
    for (let i = 0; i < data.length; i += 4 * 37) { // muestreo, no cada píxel
      if (data[i] < 235 || data[i + 1] < 225 || data[i + 2] < 210) nonBgPixels++;
    }
    return nonBgPixels;
  });
  check('el preview de un blanco IPSC dibuja algo (silueta+fiduciales), no queda en blanco', drewSomething > 5);

  // ---- Regresión build .15b: activar Fuego Seco por primera vez en la
  // sesión no debe romper la creación de #dryVideo ------------------------
  // Bug real reportado por Damian en un celular: al abrir Fuego Seco y tocar
  // "Activar cámara" saltaba "Cannot set properties of null (setting
  // 'srcObject')". Causa: DryFire.ensureScope() tenía una línea
  // `$('#dryPrompt').style.display = 'none'` que corría ANTES de que
  // `wrap.innerHTML` creara ese elemento (y de paso #dryVideo) — la primera
  // vez que se llamaba en una sesión, esa línea tiraba una excepción que
  // cortaba la función a mitad de camino: #drySide ya había quedado visible
  // (con las rondas/dificultad del drill) pero #dryVideo nunca se llegaba a
  // crear. Esta prueba reproduce exactamente ese camino — primer envío a
  // Fuego Seco de toda la sesión de este test — y confirma que #dryVideo
  // (y el resto del scope) se arma bien y sin errores de consola.
  await page.click('.family-btn[data-family="reaction"]');
  await page.waitForTimeout(50);
  await page.click('#btnGenerate');
  await page.waitForTimeout(150);
  const consoleErrorsBeforeDry = consoleErrors.length;
  await page.click('#btnSendDry');
  await page.waitForTimeout(100);
  const dryScope = await page.evaluate(() => ({
    videoExists: !!document.getElementById('dryVideo'),
    drySideVisible: getComputedStyle($('#drySide')).display !== 'none',
    btnLockDisabled: $('#btnLock').disabled,
  }));
  check('#dryVideo existe la primera vez que se manda un blanco a Fuego Seco', dryScope.videoExists);
  check('#drySide queda visible en Fuego Seco', dryScope.drySideVisible);
  check('#btnLock ("Activar cámara") queda habilitado', !dryScope.btnLockDisabled);
  check('mandar a Fuego Seco por primera vez no tira errores de consola', consoleErrors.length === consoleErrorsBeforeDry);

  // ---- Regresión build .23: mandar un SEGUNDO blanco a Fuego Seco en la
  // misma sesión no debe tirar una excepción silenciosa --------------------
  // El bug de arriba (build .15b) fue sobre #dryPrompt en la PRIMERA llamada
  // a ensureScope() de la sesión. Este es el mismo tipo de bug pero en la
  // dirección opuesta: #dryEmpty (el cartel "Generá un blanco... y enviálo
  // acá") solo existe en el HTML estático — la PRIMERA vez que ensureScope()
  // corre, `wrap.innerHTML = ...` lo borra y lo reemplaza por la plantilla
  // de cámara. Buscarlo de nuevo en la SEGUNDA llamada (y todas las
  // siguientes) daba `$('#dryEmpty') === null`, y leer `.style` de eso
  // tiraba un TypeError que cortaba ensureScope() en la primera línea —
  // silencioso, sin alert ni nada visible, pero el resto de la función
  // (el toggle Reacción/Puntería, el rearmado de #dryScopeWrap con el
  // #dryTorchBtn nuevo, resetPunteriaUi()) nunca se ejecutaba de nuevo en
  // toda la sesión. Se reproduce mandando un SEGUNDO blanco (de la otra
  // familia, para que además se note si el toggle se aplicó) y confirmando
  // que no aparece ningún error de consola nuevo.
  const consoleErrorsBeforeSecondDry = consoleErrors.length;
  await page.evaluate(() => App.setTab('target'));
  await page.waitForTimeout(50);
  await page.click('.family-btn[data-family="ipsc"]');
  await page.waitForTimeout(50);
  await page.click('#btnGenerate');
  await page.waitForTimeout(150);
  await page.click('#btnSendDry');
  await page.waitForTimeout(150);
  check(
    'mandar un SEGUNDO blanco a Fuego Seco en la misma sesión no tira errores de consola',
    consoleErrors.length === consoleErrorsBeforeSecondDry
  );

  // ---- Regresión build .23: el mismo bug de #dryEmpty existía calcado en
  // livefire.js (#liveEmpty) para Fuego Real — misma prueba, otro botón. ---
  await page.evaluate(() => App.setTab('target'));
  await page.waitForTimeout(50);
  await page.click('#btnGenerate');
  await page.waitForTimeout(150);
  const consoleErrorsBeforeFirstLive = consoleErrors.length;
  await page.click('#btnSendLive');
  await page.waitForTimeout(150);
  check('mandar un blanco a Fuego Real no tira errores de consola', consoleErrors.length === consoleErrorsBeforeFirstLive);
  const consoleErrorsBeforeSecondLive = consoleErrors.length;
  await page.evaluate(() => App.setTab('target'));
  await page.waitForTimeout(50);
  await page.click('#btnGenerate');
  await page.waitForTimeout(150);
  await page.click('#btnSendLive');
  await page.waitForTimeout(150);
  check(
    'mandar un SEGUNDO blanco a Fuego Real en la misma sesión no tira errores de consola',
    consoleErrors.length === consoleErrorsBeforeSecondLive
  );

  // ---- Botón de flash/linterna (nuevo en build .21) ----------------------
  // Sin cámara real en este entorno no se puede activar el stream (getUserMedia
  // fallaría), así que esto solo cubre lo que SÍ se puede probar sin hardware:
  // el botón existe en la plantilla y arranca oculto (el feature-detection
  // real recién lo muestra si Vision.getTorchInfo().supported da true, algo
  // que solo pasa con una cámara real de verdad), y la API de Vision no tira
  // ninguna excepción cuando se la llama sin ninguna cámara activa — se
  // degrada con calma a "no soportado" en vez de romper el resto de la app.
  const torchBtnState = await page.evaluate(() => {
    const btn = document.getElementById('dryTorchBtn');
    return btn ? getComputedStyle(btn).display : 'no-existe';
  });
  check('#dryTorchBtn existe en la plantilla de Fuego Seco y arranca oculto', torchBtnState === 'none');
  const torchInfoInitial = await page.evaluate(() => Vision.getTorchInfo());
  check('Vision.getTorchInfo() sin cámara activa da supported:false', torchInfoInitial.supported === false);
  const torchSetResult = await page.evaluate(() => Vision.setTorch(true));
  check('Vision.setTorch() sin cámara activa no tira excepción y devuelve false', torchSetResult === false);

  // ---- Regresión build .22: el panel de Diagnóstico no debe empujar el
  // cartel de consigna/resultado (#dryPrompt) ni el control de zoom
  // (#dryZoomCtrl) lejos del video --------------------------------------
  // Bug real reportado con video: "no hace nada al disparar en el blanco".
  // #dryPrompt/#dryZoomCtrl son position:absolute con bottom:12px — antes de
  // este build, ese "bottom" era relativo a TODO .scope (que es un flex-row
  // y se estira a su hijo más alto), así que prender Diagnóstico (un <pre>
  // que crece con cada línea de diagnóstico) estiraba .scope y arrastraba el
  // cartel muy por debajo del video, invisible. Se simula el estado
  // "bloqueado" sin cámara real (es puro DOM/CSS, no depende de láser):
  // se arma el mismo canvas base que onVisionFrame() usa de verdad
  // (Vision.warpCanvas, del tamaño real de Vision.WARP_W/H) dentro de
  // #dryLockedWrap, y se compara la posición de #dryPrompt relativa al
  // cuadro de video con Diagnóstico apagado vs. prendido con texto largo —
  // debe ser la MISMA en los dos casos.
  await page.evaluate(() => {
    const lockedWrap = document.getElementById('dryLockedWrap');
    const camHint = document.getElementById('dryCamHint');
    const overlay = document.getElementById('dryOverlay');
    const base = Vision.warpCanvas || document.createElement('canvas');
    base.width = Vision.WARP_W; base.height = Vision.WARP_H;
    base.className = '';
    lockedWrap.prepend(base);
    overlay.width = Vision.WARP_W; overlay.height = Vision.WARP_H;
    lockedWrap.style.display = 'block';
    camHint.style.display = 'none';
    const prompt = document.getElementById('dryPrompt');
    prompt.style.display = '';
    prompt.innerHTML = 'PRUEBA';
  });
  const gapWithDebugOff = await page.evaluate(() => {
    const prompt = document.getElementById('dryPrompt').getBoundingClientRect();
    const locked = document.getElementById('dryLockedWrap').getBoundingClientRect();
    return prompt.top - locked.bottom;
  });
  const gapWithDebugOn = await page.evaluate(() => {
    const panel = document.getElementById('dryDebugPanel');
    panel.style.display = '';
    panel.textContent = Array.from({ length: 20 }, (_, i) => `línea de diagnóstico de prueba número ${i}`).join('\n');
    const prompt = document.getElementById('dryPrompt').getBoundingClientRect();
    const locked = document.getElementById('dryLockedWrap').getBoundingClientRect();
    panel.style.display = 'none';
    panel.textContent = '';
    return prompt.top - locked.bottom;
  });
  check(
    'prender Diagnóstico no mueve el cartel de consigna/resultado lejos del video',
    Math.abs(gapWithDebugOn - gapWithDebugOff) < 1
  );

  // ---- Regresión build .23: la barra flotante inferior (.cta-bar) no debe
  // mostrar "Iniciar Drill Mente-Acción" en un blanco de Puntería (IPSC) --
  // Bug real reportado con captura de pantalla: en un blanco de Puntería
  // (family==='ipsc', donde #drySideReaction queda oculto y solo se ve
  // #drySideIpsc con "Iniciar sesión de puntería"), la barra fija de abajo
  // igual mostraba "Iniciar Drill Mente-Acción". Causa: ctaSync() elegía
  // qué botón espejar mirando `btn.style.display !== 'none'` — pero
  // #btnStartDrill nunca tiene ESE estilo puesto en sí mismo, lo que se
  // oculta es su contenedor padre (#drySideReaction). Se manda un blanco
  // IPSC a Fuego Seco, se simula la cámara bloqueada (ambos botones de
  // arranque habilitados, como pasa de verdad en ese momento) y se confirma
  // que la barra flotante muestra el botón de Puntería, no el de Reacción.
  await page.evaluate(() => App.setTab('target'));
  await page.waitForTimeout(50);
  await page.click('.family-btn[data-family="ipsc"]');
  await page.waitForTimeout(50);
  await page.click('#btnGenerate');
  await page.waitForTimeout(150);
  await page.click('#btnSendDry');
  await page.waitForTimeout(150);
  const ctaBarResult = await page.evaluate(() => {
    document.getElementById('btnStartDrill').disabled = false;
    document.getElementById('btnStartPunteria').disabled = false;
    DryFire.setupCtaBar();
    return {
      drySideReactionHidden: getComputedStyle(document.getElementById('drySideReaction')).display === 'none',
      ctaBtnText: document.getElementById('dryCtaBtn').textContent,
    };
  });
  check('en un blanco de Puntería, #drySideReaction (Reacción) queda oculto', ctaBarResult.drySideReactionHidden);
  check(
    'la barra flotante de abajo muestra "Iniciar sesión de puntería", no "Iniciar Drill Mente-Acción"',
    ctaBarResult.ctaBtnText.includes('puntería') && !ctaBarResult.ctaBtnText.includes('Mente-Acción')
  );

  // ---- Regresión build .20: arrancar Puntería no debe dejar visible el
  // cartel "Drill completo" de una sesión de Reacción anterior ------------
  // Bug real reportado: "me sale el resultado del anterior sesión" — nada en
  // el flujo de Puntería tocaba #dryPrompt, así que si se corría un drill de
  // Reacción sobre el mismo blanco (sin volver a mandarlo a Fuego Seco) su
  // cartel final se quedaba dibujado encima del video. Se simula el cartel
  // sin necesitar cámara real (startPunteria() es puro DOM) y se confirma
  // que arrancar la sesión de puntería lo oculta.
  await page.evaluate(() => {
    const banner = document.getElementById('dryPrompt');
    banner.style.display = '';
    banner.innerHTML = 'Drill completo — 3/8 aciertos';
  });
  await page.evaluate(() => DryFire.startPunteria());
  const punteriaBannerHidden = await page.evaluate(() => document.getElementById('dryPrompt').style.display === 'none');
  check('iniciar sesión de puntería oculta el cartel de la sesión de Reacción anterior', punteriaBannerHidden);
  await page.evaluate(() => DryFire.stopPunteria());

  // El cartel tampoco debe poder comerse toques manuales sobre el video —
  // nunca tiene botones adentro, así que pointer-events:none es siempre
  // seguro (parte del mismo reporte: "no me registra los impactos").
  const bannerPointerEvents = await page.evaluate(() => getComputedStyle(document.getElementById('dryPrompt')).pointerEvents);
  check('el cartel de consigna/resultado no bloquea toques (pointer-events:none)', bannerPointerEvents === 'none');

  // ---- Compartir blanco por QR/enlace (nuevo en build .18) --------------
  // No se puede probar el DIBUJO del QR acá (la librería se carga de una
  // CDN bloqueada en este entorno — mismo caso que jsPDF), pero el
  // encode/decode del código NO depende de esa librería (usa btoa/atob
  // nativos), así que sí se puede probar de punta a punta: codificar un
  // blanco, decodificarlo, y confirmar que salió exactamente igual.
  const shareRoundTrip = await page.evaluate(() => {
    const original = Target.build({
      pageSize: 'A3', mode: 'DRY', distDesigned: 3, distSimulated: 15,
      shapeCount: 5, family: 'reaction', includeQr: true,
    });
    const code = Target.encodeShareCode(original);
    const decoded = Target.decodeShareCode(code);
    return {
      decodedOk: !!decoded,
      idMatch: decoded && decoded.id === original.id,
      pageSizeMatch: decoded && decoded.pageSize === original.pageSize,
      modeMatch: decoded && decoded.mode === original.mode,
      shapeCountMatch: decoded && decoded.shapes.length === original.shapes.length,
      firstShapeMatch: decoded && original.shapes[0] &&
        decoded.shapes[0].type === original.shapes[0].type &&
        decoded.shapes[0].color === original.shapes[0].color &&
        decoded.shapes[0].number === original.shapes[0].number &&
        Math.abs(decoded.shapes[0].cx - original.shapes[0].cx) <= 1 &&
        Math.abs(decoded.shapes[0].cy - original.shapes[0].cy) <= 1,
      garbageIsNull: Target.decodeShareCode('esto-no-es-un-codigo-valido') === null,
    };
  });
  check('encodeShareCode/decodeShareCode: decodifica un blanco de reacción', shareRoundTrip.decodedOk);
  check('el ID viaja intacto en el código', shareRoundTrip.idMatch);
  check('el tamaño de papel viaja intacto', shareRoundTrip.pageSizeMatch);
  check('el modo viaja intacto', shareRoundTrip.modeMatch);
  check('la cantidad de figuras viaja intacta', shareRoundTrip.shapeCountMatch);
  check('la primera figura (tipo/color/número/posición) viaja intacta', shareRoundTrip.firstShapeMatch);
  check('decodeShareCode() de un código roto/inventado da null (no tira excepción)', shareRoundTrip.garbageIsNull);

  const ipscShareRoundTrip = await page.evaluate(() => {
    const original = Target.build({
      pageSize: 'A4', mode: 'LIVE', distDesigned: 7, distSimulated: 7,
      family: 'ipsc', includeQr: true,
    });
    const decoded = Target.decodeShareCode(Target.encodeShareCode(original));
    return decoded && decoded.family === 'ipsc' && decoded.id === original.id && decoded.mode === 'LIVE';
  });
  check('un blanco de puntería (IPSC) también viaja intacto en el código (sin figuras)', ipscShareRoundTrip);

  // Enlace de importación: abrir la app con #t=<código> tiene que cargar y
  // GUARDAR ese blanco automáticamente, sin que este navegador lo haya
  // generado nunca — el caso real que motivó esto (blancos vendidos ya
  // impresos). Genera el código en la pestaña actual, lo abre en una
  // pestaña nueva vía #t=, y confirma que quedó activo + en la biblioteca.
  const codeToImport = await page.evaluate(() => {
    const t = Target.build({ pageSize: 'A4', mode: 'DRY', distDesigned: 3, distSimulated: 15, shapeCount: 4, family: 'reaction', includeQr: true });
    return { code: Target.encodeShareCode(t), id: t.id };
  });
  const importPage = await browser.newPage();
  const importErrors = [];
  importPage.on('console', (msg) => { if (msg.type() === 'error') importErrors.push(msg.text()); });
  importPage.on('pageerror', (err) => importErrors.push('pageerror: ' + err.message));
  await importPage.goto(`http://localhost:8934/index.html#t=${codeToImport.code}`, { waitUntil: 'load' });
  importPage.once('dialog', d => d.accept()); // el alert() de confirmación de import
  await importPage.waitForTimeout(600);
  const importResult = await importPage.evaluate((expectedId) => ({
    activeIdMatch: App.currentTarget() && App.currentTarget().id === expectedId,
    savedInLibrary: Storage.get('tm_saved_targets', []).some(r => r.target && r.target.id === expectedId),
    hashCleared: location.hash === '',
  }), codeToImport.id);
  check('abrir la app con #t=<código> carga ese blanco como activo', importResult.activeIdMatch);
  check('el blanco importado por enlace queda guardado en la biblioteca', importResult.savedInLibrary);
  check('el hash #t=... se limpia después de importar (no reimporta al recargar)', importResult.hashCleared);
  check('importar por enlace no tira errores de consola', importErrors.length === 0);
  if (importErrors.length) console.log('  errores import:', importErrors.slice(0, 5));
  await importPage.close();

  // ---- Aviso de "actualización disponible" (nuevo en build .19) ---------
  // Motivado por el bug real del QR: un service worker nuevo puede terminar
  // activo de fondo sin que la pestaña ya abierta se entere, dejando a
  // alguien atascado en JS viejo indefinidamente. El fix es un cartel que
  // aparece cuando el navegador confirma el cambio de controller — pero
  // NO en la instalación inicial (eso asustaría a un usuario nuevo en su
  // primerísima visita). `controllerchange` es un evento normal de
  // EventTarget, así que se puede disparar a mano con dispatchEvent() para
  // probar la lógica sin depender de un segundo deploy real.
  const bannerHiddenAfterFirstLoad = await page.evaluate(() => document.getElementById('updateBanner').hidden);
  check('el cartel de actualización no aparece en la instalación inicial', bannerHiddenAfterFirstLoad);

  await page.evaluate(() => navigator.serviceWorker.dispatchEvent(new Event('controllerchange')));
  await page.waitForTimeout(50);
  const bannerShownAfterUpdate = await page.evaluate(() => document.getElementById('updateBanner').hidden === false);
  check('un controllerchange posterior (actualización real) sí muestra el cartel', bannerShownAfterUpdate);

  const [reloadHappened] = await Promise.all([
    page.waitForEvent('load', { timeout: 3000 }).then(() => true).catch(() => false),
    page.click('#btnReloadUpdate'),
  ]);
  check('tocar "Actualizar ahora" recarga la página', reloadHappened);

  console.log(`\n${pass} pasaron, ${fail} fallaron`);
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
})();
