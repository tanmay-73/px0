// web/src/search.js
// The Search view: find across the workspace (/api/search) with Match Case,
// Match Whole Word and Use Regular Expression, a files-to-include glob, and
// Replace / Replace All. Replacing edits each file's model (the one an open
// editor shows, if any) and saves files that had no unsaved changes before.
import { api } from './api.js';
import { h, icon, basename, dirname, debounce, esc, pref, setPref, on } from './util.js';
import { openFile } from './editors.js';
import { openDoc, isDirty, save, release } from './models.js';
import { confirm, notify } from './ui.js';
import { fileIcon } from './icons.js';
import { monaco } from './monaco.js';

const opts = pref('search.opts', { case: false, word: false, re: false, showReplace: false, showInclude: false });
let results = [];
let truncated = false;
let total = 0;
let seq = 0;
const collapsed = new Set();
let els = {};

const saveOpts = () => setPref('search.opts', opts);

function toggle(name, ic, title) {
  const b = h('button.input-toggle' + (opts[name] ? '.on' : ''), { type: 'button', title, 'aria-pressed': String(!!opts[name]) }, icon(ic));
  b.addEventListener('click', () => {
    opts[name] = !opts[name];
    b.classList.toggle('on', opts[name]);
    b.setAttribute('aria-pressed', String(opts[name]));
    saveOpts();
    runSearch();
  });
  return b;
}

export function renderSearch(container) {
  container.classList.add('search-view');
  els.q = h('textarea.search-input', { rows: 1, placeholder: 'Search', spellcheck: false, 'aria-label': 'Search' });
  els.r = h('textarea.search-input', { rows: 1, placeholder: 'Replace', spellcheck: false, 'aria-label': 'Replace' });
  els.include = h('input.search-include', { type: 'text', placeholder: 'e.g. *.go, src/**', spellcheck: false, value: pref('search.include', '') });
  const replaceToggle = h('button.search-replace-toggle', { type: 'button', title: 'Toggle Replace' }, icon(opts.showReplace ? 'chevron-down' : 'chevron-right'));
  els.replaceRow = h('div.search-row.replace-row', { hidden: !opts.showReplace },
    h('div.input-box', els.r),
    h('button.icon-btn', { type: 'button', title: 'Replace All', on: { click: replaceAll } }, icon('replace-all')));
  els.includeBox = h('div.search-include-box', { hidden: !opts.showInclude }, h('label', 'files to include'), els.include);
  els.summary = h('div.search-summary');
  els.list = h('div.search-results', { tabindex: '0' });
  replaceToggle.addEventListener('click', () => {
    opts.showReplace = !opts.showReplace;
    saveOpts();
    els.replaceRow.hidden = !opts.showReplace;
    replaceToggle.replaceChildren(icon(opts.showReplace ? 'chevron-down' : 'chevron-right'));
    if (opts.showReplace) els.r.focus();
    draw();
  });
  container.append(
    h('div.search-form',
      replaceToggle,
      h('div.search-fields',
        h('div.search-row', h('div.input-box', els.q, h('span.input-toggles',
          toggle('case', 'case-sensitive', 'Match Case'),
          toggle('word', 'whole-word', 'Match Whole Word'),
          toggle('re', 'regex', 'Use Regular Expression')))),
        els.replaceRow)),
    h('div.search-details',
      h('button.icon-btn', { type: 'button', title: 'Toggle Search Details', on: { click: () => { opts.showInclude = !opts.showInclude; saveOpts(); els.includeBox.hidden = !opts.showInclude; } } }, icon('ellipsis'))),
    els.includeBox,
    els.summary,
    els.list);
  const grow = el => { el.style.height = 'auto'; el.style.height = Math.min(120, el.scrollHeight) + 'px'; };
  for (const el of [els.q, els.r]) {
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (el === els.r && (e.ctrlKey || e.metaKey)) replaceAll();
        else runSearch();
      }
    });
    el.addEventListener('input', () => grow(el));
  }
  els.q.addEventListener('input', debounce(runSearch, 300));
  els.r.addEventListener('input', debounce(draw, 150));
  els.include.addEventListener('input', debounce(() => { setPref('search.include', els.include.value); runSearch(); }, 300));
}

export function focusSearch({ query, include } = {}) {
  if (!els.q) return;
  if (query !== undefined && query !== '') els.q.value = query;
  if (include !== undefined) { els.include.value = include; opts.showInclude = true; els.includeBox.hidden = false; }
  els.q.focus();
  els.q.select();
  if (query || include !== undefined) runSearch();
}

export async function runSearch() {
  const q = els.q.value;
  const my = ++seq;
  if (!q) {
    results = []; total = 0; truncated = false;
    draw();
    return;
  }
  els.summary.textContent = 'Searching…';
  try {
    const j = await api('api/search', { q, re: opts.re ? 1 : '', case: opts.case ? 1 : '', word: opts.word ? 1 : '', glob: els.include.value.trim() });
    if (my !== seq) return;
    results = j.results || [];
    total = j.total || 0;
    truncated = !!j.truncated;
  } catch (e) {
    if (my !== seq) return;
    results = []; total = 0;
    els.summary.textContent = e.message;
    els.list.replaceChildren();
    return;
  }
  draw();
}

