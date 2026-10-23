// web/src/layout.js
// The VS Code workbench shell, in VS Code's modern layout: the parts float as
// rounded cards on the window background.
//   title bar      app icon, Go Back/Forward and the command center (Quick
//                  Open), layout controls (Customize Layout, side bars, panel)
//   activity bar   the application menu, one icon per side bar view (with
//                  badges), Accounts and Manage at the bottom
//   side bar       the active view (Explorer, Search, Source Control, ...)
//   editor area    editor groups (editors.js)
//   panel          Problems, Output, ... (toggle with Ctrl+J)
//   secondary side bar   one view docked on the right (Outline)
//   status bar     items registered by the other modules
// Views, panels and status items register themselves here; this module only
// lays them out and remembers sizes and visibility.
import { h, icon, emit, on, pref, setPref, keyLabel } from './util.js';
import { run, keysFor } from './commands.js';
import { showMenu, showMenuAt } from './ui.js';
import { quickPick } from './quickinput.js';

const views = new Map();   // id -> view
const panels = new Map();  // id -> panel
const L = {
  sidebarVisible: pref('layout.sidebar', true),
  sidebarWidth: pref('layout.sidebarWidth', 300),
  auxVisible: pref('layout.aux', false),
  auxWidth: pref('layout.auxWidth', 300),
  panelVisible: pref('layout.panel', false),
  panelHeight: pref('layout.panelHeight', 260),
  activityVisible: pref('layout.activity', true),
  statusVisible: pref('layout.status', true),
  panelMax: false,
  view: pref('layout.view', 'explorer'),
  panel: pref('layout.panelId', 'problems'),
};
const els = {};
let appMenu = () => [];      // the activity bar's application menu (main.js)
let accountsMenu = () => []; // the Accounts menu (main.js)
let auxView = null;          // { title, render, actions }

export const activeViewId = () => (L.sidebarVisible ? L.view : '');

// The view shown last time, if it exists in this workspace.
export const initialView = () => (views.has(L.view) ? L.view : 'explorer');

/* registerView({ id, title, icon, order, render(container), onShow?, actions?:
   [{ icon, title, run }], badge?: () => number|string, when?: () => bool }) */
export function registerView(v) {
  views.set(v.id, v);
}

/* registerPanel({ id, title, render(container), badge?, actions?: () =>
   [{ icon, title, run }], widget?: () => element shown in the title bar }) */
export function registerPanel(p) {
  panels.set(p.id, p);
}

export const setAppMenu = fn => { appMenu = fn; };
export const setAccountsMenu = fn => { accountsMenu = fn; };

/* ---------- build ---------- */

const iconButton = (ic, title, onClick, cls = '') =>
  h('button.icon-btn' + cls, { type: 'button', title, 'aria-label': title, on: { click: e => onClick(e.currentTarget, e) } }, icon(ic));

