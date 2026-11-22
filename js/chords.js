// Chord voicing generator, SVG diagram renderer, voicing picker & custom chord editor

import { $, $$, esc, downloadText, lsGet, lsSet } from './utils.js';
import { CHORD_RE, NOTES_SHARP, noteIndex } from './parser.js';

const OPEN_SHAPES = {
  C: 'x32010', D: 'xx0232', E: '022100', G: '320003', A: 'x02220',
  Am: 'x02210', Dm: 'xx0231', Em: '022000', E7: '020100', A7: 'x02020',
  D7: 'xx0212', G7: '320001', C7: 'x32310', B7: 'x21202', Cmaj7: 'x32000',
  Am7: 'x02010', Em7: '020000', Dsus4: 'xx0233', Asus4: 'x02230',
  Dsus2: 'xx0230', Asus2: 'x02200', Fmaj7: 'xx3210'
};

const BARRE_E = {
  '': [0, 2, 2, 1, 0, 0], m: [0, 2, 2, 0, 0, 0], '7': [0, 2, 0, 1, 0, 0],
  m7: [0, 2, 0, 0, 0, 0], maj7: [0, 2, 1, 1, 0, 0], sus4: [0, 2, 2, 2, 0, 0]
};
const BARRE_A = {
  '': [-1, 0, 2, 2, 2, 0], m: [-1, 0, 2, 2, 1, 0], '7': [-1, 0, 2, 0, 2, 0],
  m7: [-1, 0, 2, 0, 1, 0], maj7: [-1, 0, 2, 1, 2, 0], sus4: [-1, 0, 2, 2, 3, 0],
  sus2: [-1, 0, 2, 2, 0, 0]
};

export const QUALITY_INTERVALS = {
  '': [0, 4, 7], m: [0, 3, 7], '5': [0, 7], '7': [0, 4, 7, 10],
  m7: [0, 3, 7, 10], maj7: [0, 4, 7, 11], sus4: [0, 5, 7], sus2: [0, 2, 7],
  '7sus4': [0, 5, 7, 10], dim: [0, 3, 6], dim7: [0, 3, 6, 9],
  m7b5: [0, 3, 6, 10], aug: [0, 4, 8], '6': [0, 4, 7, 9], m6: [0, 3, 7, 9],
  '9': [0, 4, 7, 10, 14], maj9: [0, 4, 7, 11, 14], m9: [0, 3, 7, 10, 14],
  add9: [0, 4, 7, 14]
};

const QUALITY_ALIAS = { M7: 'maj7', min: 'm', mi: 'm', M: '', maj: '', min7: 'm7', '-': 'm' };

export function normalizeQuality(q) {
  const mapped = QUALITY_ALIAS[q] !== undefined ? QUALITY_ALIAS[q] : q;
  if (QUALITY_INTERVALS[mapped]) return mapped;
  return /^m(?!aj)/.test(mapped) ? 'm' : '';
}

export const STD_TUNINGS = {
  Gitarre: [4, 9, 2, 7, 11, 4],
  Ukulele: [7, 0, 4, 9]
};

export const EDITOR_TUNINGS = {
  'Gitarre – Standard (E A D G B E)': ['Gitarre', [4, 9, 2, 7, 11, 4], 1],
  'Gitarre – Drop D': ['Gitarre', [2, 9, 2, 7, 11, 4], 0],
  'Gitarre – DADGAD': ['Gitarre', [2, 9, 2, 7, 9, 2], 0],
  'Gitarre – Open G': ['Gitarre', [2, 7, 2, 7, 11, 2], 0],
  'Gitarre – Open D': ['Gitarre', [2, 9, 2, 6, 9, 2], 0],
  'Ukulele – GCEA': ['Ukulele', [7, 0, 4, 9], 1],
  'Bariton-Ukulele – DGBE': ['Eigene', [2, 7, 11, 4], 0],
  'Bass – E A D G': ['Eigene', [4, 9, 2, 7], 0],
  'Klavier (2 Oktaven)': ['Klavier', [], 1],
  'Eigene Stimmung…': ['Eigene', null, 0]
};

export const DEFAULT_THEME = { c: '#333333', d: '#222222', p: '#ea580c', k: '#ffffff', kb: '#222222' };

