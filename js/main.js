// Main entry point: bootstraps storage, editor, library, chord tools, live stage, hybrid remote, MIDI & SW updates

import { $, $$, esc, uid, lsGet, lsSet, showToast } from './utils.js';
import { createStore } from './storage.js';
import { ugConvert } from './parser.js';
import { initChordTools } from './chords.js';
import { createEditor } from './editor.js';
import { createLibrary } from './library.js';
import { createRemote } from './remote.js';
import { createStage } from './stage.js';

// --- Theme initialization (persisted!) ---
{
  const savedTheme = lsGet('cp_theme', null);
  if (savedTheme === 'dark' || savedTheme === 'light') {
    document.documentElement.dataset.theme = savedTheme;
  }
}

// --- Modal helpers ---
function openModal(id) {
  $('#md').classList.add('show');
  $$('#md .box').forEach(b => b.classList.toggle('show', b.id === id));
}

function closeModal() {
  $('#md').classList.remove('show');
}

function askConfirm(message, options) {
  return new Promise(resolve => {
    $('#cft').textContent = message;
    $('#cfb').innerHTML = options
      .map((opt, i) => `<button data-i="${i}" class="${i === options.length - 1 ? '' : 'pri'}">${esc(opt)}</button>`)
      .join('');
    openModal('x-cf');
    $$('#cfb button').forEach(btn => {
      btn.onclick = () => {
        closeModal();
        resolve(+btn.dataset.i);
      };
    });
  });
}

// Register Service Worker immediately (before UI boot) so updates never get blocked by stale HTML
function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  navigator.serviceWorker.register('sw.js').then(reg => {
    const showUpdate = worker => {
      const bar = $('#sw-update');
      if (!bar) return;
      bar.hidden = false;
      $('#sw-reload').onclick = () => worker.postMessage({ type: 'SKIP_WAITING' });
    };
    if (reg.waiting) showUpdate(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      if (!nw) return;
      nw.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) {
          showUpdate(nw);
        }
      });
    });
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloaded) return;
      reloaded = true;
      location.reload();
    });
  }).catch(() => {});
}

