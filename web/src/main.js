// web/src/main.js
// Boots the editor: reads /api/meta and settings, builds the workbench
// (layout.js), registers the views, panels, viewers and commands, connects the
// server's event stream, and restores the tabs open last time.
import { S, api, apiURL, inWorkbench, wbURL } from './api.js';
import { h, icon, emit, on, keyLabel, basename, isMac, debounce } from './util.js';
import { setTheme, initialTheme, DEFAULT_THEME } from './theme.js';
import { monaco, applyMonacoTheme } from './monaco.js';
// After Monaco's own codicon font, so the newer, larger one wins.
import '../../node_modules/@vscode/codicons/dist/codicon.css';
import '../../node_modules/@xterm/xterm/css/xterm.css';
// After the codicon stylesheet, so the workbench's icon sizes win ties.
import './css/app.css';
import './css/markdown.css';
import { buildLayout, registerView, registerPanel, drawActivityBar, showView, showPanel, setTitleCenter, setTitleLeft, layoutEls, initLayout, isPanelVisible, initialView, setAppMenu, setAccountsMenu, setAuxView, customizeLayout } from './layout.js';
import { initEditors, registerViewer, registerEditorAction, activeTab, activeEditor, restoreSession, openFile, updateAllEditorOptions, isTabDirty, allTabs, refreshWatermarks, refreshDiffs } from './editors.js';
import { loadSettings, renderSettingsEditor, saveRawSettings, setting } from './settings.js';
import { initGit, G, changeCount } from './git.js';
import { renderExplorer, initExplorer, explorerMenu } from './explorer.js';
import { renderSearch, initSearch, focusSearch } from './search.js';
import { renderScm, initScm, moreMenu } from './scm.js';
import { renderRepos, reloadReposView } from './repos.js';
import { renderProblems, initProblems, problemCounts, problemsWidget, problemsActions } from './problems.js';
import { initStatusBar } from './statusbar.js';
import { initLsp, warm } from './lsp.js';
import { initDirtyDiff } from './dirtydiff.js';
import { initPalette, showQuickOpen } from './palette.js';
import { initActions, renderKeybindings } from './actions.js';
import { initKeybindings, run, keysFor } from './commands.js';
import { isSidebarVisible, isAuxVisible } from './layout.js';
import { initPreviews, isMarkdownPath, isTablePath } from './previews.js';
import { initPR, renderPR, prActions } from './pr.js';
import { checkDisk } from './models.js';
import { initTooltips, notify, pane } from './ui.js';
import { renderOutput, outputWidget, outputActions, initOutput } from './output.js';
import { renderTerminal, terminalWidget, terminalActions, onTerminalShown, initTerminal } from './terminal.js';
import { initOutline } from './outline.js';

/* ---------- event stream ---------- */

let source = null;

function connectStream() {
  if (source) return;
  source = new EventSource(apiURL('api/stream'));
  source.addEventListener('git-status', () => emit('stream:git'));
  source.addEventListener('tree', () => emit('stream:tree'));
  source.addEventListener('metrics', e => { try { emit('stream:metrics', JSON.parse(e.data)); } catch {} });
  source.onerror = () => {
    source?.close();
    source = null;
    setTimeout(() => { if (!document.hidden) connectStream(); }, 3000);
  };
}

// The stream (and disk checks) pause while the tab is hidden, as before.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { source?.close(); source = null; return; }
  connectStream();
  emit('stream:git');
  checkDisk();
});
addEventListener('focus', () => checkDisk());
setInterval(() => { if (!document.hidden) checkDisk(); }, 5000);

/* ---------- application menu ---------- */

const trigger = id => () => { const ed = activeEditor(); ed?.focus(); ed?.trigger('menu', id, null); };

