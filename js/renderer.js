// Safe ChordPro HTML renderer, A4 paginator & PDF exporter

import { esc, safeColor, safeImageUrl, safeFontFamily, rgbToHex, showToast } from './utils.js';
import { parseChordPro, createTransposer, CHORD_RE, CHORD_STRICT_RE } from './parser.js';
import { renderDiagrams, parseDefineFrets, getVoicing, normalizeQuality, guitarSvg } from './chords.js';

export function formatChordHtml(str) {
  const [main, roman] = String(str || '').split('\u0001');
  if (!roman) return esc(main);
  return `${esc(main)}<span class="c-rom"> (${esc(roman)})</span>`;
}

export function directiveStyleCss(meta) {
  const out = [];
  const px = v => {
    const num = parseFloat(v);
    return isNaN(num) || num <= 0 || num > 200 ? '' : (num * 1.333).toFixed(1) + 'px';
  };
  const addColor = (key, prop) => {
    const c = safeColor(meta[key] || meta[key.replace('colour', 'color')]);
    if (c) out.push(`${prop}:${c}`);
  };
  const addSize = (key, prop) => { const s = px(meta[key]); if (s) out.push(`${prop}:${s}`); };
  const addFont = (key, prop) => { const f = safeFontFamily(meta[key]); if (f) out.push(`${prop}:${f}`); };

  addColor('textcolour', 'color');
  addSize('textsize', 'font-size');
  addFont('textfont', 'font-family');
  addColor('chordcolour', '--cc');
  addSize('chordsize', '--cs');
  addFont('chordfont', '--cf');
  addColor('tabcolour', '--tcol');
  addSize('tabsize', '--ts');
  addFont('tabfont', '--tf');
  addColor('titlecolour', '--hcol');
  addSize('titlesize', '--hs');
  addFont('titlefont', '--hf');
  addColor('labelcolour', '--lcol');
  addSize('labelsize', '--lsz');
  addFont('labelfont', '--lf');
  addColor('footercolour', '--fcol');
  addSize('footersize', '--fsz');
  addFont('footerfont', '--ff');

  return out.length ? ';' + out.join(';') : '';
}

export function sheetCss(layout) {
  const W = layout.land ? 1123 : 794;
  return (
    `width:${W}px;font-size:${layout.fs}px;--lh:${layout.ls};--cc:${layout.cc};` +
    `color:${layout.tc};font-family:${layout.ff};font-weight:${layout.fw};` +
    `--cs:${layout.cfs}px;--hl:${layout.hl || '#fde047'};--sg:${layout.sg}px`
  );
}

function buildMetaLine(meta, layout, opts) {
  const f = layout.mf || {};
  const parts = [];
  const fields = [
    ['artist', ''], ['subtitle', ''], ['composer', 'Musik: '], ['lyricist', 'Text: '],
    ['arranger', 'Arr.: '], ['album', 'Album: '], ['year', 'Jahr: '], ['key', 'Key: '],
    ['time', 'Takt: '], ['tempo', 'Tempo: ', 'BPM'], ['duration', 'Dauer: '],
    ['capo', 'Capo: '], ['copyright', '© ']
  ];
  for (const [k, pre, suf] of fields) {
    if (f[k] && meta[k] && (k !== 'capo' || !opts.capo)) {
      parts.push(pre + meta[k] + (suf ? ' ' + suf : ''));
    }
  }
  if (opts.shift) parts.push('Shift ' + (opts.shift > 0 ? '+' : '') + opts.shift);
  if (opts.capo) parts.push('Capo ' + opts.capo);
  return parts.join(' · ');
}