function draw() {
  if (!els.list) return;
  const q = els.q.value;
  if (!q) { els.summary.textContent = ''; els.list.replaceChildren(); return; }
  els.summary.replaceChildren(
    h('span', total ? `${total} result${total === 1 ? '' : 's'} in ${results.length} file${results.length === 1 ? '' : 's'}${truncated ? ' (more not shown)' : ''}` : 'No results found. Review your settings for configured exclusions and check your gitignore files.'),
    total ? h('span.search-summary-actions',
      h('button.icon-btn', { type: 'button', title: 'Collapse All', on: { click: () => { results.forEach(r => collapsed.add(r.path)); draw(); } } }, icon('collapse-all')),
      h('button.icon-btn', { type: 'button', title: 'Clear Search Results', on: { click: () => { els.q.value = ''; runSearch(); } } }, icon('clear-all'))) : null);
  const replacing = opts.showReplace;
  const rep = els.r.value;
  const rows = [];
  for (const f of results) {
    const isCol = collapsed.has(f.path);
    const fileRow = h('div.list-row.search-file',
      icon(isCol ? 'chevron-right' : 'chevron-down', 'search-twistie'),
      fileIcon(f.path),
      h('span.search-file-name', basename(f.path)),
      h('span.search-file-dir', dirname(f.path)),
      h('span.search-actions',
        replacing ? h('button.icon-btn', { type: 'button', title: 'Replace All in File', on: { click: e => { e.stopPropagation(); replaceIn([f]); } } }, icon('replace-all')) : null,
        h('button.icon-btn', { type: 'button', title: 'Dismiss', on: { click: e => { e.stopPropagation(); dismiss(f); } } }, icon('close'))),
      h('span.badge', String(f.matches.length)));
    fileRow.addEventListener('click', () => { if (isCol) collapsed.delete(f.path); else collapsed.add(f.path); draw(); });
    rows.push(fileRow);
    if (isCol) continue;
    for (const m of f.matches) {
      const row = h('div.list-row.search-match', { title: `${m.pre}${m.mid}${m.post}` },
        h('span.search-line', {
          html: esc(m.pre) + (replacing && rep !== '' ? `<del>${esc(m.mid)}</del><ins>${esc(rep)}</ins>` : `<mark>${esc(m.mid)}</mark>`) + esc(m.post),
        }),
        h('span.search-ln', String(m.line)));
      row.addEventListener('click', () => openMatch(f.path, m, true));
      row.addEventListener('dblclick', () => openMatch(f.path, m, false));
      rows.push(row);
    }
  }
  els.list.replaceChildren(...rows);
}

function dismiss(f) {
  results = results.filter(x => x !== f);
  total -= f.matches.length;
  draw();
}

async function openMatch(path, m, preview) {
  const t = await openFile(path, { preview, line: m.line, col: 1 });
  const model = t?.doc?.model;
  if (!model || m.line > model.getLineCount()) return;
  const text = model.getLineContent(m.line);
  const re = matcher();
  let col = 1, len = m.mid.length;
  if (re) {
    re.lastIndex = 0;
    const hit = re.exec(text);
    if (hit) { col = hit.index + 1; len = hit[0].length; }
  } else {
    const i = text.indexOf(m.mid);
    if (i >= 0) col = i + 1;
  }
  const ed = monaco.editor.getEditors().find(e => e.getModel() === model && e.hasWidgetFocus?.()) || monaco.editor.getEditors().find(e => e.getModel() === model);
  ed?.setSelection(new monaco.Range(m.line, col, m.line, col + len));
  ed?.revealRangeInCenterIfOutsideViewport(new monaco.Range(m.line, col, m.line, col + len));
}

// The query as a JS RegExp, the same way the server matches it.
function matcher() {
  const q = els.q.value;
  if (!q) return null;
  let src = opts.re ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (opts.word) src = `\\b(?:${src})\\b`;
  try { return new RegExp(src, 'gm' + (opts.case ? '' : 'i')); } catch { return null; }
}

async function replaceAll() {
  if (!results.length) return;
  const n = total, files = results.length;
  const c = await confirm({
    message: `Replace ${n} occurrence${n === 1 ? '' : 's'} across ${files} file${files === 1 ? '' : 's'} with '${els.r.value}'?`,
    buttons: ['Replace'], severity: 'warning',
  });
  if (c !== 0) return;
  await replaceIn([...results]);
}

async function replaceIn(files) {
  const re = matcher();
  if (!re) { notify('The search pattern is not a valid regular expression.', { severity: 'error' }); return; }
  const rep = els.r.value;
  let count = 0, changed = 0;
  for (const f of files) {
    try {
      const d = await openDoc(f.path);
      if (d.readonly) continue;
      const wasDirty = isDirty(d);
      const text = d.model.getValue();
      let n = 0;
      const next = text.replace(re, (...args) => {
        n++;
        // $1, $& work as in VS Code with a regex; a literal query is literal.
        return opts.re ? args[0].replace(new RegExp(re.source, re.flags.replace('g', '')), rep) : rep;
      });
      if (!n) continue;
      d.model.pushEditOperations([], [{ range: d.model.getFullModelRange(), text: next }], () => null);
      d.model.pushStackElement();
      count += n;
      changed++;
      if (!wasDirty) await save(d);
      if (d.refs === 0) release(d); // opened only to replace in it
    } catch (e) {
      notify(`Could not replace in ${f.path}: ${e.message}`, { severity: 'error' });
    }
  }
  notify(`Replaced ${count} occurrence${count === 1 ? '' : 's'} across ${changed} file${changed === 1 ? '' : 's'}.`);
  runSearch();
}

export function initSearch() {
  on('doc:saved', debounce(() => { if (els.q?.value) runSearch(); }, 800));
}
