// Utility functions, sanitization, and UI helpers

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}

export function uid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

export function slug(text) {
  return String(text || 'song')
    .replace(/[\\/:*?"<>|]+/g, '')
    .trim()
    .slice(0, 60) || 'song';
}

export function debounce(fn, ms = 120) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}

export function throttleTrailing(fn, ms = 40) {
  let last = 0;
  let timer = null;
  let pendingArgs = null;
  return function (...args) {
    const now = performance.now();
    const rem = ms - (now - last);
    if (rem <= 0) {
      clearTimeout(timer);
      timer = null;
      pendingArgs = null;
      last = now;
      fn.apply(this, args);
    } else {
      pendingArgs = args;
      if (!timer) {
        timer = setTimeout(() => {
          last = performance.now();
          timer = null;
          const a = pendingArgs;
          pendingArgs = null;
          if (a) fn.apply(this, a);
        }, rem);
      }
    }
  };
}

// Safe CSS validation to prevent style/HTML injection from untrusted .cho files
export function safeColor(val) {
  if (!val) return '';
  const v = String(val).trim();
  if (/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)) return v;
  if (/^(rgb|hsl)a?\(\s*[\d.\s,%\/]+\)$/i.test(v)) return v;
  if (/^[a-z]{3,20}$/i.test(v)) return v;
  return '';
}

export function safeImageUrl(val) {
  if (!val) return '';
  const v = String(val).trim();
  if (/^(https?:\/\/|data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,|\.?\/)/i.test(v)) {
    return v.replace(/["'<>]/g, '');
  }
  // Allow simple relative filename like "logo.png"
  if (/^[a-z0-9._\-\/]+\.(png|jpe?g|gif|webp|svg)$/i.test(v)) {
    return v;
  }
  return '';
}

export function safeFontFamily(name) {
  if (!name) return '';
  const n = String(name).trim();
  if (/times|serif/i.test(n) && !/sans/i.test(n)) return "'Times New Roman', Georgia, serif";
  if (/courier|mono|consolas|menlo/i.test(n)) return "'Courier New', ui-monospace, monospace";
  if (/helvetica|arial|sans/i.test(n)) return "Arial, Helvetica, sans-serif";
  const clean = n.replace(/[^a-zA-Z0-9\s\-]/g, '').trim();
  return clean ? `'${clean}', sans-serif` : '';
}

export function rgbToHex(colorStr) {
  const m = String(colorStr || '').match(/[\d.]+/g);
  if (!m || m.length < 3) return '#000000';
  return '#' + m.slice(0, 3).map(x => Math.max(0, Math.min(255, Math.round(+x))).toString(16).padStart(2, '0')).join('');
}

export function downloadText(filename, content, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function parseDurationSec(str) {
  if (!str) return 0;
  const s = String(str).trim();
  const mmss = /^(\d+):(\d{1,2})$/.exec(s);
  if (mmss) return (+mmss[1]) * 60 + (+mmss[2]);
  const num = parseFloat(s);
  if (!isNaN(num)) return num > 20 ? Math.round(num) : Math.round(num * 60);
  return 0;
}

export function formatDuration(totalSec) {
  if (!totalSec || totalSec <= 0) return '';
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function lsGet(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function lsSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (err) {
    console.warn('localStorage write failed for', key, err);
    return false;
  }
}

let toastTimer = null;
export function showToast(message, duration = 2200) {
  let el = document.getElementById('app-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'app-toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}

export const isMobileDevice = () =>
  /Android|iPhone|iPad/i.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
