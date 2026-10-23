// web/src/explorer.js
// The Explorer view: OPEN EDITORS, the workspace folder's file tree, OUTLINE.
// The tree is virtualised (only the rows in view exist in the DOM), so folders
// with thousands of entries stay fast. Folders load lazily from /api/tree;
// git status colours names and adds VS Code's letter badges; new file / new
// folder / rename happen in an inline box in the tree, as in VS Code.
import { api, post, S, inWorkbench } from './api.js';
import { h, icon, basename, dirname, on, emit, pref, setPref, debounce } from './util.js';
import { showMenu, confirm, notify, pane } from './ui.js';
import { run } from './commands.js';
import { openFile, allTabs, closeTab, isTabDirty, activeTab, groupOf } from './editors.js';
import { G, decoration } from './git.js';
import { fileIcon } from './icons.js';
import { compareSelection } from './compare.js';
import { setting } from './settings.js';
import { initOutline } from './outline.js';

const ROW = 22;
const children = new Map(); // dir ('' = root) -> [node] once loaded
const expanded = new Set(pref('explorer.expanded:' + (location.pathname), []));
let rows = [];           // flattened visible rows
let selected = '';       // path of the selected row
let editing = null;      // { parent, depth, value, kind: 'file'|'folder'|'rename', path }
let scroller, inner, treePane;

const saveExpanded = debounce(() => setPref('explorer.expanded:' + location.pathname, [...expanded]), 300);

/* ---------- data ---------- */

async function loadDir(dir) {
  try {
    const j = await api('api/tree', { dir });
    const kids = (j.children || []).slice().sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) : a.dir ? -1 : 1));
    children.set(dir, kids);
    return kids;
  } catch {
    children.set(dir, []);
    return [];
  }
}

// Re-reads every loaded folder, keeping what is expanded.
export async function refreshTree() {
  const dirs = [...children.keys()];
  await Promise.all(dirs.map(d => (d === '' || expanded.has(d) ? loadDir(d) : (children.delete(d), null))));
  flatten();
}

const refreshSoon = debounce(refreshTree, 150);

function flatten() {
  const out = [];
  const walk = (dir, depth) => {
    const kids = children.get(dir);
    if (!kids) return;
    if (editing && editing.kind !== 'rename' && editing.parent === dir) out.push({ input: true, depth, dir });
    for (const n of kids) {
      if (editing?.kind === 'rename' && editing.path === n.path) { out.push({ input: true, depth, dir, node: n }); continue; }
      out.push({ node: n, depth });
      if (n.dir && expanded.has(n.path)) walk(n.path, depth + 1);
    }
  };
  walk('', 0);
  rows = out;
  draw();
}

/* ---------- rendering ---------- */

function draw() {
  if (!scroller) return;
  inner.style.height = rows.length * ROW + 'px';
  const top = scroller.scrollTop;
  const hgt = scroller.clientHeight || 600;
  const first = Math.max(0, Math.floor(top / ROW) - 5);
  const last = Math.min(rows.length, Math.ceil((top + hgt) / ROW) + 5);
  // Rows whose content is unchanged keep their element, so a redraw (from a
  // git event, say) between mouse down and up cannot swallow a click.
  const old = new Map();
  for (const el of inner.children) if (el._sig) old.set(el._sig, el);
  const els = [];
  for (let i = first; i < last; i++) {
    const r = rows[i];
    const sig = r.input ? '' : rowSig(r, i);
    let el = sig && old.get(sig);
    if (!el) { el = rowEl(r, i); el._sig = sig; }
    els.push(el);
  }
  inner.replaceChildren(...els);
  const inp = inner.querySelector('input.tree-input');
  if (inp && document.activeElement !== inp) {
    inp.focus();
    inp.setSelectionRange(editing.selStart ?? inp.value.length, editing.selEnd ?? inp.value.length);
    if (!editing.caretPlaced) { editing.caretPlaced = true; placeCaret(inp); }
  }
}

function rowSig(r, i) {
  const n = r.node;
  const dec = n.dir ? '' : decoration(n.path)?.cls || '';
  return [i, r.depth, n.path, n.name, n.path === selected, n.dir && expanded.has(n.path), n.dir && G.dirtyDirs.has(n.path), dec, n.ignored, n.repo].join('|');
}

function placeCaret(inp) {
  if (editing?.kind === 'rename') {
    const dot = inp.value.lastIndexOf('.');
    inp.setSelectionRange(0, dot > 0 && !editing.isDir ? dot : inp.value.length);
  }
}

