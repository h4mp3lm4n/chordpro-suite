// Persistent storage: IndexedDB (songs & file handles) + localStorage (settings) + File System Access API + Local Server Sync

import { lsGet, lsSet, slug, downloadText, uid, showToast } from './utils.js';
import { songInfo } from './parser.js';
import { chordOverrides, getCustomChords, mergeChordLibrary } from './chords.js';

export const SAMPLE_SONG = `{title: Amazing Grace}
{artist: Traditional}
{key: G}
{tempo: 80}
{duration: 3:30}

{start_of_verse: Strophe 1}
[G]Amazing [G7]grace, how [C]sweet the [G]sound
That [G]saved a [Em]wretch like [D]me
[G]I once was [G7]lost, but [C]now am [G]found
Was [Em]blind, but [D]now I [G]see
{end_of_verse}

{start_of_chorus: Refrain}
[G]My chains are [C]gone, I've been set [G]free
My God, my [C]Savior has ransomed [G]me
And like a [C]flood His mercy [G]reigns
Unending [D]love, amazing [G]grace
{end_of_chorus}
`;

export const DEFAULT_LAYOUT = {
  cols: 1,
  fs: 16,
  cfs: 16,
  ls: 1.3,
  cc: '#ea580c',
  tc: '#111827',
  hl: '#fde047',
  land: false,
  ff: 'Arial,sans-serif',
  fw: '400',
  sg: 10,
  dsz: 100,
  dgp: 14,
  insA: ['Gitarre'],
  cm: true,
  german: false,
  mf: {
    artist: true, subtitle: true, composer: false, lyricist: false,
    arranger: false, album: false, year: false, key: true,
    time: false, tempo: true, duration: false, capo: true, copyright: false
  }
};

export const BUILTIN_PROFILES = {
  'Standard A4': { ...DEFAULT_LAYOUT, cols: 1, fs: 16, cfs: 16, ls: 1.3, sg: 10 },
  'Kompakt': { ...DEFAULT_LAYOUT, cols: 2, fs: 11, cfs: 11, ls: 1.1, sg: 6, dsz: 70, dgp: 8 },
  'Große Schrift': { ...DEFAULT_LAYOUT, cols: 1, fs: 24, cfs: 24, ls: 1.4, sg: 16 }
};

export const DEFAULT_STAGE = {
  fs: 36,
  cfs: 36,
  cc: '#facc15',
  tc: '#ffffff',
  bg: '#000000',
  fw: '400',
  ff: 'Arial,sans-serif',
  ls: 1.5,
  sg: 24,
  sp: 30,
  stepPct: 33,
  hint: true,
  hc: '#111111',
  hb: '#f59e0b',
  ins: [],
  dsz: 100,
  dgp: 14,
  pos: 'pin',
  beamerMode: 'follow' // 'follow' | 'lyrics' | 'chords' | 'diagrams'
};

// IndexedDB wrapper (upgraded to v2 with separate 'songs' store alongside 'h' handles store)
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('cp', 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('h')) db.createObjectStore('h');
      if (!db.objectStoreNames.contains('data')) db.createObjectStore('data');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(store, key) {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const q = tx.objectStore(store).get(key);
      q.onsuccess = () => resolve(q.result);
      q.onerror = () => reject(q.error);
    });
  } catch {
    return undefined;
  }
}

async function idbPut(store, key, val) {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(val, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('IndexedDB put failed:', err);
    return false;
  }
}

export const FS_DIR_OK = typeof window !== 'undefined' && !!window.showDirectoryPicker;
export const FS_FILE_OK = typeof window !== 'undefined' && !!window.showOpenFilePicker;
const FILE_TYPES = [{ description: 'ChordPro', accept: { 'text/plain': ['.cho', '.chordpro', '.crd', '.pro', '.txt'] } }];

