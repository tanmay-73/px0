// web/src/statusbar.js
// Status bar items, as VS Code arranges them. Left: the workspace (opens the
// repository switcher under the workbench), branch, sync, problems. Right:
// cursor position, indentation, line endings, language, language server, CPU
// and memory.
import { S, api } from './api.js';
import { h, icon, on, keyLabel, formatBytes } from './util.js';
import { statusItem, showPanel } from './layout.js';
import { G, sync, refreshGit } from './git.js';
import { activeEditor, activeTab } from './editors.js';
import { problemCounts } from './problems.js';
import { lspState } from './lsp.js';
import { run } from './commands.js';
import { languageName, monaco } from './monaco.js';
import { showMenuAt, notificationState, toggleNotificationCenter } from './ui.js';
import { quickPick } from './quickinput.js';

export function initStatusBar() {
  const remote = statusItem({ id: 'remote', side: 'left', priority: 100, cls: 'status-remote', title: 'Switch repository', run: () => run('px0.switchRepository') });
  const branch = statusItem({ id: 'branch', side: 'left', priority: 90, run: el => branchMenu(el) });
  const syncEl = statusItem({ id: 'sync', side: 'left', priority: 80, title: 'Synchronize Changes', run: () => sync() });
  const problems = statusItem({ id: 'problems', side: 'left', priority: 70, title: 'No Problems', run: () => showPanel('problems') });
  const chord = statusItem({ id: 'chord', side: 'left', priority: 10 });
  const busy = statusItem({ id: 'busy', side: 'left', priority: 5 });

  const bell = statusItem({ id: 'notifications', side: 'right', priority: 0, title: 'Notifications', run: () => toggleNotificationCenter() });
  const metrics = statusItem({ id: 'metrics', side: 'right', priority: 10, title: 'px0 process CPU and memory' });
  const lsp = statusItem({ id: 'lsp', side: 'right', priority: 20 });
  const lang = statusItem({ id: 'lang', side: 'right', priority: 30, title: 'Select Language Mode', run: () => pickLanguage() });
  const eol = statusItem({ id: 'eol', side: 'right', priority: 40, title: 'Select End of Line Sequence', run: () => pickEol() });
  const encoding = statusItem({ id: 'encoding', side: 'right', priority: 45, title: 'Select Encoding' });
  const indent = statusItem({ id: 'indent', side: 'right', priority: 50, title: 'Select Indentation', run: () => pickIndent() });
  const cursor = statusItem({ id: 'cursor', side: 'right', priority: 60, title: 'Go to Line/Column', run: () => run('workbench.action.gotoLine') });

  // Like VS Code's remote indicator: just the icon locally; under the
  // workbench it names the repository it switches from.
  remote.replaceChildren(icon('remote'), ...(S.meta?.workbench ? [h('span.status-label', S.meta?.name || 'px0')] : []));
  remote.title = S.meta?.workbench ? `${S.meta.root} — Switch Repository (${keyLabel('Alt+O')})` : S.meta?.root || '';

  const drawGit = () => {
    branch.hidden = !G.git;
    syncEl.hidden = !G.git;
    if (!G.git) return;
    // As VS Code: * for unstaged changes, + for staged ones.
    const marks = (G.changes.length + G.conflicts.length ? '*' : '') + (G.staged.length ? '+' : '');
    // VS Code's branch icon shows whether there are changes, staged ones or conflicts.
    const branchIcon = G.operation ? 'git-merge' : G.conflicts.length ? 'git-branch-conflicts' : G.staged.length ? 'git-branch-staged-changes' : G.changes.length ? 'git-branch-changes' : 'git-branch';
    branch.replaceChildren(icon(branchIcon), (G.branch || (G.detached ? G.head : '')) + marks + (G.operation ? ` (${G.operation.toUpperCase()})` : ''));
    branch.title = `${G.branch || G.head}${G.upstream ? ' → ' + G.upstream : ''}`;
    syncEl.replaceChildren(icon(G.busy === 'push' || G.busy === 'pull' ? 'sync~spin' : G.upstream ? 'sync' : 'cloud-upload'),
      G.upstream && (G.ahead || G.behind) ? `${G.behind}↓ ${G.ahead}↑` : '');
    syncEl.title = G.upstream ? `Synchronize Changes (pull ${G.behind}, push ${G.ahead})` : 'Publish Branch';
    busy.replaceChildren(...(G.busy ? [icon('loading~spin'), 'git ' + G.busy] : []));
  };
  const drawProblems = () => {
    const c = problemCounts();
    problems.replaceChildren(icon('error'), String(c.errors), icon('warning'), String(c.warnings), ...(c.infos ? [icon('info'), String(c.infos)] : []));
    problems.title = `Errors: ${c.errors}, Warnings: ${c.warnings}, Infos: ${c.infos}`;
  };
  const drawEditor = () => {
    const ed = activeEditor();
    const t = activeTab();
    const model = ed?.getModel();
    for (const el of [cursor, indent, eol, lang, encoding]) el.hidden = !model;
    encoding.textContent = 'UTF-8';
    if (!model) { lsp.hidden = true; return; }
    const sel = ed.getSelection();
    const pos = ed.getPosition();
    const selected = sel && !sel.isEmpty() ? model.getValueInRange(sel).length : 0;
    cursor.textContent = `Ln ${pos?.lineNumber || 1}, Col ${pos?.column || 1}${selected ? ` (${selected} selected)` : ''}`;
    const opts = model.getOptions();
    indent.textContent = (opts.insertSpaces ? 'Spaces: ' : 'Tab Size: ') + opts.tabSize;
    eol.textContent = model.getEOL() === '\r\n' ? 'CRLF' : 'LF';
    lang.textContent = languageName(model.getLanguageId());
    const st = t?.path ? lspState(t.path) : null;
    lsp.hidden = !st || st.state === 'off';
    if (st && st.state !== 'off') {
      const ic = { ready: 'check-all', starting: 'loading~spin', indexing: 'loading~spin', failed: 'error' }[st.state] || 'circle-outline';
      lsp.replaceChildren(icon(ic), st.server || 'LSP');
      lsp.title = `${st.server || 'Language server'}: ${st.state}`;
    }
  };
  const drawMetrics = m => {
    if (!m) return;
    metrics.textContent = `${Number(m.cpuUsage || 0).toFixed(1)}% · ${formatBytes(m.rssBytes || 0)}${m.lspMemBytes ? ' + LSP ' + formatBytes(m.lspMemBytes) : ''}`;
  };

  const drawBell = () => {
    const n = notificationState();
    bell.replaceChildren(icon(n.doNotDisturb ? 'bell-slash' : n.unread ? 'bell-dot' : 'bell'));
    bell.title = n.doNotDisturb ? 'Do Not Disturb' : n.unread ? `${n.unread} New Notification${n.unread > 1 ? 's' : ''}` : 'No Notifications';
  };
  on('notifications:changed', drawBell);
  drawBell();
  on('git:changed', drawGit);
  on('git:busy', drawGit);
  on('problems:changed', drawProblems);
  on('editor:active', drawEditor);
  on('editor:cursor', drawEditor);
  on('lsp:state', drawEditor);
  on('stream:metrics', drawMetrics);
  on('status:chord', c => { chord.textContent = c ? `(${keyLabel(c)}) was pressed. Waiting for second key of chord...` : ''; });
  drawGit();
  drawProblems();
  drawEditor();
  if (S.meta?.metrics) drawMetrics(S.meta.metrics);
}