// VS Code's tree: 8px of indent per level, a guide line per level.
const INDENT = 8;

function indentGuides(depth) {
  return depth ? h('span.indent', [...Array(depth)].map(() => h('span.indent-guide'))) : null;
}

function rowEl(r, i) {
  const pad = r.depth * INDENT;
  if (r.input) {
    const isDir = r.node ? r.node.dir : editing.kind === 'folder';
    const inp = h('input.tree-input', { type: 'text', spellcheck: false, value: editing.value || '' });
    inp.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finishEdit(inp.value); }
      else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
    });
    // The tree re-renders while scrolling or resizing, which replaces this
    // input with a fresh one: keep its text and caret, and ignore the blur.
    const keep = () => { if (editing) { editing.value = inp.value; editing.selStart = inp.selectionStart; editing.selEnd = inp.selectionEnd; } };
    inp.addEventListener('input', keep);
    inp.addEventListener('keyup', keep);
    inp.addEventListener('click', keep);
    inp.addEventListener('blur', () => setTimeout(() => {
      if (editing && inp.isConnected && document.activeElement !== inp) finishEdit(inp.value);
    }, 0));
    return h('div.tree-row.editing', { style: { top: i * ROW + 'px', '--indent': pad + 'px' } },
      indentGuides(r.depth), isDir ? h('span.twistie', icon('chevron-right')) : fileIcon(editing.value || 'file'), inp);
  }
  const n = r.node;
  const dec = n.dir ? null : decoration(n.path);
  const dirty = n.dir && G.dirtyDirs.has(n.path);
  const open = n.dir && expanded.has(n.path);
  // Folders show no icon, as with VS Code's Seti file icons.
  const el = h('div.tree-row' + (n.path === selected ? '.selected' : '') + (n.ignored ? '.ignored' : '') + (n.dir ? '.dir' : '.file'),
    { style: { top: i * ROW + 'px', '--indent': pad + 'px' }, dataset: { path: n.path }, draggable: 'true', title: n.path + (dec ? ' • ' + dec.title : '') },
    indentGuides(r.depth),
    n.dir ? h('span.twistie', icon(open ? 'chevron-down' : 'chevron-right')) : fileIcon(n.name),
    h('span.tree-label' + (dec ? '.' + dec.cls : dirty ? '.git-dir-dirty' : ''), n.name),
    n.repo ? h('span.tree-tag', { title: 'Git repository of its own' }, 'git') : null,
    dec ? h('span.tree-badge.' + dec.cls, dec.letter) : dirty ? h('span.tree-dot', icon('circle-filled')) : null);
  return el;
}

/* ---------- actions ---------- */

async function toggleDir(path, force) {
  const open = force ?? !expanded.has(path);
  if (open) {
    expanded.add(path);
    if (!children.has(path)) await loadDir(path);
  } else expanded.delete(path);
  saveExpanded();
  flatten();
}

function select(path, scroll = false) {
  selected = path;
  if (scroll) {
    const i = rows.findIndex(r => r.node?.path === path);
    if (i >= 0) {
      const top = i * ROW;
      if (top < scroller.scrollTop || top + ROW > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = top - scroller.clientHeight / 3;
    }
  }
  draw();
}

/* reveal(path) expands every folder above path and selects it. */
export async function reveal(path, { focus = false } = {}) {
  if (!path || path.startsWith('/')) return;
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) {
    const d = parts.slice(0, i).join('/');
    expanded.add(d);
    if (!children.has(d)) await loadDir(d);
  }
  saveExpanded();
  flatten();
  select(path, true);
  if (focus) scroller.focus();
}

function startEdit(kind, parent, path) {
  if (kind !== 'rename' && parent) {
    expanded.add(parent);
    if (!children.has(parent)) return loadDir(parent).then(() => startEdit(kind, parent, path));
  }
  editing = { kind, parent: parent || '', path, value: kind === 'rename' ? basename(path) : '', isDir: kind === 'rename' && children.get(dirname(path))?.find(n => n.path === path)?.dir };
  treePane.expand();
  flatten();
  const i = rows.findIndex(r => r.input);
  if (i >= 0) scroller.scrollTop = Math.max(0, i * ROW - scroller.clientHeight / 3);
  draw();
}

function cancelEdit() {
  editing = null;
  flatten();
  scroller.focus();
}