export function createStore() {
  const savedLayout = lsGet('cp_layout', {});
  const layout = {
    ...DEFAULT_LAYOUT,
    ...savedLayout,
    mf: { ...DEFAULT_LAYOUT.mf, ...(savedLayout.mf || {}) }
  };
  if (layout.sg < 5 && layout.sg > 0) layout.sg = Math.round(layout.sg * layout.fs);

  const savedStage = lsGet('cp_stage', null);
  const stage = { ...DEFAULT_STAGE, ...(savedStage || {}) };
  if (stage.sg < 5 && stage.sg > 0) stage.sg = Math.round(stage.sg * stage.fs);
  if (!savedStage && typeof innerWidth !== 'undefined' && innerWidth < 760) {
    stage.fs = 24;
    stage.cfs = 24;
  }

  const userProfiles = lsGet('cp_prof', {});
  const profiles = { ...BUILTIN_PROFILES, ...userProfiles };

  const store = {
    songs: [{ id: 'sample-1', text: SAMPLE_SONG }],
    curId: 'sample-1',
    // Setlist items: normalized as [{ id, shift }] (backwards compatible with raw IDs)
    setlist: normalizeSetlist(lsGet('cp_set', [])),
    namedSets: normalizeNamedSets(lsGet('cp_sets', {})),
    layout,
    stage,
    profiles,
    autoSave: lsGet('cp_auto', false),
    dirHandle: null,
    fileHandles: {},
    serverSongsEnabled: false,
    onStatusChange: null,
    onLibraryChange: null
  };

  let fsTimer = null;
  let idbTimer = null;

  function normalizeSetlist(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.map(item => {
      if (item && typeof item === 'object' && item.id !== undefined) {
        return { id: String(item.id), shift: Number(item.shift) || 0 };
      }
      return { id: String(item), shift: 0 };
    });
  }

  function normalizeNamedSets(obj) {
    const out = {};
    if (obj && typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) {
        out[k] = normalizeSetlist(v);
      }
    }
    return out;
  }

  function emitStatus(msg) {
    if (store.onStatusChange) store.onStatusChange(msg);
  }

  function emitLibrary() {
    if (store.onLibraryChange) store.onLibraryChange();
  }

  function findSong(id) {
    const sId = String(id);
    return store.songs.find(s => String(s.id) === sId) || store.songs[0];
  }

  function currentSong() {
    return findSong(store.curId);
  }

  function fileNameFor(song) {
    return song.file || slug(songInfo(song).title) + '.cho';
  }

  function persistSettings() {
    lsSet('cp_set', store.setlist);
    lsSet('cp_sets', store.namedSets);
    lsSet('cp_layout', store.layout);
    lsSet('cp_stage', store.stage);
    lsSet('cp_auto', store.autoSave);
  }

  function saveAll(immediate = false) {
    persistSettings();
    const writeSongs = () => {
      idbPut('data', 'songs', store.songs);
      // Mirror compact snapshot to localStorage only if < 1.5 MB for quick recovery
      try {
        const json = JSON.stringify(store.songs);
        if (json.length < 1_500_000) localStorage.setItem('cp_songs', json);
      } catch {
        // IndexedDB is primary store; ignore localStorage quota overflow silently
      }
    };
    if (immediate) {
      clearTimeout(idbTimer);
      writeSongs();
    } else {
      clearTimeout(idbTimer);
      idbTimer = setTimeout(writeSongs, 200);
    }
    scheduleFileSync();
  }

  async function saveHandles() {
    await idbPut('h', 'files', store.fileHandles);
  }

  async function writeHandle(handle, text) {
    if ((await handle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
      if ((await handle.requestPermission({ mode: 'readwrite' })) !== 'granted') {
        throw new Error('keine Berechtigung');
      }
    }
    const w = await handle.createWritable();
    await w.write(text);
    await w.close();
  }

  async function writeSongToServer(song) {
    if (!store.serverSongsEnabled || !song.file) return false;
    try {
      const res = await fetch('/api/songs/' + encodeURIComponent(song.file), {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: song.text
      });
      if (res.ok) {
        song._w = song.text;
        return true;
      }
    } catch {
      // ignore
    }
    return false;
  }

  function scheduleFileSync() {
    if (!store.autoSave) return;
    clearTimeout(fsTimer);
    fsTimer = setTimeout(async () => {
      for (const sg of store.songs) {
        if (!sg.file || sg._w === sg.text) continue;
        if (store.dirHandle) {
          try {
            const fh = await store.dirHandle.getFileHandle(sg.file, { create: true });
            const w = await fh.createWritable();
            await w.write(sg.text);
            await w.close();
            sg._w = sg.text;
            emitStatus(`📁 ${store.dirHandle.name} – ${sg.file} gespeichert (${new Date().toLocaleTimeString()})`);
          } catch (e) {
            emitStatus('Auto-Speichern fehlgeschlagen: ' + e.name);
          }
        } else if (store.fileHandles[sg.id]) {
          try {
            const h = store.fileHandles[sg.id];
            if ((await h.queryPermission({ mode: 'readwrite' })) === 'granted') {
              await writeHandle(h, sg.text);
              sg._w = sg.text;
              emitStatus(`📄 ${sg.file} gespeichert (${new Date().toLocaleTimeString()})`);
            }
          } catch {
            // ignore until manual save
          }
        } else if (store.serverSongsEnabled) {
          if (await writeSongToServer(sg)) {
            emitStatus(`🖥 Server – ${sg.file} gespeichert (${new Date().toLocaleTimeString()})`);
          }
        }
      }
    }, 700);
  }

  async function shareOrDownload(entries) {
    const files = entries.map(([name, text]) => new File([text], name, { type: 'text/plain' }));
    if (navigator.canShare && navigator.canShare({ files })) {
      await navigator.share({ files });
      return 'shared';
    }
    entries.forEach(([name, text], i) => {
      setTimeout(() => downloadText(name, text), i * 280);
    });
    return 'downloaded';
  }

  async function saveCurrentFile(requestedName) {
    const sg = currentSong();
    let name = (requestedName || slug(songInfo(sg).title)).replace(/[\\/:*?"<>|]+/g, '').trim();
    if (!/\.(cho|chordpro|crd|pro)$/i.test(name)) name += '.cho';

    if (store.songs.some(x => x !== sg && x.file === name)) {
      emitStatus('Dateiname bereits vergeben: ' + name);
      return false;
    }

    const oldName = sg.file;
    const handle = store.fileHandles[sg.id];
    let how = '';

    try {
      if (store.dirHandle) {
        const fh = await store.dirHandle.getFileHandle(name, { create: true });
        const w = await fh.createWritable();
        await w.write(sg.text);
        await w.close();
        if (oldName && oldName !== name) {
          try { await store.dirHandle.removeEntry(oldName); } catch { /* ignore */ }
        }
        how = `in „${store.dirHandle.name}“ gespeichert`;
      } else if (store.serverSongsEnabled) {
        sg.file = name;
        const ok = await writeSongToServer(sg);
        if (!ok) throw new Error('Server-Speichern fehlgeschlagen');
        how = 'im Laptop-Ordner gespeichert';
      } else if (handle && oldName === name) {
        await writeHandle(handle, sg.text);
        how = 'in verknüpfte Datei geschrieben';
      } else if (FS_FILE_OK && window.showSaveFilePicker) {
        const nh = await window.showSaveFilePicker({ suggestedName: name, types: FILE_TYPES });
        await writeHandle(nh, sg.text);
        store.fileHandles[sg.id] = nh;
        name = nh.name;
        await saveHandles();
        how = `als „${name}“ gespeichert und verknüpft`;
      } else {
        const mode = await shareOrDownload([[name, sg.text]]);
        how = mode === 'shared' ? 'über Teilen-Menü gesichert' : 'heruntergeladen';
      }
    } catch (e) {
      if (e.name === 'AbortError') return false;
      emitStatus(`Speichern fehlgeschlagen: ${e.message || e.name}`);
      return false;
    }

    sg.file = name;
    sg._w = sg.text;
    saveAll(true);
    emitStatus(`💾 ${name} ${how}`);
    showToast(`Gespeichert: ${name}`);
    return true;
  }

  async function loadFromDirectory() {
    if (!store.dirHandle) return;
    const files = {};
    for await (const [nm, h] of store.dirHandle.entries()) {
      if (h.kind === 'file' && /\.(cho|chordpro|crd|pro|txt)$/i.test(nm)) {
        files[nm] = await (await h.getFile()).text();
      }
    }
    for (const sg of store.songs) {
      if (sg.file && files[sg.file] !== undefined) {
        sg.text = files[sg.file];
        sg._w = sg.text;
        delete files[sg.file];
      } else {
        delete sg.file;
      }
    }
    for (const [nm, text] of Object.entries(files)) {
      store.songs.push({ id: uid(), file: nm, text, _w: text });
    }
    if (!store.songs.some(x => String(x.id) === String(store.curId))) {
      store.curId = store.songs[0].id;
    }
    saveAll(true);
    const linked = store.songs.filter(x => x.file).length;
    emitStatus(`📁 „${store.dirHandle.name}“ verbunden – ${linked} Dateien eingelesen`);
    emitLibrary();
  }

  async function connectDirectory(pickNew = false) {
    if (!FS_DIR_OK) {
      emitStatus('Ordner-Zugriff nur in Chrome/Edge am Desktop. Nutze Import & Teilen/Speichern (oder den lokalen Laptop-Server).');
      return;
    }
    if (window.top !== window) {
      emitStatus('Eingebettete Ansicht (iframe): Ordnerwahl gesperrt – direkt im Browser-Tab öffnen.');
      return;
    }
    try {
      let h = pickNew ? null : await idbGet('h', 'dir');
      if (h && (await h.requestPermission({ mode: 'readwrite' })) === 'granted') {
        store.dirHandle = h;
      } else {
        store.dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
        await idbPut('h', 'dir', store.dirHandle);
      }
      await loadFromDirectory();
    } catch (e) {
      store.dirHandle = null;
      emitStatus(
        e.name === 'AbortError'
          ? 'Abgebrochen – Hinweis: Systemordner wie Downloads/Desktop sind gesperrt, bitte einen Unterordner wählen (z. B. Dokumente\\ChordPro).'
          : `Ordnerzugriff nicht möglich (${e.name})`
      );
    }
  }

  async function linkIndividualFiles() {
    if (!FS_FILE_OK) return;
    try {
      const hs = await window.showOpenFilePicker({ multiple: true, types: FILE_TYPES });
      for (const h of hs) {
        const text = await (await h.getFile()).text();
        let sg = store.songs.find(x => x.file === h.name);
        if (sg) {
          sg.text = text;
        } else {
          sg = { id: uid(), text };
          store.songs.push(sg);
        }
        sg.file = h.name;
        sg._w = text;
        store.fileHandles[sg.id] = h;
      }
      await saveHandles();
      saveAll(true);
      emitLibrary();
      emitStatus(`${hs.length} Dateien verknüpft – „Speichern“ schreibt direkt zurück.`);
    } catch (e) {
      if (e.name !== 'AbortError') emitStatus('Verknüpfen fehlgeschlagen: ' + e.name);
    }
  }

  async function syncFromServerSongs() {
    try {
      const res = await fetch('/api/songs');
      if (!res.ok) return false;
      const list = await res.json();
      if (!Array.isArray(list)) return false;
      store.serverSongsEnabled = true;
      let added = 0;
      for (const item of list) {
        const existing = store.songs.find(s => s.file === item.file);
        if (existing) {
          existing.text = item.text;
          existing._w = item.text;
        } else {
          store.songs.push({ id: uid(), file: item.file, text: item.text, _w: item.text });
          added++;
        }
      }
      // Remove default sample if real songs loaded from server
      if (list.length > 0) {
        store.songs = store.songs.filter(s => s.id !== 'sample-1');
      }
      if (!store.songs.some(s => String(s.id) === String(store.curId))) {
        store.curId = store.songs[0]?.id || 'sample-1';
      }
      saveAll(true);
      emitLibrary();
      emitStatus(`🖥 Laptop-Ordner verbunden (${list.length} Songs${added ? `, ${added} neu` : ''})`);
      return true;
    } catch {
      return false;
    }
  }

  function exportBackup() {
    const payload = {
      v: 3,
      exportedAt: new Date().toISOString(),
      songs: store.songs.map(({ id, file, text }) => ({ id, file, text })),
      set: store.setlist,
      sets: store.namedSets,
      prof: lsGet('cp_prof', {}),
      layout: store.layout,
      stage: store.stage,
      ovr: chordOverrides,
      lib: getCustomChords()
    };
    downloadText('chordpro-backup.json', JSON.stringify(payload, null, 2), 'application/json');
    showToast('Backup heruntergeladen');
  }

  function importJsonData(data) {
    if (Array.isArray(data)) {
      data.forEach(item => {
        store.songs.push({ id: uid(), file: item.file, text: item.text || String(item) });
      });
      saveAll(true);
      return `${data.length} Songs importiert`;
    }
    if (data && Array.isArray(data.songs)) {
      const existingIds = new Set(store.songs.map(x => String(x.id)));
      let added = 0;
      for (const s of data.songs) {
        const id = String(s.id ?? uid());
        if (!existingIds.has(id)) {
          store.songs.push({ id, file: s.file, text: s.text || '' });
          existingIds.add(id);
          added++;
        }
      }
      if (data.set) store.setlist = normalizeSetlist(data.set);
      if (data.sets) Object.assign(store.namedSets, normalizeNamedSets(data.sets));
      if (data.prof) {
        const merged = { ...lsGet('cp_prof', {}), ...data.prof };
        lsSet('cp_prof', merged);
        Object.assign(store.profiles, merged);
      }
      if (data.ovr || data.lib) mergeChordLibrary(data);
      saveAll(true);
      return `Backup eingelesen: ${added} neue Songs, ${Object.keys(data.sets || {}).length} Setlists`;
    }
    if (data && data.format === 'chordpro-studio-chords') {
      mergeChordLibrary(data);
      return 'Akkordbibliothek importiert';
    }
    throw new Error('Unbekanntes JSON-Format');
  }

  async function init() {
    // Request persistent browser storage so iOS/Chrome doesn't evict IndexedDB
    try { navigator.storage?.persist?.(); } catch { /* ignore */ }

    // 1. Load songs from IndexedDB (migrate from localStorage if first run on v2)
    const idbSongs = await idbGet('data', 'songs');
    if (Array.isArray(idbSongs) && idbSongs.length > 0) {
      store.songs = idbSongs.map(s => ({ ...s, id: String(s.id) }));
    } else {
      const legacy = lsGet('cp_songs', null);
      if (Array.isArray(legacy) && legacy.length > 0) {
        store.songs = legacy.map(s => ({ ...s, id: String(s.id) }));
        await idbPut('data', 'songs', store.songs);
      }
    }
    store.curId = store.songs[0].id;

    // 2. Restore saved file handles
    const handles = await idbGet('h', 'files');
    if (handles && typeof handles === 'object') {
      Object.assign(store.fileHandles, handles);
    }

    // 3. Reconnect directory if permission already granted
    if (FS_DIR_OK) {
      try {
        const dir = await idbGet('h', 'dir');
        if (dir && (await dir.queryPermission({ mode: 'readwrite' })) === 'granted') {
          store.dirHandle = dir;
          await loadFromDirectory();
        } else if (dir) {
          emitStatus(`Ordner „${dir.name}“ gemerkt – in der Bibliothek „Wiederverbinden“ klicken.`);
        }
      } catch {
        // ignore
      }
    }

    // 4. Auto-detect local laptop server songs folder (only over http/https)
    if (location.protocol === 'http:' || location.protocol === 'https:') {
      try {
        const infoRes = await fetch('/api/info');
        if (infoRes.ok) {
          const info = await infoRes.json();
          if (info.songsDir) {
            await syncFromServerSongs();
          }
        }
      } catch {
        // Not running on local server — totally fine
      }
    }
  }

  return {
    store,
    init,
    findSong,
    currentSong,
    fileNameFor,
    saveAll,
    saveHandles,
    saveCurrentFile,
    connectDirectory,
    loadFromDirectory,
    linkIndividualFiles,
    syncFromServerSongs,
    shareOrDownload,
    exportBackup,
    importJsonData
  };
}
