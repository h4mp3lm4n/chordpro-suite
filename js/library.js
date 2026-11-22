// Library & Setlist Builder modules (with direct stage launch, per-setlist transposition & total duration)

import { $, $$, esc, uid, lsGet, lsSet, formatDuration, isMobileDevice, showToast } from './utils.js';
import { songInfo } from './parser.js';
import { exportPdf } from './renderer.js';
import { FS_DIR_OK, FS_FILE_OK } from './storage.js';

export function createLibrary({ storage, askConfirm, onOpenSong, onStartStage, onUpdateBadges }) {
  const {
    store, findSong, currentSong, fileNameFor, saveAll, saveHandles,
    connectDirectory, loadFromDirectory, linkIndividualFiles,
    shareOrDownload, exportBackup, importJsonData
  } = storage;

  let sortState = lsGet('cp_sort', ['title', 1]);
  let slSortable = null;

  function selectedIds() {
    return $$('.sel:checked').map(c => String(c.value));
  }

  function updateSelectionBar() {
    const count = selectedIds().length;
    const bar = $('#lib-selbar');
    if (bar) bar.hidden = count === 0;
    const lbl = $('#lib-sel-count');
    if (lbl) lbl.textContent = count === 1 ? '1 Song ausgewählt' : `${count} Songs ausgewählt`;
    const ca = $('#ca');
    const total = $$('.sel').length;
    if (ca) {
      ca.checked = total > 0 && count === total;
      ca.indeterminate = count > 0 && count < total;
    }
  }

  function sortComparator(a, b) {
    const key = sortState[0];
    const dir = sortState[1];
    if (key === 'tempo') {
      return ((a.info.tempo || 0) - (b.info.tempo || 0)) * dir;
    }
    const field = key === 'title' ? 'sortTitle' : key;
    return String(a.info[field] || '').localeCompare(String(b.info[field] || ''), 'de', { sensitivity: 'base' }) * dir;
  }

  function updateSortHeaders() {
    const labels = { title: 'Titel', artist: 'Artist', key: 'Key', tempo: 'BPM', loop: '🔁', tags: 'Tags' };
    $$('th[data-k]').forEach(th => {
      const k = th.dataset.k;
      th.textContent = labels[k] + (sortState[0] === k ? (sortState[1] > 0 ? ' ▲' : ' ▼') : '');
    });
    $$('#lchips button').forEach(b => {
      const k = b.dataset.k;
      const on = sortState[0] === k;
      b.classList.toggle('on', on);
      b.textContent = labels[k] + (on ? (sortState[1] > 0 ? ' ▲' : ' ▼') : '');
    });
  }

  function renderLibrary() {
    const q = ($('#q')?.value || '').trim().toLowerCase();
    const rows = store.songs
      .map(s => ({ song: s, info: songInfo(s) }))
      .filter(x => !q || `${x.info.title} ${x.info.artist} ${x.info.key} ${x.info.tags}`.toLowerCase().includes(q))
      .sort(sortComparator);

    $('#lib-count').textContent = `${rows.length} / ${store.songs.length} Songs`;

    $('#tb').innerHTML = rows.map(({ song, info }) => {
      const srcLabel = song.file
        ? (store.serverSongsEnabled ? `🖥 ${song.file}` : `📄 ${song.file}`)
        : '💾 Browser';
      return `
        <tr data-id="${esc(song.id)}">
          <td><input type="checkbox" class="sel" value="${esc(song.id)}"></td>
          <td class="ct">${esc(info.title)}</td>
          <td>${esc(info.artist)}</td>
          <td><span class="key-pill">${esc(info.key || '–')}</span></td>
          <td class="muted">${info.tempo ? info.tempo : '–'}</td>
          <td>${info.loop ? '🔁' : ''}</td>
          <td class="muted">${esc(info.tags)}</td>
          <td class="cf">${esc(srcLabel)}</td>
          <td class="c-act">
            <button class="btn-ic pri" data-play="${esc(song.id)}" title="Direkt in Live Stage öffnen">▶</button>
            <button class="btn-ic" data-sh="${esc(song.id)}" title="Als .cho teilen / herunterladen">📤</button>
            <button class="btn-ic danger" data-rm="${esc(song.id)}" title="Song löschen">🗑</button>
          </td>
        </tr>`;
    }).join('');

    updateSortHeaders();
    updateSelectionBar();
  }

  async function deleteSongs(ids) {
    if (!ids.length) {
      showToast('Keine Songs ausgewählt');
      return;
    }
    const targets = store.songs.filter(s => ids.includes(String(s.id)));
    const withDirFile = targets.filter(s => s.file && store.dirHandle);
    const label = targets.length === 1 ? `„${songInfo(targets[0]).title}“` : `${targets.length} Songs`;
    const opts = withDirFile.length
      ? ['Nur aus Bibliothek entfernen', 'Auch Datei(en) im Ordner löschen', 'Abbrechen']
      : ['Löschen', 'Abbrechen'];

    const choice = await askConfirm(`${label} löschen?`, opts);
    if (choice === opts.length - 1) return;

    if (withDirFile.length && choice === 1) {
      for (const sg of withDirFile) {
        try { await store.dirHandle.removeEntry(sg.file); } catch { /* ignore */ }
      }
    }

    store.songs = store.songs.filter(s => !ids.includes(String(s.id)));
    ids.forEach(id => delete store.fileHandles[id]);
    await saveHandles();
    store.setlist = store.setlist.filter(entry => !ids.includes(String(entry.id)));

    if (!store.songs.length) {
      store.songs.push({ id: uid(), text: '{title: Neuer Song}\n{artist: }\n{key: C}\n\n' });
    }
    if (!store.songs.some(s => String(s.id) === String(store.curId))) {
      store.curId = store.songs[0].id;
    }

    saveAll(true);
    renderLibrary();
    renderSetlist();
    if (onUpdateBadges) onUpdateBadges();
    showToast(`${label} gelöscht`);
  }

  // --- Setlist Builder ---
  function populateNamedSets() {
    $('#ss').innerHTML =
      '<option value="">– gespeicherte Setlists –</option>' +
      Object.keys(store.namedSets).map(k => `<option>${esc(k)}</option>`).join('');
  }

  function renderPool() {
    const q = ($('#pq')?.value || '').trim().toLowerCase();
    const sortBy = $('#psk')?.value || 'title';
    const items = store.songs
      .map(s => ({ song: s, info: songInfo(s) }))
      .filter(x => !q || `${x.info.title} ${x.info.artist} ${x.info.tags}`.toLowerCase().includes(q))
      .sort((a, b) => String(a.info[sortBy] || '').localeCompare(String(b.info[sortBy] || ''), 'de', { sensitivity: 'base' }));

    $('#pool').innerHTML = items.map(({ song, info }) => `
      <li data-id="${esc(song.id)}">
        <div class="sl-meta">
          <b>${esc(info.title)}</b>
          <small class="muted">
            ${esc(info.artist || '–')}
            ${info.key ? ` · Key ${esc(info.key)}` : ''}
            ${info.tempo ? ` · ${info.tempo} BPM` : ''}
            ${info.duration ? ` · ${esc(info.duration)}` : ''}
          </small>
        </div>
        <button class="add" data-add="${esc(song.id)}" title="Zur Setlist hinzufügen">＋</button>
      </li>`).join('');
  }

  function renderSetlist() {
    // Keep only entries referencing existing songs
    store.setlist = store.setlist.filter(entry => store.songs.some(s => String(s.id) === String(entry.id)));

    let totalSec = 0;
    $('#sl').innerHTML = store.setlist.map((entry, idx) => {
      const sg = findSong(entry.id);
      const info = songInfo(sg);
      totalSec += info.durationSec;
      const shLabel = entry.shift > 0 ? `+${entry.shift}` : String(entry.shift || 0);
      return `
        <li data-idx="${idx}" data-id="${esc(entry.id)}">
          <span class="hd" title="Ziehen zum Sortieren">⠿</span>
          <div class="sl-meta">
            <b>${idx + 1}. ${esc(info.title)}</b>
            <small class="muted">
              ${esc(info.artist || '–')}
              ${info.key ? ` · Key ${esc(info.key)}` : ''}
              ${info.tempo ? ` · ${info.tempo} BPM` : ''}
              ${info.duration ? ` · ${esc(info.duration)}` : ''}
            </small>
          </div>
          <div class="sl-tr" title="Transposition für diesen Setlist-Eintrag">
            <button class="btn-xs" data-tr="-1">♭</button>
            <span class="sl-sh${entry.shift ? ' active' : ''}">${shLabel}</span>
            <button class="btn-xs" data-tr="1">♯</button>
          </div>
          <div class="sl-mv">
            <button class="btn-xs" data-up="${idx}" title="Nach oben">▲</button>
            <button class="btn-xs" data-dn="${idx}" title="Nach unten">▼</button>
            <button class="btn-xs danger" data-del="${idx}" title="Entfernen">✕</button>
          </div>
        </li>`;
    }).join('') || '<li class="sl-empty muted">Noch leer – links auf ＋ klicken, um Songs hinzuzufügen.</li>';

    const durStr = formatDuration(totalSec);
    $('#sl-summary').textContent = `${store.setlist.length} Songs${durStr ? ` · ca. ${durStr} Min` : ''}`;
  }

  function renderSetUI() {
    populateNamedSets();
    renderPool();
    renderSetlist();
  }

  function initControls() {
    // Library table delegated clicks
    $('#tb').addEventListener('click', async e => {
      const playBtn = e.target.closest('[data-play]');
      if (playBtn) {
        e.stopPropagation();
        store.curId = playBtn.dataset.play;
        onStartStage('one');
        return;
      }
      const shBtn = e.target.closest('[data-sh]');
      if (shBtn) {
        e.stopPropagation();
        const sg = findSong(shBtn.dataset.sh);
        if (sg) try { await shareOrDownload([[fileNameFor(sg), sg.text]]); } catch { /* ignore */ }
        return;
      }
      const rmBtn = e.target.closest('[data-rm]');
      if (rmBtn) {
        e.stopPropagation();
        deleteSongs([rmBtn.dataset.rm]);
        return;
      }
      if (e.target.type === 'checkbox') return;
      const row = e.target.closest('tr[data-id]');
      if (row) onOpenSong(row.dataset.id);
    });

    // Sorting headers & mobile chips
    $('#lib-table').tHead.onclick = e => {
      const th = e.target.closest('th[data-k]');
      if (!th) return;
      const k = th.dataset.k;
      sortState = [k, sortState[0] === k ? -sortState[1] : 1];
      lsSet('cp_sort', sortState);
      renderLibrary();
    };
    $('#lchips').onclick = e => {
      const b = e.target.closest('button[data-k]');
      if (!b) return;
      const k = b.dataset.k;
      sortState = [k, sortState[0] === k ? -sortState[1] : 1];
      lsSet('cp_sort', sortState);
      renderLibrary();
    };

    $('#q').oninput = renderLibrary;
    $('#ca').onchange = e => {
      $$('.sel').forEach(c => { c.checked = e.target.checked; });
      updateSelectionBar();
    };
    $('#tb').addEventListener('change', e => {
      if (e.target.classList.contains('sel')) updateSelectionBar();
    });
    if ($('#lib-sel-clear')) {
      $('#lib-sel-clear').onclick = () => {
        $$('.sel').forEach(c => { c.checked = false; });
        updateSelectionBar();
      };
    }

    // New song
    $('#nw').onclick = () => {
      const id = uid();
      store.songs.push({
        id,
        text: '{title: Neuer Song}\n{artist: }\n{key: C}\n{tempo: 100}\n{duration: 3:30}\n\n{start_of_verse: Strophe 1}\n\n{end_of_verse}\n\n{start_of_chorus: Refrain}\n\n{end_of_chorus}\n'
      });
      saveAll(true);
      onOpenSong(id);
    };

    // Bulk actions
    $('#bd').onclick = () => deleteSongs(selectedIds());
    $('#bs').onclick = () => {
      const ids = selectedIds();
      if (!ids.length) { showToast('Bitte erst Songs anhaken'); return; }
      ids.forEach(id => store.setlist.push({ id, shift: 0 }));
      saveAll(true);
      window.dispatchEvent(new CustomEvent('cp:mode', { detail: 'set' }));
      showToast(`${ids.length} Song(s) zur Setlist hinzugefügt`);
    };
    $('#bp').onclick = () => {
      const list = selectedIds().map(id => findSong(id)).filter(Boolean);
      exportPdf(list, store.layout, {}, false);
    };
    $('#bj').onclick = exportBackup;
    $('#bsh').onclick = async () => {
      const list = store.songs.filter(s => selectedIds().includes(String(s.id)));
      if (!list.length) { showToast('Nichts ausgewählt'); return; }
      try { await shareOrDownload(list.map(s => [fileNameFor(s), s.text])); } catch { /* ignore */ }
    };

    // File import (.cho, .txt, .json)
    if (isMobileDevice()) $('#fi').removeAttribute('accept');
    $('#b-imp').onclick = () => $('#fi').click();
    $('#fi').onchange = async e => {
      const msgs = [];
      for (const f of e.target.files) {
        try {
          const text = await f.text();
          if (/\.json$/i.test(f.name)) {
            msgs.push(importJsonData(JSON.parse(text)));
          } else {
            store.songs.push({ id: uid(), file: f.name, text });
            msgs.push(`${f.name} importiert`);
          }
        } catch (err) {
          msgs.push(`${f.name}: ${err.message}`);
        }
      }
      e.target.value = '';
      saveAll(true);
      renderLibrary();
      renderSetUI();
      if (msgs.length) showToast(msgs.join(' · '), 3200);
    };

    // Directory / File handles / Folder import
    $('#fc').disabled = $('#fn').disabled = $('#fr2').disabled = !FS_DIR_OK;
    $('#fc').onclick = () => connectDirectory(false);
    $('#fn').onclick = () => connectDirectory(true);
    $('#fr2').onclick = () => (store.dirHandle ? loadFromDirectory() : showToast('Kein Ordner verbunden'));
    $('#fl').hidden = !FS_FILE_OK;
    $('#fl').onclick = linkIndividualFiles;
    $('#fd').onclick = () => $('#fdi').click();
    $('#fdi').onchange = async e => {
      let n = 0;
      for (const f of e.target.files) {
        if (!/\.(cho|chordpro|crd|pro|txt)$/i.test(f.name)) continue;
        const text = await f.text();
        const ex = store.songs.find(s => s.file === f.name);
        if (ex) ex.text = text;
        else { store.songs.push({ id: uid(), file: f.name, text, _w: text }); n++; }
      }
      e.target.value = '';
      saveAll(true);
      renderLibrary();
      showToast(`Ordner eingelesen (${n} neue Songs)`);
    };

    const canShare = !!navigator.canShare;
    $('#f1').textContent = canShare ? '📤 Song teilen' : '💾 Song als .cho';
    $('#fa').textContent = canShare ? '📤 Alle teilen' : '⬇ Alle als .cho';
    $('#f1').onclick = async () => {
      const sg = currentSong();
      try { await shareOrDownload([[fileNameFor(sg), sg.text]]); } catch { /* ignore */ }
    };
    $('#fa').onclick = async () => {
      try { await shareOrDownload(store.songs.map(s => [fileNameFor(s), s.text])); } catch { /* ignore */ }
    };

    $('#ftg').onclick = () => {
      const box = $('#fbox');
      const willOpen = box.hidden;
      box.hidden = !willOpen;
      $('#ftg').classList.toggle('on', willOpen);
    };
    $('#fbox').hidden = true;

    // Pool & Setlist delegated events
    $('#pq').oninput = renderPool;
    $('#psk').onchange = renderPool;
    $('#pool').addEventListener('click', e => {
      const btn = e.target.closest('[data-add]');
      if (!btn) return;
      store.setlist.push({ id: btn.dataset.add, shift: 0 });
      saveAll(true);
      renderSetlist();
    });

    $('#sl').addEventListener('click', e => {
      const li = e.target.closest('li[data-idx]');
      if (!li) return;
      const idx = +li.dataset.idx;
      const trBtn = e.target.closest('[data-tr]');
      if (trBtn) {
        store.setlist[idx].shift = (store.setlist[idx].shift || 0) + (+trBtn.dataset.tr);
        saveAll(true);
        renderSetlist();
        return;
      }
      if (e.target.closest('[data-up]')) {
        if (idx > 0) {
          [store.setlist[idx - 1], store.setlist[idx]] = [store.setlist[idx], store.setlist[idx - 1]];
          saveAll(true);
          renderSetlist();
        }
        return;
      }
      if (e.target.closest('[data-dn]')) {
        if (idx < store.setlist.length - 1) {
          [store.setlist[idx + 1], store.setlist[idx]] = [store.setlist[idx], store.setlist[idx + 1]];
          saveAll(true);
          renderSetlist();
        }
        return;
      }
      if (e.target.closest('[data-del]')) {
        store.setlist.splice(idx, 1);
        saveAll(true);
        renderSetlist();
      }
    });

    // Named setlists
    $('#ss').onchange = e => {
      const k = e.target.value;
      if (!k || !store.namedSets[k]) return;
      store.setlist = store.namedSets[k].map(x => ({ ...x }));
      $('#sn').value = k;
      saveAll(true);
      renderSetlist();
    };
    $('#sv1').onclick = () => {
      const name = $('#sn').value.trim();
      if (!name) { showToast('Bitte Setlist-Namen eingeben'); return; }
      store.namedSets[name] = store.setlist.map(x => ({ ...x }));
      saveAll(true);
      populateNamedSets();
      $('#ss').value = name;
      showToast(`Setlist „${name}“ gespeichert`);
    };
    $('#sx').onclick = () => {
      const k = $('#ss').value;
      if (!k) return;
      delete store.namedSets[k];
      saveAll(true);
      populateNamedSets();
      showToast(`Setlist „${k}“ gelöscht`);
    };
    $('#sgo').onclick = () => {
      if (store.setlist.length) store.curId = store.setlist[0].id;
      onStartStage('set');
    };
    $('#ssk').onchange = e => {
      const k = e.target.value;
      if (!k) return;
      const getVal = entry => songInfo(findSong(entry.id))[k] || '';
      store.setlist.sort((a, b) => String(getVal(a)).localeCompare(String(getVal(b)), 'de', { sensitivity: 'base' }));
      saveAll(true);
      renderSetlist();
      e.target.value = '';
    };

    // Sortable drag & drop (gracefully skipped if CDN offline)
    if (window.Sortable) {
      slSortable = new window.Sortable($('#sl'), {
        handle: '.hd',
        animation: 150,
        onEnd: e => {
          if (e.oldIndex === e.newIndex || e.oldIndex == null || e.newIndex == null) return;
          const [moved] = store.setlist.splice(e.oldIndex, 1);
          store.setlist.splice(e.newIndex, 0, moved);
          saveAll(true);
          renderSetlist();
        }
      });
    }
  }

  initControls();

  return {
    renderLibrary,
    renderSetUI,
    renderSetlist
  };
}
