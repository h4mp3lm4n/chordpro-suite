// Live Stage View: Wake Lock, Pianist vs. Beamer mode, Blackout, Section Jump-Bar,
// 60fps Smooth Remote Scroll Interpolation, Visual Metronome & Pinch-to-Zoom

import { $, $$, esc, throttleTrailing } from './utils.js';
import { songInfo } from './parser.js';
import { buildSongModel } from './renderer.js';

const STAGE_DIA_THEME = { c: '#e5e7eb', d: '#facc15', p: '#facc15', k: '#374151', kb: '#111827' };

export function createStage({ storage, remote, getEditorOpts, onExit }) {
  const { store, findSong, saveAll } = storage;
  const SG = store.stage;

  let listIdx = 0;
  let playing = false;
  let scrollPos = 0;
  let lastTick = 0;
  let pageAcc = 0;
  let stageShift = 0;
  let remoteSong = null;        // Song received when in 'display' role
  let remoteDisplayBlackout = false;
  let ctrlBlackout = false;
  let lastSentSig = '';
  let lastSentText = '';

  // Smooth remote scroll interpolation target (Display role)
  let smoothTarget = null;
  let wakeLock = null;

  // Visual metronome (Controller / Local only)
  let metroOn = false;
  let metroTimer = null;
  let metroBeat = 0;

  const scroller = () => $('#lsc');

  // --- Screen Wake Lock ---
  async function acquireWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
      if (wakeLock && !wakeLock.released) return;
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch {
      // Ignore if battery saver / unsupported
    }
  }

  function releaseWakeLock() {
    if (wakeLock) {
      try { wakeLock.release(); } catch { /* ignore */ }
      wakeLock = null;
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && isOpen()) {
      acquireWakeLock();
    }
  });

  function isOpen() {
    return $('#live').classList.contains('show');
  }

  function toast(msg) {
    let t = $('#ltoast');
    if (!t) {
      $('#live').insertAdjacentHTML('beforeend', '<div id="ltoast"></div>');
      t = $('#ltoast');
    }
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(t._h);
    t._h = setTimeout(() => { t.style.opacity = '0'; }, 1000);
  }

  // Returns array of { id, shift } entries for current stage source
  function activeEntries() {
    const v = $('#lsrc').value;
    const valid = arr => arr.filter(item => store.songs.some(s => String(s.id) === String(item.id)));
    let list;
    if (v === 'all') {
      list = store.songs.map(s => ({ id: String(s.id), shift: 0 }));
    } else if (v === 'one') {
      list = [{ id: String(store.curId), shift: getEditorOpts().shift || 0 }];
    } else if (v.startsWith('sl:')) {
      list = valid(store.namedSets[v.slice(3)] || []);
    } else {
      list = valid(store.setlist);
    }
    return list.length ? list : store.songs.map(s => ({ id: String(s.id), shift: 0 }));
  }

  function populateSources(selected) {
    $('#lsrc').innerHTML =
      '<option value="set">Aktuelle Setlist</option>' +
      '<option value="all">Alle Songs</option>' +
      '<option value="one">Nur dieser Song</option>' +
      Object.keys(store.namedSets).map(k => `<option value="sl:${esc(k)}">Setlist: ${esc(k)}</option>`).join('');
    $('#lsrc').value = selected;
  }

  // --- Visual Metronome ---
  function stopMetronome() {
    clearInterval(metroTimer);
    metroTimer = null;
    const dot = $('#lmet-dot');
    if (dot) dot.classList.remove('beat', 'accent');
  }

  function startMetronome(bpm) {
    stopMetronome();
    if (!metroOn || !bpm || bpm < 30 || bpm > 260) return;
    metroBeat = 0;
    const dot = $('#lmet-dot');
    const pulse = () => {
      if (!dot || !isOpen()) return;
      const isDownbeat = metroBeat % 4 === 0;
      dot.classList.remove('beat', 'accent');
      void dot.offsetWidth;
      dot.classList.add(isDownbeat ? 'accent' : 'beat');
      metroBeat++;
    };
    pulse();
    metroTimer = setInterval(pulse, Math.round(60000 / bpm));
  }

  function updateMetronomeUi(bpm) {
    const btn = $('#lmet');
    if (!btn) return;
    const effectiveBpm = bpm || 0;
    btn.hidden = remote.state.role === 'display' || !effectiveBpm;
    btn.classList.toggle('on', metroOn && !!effectiveBpm);
    const lbl = $('#lmet-bpm');
    if (lbl) lbl.textContent = effectiveBpm ? `${effectiveBpm}` : '–';
    if (metroOn && effectiveBpm) startMetronome(effectiveBpm);
    else stopMetronome();
  }

  // --- Anchor-based Remote Scroll Helpers ---
  function anchorNodes() {
    return [...scroller().querySelectorAll('.ln,.lab,.gr,.cm')].filter(e => e.offsetParent !== null);
  }

  function computeAnchor() {
    const c = scroller();
    const ct = c.getBoundingClientRect().top;
    const es = anchorNodes();
    for (let i = 0; i < es.length; i++) {
      const r = es[i].getBoundingClientRect();
      if (r.bottom > ct + 1) {
        return { i, f: Math.max(0, Math.min(1, (ct - r.top) / Math.max(1, r.height))) };
      }
    }
    return { i: 0, f: 0 };
  }

  function applyAnchorSmooth(anchor, instant = false) {
    const c = scroller();
    const es = anchorNodes();
    if (!es.length) return;
    const e = es[Math.min(anchor.i, es.length - 1)];
    if (!e) return;
    const r = e.getBoundingClientRect();
    const ct = c.getBoundingClientRect().top;
    const maxScroll = Math.max(0, c.scrollHeight - c.clientHeight);
    const target = Math.max(0, Math.min(maxScroll, c.scrollTop + (r.top - ct) + (anchor.f || 0) * r.height));
    if (instant) {
      smoothTarget = null;
      c.scrollTop = target;
      scrollPos = target;
    } else {
      smoothTarget = target;
    }
  }

  function jumpToSection(secId, fromRemote = false) {
    const c = scroller();
    const el = c.querySelector(`[data-sec="${secId}"], [data-sec-grp="${secId}"]`);
    if (!el) return;
    const ct = c.getBoundingClientRect().top;
    const r = el.getBoundingClientRect();
    const target = Math.max(0, Math.min(c.scrollHeight - c.clientHeight, c.scrollTop + (r.top - ct) - 18));

    if (fromRemote) {
      smoothTarget = target;
    } else {
      c.scrollTo({ top: target, behavior: 'smooth' });
      scrollPos = target;
      if (remote.state.connected && remote.state.role === 'ctrl') {
        remote.send({ t: 'jump', secId });
      }
    }
    // Highlight active section pill
    $$('#ljump button').forEach(b => b.classList.toggle('on', b.dataset.sec === String(secId)));
  }

  function sendSongToRemote(force = false, keepScroll = false) {
    if (!remote.state.connected || remote.state.role !== 'ctrl' || !isOpen()) return;
    const entries = activeEntries();
    const entry = entries[listIdx] || entries[0];
    const sg = findSong(entry.id);
    if (!sg) return;
    const edOpts = getEditorOpts();
    const view = $('#lvw').value;
    const sig = JSON.stringify([sg.id, stageShift, edOpts.capo, edOpts.nota, !!store.layout.german, view]);
    if (!force && sig === lastSentSig && lastSentText === sg.text) return;
    lastSentSig = sig;
    lastSentText = sg.text;
    remote.send({
      t: 'song',
      songId: sg.id,
      text: sg.text,
      shift: stageShift,
      capo: edOpts.capo,
      nota: edOpts.nota,
      german: !!store.layout.german,
      view,
      keepScroll
    });
    if (!keepScroll) {
      setTimeout(() => sendScrollToRemote(), 120);
    } else {
      setTimeout(() => sendScrollToRemote(), 60);
    }
  }

  const sendScrollToRemote = throttleTrailing(() => {
    if (remote.state.connected && remote.state.role === 'ctrl' && isOpen()) {
      remote.send({ t: 'scroll', ...computeAnchor() });
    }
  }, 35);

  function setBlackoutLocal(on) {
    ctrlBlackout = !!on;
    const btn = $('#lblack');
    if (btn) {
      btn.classList.toggle('on', ctrlBlackout);
      btn.innerHTML = ctrlBlackout ? '⬛ <span class="lbt">Beamer AN</span>' : '⬛ <span class="lbt">Schwarz</span>';
    }
    const ind = $('#lblack-ind');
    if (ind) ind.hidden = !ctrlBlackout;
    if (remote.state.connected && remote.state.role === 'ctrl') {
      remote.send({ t: 'blackout', on: ctrlBlackout });
    }
    toast(ctrlBlackout ? 'Beamer: Schwarzbild' : 'Beamer: Aktiv');
  }

  function applyDisplayBlackout(on) {
    remoteDisplayBlackout = !!on;
    const ov = $('#lblackout');
    if (ov) ov.classList.toggle('show', remoteDisplayBlackout);
  }

  // --- Core Stage Render ---
  function render(keepScroll = false) {
    const c = scroller();
    const entries = activeEntries();
    if (listIdx >= entries.length) listIdx = 0;
    const entry = entries[listIdx] || entries[0];
    const isDisplayRemote = remote.state.role === 'display' && !!remoteSong;
    const sg = isDisplayRemote ? remoteSong : findSong(entry.id);
    if (!sg) return;

    const rel = keepScroll && c.scrollHeight > 0 ? c.scrollTop / c.scrollHeight : 0;
    if (!isDisplayRemote) store.curId = sg.id;

    // Resolve view mode: Display can override controller view (e.g. "Publikum: Nur Text, zentriert")
    const ctrlView = isDisplayRemote ? (remoteSong.view || 'c') : $('#lvw').value;
    let effectiveView = ctrlView;
    let isAudienceMode = false;
    if (remote.state.role === 'display') {
      if (SG.beamerMode === 'lyrics') { effectiveView = 't'; isAudienceMode = true; }
      else if (SG.beamerMode === 'chords') effectiveView = 'c';
      else if (SG.beamerMode === 'diagrams') effectiveView = 'g';
    }

    const edOpts = getEditorOpts();
    const shiftVal = isDisplayRemote ? (remoteSong.shift || 0) : stageShift;
    const capoVal = isDisplayRemote ? (remoteSong.capo || 0) : edOpts.capo;
    const notaVal = isDisplayRemote ? (remoteSong.nota || 'std') : edOpts.nota;
    const germanVal = isDisplayRemote ? !!remoteSong.german : !!store.layout.german;

    const model = buildSongModel(sg.text, store.layout, {
      shift: shiftVal,
      capo: capoVal,
      nota: notaVal,
      german: germanVal,
      cols: 1,
      dins: effectiveView === 'g' ? (SG.ins && SG.ins.length ? SG.ins : ['Gitarre']) : [],
      th: { ...STAGE_DIA_THEME, sz: SG.dsz, gp: SG.dgp },
      diaSep: true,
      cm: !isAudienceMode && SG.hint
    });

    c.className =
      (effectiveView === 't' ? 'nochord ' : '') +
      (SG.hint && !isAudienceMode ? '' : 'nohint ') +
      (isAudienceMode ? 'audience ' : '');

    c.style.cssText =
      `font-size:${SG.fs}px;font-family:${SG.ff};font-weight:${SG.fw};--lh:${SG.ls};` +
      `--cc:${SG.cc};--cs:${SG.cfs}px;--hc:${SG.hc};--hb:${SG.hb};--sg:${SG.sg}px;` +
      `color:${SG.tc};background:${SG.bg}`;

    const diaBlock = model.dh
      ? `<div class="ldia${SG.pos === 'pin' ? ' pin' : ''}" style="--lbg:${SG.bg};font-size:${Math.max(10, Math.round(SG.fs * SG.dsz / 100 * 0.6))}px">${model.dh}</div>`
      : '';

    c.innerHTML =
      `<div class="lw">${model.head}${diaBlock}` +
      model.groups.filter(g => !g.brk).map(g => model.renderGroup(g, g.l)).join('') +
      `<div class="lend">— Ende —</div></div>`;

    if (keepScroll) {
      c.scrollTop = rel * c.scrollHeight;
      scrollPos = c.scrollTop;
    }

    const info = songInfo(sg);
    $('#lt').textContent = isDisplayRemote
      ? `📡 ${info.title}`
      : `${listIdx + 1}/${entries.length} · ${info.title}${info.loop ? ' 🔁' : ''}`;
    $('#lsh').textContent = shiftVal > 0 ? `+${shiftVal}` : String(shiftVal);

    // Populate Section Jump-Bar (hidden on display role to keep beamer clean)
    const jumpBar = $('#ljump');
    if (jumpBar) {
      if (remote.state.role === 'display' || !model.sections.length) {
        jumpBar.hidden = true;
        jumpBar.innerHTML = '';
      } else {
        jumpBar.hidden = false;
        jumpBar.innerHTML = model.sections
          .map(s => `<button data-sec="${s.id}" class="jump-pill jump-${s.type}">${esc(s.label)}</button>`)
          .join('');
        $$('#ljump button').forEach(b => {
          b.onclick = () => jumpToSection(b.dataset.sec, false);
        });
      }
    }

    // Show/hide role-specific controls
    const blackBtn = $('#lblack');
    if (blackBtn) blackBtn.hidden = remote.state.role !== 'ctrl';
    const beamerRow = $('#sg-beamer-wrap');
    if (beamerRow) beamerRow.hidden = remote.state.role !== 'display';

    updateMetronomeUi(info.tempo);
    updateSpeedLabel();
    updatePageIndicator();
    sendSongToRemote(false, keepScroll);
  }

  function updatePageIndicator() {
    const c = scroller();
    const H = c.clientHeight || 1;
    const total = Math.max(1, Math.ceil(c.scrollHeight / H));
    const current = Math.min(total, Math.round(c.scrollTop / H) + 1);
    $('#lpg').textContent = `Seite ${current}/${total}`;
  }

  function setPlay(v) {
    playing = !!v;
    lastTick = 0;
    pageAcc = 0;
    scrollPos = scroller().scrollTop;
    $('#lpl').textContent = playing ? '⏸' : '▶';
    $('#lpl').classList.toggle('playing', playing);
  }

  function togglePlay() {
    setPlay(!playing);
  }

  function goSong(delta) {
    const entries = activeEntries();
    if (!entries.length) return;
    listIdx = (listIdx + delta + entries.length) % entries.length;
    stageShift = entries[listIdx]?.shift || 0;
    setPlay(false);
    render(false);
    scroller().scrollTop = 0;
    scrollPos = 0;
    updatePageIndicator();
    sendSongToRemote(true, false);
  }

  function pageStep(dir) {
    const c = scroller();
    const t = Math.max(0, Math.min(c.scrollTop + dir * c.clientHeight * 0.85, c.scrollHeight - c.clientHeight));
    c.scrollTo({ top: t, behavior: 'smooth' });
    scrollPos = t;
  }

  function nudge(dir) {
    const c = scroller();
    const frac = Math.max(0.1, Math.min(1, (SG.stepPct || 33) / 100));
    const t = Math.max(0, Math.min(c.scrollHeight - c.clientHeight, c.scrollTop + dir * c.clientHeight * frac));
    if (playing) {
      scrollPos = t;
      c.scrollTop = t;
    } else {
      c.scrollTo({ top: t, behavior: 'smooth' });
      scrollPos = t;
    }
  }

  function updateSpeedLabel() {
    const txt = $('#lm').value === 's' ? `${SG.sp} px/s` : `${(180 / SG.sp).toFixed(1)} s/S`;
    if ($('#spv')) $('#spv').textContent = txt;
    if ($('#spv-mini')) $('#spv-mini').textContent = txt;
  }

  function adjustTempo(delta) {
    SG.sp = Math.max(5, Math.min(300, SG.sp + delta));
    saveAll();
    updateSpeedLabel();
    toast('Scroll-Tempo ' + ($('#spv')?.textContent || ''));
  }

  function closeSettings() {
    const panel = $('#lset-panel');
    if (panel) panel.hidden = true;
    const btn = $('#lgr');
    if (btn) btn.classList.remove('on');
  }

  // --- Animation Loop (AutoScroll + 60fps Remote Smooth Lerp) ---
  function tick(ts) {
    const c = scroller();

    // Smooth remote scrolling on Display (Beamer)
    if (smoothTarget !== null && isOpen()) {
      const diff = smoothTarget - c.scrollTop;
      if (Math.abs(diff) < 0.75) {
        c.scrollTop = smoothTarget;
        scrollPos = smoothTarget;
        smoothTarget = null;
      } else {
        c.scrollTop += diff * 0.22;
        scrollPos = c.scrollTop;
      }
    }

    // Local AutoScroll
    if (playing && isOpen()) {
      if ($('#lm').value === 's') {
        if (lastTick) {
          scrollPos += SG.sp * (ts - lastTick) / 1000;
          c.scrollTop = scrollPos;
        }
        lastTick = ts;
        if (scrollPos >= c.scrollHeight - c.clientHeight) setPlay(false);
      } else {
        pageAcc += lastTick ? ts - lastTick : 0;
        lastTick = ts;
        if (pageAcc > 180000 / SG.sp) {
          pageAcc = 0;
          if (c.scrollTop + c.clientHeight >= c.scrollHeight - 4) setPlay(false);
          else pageStep(1);
        }
      }
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  // --- Public API ---
  function start(src) {
    populateSources(src || $('#lsrc').value || (store.setlist.length ? 'set' : 'all'));
    const entries = activeEntries();
    const foundIdx = entries.findIndex(e => String(e.id) === String(store.curId));
    listIdx = foundIdx >= 0 ? foundIdx : 0;
    stageShift = foundIdx >= 0
      ? (entries[foundIdx].shift || (src === 'one' ? getEditorOpts().shift : 0))
      : (getEditorOpts().shift || 0);

    $('#live').classList.add('show');
    acquireWakeLock();
    try {
      const r = document.documentElement.requestFullscreen?.();
      r?.catch?.(() => 0);
    } catch { /* ignore on iOS */ }

    render(false);
    scroller().scrollTop = 0;
    scrollPos = 0;
    sendSongToRemote(true, false);
  }

  function exit() {
    setPlay(false);
    stopMetronome();
    releaseWakeLock();
    applyDisplayBlackout(false);
    $('#live').classList.remove('show', 'focus');
    try { if (document.fullscreenElement) document.exitFullscreen(); } catch { /* ignore */ }
    if (onExit) onExit();
  }

  // Handle incoming remote messages
  function handleRemoteMessage(msg) {
    if (msg.t === 'hello' && remote.state.role === 'ctrl') {
      sendSongToRemote(true, true);
      if (ctrlBlackout) remote.send({ t: 'blackout', on: true });
      return;
    }

    if (remote.state.role !== 'display') return;

    if (msg.t === 'song') {
      const sameSong = remoteSong && remoteSong.songId === msg.songId && msg.keepScroll;
      remoteSong = {
        id: 'remote',
        songId: msg.songId,
        text: msg.text,
        shift: msg.shift || 0,
        capo: msg.capo || 0,
        nota: msg.nota || 'std',
        german: !!msg.german,
        view: msg.view || 'c'
      };
      // Automatically dismiss Remote modal & QR overlay on the display as soon as a song arrives!
      const md = $('#md');
      if (md) md.classList.remove('show');
      const qrOv = $('#beamer-qr-overlay');
      if (qrOv) qrOv.classList.remove('show');

      if (!isOpen()) {
        start();
        $('#live').classList.add('focus');
      } else {
        render(!!sameSong);
      }
      if (!sameSong) {
        smoothTarget = null;
        scroller().scrollTop = 0;
        scrollPos = 0;
      }
    } else if (msg.t === 'scroll' && remoteSong) {
      applyAnchorSmooth(msg, false);
    } else if (msg.t === 'jump' && remoteSong) {
      jumpToSection(msg.secId, true);
    } else if (msg.t === 'blackout') {
      applyDisplayBlackout(!!msg.on);
    }
  }

  function onRemoteStatusChanged() {
    const on = remote.state.connected;
    const role = remote.state.role;
    const btn = $('#lsy');
    if (btn) {
      btn.classList.toggle('connected', on);
      btn.textContent = on ? (role === 'display' ? '📡 Anzeige' : '📡 Aktiv') : '📡';
    }
    if (!role) {
      remoteSong = null;
      applyDisplayBlackout(false);
      ctrlBlackout = false;
      if (isOpen()) render(true);
    } else if (on && role === 'ctrl' && isOpen()) {
      sendSongToRemote(true, true);
    } else if (role === 'display' && isOpen()) {
      render(true);
    }
  }

  // --- Wire Controls ---
  function initControls() {
    $('#lp').onclick = () => goSong(-1);
    $('#ln').onclick = () => goSong(1);
    $('#lpl').onclick = togglePlay;
    $('#lup').onclick = () => nudge(-1);
    $('#ldw').onclick = () => nudge(1);
    $('#ltm').onclick = () => adjustTempo(-5);
    $('#ltp').onclick = () => adjustTempo(5);
    $('#lsm').onclick = () => adjustTempo(-5);
    $('#lsp').onclick = () => adjustTempo(5);
    $('#lk').onclick = () => { stageShift--; render(true); };
    $('#lj').onclick = () => { stageShift++; render(true); };
    $('#lx').onclick = exit;
    $('#lfo').onclick = () => { closeSettings(); $('#live').classList.add('focus'); };
    $('#lfab').onclick = () => $('#live').classList.remove('focus');
    $('#lsy').onclick = () => remote.openModal();
    $('#lblack').onclick = () => setBlackoutLocal(!ctrlBlackout);
    $('#lmet').onclick = () => {
      metroOn = !metroOn;
      const entries = activeEntries();
      const sg = findSong(entries[listIdx]?.id);
      updateMetronomeUi(sg ? songInfo(sg).tempo : 0);
    };

    $('#lgr').onclick = e => {
      e.stopPropagation();
      const panel = $('#lset-panel');
      const willOpen = panel.hidden;
      panel.hidden = !willOpen;
      $('#lgr').classList.toggle('on', willOpen);
    };

    $('#live').addEventListener('click', e => {
      if (!e.target.closest('#lset-panel') && !e.target.closest('#lgr')) closeSettings();
      const b = e.target.closest('button');
      if (b) b.blur();
    });

    const bindings = [
      ['sgc', 'cc'], ['sgt', 'tc'], ['sgb', 'bg'], ['sgf', 'ff'], ['sgw', 'fw'],
      ['sgl', 'ls'], ['sgs', 'sg'], ['sgfs', 'fs'], ['sgcs', 'cfs'], ['sghc', 'hc'],
      ['sghb', 'hb'], ['sgd', 'dsz'], ['sgg', 'dgp'], ['sgstep', 'stepPct']
    ];
    for (const [id, key] of bindings) {
      const el = $('#' + id);
      if (!el) continue;
      el.value = SG[key];
      el.oninput = () => {
        if (el.type === 'number') {
          if (el.value === '' || isNaN(+el.value)) return;
          SG[key] = +el.value;
        } else {
          SG[key] = el.value;
        }
        saveAll();
        render(true);
      };
    }

    $('#sgh').checked = SG.hint;
    $('#sgh').onchange = e => { SG.hint = e.target.checked; saveAll(); render(true); };
    $('#sgp').value = SG.pos || 'pin';
    $('#sgp').onchange = e => { SG.pos = e.target.value; saveAll(); render(true); };

    const beamerSel = $('#sg-beamer');
    if (beamerSel) {
      beamerSel.value = SG.beamerMode || 'follow';
      beamerSel.onchange = e => { SG.beamerMode = e.target.value; saveAll(); render(true); };
    }

    $$('#sgdia [data-si]').forEach(c => {
      c.checked = (SG.ins || []).includes(c.dataset.si);
      c.onchange = () => {
        SG.ins = $$('#sgdia [data-si]:checked').map(x => x.dataset.si);
        if (SG.ins.length) $('#lvw').value = 'g';
        else if ($('#lvw').value === 'g') $('#lvw').value = 'c';
        saveAll();
        render(true);
      };
    });

    $('#lvw').onchange = () => render(true);
    $('#lm').onchange = () => { setPlay(false); updateSpeedLabel(); };
    $('#lsrc').onchange = () => {
      const entries = activeEntries();
      const idx = entries.findIndex(e => String(e.id) === String(store.curId));
      listIdx = idx >= 0 ? idx : 0;
      stageShift = entries[listIdx]?.shift || 0;
      setPlay(false);
      render(false);
      scroller().scrollTop = 0;
      scrollPos = 0;
    };
    $$('#lset-panel select').forEach(x => x.addEventListener('change', () => x.blur()));

    // Scroll & Touch events
    const c = scroller();
    c.addEventListener('scroll', () => {
      updatePageIndicator();
      if (remote.state.role === 'ctrl') sendScrollToRemote();
    }, { passive: true });

    ['wheel', 'touchstart'].forEach(ev => {
      c.addEventListener(ev, () => {
        scrollPos = c.scrollTop;
        smoothTarget = null;
      }, { passive: true });
    });

    c.onclick = e => {
      if ($('#lm').value !== 'p') return;
      const r = c.getBoundingClientRect();
      pageStep(e.clientX - r.left > r.width / 3 ? 1 : -1);
    };

    // GPU Pinch-to-Zoom for Stage font size
    let d0 = 0, rScale = 1, f0 = 0, c0 = 0, lw = null;
    const dist = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    c.addEventListener('touchstart', e => {
      if (e.touches.length === 2) {
        d0 = dist(e.touches);
        rScale = 1;
        f0 = SG.fs;
        c0 = SG.cfs;
        lw = c.querySelector('.lw');
        if (lw) {
          const b = c.getBoundingClientRect();
          const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - b.left;
          const my = (e.touches[0].clientY + e.touches[1].clientY) / 2 - b.top + c.scrollTop;
          lw.style.transformOrigin = `${mx}px ${my}px`;
          lw.style.willChange = 'transform';
        }
      }
    }, { passive: true });
    c.addEventListener('touchmove', e => {
      if (e.touches.length === 2 && d0 && lw) {
        e.preventDefault();
        rScale = Math.max(14 / f0, Math.min(160 / f0, dist(e.touches) / d0));
        lw.style.transform = `scale(${rScale})`;
      }
    }, { passive: false });
    c.addEventListener('touchend', e => {
      if (e.touches.length < 2 && d0) {
        d0 = 0;
        if (lw) {
          lw.style.transform = '';
          lw.style.willChange = '';
          if (Math.abs(rScale - 1) > 0.02) {
            SG.fs = Math.round(f0 * rScale);
            SG.cfs = Math.max(10, Math.round(c0 * rScale));
            $('#sgfs').value = SG.fs;
            $('#sgcs').value = SG.cfs;
            saveAll();
            render(true);
          }
        }
        lw = null;
      }
    });

    // Ctrl+Wheel font zoom on desktop
    let wheelRaf = 0;
    c.addEventListener('wheel', e => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const delta = e.deltaY < 0 ? 2 : -2;
      SG.fs = Math.max(14, Math.min(160, SG.fs + delta));
      SG.cfs = Math.max(10, Math.min(160, SG.cfs + delta));
      $('#sgfs').value = SG.fs;
      $('#sgcs').value = SG.cfs;
      saveAll();
      cancelAnimationFrame(wheelRaf);
      wheelRaf = requestAnimationFrame(() => render(true));
    }, { passive: false });

    // Keyboard shortcuts in Live Stage
    window.addEventListener('keydown', e => {
      if (!isOpen() || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
      else if (e.code === 'PageDown') { e.preventDefault(); goSong(1); }
      else if (e.code === 'PageUp') { e.preventDefault(); goSong(-1); }
      else if (e.code === 'ArrowDown' || e.code === 'ArrowRight') { e.preventDefault(); nudge(1); }
      else if (e.code === 'ArrowUp' || e.code === 'ArrowLeft') { e.preventDefault(); nudge(-1); }
      else if (e.key === '+' || e.key === '=') adjustTempo(5);
      else if (e.key === '-') adjustTempo(-5);
      else if (e.key === 'b' || e.key === 'B') {
        if (remote.state.role === 'ctrl') setBlackoutLocal(!ctrlBlackout);
      } else if (e.key === 'Escape') {
        if ($('#live').classList.contains('focus')) $('#live').classList.remove('focus');
        else exit();
      }
    });

    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { if (isOpen()) render(true); }, 250);
    });
  }

  initControls();

  return {
    start,
    exit,
    isOpen,
    goSong,
    togglePlay,
    nudge,
    adjustTempo,
    toggleBlackout: () => setBlackoutLocal(!ctrlBlackout),
    handleRemoteMessage,
    onRemoteStatusChanged
  };
}