export function buildLayout(root) {
  root.classList.add('workbench');

  els.activityViews = h('div.activity-views', { role: 'tablist', 'aria-label': 'Views' });
  els.activity = h('nav.activitybar.part',
    h('div.activity-menu', h('button.activity-item.menubar-toggle', { type: 'button', title: 'Application Menu', 'aria-label': 'Application Menu', 'aria-haspopup': 'menu', on: { click: e => openAppMenu(e.currentTarget) } }, icon('menu'))),
    els.activityViews,
    h('div.activity-spacer'),
    h('div.activity-global',
      h('button.activity-item', { type: 'button', title: 'Accounts', 'aria-label': 'Accounts', on: { click: e => openGlobalMenu(e.currentTarget, accountsMenu()) } }, icon('account')),
      h('button.activity-item', { type: 'button', title: 'Manage', 'aria-label': 'Manage', on: { click: e => openGlobalMenu(e.currentTarget, manageMenu()) } }, icon('settings-gear'))));

  els.sideTitle = h('h2.sidebar-title');
  els.sideActions = h('div.sidebar-actions');
  els.sideHeader = h('div.sidebar-header', els.sideTitle, els.sideActions);
  els.sideBody = h('div.sidebar-body');
  els.sidebar = h('aside.sidebar.part', els.sideHeader, els.sideBody);
  els.sideSash = h('div.sash.sash-v.side-sash');

  els.auxTitle = h('h2.sidebar-title');
  els.auxActions = h('div.sidebar-actions');
  els.auxBody = h('div.sidebar-body');
  els.aux = h('aside.auxbar.part', h('div.sidebar-header', els.auxTitle, els.auxActions), els.auxBody);
  els.auxSash = h('div.sash.sash-v.aux-sash');

  els.editorArea = h('div.editor-area.part');
  els.panelTabs = h('div.panel-tabs', { role: 'tablist' });
  els.panelWidget = h('div.panel-widget');
  els.panelOwnActions = h('div.panel-actions.panel-own-actions');
  els.panelMaxBtn = iconButton('screen-full', 'Maximize Panel Size', togglePanelMax);
  els.panelActions = h('div.panel-actions',
    els.panelMaxBtn,
    iconButton('close', `Hide Panel (${keyLabel('Mod+J')})`, () => setPanelVisible(false)));
  els.panelBody = h('div.panel-body');
  els.panel = h('section.panel.part', h('div.panel-header', els.panelTabs, els.panelWidget, els.panelOwnActions, els.panelActions), els.panelBody);
  els.panelSash = h('div.sash.sash-h.panel-sash');

  els.statusLeft = h('div.status-left');
  els.statusRight = h('div.status-right');
  els.status = h('footer.statusbar', els.statusLeft, els.statusRight);

  els.titleLeft = h('div.title-left');
  els.center = h('div.title-center');
  els.layoutControls = {
    sidebar: iconButton('layout-sidebar-left', `Toggle Primary Side Bar (${keyLabel('Mod+B')})`, () => run('workbench.action.toggleSidebarVisibility')),
    panel: iconButton('layout-panel', `Toggle Panel (${keyLabel('Mod+J')})`, () => run('workbench.action.togglePanel')),
    aux: iconButton('layout-sidebar-right-off', `Toggle Secondary Side Bar (${keyLabel('Mod+Alt+B')})`, () => run('workbench.action.toggleAuxiliaryBar')),
  };
  els.titleRight = h('div.title-right',
    h('div.layout-controls',
      iconButton('layout', 'Customize Layout...', () => customizeLayout()),
      els.layoutControls.sidebar, els.layoutControls.panel, els.layoutControls.aux));
  els.title = h('header.titlebar', els.titleLeft, els.center, els.titleRight);

  els.content = h('div.workbench-content', els.editorArea, els.panelSash, els.panel);
  root.replaceChildren(
    els.title,
    h('div.workbench-main', els.activity, els.sidebar, els.sideSash, els.content, els.auxSash, els.aux),
    els.status);

  dragSash(els.sideSash, 'x', () => L.sidebarWidth, w => {
    L.sidebarWidth = Math.max(170, Math.min(w, innerWidth - 320));
    applyLayout();
  }, () => setPref('layout.sidebarWidth', L.sidebarWidth));
  dragSash(els.auxSash, 'x', () => L.auxWidth, w => {
    L.auxWidth = Math.max(170, Math.min(w, innerWidth - 320));
    applyLayout();
  }, () => setPref('layout.auxWidth', L.auxWidth), true);
  dragSash(els.panelSash, 'y', () => L.panelHeight, hgt => {
    L.panelHeight = Math.max(80, Math.min(hgt, innerHeight - 160));
    applyLayout();
  }, () => setPref('layout.panelHeight', L.panelHeight), true);
  els.sideSash.addEventListener('dblclick', () => { L.sidebarWidth = 300; setPref('layout.sidebarWidth', 300); applyLayout(); });
  return els;
}

function dragSash(el, axis, get, set, done, invert = false) {
  el.addEventListener('pointerdown', e => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    el.classList.add('active');
    document.body.classList.add(axis === 'x' ? 'sash-dragging-x' : 'sash-dragging-y');
    const start = axis === 'x' ? e.clientX : e.clientY;
    const v0 = get();
    const move = ev => {
      const d = (axis === 'x' ? ev.clientX : ev.clientY) - start;
      set(v0 + (invert ? -d : d));
    };
    const up = () => {
      el.classList.remove('active');
      document.body.classList.remove('sash-dragging-x', 'sash-dragging-y');
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      done();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  });
}

