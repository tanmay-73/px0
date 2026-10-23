// web/src/editors.js
// The editor area, laid out as VS Code's: one or more editor groups side by
// side, each with its own tabs, breadcrumbs and editors. A tab is an "editor
// input":
//   file      a workspace file in Monaco (editable)
//   diff      two sides in Monaco's diff editor: git changes, a commit, a
//             comparison of two files
//   view      anything else rendered by a viewer (Markdown preview, table,
//             image, welcome) registered with registerViewer()
// Single-clicking a file opens a preview tab (italic) that the next preview
// replaces; editing it, double-clicking it or its tab keeps it.
import { monaco } from './monaco.js';
import { S } from './api.js';
import { h, icon, basename, dirname, emit, on, keyLabel, pref, setPref, extname } from './util.js';
import { openDoc, retain, release, isDirty, save, getDoc, originalModel, textModel, releaseOriginal, fileUri, pathOfUri } from './models.js';
import { showMenu, confirm, notify } from './ui.js';
import { run, keysFor } from './commands.js';
import { decoration } from './git.js';
import { fileIcon } from './icons.js';
import { editorOptions, diffOptions } from './settings.js';
import { compareSelection } from './compare.js';
import { keycaps } from './ui.js';
import { documentSymbols } from './lsp.js';

const groups = [];
let activeGroup = null;
let area = null;
const viewers = new Map(); // view kind -> { render(tab, el), dispose?(tab) }

export const getGroups = () => groups;
export const activeTab = () => activeGroup?.active || null;
export const allTabs = () => groups.flatMap(g => g.tabs);

export function registerViewer(kind, viewer) {
  viewers.set(kind, viewer);
}

/* ---------- groups ---------- */