export const chordOverrides = lsGet('cp_ovr', {});
export let customChords = lsGet('cp_cx', []);
export function getCustomChords() { return customChords; }

const voicingCache = new Map();

function saveOverrides() {
  lsSet('cp_ovr', chordOverrides);
}

function saveCustomChords() {
  lsSet('cp_cx', customChords);
}

export function mergeChordLibrary(data) {
  if (!data) return 0;
  let count = 0;
  if (Array.isArray(data.lib)) {
    for (const item of data.lib) {
      customChords = customChords.filter(
        y => !(y.ins === item.ins && y.name === item.name && (y.tun || []).join() === (item.tun || []).join())
      );
      customChords.push(item);
      count++;
    }
    saveCustomChords();
  }
  if (data.overrides && typeof data.overrides === 'object') {
    Object.assign(chordOverrides, data.overrides);
    saveOverrides();
  }
  if (data.ovr && typeof data.ovr === 'object') {
    Object.assign(chordOverrides, data.ovr);
    saveOverrides();
  }
  return count;
}

function defaultGuitarShape(root, qual) {
  if (OPEN_SHAPES[root + qual]) {
    return [...OPEN_SHAPES[root + qual]].map(ch => (ch === 'x' ? -1 : +ch));
  }
  const isMinor = /^m(?!aj)/.test(qual);
  const k = BARRE_E[qual] || BARRE_A[qual] ? qual : isMinor ? 'm' : '';
  const rIdx = noteIndex(root);
  const fE = (rIdx - 4 + 12) % 12;
  const fA = (rIdx - 9 + 12) % 12;
  const useA = BARRE_A[k] && (!BARRE_E[k] || fA < fE);
  const base = useA ? fA : fE;
  return (useA ? BARRE_A[k] : BARRE_E[k]).map(v => (v < 0 ? v : v + base));
}

function generateFrettedVoicings(root, qual, ins, bassPc) {
  const tu = STD_TUNINGS[ins] || STD_TUNINGS.Gitarre;
  const n = tu.length;
  const R = noteIndex(root);
  if (R < 0) return [];
  const B = bassPc === undefined ? R : bassPc;
  const chordSet = new Set(QUALITY_INTERVALS[qual].map(i => (R + i) % 12));
  chordSet.add(B);
  const required = new Set(chordSet);
  if (chordSet.size > 3 && (R + 7) % 12 !== B) required.delete((R + 7) % 12);

  const res = [];
  const seen = new Set();

  for (let b = 0; b <= 11; b++) {
    const opts = tu.map(t => {
      const o = [-1];
      for (let f = b; f <= b + 3; f++) {
        if (chordSet.has((t + f) % 12)) o.push(f);
      }
      if (b && chordSet.has(t % 12)) o.push(0);
      return o;
    });

    const test = cur => {
      const sounded = cur.filter(v => v >= 0);
      if (sounded.length < (n > 4 ? 4 : 3)) return;
      const pcs = new Set(cur.map((v, i) => (v < 0 ? -1 : (tu[i] + v) % 12)));
      for (const req of required) if (!pcs.has(req)) return;
      if (n > 4) {
        const firstIdx = cur.findIndex(v => v >= 0);
        if ((tu[firstIdx] + cur[firstIdx]) % 12 !== B) return;
      }
      const key = cur.join(',');
      if (seen.has(key)) return;
      seen.add(key);
      const fretted = sounded.filter(v => v > 0);
      const minF = fretted.length ? Math.min(...fretted) : 0;
      const span = fretted.length ? Math.max(...fretted) - minF : 0;
      const muted = cur.filter(v => v < 0).length;
      const open = cur.filter(v => v === 0).length;
      res.push({ a: [...cur], sc: minF * 3 + muted * 2 + span * 2 - open });
    };

    const rec = (i, cur, hasSounded) => {
      if (i === n) { test(cur); return; }
      for (const v of opts[i]) {
        if (v < 0 && hasSounded) continue;
        cur.push(v);
        rec(i + 1, cur, hasSounded || v >= 0);
        cur.pop();
      }
    };
    rec(0, [], false);
  }

  return res.sort((a, b) => a.sc - b.sc).slice(0, 30).map(x => x.a);
}

