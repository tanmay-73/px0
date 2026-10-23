// web/src/util.js
// Small helpers shared by every module: DOM building, escaping, key labels,
// paths and a tiny event bus. No dependencies.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/* h('div.cls#id', { attrs, on: { click } }, ...children) builds an element.
   Children may be strings, nodes, arrays, or null/false (skipped). */
export function h(tag, props, ...children) {
  const m = /^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i.exec(tag) || [];
  const el = document.createElement(m[1] || 'div');
  for (const part of (m[2] || '').match(/[.#][\w-]+/g) || []) {
    if (part[0] === '.') el.classList.add(part.slice(1));
    else el.id = part.slice(1);
  }
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
    props = null;
  }
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === 'class') el.className += (el.className ? ' ' : '') + v;
    else if (k === 'style' && typeof v === 'object') {
      // Custom properties (--indent) need setProperty; assigning them is ignored.
      for (const [name, val] of Object.entries(v)) {
        if (name.startsWith('--')) el.style.setProperty(name, val);
        else el.style[name] = val;
      }
    }
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : String(c));
  }
}

// A codicon (https://microsoft.github.io/vscode-codicons/), the VS Code icon font.
// "sync~spin" spins the icon, as in VS Code's label syntax.
export const icon = (name, cls = '') => {
  const [id, mod] = name.split('~');
  return h('span', { class: `codicon codicon-${id}${mod ? ' codicon-modifier-' + mod : ''}${cls ? ' ' + cls : ''}`, 'aria-hidden': 'true' });
};

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function debounce(fn, ms) {
  let t = 0;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.cancel = () => clearTimeout(t);
  return d;
}

export const basename = p => p.slice(p.lastIndexOf('/') + 1);
export const dirname = p => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
export const extname = p => { const b = basename(p); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i + 1).toLowerCase() : ''; };

// "Mod+Shift+P" -> "Ctrl+Shift+P", or "⌘⇧P" on a Mac.
export function keyLabel(combo) {
  return combo.split(' ').map(chord => {
    const parts = chord.split('+');
    if (isMac) {
      const map = { Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Enter: '↩', Escape: 'Esc', Backspace: '⌫', Delete: '⌦' };
      return parts.map(p => map[p] || p).join('');
    }
    return parts.map(p => (p === 'Mod' ? 'Ctrl' : p)).join('+');
  }).join(' ');
}

export function relTime(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return Math.floor(s / 60) + ' min';
  if (s < 86400) return Math.floor(s / 3600) + ' hr';
  if (s < 86400 * 30) return Math.floor(s / 86400) + ' days';
  if (s < 86400 * 365) return Math.floor(s / 86400 / 30) + ' mo';
  return Math.floor(s / 86400 / 365) + ' yr';
}

export function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

/* ---------- event bus ---------- */

const listeners = new Map();

export function on(name, fn) {
  if (!listeners.has(name)) listeners.set(name, new Set());
  listeners.get(name).add(fn);
  return () => listeners.get(name)?.delete(fn);
}

export function emit(name, payload) {
  for (const fn of listeners.get(name) || []) {
    try { fn(payload); } catch (e) { console.error(name, e); }
  }
}

/* ---------- local preferences ---------- */

export function pref(key, fallback) {
  try {
    const v = localStorage.getItem('px0.' + key);
    return v === null ? fallback : JSON.parse(v);
  } catch { return fallback; }
}

export function setPref(key, value) {
  try { localStorage.setItem('px0.' + key, JSON.stringify(value)); } catch {}
}
