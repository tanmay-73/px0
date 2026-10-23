// web/src/settings.js
// User settings (settings.json, served by /api/settings), the editor options
// derived from them, and the Settings editor: a searchable form over the
// server's schema, as VS Code's, plus settings.json itself in Monaco.
import { api, post } from './api.js';
import { h, icon, emit, on, debounce, isMac } from './util.js';
import { notify } from './ui.js';

let values = {};   // merged: defaults overlaid with settings.json
let schema = [];
let settingsPath = '';

export const setting = (key, fallback) => (values[key] !== undefined ? values[key] : fallback);

export async function loadSettings() {
  try {
    const j = await api('api/settings');
    values = j.settings || {};
    schema = j.schema || [];
    settingsPath = j.path || '';
    return j;
  } catch {
    return null;
  }
}

export async function updateSetting(key, value) {
  try {
    const j = await post('api/settings', { [key]: value });
    values = j.settings || { ...values, [key]: value };
    emit('settings:changed', [key]);
  } catch (e) {
    notify('Could not save the setting: ' + e.message, { severity: 'error' });
  }
}

export async function saveRawSettings(raw) {
  const j = await post('api/settings', { raw });
  values = j.settings || values;
  emit('settings:changed', null);
  return j;
}

// VS Code's default editor font for the platform the browser runs on.
export const EDITOR_FONT = isMac ? 'Menlo, Monaco, "Courier New", monospace'
  : /Win/.test(navigator.platform) ? 'Consolas, "Courier New", monospace'
    : '"Droid Sans Mono", "monospace", monospace';

export function editorOptions() {
  const wrap = setting('editor.wordWrap', 'off');
  return {
    fontSize: Number(setting('editor.fontSize', 14)) || 14,
    fontFamily: setting('editor.fontFamily', '') || EDITOR_FONT,
    fontLigatures: !!setting('editor.fontLigatures', false),
    lineHeight: Number(setting('editor.lineHeight', 0)) || 0,
    tabSize: Number(setting('editor.tabSize', 4)) || 4,
    insertSpaces: setting('editor.insertSpaces', true) !== false,
    detectIndentation: setting('editor.detectIndentation', true) !== false,
    wordWrap: wrap === true ? 'on' : wrap === false ? 'off' : wrap,
    lineNumbers: setting('editor.lineNumbers', 'on'),
    renderWhitespace: setting('editor.renderWhitespace', 'selection'),
    minimap: { enabled: setting('editor.minimap.enabled', true) !== false },
    rulers: setting('editor.rulers', []),
    cursorBlinking: setting('editor.cursorBlinking', 'smooth'),
    cursorStyle: setting('editor.cursorStyle', 'line'),
    cursorSmoothCaretAnimation: setting('editor.cursorSmoothCaretAnimation', 'on'),
    smoothScrolling: setting('editor.smoothScrolling', true) !== false,
    bracketPairColorization: { enabled: setting('editor.bracketPairColorization.enabled', setting('editor.bracketPairColorization', true)) !== false },
    guides: { bracketPairs: 'active', indentation: true },
    stickyScroll: { enabled: setting('editor.stickyScroll.enabled', true) !== false },
    renderLineHighlight: setting('editor.renderLineHighlight', 'line'),
    scrollBeyondLastLine: setting('editor.scrollBeyondLastLine', true) !== false,
    mouseWheelZoom: !!setting('editor.mouseWheelZoom', false),
    linkedEditing: true,
    'semanticHighlighting.enabled': false,
  };
}

export function diffOptions() {
  return {
    renderSideBySide: setting('diffEditor.renderSideBySide', true) !== false,
    ignoreTrimWhitespace: setting('diffEditor.ignoreTrimWhitespace', true) !== false,
    renderIndicators: true,
    useInlineViewWhenSpaceIsLimited: true,
    renderMarginRevertIcon: true,
    hideUnchangedRegions: { enabled: !!setting('diffEditor.hideUnchangedRegions.enabled', false) },
    diffAlgorithm: 'advanced',
    enableSplitViewResizing: true,
  };
}

/* ---------- the Settings editor ---------- */

// Editor settings px0 honours beyond the server's schema, shown in the form too.
const EXTRA = [
  { key: 'editor.insertSpaces', title: 'Insert Spaces', category: 'Editor', type: 'boolean', default: true, description: 'Insert spaces when pressing Tab.' },
  { key: 'editor.detectIndentation', title: 'Detect Indentation', category: 'Editor', type: 'boolean', default: true, description: 'Detect Tab Size and Insert Spaces from the file content.' },
  { key: 'editor.fontLigatures', title: 'Font Ligatures', category: 'Editor', type: 'boolean', default: false, description: 'Enable font ligatures.' },
  { key: 'editor.cursorBlinking', title: 'Cursor Blinking', category: 'Editor', type: 'select', options: ['blink', 'smooth', 'phase', 'expand', 'solid'], default: 'smooth', description: 'Control the cursor animation style.' },
  { key: 'editor.bracketPairColorization.enabled', title: 'Bracket Pair Colorization', category: 'Editor', type: 'boolean', default: true, description: 'Colour matching brackets.' },
  { key: 'editor.stickyScroll.enabled', title: 'Sticky Scroll', category: 'Editor', type: 'boolean', default: true, description: 'Show the nested scopes at the top of the editor while scrolling.' },
  { key: 'files.trimTrailingWhitespace', title: 'Trim Trailing Whitespace', category: 'Files', type: 'boolean', default: false, description: 'Trim trailing whitespace when saving a file.' },
  { key: 'files.insertFinalNewline', title: 'Insert Final Newline', category: 'Files', type: 'boolean', default: false, description: 'Insert a final newline at the end of the file when saving it.' },
  { key: 'diffEditor.ignoreTrimWhitespace', title: 'Ignore Trim Whitespace', category: 'Diff Editor', type: 'boolean', default: true, description: 'Ignore leading and trailing whitespace changes in the diff editor.' },
  { key: 'diffEditor.hideUnchangedRegions.enabled', title: 'Hide Unchanged Regions', category: 'Diff Editor', type: 'boolean', default: false, description: 'Collapse unchanged regions in the diff editor.' },
];