export function buildSongModel(text, layout, opts = {}) {
  const instruments = opts.dins || [];
  const parsed = parseChordPro(text, instruments);
  const m = parsed.meta;

  // Support {diagrams: off|false|0} directive
  const diagramsDisabled = /^(off|false|0|no|none)$/i.test(String(m.diagrams || '').trim());
  const effectiveInstruments = diagramsDisabled ? [] : instruments;

  // Initial transposition (may be updated inline by {transpose: N} directives for modulations!)
  let inlineShift = 0;
  const makeTr = extra => createTransposer(parsed, {
    shift: (opts.shift || 0) + extra,
    capo: opts.capo || 0,
    nota: opts.nota || 'std',
    german: opts.german ?? !!layout.german
  });
  let tr = makeTr(0);

  // If song starts with {transpose: N}, apply it to diagrams too
  const firstTranspose = parsed.items.find(it => it.k === 'transpose' || it.k === 'ln');
  const diagramTr = firstTranspose && firstTranspose.k === 'transpose' ? makeTr(firstTranspose.v) : tr;

  const dh = effectiveInstruments.length
    ? renderDiagrams(parsed, diagramTr.std, effectiveInstruments, opts.th, { dsz: layout.dsz, dgp: layout.dgp }, diagramTr.fmt)
    : '';

  const head =
    `<div class="h1">${esc(m.title || 'Ohne Titel')}</div>` +
    `<div class="mt">${esc(buildMetaLine(m, layout, opts))}</div>` +
    (opts.diaSep ? '' : dh);

  const pairHtml = (c, t) =>
    `<span class="p"><span class="c">${formatChordHtml(tr.fmt(c))}</span><span class="t">${esc(t) || '&nbsp;'}</span></span>`;

  const lineHtml = segs => {
    let html = '';
    let word = '';
    const flush = () => {
      if (word) {
        html += `<span class="w">${word}</span>`;
        word = '';
      }
    };
    for (const [c, t] of segs) {
      if (!c && !t) continue;
      const chunks = t.match(/\s*\S+\s*|\s+/g) || [''];
      chunks.forEach((p, idx) => {
        if (/^\s/.test(p) && word) flush();
        word += pairHtml(idx ? '' : c, p);
        if (/\s$/.test(p)) flush();
      });
    }
    flush();
    return html;
  };

  const gridHtml = val => {
    const tokens = val.trim().split(/\s+/);
    const isBar = x => /^(\|[|:.\d]*|:\|[|:]*)$/.test(x);
    const cols = tokens.map(x => (isBar(x) ? 'auto' : 'minmax(0,1fr)')).join(' ');
    const cells = tokens.map(x =>
      isBar(x)
        ? `<span class="gb">${esc(x)}</span>`
        : `<span class="gc">${CHORD_STRICT_RE.test(x) ? formatChordHtml(tr.fmt(x)) : esc(x)}</span>`
    ).join('');
    return `<div class="gr" style="grid-template-columns:${cols}">${cells}</div>`;
  };

  const inlineChordHtml = val => {
    const nm = val.trim().split(/\s+/)[0];
    const cm = CHORD_RE.exec(nm);
    if (!cm) return '';
    const ins = instruments.find(i => i !== 'Klavier') || 'Gitarre';
    const frets = parseDefineFrets(val, ins) || getVoicing(cm[1], normalizeQuality(cm[2] || ''), ins, nm, cm[3]);
    const cc = safeColor(layout.cc) || '#ea580c';
    return `<div class="inline-chd">${guitarSvg(frets, { c: cc, d: cc, p: cc, k: '#fff', kb: '#222' }, layout.dsz)}<div style="color:${cc}">${esc(nm)}</div></div>`;
  };

  const kv = (v, k) => {
    const r = new RegExp(k + '=(?:"([^"]*)"|(\\S+))').exec(v);
    return r ? (r[1] !== undefined ? r[1] : r[2]) : null;
  };

  const safeImgHtml = val => {
    const rawSrc = kv(val, 'src') || val.trim().split(/\s+/)[0];
    const src = safeImageUrl(rawSrc);
    if (!src) return '';
    const wNum = parseFloat(kv(val, 'width'));
    const hNum = parseFloat(kv(val, 'height'));
    const scNum = parseFloat(kv(val, 'scale'));
    const alignRaw = (kv(val, 'align') || (/\bcenter\b/.test(val) ? 'center' : 'left')).toLowerCase();
    const align = alignRaw === 'right' || alignRaw === 'center' ? alignRaw : 'left';
    const bdRaw = kv(val, 'border') || (/\bborder\b(?!=)/.test(val) ? '1' : null);
    const bdNum = bdRaw ? Math.max(0, Math.min(20, parseFloat(bdRaw) || 1)) : 0;
    const bc = safeColor(kv(val, 'bordercolor')) || '#000000';
    const title = kv(val, 'title');

    let style = 'display:block;max-width:100%;';
    if (!isNaN(wNum) && wNum > 0 && wNum < 3000) style += `width:${wNum}px;`;
    if (!isNaN(hNum) && hNum > 0 && hNum < 3000) style += `height:${hNum}px;`;
    if (!isNaN(scNum) && scNum > 0 && scNum <= 5 && isNaN(wNum)) style += `width:${(scNum * 100).toFixed(1)}%;`;
    if (bdNum > 0) style += `border:${bdNum}px solid ${bc};box-sizing:border-box;`;

    return (
      `<div style="text-align:${align};margin:.4em 0">` +
      `<div style="display:inline-block;max-width:100%">` +
      `<img src="${esc(src)}" alt="" style="${style}">` +
      (title ? `<div style="font-size:.75em;opacity:.7;text-align:center">${esc(title)}</div>` : '') +
      `</div></div>`
    );
  };

  const groups = [];
  const sections = [];
  let sec = null;
  let par = null;
  let lastBlank = false;
  let secCounter = 0;
  let lastChorusItems = null;
  let curChorusItems = null;

  const put = h => { (sec || (par = par || { l: [] })).l.push(h); };
  const closePar = () => { if (par) { groups.push(par); par = null; } };
  const pushSec = g => {
    while (g.l.length && g.l[g.l.length - 1].startsWith('<div class="sp-br">')) g.l.pop();
    if (g.c === 'ch' && curChorusItems) {
      lastChorusItems = curChorusItems.slice();
      curChorusItems = null;
    }
    groups.push(g);
  };

  const renderInlineItem = (item, isGrid) => {
    if (item.k === 'cm') return opts.cm !== false ? `<div class="cm cm-${item.t}">${esc(item.v)}</div>` : '';
    if (item.k === 'img') return safeImgHtml(item.v);
    if (item.k === 'chd') return inlineChordHtml(item.v);
    if (item.k === 'tx') return isGrid ? gridHtml(item.v) : `<div class="ln"><span class="tx">${esc(item.v)}</span></div>`;
    if (item.k === 'ln') return `<div class="ln">${lineHtml(item.segs)}</div>`;
    if (item.k === 'br') return '<div class="sp-br"></div>';
    return '';
  };

  const defaultLabel = code => ({ sc: 'Refrain', sv: 'Strophe', sb: 'Bridge', st: 'Tab', sg: 'Grid' }[code] || '');

  for (const item of parsed.items) {
    if (item.k !== 'br') lastBlank = false;

    if (item.k === 'transpose') {
      inlineShift += item.v;
      tr = makeTr(inlineShift);
      continue;
    }

    if (item.k === 'chorus_ref') {
      closePar();
      if (sec) { pushSec(sec); sec = null; }
      const secId = secCounter++;
      const lbl = item.v || 'Refrain';
      sections.push({ id: secId, label: lbl, type: 'sc' });
      const lines = [`<div class="lab" data-sec="${secId}">${esc(lbl)}</div>`];
      if (lastChorusItems && lastChorusItems.length) {
        for (const ci of lastChorusItems) {
          const h = renderInlineItem(ci, false);
          if (h) lines.push(h);
        }
      }
      groups.push({ c: 'ch', secId, l: lines });
      continue;
    }

    if (/^s[cvbtg]$/.test(item.k)) {
      closePar();
      if (sec) pushSec(sec);
      const secId = secCounter++;
      const labelText = item.v || defaultLabel(item.k);
      if (labelText) sections.push({ id: secId, label: labelText, type: item.k });
      curChorusItems = item.k === 'sc' ? [] : null;
      sec = {
        c: item.k === 'sc' ? 'ch' : item.k === 'st' ? 'sec tab' : item.k === 'sg' ? 'sec grid' : 'sec',
        g: item.k === 'sg',
        secId,
        l: item.v ? [`<div class="lab" data-sec="${secId}">${esc(item.v)}</div>`] : []
      };
    } else if (/^e[cvbtg]$/.test(item.k)) {
      if (sec) pushSec(sec);
      sec = null;
    } else if (item.k === 'br') {
      if (lastBlank) continue;
      lastBlank = true;
      if (sec) {
        if (curChorusItems) curChorusItems.push(item);
        sec.l.push('<div class="sp-br"></div>');
      } else closePar();
    } else if (item.k === 'np' || item.k === 'cb2') {
      closePar();
      if (sec) { pushSec(sec); sec = null; }
      groups.push({ brk: item.k === 'np' ? 'np' : 'col' });
    } else if (item.k === 'cm') {
      if (opts.cm !== false) {
        if (curChorusItems) curChorusItems.push(item);
        const secId = secCounter++;
        if (item.t === 'c' && item.v && item.v.length <= 28) {
          sections.push({ id: secId, label: item.v, type: 'cm' });
          put(`<div class="cm cm-${item.t}" data-sec="${secId}">${esc(item.v)}</div>`);
        } else {
          put(`<div class="cm cm-${item.t}">${esc(item.v)}</div>`);
        }
      }
    } else if (item.k === 'img') {
      if (curChorusItems) curChorusItems.push(item);
      const h = safeImgHtml(item.v);
      if (h) put(h);
    } else if (item.k === 'chd') {
      if (curChorusItems) curChorusItems.push(item);
      const h = inlineChordHtml(item.v);
      if (h) put(h);
    } else if (item.k === 'tx') {
      if (curChorusItems) curChorusItems.push(item);
      put(sec && sec.g ? gridHtml(item.v) : `<div class="ln"><span class="tx">${esc(item.v)}</span></div>`);
    } else {
      if (curChorusItems) curChorusItems.push(item);
      put(`<div class="ln">${lineHtml(item.segs)}</div>`);
    }
  }
  if (sec) pushSec(sec);
  closePar();

  const renderGroup = (g, lines) => {
    const attr = g.secId !== undefined ? ` data-sec-grp="${g.secId}"` : '';
    return `<div class="${g.c || 'par'}"${attr}>${lines.join('')}</div>`;
  };

  return { head, dh, groups, sections, meta: m, renderGroup };
}

