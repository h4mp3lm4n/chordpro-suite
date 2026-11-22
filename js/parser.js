// ChordPro parser, transposition, Roman/Nashville notation, Auto-Capo & Ultimate Guitar converter

import { parseDurationSec } from './utils.js';

export const NOTES_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const NOTES_FLAT  = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
export const ROMAN = ['I', 'bII', 'II', 'bIII', 'III', 'IV', '#IV', 'V', 'bVI', 'VI', 'bVII', 'VII'];

export const CHORD_RE = /^([A-GH][#b]?)([^\/]*)(?:\/([A-GH][#b]?))?$/;
export const CHORD_STRICT_RE = /^[A-GH][#b]?(?:maj|min|dim|aug|sus|add|m|M|\d+|[#b+\-°ø()]|\/[A-GH][#b]?)*$/;
const SECTION_HEAD_RE = /^(intro|verse|chorus|pre-?chorus|bridge|outro|solo|instrumental|interlude|refrain|hook|tag|coda|breakdown|strophe|ending|zwischenteil|vorspiel|nachspiel)\b/i;

const OPEN_CHORDS = /^(C|D|E|G|A|Am|Dm|Em|E7|A7|D7|G7|C7|B7|Cmaj7|Am7|Em7|Dsus4|Asus4|Dsus2|Asus2|Fmaj7)$/;

const ALIASES = {
  soc: 'sc', eoc: 'ec',
  sov: 'sv', eov: 'ev',
  sob: 'sb', eob: 'eb',
  sot: 'st', eot: 'et',
  sog: 'sg', eog: 'eg',
  t: 'title', st: 'subtitle', a: 'artist', k: 'key'
};

const COMMENT_TYPES = {
  comment: 'c', c: 'c',
  comment_italic: 'i', ci: 'i',
  comment_box: 'b', cb: 'b',
  highlight: 'h'
};

const PAGE_BREAKS = {
  new_page: 'np', np: 'np',
  new_physical_page: 'np', npp: 'np',
  column_break: 'cb2', colb: 'cb2'
};

export function noteIndex(note) {
  if (!note) return -1;
  // Support German H (= B)
  const norm = note === 'H' ? 'B' : note === 'Hb' ? 'Bb' : note;
  const i = NOTES_SHARP.indexOf(norm);
  return i >= 0 ? i : NOTES_FLAT.indexOf(norm);
}

function formatNote(idx, flat, german) {
  const n = (flat ? NOTES_FLAT : NOTES_SHARP)[((idx % 12) + 12) % 12];
  if (!german) return n;
  if (n === 'B') return 'H';
  if (n === 'Bb' || n === 'A#') return 'B';
  return n;
}

export function parseChordPro(text, activeInstruments = []) {
  const meta = {};
  const items = [];
  const chords = [];
  const defs = {};

  const instMatches = sel => {
    const map = { guitar: 'Gitarre', ukulele: 'Ukulele', piano: 'Klavier', keyboard: 'Klavier' };
    const target = map[sel.toLowerCase()];
    return target ? activeInstruments.includes(target) : false;
  };

  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line[0] === '#') continue;

    const dir = /^\{\s*([\w-]+)\s*(?::|\s)?\s*(.*?)\s*\}$/.exec(line.trim());
    if (dir) {
      let name = dir[1].toLowerCase();
      const val = dir[2];
      let sel = '';
      let neg = false;

      const selMatch = /^([a-z_]+)-(.+)$/.exec(name);
      if (selMatch) {
        name = selMatch[1];
        sel = selMatch[2];
        if (sel[0] === '!') {
          neg = true;
          sel = sel.slice(1);
        }
      }

      if (sel && !/^(define|chord)$/.test(name) && activeInstruments.length > 0 && instMatches(sel) === neg) {
        continue;
      }

      if (name === 'cb' && !val.trim()) name = 'colb';

      if (COMMENT_TYPES[name]) {
        items.push({ k: 'cm', v: val, t: COMMENT_TYPES[name] });
        continue;
      }
      if (PAGE_BREAKS[name]) {
        items.push({ k: PAGE_BREAKS[name] });
        continue;
      }
      if (name === 'image') {
        items.push({ k: 'img', v: val });
        continue;
      }

      name = ALIASES[name] ||
        name.replace(/^start_of_(.)\w*/, 's$1').replace(/^end_of_(.)\w*/, 'e$1');

      if (/^[se][cvbtg]$/.test(name)) {
        items.push({ k: name, v: val });
      } else if (name === 'define' || name === 'chord') {
        const chordName = val.split(/\s+/)[0];
        if (chordName) (defs[chordName] = defs[chordName] || []).push(val);
        if (name === 'chord') items.push({ k: 'chd', v: val });
      } else if (name === 'tag') {
        (meta.tags = meta.tags || []).push(val);
      } else if (name === 'meta') {
        const q = /^(\S+)\s*(.*)$/.exec(val);
        if (q) {
          if (q[1] === 'tag') (meta.tags = meta.tags || []).push(q[2]);
          else meta[q[1]] = q[2];
        }
      } else {
        meta[name] = val;
      }
      continue;
    }

    if (!line.trim()) {
      items.push({ k: 'br' });
      continue;
    }

    if (!line.includes('[')) {
      items.push({ k: 'tx', v: line });
      continue;
    }

    const parts = line.split(/\[([^\]]*)\]/);
    const segs = [['', parts[0]]];
    for (let i = 1; i < parts.length; i += 2) {
      segs.push([parts[i], parts[i + 1] || '']);
      if (parts[i]) chords.push(parts[i]);
    }
    items.push({ k: 'ln', segs });
  }

  return { meta, items, chords, defs };
}