export function applyLayout() {
  const root = els.title.parentElement;
  els.sidebar.hidden = !L.sidebarVisible;
  els.sideSash.hidden = !L.sidebarVisible;
  els.sidebar.style.width = L.sidebarWidth + 'px';
  const aux = L.auxVisible && !!auxView;
  els.aux.hidden = !aux;
  els.auxSash.hidden = !aux;
  els.aux.style.width = L.auxWidth + 'px';
  els.activity.hidden = !L.activityVisible;
  els.status.hidden = !L.statusVisible;
  els.panel.hidden = !L.panelVisible;
  els.panelSash.hidden = !L.panelVisible || L.panelMax;
  els.editorArea.hidden = L.panelVisible && L.panelMax;
  els.panel.style.height = L.panelMax ? '' : L.panelHeight + 'px';
  els.panel.classList.toggle('maximized', L.panelVisible && L.panelMax);
  root?.classList.toggle('nosidebar', !L.sidebarVisible);
  root?.classList.toggle('noactivitybar', !L.activityVisible);
  root?.classList.toggle('nostatusbar', !L.statusVisible);
  root?.classList.toggle('noauxbar', !aux);
  const lc = els.layoutControls;
  lc.sidebar.replaceChildren(icon(L.sidebarVisible ? 'layout-sidebar-left' : 'layout-sidebar-left-off'));
  lc.panel.replaceChildren(icon(L.panelVisible ? 'layout-panel' : 'layout-panel-off'));
  lc.aux.replaceChildren(icon(aux ? 'layout-sidebar-right' : 'layout-sidebar-right-off'));
  lc.sidebar.setAttribute('aria-pressed', String(L.sidebarVisible));
  lc.panel.setAttribute('aria-pressed', String(L.panelVisible));
  lc.aux.setAttribute('aria-pressed', String(aux));
  for (const b of els.activityViews.querySelectorAll('.activity-item[data-view]')) {
    const on = L.sidebarVisible && b.dataset.view === L.view;
    b.classList.toggle('checked', on);
    b.setAttribute('aria-selected', String(on));
  }
  emit('layout:changed', L);
}

/* ---------- title bar ---------- */

export function setTitleCenter(...nodes) {
  els.center.replaceChildren(...nodes);
}

export function setTitleLeft(node) {
  els.titleLeft.replaceChildren(node);
}

// VS Code's Customize Layout picker: toggle parts on and off.
export function customizeLayout() {
  const item = (label, isOn, toggle, keys) => ({ label, icon: isOn ? 'eye' : 'eye-closed', keys, toggle, description: isOn ? '' : 'Hidden' });
  const items = () => [
    { separator: true, label: 'Visibility' },
    item('Activity Bar', L.activityVisible, () => setActivityBarVisible(!L.activityVisible)),
    item('Primary Side Bar', L.sidebarVisible, () => setSidebarVisible(!L.sidebarVisible), keysFor('workbench.action.toggleSidebarVisibility')),
    item('Secondary Side Bar', L.auxVisible, () => setAuxVisible(!L.auxVisible), keysFor('workbench.action.toggleAuxiliaryBar')),
    item('Panel', L.panelVisible, () => setPanelVisible(!L.panelVisible), keysFor('workbench.action.togglePanel')),
    item('Status Bar', L.statusVisible, () => setStatusBarVisible(!L.statusVisible)),
    { separator: true, label: 'Modes' },
    { label: L.panelMax ? 'Restore Panel Size' : 'Maximize Panel Size', icon: L.panelMax ? 'screen-normal' : 'screen-full', toggle: () => { if (!L.panelVisible) setPanelVisible(true); togglePanelMax(); } },
  ];
  quickPick({
    title: 'Customize Layout',
    placeholder: 'Select an item to toggle it',
    items: items(),
    onAccept: it => { it.toggle?.(); setTimeout(customizeLayout, 0); },
  });
}

/* ---------- activity bar and side bar ---------- */

export function drawActivityBar() {
  const items = [...views.values()].filter(v => !v.when || v.when()).sort((a, b) => a.order - b.order);
  els.activityViews.replaceChildren(...items.map(v => {
    const b = h('button.activity-item', { type: 'button', role: 'tab', dataset: { view: v.id }, title: v.title + (v.keys ? ` (${keyLabel(v.keys)})` : ''), 'aria-label': v.title },
      icon(v.icon), h('span.activity-badge', { hidden: true }));
    b.addEventListener('click', () => {
      if (L.sidebarVisible && L.view === v.id) setSidebarVisible(false);
      else showView(v.id);
    });
    return b;
  }));
  updateBadges();
  applyLayout();
}