function generatePianoVoicings(root, qual, bassPc) {
  const R = noteIndex(root);
  if (R < 0) return [[0, 4, 7]];
  const base = QUALITY_INTERVALS[qual].map(i => R + i);
  const out = [];
  const seen = new Set();

  const add = w => {
    w = [...w].sort((a, b) => a - b);
    if (bassPc === undefined) while (w[0] >= 12) w = w.map(x => x - 12);
    if (Math.max(...w) > 23) return;
    const k = w.join(',');
    if (!seen.has(k)) {
      seen.add(k);
      out.push(w);
    }
  };

  if (bassPc !== undefined) {
    const up = o => base.map(x => {
      let p = x % 12;
      while (p <= bassPc + o) p += 12;
      return p;
    });
    add([bassPc, ...up(0)]);
    add([bassPc, ...up(12)]);
  } else {
    let v = base;
    for (let k = 0; k < base.length; k++) {
      add(v);
      v = [...v.slice(1), v[0] + 12];
    }
    add([base[0], ...base.slice(1).map(x => x + 12)]);
    add([base[0], base[0] + 12, ...base.slice(1)]);
  }

  if (!out.length) {
    out.push((bassPc !== undefined ? [bassPc] : []).concat(base.map(x => x % 12)).sort((a, b) => a - b));
  }
  return out;
}

export function getAlternatives(root, qual, ins, bassPc) {
  const key = `${ins}|${root}${qual}${bassPc === undefined ? '' : '/' + bassPc}`;
  if (voicingCache.has(key)) return voicingCache.get(key);
  let list;
  if (ins === 'Klavier') {
    list = generatePianoVoicings(root, qual, bassPc);
  } else {
    list = generateFrettedVoicings(root, qual, ins, bassPc);
    if (bassPc === undefined && ins !== 'Ukulele' && (OPEN_SHAPES[root + qual] || BARRE_E[qual] || BARRE_A[qual])) {
      const def = defaultGuitarShape(root, qual);
      list = [def, ...list.filter(x => x.join() !== def.join())];
    }
  }
  voicingCache.set(key, list);
  return list;
}

export function getVoicing(root, qual, ins, chordName, bass) {
  return (
    chordOverrides[`${ins}|${chordName}`] ||
    getAlternatives(root, qual, ins, bass === undefined ? undefined : noteIndex(bass))[0] ||
    (ins === 'Klavier' ? [0, 4, 7] : [-1, -1, -1, -1, -1, -1])
  );
}

export function parseDefineFrets(defStr, ins) {
  const fm = /frets\s+((?:[xX\d]+\s*)+)/.exec(defStr);
  const bm = /base-fret\s+(\d+)/.exec(defStr);
  if (!fm) return null;
  const base = bm ? +bm[1] : 1;
  const frets = fm[1].trim().split(/\s+/).map(v => (/x/i.test(v) ? -1 : +v > 0 ? +v + base - 1 : 0));
  return frets.length === (STD_TUNINGS[ins] || []).length ? frets : null;
}

export function guitarSvg(frets, theme = DEFAULT_THEME, scalePct = 100) {
  const t = { ...DEFAULT_THEME, ...theme };
  const sz = t.sz ?? scalePct ?? 100;
  const n = frets.length;
  const sp = n > 5 ? 9 : 13;
  const w = (n - 1) * sp + 20;
  const pos = frets.filter(v => v > 0);
  const minF = pos.length ? Math.min(...pos) : 1;
  const base = Math.max(...pos, 0) <= 4 ? 1 : minF;

  let s = `<svg viewBox="0 0 ${w} 74" width="${(w * 0.95 * sz / 100).toFixed(1)}">`;
  for (let i = 0; i < n; i++) {
    s += `<path d="M${10 + i * sp} 16V68" stroke="${t.c}" stroke-width=".8"/>`;
  }
  for (let f = 0; f <= 4; f++) {
    s += `<path d="M10 ${16 + f * 13}H${10 + (n - 1) * sp}" stroke="${t.c}" stroke-width="${f === 0 && base === 1 ? 3 : 0.8}"/>`;
  }
  frets.forEach((v, i) => {
    const x = 10 + i * sp;
    if (v < 0) s += `<text x="${x}" y="11" font-size="9" text-anchor="middle" fill="${t.c}">×</text>`;
    else if (v === 0) s += `<circle cx="${x}" cy="8" r="3" fill="none" stroke="${t.c}"/>`;
    else s += `<circle cx="${x}" cy="${9.5 + (v - base + 1) * 13}" r="4.2" fill="${t.d}"/>`;
  });
  if (base > 1) s += `<text x="0" y="29" font-size="8" fill="${t.c}">${base}</text>`;
  return s + '</svg>';
}