function allSchema() {
  const seen = new Set(schema.map(s => s.key));
  return [...schema.filter(s => s.key !== 'editor.vimMode'), ...EXTRA.filter(s => !seen.has(s.key))];
}

export function renderSettingsEditor(tab, root, { openJSON }) {
  root.classList.add('settings-editor');
  const search = h('input.settings-search', { type: 'text', placeholder: 'Search settings', spellcheck: false, 'aria-label': 'Search settings' });
  const toc = h('div.settings-toc', { role: 'tree' });
  const list = h('div.settings-list');
  const count = h('span.settings-count');
  root.append(
    h('div.settings-header',
      h('div.settings-search-row', search,
        h('button.icon-btn', { type: 'button', title: `Open Settings (JSON)${settingsPath ? ' — ' + settingsPath : ''}`, on: { click: openJSON } }, icon('go-to-file'))),
      h('div.settings-tabs', h('span.settings-tab', 'User'), h('span.grow'), count)),
    h('div.settings-main', toc, list));
  // The table of contents follows the scroll position, as in VS Code.
  list.addEventListener('scroll', () => {
    const cats = [...list.querySelectorAll('.settings-cat')];
    const top = list.getBoundingClientRect().top;
    const cur = cats.filter(c => c.getBoundingClientRect().top - top < 40).pop() || cats[0];
    for (const it of toc.children) it.classList.toggle('active', it.dataset.cat === cur?.dataset.cat);
  });

  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const items = allSchema().filter(s => !q || (s.key + ' ' + s.title + ' ' + (s.description || '')).toLowerCase().includes(q));
    const cats = [...new Set(items.map(s => s.category || 'Other'))];
    toc.replaceChildren(...cats.map((c, i) => h('div.settings-toc-item' + (i ? '' : '.active'), { role: 'treeitem', dataset: { cat: c }, on: { click: () => list.querySelector(`.settings-cat[data-cat="${CSS.escape(c)}"]`)?.scrollIntoView({ block: 'start' }) } }, c)));
    count.textContent = q ? `${items.length} Setting${items.length === 1 ? '' : 's'} Found` : '';
    list.replaceChildren(...cats.map(c => h('div.settings-cat', { dataset: { cat: c } },
      h('h2', c),
      items.filter(s => (s.category || 'Other') === c).map(settingRow))));
    if (!items.length) list.append(h('div.settings-empty', 'No settings found'));
  };
  search.addEventListener('input', debounce(draw, 80));
  const unsubscribe = on('settings:changed', keys => {
    for (const row of list.querySelectorAll('.setting')) {
      if (!keys || keys.includes(row.dataset.key)) row.syncSetting();
    }
  });
  draw();
  setTimeout(() => search.focus(), 0);
  return unsubscribe;
}

function settingRow(s) {
  const cur = setting(s.key, s.default);
  const modified = JSON.stringify(cur) !== JSON.stringify(s.default);
  const save = async v => { await updateSetting(s.key, v); row.syncSetting(); };
  let control;
  if (s.type === 'boolean') {
    const cb = h('input', { type: 'checkbox', checked: !!cur, on: { change: () => save(cb.checked) } });
    control = h('label.setting-check', cb, h('span', s.description || ''));
  } else if (s.type === 'select' || s.options?.length) {
    const sel = h('select.setting-select', { on: { change: () => save(sel.value) } },
      (s.options || []).map(o => h('option', { value: o, selected: String(cur) === String(o) }, o)));
    control = sel;
  } else if (s.type === 'number') {
    const inp = h('input.setting-input', { type: 'number', value: cur ?? '', min: s.min, max: s.max, step: s.step, on: { change: () => save(inp.value === '' ? s.default : Number(inp.value)) } });
    control = inp;
  } else {
    const inp = h('input.setting-input', { type: s.secret ? 'password' : 'text', value: cur ?? '', spellcheck: false, on: { change: () => save(inp.value) } });
    control = inp;
  }
  const row = h('div.setting' + (modified ? '.modified' : ''),
    h('div.setting-title', h('span.setting-cat', (s.category || '') + ': '), s.title || s.key),
    s.type !== 'boolean' && s.description ? h('div.setting-desc', s.description) : null,
    control,
    h('div.setting-key', s.key));
  row.dataset.key = s.key;
  const input = control.matches('input, select') ? control : control.querySelector('input');
  input.setAttribute('aria-label', s.title || s.key);
  row.syncSetting = () => {
    const value = setting(s.key, s.default);
    if (s.type === 'boolean') input.checked = !!value;
    else input.value = value ?? '';
    row.classList.toggle('modified', JSON.stringify(value) !== JSON.stringify(s.default));
  };
  return row;
}
