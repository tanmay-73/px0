// web/src/actions.js
// Every command the workbench offers, with VS Code's names and (where the
// browser lets us have them) VS Code's keybindings. Browsers keep Ctrl+W,
// Ctrl+T, Ctrl+N and Ctrl+Tab for themselves, so closing a tab is Alt+W and
// switching tabs Alt+1..9 / Ctrl+Alt+Left/Right.
import { S, inWorkbench, wbURL } from './api.js';
import { registerAll, run, allCommands } from './commands.js';
import { basename, dirname, on, keyLabel, h, icon, isMac } from './util.js';
import { notify, confirm } from './ui.js';
import { quickPick, inputBox } from './quickinput.js';
import { activeTab, activeEditor, activeDiffEditor, openFile, openDiff, openView, closeTab, closeTabs, allTabs, splitTab, nextTab, openTabAt, getGroups, updateAllEditorOptions, keepActiveOpen, groupOf, focusGroup } from './editors.js';
import { save, revert, isDirty, allDocs } from './models.js';
import { showView, showPanel, setSidebarVisible, isSidebarVisible, setPanelVisible, isPanelVisible, activeViewId, setAuxVisible, isAuxVisible, customizeLayout, togglePanelMaximized, setActivityBarVisible, setStatusBarVisible } from './layout.js';
import { connectForge } from './pr.js';
import { showTerminal, toggleTerminal, killTerminal, clearTerminal, renameTerminal, findInTerminal, isTerminalFocused } from './terminal.js';
import { toggleNotificationCenter, clearNotifications, toggleDoNotDisturb } from './ui.js';
import { showQuickOpen, pickFile } from './palette.js';
import { listThemes, currentTheme, setTheme } from './theme.js';
import { setting, updateSetting } from './settings.js';
import { G, stageAll, unstageAll, stage, unstage, discard, push, pull, sync, refreshGit } from './git.js';
import { openChangeOf, focusCommitInput } from './scm.js';
import { reveal, newFile, newFolder, renamePath, deletePath, focusExplorer, selectedPath } from './explorer.js';
import { focusSearch } from './search.js';
import { selectForCompare, compareWithSelected, compareFiles } from './compare.js';
import { pickRepository, openInWorkbench } from './repos.js';
import { openMarkdownPreview, isMarkdownPath } from './previews.js';
import { monaco } from './monaco.js';
import { initAutoSave } from './autosave.js';

const activePath = () => {
  const t = activeTab();
  return t?.kind === 'file' || t?.kind === 'diff' ? t.path : t?.path || '';
};
const absPath = p => (p.startsWith('/') ? p : (S.meta?.root || '').replace(/\/$/, '') + '/' + p);
const copy = (text, what) => navigator.clipboard?.writeText(text).then(() => notify(`Copied ${what}`, { timeout: 1500 }), () => notify('Could not copy to the clipboard', { severity: 'error' }));

/* ---------- save ---------- */

async function saveActive() {
  const t = activeTab();
  if (!t) return;
  if (t.save) return t.save();
  const d = t.doc;
  if (d) {
    t.preview = false;
    await save(d);
  }
}

async function saveAll() {
  for (const d of allDocs()) if (isDirty(d)) await save(d);
}

/* ---------- navigation history (Alt+Left / Alt+Right) ---------- */

const back = [];
const fwd = [];
let navigating = false;

function here() {
  const t = activeTab();
  const ed = activeEditor();
  if (!t || t.kind !== 'file') return null;
  return { path: t.path, line: ed?.getPosition()?.lineNumber || 1, col: ed?.getPosition()?.column || 1 };
}

function noteLocation(loc) {
  if (navigating || !loc) return;
  const last = back[back.length - 1];
  if (last && last.path === loc.path && Math.abs(last.line - loc.line) < 10) { back[back.length - 1] = loc; return; }
  back.push(loc);
  if (back.length > 60) back.shift();
  fwd.length = 0;
}

async function navigate(from, to) {
  const target = from.pop();
  if (!target) return;
  const cur = here();
  if (cur) to.push(cur);
  navigating = true;
  try { await openFile(target.path, { line: target.line, col: target.col }); } finally { setTimeout(() => { navigating = false; }, 50); }
}

