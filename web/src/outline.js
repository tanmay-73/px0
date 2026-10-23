// web/src/outline.js
// Explorer's OUTLINE section: the active file's symbols as a tree, following
// the cursor; click a symbol to go to it.
import { h, icon, on, debounce } from './util.js';
import { activeTab, activeEditor, openFile } from './editors.js';
import { documentSymbols } from './lsp.js';

const KIND_ICON = {
  func: 'symbol-method', function: 'symbol-method', method: 'symbol-method', class: 'symbol-class', struct: 'symbol-structure',
  interface: 'symbol-interface', type: 'symbol-class', enum: 'symbol-enum', const: 'symbol-constant', constant: 'symbol-constant',
  var: 'symbol-variable', variable: 'symbol-variable', field: 'symbol-field', property: 'symbol-property', module: 'symbol-module',
  namespace: 'symbol-namespace', package: 'symbol-package', heading: 'symbol-string', section: 'symbol-string', key: 'symbol-key',
};

export function initOutline(p) {
  let syms = [];
  let path = '';
  let seq = 0;
  const draw = () => {
    const t = activeTab();
    if (!t || t.kind !== 'file') { p.body.replaceChildren(h('div.pane-empty', 'The active editor cannot provide outline information.')); return; }
    if (!syms.length) { p.body.replaceChildren(h('div.pane-empty', 'No symbols found in document \'' + t.path.split('/').pop() + '\'')); return; }
    const line = activeEditor()?.getPosition()?.lineNumber || 0;
    let cur = -1;
    syms.forEach((s, i) => { if (s.line <= line) cur = i; });
    p.body.replaceChildren(...syms.map((s, i) => h('div.outline-row' + (i === cur ? '.current' : ''), {
      style: { paddingLeft: 10 + Math.min(s.indent || 0, 8) * 10 + 'px' },
      on: { click: () => openFile(path, { line: s.line, col: 1 }) },
    }, icon(KIND_ICON[(s.kind || '').toLowerCase()] || 'symbol-field', 'outline-icon'), h('span.outline-name', s.name), s.detail ? h('span.outline-detail', s.detail) : null)));
  };
  const load = debounce(async () => {
    if (!p.expanded()) return;
    const t = activeTab();
    const my = ++seq;
    if (!t || t.kind !== 'file') { syms = []; draw(); return; }
    path = t.path;
    const list = await documentSymbols(t.path);
    if (my !== seq) return;
    syms = list;
    draw();
  }, 250);
  on('editor:active', load);
  on('doc:saved', load);
  on('editor:cursor', debounce(draw, 100));
  p.head.addEventListener('click', () => setTimeout(load, 0));
  load();
}