// The menu behind the activity bar's hamburger button (VS Code's compact menu bar).
function appMenu() {
  const menus = {
    File: () => [
      { label: 'New File...', keys: keysFor('workbench.action.files.newUntitledFile'), run: () => run('workbench.action.files.newUntitledFile') },
      { label: 'New Folder...', run: () => run('explorer.newFolder') },
      { separator: true },
      { label: 'Go to File...', keys: keysFor('workbench.action.quickOpen'), run: () => run('workbench.action.quickOpen') },
      inWorkbench() && { label: 'Switch Repository...', keys: keysFor('px0.switchRepository'), run: () => run('px0.switchRepository') },
      inWorkbench() && { label: 'Open Workbench', run: () => run('px0.openWorkbench') },
      { separator: true },
      { label: 'Save', keys: keysFor('workbench.action.files.save'), run: () => run('workbench.action.files.save') },
      { label: 'Save All', keys: keysFor('workbench.action.files.saveAll'), run: () => run('workbench.action.files.saveAll') },
      { label: 'Revert File', run: () => run('workbench.action.files.revert') },
      { separator: true },
      { label: 'Auto Save', checked: ['afterDelay', 'onFocusChange'].includes(setting('files.autoSave', 'off')), run: () => run('workbench.action.toggleAutoSave') },
      { separator: true },
      { label: 'Settings', keys: keysFor('workbench.action.openSettings'), run: () => run('workbench.action.openSettings') },
      { label: 'Keyboard Shortcuts', keys: keysFor('workbench.action.openGlobalKeybindings'), run: () => run('workbench.action.openGlobalKeybindings') },
      { label: 'Color Theme', keys: keysFor('workbench.action.selectTheme'), run: () => run('workbench.action.selectTheme') },
      { separator: true },
      { label: 'Close Editor', keys: keysFor('workbench.action.closeActiveEditor'), run: () => run('workbench.action.closeActiveEditor') },
      { label: 'Close All Editors', keys: keysFor('workbench.action.closeAllEditors'), run: () => run('workbench.action.closeAllEditors') },
    ],
    Edit: () => [
      { label: 'Undo', keys: 'Mod+Z', run: trigger('undo') },
      { label: 'Redo', keys: isMac ? 'Mod+Shift+Z' : 'Mod+Y', run: trigger('redo') },
      { separator: true },
      { label: 'Find', keys: 'Mod+F', run: trigger('actions.find') },
      { label: 'Replace', keys: isMac ? 'Mod+Alt+F' : 'Mod+H', run: trigger('editor.action.startFindReplaceAction') },
      { separator: true },
      { label: 'Find in Files', keys: keysFor('workbench.view.search'), run: () => run('workbench.view.search') },
      { separator: true },
      { label: 'Toggle Line Comment', keys: 'Mod+/', run: trigger('editor.action.commentLine') },
      { label: 'Toggle Block Comment', keys: 'Shift+Alt+A', run: trigger('editor.action.blockComment') },
    ],
    Selection: () => [
      { label: 'Select All', keys: 'Mod+A', run: trigger('editor.action.selectAll') },
      { label: 'Expand Selection', keys: 'Shift+Alt+ArrowRight', run: trigger('editor.action.smartSelect.expand') },
      { label: 'Shrink Selection', keys: 'Shift+Alt+ArrowLeft', run: trigger('editor.action.smartSelect.shrink') },
      { separator: true },
      { label: 'Copy Line Up', keys: 'Shift+Alt+ArrowUp', run: trigger('editor.action.copyLinesUpAction') },
      { label: 'Copy Line Down', keys: 'Shift+Alt+ArrowDown', run: trigger('editor.action.copyLinesDownAction') },
      { label: 'Move Line Up', keys: 'Alt+ArrowUp', run: trigger('editor.action.moveLinesUpAction') },
      { label: 'Move Line Down', keys: 'Alt+ArrowDown', run: trigger('editor.action.moveLinesDownAction') },
      { separator: true },
      { label: 'Add Cursor Above', keys: 'Mod+Alt+ArrowUp', run: trigger('editor.action.insertCursorAbove') },
      { label: 'Add Cursor Below', keys: 'Mod+Alt+ArrowDown', run: trigger('editor.action.insertCursorBelow') },
      { label: 'Add Next Occurrence', keys: 'Mod+D', run: trigger('editor.action.addSelectionToNextFindMatch') },
      { label: 'Select All Occurrences', keys: 'Mod+Shift+L', run: trigger('editor.action.selectHighlights') },
    ],
    View: () => [
      { label: 'Command Palette...', keys: keysFor('workbench.action.showCommands'), run: () => run('workbench.action.showCommands') },
      { separator: true },
      { label: 'Explorer', keys: keysFor('workbench.view.explorer'), run: () => run('workbench.view.explorer') },
      { label: 'Search', keys: keysFor('workbench.view.search'), run: () => run('workbench.view.search') },
      { label: 'Source Control', keys: keysFor('workbench.view.scm'), run: () => run('workbench.view.scm') },
      S.meta?.pr && { label: 'Pull Request', run: () => showView('pr') },
      inWorkbench() && { label: 'Repositories', run: () => showView('repos') },
      { label: 'Problems', keys: keysFor('workbench.actions.view.problems'), run: () => run('workbench.actions.view.problems') },
      { label: 'Output', keys: keysFor('workbench.action.output.toggleOutput'), run: () => run('workbench.action.output.toggleOutput') },
      { label: 'Terminal', keys: keysFor('workbench.action.terminal.toggleTerminal'), run: () => run('workbench.action.terminal.toggleTerminal') },
      { separator: true },
      { label: 'Appearance', submenu: () => [
        { label: 'Primary Side Bar', checked: isSidebarVisible(), keys: keysFor('workbench.action.toggleSidebarVisibility'), run: () => run('workbench.action.toggleSidebarVisibility') },
        { label: 'Secondary Side Bar', checked: isAuxVisible(), keys: keysFor('workbench.action.toggleAuxiliaryBar'), run: () => run('workbench.action.toggleAuxiliaryBar') },
        { label: 'Panel', checked: isPanelVisible(), keys: keysFor('workbench.action.togglePanel'), run: () => run('workbench.action.togglePanel') },
        { separator: true },
        { label: 'Customize Layout...', run: customizeLayout },
      ] },
      { label: 'Editor Layout', submenu: () => [
        { label: 'Split Right', keys: keysFor('workbench.action.splitEditor'), run: () => run('workbench.action.splitEditor') },
      ] },
      { separator: true },
      { label: 'Word Wrap', keys: keysFor('editor.action.toggleWordWrap'), checked: setting('editor.wordWrap', 'off') !== 'off', run: () => run('editor.action.toggleWordWrap') },
      { label: 'Minimap', checked: setting('editor.minimap.enabled', true) !== false, run: () => run('editor.action.toggleMinimap') },
      { label: 'Render Whitespace', checked: setting('editor.renderWhitespace', 'selection') === 'all', run: () => run('editor.action.toggleRenderWhitespace') },
    ],
    Go: () => [
      { label: 'Back', keys: keysFor('workbench.action.navigateBack'), run: () => run('workbench.action.navigateBack') },
      { label: 'Forward', keys: keysFor('workbench.action.navigateForward'), run: () => run('workbench.action.navigateForward') },
      { separator: true },
      { label: 'Go to File...', keys: keysFor('workbench.action.quickOpen'), run: () => run('workbench.action.quickOpen') },
      { label: 'Go to Symbol in Editor...', keys: keysFor('workbench.action.gotoSymbol'), run: () => run('workbench.action.gotoSymbol') },
      { label: 'Go to Line/Column...', keys: keysFor('workbench.action.gotoLine'), run: () => run('workbench.action.gotoLine') },
      { separator: true },
      { label: 'Go to Definition', keys: 'F12', run: trigger('editor.action.revealDefinition') },
      { label: 'Peek Definition', keys: 'Alt+F12', run: trigger('editor.action.peekDefinition') },
      { label: 'Go to References', keys: 'Shift+F12', run: trigger('editor.action.goToReferences') },
      { separator: true },
      { label: 'Next Problem', keys: 'F8', run: trigger('editor.action.marker.nextInFiles') },
      { label: 'Previous Problem', keys: 'Shift+F8', run: trigger('editor.action.marker.prevInFiles') },
      { label: 'Next Change', keys: keysFor('workbench.action.editor.nextChange'), run: () => run('workbench.action.editor.nextChange') },
      { label: 'Previous Change', keys: keysFor('workbench.action.editor.previousChange'), run: () => run('workbench.action.editor.previousChange') },
    ],
    Terminal: () => [
      { label: 'New Terminal', keys: keysFor('workbench.action.terminal.new'), run: () => run('workbench.action.terminal.new') },
      { label: 'Split Terminal', keys: keysFor('workbench.action.terminal.split'), run: () => run('workbench.action.terminal.split') },
      { separator: true },
      { label: 'Clear Terminal', run: () => run('workbench.action.terminal.clear') },
      { label: 'Rename Terminal...', run: () => run('workbench.action.terminal.rename') },
      { label: 'Kill Terminal', run: () => run('workbench.action.terminal.kill') },
    ],
    Help: () => [
      { label: 'Show All Commands', keys: keysFor('workbench.action.showCommands'), run: () => run('workbench.action.showCommands') },
      { label: 'Keyboard Shortcuts Reference', keys: keysFor('workbench.action.openGlobalKeybindings'), run: () => run('workbench.action.openGlobalKeybindings') },
      { separator: true },
      { label: `About px0 ${S.meta?.version ? 'v' + S.meta.version : ''}`, run: () => notify(`px0 ${S.meta?.version || ''}`, { detail: `${S.meta?.root || ''}\nEditor: Monaco` }) },
    ],
  };
  return Object.entries(menus).map(([label, items]) => ({ label, submenu: items }));
}