// --- App Bootstrap ---
async function boot() {
  registerServiceWorker();
  const storage = createStore();
  const { store } = storage;

  // Bind modal close buttons & backdrop click
  $$('.xc').forEach(b => { b.onclick = closeModal; });
  $('#md').addEventListener('click', e => { if (e.target === $('#md')) closeModal(); });

  // Theme toggle
  $('#th').onclick = () => {
    const r = document.documentElement;
    const isDark = getComputedStyle(r).getPropertyValue('--bg').trim() === '#0b0f17';
    const next = isDark ? 'light' : 'dark';
    r.dataset.theme = next;
    lsSet('cp_theme', next);
  };

  // Remote & Stage cross-wiring
  let stage = null;

  const remote = createRemote({
    onReceive: msg => stage && stage.handleRemoteMessage(msg),
    onStatusChange: st => {
      updateRemotePill(st);
      if (stage) stage.onRemoteStatusChanged();
    },
    onOpenModal: () => openModal('x-sy')
  });

  function updateRemotePill(st) {
    const btn = $('#sybtn');
    if (!btn) return;
    const paired = st.connected && (st.role === 'display' ? st.peers.ctrl > 0 : st.peers.display > 0);
    btn.classList.toggle('connected', paired);
    btn.classList.toggle('waiting', !!st.role && !paired);
    if (paired) {
      btn.innerHTML = st.role === 'display'
        ? `<span class="dot ok"></span><span>Anzeige</span>`
        : `<span class="dot ok"></span><span>Steuerung</span>`;
    } else if (st.connected && st.role) {
      btn.innerHTML = `<span class="dot warn"></span><span>Warte…</span>`;
    } else if (st.role) {
      btn.innerHTML = `<span class="dot warn"></span><span>Verbinde…</span>`;
    } else {
      btn.innerHTML = `<span class="dot"></span><span>Remote</span>`;
    }
  }

  function updateStorageBadge(msg) {
    const badge = $('#fsb2');
    if (badge) {
      const linkedFiles = Object.keys(store.fileHandles).length;
      if (store.serverSongsEnabled) {
        badge.textContent = '🖥 Laptop-Ordner';
        badge.className = 'pill-btn ok';
      } else if (store.dirHandle) {
        badge.textContent = `📁 ${store.dirHandle.name}`;
        badge.className = 'pill-btn ok';
      } else if (linkedFiles > 0) {
        badge.textContent = `📄 ${linkedFiles} verknüpft`;
        badge.className = 'pill-btn ok';
      } else {
        badge.textContent = '💾 Lokal';
        badge.className = 'pill-btn warn';
      }
    }
    if (msg) {
      const fss = $('#fss');
      if (fss) fss.textContent = msg;
    }
  }

  // Init Editor
  let chordTools = null;
  const editor = createEditor({
    storage,
    onOpenVoicing: (c, ins) => chordTools.openVoicingPicker(c, ins),
    onOpenUg: () => openModal('x-ug'),
    onOpenChords: () => chordTools.openChordEditor(),
    onOpenMidi: () => openMidiModal()
  });

  // Init Unified Chord Tools
  chordTools = initChordTools({
    openModal,
    closeModal,
    onChanged: () => editor.draw(),
    insertDefine: snippet => editor.insertText(snippet)
  });

  // Init Live Stage
  stage = createStage({
    storage,
    remote,
    getEditorOpts: () => editor.getOpts(),
    onExit: () => setMode('editor')
  });

  // Init Library & Setlist
  const library = createLibrary({
    storage,
    askConfirm,
    onOpenSong: id => {
      store.curId = String(id);
      editor.resetTransposition();
      setMode('editor');
    },
    onStartStage: src => stage.start(src),
    onUpdateBadges: () => {
      updateStorageBadge();
      editor.updateFileBar();
    }
  });

  storage.onStatusChange = msg => {
    updateStorageBadge(msg);
    editor.updateFileBar();
  };
  storage.onLibraryChange = () => {
    library.renderLibrary();
    library.renderSetUI();
    editor.loadSongIntoEditor();
    updateStorageBadge();
  };

  // Mode navigation
  function setMode(mode) {
    if (mode === 'live') {
      stage.start();
      return;
    }
    $$('.mode').forEach(el => { el.hidden = el.id !== 'm-' + mode; });
    $$('#nav button').forEach(b => b.classList.toggle('on', b.dataset.m === mode));
    if (mode === 'editor') editor.loadSongIntoEditor();
    if (mode === 'lib') library.renderLibrary();
    if (mode === 'set') library.renderSetUI();
  }

  $$('#nav button').forEach(b => { b.onclick = () => setMode(b.dataset.m); });
  $('#sybtn').onclick = () => remote.openModal();
  $('#fsb2').onclick = () => setMode('lib');

  window.addEventListener('cp:mode', e => setMode(e.detail));
  window.addEventListener('cp:open-stage', () => stage.start());

  // Ultimate Guitar Converter
  $('#ugc').onclick = () => {
    const raw = $('#ugi').value;
    if (!raw.trim()) return;
    const normH = $('#ug-norm-h')?.checked !== false;
    const converted = ugConvert(raw, normH);
    const hasTitle = /^\{\s*(?:title|t)\s*:/im.test(converted);
    const text = (hasTitle ? '' : '{title: Importierter Song}\n\n') + converted;
    const id = uid();
    store.songs.push({ id, text });
    store.curId = id;
    storage.saveAll(true);
    closeModal();
    editor.resetTransposition();
    setMode('editor');
    showToast('Song aus Ultimate Guitar importiert');
  };

  // Web MIDI / Pedal Learn
  let midiLearnAction = null;
  const midiMap = lsGet('cp_midi', {});
  const midiActions = {
    next: 'Nächster Song (⏭)',
    prev: 'Vorheriger Song (⏮)',
    scroll: 'AutoScroll Start / Pause (▶)',
    scrollUp: 'Scroll hoch (▲)',
    scrollDown: 'Scroll runter (▼)',
    speedUp: 'Scroll-Tempo schneller (+)',
    speedDown: 'Scroll-Tempo langsamer (−)',
    blackout: 'Beamer Schwarz an / aus (⬛)'
  };

  function renderMidiUi() {
    $('#mal').innerHTML = Object.keys(midiActions).map(act => `
      <div class="flex gap-2 items-center my-2">
        <span style="flex:1;font-size:13px">${midiActions[act]}: <code>${esc(midiMap[act] || '–')}</code></span>
        <button class="btn-sm${midiLearnAction === act ? ' pri' : ''}" data-a="${act}">${midiLearnAction === act ? 'Warte auf Signal…' : 'Anlernen'}</button>
        ${midiMap[act] ? `<button class="btn-xs danger" data-clr="${act}" title="Zuweisung entfernen">✕</button>` : ''}
      </div>`).join('');
    $$('#mal [data-a]').forEach(b => {
      b.onclick = () => {
        midiLearnAction = midiLearnAction === b.dataset.a ? null : b.dataset.a;
        renderMidiUi();
      };
    });
    $$('#mal [data-clr]').forEach(b => {
      b.onclick = () => {
        delete midiMap[b.dataset.clr];
        lsSet('cp_midi', midiMap);
        renderMidiUi();
      };
    });
  }

  function handleMidiMessage(e) {
    const [status, d1, d2] = e.data;
    const type = status & 0xf0;
    // Accept Note On (0x90), Control Change (0xb0) with value > 0, and Program Change (0xc0)
    if (!((type === 0x90 && d2 > 0) || (type === 0xb0 && d2 > 0) || type === 0xc0)) return;
    const key = `${type.toString(16)}-${d1}`;
    if (midiLearnAction) {
      midiMap[midiLearnAction] = key;
      lsSet('cp_midi', midiMap);
      midiLearnAction = null;
      renderMidiUi();
      return;
    }
    const act = Object.keys(midiMap).find(x => midiMap[x] === key);
    if (!act || !stage.isOpen()) {
      // Allow song switching even if stage already open; ignore others when not in stage
      if (act === 'next' && stage.isOpen()) stage.goSong(1);
      else if (act === 'prev' && stage.isOpen()) stage.goSong(-1);
      return;
    }
    if (act === 'next') stage.goSong(1);
    else if (act === 'prev') stage.goSong(-1);
    else if (act === 'scroll') stage.togglePlay();
    else if (act === 'scrollUp') stage.nudge(-1);
    else if (act === 'scrollDown') stage.nudge(1);
    else if (act === 'speedUp') stage.adjustTempo(5);
    else if (act === 'speedDown') stage.adjustTempo(-5);
    else if (act === 'blackout') stage.toggleBlackout();
  }

  async function openMidiModal() {
    openModal('x-mi');
    renderMidiUi();
    if (!navigator.requestMIDIAccess) {
      $('#mst').textContent = 'Web MIDI wird von diesem Browser nicht unterstützt (z. B. Safari auf iPadOS; in Chrome auf Android/Desktop verfügbar). Bluetooth-Tastatur-Pedale (Bild↑/Bild↓/Pfeile) funktionieren auf allen Geräten.';
      return;
    }
    try {
      const access = await navigator.requestMIDIAccess();
      const hook = () => {
        access.inputs.forEach(inp => { inp.onmidimessage = handleMidiMessage; });
        const names = [...access.inputs.values()].map(i => i.name).join(', ');
        $('#mst').textContent = 'MIDI-Geräte: ' + (names || 'keine gefunden');
      };
      hook();
      access.onstatechange = hook;
    } catch {
      $('#mst').textContent = 'MIDI-Zugriff verweigert.';
    }
  }

  // Load persistent data from IndexedDB / Local Server
  await storage.init();
  updateStorageBadge();
  setMode('editor');

  // Hybrid remote auto-detection & QR deep-link auto-connect
  const autoRole = await remote.initFromUrl();
  updateRemotePill(remote.state);
  if (autoRole === 'ctrl') {
    showToast('Verbunden als Steuerung – starte Live Stage…', 2500);
    setTimeout(() => stage.start(), 350);
  } else if (autoRole === 'display') {
    stage.start();
    $('#live').classList.add('focus');
  }
}

boot();
