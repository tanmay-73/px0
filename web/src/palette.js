// web/src/palette.js
// Quick Open (Ctrl+P) and the Command Palette (Ctrl+Shift+P): one box whose
// first character picks the mode, as in VS Code:
//   (none)  files, fuzzy-matched by the server (/api/find), recent first
//   >       commands
//   @       symbols in the active file
//   :       go to line[:column]
import { api } from './api.js';
import { basename, dirname, pref, setPref, on } from './util.js';
import { quickPick, highlight, fuzzy } from './quickinput.js';
import { allCommands, run } from './commands.js';
import { openFile, activeTab, activeEditor } from './editors.js';
import { documentSymbols } from './lsp.js';
import { fileIcon } from './icons.js';
import { monaco } from './monaco.js';

const RECENT_KEY = () => 'recentFiles:' + location.pathname;
const recentCmdKey = 'recentCommands';

function recentFiles() { return pref(RECENT_KEY(), []); }

export function noteRecentFile(path) {
  if (!path || path.startsWith('/')) return;
  const list = recentFiles().filter(p => p !== path);
  list.unshift(path);
  setPref(RECENT_KEY(), list.slice(0, 50));
}

function fileItem(path, pos) {
  const name = basename(path);
  const cut = path.length - name.length;
  return {
    label: name, path, icon: fileIcon(path),
    labelHTML: pos ? highlight(name, pos.filter(p => p >= cut).map(p => p - cut)) : undefined,
    descriptionHTML: pos ? highlight(dirname(path), pos.filter(p => p < cut - 1)) : undefined,
    description: dirname(path),
  };
}

async function fileItems(q) {
  if (!q) {
    const cur = activeTab()?.path;
    const rec = recentFiles().filter(p => p !== cur).slice(0, 20);
    return rec.length ? [{ separator: true, label: 'recently opened' }, ...rec.map(p => fileItem(p))] : [];
  }
  const j = await api('api/find', { q, limit: 100 });
  const items = (j.results || []).map(r => fileItem(r.path, r.pos));
  return items.length ? [{ separator: true, label: 'file results' }, ...items] : [];
}

function commandItems(q) {
  const recent = pref(recentCmdKey, []);
  const cmds = allCommands();
  const items = [];
  for (const c of cmds) {
    const label = (c.category ? c.category + ': ' : '') + c.title;
    const m = fuzzy(q, label);
    if (!m) continue;
    items.push({ label, labelHTML: highlight(label, m.pos), keys: c.keys?.[0], id: c.id, _score: m.score, _recent: recent.indexOf(c.id) });
  }
  if (!q) {
    const rec = items.filter(i => i._recent >= 0).sort((a, b) => a._recent - b._recent);
    const rest = items.filter(i => i._recent < 0).sort((a, b) => a.label.localeCompare(b.label));
    return [...(rec.length ? [{ separator: true, label: 'recently used' }] : []), ...rec, ...(rec.length ? [{ separator: true, label: 'other commands' }] : []), ...rest];
  }
  return items.sort((a, b) => b._score - a._score);
}

let symbolCache = { path: '', syms: [] };

async function symbolItems(q) {
  const t = activeTab();
  if (!t?.path || t.kind !== 'file') return [{ label: 'To go to a symbol, first open a text editor with symbol information.', disabled: true }];
  if (symbolCache.path !== t.path) symbolCache = { path: t.path, syms: await documentSymbols(t.path) };
  const out = [];
  for (const s of symbolCache.syms) {
    const m = fuzzy(q, s.name);
    if (!m) continue;
    out.push({ label: s.name, labelHTML: highlight(s.name, m.pos), description: s.kind + (s.detail ? ' ' + s.detail : ''), icon: 'symbol-' + symIcon(s.kind), line: s.line, _score: m.score });
  }
  if (q) out.sort((a, b) => b._score - a._score);
  return out.length ? out : [{ label: 'No matching symbols', disabled: true }];
}

const symIcon = k => ({ func: 'method', function: 'method', method: 'method', class: 'class', struct: 'structure', interface: 'interface', type: 'class', enum: 'enum', const: 'constant', var: 'variable', field: 'field', heading: 'string' }[(k || '').toLowerCase()] || 'field');

function lineItems(q) {
  const ed = activeEditor();
  const model = ed?.getModel();
  if (!model) return [{ label: 'Open a text editor first to go to a line.', disabled: true }];
  const [l, c] = q.split(/[:,]/).map(n => parseInt(n, 10));
  const total = model.getLineCount();
  if (!l) return [{ label: `Current Line: ${ed.getPosition().lineNumber}, Character: ${ed.getPosition().column}. Type a line number between 1 and ${total} to navigate to.`, disabled: true }];
  const line = Math.min(Math.max(1, l), total);
  return [{ label: `Go to line ${line}${c ? `, character ${c}` : ''}.`, line, col: c || 1 }];
}

/* showQuickOpen(prefix) opens the box seeded with a mode character. */
export function showQuickOpen(prefix = '') {
  let mode = '';
  const modeOf = v => (v.startsWith('>') ? '>' : v.startsWith('@') ? '@' : v.startsWith(':') ? ':' : '');
  quickPick({
    value: prefix,
    placeholder: 'Search files by name (append : to go to line or @ to go to symbol)',
    items: async v => {
      mode = modeOf(v);
      const q = mode ? v.slice(1).trim() : v.trim();
      if (mode === '>') return commandItems(q);
      if (mode === '@') return symbolItems(q);
      if (mode === ':') return lineItems(q);
      // "file.go:42" opens at a line.
      const at = /^(.*?):(\d+)(?::(\d+))?$/.exec(q);
      const items = await fileItems(at ? at[1] : q);
      if (at) for (const it of items) if (it.path) { it.line = +at[2]; it.col = at[3] ? +at[3] : 1; }
      return items;
    },
    emptyText: v => (modeOf(v) === '>' ? 'No matching commands' : 'No matching results'),
    onActive: it => {
      if (mode === '@' && it.line) activeEditor()?.revealLineInCenterIfOutsideViewport(it.line);
    },
    onAccept: async (it, { newTab }) => {
      if (it.disabled) return false;
      if (it.id) {
        const rec = pref(recentCmdKey, []).filter(x => x !== it.id);
        rec.unshift(it.id);
        setPref(recentCmdKey, rec.slice(0, 20));
        setTimeout(() => run(it.id), 0);
        return;
      }
      if (it.path) { await openFile(it.path, { line: it.line, col: it.col, sideBySide: newTab }); return; }
      if (it.line) {
        const ed = activeEditor();
        if (!ed) return;
        ed.setPosition({ lineNumber: it.line, column: it.col || 1 });
        ed.revealLineInCenter(it.line, monaco.editor.ScrollType.Smooth);
        ed.focus();
      }
    },
  });
}

export function initPalette() {
  on('editor:active', t => { if (t?.kind === 'file') noteRecentFile(t.path); symbolCache = { path: '', syms: [] }; });
  on('doc:saved', () => { symbolCache = { path: '', syms: [] }; });
}

// A picker for any file in the workspace, for commands that need one.
export function pickFile(placeholder) {
  return new Promise(resolve => {
    quickPick({
      placeholder,
      items: q => fileItems(q.trim()),
      onAccept: it => { if (!it.path) return false; resolve(it.path); },
      onCancel: () => resolve(null),
    });
  });
}
