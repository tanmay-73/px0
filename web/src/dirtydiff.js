// web/src/dirtydiff.js
// VS Code's quick diff: bars in the editor gutter for lines added (green),
// changed (blue) and removed (red marker) relative to the file in the git
// index, updated as you type. Clicking a bar opens the file's changes.
import { monaco } from './monaco.js';
import { on, debounce } from './util.js';
import { pathOfUri, originalModel } from './models.js';
import { G } from './git.js';
import { S } from './api.js';
import { run } from './commands.js';
import { diffLines } from './linediff.js';

const MAX_LINES = 20000;

function decorationsFor(hunks) {
  const out = [];
  for (const h of hunks) {
    const mod = Math.min(h.aLen, h.bLen);
    for (let i = 0; i < h.bLen; i++) {
      const line = h.b + i + 1;
      const cls = i < mod ? 'dd-modified' : 'dd-added';
      out.push({ range: new monaco.Range(line, 1, line, 1), options: { linesDecorationsClassName: cls, overviewRuler: { color: i < mod ? 'rgba(80,140,230,.6)' : 'rgba(90,180,90,.6)', position: monaco.editor.OverviewRulerLane.Left } } });
    }
    if (!h.bLen) {
      const line = Math.max(1, h.b);
      out.push({ range: new monaco.Range(line, 1, line, 1), options: { linesDecorationsClassName: h.b === 0 ? 'dd-deleted-top' : 'dd-deleted', overviewRuler: { color: 'rgba(220,80,80,.6)', position: monaco.editor.OverviewRulerLane.Left } } });
    }
  }
  return out;
}

function attach(editor) {
  let coll = editor.createDecorationsCollection();
  let seq = 0;
  const update = debounce(async () => {
    const model = editor.getModel();
    const path = model && pathOfUri(model.uri);
    const my = ++seq;
    if (!path || !S.meta?.git || !G.git || path.startsWith('/') || model.getLineCount() > MAX_LINES || !G.byPath.has(path) || G.byPath.get(path).untracked) {
      coll.clear();
      return;
    }
    let orig;
    try { orig = await originalModel(path, 'INDEX'); } catch { coll.clear(); return; }
    if (my !== seq || editor.getModel() !== model || model.isDisposed()) return;
    if (!orig.exists) { coll.clear(); return; }
    const hunks = diffLines(orig.model.getLinesContent(), model.getLinesContent());
    if (my !== seq) return;
    coll.set(hunks ? decorationsFor(hunks) : []);
  }, 250);
  editor.onDidChangeModel(update);
  editor.onDidChangeModelContent(update);
  editor.onMouseDown(e => {
    if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS) return;
    const cls = e.target.element?.className || '';
    if (!/dd-(added|modified|deleted)/.test(cls)) return;
    const path = pathOfUri(editor.getModel().uri);
    if (path) run('git.openChange', path, e.target.position?.lineNumber);
  });
  on('git:changed', update);
  on('git:after-op', async () => {
    const model = editor.getModel();
    const path = model && pathOfUri(model.uri);
    if (path) await originalModel(path, 'INDEX', { refresh: true }).catch(() => {});
    update();
  });
  update();
}

export function initDirtyDiff() {
  // Only plain code editors: a diff editor shows the changes already.
  on('editor:created', ed => { if (!ed.getContainerDomNode().closest('.diff-host')) attach(ed); });
}
