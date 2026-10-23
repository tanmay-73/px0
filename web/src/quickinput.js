// web/src/quickinput.js
// VS Code's quick input: the box at the top of the window behind Quick Open,
// the Command Palette and every picker. quickPick() lists items for a query;
// inputBox() asks for one line of text.
import { h, icon, esc, debounce } from './util.js';
import { keycaps } from './ui.js';

let active = null; // { el, close }

export const isQuickOpen = () => !!active;

export function closeQuick() {
  active?.close(null);
}

/* Highlights the characters of label at the given indexes. */
export function highlight(label, pos) {
  if (!pos || !pos.length) return esc(label);
  const set = new Set(pos);
  let out = '', open = false;
  for (let i = 0; i < label.length; i++) {
    const hit = set.has(i);
    if (hit && !open) { out += '<b>'; open = true; }
    if (!hit && open) { out += '</b>'; open = false; }
    out += esc(label[i]);
  }
  return out + (open ? '</b>' : '');
}

/* Fuzzy subsequence match of q in s, case-insensitive: the matched indexes, or
   null. Contiguous and word-start hits come first through score. */
export function fuzzy(q, s) {
  if (!q) return { pos: [], score: 0 };
  const lq = q.toLowerCase(), ls = s.toLowerCase();
  const sub = ls.indexOf(lq);
  if (sub >= 0) return { pos: [...Array(lq.length).keys()].map(i => i + sub), score: 1000 - sub - (sub && /\w/.test(ls[sub - 1]) ? 50 : 0) };
  const pos = [];
  let j = 0, score = 0, prev = -2;
  for (let i = 0; i < ls.length && j < lq.length; i++) {
    if (ls[i] === lq[j]) {
      pos.push(i);
      score += prev === i - 1 ? 5 : (i === 0 || /[\s/_\-.:]/.test(ls[i - 1]) ? 3 : 1);
      prev = i;
      j++;
    }
  }
  return j === lq.length ? { pos, score } : null;
}

/* quickPick(opts) opens the box.
   opts.items: an array, or async (query) => array, of
     { label, labelHTML, description, detail, icon, keys, separator, ...any }
   opts.value / placeholder / title
   opts.onAccept(item, { newTab, query }) -> keep open when it returns false
   opts.onActive(item)          preview the highlighted item
   opts.onQuery(query)          return false to let the caller take the query (prefix modes)
   opts.filter                  true to fuzzy-filter a static list (default)
   opts.footer                  hint text under the list
   Resolves with the accepted item or null. */