async function finishEdit(value) {
  const e = editing;
  if (!e) return;
  editing = null;
  const name = value.trim();
  if (!name || (e.kind === 'rename' && name === basename(e.path))) { flatten(); return; }
  if (/(^|\/)\.\.?(\/|$)/.test(name) || name.startsWith('/')) {
    notify(`The name ${name} is not valid as a file or folder name.`, { severity: 'error' });
    flatten();
    return;
  }
  try {
    if (e.kind === 'rename') {
      const to = (dirname(e.path) ? dirname(e.path) + '/' : '') + name;
      await post('api/fs/rename', { from: e.path, to });
      emit('fs:renamed', { from: e.path, to });
      await refreshTree();
      select(to, true);
    } else {
      const path = (e.parent ? e.parent + '/' : '') + name;
      await post('api/fs/new', { path, type: e.kind === 'folder' ? 'dir' : 'file' });
      await refreshTree();
      if (e.kind === 'file') { await reveal(path); openFile(path); }
      else select(path, true);
    }
    emit('fs:changed');
  } catch (err) {
    notify(err.message, { severity: 'error' });
    flatten();
  }
}

export async function deletePath(path) {
  const node = findNode(path);
  const isDir = node?.dir;
  const choice = await confirm({
    message: `Are you sure you want to delete '${basename(path)}'${isDir ? ' and its contents' : ''}?`,
    detail: 'This cannot be undone.',
    buttons: ['Delete'],
  });
  if (choice !== 0) return;
  try {
    await post('api/fs/delete', { path });
    for (const t of allTabs()) {
      if (t.path === path || t.path?.startsWith(path + '/')) {
        if (!isTabDirty(t)) closeTab(t, groupOf(t), { force: true });
      }
    }
    await refreshTree();
    emit('fs:changed');
  } catch (e) {
    notify(e.message, { severity: 'error' });
  }
}

function findNode(path) {
  return children.get(dirname(path))?.find(n => n.path === path) || null;
}

// The folder new items go in: the selected folder, or the selected file's.
function targetDir() {
  const n = findNode(selected);
  if (!n) return '';
  return n.dir ? n.path : dirname(n.path);
}

export const newFile = (dir = targetDir()) => startEdit('file', dir);
export const newFolder = (dir = targetDir()) => startEdit('folder', dir);
export const renamePath = (path = selected) => { if (path) startEdit('rename', dirname(path), path); };

export function collapseAll() {
  expanded.clear();
  saveExpanded();
  flatten();
}

const absPath = p => (S.meta?.root || '').replace(/\/$/, '') + '/' + p;

function rowMenu(n, x, y) {
  const isMd = !n.dir && /\.(md|markdown)$/i.test(n.name);
  const changed = !n.dir && G.byPath.has(n.path);
  const sel = compareSelection();
  const dir = n.dir ? n.path : dirname(n.path);
  showMenu([
    n.repo && inWorkbench() && { label: 'Open Repository', run: () => run('px0.openRepository', absPath(n.path), false) },
    n.repo && inWorkbench() && { label: 'Open Repository in New Tab', run: () => run('px0.openRepository', absPath(n.path), true) },
    n.repo && inWorkbench() && { separator: true },
    { label: 'New File...', run: () => newFile(dir) },
    { label: 'New Folder...', run: () => newFolder(dir) },
    { separator: true },
    !n.dir && { label: 'Open to the Side', run: () => openFile(n.path, { sideBySide: true }) },
    isMd && { label: 'Open Preview', run: () => run('markdown.showPreview', n.path) },
    changed && { label: 'Open Changes', run: () => run('git.openChange', n.path) },
    !n.dir && { separator: true },
    !n.dir && { label: 'Select for Compare', run: () => run('selectForCompare', n.path) },
    !n.dir && sel && sel !== n.path && { label: `Compare with '${basename(sel)}'`, run: () => run('compareSelected', n.path) },
    { separator: true },
    { label: 'Copy Path', run: () => run('copyFilePath', n.path) },
    { label: 'Copy Relative Path', run: () => run('copyRelativeFilePath', n.path) },
    { separator: true },
    { label: 'Open in Integrated Terminal', run: () => run('workbench.action.terminal.newWithCwd', dir) },
    { separator: true },
    n.dir && { label: 'Find in Folder...', run: () => run('workbench.action.findInFiles', { include: n.path + '/**' }) },
    { label: 'Rename...', keys: 'F2', run: () => renamePath(n.path) },
    { label: 'Delete', keys: 'Delete', run: () => deletePath(n.path) },
  ], x, y);
}

/* ---------- view ---------- */