/* ---------- pickers ---------- */

function pickTheme() {
  const before = currentTheme();
  quickPick({
    placeholder: 'Select Color Theme (Up/Down Keys to Preview)',
    items: [
      { separator: true, label: 'dark themes' },
      ...listThemes().filter(t => t.scheme !== 'light').map(t => ({ label: t.name, id: t.id, picked: t.id === before })),
      { separator: true, label: 'light themes' },
      ...listThemes().filter(t => t.scheme === 'light').map(t => ({ label: t.name, id: t.id, picked: t.id === before })),
    ],
    onActive: it => it.id && setTheme(it.id, false),
    onAccept: it => setTheme(it.id, true, id => updateSetting('workbench.colorTheme', id)),
    onCancel: () => setTheme(before, false),
  });
}

async function compareActiveWith() {
  const cur = activePath();
  if (!cur) { notify('Open a file first.'); return; }
  const other = await pickFile(`Select a file to compare with '${basename(cur)}'`);
  if (other) compareFiles(other, cur);
}

async function newFileCommand() {
  if (activeViewId() === 'explorer' && isSidebarVisible()) { newFile(); return; }
  const dir = dirname(activePath() || '');
  const name = await inputBox({ prompt: 'Enter the path of the new file, relative to the workspace', value: dir ? dir + '/' : '', selection: [dir.length + 1, dir.length + 1] });
  if (!name) return;
  const { post } = await import('./api.js');
  try {
    await post('api/fs/new', { path: name.replace(/^\/+/, ''), type: 'file' });
    await openFile(name.replace(/^\/+/, ''));
    reveal(name);
  } catch (e) { notify(e.message, { severity: 'error' }); }
}

/* ---------- keyboard shortcuts view ---------- */

function renderKeybindings(t, root) {
  root.classList.add('keybindings-view');
  const filter = h('input.view-filter', { type: 'text', placeholder: 'Type to search in keybindings', spellcheck: false });
  const table = h('table.kb-table');
  const draw = () => {
    const q = filter.value.toLowerCase();
    const rows = allCommands().map(c => ({ title: (c.category ? c.category + ': ' : '') + c.title, keys: c.keys || [], id: c.id }))
      .filter(c => !q || (c.title + ' ' + c.id + ' ' + c.keys.map(keyLabel).join(' ')).toLowerCase().includes(q))
      .sort((a, b) => (b.keys.length - a.keys.length) || a.title.localeCompare(b.title));
    table.replaceChildren(h('thead', h('tr', h('th', 'Command'), h('th', 'Keybinding'), h('th', 'Command ID'))),
      h('tbody', rows.map(c => h('tr', { on: { dblclick: () => run(c.id) } }, h('td', c.title), h('td', c.keys.map(k => h('kbd', keyLabel(k)))), h('td.kb-id', c.id)))));
  };
  filter.addEventListener('input', draw);
  root.append(h('div.kb-header', filter), h('div.kb-scroll', table));
  draw();
  setTimeout(() => filter.focus(), 0);
}