export function paginate(model, W, H, pad, gap, cols, sty, cls = '') {
  const cw = (W - 2 * pad - gap * (cols - 1)) / cols;
  const ch = H - 2 * pad;
  const ms = document.createElement('div');
  ms.className = cls;
  ms.style.cssText = `position:absolute;left:-9999px;top:0;visibility:hidden;display:flow-root;font-family:Arial,sans-serif;${sty}`;
  document.body.appendChild(ms);

  const measure = (html, w) => {
    ms.style.width = w + 'px';
    ms.innerHTML = html;
    return ms.offsetHeight;
  };

  const headH = measure(model.head, W - 2 * pad) + 12;
  const pages = [];
  let page = [];
  let col = { h: 0, it: [] };

  const capacity = () => (pages.length ? ch : Math.max(80, ch - headH));
  const nextCol = () => {
    page.push(col);
    col = { h: 0, it: [] };
    if (page.length === cols) {
      pages.push(page);
      page = [];
    }
  };

  for (const g of model.groups) {
    if (g.brk) {
      if (g.brk === 'col') {
        if (col.it.length) nextCol();
      } else {
        if (col.it.length) page.push(col);
        if (page.length) pages.push(page);
        page = [];
        col = { h: 0, it: [] };
      }
      continue;
    }

    const html = model.renderGroup(g, g.l);
    const full = measure(html, cw);
    if (col.h + full <= capacity()) {
      col.it.push(html);
      col.h += full + 8;
      continue;
    }
    if (full <= capacity()) {
      nextCol();
      col.it.push(html);
      col.h += full + 8;
      continue;
    }

    let buf = [];
    let bh = 0;
    const flush = () => {
      if (buf.length) {
        col.it.push(model.renderGroup(g, buf));
        col.h += bh;
        buf = [];
        bh = 0;
      }
    };
    for (const l of g.l) {
      const hl = measure(l, cw);
      if (col.h + bh + hl > capacity() && (buf.length || col.it.length)) {
        flush();
        nextCol();
      }
      buf.push(l);
      bh += hl;
    }
    flush();
  }

  if (col.it.length) page.push(col);
  if (page.length) pages.push(page);
  if (!pages.length) pages.push([{ it: [] }]);
  ms.remove();
  return pages;
}