function keyNav(e) {
  if (editing) return;
  const i = rows.findIndex(r => r.node?.path === selected);
  const r = rows[i];
  const go = j => { const t = rows[Math.max(0, Math.min(rows.length - 1, j))]; if (t?.node) select(t.node.path, true); };
  switch (e.key) {
    case 'ArrowDown': e.preventDefault(); go(i + 1); break;
    case 'ArrowUp': e.preventDefault(); go(i < 0 ? 0 : i - 1); break;
    case 'Home': e.preventDefault(); go(0); break;
    case 'End': e.preventDefault(); go(rows.length - 1); break;
    case 'PageDown': e.preventDefault(); go(i + Math.floor(scroller.clientHeight / ROW)); break;
    case 'PageUp': e.preventDefault(); go(i - Math.floor(scroller.clientHeight / ROW)); break;
    case 'ArrowRight':
      e.preventDefault();
      if (r?.node.dir) { if (!expanded.has(r.node.path)) toggleDir(r.node.path, true); else go(i + 1); }
      break;
    case 'ArrowLeft':
      e.preventDefault();
      if (r?.node.dir && expanded.has(r.node.path)) toggleDir(r.node.path, false);
      else if (r) { const p = dirname(r.node.path); if (p) select(p, true); }
      break;
    case 'Enter':
      e.preventDefault();
      if (r?.node.dir) toggleDir(r.node.path);
      else if (r) openFile(r.node.path);
      break;
    case ' ':
      e.preventDefault();
      if (r && !r.node.dir) openFile(r.node.path, { preview: true, focus: false });
      break;
    case 'F2': e.preventDefault(); if (r) renamePath(r.node.path); break;
    case 'Delete': e.preventDefault(); if (r) deletePath(r.node.path); break;
    default: return;
  }
}

function renderTreePane(body) {
  scroller = h('div.tree', { tabindex: '0', role: 'tree' });
  inner = h('div.tree-inner');
  scroller.append(inner);
  body.append(scroller);
  scroller.addEventListener('scroll', () => requestAnimationFrame(draw));
  new ResizeObserver(() => draw()).observe(scroller);
  scroller.addEventListener('keydown', keyNav);
  scroller.addEventListener('click', e => {
    const row = e.target.closest('.tree-row[data-path]');
    if (!row) return;
    const n = rows.find(r => r.node?.path === row.dataset.path)?.node;
    if (!n) return;
    select(n.path);
    if (n.dir) toggleDir(n.path);
    else openFile(n.path, { preview: !(e.ctrlKey || e.metaKey), sideBySide: e.altKey });
  });
  scroller.addEventListener('dblclick', e => {
    const row = e.target.closest('.tree-row.file[data-path]');
    if (row) openFile(row.dataset.path, { preview: false });
  });
  scroller.addEventListener('contextmenu', e => {
    const row = e.target.closest('.tree-row[data-path]');
    e.preventDefault();
    if (!row) {
      showMenu([
        { label: 'New File...', run: () => newFile('') },
        { label: 'New Folder...', run: () => newFolder('') },
        { separator: true },
        { label: 'Refresh Explorer', run: refreshTree },
        { label: 'Collapse Folders in Explorer', run: collapseAll },
      ], e.clientX, e.clientY);
      return;
    }
    const n = rows.find(r => r.node?.path === row.dataset.path)?.node;
    if (n) { select(n.path); rowMenu(n, e.clientX, e.clientY); }
  });
  // Drag a row onto a folder (or the empty space, for the root) to move it.
  let dragPath = '';
  scroller.addEventListener('dragstart', e => {
    const row = e.target.closest('.tree-row[data-path]');
    if (!row) return;
    dragPath = row.dataset.path;
    e.dataTransfer.setData('text/plain', dragPath);
    e.dataTransfer.effectAllowed = 'move';
  });
  scroller.addEventListener('dragover', e => {
    if (!dragPath) return;
    e.preventDefault();
    for (const x of inner.querySelectorAll('.drop-target')) x.classList.remove('drop-target');
    e.target.closest('.tree-row.dir')?.classList.add('drop-target');
  });
  scroller.addEventListener('dragend', () => { dragPath = ''; for (const x of inner.querySelectorAll('.drop-target')) x.classList.remove('drop-target'); });
  scroller.addEventListener('drop', async e => {
    e.preventDefault();
    const from = dragPath;
    dragPath = '';
    if (!from) return;
    const row = e.target.closest('.tree-row[data-path]');
    const n = row && rows.find(r => r.node?.path === row.dataset.path)?.node;
    const dir = n ? (n.dir ? n.path : dirname(n.path)) : '';
    const to = (dir ? dir + '/' : '') + basename(from);
    if (to === from || to.startsWith(from + '/')) return;
    const ok = await confirm({ message: `Are you sure you want to move '${basename(from)}' into '${dir || basename(S.meta.root)}'?`, buttons: ['Move'], severity: 'info' });
    if (ok !== 0) return;
    try {
      await post('api/fs/rename', { from, to });
      emit('fs:renamed', { from, to });
      await refreshTree();
      select(to, true);
      emit('fs:changed');
    } catch (err) { notify(err.message, { severity: 'error' }); }
  });
}