function branchMenu(el) {
  showMenuAt([
    { label: 'Pull', disabled: !G.upstream, run: () => run('git.pull') },
    { label: 'Push', run: () => run('git.push') },
    { label: 'Sync', run: () => run('git.sync') },
    { separator: true },
    { label: 'Copy Branch Name', run: () => navigator.clipboard?.writeText(G.branch) },
    { label: 'Refresh', run: refreshGit },
  ], el);
}

function pickLanguage() {
  const ed = activeEditor();
  const model = ed?.getModel();
  if (!model) return;
  const cur = model.getLanguageId();
  quickPick({
    placeholder: 'Select Language Mode',
    items: monaco.languages.getLanguages().map(l => ({ label: (l.aliases && l.aliases[0]) || l.id, description: `(${l.id})`, id: l.id, picked: l.id === cur }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    onAccept: it => monaco.editor.setModelLanguage(model, it.id),
  });
}

function pickEol() {
  const model = activeEditor()?.getModel();
  if (!model) return;
  quickPick({
    placeholder: 'Select End of Line Sequence',
    items: [{ label: 'LF', v: 0 }, { label: 'CRLF', v: 1 }],
    onAccept: it => model.pushEOL(it.v ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF),
  });
}

function pickIndent() {
  const model = activeEditor()?.getModel();
  if (!model) return;
  const items = [
    { label: 'Indent Using Spaces', f: () => pickSize(true) },
    { label: 'Indent Using Tabs', f: () => pickSize(false) },
    { label: 'Detect Indentation from Content', f: () => run('editor.action.detectIndentation') },
    { label: 'Convert Indentation to Spaces', f: () => activeEditor()?.trigger('px0', 'editor.action.indentationToSpaces') },
    { label: 'Convert Indentation to Tabs', f: () => activeEditor()?.trigger('px0', 'editor.action.indentationToTabs') },
  ];
  const pickSize = spaces => quickPick({
    placeholder: 'Select Tab Size for the Current File',
    items: [1, 2, 3, 4, 5, 6, 7, 8].map(n => ({ label: String(n), n, picked: model.getOptions().tabSize === n })),
    onAccept: it => model.updateOptions({ tabSize: it.n, insertSpaces: spaces }),
  });
  quickPick({ placeholder: 'Select Action', items, onAccept: it => { setTimeout(it.f, 0); } });
}

export async function refreshMetricsOnce() {
  try { const m = await api('api/metrics'); return m; } catch { return null; }
}