function createGroup(index = groups.length) {
  const g = {
    id: Math.random().toString(36).slice(2),
    tabs: [],
    active: null,
    code: null,
    diff: null,
    shownModelKey: '',
  };
  g.tabsEl = h('div.tabs', { role: 'tablist' });
  g.actionsEl = h('div.editor-actions');
  g.crumbsEl = h('div.breadcrumbs');
  g.codeHost = h('div.editor-host.code-host');
  g.diffHost = h('div.editor-host.diff-host');
  g.viewHost = h('div.editor-host.view-host');
  g.emptyEl = h('div.watermark');
  g.el = h('div.editor-group', { on: { mousedown: () => focusGroup(g, false) } },
    h('div.tabs-bar', g.tabsEl, g.actionsEl),
    g.crumbsEl,
    h('div.editor-body', g.codeHost, g.diffHost, g.viewHost, g.emptyEl));
  g.tabsEl.addEventListener('wheel', e => { if (e.deltaY) { g.tabsEl.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });
  g.tabsEl.addEventListener('dblclick', e => { if (e.target === g.tabsEl) run('workbench.action.files.newUntitledFile'); });
  groups.splice(index, 0, g);
  layoutGroups();
  return g;
}

function layoutGroups() {
  area.replaceChildren();
  groups.forEach((g, i) => {
    if (i) area.append(sash(groups[i - 1], g));
    g.el.style.flex = g.flex ? `${g.flex} 1 0` : '1 1 0';
    area.append(g.el);
  });
  area.classList.toggle('multi', groups.length > 1);
}

function sash(left, right) {
  const s = h('div.sash.sash-v');
  s.addEventListener('pointerdown', e => {
    e.preventDefault();
    s.setPointerCapture(e.pointerId);
    const lw = left.el.getBoundingClientRect().width;
    const rw = right.el.getBoundingClientRect().width;
    const x0 = e.clientX;
    const move = ev => {
      const d = ev.clientX - x0;
      const l = Math.max(120, lw + d), r = Math.max(120, rw - d);
      left.flex = l; right.flex = r;
      left.el.style.flex = `${l} 1 0`;
      right.el.style.flex = `${r} 1 0`;
    };
    const up = () => { s.removeEventListener('pointermove', move); s.removeEventListener('pointerup', up); };
    s.addEventListener('pointermove', move);
    s.addEventListener('pointerup', up);
  });
  s.addEventListener('dblclick', () => { left.flex = right.flex = 0; layoutGroups(); });
  return s;
}

export function focusGroup(g, focusEditor = true) {
  if (activeGroup !== g) {
    activeGroup = g;
    for (const x of groups) x.el.classList.toggle('active', x === g);
    emit('editor:active', activeTab());
  }
  if (focusEditor) focusEditorOf(g);
}

function focusEditorOf(g) {
  const t = g.active;
  if (!t) return;
  if (t.kind === 'file') g.code?.focus();
  else if (t.kind === 'diff') g.diff?.getModifiedEditor().focus();
  else g.viewHost.querySelector('[tabindex]')?.focus();
}

function removeGroup(g) {
  if (groups.length <= 1) return;
  const i = groups.indexOf(g);
  groups.splice(i, 1);
  g.code?.dispose();
  g.diff?.dispose();
  layoutGroups();
  focusGroup(groups[Math.max(0, i - 1)]);
}

/* ---------- tab keys and titles ---------- */

const diffKey = (left, right) => 'diff:' + JSON.stringify([left, right]);

function tabTitle(t) {
  return t.title || basename(t.path || '') || 'Untitled';
}

/* ---------- opening ---------- */

/* openFile(path, { line, col, endLine, endCol, preview, group, focus, sideBySide })
   preview defaults to false: callers that open on a single click (explorer,
   search results) pass preview: true. */
export async function openFile(path, opts = {}) {
  const g = targetGroup(opts);
  const viewer = viewerFor(path);
  if (viewer && !opts.asText) return openView(viewer, path, { ...opts, group: g });
  let t = g.tabs.find(x => x.kind === 'file' && x.path === path);
  if (!t) {
    let doc;
    try {
      doc = await openDoc(path);
    } catch (e) {
      if (!opts.quiet) notify(`Unable to open '${basename(path)}': ${e.message}`, { severity: 'error' });
      return null;
    }
    if (doc.binary || doc.tooLarge) {
      release(doc);
      return openView('binary', path, { ...opts, group: g, info: doc.binary ? 'binary' : 'large' });
    }
    retain(doc);
    t = { key: 'file:' + path, kind: 'file', path, doc, preview: !!opts.preview, viewState: null };
    addTab(g, t, opts);
  } else if (!opts.preview) {
    t.preview = false;
  }
  activate(g, t, opts);
  if (opts.line) revealPosition(g, opts);
  return t;
}

function viewerFor(path) {
  const ext = extname(path);
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif'].includes(ext)) return 'image';
  return null;
}

/* openDiff({ path, left, right, title, description, preview, group, line })
   left/right: { ref } for a git version ("HEAD", "INDEX", "BASE", sha, sha^),
   { path } for a workspace file (editable on the right), or { empty: true }. */
export async function openDiff(spec) {
  const g = targetGroup(spec);
  const key = diffKey(spec.left, spec.right);
  let t = g.tabs.find(x => x.key === key);
  if (!t) {
    t = {
      key, kind: 'diff', path: spec.path || spec.right.path || spec.left.path, left: spec.left, right: spec.right,
      title: spec.title, description: spec.description, preview: spec.preview !== false && !!spec.preview, viewState: null,
    };
    try {
      await loadDiffSides(t);
    } catch (e) {
      notify(`Unable to open the changes of '${basename(t.path)}': ${e.message}`, { severity: 'error' });
      return null;
    }
    addTab(g, t, spec);
  } else if (!spec.preview) t.preview = false;
  activate(g, t, spec);
  if (spec.line) revealPosition(g, spec);
  return t;
}

async function sideModel(side, path, t, which) {
  if (side.path) {
    const doc = await openDoc(side.path);
    retain(doc);
    t.docs = (t.docs || []).concat(doc);
    return { model: doc.model, editable: !doc.readonly };
  }
  if (side.empty) return { model: textModel('', path, which + Date.now()), editable: false, temp: true };
  const o = await originalModel(side.of || path, side.ref);
  t.originals = (t.originals || []).concat(o);
  return { model: o.model, editable: false };
}

async function loadDiffSides(t) {
  const [l, r] = await Promise.all([sideModel(t.left, t.path, t, 'l'), sideModel(t.right, t.path, t, 'r')]);
  t.leftModel = l;
  t.rightModel = r;
  t.doc = t.right.path ? getDoc(t.right.path) : null;
}

export async function openView(kind, path, opts = {}) {
  const g = targetGroup(opts);
  const key = 'view:' + kind + ':' + (path || opts.key || '');
  let t = g.tabs.find(x => x.key === key);
  if (!t) {
    t = { key, kind: 'view', view: kind, path, title: opts.title, description: opts.description, preview: !!opts.preview, info: opts.info, data: opts.data, icon: opts.icon };
    addTab(g, t, opts);
  } else {
    if (!opts.preview) t.preview = false;
    if (opts.data !== undefined) { t.data = opts.data; t.rendered = false; }
  }
  activate(g, t, opts);
  return t;
}

function targetGroup(opts) {
  if (opts.group && groups.includes(opts.group)) return opts.group;
  if (opts.sideBySide) {
    const i = groups.indexOf(activeGroup);
    return groups[i + 1] || createGroup(i + 1);
  }
  return activeGroup || groups[0];
}

function addTab(g, t, opts) {
  // A preview tab is replaced by the next preview, as in VS Code.
  const prevIdx = t.preview ? g.tabs.findIndex(x => x.preview && !isTabDirty(x)) : -1;
  const at = g.active ? g.tabs.indexOf(g.active) + 1 : g.tabs.length;
  if (prevIdx >= 0) {
    const old = g.tabs[prevIdx];
    g.tabs.splice(prevIdx, 1, t);
    disposeTab(g, old);
  } else {
    g.tabs.splice(Math.min(at, g.tabs.length), 0, t);
  }
  saveSession();
}

export const isTabDirty = t => (t.kind === 'file' || t.kind === 'diff') && !!t.doc && isDirty(t.doc);

function activate(g, t, opts = {}) {
  const prev = g.active;
  if (prev && prev !== t) saveViewState(g, prev);
  g.active = t;
  show(g);
  drawTabs(g);
  if (opts.focus !== false) focusGroup(g);
  else if (activeGroup !== g) focusGroup(g, false);
  emit('editor:active', t);
  saveSession();
}

function saveViewState(g, t) {
  if (t.kind === 'file' && g.code && g.shownModelKey === t.key) t.viewState = g.code.saveViewState();
  if (t.kind === 'diff' && g.diff && g.shownModelKey === t.key) t.viewState = g.diff.saveViewState();
  if (t.kind === 'view') t.scrollTop = g.viewHost.firstElementChild?.scrollTop || 0;
}

function ensureCode(g) {
  if (g.code) return g.code;
  g.code = monaco.editor.create(g.codeHost, { ...editorOptions(), automaticLayout: true, model: null, fixedOverflowWidgets: true });
  g.code.onDidFocusEditorWidget(() => focusGroup(g, false));
  g.code.onDidBlurEditorWidget(() => emit('doc:blur', getDoc(pathOfUri(g.code.getModel()?.uri || {}))));
  g.code.onDidChangeCursorPosition(() => emit('editor:cursor', g.code));
  g.code.onDidChangeCursorSelection(() => emit('editor:cursor', g.code));
  g.code.onDidChangeModelContent(() => {
    const t = g.active;
    if (t?.preview) { t.preview = false; drawTabs(g); }
  });
  addEditorActions(g.code, g);
  emit('editor:created', g.code);
  return g.code;
}

function ensureDiff(g) {
  if (g.diff) return g.diff;
  g.diff = monaco.editor.createDiffEditor(g.diffHost, { ...editorOptions(), ...diffOptions(), automaticLayout: true, fixedOverflowWidgets: true });
  const mod = g.diff.getModifiedEditor();
  mod.onDidFocusEditorWidget(() => focusGroup(g, false));
  mod.onDidBlurEditorWidget(() => emit('doc:blur', getDoc(pathOfUri(mod.getModel()?.uri || {}))));
  g.diff.getOriginalEditor().onDidFocusEditorWidget(() => focusGroup(g, false));
  g.diff.getOriginalEditor().onDidBlurEditorWidget(() => emit('doc:blur', getDoc(pathOfUri(g.diff.getOriginalEditor().getModel()?.uri || {}))));
  mod.onDidChangeCursorPosition(() => emit('editor:cursor', mod));
  mod.onDidChangeModelContent(() => {
    const t = g.active;
    if (t?.preview) { t.preview = false; drawTabs(g); }
  });
  addEditorActions(mod, g);
  emit('editor:created', mod);
  return g.diff;
}

// Keys Monaco would otherwise swallow while it has focus.
function addEditorActions(ed, g) {
  ed.addAction({
    id: 'px0.save', label: 'File: Save', keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
    run: () => run('workbench.action.files.save'),
  });
}

function show(g) {
  const t = g.active;
  g.emptyEl.hidden = !!t;
  // Built when first shown: the shortcuts it lists are registered after the editors.
  if (!t && !g.emptyEl.firstChild) g.emptyEl.replaceChildren(...watermark().childNodes);
  g.codeHost.hidden = !t || t.kind !== 'file';
  g.diffHost.hidden = !t || t.kind !== 'diff';
  g.viewHost.hidden = !t || t.kind !== 'view';
  drawCrumbs(g);
  drawActions(g);
  if (!t) {
    g.shownModelKey = '';
    g.code?.setModel(null);
    g.diff?.setModel(null);
    return;
  }
  if (t.kind === 'file') {
    const ed = ensureCode(g);
    if (ed.getModel() !== t.doc.model) ed.setModel(t.doc.model);
    ed.updateOptions({ readOnly: t.doc.readonly });
    if (t.viewState) ed.restoreViewState(t.viewState);
    g.shownModelKey = t.key;
    requestAnimationFrame(() => ed.layout());
  } else if (t.kind === 'diff') {
    const de = ensureDiff(g);
    const cur = de.getModel();
    if (!cur || cur.original !== t.leftModel.model || cur.modified !== t.rightModel.model) {
      de.setModel({ original: t.leftModel.model, modified: t.rightModel.model });
    }
    de.updateOptions({ originalEditable: !!t.leftModel.editable && !!t.left.path, readOnly: !t.rightModel.editable });
    if (t.viewState) de.restoreViewState(t.viewState);
    g.shownModelKey = t.key;
    requestAnimationFrame(() => de.layout());
  } else {
    const v = viewers.get(t.view);
    if (!t.el) {
      t.el = h('div.view-root', { tabindex: '-1' });
      t.rendered = false;
    }
    if (!t.rendered) {
      t.rendered = true;
      t.el.replaceChildren();
      v?.render(t, t.el);
    }
    if (g.viewHost.firstChild !== t.el) g.viewHost.replaceChildren(t.el);
    if (t.scrollTop) t.el.scrollTop = t.scrollTop;
    g.shownModelKey = t.key;
  }
}

// Re-renders a view tab (its file changed, or the theme did).
export function rerenderView(match) {
  for (const g of groups) {
    for (const t of g.tabs) {
      if (t.kind === 'view' && match(t)) {
        t.rendered = false;
        if (g.active === t) { t.scrollTop = t.el?.scrollTop || 0; show(g); }
      }
    }
  }
}

function revealPosition(g, { line, col = 1, endLine, endCol }) {
  const ed = g.active?.kind === 'diff' ? g.diff?.getModifiedEditor() : g.code;
  if (!ed || !line) return;
  const range = endLine ? new monaco.Range(line, col, endLine, endCol || col) : new monaco.Range(line, col, line, col);
  ed.setSelection(range);
  ed.revealRangeInCenterIfOutsideViewport(range, monaco.editor.ScrollType.Immediate);
}

/* ---------- closing ---------- */

export async function closeTab(t, g = groupOf(t), { force = false } = {}) {
  if (!g || !g.tabs.includes(t)) return true;
  if (!force && isTabDirty(t) && openCount(t.doc) === 1) {
    const choice = await confirm({
      message: `Do you want to save the changes you made to ${basename(t.path)}?`,
      detail: "Your changes will be lost if you don't save them.",
      buttons: ['Save', "Don't Save"],
    });
    if (choice === -1) return false;
    if (choice === 0 && !(await save(t.doc))) return false;
    if (choice === 1) discardDoc(t.doc);
  }
  const i = g.tabs.indexOf(t);
  g.tabs.splice(i, 1);
  if (g.active === t) {
    g.active = g.tabs[Math.min(i, g.tabs.length - 1)] || null;
    show(g);
  }
  disposeTab(g, t);
  drawTabs(g);
  emit('editor:closed', t);
  if (!g.tabs.length && groups.length > 1) removeGroup(g);
  emit('editor:active', activeTab());
  saveSession();
  return true;
}

function discardDoc(doc) {
  // Unsaved edits thrown away: the model is rebuilt from disk next time.
  doc.savedVersion = doc.model.getAlternativeVersionId();
}

const openCount = doc => allTabs().filter(t => t.doc === doc || t.docs?.includes(doc)).length;

function disposeTab(g, t) {
  if (t.kind === 'file' && t.doc) {
    if (g.code?.getModel() === t.doc.model && g.active?.doc !== t.doc) g.code.setModel(null);
    release(t.doc);
  }
  if (t.kind === 'diff') {
    if (g.diff && g.active !== t) {
      const m = g.diff.getModel();
      if (m && (m.modified === t.rightModel?.model || m.original === t.leftModel?.model)) g.diff.setModel(null);
    }
    for (const d of t.docs || []) release(d);
    for (const o of t.originals || []) releaseOriginal(o);
    for (const side of [t.leftModel, t.rightModel]) if (side?.temp) side.model.dispose();
  }
  if (t.kind === 'view') viewers.get(t.view)?.dispose?.(t);
}

export async function closeTabs(list) {
  for (const t of [...list]) {
    if (!(await closeTab(t))) return false;
  }
  return true;
}

export const groupOf = t => groups.find(g => g.tabs.includes(t)) || null;

/* ---------- tab bar ---------- */

function drawTabs(g) {
  const names = new Map();
  for (const t of g.tabs) names.set(tabTitle(t), (names.get(tabTitle(t)) || 0) + 1);
  g.tabsEl.replaceChildren(...g.tabs.map(t => {
    const dirty = isTabDirty(t);
    const dec = t.kind === 'file' ? decoration(t.path) : null;
    const desc = t.description ?? (names.get(tabTitle(t)) > 1 && t.path ? dirname(t.path) : '');
    const el = h('div.tab' + (t === g.active ? '.active' : '') + (t.preview ? '.preview' : '') + (dirty ? '.dirty' : '') + (t.doc?.deleted ? '.deleted' : ''),
      { role: 'tab', draggable: 'true', 'aria-selected': String(t === g.active), title: tabTooltip(t) },
      t === g.active ? h('span.tab-edge') : null,
      h('span.tab-label',
        tabIcon(t),
        h('span.tab-name' + (dec ? '.' + dec.cls : ''), tabTitle(t)),
        desc ? h('span.tab-desc', desc) : null,
        dec && dec.letter ? h('span.tab-deco.' + dec.cls, dec.letter) : null),
      h('span.tab-actions', h('span.tab-close', { title: `Close (${keyLabel(keysFor('workbench.action.closeActiveEditor'))})`, role: 'button', 'aria-label': 'Close' }, icon(dirty ? 'circle-filled' : 'close'))));
    el.addEventListener('mousedown', e => {
      if (e.button === 1) { e.preventDefault(); closeTab(t, g); return; }
      if (e.button !== 0 || e.target.closest('.tab-close')) return;
      activate(g, t);
    });
    el.addEventListener('click', e => { if (e.target.closest('.tab-close')) closeTab(t, g); });
    el.addEventListener('dblclick', () => { t.preview = false; drawTabs(g); });
    el.addEventListener('contextmenu', e => { e.preventDefault(); tabMenu(g, t, e.clientX, e.clientY); });
    el.addEventListener('dragstart', e => { e.dataTransfer.setData('text/px0-tab', t.key); dragging = { g, t }; });
    el.addEventListener('dragover', e => { if (dragging) e.preventDefault(); });
    el.addEventListener('drop', e => {
      e.preventDefault();
      if (!dragging) return;
      moveTab(dragging.g, dragging.t, g, g.tabs.indexOf(t));
      dragging = null;
    });
    return el;
  }));
  g.tabsEl.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

let dragging = null;

function moveTab(fromG, t, toG, index) {
  if (fromG === toG) {
    const i = fromG.tabs.indexOf(t);
    fromG.tabs.splice(i, 1);
    fromG.tabs.splice(index < 0 ? fromG.tabs.length : index, 0, t);
    drawTabs(fromG);
    return;
  }
  // Across groups: reopen there, close here.
  reopenIn(t, toG).then(() => closeTab(t, fromG, { force: true }));
}

async function reopenIn(t, g) {
  if (t.kind === 'file') return openFile(t.path, { group: g });
  if (t.kind === 'diff') return openDiff({ path: t.path, left: t.left, right: t.right, title: t.title, description: t.description, group: g });
  return openView(t.view, t.path, { group: g, title: t.title, data: t.data, info: t.info });
}

function tabTooltip(t) {
  if (t.kind === 'diff') return `${t.left.path || t.path} ${t.left.ref ? '(' + t.left.ref + ')' : ''} ↔ ${t.right.path || t.path} ${t.right.ref ? '(' + t.right.ref + ')' : ''}`;
  return (t.path ? (S.meta?.root ? S.meta.root.replace(/\/$/, '') + '/' : '') + t.path : tabTitle(t)) + (t.doc?.deleted ? ' (deleted)' : '');
}

function tabIcon(t) {
  if (t.icon) return icon(t.icon, 'tab-icon');
  if (t.kind === 'diff') return t.path ? fileIcon(t.path, 'tab-icon') : icon('diff', 'tab-icon');
  if (t.kind === 'view' && t.view === 'markdown') return icon('open-preview', 'tab-icon');
  return fileIcon(t.path || '', 'tab-icon');
}

function tabMenu(g, t, x, y) {
  const i = g.tabs.indexOf(t);
  const path = t.path;
  showMenu([
    { label: 'Close', keys: keysFor('workbench.action.closeActiveEditor'), run: () => closeTab(t, g) },
    { label: 'Close Others', disabled: g.tabs.length < 2, run: () => closeTabs(g.tabs.filter(x => x !== t)) },
    { label: 'Close to the Right', disabled: i === g.tabs.length - 1, run: () => closeTabs(g.tabs.slice(i + 1)) },
    { label: 'Close Saved', run: () => closeTabs(g.tabs.filter(x => !isTabDirty(x))) },
    { label: 'Close All', run: () => closeTabs([...g.tabs]) },
    { separator: true },
    path && { label: 'Copy Path', run: () => run('copyFilePath', path) },
    path && { label: 'Copy Relative Path', run: () => run('copyRelativeFilePath', path) },
    { separator: true },
    path && !path.startsWith('/') && { label: 'Reveal in Explorer View', run: () => run('workbench.files.action.showActiveFileInExplorer', path) },
    t.preview && { label: 'Keep Open', run: () => { t.preview = false; drawTabs(g); } },
    { separator: true },
    { label: 'Split Right', run: () => splitTab(t, g) },
    t.kind === 'file' && { separator: true },
    t.kind === 'file' && { label: 'Select for Compare', run: () => run('selectForCompare', path) },
    t.kind === 'file' && { label: 'Compare with Selected', disabled: !compareSelection() || compareSelection() === path, run: () => run('compareSelected', path) },
    t.kind === 'file' && /\.(md|markdown)$/i.test(path) && { label: 'Open Preview', run: () => run('markdown.showPreview', path) },
  ], x, y);
}

export async function splitTab(t = activeTab(), g = activeGroup) {
  if (!t) return;
  const i = groups.indexOf(g);
  const target = groups[i + 1] || createGroup(i + 1);
  await reopenIn(t, target);
}

/* ---------- title actions and breadcrumbs ---------- */

const editorActions = []; // { id, icon, title, when(tab) }

export function registerEditorAction(a) {
  editorActions.push(a);
}

function drawActions(g) {
  const t = g.active;
  const btns = editorActions.filter(a => t && a.when(t)).map(a =>
    h('button.icon-btn', { type: 'button', title: a.title + (keysFor(a.id) ? ` (${keyLabel(keysFor(a.id))})` : ''), on: { click: () => { focusGroup(g, false); run(a.id, t); } } }, icon(typeof a.icon === 'function' ? a.icon(t) : a.icon)));
  btns.push(h('button.icon-btn', { type: 'button', title: 'Split Editor Right', on: { click: () => splitTab(t, g) } }, icon('split-horizontal')));
  btns.push(h('button.icon-btn', { type: 'button', title: 'More Actions...', on: { click: e => groupMenu(g, e.currentTarget) } }, icon('ellipsis')));
  g.actionsEl.replaceChildren(...btns);
}

function groupMenu(g, anchor) {
  const r = anchor.getBoundingClientRect();
  showMenu([
    { label: 'Close All', run: () => closeTabs([...g.tabs]) },
    { label: 'Close Saved', run: () => closeTabs(g.tabs.filter(x => !isTabDirty(x))) },
    { separator: true },
    { label: 'Toggle Word Wrap', keys: 'Alt+Z', run: () => run('editor.action.toggleWordWrap') },
    { label: 'Toggle Minimap', run: () => run('editor.action.toggleMinimap') },
    { label: 'Toggle Inline View', disabled: g.active?.kind !== 'diff', run: () => run('toggle.diff.renderSideBySide') },
  ], r.right - 200, r.bottom + 2);
}

function drawCrumbs(g) {
  const t = g.active;
  g.crumbsEl.replaceChildren();
  g.crumbsEl.hidden = !t || !t.path || t.kind === 'view' && !t.path;
  if (!t || !t.path) return;
  const parts = t.path.replace(/^\//, '').split('/');
  parts.forEach((p, i) => {
    if (i) g.crumbsEl.append(icon('chevron-right', 'crumb-sep'));
    const isFile = i === parts.length - 1;
    const sub = parts.slice(0, i + 1).join('/');
    g.crumbsEl.append(h('span.crumb', {
      on: { click: () => { if (!t.path.startsWith('/')) run('workbench.files.action.showActiveFileInExplorer', isFile ? t.path : sub); } },
    }, isFile ? fileIcon(p, 'crumb-icon') : null, p));
  });
  if (t.kind === 'diff') g.crumbsEl.append(h('span.crumb-note', diffNote(t)));
  if (t.kind === 'file') g.crumbsEl.append(h('span.crumb-symbols'));
  drawSymbolCrumbs(g);
}

/* The breadcrumbs' symbol path: the symbols around the cursor, outermost
   first, from the same symbol list as the Outline. */
const symbolCache = new Map(); // path -> Promise<symbols>
const SYMBOL_ICON = {
  func: 'symbol-method', function: 'symbol-method', method: 'symbol-method', class: 'symbol-class', struct: 'symbol-structure',
  interface: 'symbol-interface', type: 'symbol-class', enum: 'symbol-enum', const: 'symbol-constant', constant: 'symbol-constant',
  var: 'symbol-variable', variable: 'symbol-variable', field: 'symbol-field', property: 'symbol-property', module: 'symbol-module',
  namespace: 'symbol-namespace', package: 'symbol-package', heading: 'symbol-string', section: 'symbol-string', key: 'symbol-key',
};

async function drawSymbolCrumbs(g) {
  const t = g.active;
  const box = g.crumbsEl.querySelector('.crumb-symbols');
  if (!box || t?.kind !== 'file' || !g.code) return;
  if (!symbolCache.has(t.path)) symbolCache.set(t.path, documentSymbols(t.path).catch(() => []));
  const syms = await symbolCache.get(t.path);
  if (g.active !== t || !box.isConnected) return;
  const line = g.code.getPosition()?.lineNumber || 1;
  const chain = [];
  for (const sym of syms) {
    if (sym.line > line) break;
    const end = sym.end || sym.line;
    while (chain.length && (chain[chain.length - 1].indent || 0) >= (sym.indent || 0)) chain.pop();
    if (line <= end) chain.push(sym);
  }
  box.replaceChildren(...chain.flatMap(sym => [
    icon('chevron-right', 'crumb-sep'),
    h('span.crumb', { on: { click: () => openFile(t.path, { line: sym.line, col: 1 }) } },
      icon(SYMBOL_ICON[(sym.kind || '').toLowerCase()] || 'symbol-field', 'crumb-icon symbol-icon'), sym.name),
  ]));
}

let crumbTimer = 0;
on('editor:cursor', () => { clearTimeout(crumbTimer); crumbTimer = setTimeout(() => { if (activeGroup) drawSymbolCrumbs(activeGroup); }, 150); });
on('doc:saved', d => symbolCache.delete(d?.path));

function diffNote(t) {
  const name = s => s.path ? (s.path === t.path ? 'Working Tree' : s.path) : s.empty ? 'Empty' : s.ref === 'INDEX' ? 'Index' : s.ref;
  return `${name(t.left)} ↔ ${name(t.right)}`;
}

// The empty editor group: VS Code's letterpress and a few shortcuts.
function watermark() {
  const row = (label, id) => {
    const keys = keysFor(id);
    return keys ? h('dl.wm-entry', h('dt', label), h('dd', keycaps(keys))) : null;
  };
  return h('div.watermark',
    h('div.letterpress', { 'aria-hidden': 'true' }, h('span.lp-bracket', '['), h('span.lp-zero', '0'), h('span.lp-bracket', ']')),
    h('div.wm-shortcuts',
      row('Show All Commands', 'workbench.action.showCommands'),
      row('Go to File', 'workbench.action.quickOpen'),
      row('Find in Files', 'workbench.view.search'),
      S.meta?.workbench ? row('Switch Repository', 'px0.switchRepository') : row('Source Control', 'workbench.view.scm'),
      row('Toggle Panel', 'workbench.action.togglePanel')));
}

/* ---------- editor access for other modules ---------- */

// The Monaco editor of the active group's tab (the modified side of a diff).
export function activeEditor() {
  const g = activeGroup;
  if (!g?.active) return null;
  if (g.active.kind === 'file') return g.code;
  if (g.active.kind === 'diff') return g.diff?.getModifiedEditor() || null;
  return null;
}

export function activeDiffEditor() {
  return activeGroup?.active?.kind === 'diff' ? activeGroup.diff : null;
}

export function allCodeEditors() {
  return groups.flatMap(g => [g.code, g.diff?.getModifiedEditor(), g.diff?.getOriginalEditor()]).filter(Boolean);
}

export function updateAllEditorOptions() {
  for (const g of groups) {
    g.code?.updateOptions(editorOptions());
    g.diff?.updateOptions({ ...editorOptions(), ...diffOptions() });
  }
}

// Rebuilds the empty-group watermark (its shortcuts are known once commands register).
export function refreshWatermarks() {
  for (const g of groups) { g.emptyEl.replaceChildren(); if (!g.active) show(g); }
}

export function redrawTabs() {
  for (const g of groups) { drawTabs(g); drawActions(g); }
}

export function nextTab(d) {
  const g = activeGroup;
  if (!g?.tabs.length) return;
  const i = g.tabs.indexOf(g.active);
  activate(g, g.tabs[(i + d + g.tabs.length) % g.tabs.length]);
}

export function openTabAt(n) {
  const g = activeGroup;
  const t = n === 9 ? g?.tabs[g.tabs.length - 1] : g?.tabs[n - 1];
  if (t) activate(g, t);
}

export function focusGroupAt(i) {
  if (groups[i]) focusGroup(groups[i]);
  else if (i === groups.length && activeTab()) splitTab();
}

export function closeOthersInGroup() {
  const g = activeGroup;
  if (g) return closeTabs(g.tabs.filter(t => t !== g.active));
}

export function keepActiveOpen() {
  const t = activeTab();
  if (t) { t.preview = false; drawTabs(activeGroup); }
}

// Re-reads the sides of open diffs whose git versions may have moved.
export async function refreshDiffs() {
  for (const g of groups) for (const t of g.tabs) {
    if (t.kind !== 'diff') continue;
    for (const o of t.originals || []) {
      if (!/^[0-9a-f]{7,40}\^?$/.test(o.ref)) await originalModel(o.path, o.ref, { refresh: true }).catch(() => {});
    }
  }
}

/* ---------- session ---------- */

const sessionKey = () => 'session:' + (S.meta?.root || '');

function saveSession() {
  if (!S.meta) return;
  const state = groups.map(g => ({
    tabs: g.tabs.filter(t => (t.kind === 'file' && !t.path.startsWith('/')) || (t.kind === 'view' && t.path && t.view !== 'binary')).map(t => ({ kind: t.kind, path: t.path, view: t.view, preview: t.preview })),
    active: g.active && g.tabs.indexOf(g.active),
  }));
  setPref(sessionKey(), state);
}

export async function restoreSession() {
  const state = pref(sessionKey(), null);
  if (!Array.isArray(state)) return false;
  let any = false;
  for (let gi = 0; gi < state.length && gi < 3; gi++) {
    const s = state[gi];
    const g = groups[gi] || createGroup(gi);
    for (const t of s.tabs || []) {
      const r = t.kind === 'view' ? await openView(t.view, t.path, { group: g, focus: false, title: t.view === 'markdown' ? 'Preview ' + basename(t.path) : undefined }).catch(() => null)
        : await openFile(t.path, { group: g, focus: false, preview: t.preview, quiet: true }).catch(() => null);
      if (r) any = true;
    }
    const act = g.tabs[s.active ?? -1];
    if (act) activate(g, act, { focus: false });
  }
  for (const g of [...groups]) if (!g.tabs.length && groups.length > 1) removeGroup(g);
  return any;
}

/* A file or folder was renamed or moved: its open file tabs move with it,
   unsaved edits included. */
async function followRename({ from, to }) {
  const moved = p => (p === from ? to : p.startsWith(from + '/') ? to + p.slice(from.length) : null);
  for (const g of groups) {
    for (const t of [...g.tabs]) {
      if (t.kind !== 'file') continue;
      const next = moved(t.path);
      if (!next) continue;
      const wasActive = g.active === t;
      const unsaved = isDirty(t.doc) ? t.doc.model.getValue() : null;
      const nt = await openFile(next, { group: g, focus: false, preview: t.preview });
      if (nt && unsaved !== null) nt.doc.model.setValue(unsaved);
      if (nt) {
        // Put the new tab where the old one was.
        g.tabs.splice(g.tabs.indexOf(nt), 1);
        g.tabs.splice(g.tabs.indexOf(t), 0, nt);
      }
      discardDoc(t.doc);
      await closeTab(t, g, { force: true });
      if (nt && wasActive) activate(g, nt, { focus: false });
    }
  }
}

/* ---------- init ---------- */

export function initEditors(container) {
  area = container;
  activeGroup = createGroup();
  activeGroup.el.classList.add('active');
  show(activeGroup);
  drawTabs(activeGroup);
  on('doc:dirty', () => redrawTabs());
  on('git:changed', () => redrawTabs());
  on('fs:renamed', followRename);
  // Go to definition and peek references into another file land here.
  monaco.editor.registerEditorOpener({
    openCodeEditor(source, resource, selectionOrPosition) {
      const path = pathOfUri(resource);
      if (path === null) return false;
      const sel = selectionOrPosition;
      const line = sel ? (sel.startLineNumber || sel.lineNumber) : undefined;
      const col = sel ? (sel.startColumn || sel.column) : undefined;
      openFile(path, { line, col });
      return true;
    },
  });
  addEventListener('beforeunload', e => {
    if (allTabs().some(isTabDirty)) { e.preventDefault(); e.returnValue = ''; }
  });
}

export { fileUri };