/* ---------- open editors ---------- */

function renderOpenEditors(p) {
  const draw = () => {
    const tabs = allTabs();
    p.setBadge(tabs.filter(isTabDirty).length);
    p.body.replaceChildren(...tabs.map(t => {
      const dirty = isTabDirty(t);
      const row = h('div.list-row.oe-row' + (t === activeTab() ? '.selected' : '') + (dirty ? '.dirty' : ''),
        h('span.oe-close', { title: 'Close Editor', on: { click: e => { e.stopPropagation(); closeTab(t); } } }, icon(dirty ? 'circle-filled' : 'close')),
        t.kind === 'diff' ? icon('diff', 'file-icon') : fileIcon(t.path || ''),
        h('span.row-name', t.title || basename(t.path || '')),
        h('span.row-desc', t.kind === 'file' ? dirname(t.path) : ''));
      row.addEventListener('click', () => {
        if (t.kind === 'file') openFile(t.path, { group: groupOf(t) });
        else run('px0.activateTab', t);
      });
      return row;
    }));
  };
  on('editor:active', draw);
  on('doc:dirty', draw);
  draw();
}

// Explorer's sections and whether each is shown; VS Code hides Open Editors by default.
const sections = { openEditors: pref('explorer.showOpenEditors', false), outline: pref('explorer.showOutline', true) };
let sectionEls = {};

export function explorerMenu() {
  const toggle = key => () => {
    sections[key] = !sections[key];
    setPref(key === 'openEditors' ? 'explorer.showOpenEditors' : 'explorer.showOutline', sections[key]);
    sectionEls[key].hidden = !sections[key];
  };
  return [
    { label: 'Open Editors', checked: sections.openEditors, run: toggle('openEditors') },
    { label: 'Folders', checked: true, disabled: true },
    { label: 'Outline', checked: sections.outline, run: toggle('outline') },
    { separator: true },
    { label: 'New File...', run: () => newFile() },
    { label: 'New Folder...', run: () => newFolder() },
    { label: 'Refresh Explorer', run: refreshTree },
    { label: 'Collapse Folders in Explorer', run: collapseAll },
  ];
}

export function renderExplorer(container) {
  const open = pane({ title: 'Open Editors', collapsed: pref('explorer.openEditors', false), onToggle: x => setPref('explorer.openEditors', !x) });
  renderOpenEditors(open);
  treePane = pane({
    title: S.meta?.name || 'Workspace', grow: true,
    actions: () => [
      { icon: 'new-file', title: 'New File...', run: () => newFile() },
      { icon: 'new-folder', title: 'New Folder...', run: () => newFolder() },
      { icon: 'refresh', title: 'Refresh Explorer', run: refreshTree },
      { icon: 'collapse-all', title: 'Collapse Folders in Explorer', run: collapseAll },
    ],
  });
  renderTreePane(treePane.body);
  const outline = pane({ title: 'Outline', collapsed: pref('explorer.outline', true), onToggle: x => setPref('explorer.outline', !x) });
  initOutline(outline);
  sectionEls = { openEditors: open.el, outline: outline.el };
  open.el.hidden = !sections.openEditors;
  outline.el.hidden = !sections.outline;
  container.append(open.el, treePane.el, outline.el);
  container.classList.add('panes');
  loadDir('').then(async () => {
    for (const d of [...expanded].sort((a, b) => a.length - b.length)) {
      if (!children.has(dirname(d)) && dirname(d) !== '') { expanded.delete(d); continue; }
      await loadDir(d);
    }
    flatten();
  });
}

export function initExplorer() {
  on('git:changed', () => draw());
  on('fs:changed', refreshSoon);
  on('stream:tree', refreshSoon);
  on('editor:active', t => {
    if (t?.path && t.kind === 'file' && setting('explorer.autoReveal', true) !== false) reveal(t.path);
  });
}

export const focusExplorer = () => scroller?.focus();
export const selectedPath = () => selected;
