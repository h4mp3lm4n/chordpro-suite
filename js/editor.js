// Editor module: Syntax-highlighted overlay textarea, debounced A4 preview,
// collapsible Inspector sidebar, Auto-Capo, profiles, zoom, fullscreen preview & quick-insert

import { $, $$, esc, debounce, slug, lsGet, lsSet, showToast } from './utils.js';
import { computeAutoCapo, songInfo } from './parser.js';
import { renderPagesA4, sheetCss, exportPdf } from './renderer.js';

const DIRECTIVE_GROUPS = (() => {
  const dd = (n, v) => [n, `{${n}: |${v || ''}}`];
  const groups = {
    Metadaten: ['title', 'sorttitle', 'subtitle', 'artist', 'composer', 'lyricist', 'arranger', 'copyright', 'album', 'year', 'key', 'tempo', 'duration', 'capo', 'tag']
      .map(n => dd(n))
      .concat([dd('time', '4/4'), ['meta', '{meta: Name |Wert}']]),
    Abschnitte: [
      ['Strophe', '{start_of_verse: Strophe}\n|\n{end_of_verse}\n'],
      ['Refrain', '{start_of_chorus: Refrain}\n|\n{end_of_chorus}\n'],
      ['Bridge', '{start_of_bridge: Bridge}\n|\n{end_of_bridge}\n'],
      ['Intro', '{start_of_verse: Intro}\n|\n{end_of_verse}\n'],
      ['Pre-Chorus', '{start_of_verse: Pre-Chorus}\n|\n{end_of_verse}\n'],
      ['Outro', '{start_of_verse: Outro}\n|\n{end_of_verse}\n'],
      ['Tab-Block', '{start_of_tab}\n|\n{end_of_tab}\n'],
      ['Grid-Block', '{start_of_grid}\n|\n{end_of_grid}\n'],
      ['chorus (wiederholen)', '{chorus: |}']
    ],
    Kommentare: ['comment', 'comment_italic', 'comment_box', 'highlight'].map(n => dd(n)),
    Layout: [
      ['new_page', '{new_page}\n'],
      ['new_physical_page', '{new_physical_page}\n'],
      ['column_break', '{column_break}\n'],
      dd('columns', '2'),
      ['image', '{image: src="|"}'],
      dd('pagetype', 'a4')
    ],
    Akkorde: [
      ['define (Gitarre)', '{define: | base-fret 1 frets x 0 2 2 1 0}'],
      ['define (Ukulele)', '{define: | base-fret 1 frets 0 0 0 3}'],
      dd('chord'),
      dd('transpose'),
      ['diagrams an', '{diagrams: on}\n'],
      ['diagrams aus', '{diagrams: off}\n']
    ],
    'Schrift/Farbe': []
  };
  ['text', 'chord', 'tab', 'title', 'footer', 'label'].forEach(p => {
    [['font', 'Helvetica'], ['size', '12'], ['colour', 'blue']].forEach(([q, v]) => {
      groups['Schrift/Farbe'].push(dd(p + q, v));
    });
  });
  return Object.entries(groups);
})();

