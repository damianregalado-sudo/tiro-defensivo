const App = (() => {
  let target = null;
  let activeTab = 'safety';

  function currentTarget() { return target; }

  function setTab(name) {
    if (activeTab === 'dry' && name !== 'dry') DryFire.stopCamera();
    if (activeTab === 'live' && name !== 'live') LiveFire.stopCamera();
    activeTab = name;
    $$('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    $$('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + name));
    DryFire.setupCtaBar();
  }

  function unlockTabs() {
    $$('.tab-btn').forEach(b => { if (b.dataset.tab !== 'safety') { b.disabled = false; b.classList.remove('locked'); } });
  }

  function onArmed(mode) {
    $('#statusDot').classList.add('on');
    $('#statusText').textContent = 'SAFETY STATE: ARMED — CÁMARA HABILITADA';
    unlockTabs();
    if (mode) {
      $('#pageMode').value = mode;
      $('#pageMode').dispatchEvent(new Event('change'));
    }
    setTab('target');
  }

  // ---- target generator ----
  function updateTargetMeta() {
    const spec = PAGE_SPECS[target.pageSize];
    $('#targetMeta').innerHTML = `<span class="pill accent">${spec.label}</span>
      <span class="pill ${target.mode === 'LIVE' ? 'danger' : 'info'}">${target.mode === 'LIVE' ? 'FUEGO REAL' : 'FUEGO SECO'}</span>
      <span class="pill">Diseñado: ${target.distDesigned} m</span>
      ${target.mode === 'DRY' ? `<span class="pill">Simulado: ${target.distSimulated} m</span>` : ''}
      <span class="pill">${target.shapes.length} figuras</span>`;
  }

  function refreshTargetUi() {
    Target.drawPrintPreview($('#previewCanvas'), target);
    renderJson();
    $('#btnSendDry').disabled = false;
    $('#btnSendLive').disabled = false;
    $('#btnExportPdf').disabled = false;
    $('#btnSaveTarget').disabled = false;
    updateTargetMeta();
  }

  function buildTarget() {
    target = Target.build({
      pageSize: $('#pageSize').value,
      mode: $('#pageMode').value,
      distDesigned: parseFloat($('#distDesigned').value) || 3,
      distSimulated: parseFloat($('#distSimulated').value) || 15,
      shapeCount: parseInt($('#shapeCount').value, 10) || 7,
    });
    refreshTargetUi();
  }

  function renderJson() {
    $('#targetJson').textContent = JSON.stringify(Target.toJson(target), null, 2);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---- saved targets (so a printed sheet can be reused instead of
  // regenerating — and losing — its exact shape layout every time) ----
  //
  // Each saved record carries BOTH pieces a session needs, not just what's
  // needed to reprint the paper:
  //   - `target`: the full-precision internal object (pageSize, mode,
  //     distances, and every shape's exact id/type/color/cx/cy/r/number).
  //     This is the SAME object drill.js/livefire.js hit-test against, so
  //     loading a saved target puts the app back in the exact scanning
  //     configuration that matches the physical sheet you printed from it.
  //   - `metatagJson`: the same summarized JSON shown in the "Target
  //     Metatag decodificado" panel — i.e. what a real optical scan of the
  //     printed metatag would hand the app. Stored explicitly (not just
  //     re-derivable) so it's inspectable per saved target without having
  //     to load it first, and so nothing about the scanning config is
  //     implicit.
  // Inserts a new library record, or — if this exact printed target.id is
  // already saved — overwrites that record's shapes with the current state.
  // The overwrite matters because "Reroll" keeps the same target.id while
  // changing the shapes: without this, saving/printing twice on the same
  // generated target could leave the library pointing at stale geometry
  // for an ID that's actually printed with different shapes.
  function upsertSavedTarget(name) {
    const list = Storage.get('tm_saved_targets', []);
    const targetSnapshot = JSON.parse(JSON.stringify(target));
    const idx = list.findIndex(r => r.target && r.target.id === target.id);
    if (idx >= 0) {
      list[idx].target = targetSnapshot;
      list[idx].metatagJson = Target.toJson(targetSnapshot);
      list[idx].updatedAt = Date.now();
      if (name) list[idx].name = name;
    } else {
      const spec = PAGE_SPECS[target.pageSize];
      list.unshift({
        id: 'tgt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        name: name || `${spec.label} ${target.mode === 'LIVE' ? 'real' : 'seco'} #${target.id}`,
        target: targetSnapshot,
        metatagJson: Target.toJson(targetSnapshot),
        createdAt: Date.now(),
      });
    }
    Storage.set('tm_saved_targets', list.slice(0, 200));
    renderSavedTargets();
  }

  function saveCurrentTarget() {
    if (!target) return;
    const spec = PAGE_SPECS[target.pageSize];
    const defaultName = `${spec.label} ${target.mode === 'LIVE' ? 'real' : 'seco'} #${target.id}`;
    const name = prompt('Nombre para este blanco:', defaultName);
    if (!name) return;
    upsertSavedTarget(name);
  }

  // Auto-save, no prompt — called right before a target leaves the app
  // (PDF export, or heading into a dry/live session) so a printed sheet is
  // NEVER missing from the library. This is what actually fixes "imprimo
  // blancos que después no puedo volver a usar": that only happened when a
  // sheet was printed without ever tapping "Guardar blanco" first, so its
  // ID had nothing to match against once you tried to load/recognize it.
  function autoSaveTarget() {
    if (!target) return;
    upsertSavedTarget(null);
  }

  function viewSavedTargetJson(id) {
    const rec = Storage.get('tm_saved_targets', []).find(r => r.id === id);
    if (!rec) return;
    $('#savedTargetJsonWrap').style.display = '';
    $('#savedTargetJsonName').textContent = rec.name;
    $('#savedTargetJson').textContent = JSON.stringify(rec.metatagJson || Target.toJson(rec.target), null, 2);
    $('#savedTargetJsonWrap').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // Shared by manual "Cargar" and by camera auto-recognition — puts a target
  // (a full internal object, already cloned by the caller) into the active
  // slot and keeps the generator form/preview/JSON in sync with it.
  function setActiveTarget(t) {
    target = t;
    $('#pageSize').value = target.pageSize;
    $('#pageMode').value = target.mode;
    $('#pageMode').dispatchEvent(new Event('change'));
    $('#distDesigned').value = target.distDesigned;
    $('#distSimulated').value = target.distSimulated;
    $('#shapeCount').value = target.shapes.length;
    refreshTargetUi();
  }

  function loadSavedTarget(id) {
    const rec = Storage.get('tm_saved_targets', []).find(r => r.id === id);
    if (!rec) return;
    setActiveTarget(JSON.parse(JSON.stringify(rec.target))); // clone — reroll/edits must never mutate the saved copy
  }

  function findSavedTargetById(targetId) {
    return Storage.get('tm_saved_targets', []).find(r => r.target && r.target.id === targetId);
  }

  // Called from the camera pipeline (drill.js/livefire.js) once it optically
  // decodes a metatag off the locked/warped frame. Looks the decoded 16-bit
  // targetId up against the saved-targets library and, if found, auto-loads
  // it — the whole point being the shooter never has to tap "Cargar" at all.
  // Returns a status object the caller uses to drive its recognition pill:
  //   { status: 'recognized', rec }   — matched a saved target, now active
  //   { status: 'unsaved', decoded }  — metatag read cleanly but that target
  //                                     was never saved to this device
  //   { status: 'invalid' }           — bad/unreadable optical read
  function recognizeTarget(decoded) {
    if (!decoded || !decoded.valid) return { status: 'invalid' };
    const rec = findSavedTargetById(decoded.targetId);
    if (!rec) return { status: 'unsaved', decoded };
    setActiveTarget(JSON.parse(JSON.stringify(rec.target)));
    return { status: 'recognized', rec };
  }

  function deleteSavedTarget(id) {
    if (!confirm('¿Eliminar este blanco guardado? No se puede deshacer.')) return;
    Storage.set('tm_saved_targets', Storage.get('tm_saved_targets', []).filter(r => r.id !== id));
    renderSavedTargets();
  }

  function renderSavedTargets() {
    let list = Storage.get('tm_saved_targets', []);
    const q = ($('#savedTargetSearch') && $('#savedTargetSearch').value || '').trim().toLowerCase();
    if (q) {
      list = list.filter(r =>
        String(r.target.id).includes(q) ||
        r.name.toLowerCase().includes(q)
      );
    }
    $('#savedTargetsBody').innerHTML = list.map(r => `
      <tr>
        <td>${escapeHtml(r.name)}<br><span style="color:var(--text-faint);font-size:11px;">ID ${r.target.id}</span></td>
        <td>${PAGE_SPECS[r.target.pageSize].label}</td>
        <td>${r.target.mode === 'LIVE' ? 'Real' : 'Seco'}</td>
        <td>${fmtDate(new Date(r.createdAt).toISOString())}</td>
        <td style="white-space:nowrap;">
          <button class="btn btn-ghost" style="padding:4px 9px;font-size:12px;" data-load="${r.id}">Cargar</button>
          <button class="btn btn-ghost" style="padding:4px 9px;font-size:12px;" data-view="${r.id}">Ver JSON</button>
          <button class="btn btn-ghost" style="padding:4px 9px;font-size:12px;color:var(--danger);" data-del="${r.id}">Eliminar</button>
        </td>
      </tr>
    `).join('') || `<tr><td colspan="5" style="color:var(--text-faint);">${q ? 'Ningún blanco guardado coincide con la búsqueda.' : 'Todavía no guardaste ningún blanco. Generá uno y tocá "Guardar blanco" (o simplemente exportá el PDF — ahora se guarda solo).'}</td></tr>`;
    $$('#savedTargetsBody [data-load]').forEach(b => b.addEventListener('click', () => loadSavedTarget(b.dataset.load)));
    $$('#savedTargetsBody [data-view]').forEach(b => b.addEventListener('click', () => viewSavedTargetJson(b.dataset.view)));
    $$('#savedTargetsBody [data-del]').forEach(b => b.addEventListener('click', () => deleteSavedTarget(b.dataset.del)));
  }

  // ---- library backup (export/import as a .json file) ----------------
  // localStorage lives inside ONE browser on ONE device/profile — it is NOT
  // touched by app updates (a redeployed PWA keeps it), but it IS lost if
  // the user clears site data, reinstalls, or wants to move to a different
  // phone. This is the real fix for "post actualización de la app" / moving
  // devices: back up the whole library to a file you keep yourself, and
  // restore it anywhere.
  function exportLibrary() {
    const list = Storage.get('tm_saved_targets', []);
    if (!list.length) { alert('Todavía no hay blancos guardados para exportar.'); return; }
    const blob = new Blob([JSON.stringify(list, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `targetmind_biblioteca_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function importLibrary(file) {
    const reader = new FileReader();
    reader.onload = () => {
      let incoming;
      try { incoming = JSON.parse(reader.result); } catch (e) {
        alert('No se pudo leer ese archivo — no es un JSON válido.');
        return;
      }
      if (!Array.isArray(incoming)) { alert('Ese archivo no tiene el formato esperado (biblioteca de blancos).'); return; }
      const list = Storage.get('tm_saved_targets', []);
      let added = 0, updated = 0;
      incoming.forEach(rec => {
        if (!rec || !rec.target || typeof rec.target.id === 'undefined') return;
        const idx = list.findIndex(r => r.target && r.target.id === rec.target.id);
        if (idx >= 0) {
          const existingTs = list[idx].updatedAt || list[idx].createdAt || 0;
          const incomingTs = rec.updatedAt || rec.createdAt || 0;
          if (incomingTs >= existingTs) { list[idx] = rec; updated++; }
        } else {
          list.unshift(rec);
          added++;
        }
      });
      Storage.set('tm_saved_targets', list.slice(0, 200));
      renderSavedTargets();
      alert(`Importado: ${added} blanco(s) nuevo(s), ${updated} actualizado(s).`);
    };
    reader.readAsText(file);
  }

  // ---- history ----
  function fmtDate(iso) {
    const d = new Date(iso);
    return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' }) + ' ' + d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  }
  // Plain inline SVG sparkline of avg reaction time across recent drill
  // sessions, oldest-to-newest (left-to-right) — no charting library, works
  // fully offline like the rest of the app. Requested directly: "guardar
  // las sesiones anteriores para ver si hay mejoras en los tiempos" — the
  // session-by-session table already existed, but reading a trend out of a
  // column of numbers is real work; this puts it in one glance instead.
  // Lower on the Y axis = slower (worse); the line trending UP over time
  // (left to right) reads the same way "improving" reads anywhere else.
  function renderTrend(drillHist) {
    const box = $('#trendBox');
    if (!box) return;
    if (drillHist.length < 2) {
      box.innerHTML = drillHist.length === 1
        ? `<p class="trend-headline">Todavía hay una sola sesión guardada (${drillHist[0].avgRt.toFixed(0)} ms promedio) — la tendencia aparece a partir de la segunda.</p>`
        : `<p class="trend-headline">Sin sesiones guardadas todavía — la tendencia va a aparecer acá después del primer drill.</p>`;
      return;
    }
    // Stored newest-first; chart reads oldest→newest, left→right. Capped at
    // the most recent 20 so the chart doesn't get unreadably dense.
    const chrono = drillHist.slice(0, 20).slice().reverse();
    const vals = chrono.map(h => h.avgRt);
    const min = Math.min(...vals), max = Math.max(...vals);
    const range = Math.max(max - min, 1);
    const W = Math.max(280, chrono.length * 34), H = 90, padX = 10, padY = 12;
    const plotW = W - padX * 2, plotH = H - padY * 2;
    const pt = (i, v) => {
      const x = padX + (chrono.length === 1 ? plotW / 2 : (i / (chrono.length - 1)) * plotW);
      const y = padY + ((v - min) / range) * plotH;
      return [x, y];
    };
    const points = chrono.map((h, i) => pt(i, h.avgRt));
    const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
    const dots = chrono.map((h, i) => {
      const [x, y] = points[i];
      const acc = h.rounds ? h.hits / h.rounds : 0;
      const color = acc >= 0.75 ? 'var(--success)' : acc >= 0.5 ? 'var(--accent)' : 'var(--danger)';
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.5" fill="${color}"><title>${fmtDate(h.date)} — ${h.avgRt.toFixed(0)}ms, ${h.hits}/${h.rounds} aciertos</title></circle>`;
    }).join('');
    const svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
      <path d="${linePath}" fill="none" stroke="var(--accent)" stroke-width="2" opacity="0.85"/>
      ${dots}
    </svg>`;
    // Headline: compare the average of the earliest up-to-5 sessions shown
    // against the average of the most recent up-to-5 — a rolling comparison
    // rather than just first-vs-last, so one unusually good/bad session
    // doesn't single-handedly swing the whole verdict.
    const n = Math.max(1, Math.min(5, Math.floor(chrono.length / 2)));
    const earlyAvg = chrono.slice(0, n).reduce((a, h) => a + h.avgRt, 0) / n;
    const recentAvg = chrono.slice(-n).reduce((a, h) => a + h.avgRt, 0) / n;
    const deltaPct = ((recentAvg - earlyAvg) / earlyAvg) * 100;
    const improved = deltaPct < 0;
    const headline = Math.abs(deltaPct) < 1
      ? `Tiempo de reacción estable: ${recentAvg.toFixed(0)} ms en tus últimas ${n} sesión(es), similar a tus primeras ${n} (${earlyAvg.toFixed(0)} ms).`
      : `Tiempo de reacción ${improved ? 'bajó' : 'subió'} <span class="${improved ? 'delta-down' : 'delta-up'}">${Math.abs(deltaPct).toFixed(0)}%</span> — de ${earlyAvg.toFixed(0)} ms (primeras ${n}) a ${recentAvg.toFixed(0)} ms (últimas ${n}).`;
    box.innerHTML = `<p class="trend-headline">${headline}</p><div class="trend-svg-wrap">${svg}</div>`;
  }

  function renderHistory() {
    const drillHist = Storage.get('tm_drill_history', []);
    const liveHist = Storage.get('tm_live_history', []);
    renderTrend(drillHist);
    $('#histDrillBody').innerHTML = drillHist.map(h =>
      `<tr><td>${fmtDate(h.date)}</td><td>${h.rounds}</td><td>${h.hits}</td><td>${h.avgRt.toFixed(0)}ms</td></tr>`
    ).join('') || `<tr><td colspan="4" style="color:var(--text-faint);">Sin datos aún</td></tr>`;
    $('#histLiveBody').innerHTML = liveHist.map(h =>
      `<tr><td>${fmtDate(h.date)}</td><td>${h.distance}m</td><td>${h.shots}</td><td>${h.moa.toFixed(2)}</td></tr>`
    ).join('') || `<tr><td colspan="4" style="color:var(--text-faint);">Sin datos aún</td></tr>`;
  }

  function init() {
    $$('.tab-btn').forEach(b => b.addEventListener('click', () => { if (!b.disabled) setTab(b.dataset.tab); }));
    Safety.init(onArmed);

    $('#btnGenerate').addEventListener('click', buildTarget);
    $('#btnReroll').addEventListener('click', () => {
      if (!target) { buildTarget(); return; }
      target.shapes = Target.generateShapes(target.shapes.length, target.pageSize);
      refreshTargetUi();
    });
    $('#pageMode').addEventListener('change', () => {
      $('#distSimWrap').style.display = $('#pageMode').value === 'DRY' ? '' : 'none';
    });
    $('#pageMode').dispatchEvent(new Event('change'));
    $('#btnExportPdf').addEventListener('click', () => { if (target) { autoSaveTarget(); Target.exportPdf(target); } });
    $('#btnSaveTarget').addEventListener('click', saveCurrentTarget);
    renderSavedTargets();
    $('#savedTargetSearch').addEventListener('input', () => renderSavedTargets());
    $('#btnExportLibrary').addEventListener('click', exportLibrary);
    $('#btnImportLibrary').addEventListener('click', () => $('#importLibraryFile').click());
    $('#importLibraryFile').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) importLibrary(file);
      e.target.value = '';
    });

    $('#btnSendDry').addEventListener('click', () => { autoSaveTarget(); setTab('dry'); DryFire.ensureScope(); });
    $('#btnSendLive').addEventListener('click', () => { autoSaveTarget(); setTab('live'); LiveFire.ensureScope(); });

    $('#btnLock').addEventListener('click', () => {
      if ($('#btnLock').textContent.includes('Activar')) DryFire.toggleCamera();
      else DryFire.startLock();
    });
    $('#btnStartDrill').addEventListener('click', DryFire.startDrill);
    $('#btnStopDrill').addEventListener('click', DryFire.stopDrill);
    // Scoped to laser-color buttons only (data-color) — the cue-order
    // buttons below also carry class .toggle-btn for shared styling, but
    // they're a separate group and must not clear/set .active on each
    // other or call setLaserColor(undefined).
    $$('.toggle-btn[data-color]').forEach(b => b.addEventListener('click', () => {
      $$('.toggle-btn[data-color]').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      DryFire.setLaserColor(b.dataset.color);
    }));

    // Audio cues (voice + beep) config
    const audioCuesToggle = $('#audioCuesToggle');
    if (audioCuesToggle) {
      audioCuesToggle.checked = DryFire.getAudioCuesOn();
      audioCuesToggle.addEventListener('change', () => {
        DryFire.setAudioCuesOn(audioCuesToggle.checked);
      });
    }
    const cueOrderBtns = $$('.cue-order-btn');
    if (cueOrderBtns.length) {
      const savedOrder = DryFire.getCueOrder();
      cueOrderBtns.forEach(b => b.classList.toggle('active', b.dataset.cueOrder === savedOrder));
      cueOrderBtns.forEach(b => b.addEventListener('click', () => {
        cueOrderBtns.forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        DryFire.setCueOrder(b.dataset.cueOrder);
      }));
    }

    // Difficulty level (1=figura, 2=+color, 3=+número, 4=cuentas — see
    // buildPromptForLevel() in drill.js for how each is actually built).
    const DIFFICULTY_DESC = {
      1: 'Nivel 1 — sólo el nombre de la figura (ej. "Disparar: Triángulo"). Si hay más de una del mismo tipo en el blanco, se pasa automáticamente a un nivel más específico esa ronda para que la consigna nunca sea ambigua.',
      2: 'Nivel 2 — figura y color (ej. "Disparar: Triángulo Verde").',
      3: 'Nivel 3 — figura, color y número (ej. "Disparar: Triángulo Verde #4").',
      4: 'Nivel 4 — cuentas: disparar la figura cuyo número da el resultado de la cuenta (el modo original).',
    };
    const difficultyBtns = $$('.difficulty-btn');
    if (difficultyBtns.length) {
      const syncDifficultyUi = (level) => {
        difficultyBtns.forEach(x => x.classList.toggle('active', parseInt(x.dataset.difficulty, 10) === level));
        const desc = $('#difficultyDesc');
        if (desc) desc.textContent = DIFFICULTY_DESC[level] || '';
      };
      syncDifficultyUi(DryFire.getDifficulty());
      difficultyBtns.forEach(b => b.addEventListener('click', () => {
        const level = parseInt(b.dataset.difficulty, 10);
        DryFire.setDifficulty(level);
        syncDifficultyUi(DryFire.getDifficulty());
      }));
    }

    $('#btnLiveCamera').addEventListener('click', LiveFire.toggleCamera);
    $('#btnStartGroup').addEventListener('click', LiveFire.startGroup);
    $('#btnNewGroup').addEventListener('click', LiveFire.newGroup);
    $('#liveDistance').addEventListener('input', LiveFire.updateStats);

    $('#btnClearHist').addEventListener('click', () => {
      Storage.set('tm_drill_history', []);
      Storage.set('tm_live_history', []);
      renderHistory();
    });

    renderHistory();
    DryFire.setupCtaBar();

    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(() => {});
      });
    }
  }

  return { init, currentTarget, renderHistory, setTab, setActiveTarget, findSavedTargetById, recognizeTarget };
})();

document.addEventListener('DOMContentLoaded', App.init);