export function pageDims(layout, pagetype) {
  const pt = String(pagetype || 'a4').toLowerCase().trim();
  let w = 794, h = 1123; // A4 @ 96dpi
  if (pt === 'letter') { w = 816; h = 1056; }
  else if (pt === 'a5') { w = 559; h = 794; }
  return layout.land ? { W: h, H: w } : { W: w, H: h };
}

export function renderPagesA4(text, layout, opts) {
  const model = buildSongModel(text, layout, opts);
  const M = model.meta;
  const { W, H } = pageDims(layout, M.pagetype);
  const cols = +(M.columns || M.col) || opts.cols || 1;
  const gap = 24;
  const ex = directiveStyleCss(M);
  const pages = paginate(model, W, H, 40, gap, cols, sheetCss(layout) + ex);

  const html = pages.map((pg, i) =>
    `<div class="pg" style="width:${W}px;height:${H}px${ex}">` +
    (i ? '' : model.head) +
    `<div style="display:grid;grid-template-columns:repeat(${cols},1fr);gap:${gap}px">` +
    pg.map(c => `<div>${c.it.join('')}</div>`).join('') +
    `</div><div class="pn">${i + 1}/${pages.length}</div></div>`
  ).join('');

  return { html, pageCount: pages.length, model };
}

// Fast text line extraction: avoids per-character Range when text fits on one line
function extractTextRuns(textNode, isMono) {
  const t = textNode.nodeValue;
  if (!t || !t.trim()) return [];
  const r = document.createRange();

  if (!isMono) {
    r.selectNodeContents(textNode);
    const rects = r.getClientRects();
    if (rects.length === 1) {
      return [{ t, x: rects[0].left, y: rects[0].top }];
    }
  }

  const out = [];
  let cy = null, cur = '', cx = 0, ch = [];
  const push = () => {
    if (cur.trim()) out.push({ t: cur, x: cx, y: cy, ch });
    cur = '';
    ch = [];
  };
  for (let i = 0; i < t.length; i++) {
    r.setStart(textNode, i);
    r.setEnd(textNode, i + 1);
    const b = r.getClientRects()[0];
    if (!b) continue;
    if (cy === null || Math.abs(b.top - cy) > 3) {
      push();
      cy = b.top;
      cx = b.left;
    }
    cur += t[i];
    if (isMono) ch.push([t[i], b.left]);
  }
  push();
  return out;
}