export function initActions() {
  const fileOrActive = p => (typeof p === 'string' ? p : activePath());
  const onEditor = () => !!activeEditor();
  registerAll([
    // Quick access
    { id: 'workbench.action.quickOpen', title: 'Go to File...', keys: ['Mod+P', 'Mod+E'], global: true, terminal: ['Mod+P'], run: () => showQuickOpen('') },
    { id: 'workbench.action.showCommands', title: 'Show All Commands', keys: ['Mod+Shift+P', 'F1'], global: true, terminal: true, run: () => showQuickOpen('>') },
    { id: 'workbench.action.gotoLine', title: 'Go to Line/Column...', keys: ['Mod+G'], run: () => showQuickOpen(':') },
    { id: 'workbench.action.gotoSymbol', title: 'Go to Symbol in Editor...', keys: ['Mod+Shift+O'], run: () => showQuickOpen('@') },
    { id: 'workbench.action.navigateBack', title: 'Go Back', category: 'Go', keys: ['Alt+ArrowLeft', 'Mod+Alt+-'], run: () => navigate(back, fwd) },
    { id: 'workbench.action.navigateForward', title: 'Go Forward', category: 'Go', keys: ['Alt+ArrowRight', 'Mod+Shift+-'], run: () => navigate(fwd, back) },

    // Files
    { id: 'workbench.action.files.save', title: 'Save', category: 'File', keys: ['Mod+S'], global: true, run: saveActive },
    { id: 'workbench.action.files.saveAll', title: 'Save All', category: 'File', keys: ['Mod+Alt+S'], global: true, run: saveAll },
    { id: 'workbench.action.toggleAutoSave', title: 'Auto Save', category: 'File', run: () => updateSetting('files.autoSave', ['afterDelay', 'onFocusChange'].includes(setting('files.autoSave', 'off')) ? 'off' : 'afterDelay') },
    { id: 'workbench.action.files.revert', title: 'Revert File', category: 'File', run: async () => { const d = activeTab()?.doc; if (d) await revert(d); } },
    { id: 'workbench.action.files.newUntitledFile', title: 'New File...', category: 'File', keys: ['Mod+Alt+N'], run: newFileCommand },
    { id: 'explorer.newFolder', title: 'New Folder...', category: 'File', run: () => { showView('explorer'); newFolder(); } },
    { id: 'renameFile', title: 'Rename...', category: 'File', keys: ['F2'], when: () => document.activeElement?.closest?.('.tree'), run: () => renamePath() },
    { id: 'deleteFile', title: 'Delete', category: 'File', keys: ['Delete'], hidden: true, when: () => document.activeElement?.closest?.('.tree'), run: () => selectedPath() && deletePath(selectedPath()) },
    { id: 'copyFilePath', title: 'Copy Path of Active File', category: 'File', keys: ['Shift+Alt+C'], run: p => { const x = fileOrActive(p); if (x) copy(absPath(x), 'path'); } },
    { id: 'copyRelativeFilePath', title: 'Copy Relative Path of Active File', category: 'File', keys: ['Mod+K Mod+Shift+Alt+C'], run: p => { const x = fileOrActive(p); if (x) copy(x, 'relative path'); } },
    { id: 'workbench.files.action.showActiveFileInExplorer', title: 'Reveal Active File in Explorer View', category: 'File', run: p => { const x = fileOrActive(p); if (!x) return; showView('explorer', { focus: false }); reveal(x, { focus: true }); } },
    { id: 'selectForCompare', title: 'Select for Compare', category: 'File', run: p => { const x = fileOrActive(p); if (x) { selectForCompare(x); notify(`Selected '${basename(x)}' for compare.`, { timeout: 2000 }); } } },
    { id: 'compareSelected', title: 'Compare Active File with Selected', category: 'File', run: p => compareWithSelected(fileOrActive(p)) },
    { id: 'workbench.files.action.compareFileWith', title: 'Compare Active File With...', category: 'File', run: compareActiveWith },

    // Editors
    { id: 'workbench.action.closeActiveEditor', title: 'Close Editor', category: 'View', keys: ['Alt+W', 'Mod+F4'], global: true, run: () => { const t = activeTab(); if (t) closeTab(t); } },
    { id: 'workbench.action.closeAllEditors', title: 'Close All Editors', category: 'View', keys: ['Mod+K Mod+W', 'Alt+Shift+W'], run: () => closeTabs(allTabs()) },
    { id: 'workbench.action.closeOtherEditors', title: 'Close Other Editors in Group', category: 'View', run: () => { const t = activeTab(); const g = groupOf(t); if (g) closeTabs(g.tabs.filter(x => x !== t)); } },
    { id: 'workbench.action.reopenClosedEditor', title: 'Reopen Closed Editor', category: 'View', keys: ['Alt+Shift+T'], run: () => { const p = closed.pop(); if (p) openFile(p); } },
    { id: 'workbench.action.keepEditor', title: 'Keep Editor', category: 'View', keys: ['Mod+K Enter'], run: keepActiveOpen },
    { id: 'workbench.action.nextEditor', title: 'Open Next Editor', category: 'View', keys: ['Mod+Alt+ArrowRight', 'Ctrl+PageDown'], run: () => nextTab(1) },
    { id: 'workbench.action.previousEditor', title: 'Open Previous Editor', category: 'View', keys: ['Mod+Alt+ArrowLeft', 'Ctrl+PageUp'], run: () => nextTab(-1) },
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => ({ id: 'workbench.action.openEditorAtIndex' + n, title: `Open Editor at Index ${n}`, hidden: true, keys: ['Alt+' + n], run: () => openTabAt(n) })),
    { id: 'workbench.action.splitEditor', title: 'Split Editor', category: 'View', keys: ['Mod+\\'], run: () => splitTab() },
    { id: 'workbench.action.focusNextGroup', title: 'Focus Next Editor Group', category: 'View', run: () => { const gs = getGroups(); const i = gs.findIndex(g => g.tabs.includes(activeTab())); focusGroup(gs[(i + 1) % gs.length]); } },
    { id: 'editor.action.toggleWordWrap', title: 'Toggle Word Wrap', category: 'View', keys: ['Alt+Z'], run: () => updateSetting('editor.wordWrap', setting('editor.wordWrap', 'off') === 'off' ? 'on' : 'off').then(updateAllEditorOptions) },
    { id: 'editor.action.toggleMinimap', title: 'Toggle Minimap', category: 'View', run: () => updateSetting('editor.minimap.enabled', setting('editor.minimap.enabled', true) === false).then(updateAllEditorOptions) },
    { id: 'editor.action.toggleRenderWhitespace', title: 'Toggle Render Whitespace', category: 'View', run: () => updateSetting('editor.renderWhitespace', setting('editor.renderWhitespace', 'selection') === 'all' ? 'selection' : 'all').then(updateAllEditorOptions) },
    { id: 'toggle.diff.renderSideBySide', title: 'Toggle Inline View', category: 'Diff Editor', run: () => updateSetting('diffEditor.renderSideBySide', setting('diffEditor.renderSideBySide', true) === false).then(updateAllEditorOptions) },
    { id: 'diffEditor.toggleIgnoreTrimWhitespace', title: 'Toggle Ignore Trim Whitespace', category: 'Diff Editor', run: () => updateSetting('diffEditor.ignoreTrimWhitespace', setting('diffEditor.ignoreTrimWhitespace', true) === false).then(updateAllEditorOptions) },
    { id: 'workbench.action.editor.nextChange', title: 'Go to Next Change', category: 'Diff Editor', keys: ['Alt+F5'], run: () => activeDiffEditor()?.goToDiff('next') },
    { id: 'workbench.action.editor.previousChange', title: 'Go to Previous Change', category: 'Diff Editor', keys: ['Shift+Alt+F5'], run: () => activeDiffEditor()?.goToDiff('previous') },

    // Layout and views
    { id: 'workbench.action.toggleSidebarVisibility', title: 'Toggle Primary Side Bar Visibility', category: 'View', keys: ['Mod+B'], run: () => setSidebarVisible(!isSidebarVisible()) },
    { id: 'workbench.action.togglePanel', title: 'Toggle Panel Visibility', category: 'View', keys: ['Mod+J'], terminal: true, run: () => (isPanelVisible() ? setPanelVisible(false) : showPanel()) },
    { id: 'workbench.view.explorer', title: 'Show Explorer', category: 'View', keys: ['Mod+Shift+E'], terminal: true, run: () => { showView('explorer'); focusExplorer(); } },
    { id: 'workbench.view.search', title: 'Show Search', category: 'View', keys: ['Mod+Shift+F'], global: true, terminal: true, run: () => { const sel = activeEditor()?.getModel() && activeEditor().getModel().getValueInRange(activeEditor().getSelection()); showView('search'); focusSearch({ query: sel && !sel.includes('\n') ? sel : undefined }); } },
    { id: 'workbench.action.findInFiles', title: 'Find in Files', category: 'Search', hidden: true, run: (args = {}) => { showView('search'); focusSearch(args); } },
    { id: 'workbench.view.scm', title: 'Show Source Control', category: 'View', keys: ['Mod+Shift+G'], terminal: true, run: () => { showView('scm'); focusCommitInput(); } },
    { id: 'workbench.view.repos', title: 'Show Repositories', category: 'View', run: () => showView('repos') },
    { id: 'workbench.actions.view.problems', title: 'Show Problems', category: 'View', keys: ['Mod+Shift+M'], terminal: true, run: () => showPanel('problems', { focus: true }) },
    // Terminal (terminal.js)
    { id: 'workbench.action.terminal.toggleTerminal', title: 'Toggle Terminal', category: 'View', keys: [isMac ? 'Ctrl+`' : 'Mod+`'], global: true, terminal: true, run: toggleTerminal },
    { id: 'workbench.action.terminal.new', title: 'Create New Terminal', category: 'Terminal', keys: [isMac ? 'Ctrl+Shift+`' : 'Mod+Shift+`'], global: true, terminal: true, run: () => showTerminal({ create: true }) },
    { id: 'workbench.action.terminal.split', title: 'Split Terminal', category: 'Terminal', keys: [isMac ? 'Mod+\\' : 'Mod+Shift+5'], terminal: true, when: () => !isMac || isTerminalFocused(), run: () => showTerminal({ create: true, split: true }) },
    { id: 'workbench.action.terminal.kill', title: 'Kill the Active Terminal Instance', category: 'Terminal', terminal: true, run: () => killTerminal() },
    { id: 'workbench.action.terminal.focus', title: 'Focus Terminal', category: 'Terminal', run: () => showTerminal() },
    { id: 'workbench.action.terminal.clear', title: 'Clear', category: 'Terminal', run: () => clearTerminal() },
    { id: 'workbench.action.terminal.rename', title: 'Rename...', category: 'Terminal', run: () => renameTerminal() },
    { id: 'workbench.action.terminal.focusFind', title: 'Focus Find', category: 'Terminal', run: () => findInTerminal() },
    { id: 'workbench.action.terminal.newWithCwd', title: 'Open in Integrated Terminal', hidden: true, run: cwd => showTerminal({ create: true, cwd }) },
    { id: 'workbench.action.output.toggleOutput', title: 'Toggle Output', category: 'View', keys: ['Mod+K Mod+H'], run: () => showPanel('output', { focus: true }) },
    { id: 'workbench.action.toggleAuxiliaryBar', title: 'Toggle Secondary Side Bar Visibility', category: 'View', keys: ['Mod+Alt+B'], run: () => setAuxVisible(!isAuxVisible()) },
    { id: 'workbench.action.toggleMaximizedPanel', title: 'Toggle Maximized Panel', category: 'View', run: togglePanelMaximized },
    { id: 'workbench.action.customizeLayout', title: 'Customize Layout...', category: 'View', run: customizeLayout },
    { id: 'workbench.action.toggleActivityBarVisibility', title: 'Toggle Activity Bar Visibility', category: 'View', run: () => setActivityBarVisible(document.querySelector('.activitybar')?.hidden) },
    { id: 'workbench.action.toggleStatusbarVisibility', title: 'Toggle Status Bar Visibility', category: 'View', run: () => setStatusBarVisible(document.querySelector('.statusbar')?.hidden) },
    { id: 'notifications.toggleList', title: 'Toggle Notifications', category: 'Notifications', run: () => toggleNotificationCenter() },
    { id: 'notifications.clearAll', title: 'Clear All Notifications', category: 'Notifications', run: clearNotifications },
    { id: 'notifications.toggleDoNotDisturbMode', title: 'Toggle Do Not Disturb Mode', category: 'Notifications', run: toggleDoNotDisturb },
    { id: 'px0.connectForge', title: 'Sign in to the Forge with a Token...', category: 'Accounts', run: connectForge },

    // Preferences
    { id: 'workbench.action.openSettings', title: 'Open Settings (UI)', category: 'Preferences', keys: ['Mod+,'], global: true, terminal: true, run: () => openView('settings', '', { key: 'settings', title: 'Settings', icon: 'settings-gear' }) },
    { id: 'workbench.action.openSettingsJson', title: 'Open User Settings (JSON)', category: 'Preferences', run: () => openView('settings-json', '', { key: 'settings.json', title: 'settings.json', icon: 'json' }) },
    { id: 'workbench.action.openGlobalKeybindings', title: 'Open Keyboard Shortcuts', category: 'Preferences', keys: ['Mod+K Mod+S'], global: true, run: () => openView('keybindings', '', { key: 'keybindings', title: 'Keyboard Shortcuts', icon: 'keyboard' }) },
    { id: 'workbench.action.selectTheme', title: 'Color Theme', category: 'Preferences', keys: ['Mod+K Mod+T'], global: true, run: pickTheme },

    // Markdown
    { id: 'markdown.showPreview', title: 'Open Preview', category: 'Markdown', keys: ['Mod+Shift+V'], when: () => isMarkdownPath(activePath() || ''), run: p => openMarkdownPreview(fileOrActive(p)) },
    { id: 'markdown.showPreviewToSide', title: 'Open Preview to the Side', category: 'Markdown', keys: ['Mod+K V'], when: () => isMarkdownPath(activePath() || ''), run: p => openMarkdownPreview(fileOrActive(p), { sideBySide: true }) },

    { id: 'px0.openTablePreview', title: 'Open Table Preview', category: 'View', when: () => /\.(csv|tsv)$/i.test(activePath() || ''), run: p => { const x = fileOrActive(p); if (x) openView('table', x, { title: 'Table ' + basename(x), icon: 'table' }); } },

    // Git
    { id: 'git.commit', title: 'Commit', category: 'Git', run: () => { showView('scm'); focusCommitInput(); } },
    { id: 'git.stageAll', title: 'Stage All Changes', category: 'Git', run: stageAll },
    { id: 'git.unstageAll', title: 'Unstage All Changes', category: 'Git', run: unstageAll },
    { id: 'git.stage', title: 'Stage Changes', category: 'Git', run: p => { const x = fileOrActive(p); if (x) stage([x]); } },
    { id: 'git.unstage', title: 'Unstage Changes', category: 'Git', run: p => { const x = fileOrActive(p); if (x) unstage([x]); } },
    { id: 'git.clean', title: 'Discard Changes', category: 'Git', run: async p => { const x = fileOrActive(p); if (!x) return; if (await confirm({ message: `Are you sure you want to discard changes in ${basename(x)}?`, detail: 'This is IRREVERSIBLE!', buttons: ['Discard File'] }) === 0) discard([x]); } },
    { id: 'git.openChange', title: 'Open Changes', category: 'Git', run: (p, line) => { const x = fileOrActive(p); if (x) openChangeOf(x)?.then?.(() => { if (line) activeEditor()?.revealLineInCenter(line); }); } },
    { id: 'git.openFile', title: 'Open File', category: 'Git', run: () => { const t = activeTab(); if (t?.kind === 'diff') openFile(t.path); } },
    { id: 'git.push', title: 'Push', category: 'Git', run: () => push() },
    { id: 'git.pull', title: 'Pull', category: 'Git', run: () => pull() },
    { id: 'git.sync', title: 'Sync', category: 'Git', run: () => sync() },
    { id: 'git.refresh', title: 'Refresh', category: 'Git', run: refreshGit },

    // Repositories (workbench)
    { id: 'px0.switchRepository', title: 'Switch Repository...', category: 'Workspace', keys: ['Alt+O'], run: pickRepository },
    { id: 'px0.openWorkbench', title: 'Open Workbench', category: 'Workspace', when: inWorkbench, run: () => { location.href = wbURL(''); } },
    { id: 'px0.openRepository', title: 'Open Repository', hidden: true, run: (path, newTab) => openInWorkbench({ target: path }, newTab) },
    { id: 'px0.activateTab', hidden: true, run: t => { const g = groupOf(t); if (g) { g.active = null; } if (t.kind === 'diff') openDiff({ path: t.path, left: t.left, right: t.right, title: t.title, group: g }); else openView(t.view, t.path, { group: g, key: t.key, title: t.title }); } },
    { id: 'workbench.action.reloadWindow', title: 'Reload Window', category: 'Developer', run: () => location.reload() },
  ]);
  on('editor:active', t => { if (t?.kind === 'file') noteLocation(here()); });
  on('editor:cursor', () => noteLocation(here()));
  on('editor:closed', t => { if (t?.kind === 'file' && t.path) { closed.push(t.path); if (closed.length > 30) closed.shift(); } });

  initAutoSave({ on, setting, allDocs, isDirty, save, window, document });
}

const closed = [];

export { renderKeybindings };