// Accounts: the forge account px0 uses for pull requests.
function accountsMenu() {
  const f = S.meta?.forge;
  const label = f?.info?.label || 'GitHub';
  return [
    f?.hasToken
      ? { label: `${label} (signed in with a token)`, disabled: true }
      : { label: `Sign in with ${label} to use Pull Requests`, run: () => run('px0.connectForge') },
    { separator: true },
    { label: 'Manage Tokens in Settings', run: () => run('workbench.action.openSettings') },
  ];
}

/* ---------- boot ---------- */

async function boot() {
  try {
    S.meta = await api('api/meta');
  } catch (e) {
    document.body.textContent = 'px0: could not reach the server (' + e.message + ').';
    return;
  }
  await loadSettings();
  const theme = initialTheme(setting('workbench.colorTheme', DEFAULT_THEME));
  if (!setTheme(theme, false)) setTheme(DEFAULT_THEME, false);

  buildLayout(document.getElementById('app'));
  initLayout();
  applyMonacoTheme();
  initEditors(layoutEls().editorArea);
  initKeybindings();
  initTooltips();

  // Title bar: the app icon (the way back to the workbench), Go Back/Forward
  // and the command center; the application menu lives in the activity bar.
  const logo = h('span.app-icon-mark', { 'aria-hidden': 'true' }, '0');
  setTitleLeft(inWorkbench()
    ? h('a.app-icon', { href: wbURL(''), title: 'Back to the px0 workbench' }, logo)
    : h('span.app-icon', { title: `px0 ${S.meta.version || ''}` }, logo));
  setTitleCenter(
    h('div.title-navigation',
      h('button.icon-btn', { type: 'button', title: `Go Back (${keyLabel('Alt+ArrowLeft')})`, on: { click: () => run('workbench.action.navigateBack') } }, icon('arrow-left')),
      h('button.icon-btn', { type: 'button', title: `Go Forward (${keyLabel('Alt+ArrowRight')})`, on: { click: () => run('workbench.action.navigateForward') } }, icon('arrow-right'))),
    h('button.command-center', { type: 'button', title: `Search ${S.meta.name} (${keyLabel('Mod+P')})`, on: { click: () => showQuickOpen('') } },
      h('span.command-center-label', S.meta.name + (S.meta.pr ? ` — PR #${S.meta.pr.number}` : ''))));
  setAppMenu(appMenu);
  setAccountsMenu(accountsMenu);

  registerView({ id: 'explorer', title: 'Explorer', icon: 'files', order: 1, keys: 'Mod+Shift+E', render: renderExplorer, menu: explorerMenu });
  registerView({ id: 'search', title: 'Search', icon: 'search', order: 2, keys: 'Mod+Shift+F', render: renderSearch, onShow: ({ focus }) => { if (focus) focusSearch(); } });
  registerView({
    id: 'scm', title: 'Source Control', icon: 'source-control', order: 3, keys: 'Mod+Shift+G', render: renderScm, badge: changeCount,
    actions: () => [
      { icon: 'check', title: 'Commit', run: () => run('git.commit') },
      { icon: 'refresh', title: 'Refresh', run: () => run('git.refresh') },
      { icon: 'ellipsis', title: 'More Actions...', run: el => moreMenu(el) },
    ],
  });
  if (S.meta.pr) registerView({ id: 'pr', title: 'Pull Request', icon: 'git-pull-request', order: 4, render: renderPR, actions: prActions });
  if (inWorkbench()) {
    registerView({
      id: 'repos', title: 'Repositories', icon: 'repo', order: 5, render: renderRepos,
      actions: () => [
        { icon: 'refresh', title: 'Rescan for Repositories', run: () => reloadReposView({ container: document.querySelector('.view[data-view="repos"]') }, true) },
        { icon: 'home', title: 'Open Workbench', run: () => run('px0.openWorkbench') },
      ],
    });
  }
  registerPanel({ id: 'problems', title: 'Problems', keys: 'Mod+Shift+M', render: renderProblems, widget: problemsWidget, actions: problemsActions, badge: () => { const c = problemCounts(); return c.errors + c.warnings + c.infos; } });
  registerPanel({ id: 'output', title: 'Output', keys: 'Mod+K Mod+H', render: renderOutput, widget: outputWidget, actions: outputActions });
  registerPanel({ id: 'terminal', title: 'Terminal', keys: isMac ? 'Ctrl+`' : 'Mod+`', render: renderTerminal, widget: terminalWidget, actions: terminalActions, onShow: onTerminalShown });
  // The secondary side bar docks a second Outline, following the active editor.
  setAuxView({
    title: 'Outline',
    render: container => {
      const p = pane({ title: 'Outline', grow: true });
      p.el.classList.add('pane-headerless');
      container.classList.add('panes');
      container.append(p.el);
      initOutline(p);
    },
  });

  registerViewer('settings', {
    render: (t, root) => { t.disposeSettings = renderSettingsEditor(t, root, { openJSON: () => run('workbench.action.openSettingsJson') }); },
    dispose: t => t.disposeSettings?.(),
  });
  registerViewer('settings-json', { render: renderSettingsJSON, dispose: t => { t.editor?.dispose(); t.model?.dispose(); } });
  registerViewer('keybindings', { render: renderKeybindings });
  initPreviews();

  registerEditorAction({ id: 'git.openChange', icon: 'git-compare', title: 'Open Changes', when: t => t.kind === 'file' && G.byPath.has(t.path) && !G.byPath.get(t.path).untracked });
  registerEditorAction({ id: 'markdown.showPreviewToSide', icon: 'open-preview', title: 'Open Preview to the Side', when: t => t.kind === 'file' && isMarkdownPath(t.path) });
  registerEditorAction({ id: 'px0.openTablePreview', icon: 'table', title: 'Open Table Preview', when: t => t.kind === 'file' && isTablePath(t.path) });
  registerEditorAction({ id: 'workbench.action.editor.previousChange', icon: 'arrow-up', title: 'Previous Change', when: t => t.kind === 'diff' });
  registerEditorAction({ id: 'workbench.action.editor.nextChange', icon: 'arrow-down', title: 'Next Change', when: t => t.kind === 'diff' });
  registerEditorAction({ id: 'toggle.diff.renderSideBySide', icon: 'diff-single', title: 'Toggle Inline View', when: t => t.kind === 'diff' });
  registerEditorAction({ id: 'git.openFile', icon: 'go-to-file', title: 'Open File', when: t => t.kind === 'diff' && !!t.path && !t.right?.empty });

  initActions();
  refreshWatermarks();
  initPalette();
  initLsp();
  initProblems();
  initOutput();
  initTerminal();
  initDirtyDiff();
  initExplorer();
  initSearch();
  initScm();
  if (S.meta.pr) initPR();
  await initGit();
  drawActivityBar();
  initStatusBar();
  showView(initialView(), { focus: false });
  if (isPanelVisible()) showPanel();
  connectStream();

  on('settings:changed', () => updateAllEditorOptions());
  // The fixed sides of open diffs (HEAD, the index) move with stage, commit, pull...
  const refreshDiffsSoon = debounce(refreshDiffs, 500);
  on('git:after-op', refreshDiffsSoon);
  on('stream:git', refreshDiffsSoon);
  on('editor:active', t => {
    updateTitle();
    if (t?.kind === 'file') warm(t.path);
  });
  on('doc:dirty', updateTitle);

  const params = new URLSearchParams(location.search);
  const restored = await restoreSession();
  if (params.get('path')) {
    await openFile(params.get('path'), { line: parseInt(params.get('line'), 10) || undefined });
    history.replaceState(null, '', location.pathname);
  } else if (!restored && S.meta.pr) {
    showView('pr');
  }
  updateTitle();
}