export async function exportPdf(songList, layout, currentOpts, useCurrentOpts = false) {
  if (!songList.length) {
    showToast('Keine Songs ausgewählt');
    return;
  }

  if (!window.pdfMake) {
    showToast('PDF-Bibliothek offline nicht verfügbar – öffne Druckdialog…', 3000);
    window.print();
    return;
  }

  const W = layout.land ? 1123 : 794;
  const H = layout.land ? 794 : 1123;
  const K = 0.75;
  const content = [];
  const box = document.createElement('div');
  box.style.cssText = `${sheetCss(layout)};position:absolute;left:-99999px;top:0`;
  document.body.appendChild(box);
  let first = true;

  for (const sg of songList) {
    const o = useCurrentOpts
      ? currentOpts
      : { shift: 0, capo: 0, nota: 'std', cols: layout.cols, dins: layout.insA || [], cm: layout.cm !== false, german: !!layout.german };
    const { html } = renderPagesA4(sg.text, layout, o);
    box.innerHTML = html;

    for (const pg of box.querySelectorAll('.pg')) {
      const r0 = pg.getBoundingClientRect();
      content.push({ text: ' ', fontSize: 1, pageBreak: first ? undefined : 'before' });
      first = false;

      const add = (node, x, y) => {
        node.absolutePosition = { x: (x - r0.left) * K, y: (y - r0.top) * K };
        content.push(node);
      };

      pg.querySelectorAll('.ch').forEach(e => {
        const r = e.getBoundingClientRect();
        add({ canvas: [{ type: 'rect', x: 0, y: 0, w: 3, h: r.height * K, color: layout.cc }] }, r.left, r.top);
      });

      pg.querySelectorAll('.cm').forEach(e => {
        const r = e.getBoundingClientRect();
        const cs = getComputedStyle(e);
        const bg = cs.backgroundColor;
        const cv = [];
        if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
          cv.push({ type: 'rect', x: 0, y: 0, w: r.width * K, h: r.height * K, color: rgbToHex(bg) });
        }
        if (parseFloat(cs.borderTopWidth) > 0) {
          cv.push({ type: 'rect', x: 0, y: 0, w: r.width * K, h: r.height * K, lineWidth: 0.75, lineColor: rgbToHex(cs.borderTopColor) });
        }
        if (cv.length) add({ canvas: cv }, r.left, r.top);
      });

      pg.querySelectorAll('svg').forEach(e => {
        const r = e.getBoundingClientRect();
        const c = e.cloneNode(true);
        c.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        c.setAttribute('width', r.width * K);
        c.setAttribute('height', r.height * K);
        add({ svg: c.outerHTML, width: r.width * K }, r.left, r.top);
      });

      pg.querySelectorAll('img').forEach(e => {
        try {
          if (!e.naturalWidth) return;
          const cv = document.createElement('canvas');
          cv.width = e.naturalWidth;
          cv.height = e.naturalHeight;
          cv.getContext('2d').drawImage(e, 0, 0);
          const r = e.getBoundingClientRect();
          add({ image: cv.toDataURL('image/png'), width: r.width * K, height: r.height * K }, r.left, r.top);
        } catch {
          // CORS-tainted image cannot be drawn to canvas
        }
      });

      const tw = document.createTreeWalker(pg, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = tw.nextNode())) {
        const p = n.parentElement;
        if (!p || p.closest('svg')) continue;
        const cs = getComputedStyle(p);
        const mono = /mono|courier|consolas|menlo/i.test(cs.fontFamily);
        for (const run of extractTextRuns(n, mono)) {
          const bs = {
            noWrap: true,
            fontSize: parseFloat(cs.fontSize) * K,
            bold: +cs.fontWeight >= 600,
            italics: cs.fontStyle === 'italic',
            color: rgbToHex(cs.color)
          };
          if (mono && run.ch) {
            run.ch.forEach(([ch, x]) => {
              if (ch.trim()) add({ text: ch, ...bs }, x, run.y);
            });
          } else {
            add({ text: run.t.replace(/\u00a0/g, ' '), ...bs }, run.x, run.y);
          }
        }
      }
    }
  }

  box.remove();
  const filename = songList.length === 1 ? 'chordpro-song.pdf' : 'chordpro-songbook.pdf';
  window.pdfMake.createPdf({ pageSize: { width: W * K, height: H * K }, pageMargins: [0, 0, 0, 0], content }).download(filename);
  showToast('PDF erstellt');
}
