// web/src/problems.js
// The PROBLEMS panel: every diagnostic in every open file (Monaco markers set
// by lsp.js), grouped by file, filterable; click one to go to it.
import { monaco } from './monaco.js';
import { h, icon, basename, dirname, debounce, emit } from './util.js';
import { pathOfUri } from './models.js';
import { openFile } from './editors.js';
import { fileIcon } from './icons.js';

const SEV_ICON = { 8: ['error', 'sev-error'], 4: ['warning', 'sev-warning'], 2: ['info', 'sev-info'], 1: ['lightbulb', 'sev-hint'] };

export function problemCounts() {
  const all = monaco.editor.getModelMarkers({});
  return {
    errors: all.filter(m => m.severity === monaco.MarkerSeverity.Error).length,
    warnings: all.filter(m => m.severity === monaco.MarkerSeverity.Warning).length,
    infos: all.filter(m => m.severity <= monaco.MarkerSeverity.Info).length,
  };
}

let filter, list;

export function renderProblems(container) {
  list = h('div.problems-list', { tabindex: '0' });
  container.append(list);
  draw();
}

// The filter box VS Code shows in the panel title while PROBLEMS is active.
export function problemsWidget() {
  if (!filter) {
    filter = h('input.panel-filter', { type: 'text', placeholder: 'Filter (e.g. text, **/*.go, !**/node_modules/**)', spellcheck: false, 'aria-label': 'Filter Problems' });
    filter.addEventListener('input', debounce(draw, 100));
  }
  return h('div.panel-filter-box', filter, icon('filter', 'panel-filter-icon'));
}

export const problemsActions = () => [
  { icon: 'collapse-all', title: 'Collapse All', run: () => { for (const m of monaco.editor.getModelMarkers({})) { const p = pathOfUri(m.resource); if (p) collapsed.add(p); } draw(); } },
];

const collapsed = new Set();

function draw() {
  if (!list) return;
  const q = (filter?.value || '').toLowerCase();
  const byFile = new Map();
  for (const m of monaco.editor.getModelMarkers({})) {
    const path = pathOfUri(m.resource);
    if (!path) continue;
    if (q && !(m.message + ' ' + path).toLowerCase().includes(q)) continue;
    if (!byFile.has(path)) byFile.set(path, []);
    byFile.get(path).push(m);
  }
  const rows = [];
  for (const [path, ms] of [...byFile].sort((a, b) => a[0].localeCompare(b[0]))) {
    ms.sort((a, b) => b.severity - a.severity || a.startLineNumber - b.startLineNumber);
    const col = collapsed.has(path);
    const fr = h('div.list-row.problem-file', icon(col ? 'chevron-right' : 'chevron-down', 'twistie-icon'), fileIcon(path),
      h('span.row-name', basename(path)), h('span.row-desc', dirname(path)), h('span.badge', String(ms.length)));
    fr.addEventListener('click', () => { if (col) collapsed.delete(path); else collapsed.add(path); draw(); });
    rows.push(fr);
    if (col) continue;
    for (const m of ms) {
      const [ic, cls] = SEV_ICON[m.severity] || SEV_ICON[2];
      const r = h('div.list-row.problem-row', icon(ic, cls), h('span.problem-msg', m.message),
        h('span.problem-src', [m.source, m.code && (typeof m.code === 'object' ? m.code.value : m.code)].filter(Boolean).join('(') + (m.code ? ')' : '')),
        h('span.problem-pos', `[Ln ${m.startLineNumber}, Col ${m.startColumn}]`));
      r.addEventListener('click', () => openFile(path, { line: m.startLineNumber, col: m.startColumn, endLine: m.endLineNumber, endCol: m.endColumn }));
      rows.push(r);
    }
  }
  if (!rows.length) rows.push(h('div.panel-message', q ? 'No results found with provided filter criteria.' : 'No problems have been detected in the workspace.'));
  list.replaceChildren(...rows);
}

export function initProblems() {
  monaco.editor.onDidChangeMarkers(debounce(() => { draw(); emit('problems:changed', problemCounts()); emit('badges:changed'); }, 100));
}