function updateTitle() {
  const t = activeTab();
  const dirty = allTabs().some(isTabDirty);
  document.title = (dirty ? '● ' : '') + (t ? (t.title || basename(t.path || '')) + ' - ' : '') + (S.meta?.name || 'px0') + ' - px0';
}

function renderSettingsJSON(t, root) {
  root.classList.add('settings-json');
  root.append(h('div.view-message', 'Loading settings…'));
  api('api/settings').then(j => {
    root.replaceChildren();
    const host = h('div.editor-host-inner');
    root.append(host);
    const uri = monaco.Uri.from({ scheme: 'px0-settings', path: '/settings.json' });
    monaco.editor.getModel(uri)?.dispose();
    t.model = monaco.editor.createModel(j.raw || '{\n}\n', 'json', uri);
    t.editor = monaco.editor.create(host, { model: t.model, automaticLayout: true, fontSize: Number(setting('editor.fontSize', 13)), minimap: { enabled: false }, tabSize: 2 });
    let saved = t.model.getAlternativeVersionId();
    t.save = async () => {
      try {
        await saveRawSettings(t.model.getValue());
        saved = t.model.getAlternativeVersionId();
        notify('Settings saved.', { timeout: 1500 });
      } catch (e) {
        notify('Could not save settings: ' + e.message, { severity: 'error' });
      }
    };
    t.description = j.path || '';
  });
}

boot();