function openAppMenu(anchor) {
  const r = anchor.getBoundingClientRect();
  anchor.classList.add('open');
  const el = showMenu(appMenu(), r.left, r.bottom + 2, { onClose: () => anchor.classList.remove('open') });
  return el;
}

function openGlobalMenu(anchor, items) {
  const r = anchor.getBoundingClientRect();
  showMenu(items, r.right + 4, r.top, { above: r.bottom, alignBottom: true });
}

function manageMenu() {
  return [
    { label: 'Command Palette...', keys: keysFor('workbench.action.showCommands'), run: () => run('workbench.action.showCommands') },
    { separator: true },
    { label: 'Settings', keys: keysFor('workbench.action.openSettings'), run: () => run('workbench.action.openSettings') },
    { label: 'Open Settings (JSON)', run: () => run('workbench.action.openSettingsJson') },
    { label: 'Keyboard Shortcuts', keys: keysFor('workbench.action.openGlobalKeybindings'), run: () => run('workbench.action.openGlobalKeybindings') },
    { separator: true },
    { label: 'Themes', submenu: () => [
      { label: 'Color Theme', keys: keysFor('workbench.action.selectTheme'), run: () => run('workbench.action.selectTheme') },
    ] },
  ];
}

export function updateBadges() {
  for (const b of els.activityViews.querySelectorAll('.activity-item[data-view]')) {
    const v = views.get(b.dataset.view);
    const n = v?.badge?.();
    const badge = b.querySelector('.activity-badge');
    badge.hidden = !n;
    badge.textContent = n > 999 ? '1k+' : String(n || '');
  }
}

export function showView(id, { focus = true } = {}) {
  const v = views.get(id);
  if (!v) return;
  L.view = id;
  L.sidebarVisible = true;
  setPref('layout.view', id);
  setPref('layout.sidebar', true);
  if (!v.container) {
    v.container = h('div.view', { dataset: { view: id } });
    v.render(v.container);
  }
  if (els.sideBody.firstChild !== v.container) els.sideBody.replaceChildren(v.container);
  drawSideHeader(v);
  applyLayout();
  v.onShow?.({ focus });
}

const actionButtons = list => (list || []).map(a =>
  h('button.icon-btn', { type: 'button', title: a.title, 'aria-label': a.title, disabled: !!a.disabled, on: { click: e => a.run(e.currentTarget) } }, icon(a.icon)));

export function drawSideHeader(v = views.get(L.view)) {
  if (!v) return;
  els.sideTitle.textContent = v.title;
  els.sideTitle.title = v.title;
  const acts = v.actions?.() || [];
  const buttons = actionButtons(acts);
  if (!acts.some(a => a.icon === 'ellipsis')) buttons.push(iconButton('ellipsis', 'Views and More Actions...', el => viewsMenu(el, v)));
  els.sideActions.replaceChildren(...buttons);
}

// "Views and More Actions...": the view's own toggles (v.menu), then the
// other views to switch to.
function viewsMenu(anchor, current) {
  const items = [...views.values()].filter(v => !v.when || v.when()).sort((a, b) => a.order - b.order);
  const own = current?.menu?.() || [];
  showMenuAt([
    ...own,
    own.length && { separator: true },
    ...items.map(v => ({ label: v.title, checked: v.id === L.view, keys: v.keys, run: () => showView(v.id) })),
    { separator: true },
    { label: 'Hide Primary Side Bar', keys: keysFor('workbench.action.toggleSidebarVisibility'), run: () => setSidebarVisible(false) },
  ], anchor);
}

export function setSidebarVisible(on) {
  L.sidebarVisible = on;
  setPref('layout.sidebar', on);
  if (on) showView(L.view);
  else applyLayout();
}

export const isSidebarVisible = () => L.sidebarVisible;

/* ---------- secondary side bar ---------- */

/* setAuxView({ title, render(container), actions? }) docks one view in the
   secondary side bar. */