export function createEditor({ storage, onOpenVoicing, onOpenUg, onOpenChords, onOpenMidi }) {
  const { store, currentSong, saveAll, saveCurrentFile } = storage;
  const L = store.layout;

  let shift = 0;
  let capo = 0;
  let nota = 'std';
  let zoomMode = lsGet('cp_zm', 'page');
  let pageCount = 1;
  let viewMode = lsGet('cp_vm', innerWidth < 760 ? 'code' : 'split');
  let splitRatio = lsGet('cp_ratio', 0.48);
  let inspectorOpen = lsGet('cp_insp', innerWidth >= 1100);

  function getOpts() {
    return {
      shift,
      capo,
      nota,
      cols: L.cols,
      dins: L.insA || [],
      cm: L.cm !== false,
      german: !!L.german
    };
  }

  function resetTransposition() {
    shift = 0;
    capo = 0;
    if ($('#cp')) $('#cp').value = '0';
  }

  // --- Lightweight Syntax Highlight Backdrop ---
  function highlightChordPro(raw) {
    // Trailing newline ensures scroll height matches textarea exactly
    const safe = esc(raw).replace(/\r\n/g, '\n');
    const lines = safe.split('\n').map(line => {
      if (/^\s*#/.test(line)) {
        return `<span class="hl-cmt">${line}</span>`;
      }
      if (/^\s*\{.*\}\s*$/.test(line)) {
        return `<span class="hl-dir">${line}</span>`;
      }
      return line.replace(/\[([^\]]*)\]/g, '<span class="hl-ch">[$1]</span>');
    });
    return lines.join('\n') + '\n';
  }

  function syncHighlight() {
    const ed = $('#ed');
    const hl = $('#ed-hl');
    if (!ed || !hl) return;
    hl.innerHTML = highlightChordPro(ed.value);
    hl.scrollTop = ed.scrollTop;
    hl.scrollLeft = ed.scrollLeft;
  }

  // --- Insert Text Helper ---
  function insertText(snippet, cursorOffset = null) {
    const ed = $('#ed');
    if (!ed) return;
    const pipeIdx = snippet.indexOf('|');
    const text = pipeIdx >= 0 ? snippet.replace('|', '') : snippet;
    const start = ed.selectionStart;
    const end = ed.selectionEnd;
    const val = ed.value;
    const needsNewline = start > 0 && val[start - 1] !== '\n' && text[0] === '{' ? '\n' : '';
    ed.value = val.slice(0, start) + needsNewline + text + val.slice(end);
    const pos = start + needsNewline.length + (cursorOffset != null ? cursorOffset : (pipeIdx >= 0 ? pipeIdx : text.length));
    ed.focus();
    ed.setSelectionRange(pos, pos);
    ed.dispatchEvent(new Event('input'));
  }

  // --- Preview Fit & Render ---
  function fit() {
    const pv = $('#pv');
    if (!pv || pv.offsetParent === null) return;
    const W = L.land ? 1123 : 794;
    const H = L.land ? 794 : 1123;
    const totalH = pageCount * H + (pageCount - 1) * 16;
    const aw = Math.max(0.1, (pv.clientWidth - 24) / W);
    const ah = Math.max(0.1, (pv.clientHeight - 24) / H);
    const scale = zoomMode === 'page' ? Math.min(aw, ah, 2) : zoomMode === 'width' ? Math.min(aw, 3) : zoomMode / 100;

    $('#sheet').style.transform = `scale(${scale})`;
    $('#wrap').style.width = `${W * scale}px`;
    $('#wrap').style.height = `${totalH * scale}px`;

    const pct = Math.round(scale * 100) + '%';
    if ($('#zs')) $('#zs').value = String(zoomMode);
    if ($('#zl')) $('#zl').textContent = pct;
    if ($('#pvz')) $('#pvz').textContent = pct;
  }

  function updateFileBar() {
    const sg = currentSong();
    const fnm = $('#fnm');
    if (fnm && document.activeElement !== fnm) {
      fnm.value = sg.file || '';
      fnm.placeholder = slug(songInfo(sg).title) + '.cho';
    }
    const dirty = sg._w !== sg.text;
    const dot = $('#fst');
    if (dot) {
      if (!sg.file) {
        dot.textContent = '● lokal';
        dot.title = 'Noch nicht als .cho-Datei gespeichert';
        dot.className = 'status-dot warn';
      } else if (dirty) {
        dot.textContent = '● geändert';
        dot.title = 'Ungespeicherte Änderungen (Strg+S)';
        dot.className = 'status-dot warn';
      } else {
        dot.textContent = '✓ gespeichert';
        dot.title = 'Mit Datei synchron';
        dot.className = 'status-dot ok';
      }
    }
    const lpBtn = $('#flp');
    if (lpBtn) {
      const isLp = songInfo(sg).loop;
      lpBtn.classList.toggle('on', isLp);
      lpBtn.textContent = isLp ? '🔁 Looper: Ja' : '🔁 Looper: Nein';
    }
  }

  function draw() {
    const sg = currentSong();
    const sh = $('#sheet');
    if (!sg || !sh) return;
    sh.style.cssText = sheetCss(L);
    const { html, pageCount: pc } = renderPagesA4(sg.text, L, getOpts());
    pageCount = pc;
    sh.innerHTML = html;

    $('#sh').textContent = shift > 0 ? `+${shift}` : String(shift);
    $('#cn').textContent = String(L.cols);
    updateFileBar();
    fit();
  }

  const drawDebounced = debounce(() => {
    saveAll(false);
    draw();
  }, 110);

  function loadSongIntoEditor() {
    const sg = currentSong();
    $('#ed').value = sg.text;
    syncHighlight();
    draw();
  }

  function setViewMode(mode) {
    viewMode = mode;
    lsSet('cp_vm', mode);
    const edPane = $('#ed-pane') || $('#ed-wrap');
    const pv = $('#pv');
    const dv = $('#dv');
    if (edPane) edPane.style.display = mode === 'pv' ? 'none' : '';
    if (pv) pv.style.display = mode === 'code' ? 'none' : '';
    if (dv) dv.style.display = mode === 'split' ? '' : 'none';
    if (edPane) edPane.style.flex = mode === 'split' ? `0 0 ${splitRatio * 100}%` : '1 1 100%';
    $$('[data-v]').forEach(b => b.classList.toggle('on', b.dataset.v === mode));
    fit();
  }

  function setInspectorOpen(open) {
    inspectorOpen = !!open;
    lsSet('cp_insp', inspectorOpen);
    $('#insp').hidden = !inspectorOpen;
    $('#b-insp').classList.toggle('on', inspectorOpen);
    setTimeout(fit, 30);
  }

  function setPreviewFullscreen(on) {
    document.body.classList.toggle('pvf', on);
    if (on) {
      $('#pv').style.display = '';
      try { document.documentElement.requestFullscreen?.()?.catch?.(() => 0); } catch { /* ignore */ }
    } else {
      setViewMode(viewMode);
      try { if (document.fullscreenElement) document.exitFullscreen(); } catch { /* ignore */ }
    }
    setTimeout(fit, 60);
  }

  function populateProfiles() {
    $('#pf').innerHTML = Object.keys(store.profiles).map(k => `<option>${esc(k)}</option>`).join('');
  }

  function syncInspectorUi() {
    ['fs', 'cfs', 'ls', 'sg', 'dsz', 'dgp', 'cc', 'tc', 'ff', 'fw'].forEach(k => {
      const el = $('#' + k);
      if (el) el.value = L[k];
    });
    if ($('#mhl')) $('#mhl').value = L.hl || '#fde047';
    if ($('#mcm')) $('#mcm').checked = L.cm !== false;
    if ($('#de-not')) $('#de-not').checked = !!L.german;
    $$('#insg input').forEach(c => { c.checked = (L.insA || []).includes(c.dataset.i); });
    if ($('#dszg')) $('#dszg').hidden = !(L.insA && L.insA.length);
    $$('[data-mf]').forEach(c => { c.checked = !!L.mf[c.dataset.mf]; });
    $('#cn').textContent = String(L.cols);
    $('#or').textContent = L.land ? '📄 Querformat' : '📄 Hochformat';
  }

  function initControls() {
    // Capo select 0..11
    $('#cp').innerHTML = [...Array(12).keys()].map(i => `<option value="${i}">${i === 0 ? 'Kein' : 'Bund ' + i}</option>`).join('');
    $('#cp').onchange = e => { capo = +e.target.value; draw(); };

    // Directive insert dropdown
    $('#mre').innerHTML = '<option value="">+ Direktive…</option>' +
      DIRECTIVE_GROUPS.map(([grp, arr], gi) =>
        `<optgroup label="${esc(grp)}">${arr.map((x, i) => `<option value="${gi}.${i}">${esc(x[0])}</option>`).join('')}</optgroup>`
      ).join('');
    $('#mre').onchange = e => {
      const [g, i] = e.target.value.split('.');
      if (g !== '' && DIRECTIVE_GROUPS[+g]) {
        insertText(DIRECTIVE_GROUPS[+g][1][+i][1]);
      }
      e.target.value = '';
    };

    // Quick-insert buttons
    $('#qi-v').onclick = () => {
      const n = ($('#ed').value.match(/\{start_of_verse:\s*Strophe/gi) || []).length + 1;
      insertText(`{start_of_verse: Strophe ${n}}\n|\n{end_of_verse}\n`);
    };
    $('#qi-c').onclick = () => insertText('{start_of_chorus: Refrain}\n|\n{end_of_chorus}\n');
    $('#qi-b').onclick = () => insertText('{start_of_bridge: Bridge}\n|\n{end_of_bridge}\n');
    $('#qi-ch').onclick = () => insertText('[|]');

    // Editor textarea input, auto-close '[', highlight & proportional scroll sync
    const ed = $('#ed');
    ed.addEventListener('input', () => {
      currentSong().text = ed.value;
      syncHighlight();
      drawDebounced();
    });
    ed.addEventListener('scroll', () => {
      const hl = $('#ed-hl');
      if (hl) {
        hl.scrollTop = ed.scrollTop;
        hl.scrollLeft = ed.scrollLeft;
      }
      // Gentle proportional scroll-sync to A4 preview in split mode
      if (viewMode === 'split') {
        const pv = $('#pv');
        const maxEd = ed.scrollHeight - ed.clientHeight;
        const maxPv = pv.scrollHeight - pv.clientHeight;
        if (maxEd > 20 && maxPv > 20) {
          pv.scrollTop = (ed.scrollTop / maxEd) * maxPv;
        }
      }
    }, { passive: true });

    ed.addEventListener('keydown', e => {
      if (e.key === '[' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const s = ed.selectionStart, end = ed.selectionEnd;
        if (s === end) {
          e.preventDefault();
          insertText('[|]');
        }
      }
    });

    // Transposition & Auto-Capo
    $('#tm').onclick = () => { shift--; draw(); };
    $('#tp').onclick = () => { shift++; draw(); };
    $('#ac').onclick = () => {
      const ins = L.insA || [];
      if (ins.length === 1 && ins[0] === 'Klavier') {
        showToast('Auto-Capo ist für Gitarre/Ukulele');
        return;
      }
      capo = computeAutoCapo(currentSong().text, shift);
      $('#cp').value = String(capo);
      draw();
      showToast(capo ? `Auto-Capo: Bund ${capo}` : 'Auto-Capo: Kein Capo nötig');
    };
    $('#nt').onchange = e => { nota = e.target.value; draw(); };
    $('#de-not').onchange = e => { L.german = e.target.checked; saveAll(); draw(); };

    // View mode & Inspector toggle
    $$('[data-v]').forEach(b => { b.onclick = () => setViewMode(b.dataset.v); });
    $('#b-insp').onclick = () => setInspectorOpen(!inspectorOpen);
    $('#insp-close').onclick = () => setInspectorOpen(false);
    $('#b-pvf').onclick = () => setPreviewFullscreen(true);
    $('#pvx').onclick = () => setPreviewFullscreen(false);

    // Split drag & stack toggle
    $('#sk').onclick = () => {
      $('#split').classList.toggle('stk');
      lsSet('cp_stk', $('#split').classList.contains('stk'));
      fit();
    };
    if (lsGet('cp_stk', false)) $('#split').classList.add('stk');

    $('#dv').onpointerdown = e => {
      e.preventDefault();
      const sp = $('#split');
      const isCol = getComputedStyle(sp).flexDirection === 'column';
      const onMove = ev => {
        const r = sp.getBoundingClientRect();
        splitRatio = Math.min(0.82, Math.max(0.18, isCol ? (ev.clientY - r.top) / r.height : (ev.clientX - r.left) / r.width));
        $('#ed-pane').style.flex = `0 0 ${splitRatio * 100}%`;
        fit();
      };
      const onUp = () => {
        removeEventListener('pointermove', onMove);
        removeEventListener('pointerup', onUp);
        lsSet('cp_ratio', splitRatio);
      };
      addEventListener('pointermove', onMove);
      addEventListener('pointerup', onUp);
    };

    // Layout & Format Inspector controls
    $('#cm').onclick = () => { L.cols = Math.max(1, L.cols - 1); saveAll(); draw(); };
    $('#cpl').onclick = () => { L.cols = Math.min(4, L.cols + 1); saveAll(); draw(); };
    $('#or').onclick = () => { L.land = !L.land; saveAll(); syncInspectorUi(); draw(); };

    ['fs', 'cfs', 'ls', 'sg', 'dsz', 'dgp', 'cc', 'tc', 'ff', 'fw'].forEach(k => {
      const el = $('#' + k);
      if (!el) return;
      el.oninput = () => {
        if (el.type === 'number') {
          if (el.value === '' || isNaN(+el.value)) return;
          L[k] = +el.value;
        } else {
          L[k] = el.value;
        }
        saveAll();
        draw();
      };
    });

    $('#mhl').oninput = e => { L.hl = e.target.value; saveAll(); draw(); };
    $('#mcm').onchange = e => { L.cm = e.target.checked; saveAll(); draw(); };
    $$('#insg input').forEach(c => {
      c.onchange = () => {
        L.insA = $$('#insg input:checked').map(x => x.dataset.i);
        saveAll();
        syncInspectorUi();
        draw();
      };
    });
    $$('[data-mf]').forEach(c => {
      c.onchange = () => {
        L.mf[c.dataset.mf] = c.checked;
        saveAll();
        draw();
      };
    });

    // Profiles
    populateProfiles();
    $('#pf').onchange = e => {
      const p = store.profiles[e.target.value];
      if (!p) return;
      Object.assign(L, JSON.parse(JSON.stringify(p)));
      syncInspectorUi();
      saveAll();
      draw();
    };
    $('#ps').onclick = () => {
      const name = $('#pn').value.trim();
      if (!name) return;
      const saved = lsGet('cp_prof', {});
      saved[name] = JSON.parse(JSON.stringify(L));
      lsSet('cp_prof', saved);
      store.profiles[name] = saved[name];
      populateProfiles();
      $('#pf').value = name;
      $('#pn').value = '';
      showToast(`Profil „${name}“ gespeichert`);
    };
    $('#pd').onclick = () => {
      const name = $('#pf').value;
      const saved = lsGet('cp_prof', {});
      if (!saved[name]) { showToast('Standard-Profile können nicht gelöscht werden'); return; }
      delete saved[name];
      delete store.profiles[name];
      lsSet('cp_prof', saved);
      populateProfiles();
      showToast(`Profil „${name}“ gelöscht`);
    };

    // Zoom controls + Ctrl+Wheel + Pinch on A4 preview
    const stepZoom = d => {
      const curPct = Math.round((parseFloat(($('#sheet').style.transform || '').slice(6)) || 1) * 100);
      zoomMode = Math.max(25, Math.min(400, curPct + d));
      lsSet('cp_zm', zoomMode);
      fit();
    };
    $('#zs').onchange = e => { zoomMode = isNaN(e.target.value) ? e.target.value : +e.target.value; lsSet('cp_zm', zoomMode); fit(); };
    $('#zo').onclick = () => stepZoom(-10);
    $('#zi').onclick = () => stepZoom(10);
    $('#pvm').onclick = () => stepZoom(-10);
    $('#pvn').onclick = () => stepZoom(10);
    $('#pvp').onclick = () => { zoomMode = 'page'; lsSet('cp_zm', zoomMode); fit(); };
    $('#pvw').onclick = () => { zoomMode = 'width'; lsSet('cp_zm', zoomMode); fit(); };

    const pv = $('#pv');
    pv.addEventListener('wheel', e => {
      if (e.ctrlKey) {
        e.preventDefault();
        stepZoom(e.deltaY < 0 ? 10 : -10);
      }
    }, { passive: false });

    let pd0 = 0, ps0 = 100;
    const pdist = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    pv.addEventListener('touchstart', e => {
      if (e.touches.length === 2) {
        pd0 = pdist(e.touches);
        ps0 = Math.round((parseFloat(($('#sheet').style.transform || '').slice(6)) || 1) * 100);
      }
    }, { passive: true });
    pv.addEventListener('touchmove', e => {
      if (e.touches.length === 2 && pd0) {
        e.preventDefault();
        zoomMode = Math.max(25, Math.min(400, Math.round(ps0 * (pdist(e.touches) / pd0))));
        fit();
      }
    }, { passive: false });
    pv.addEventListener('touchend', e => {
      if (e.touches.length < 2 && pd0) { pd0 = 0; lsSet('cp_zm', zoomMode); }
    });

    // Click on chord diagram -> open voicing picker
    $('#sheet').addEventListener('click', e => {
      const card = e.target.closest('[data-ch]');
      if (card && onOpenVoicing) onOpenVoicing(card.dataset.ch, card.dataset.ins);
    });

    // File bar & Looper tag
    $('#fsv').onclick = () => saveCurrentFile($('#fnm').value.trim()).then(updateFileBar);
    $('#fnm').onkeydown = e => { if (e.key === 'Enter') saveCurrentFile($('#fnm').value.trim()).then(updateFileBar); };
    $('#fau').checked = store.autoSave;
    $('#fau').onchange = e => { store.autoSave = e.target.checked; saveAll(); };
    $('#flp').onclick = () => {
      const re = /^\{\s*tag\s*:\s*loop\s*\}\s*\n?/im;
      if (re.test(ed.value)) {
        ed.value = ed.value.replace(re, '');
      } else if (/^\{\s*title\s*[:\s]/i.test(ed.value)) {
        ed.value = ed.value.replace(/^(\{\s*title\s*[:\s][^\n]*\n)/i, '$1{tag: loop}\n');
      } else {
        ed.value = '{tag: loop}\n' + ed.value;
      }
      ed.dispatchEvent(new Event('input'));
    };

    // Tool triggers
    $('#b-ug').onclick = () => onOpenUg && onOpenUg();
    $('#b-ch').onclick = () => onOpenChords && onOpenChords();
    $('#b-mi').onclick = () => onOpenMidi && onOpenMidi();
    $('#b-pdf').onclick = () => exportPdf([currentSong()], L, getOpts(), true);

    // Global Ctrl+S & Escape from fullscreen preview
    window.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && !$('#m-editor').hidden && !$('#live').classList.contains('show')) {
        e.preventDefault();
        saveCurrentFile($('#fnm').value.trim()).then(updateFileBar);
      } else if (e.key === 'Escape' && document.body.classList.contains('pvf')) {
        setPreviewFullscreen(false);
      }
    });

    window.addEventListener('resize', fit);
    if (typeof ResizeObserver !== 'undefined') {
      let fitRaf = 0;
      new ResizeObserver(() => {
        cancelAnimationFrame(fitRaf);
        fitRaf = requestAnimationFrame(fit);
      }).observe(pv);
    }

    syncInspectorUi();
    setViewMode(viewMode);
    setInspectorOpen(inspectorOpen);
  }

  initControls();

  return {
    getOpts,
    draw,
    fit,
    loadSongIntoEditor,
    resetTransposition,
    insertText,
    updateFileBar,
    populateProfiles
  };
}