export function quickPick(opts) {
  closeQuick();
  return new Promise(resolve => {
    let items = [];
    let sel = 0;
    let seq = 0;
    const input = h('input.qi-input', { type: 'text', spellcheck: false, autocomplete: 'off', placeholder: opts.placeholder || '', 'aria-label': opts.placeholder || 'Quick input' });
    const list = h('div.qi-list', { role: 'listbox' });
    const footer = h('div.qi-footer');
    const title = h('div.qi-title');
    const el = h('div.quick-input', { role: 'dialog' }, title, h('div.qi-box', input), list, footer);
    const backdrop = h('div.qi-backdrop');
    document.body.append(backdrop, el);
    input.value = opts.value || '';

    const setTitle = t => { title.textContent = t || ''; title.hidden = !t; };
    const setFooter = t => { footer.textContent = t || ''; footer.hidden = !t; };
    setTitle(opts.title);
    setFooter(opts.footer);

    const draw = () => {
      list.replaceChildren();
      if (!items.length) {
        list.append(h('div.qi-empty', opts.emptyText?.(input.value) || 'No matching results'));
        return;
      }
      // As in VS Code, a separator is not a row of its own: its label sits at
      // the right of the first item of its group, which gets a top border.
      let sepLabel = null, first = true;
      items.forEach((it, i) => {
        if (it.separator) { sepLabel = it.label || ''; return; }
        const row = h('div.qi-item' + (i === sel ? '.selected' : '') + (sepLabel !== null && !first ? '.qi-group-start' : '') + (it.disabled ? '.disabled' : ''), { role: 'option', 'aria-selected': String(i === sel), dataset: { i } },
          h('div.qi-entry',
            it.icon ? (typeof it.icon === 'string' ? icon(it.icon, 'qi-icon') : it.icon) : null,
            h('span.qi-label', { html: it.labelHTML || esc(it.label) }),
            it.description || it.descriptionHTML ? h('span.qi-desc', { html: it.descriptionHTML || esc(it.description) }) : null,
            h('span.qi-grow'),
            sepLabel ? h('span.qi-sep-label', sepLabel) : null,
            it.badge ? h('span.qi-badge', it.badge) : null,
            it.keys ? keycaps(it.keys, 'qi-keys') : null),
          it.detail ? h('div.qi-detail', it.detail) : null);
        sepLabel = null;
        first = false;
        list.append(row);
      });
      list.querySelector('.qi-item.selected')?.scrollIntoView({ block: 'nearest' });
    };
    const selectable = i => items[i] && !items[i].separator;
    const move = d => {
      if (!items.some((_, i) => selectable(i))) return;
      let i = sel;
      do { i = (i + d + items.length) % items.length; } while (!selectable(i));
      sel = i;
      draw();
      opts.onActive?.(items[sel]);
    };
    const refresh = async () => {
      const my = ++seq;
      const q = input.value;
      if (opts.onQuery && opts.onQuery(q) === false) return;
      let next;
      if (typeof opts.items === 'function') {
        try { next = await opts.items(q); } catch (e) { next = [{ label: e.message, disabled: true }]; }
        if (my !== seq || active?.el !== el) return;
      } else if (opts.filter !== false) {
        next = [];
        for (const it of opts.items) {
          if (it.separator) { if (!q) next.push(it); continue; }
          const m = fuzzy(q, it.label);
          const md = !m && it.description ? fuzzy(q, it.description) : null;
          if (m || md) next.push({ ...it, labelHTML: m ? highlight(it.label, m.pos) : esc(it.label), _score: m ? m.score : (md.score / 2) });
        }
        if (q) next.sort((a, b) => b._score - a._score);
      } else next = opts.items;
      items = next;
      sel = Math.max(0, items.findIndex((it, i) => selectable(i) && it.picked));
      if (!selectable(sel)) sel = items.findIndex((_, i) => selectable(i));
      if (sel < 0) sel = 0;
      draw();
      if (items[sel]) opts.onActive?.(items[sel]);
    };
    const refreshSoon = debounce(refresh, typeof opts.items === 'function' ? 40 : 0);
    const accept = async (newTab = false) => {
      const it = items[sel];
      if (!it || it.separator || it.disabled) {
        if (opts.acceptEmpty) { const r = await opts.acceptEmpty(input.value); if (r !== false) close(null); }
        return;
      }
      const r = await opts.onAccept?.(it, { newTab, query: input.value });
      if (r === false) return;
      close(it, true);
    };
    const close = (result, accepted = false) => {
      if (active?.el !== el) return;
      active = null;
      el.remove();
      backdrop.remove();
      if (!accepted) opts.onCancel?.();
      resolve(result);
      if (!accepted || opts.restoreFocus) prevFocus?.focus?.();
    };
    const prevFocus = document.activeElement;
    active = { el, close, input, refresh, setTitle, setFooter };

    input.addEventListener('input', refreshSoon);
    input.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) { e.preventDefault(); move(-1); }
      else if (e.key === 'PageDown') { e.preventDefault(); for (let i = 0; i < 10; i++) move(1); }
      else if (e.key === 'PageUp') { e.preventDefault(); for (let i = 0; i < 10; i++) move(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); accept(e.metaKey || e.ctrlKey); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); }
      else if (e.key === 'Tab') { e.preventDefault(); move(e.shiftKey ? -1 : 1); }
    });
    list.addEventListener('mousedown', e => e.preventDefault());
    list.addEventListener('click', e => {
      const row = e.target.closest('.qi-item');
      if (!row) return;
      sel = +row.dataset.i;
      accept(e.metaKey || e.ctrlKey);
    });
    backdrop.addEventListener('mousedown', () => close(null));
    input.focus();
    if (opts.selectValue) input.select();
    refresh();
  });
}

// Re-runs the open picker's query (after its items changed).
export function refreshQuick() {
  active?.refresh();
}

export function quickInputElement() {
  return active?.input || null;
}

/* inputBox({ prompt, value, placeholder, validate, selection: [start, end] })
   resolves to the entered text, or null when dismissed. validate returns an
   error message or ''. */
export function inputBox(opts) {
  closeQuick();
  return new Promise(resolve => {
    const input = h('input.qi-input', { type: 'text', spellcheck: false, autocomplete: 'off', placeholder: opts.placeholder || '' });
    const msg = h('div.qi-message', opts.prompt || '');
    const el = h('div.quick-input', { role: 'dialog' }, h('div.qi-box', input), msg);
    const backdrop = h('div.qi-backdrop');
    document.body.append(backdrop, el);
    input.value = opts.value || '';
    const prevFocus = document.activeElement;
    const close = v => {
      if (active?.el !== el) return;
      active = null;
      el.remove();
      backdrop.remove();
      prevFocus?.focus?.();
      resolve(v);
    };
    active = { el, close: () => close(null), input };
    const check = () => {
      const err = opts.validate?.(input.value) || '';
      msg.textContent = err || opts.prompt || '';
      msg.classList.toggle('error', !!err);
      el.classList.toggle('invalid', !!err);
      return !err;
    };
    input.addEventListener('input', check);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); if (check()) close(input.value); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); }
    });
    backdrop.addEventListener('mousedown', () => close(null));
    input.focus();
    if (opts.selection) input.setSelectionRange(...opts.selection);
    else input.select();
    check();
  });
}