export function keyOf(parsed) {
  const k = parsed.meta.key || parsed.chords[0] || 'C';
  const m = CHORD_RE.exec(k) || [null, 'C', ''];
  return { root: m[1], minor: /^m(?!aj)/.test(m[2] || '') };
}

export function convertChord(chord, semitones, flat, keyObj, mode = 'std', german = false) {
  const m = CHORD_RE.exec(chord);
  if (!m) return chord;
  const rootIdx = noteIndex(m[1]);
  if (rootIdx < 0) return chord;

  const qual = m[2] || '';
  const bassIdx = m[3] ? noteIndex(m[3]) : -1;

  const transposedRoot = formatNote(rootIdx + semitones, flat, german);
  const transposedBass = bassIdx >= 0 ? '/' + formatNote(bassIdx + semitones, flat, german) : '';
  const std = transposedRoot + qual + transposedBass;
  if (mode === 'std') return std;

  const keyIdx = noteIndex(keyObj.root);
  const isMinor = /^m(?!aj)/.test(qual);
  const relDeg = ROMAN[((rootIdx - keyIdx) % 12 + 12) % 12];
  const romanRoot = (isMinor ? relDeg.toLowerCase() : relDeg) + (isMinor ? qual.slice(1) : qual);
  const romanBass = bassIdx >= 0 ? '/' + ROMAN[((bassIdx - keyIdx) % 12 + 12) % 12] : '';
  const rom = romanRoot + romanBass;

  return mode === 'rom' ? rom : `${std}\u0001${rom}`;
}

export function createTransposer(parsed, { shift = 0, capo = 0, nota = 'std', german = false } = {}) {
  const K = keyOf(parsed);
  const delta = shift - capo;
  let targetKey = ((noteIndex(K.root) + delta) % 12 + 12) % 12;
  if (K.minor) targetKey = (targetKey + 3) % 12;
  // Keys F, Bb, Eb, Ab, Db prefer flats
  const flat = [5, 10, 3, 8, 1].includes(targetKey);

  return {
    key: K,
    flat,
    std: c => convertChord(c, delta, flat, K, 'std', false), // canonical name for diagram lookup
    fmt: c => (c ? convertChord(c, delta, flat, K, nota, german) : '')
  };
}