export function pianoSvg(notes, theme = DEFAULT_THEME, scalePct = 100) {
  const t = { ...DEFAULT_THEME, ...theme };
  const sz = t.sz ?? scalePct ?? 100;
  const W = [0, 2, 4, 5, 7, 9, 11];
  const B = { 1: 0, 3: 1, 6: 3, 8: 4, 10: 5 };
  let s = `<svg viewBox="0 0 168 46" width="${(150 * sz / 100).toFixed(1)}">`;
  for (let o = 0; o < 2; o++) {
    W.forEach((n, i) => {
      s += `<rect x="${o * 84 + i * 12}" y="0" width="12" height="46" fill="${notes.includes(o * 12 + n) ? t.p : t.k}" stroke="${t.c}"/>`;
    });
  }
  for (let o = 0; o < 2; o++) {
    for (const [nStr, pos] of Object.entries(B)) {
      const pitch = o * 12 + (+nStr);
      s += `<rect x="${(o * 7 + pos + 1) * 12 - 3.5}" y="0" width="7" height="28" fill="${notes.includes(pitch) ? t.p : t.kb}" stroke="${t.c}" stroke-width=".5"/>`;
    }
  }
  return s + '</svg>';
}

export function renderDiagrams(parsed, toStd, instruments, theme = DEFAULT_THEME, defaults = { dsz: 100, dgp: 14 }, formatLabel = null) {
  const t = { ...DEFAULT_THEME, ...theme };
  const gap = t.gp ?? defaults.dgp ?? 14;
  const sz = t.sz ?? defaults.dsz ?? 100;
  const unique = [...new Set(parsed.chords.map(c => toStd(c)).filter(Boolean))];
  if (!unique.length || !instruments.length) return '';

  return instruments.map(ins => {
    const cards = unique.map(c => {
      const m = CHORD_RE.exec(c);
      if (!m) return '';
      const q = normalizeQuality(m[2] || '');
      const voicing =
        (ins !== 'Klavier' && parsed.defs && (parsed.defs[c] || []).map(d => parseDefineFrets(d, ins)).find(Boolean)) ||
        getVoicing(m[1], q, ins, c, m[3]);
      const displayLabel = formatLabel ? formatLabel(c).split('\u0001')[0] : c;
      const svg = ins === 'Klavier' ? pianoSvg(voicing, { ...t, sz }) : guitarSvg(voicing, { ...t, sz });
      return `<div class="dia-card" data-ch="${esc(c)}" data-ins="${esc(ins)}" title="Klicken für alternative Griffe" style="color:${t.c}">${svg}<div>${esc(displayLabel)}</div></div>`;
    }).join('');
    const header = instruments.length > 1 ? `<div class="dia-ins" style="color:${t.c}">${esc(ins)}</div>` : '';
    return `<div class="dia-row" style="gap:${gap}px">${header}${cards}</div>`;
  }).join('');
}

export function detectChordName(pcs, bassPc) {
  const unique = [...new Set(pcs)];
  if (unique.length < 2) return '';
  const matches = [];
  for (const root of unique) {
    for (const [q, intervals] of Object.entries(QUALITY_INTERVALS)) {
      const set = new Set(intervals.map(i => (root + i) % 12));
      if (set.size === unique.length && unique.every(p => set.has(p))) {
        matches.push([root, q]);
      }
    }
  }
  if (!matches.length) return '';
  const best = matches.find(y => y[0] === bassPc) || matches[0];
  const name = NOTES_SHARP[best[0]] + best[1];
  return best[0] !== bassPc && bassPc !== undefined ? `${name}/${NOTES_SHARP[bassPc]}` : name;
}