export function setAuxView(v) {
  auxView = v;
  els.auxTitle.textContent = v.title;
  els.auxActions.replaceChildren(...actionButtons(v.actions?.()),
    iconButton('close', `Hide Secondary Side Bar (${keyLabel('Mod+Alt+B')})`, () => setAuxVisible(false)));
  if (L.auxVisible) renderAux();
  applyLayout();
}

function renderAux() {
  if (!auxView || auxView.container) return;
  auxView.container = h('div.view');
  els.auxBody.replaceChildren(auxView.container);
  auxView.render(auxView.container);
}

export function setAuxVisible(on) {
  L.auxVisible = on;
  setPref('layout.aux', on);
  if (on) renderAux();
  applyLayout();
}

export const isAuxVisible = () => L.auxVisible;

export function setActivityBarVisible(on) {
  L.activityVisible = on;
  setPref('layout.activity', on);
  applyLayout();
}

export function setStatusBarVisible(on) {
  L.statusVisible = on;
  setPref('layout.status', on);
  applyLayout();
}

/* ---------- panel ---------- */

export function drawPanelTabs() {
  els.panelTabs.replaceChildren(...[...panels.values()].map(p => {
    const n = p.badge?.();
    return h('button.panel-tab' + (p.id === L.panel ? '.checked' : ''), { type: 'button', role: 'tab', 'aria-selected': String(p.id === L.panel), title: p.title + (p.keys ? ` (${keyLabel(p.keys)})` : ''), on: { click: () => showPanel(p.id, { focus: true }) } },
      h('span.panel-tab-label', p.title), n ? h('span.badge.panel-badge', String(n)) : null);
  }));
  const p = panels.get(L.panel);
  els.panelWidget.replaceChildren(...(p?.widget ? [p.widget()] : []));
  els.panelOwnActions.replaceChildren(...actionButtons(p?.actions?.()));
}

export function showPanel(id = L.panel, { focus = false } = {}) {
  const p = panels.get(id) || [...panels.values()][0];
  if (!p) return;
  L.panel = p.id;
  setPref('layout.panelId', p.id);
  if (!p.container) {
    p.container = h('div.panel-view');
    p.render(p.container);
  }
  if (els.panelBody.firstChild !== p.container) els.panelBody.replaceChildren(p.container);
  setPanelVisible(true);
  drawPanelTabs();
  p.onShow?.({ focus });
}

export function setPanelVisible(on) {
  L.panelVisible = on;
  if (!on) L.panelMax = false;
  setPref('layout.panel', on);
  if (on && !els.panelBody.firstChild) { showPanel(L.panel); return; }
  applyLayout();
}

export const isPanelVisible = () => L.panelVisible;
export const activePanelId = () => (L.panelVisible ? L.panel : '');

function togglePanelMax() {
  L.panelMax = !L.panelMax;
  els.panelMaxBtn.replaceChildren(icon(L.panelMax ? 'screen-normal' : 'screen-full'));
  els.panelMaxBtn.title = L.panelMax ? 'Restore Panel Size' : 'Maximize Panel Size';
  applyLayout();
}

export const togglePanelMaximized = () => { if (!L.panelVisible) setPanelVisible(true); togglePanelMax(); };

/* ---------- status bar ---------- */

/* statusItem({ id, side: 'left'|'right', priority, title, run }) returns an
   element to fill; higher priority sits further out (left on the left side,
   right on the right). */
export function statusItem({ id, side = 'left', priority = 0, title, run: action, cls = '' }) {
  const el = h(action ? 'button.status-item' : 'span.status-item', { type: action ? 'button' : undefined, dataset: { id, priority }, title: title || '' });
  if (cls) el.className += ' ' + cls;
  if (action) el.addEventListener('click', e => action(e.currentTarget));
  const parent = side === 'left' ? els.statusLeft : els.statusRight;
  const before = [...parent.children].find(s => Number(s.dataset.priority) < priority);
  parent.insertBefore(el, before || null);
  return el;
}

export const layoutEls = () => els;

export function initLayout() {
  on('git:changed', updateBadges);
  on('badges:changed', () => { updateBadges(); drawPanelTabs(); });
  on('panel:actions', () => drawPanelTabs());
  applyLayout();
}