export function computeAutoCapo(text, shift = 0) {
  const parsed = parseChordPro(text);
  const unique = [...new Set(parsed.chords)];
  if (!unique.length) return 0;

  let bestCapo = 0;
  let bestScore = -1;
  for (let capo = 0; capo <= 9; capo++) {
    let score = 0;
    for (const ch of unique) {
      const m = CHORD_RE.exec(ch);
      if (!m) continue;
      const idx = noteIndex(m[1]);
      if (idx < 0) continue;
      const name = NOTES_SHARP[((idx + shift - capo) % 12 + 12) % 12] + (m[2] || '');
      if (OPEN_CHORDS.test(name)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestCapo = capo;
    }
  }
  return bestCapo;
}

export function songInfo(song) {
  const m = parseChordPro(song.text).meta;
  const tags = m.tags || [];
  const loop =
    tags.some(x => /^(loop|loopable|looper)$/i.test(x.trim())) ||
    /^(1|true|yes|ja|on)$/i.test(m.loop || '');
  const tempoNum = parseInt(String(m.tempo || '').replace(/\D+/g, ''), 10) || 0;
  const durationSec = parseDurationSec(m.duration);
  return {
    title: m.title || 'Ohne Titel',
    subtitle: m.subtitle || '',
    artist: m.artist || '',
    key: m.key || '',
    tempo: tempoNum,
    duration: m.duration || '',
    durationSec,
    tags: tags.join(', '),
    loop
  };
}

export function ugConvert(rawText, normalizeGermanH = true) {
  let txt = String(rawText || '')
    .replace(/\[\/?tab\]/gi, '')
    .replace(/\[ch\]([^\[]*)\[\/ch\]/gi, '$1')
    .replace(/\t/g, '    ');

  const lines = txt.split(/\r?\n/);
  const tok = l => l.trim().split(/\s+/);
  const normChord = x => {
    if (!normalizeGermanH) return x;
    return x.replace(/^H(#|b)?/, 'B$1').replace(/\/H(#|b)?/, '/B$1');
  };
  const isChordLine = l => {
    const t = tok(l);
    return (
      l.trim().length > 0 &&
      t.every(x => CHORD_STRICT_RE.test(x) || /^(\||\/|x\d+|\d+x|N\.?C\.?|\(|\)|-)$/i.test(x)) &&
      t.some(x => CHORD_STRICT_RE.test(x))
    );
  };
  const headerOf = l => {
    const m = /^\s*\[([^\]]+)\]\s*$/.exec(l) || /^\s*([A-Za-zÄÖÜäöüß\- ]+\d*)\s*:?\s*$/.exec(l);
    return m && SECTION_HEAD_RE.test(m[1].trim()) ? m[1].trim() : null;
  };
  const isTabLine = l => /^\s*[eEBGDAhH]\|[-0-9hpbrx\/\\~()|.\s^]*$/.test(l);

  const blocks = [];
  const meta = [];
  let cur = null;
  const newBlock = (type, label) => {
    cur = { type, label, lines: [] };
    blocks.push(cur);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heading = headerOf(line);
    const metaMatch = !blocks.length && /^\s*(title|artist|capo|key|tuning|tempo|bpm)\s*[:\-]\s*(.+)$/i.exec(line);

    if (metaMatch) {
      const k = metaMatch[1].toLowerCase();
      const v = metaMatch[2].trim();
      if (k === 'capo') {
        const n = /\d+/.exec(v);
        meta.push(`{capo: ${n ? n[0] : v}}`);
      } else if (k === 'key') {
        meta.push(`{key: ${normChord(v)}}`);
      } else if (k === 'tempo' || k === 'bpm') {
        meta.push(`{tempo: ${v.replace(/\D+/g, '')}}`);
      } else if (k === 'title' || k === 'artist') {
        meta.push(`{${k}: ${v}}`);
      } else {
        meta.push(`{comment: Tuning: ${v}}`);
      }
      continue;
    }

    if (heading) {
      const secType = /^(chorus|refrain|hook)/i.test(heading)
        ? 'chorus'
        : /^bridge|zwischenteil/i.test(heading)
          ? 'bridge'
          : 'verse';
      newBlock(secType, heading);
      continue;
    }

    if (isTabLine(line)) {
      if (!cur || cur.type !== 'tab') newBlock('tab');
      cur.lines.push(line.replace(/\s+$/, ''));
      continue;
    }

    if (!line.trim()) {
      if (cur && cur.type === 'raw') cur.lines.push('');
      continue;
    }

    if (!cur || cur.type === 'tab') newBlock('raw');

    if (isChordLine(line)) {
      const next = lines[i + 1];
      if (next !== undefined && next.trim() && !isChordLine(next) && !headerOf(next) && !isTabLine(next)) {
        let merged = next;
        let offset = 0;
        for (const m of [...line.matchAll(/\S+/g)]) {
          if (!CHORD_STRICT_RE.test(m[0])) continue;
          const chord = normChord(m[0]);
          const pos = Math.min(m.index + offset, merged.length);
          merged = merged.slice(0, pos) + `[${chord}]` + merged.slice(pos);
          offset += chord.length + 2;
        }
        cur.lines.push(merged);
        i++;
      } else {
        cur.lines.push(tok(line).map(x => (CHORD_STRICT_RE.test(x) ? `[${normChord(x)}]` : x)).join(' '));
      }
    } else {
      cur.lines.push(line);
    }
  }

  const out = [...meta];
  if (meta.length) out.push('');

  for (const b of blocks) {
    const q = b.lines.slice();
    while (q.length && !q[0].trim()) q.shift();
    while (q.length && !q[q.length - 1].trim()) q.pop();
    if (!q.length) continue;

    if (b.type === 'raw') {
      out.push(...q);
    } else if (b.type === 'tab') {
      out.push('{start_of_tab}', ...q, '{end_of_tab}');
    } else {
      out.push(`{start_of_${b.type}: ${b.label}}`, ...q, `{end_of_${b.type}}`);
    }
    out.push('');
  }

  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.join('\n');
}