// Unified Chord Editor & Voicing Picker controller
export function initChordTools({ openModal, closeModal, onChanged, insertDefine }) {
  let lastVoicingCtx = null;

  const state = {
    preset: 'Gitarre – Standard (E A D G B E)',
    ins: 'Gitarre',
    tun: [4, 9, 2, 7, 11, 4],
    std: 1,
    base: 1,
    fr: [-1, -1, -1, -1, -1, -1],
    notes: []
  };

  const absFrets = () => state.fr.map(v => (v > 0 ? v + state.base - 1 : v));
  const formatDefine = e =>
    `{define: ${e.name} base-fret ${e.base} frets ${e.frets.map(v => (v < 0 ? 'x' : v > 0 ? v - e.base + 1 : 0)).join(' ')}}`;

  // Populate tuning preset select
  const presetSel = $('#cep');
  if (presetSel) {
    presetSel.innerHTML = Object.keys(EDITOR_TUNINGS).map(k => `<option>${esc(k)}</option>`).join('');
  }

  function renderFretboard() {
    const n = state.tun.length;
    const sp = n > 5 ? 30 : 36;
    const x0 = 34, y0 = 34, rh = 34;
    const w = x0 * 2 + (n - 1) * sp;
    let s = `<svg viewBox="0 0 ${w} ${y0 + 5 * rh + 16}" width="${Math.min(w * 1.25, 420)}" style="background:#fff;border-radius:10px;border:1px solid #d1d5db">`;
    for (let i = 0; i < n; i++) s += `<path d="M${x0 + i * sp} ${y0}V${y0 + 5 * rh}" stroke="#333"/>`;
    for (let r = 0; r <= 5; r++) s += `<path d="M${x0} ${y0 + r * rh}H${x0 + (n - 1) * sp}" stroke="#333" stroke-width="${r === 0 && state.base === 1 ? 5 : 1}"/>`;
    state.fr.forEach((v, i) => {
      const x = x0 + i * sp;
      if (v < 0) s += `<text x="${x}" y="${y0 - 10}" text-anchor="middle" font-size="16" fill="#333">×</text>`;
      else if (v === 0) s += `<circle cx="${x}" cy="${y0 - 14}" r="6" fill="none" stroke="#333" stroke-width="1.5"/>`;
      else s += `<circle cx="${x}" cy="${y0 + (v - 0.5) * rh}" r="11" fill="#ea580c"/>`;
      for (let r = 0; r <= 5; r++) {
        s += `<rect data-s="${i}" data-r="${r}" x="${x - sp / 2}" y="${r ? y0 + (r - 1) * rh : 0}" width="${sp}" height="${r ? rh : y0}" fill="transparent" style="cursor:pointer"/>`;
      }
      s += `<text x="${x}" y="${y0 + 5 * rh + 13}" text-anchor="middle" font-size="11" fill="#666">${NOTES_SHARP[state.tun[i]]}</text>`;
    });
    if (state.base > 1) s += `<text x="3" y="${y0 + rh * 0.65}" font-size="13" fill="#333">${state.base}fr</text>`;
    return s + '</svg>';
  }

  function renderEditorPiano() {
    const W = [0, 2, 4, 5, 7, 9, 11];
    const B = { 1: 0, 3: 1, 6: 3, 8: 4, 10: 5 };
    const on = k => state.notes.includes(k);
    let s = '<svg viewBox="0 0 168 70" style="background:#fff;border-radius:10px;width:100%;max-width:520px;border:1px solid #d1d5db">';
    for (let o = 0; o < 2; o++) {
      W.forEach((n, i) => {
        s += `<rect data-k="${o * 12 + n}" x="${o * 84 + i * 12}" y="0" width="12" height="70" fill="${on(o * 12 + n) ? '#ea580c' : '#fff'}" stroke="#333" style="cursor:pointer"/>`;
      });
    }
    for (let o = 0; o < 2; o++) {
      for (const [nStr, pos] of Object.entries(B)) {
        const pitch = o * 12 + (+nStr);
        s += `<rect data-k="${pitch}" x="${(o * 7 + pos + 1) * 12 - 3.5}" y="0" width="7" height="42" fill="${on(pitch) ? '#ea580c' : '#222'}" stroke="#333" style="cursor:pointer"/>`;
      }
    }
    return s + '</svg>';
  }

  function updateEditor() {
    const isPiano = state.ins === 'Klavier';
    $('#ceb-wrap').hidden = isPiano;

    let pcs, bass;
    if (isPiano) {
      const sorted = [...state.notes].sort((a, b) => a - b);
      pcs = sorted.map(k => k % 12);
      bass = pcs[0];
    } else {
      pcs = absFrets().map((v, i) => (v < 0 ? null : (state.tun[i] + v) % 12)).filter(x => x !== null);
      bass = pcs[0];
    }

    $('#cev').innerHTML = isPiano ? renderEditorPiano() : renderFretboard();
    $$('#cev [data-s]').forEach(r => {
      r.onclick = () => {
        const i = +r.dataset.s, k = +r.dataset.r;
        state.fr[i] = k ? (state.fr[i] === k ? 0 : k) : (state.fr[i] === 0 ? -1 : 0);
        updateEditor();
      };
    });
    $$('#cev [data-k]').forEach(r => {
      r.onclick = () => {
        const k = +r.dataset.k;
        const idx = state.notes.indexOf(k);
        if (idx < 0) state.notes.push(k); else state.notes.splice(idx, 1);
        state.notes.sort((a, b) => a - b);
        updateEditor();
      };
    });

    $('#cep2').innerHTML = `<div style="background:#fff;border-radius:8px;padding:6px;display:inline-block">${isPiano ? pianoSvg([...state.notes].sort((a, b) => a - b)) : guitarSvg(absFrets())}</div>`;

    const detected = detectChordName(pcs, bass);
    $('#ceg').innerHTML = detected
      ? `Erkannt: <b>${esc(detected)}</b> <button class="btn-sm" id="ceu">Übernehmen</button>`
      : '<span class="muted">Kein Standard-Akkord erkannt</span>';
    if (detected) $('#ceu').onclick = () => { $('#cen').value = detected; };

    $('#cel').innerHTML = customChords.length
      ? customChords.map((e, i) => `
          <div class="ce-item">
            <div class="ce-thumb">${e.ins === 'Klavier' ? pianoSvg(e.notes, DEFAULT_THEME, 70) : guitarSvg(e.frets, DEFAULT_THEME, 80)}</div>
            <div style="flex:1;min-width:0">
              <b>${esc(e.name)}</b><br>
              <small class="muted">${esc(e.p)}${e.std ? ' · aktiv in Diagrammen' : ' · nur Bibliothek'}</small>
            </div>
            ${e.ins !== 'Klavier' ? `<button class="btn-sm" data-d="${i}" title="{define} in Song einfügen">{define}</button>` : ''}
            <button class="btn-sm" data-e="${i}" title="Bearbeiten">✎</button>
            <button class="btn-sm danger" data-x="${i}" title="Löschen">✕</button>
          </div>`).join('')
      : '<small class="muted">Noch keine eigenen Akkorde gespeichert.</small>';

    $$('#cel [data-e]').forEach(b => { b.onclick = () => loadCustomChord(customChords[+b.dataset.e]); });
    $$('#cel [data-x]').forEach(b => {
      b.onclick = () => {
        const removed = customChords.splice(+b.dataset.x, 1)[0];
        if (removed && removed.std) delete chordOverrides[`${removed.ins}|${removed.name}`];
        saveCustomChords();
        saveOverrides();
        onChanged();
        updateEditor();
      };
    });
    $$('#cel [data-d]').forEach(b => {
      b.onclick = () => {
        insertDefine(formatDefine(customChords[+b.dataset.d]) + '\n');
        closeModal();
      };
    });
  }

  function applyPreset(key, customTun) {
    const t = EDITOR_TUNINGS[key] || EDITOR_TUNINGS['Gitarre – Standard (E A D G B E)'];
    state.preset = key;
    state.ins = t[0];
    state.std = t[2];
    if (t[1]) state.tun = [...t[1]];
    else if (customTun) state.tun = [...customTun];
    if (state.ins !== 'Klavier') {
      state.fr = state.tun.map((_, i) => (state.fr[i] === undefined ? -1 : state.fr[i]));
      state.fr.length = state.tun.length;
    }
    $('#cep').value = key;
    $('#cet').hidden = key !== 'Eigene Stimmung…';
    updateEditor();
  }

  function loadCustomChord(e) {
    $('#cen').value = e.name;
    const k = Object.keys(EDITOR_TUNINGS).find(x => x === e.p) || 'Eigene Stimmung…';
    state.tun = e.tun ? [...e.tun] : state.tun;
    if (e.ins === 'Klavier') {
      state.notes = [...e.notes];
    } else {
      state.base = e.base || 1;
      $('#ceb').value = state.base;
      state.fr = e.frets.map(v => (v > 0 ? v - state.base + 1 : v));
    }
    if (k === 'Eigene Stimmung…') $('#cet').value = state.tun.map(t => NOTES_SHARP[t]).join(' ');
    applyPreset(k, state.tun);
  }

  function saveCurrentChord() {
    const name = $('#cen').value.trim();
    if (!name) { $('#ces').textContent = 'Bitte einen Akkordnamen eingeben.'; return; }
    const isPiano = state.ins === 'Klavier';
    const entry = { name, ins: state.ins, p: state.preset, tun: [...state.tun], std: state.std, base: state.base };
    if (isPiano) {
      if (!state.notes.length) { $('#ces').textContent = 'Keine Tasten gewählt.'; return; }
      entry.notes = [...state.notes];
    } else {
      entry.frets = absFrets();
      if (!entry.frets.some(v => v >= 0)) { $('#ces').textContent = 'Keine Saite gespielt.'; return; }
    }
    const idOf = x => `${x.ins}|${x.name}|${(x.tun || []).join('.')}`;
    customChords = customChords.filter(x => idOf(x) !== idOf(entry));
    customChords.push(entry);
    if (entry.std) chordOverrides[`${entry.ins}|${name}`] = isPiano ? [...entry.notes] : [...entry.frets];
    saveCustomChords();
    saveOverrides();
    onChanged();
    $('#ces').textContent = `✓ „${name}“ gespeichert${entry.std ? ' und aktiv in Diagrammen.' : ' (Bibliothek).'}`;
    updateEditor();
  }

  function openChordEditor(name, ins) {
    $('#ces').textContent = '';
    openModal('x-ce');
    if (name !== undefined) {
      $('#cen').value = name;
      const m = CHORD_RE.exec(name);
      const k = ins === 'Klavier'
        ? 'Klavier (2 Oktaven)'
        : ins === 'Ukulele'
          ? 'Ukulele – GCEA'
          : 'Gitarre – Standard (E A D G B E)';
      state.base = 1;
      if (m) {
        const v = getVoicing(m[1], normalizeQuality(m[2] || ''), ins, name, m[3]);
        if (ins === 'Klavier') {
          state.notes = [...v];
        } else {
          const pos = v.filter(x => x > 0);
          const b = pos.length && Math.max(...pos) > 4 ? Math.min(...pos) : 1;
          state.base = b;
          state.tun = [...EDITOR_TUNINGS[k][1]];
          state.fr = v.map(x => (x > 0 ? x - b + 1 : x));
        }
      }
      $('#ceb').value = state.base;
      applyPreset(k);
    } else {
      applyPreset(state.preset);
    }
  }

  function openVoicingPicker(chordName, ins) {
    lastVoicingCtx = { c: chordName, ins };
    const m = CHORD_RE.exec(chordName);
    if (!m) return;
    const list = getAlternatives(m[1], normalizeQuality(m[2] || ''), ins, m[3] === undefined ? undefined : noteIndex(m[3])).slice(0, 40);
    $('#vct').textContent = `${ins}: Griff für ${chordName} (${list.length} Varianten)`;
    $('#vcl').innerHTML = list.map((v, i) => `
      <div class="vc-opt" data-i="${i}">
        ${ins === 'Klavier' ? pianoSvg(v) : guitarSvg(v)}
      </div>`).join('');

    $$('#vcl [data-i]').forEach(d => {
      d.onclick = () => {
        chordOverrides[`${ins}|${chordName}`] = list[+d.dataset.i];
        saveOverrides();
        closeModal();
        onChanged();
      };
    });
    $('#vcr').onclick = () => {
      delete chordOverrides[`${ins}|${chordName}`];
      saveOverrides();
      closeModal();
      onChanged();
    };
    openModal('x-vc');
  }

  // Wire UI events
  $('#cep').onchange = e => applyPreset(e.target.value);
  $('#cet').oninput = e => {
    const t = (e.target.value.match(/[A-Ga-gH][#b]?/g) || [])
      .map(x => noteIndex(x[0].toUpperCase() + x.slice(1)))
      .filter(x => x >= 0)
      .slice(0, 8);
    if (t.length > 1) {
      state.tun = t;
      state.fr = t.map((_, i) => (state.fr[i] === undefined ? -1 : state.fr[i]));
      updateEditor();
    }
  };
  $('#ceb').oninput = e => { state.base = Math.max(1, Math.min(24, +e.target.value || 1)); updateEditor(); };
  $('#cer').onclick = () => {
    state.fr = state.tun.map(() => -1);
    state.notes = [];
    state.base = 1;
    $('#ceb').value = 1;
    $('#cen').value = '';
    updateEditor();
  };
  $('#ces2').onclick = saveCurrentChord;
  $('#ced').onclick = () => {
    if (state.ins === 'Klavier') { $('#ces').textContent = '{define} gibt es nur für Saiteninstrumente.'; return; }
    const name = $('#cen').value.trim();
    if (!name) { $('#ces').textContent = 'Bitte einen Namen eingeben.'; return; }
    insertDefine(formatDefine({ name, base: state.base, frets: absFrets() }) + '\n');
    closeModal();
  };
  $('#cx1').onclick = () => downloadText(
    'chordpro-akkorde.json',
    JSON.stringify({ format: 'chordpro-studio-chords', v: 2, lib: customChords, overrides: chordOverrides }, null, 2),
    'application/json'
  );
  $('#cx2').onclick = () => downloadText(
    'chord-defines.txt',
    customChords.filter(e => e.ins !== 'Klavier').map(formatDefine).join('\n') + '\n'
  );
  $('#cx3').onclick = () => $('#cxg').click();
  $('#cxg').onchange = async e => {
    const f = e.target.files[0];
    if (!f) return;
    const t = await f.text();
    let n = 0;
    try {
      if (/\.json$/i.test(f.name)) {
        n = mergeChordLibrary(JSON.parse(t));
      } else {
        for (const l of t.split(/\r?\n/)) {
          const m = /^\{\s*define\s*:?\s*(\S+)(.*)\}/i.exec(l.trim());
          if (!m) continue;
          const fr = parseDefineFrets(l, 'Gitarre') || parseDefineFrets(l, 'Ukulele');
          if (!fr) continue;
          const ins = fr.length === 6 ? 'Gitarre' : 'Ukulele';
          const pr = ins === 'Gitarre' ? 'Gitarre – Standard (E A D G B E)' : 'Ukulele – GCEA';
          const pos = fr.filter(v => v > 0);
          const b = pos.length && Math.max(...pos) > 4 ? Math.min(...pos) : 1;
          customChords = customChords.filter(y => !(y.ins === ins && y.name === m[1]));
          customChords.push({ name: m[1], ins, p: pr, tun: [...EDITOR_TUNINGS[pr][1]], std: 1, base: b, frets: fr });
          chordOverrides[`${ins}|${m[1]}`] = fr;
          n++;
        }
        saveCustomChords();
        saveOverrides();
      }
      onChanged();
      $('#ces').textContent = `${n} Einträge importiert.`;
    } catch (err) {
      $('#ces').textContent = 'Import fehlgeschlagen: ' + err.message;
    }
    e.target.value = '';
    updateEditor();
  };
  $('#vce').onclick = () => {
    if (lastVoicingCtx) openChordEditor(lastVoicingCtx.c, lastVoicingCtx.ins);
  };

  return { openChordEditor, openVoicingPicker };
}
