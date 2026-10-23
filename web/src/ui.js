// web/src/ui.js
// VS Code-style building blocks with no knowledge of the rest of the app:
// context menus (with submenus), notification toasts and the notification
// center, modal dialogs, hover tooltips, keybinding labels and view panes.
import { h, icon, keyLabel, isMac, emit } from './util.js';

/* ---------- keybinding labels ---------- */

/* keycaps("Mod+Shift+P") renders a keybinding as VS Code's keybinding label:
   one key cap per key, "+" between them, a space between the chords. */
export function keycaps(combo, cls = '') {
  const el = h('span.keybinding' + (cls ? '.' + cls : ''));
  if (!combo) return el;
  combo.split(' ').forEach((chord, ci) => {
    if (ci) el.append(h('span.kb-chord-sep', ' '));
    // On a Mac keyLabel joins modifiers into symbols; keep a key name whole.
    const keys = isMac ? macKeys(keyLabel(chord)) : keyLabel(chord).split(/\+(?!$)/);
    keys.forEach((k, i) => {
      if (i && !isMac) el.append(h('span.kb-sep', '+'));
      el.append(h('kbd.kb-key', prettyKey(k)));
    });
  });
  return el;
}

function macKeys(label) {
  const out = [];
  let rest = label;
  while (rest && '⌘⌃⌥⇧'.includes(rest[0])) { out.push(rest[0]); rest = rest.slice(1); }
  if (rest) out.push(rest);
  return out;
}

const prettyKey = k => ({ ArrowUp: 'UpArrow', ArrowDown: 'DownArrow', ArrowLeft: 'LeftArrow', ArrowRight: 'RightArrow', Escape: 'Escape' }[k] || k);

/* ---------- context menu ---------- */

let stack = []; // open menus, root first: { el, buttons, items, parentBtn }
let menuCleanup = null;
let onCloseCb = null;

export function closeMenu() {
  if (!stack.length) return;
  for (const m of stack) m.el.remove();
  stack = [];
  menuCleanup?.();
  menuCleanup = null;
  const cb = onCloseCb;
  onCloseCb = null;
  cb?.();
}

function closeFrom(level) {
  while (stack.length > level) stack.pop().el.remove();
}

/* showMenu(items, x, y, opts): items are { label, keys, run, disabled,
   checked, submenu: () => items } or { separator: true }. Keyboard: arrows
   (Right opens a submenu, Left closes it), Enter, Escape. opts.above: the y to
   open upwards from when there is no room below; opts.onClose. */
export function showMenu(items, x, y, opts = {}) {
  closeMenu();
  onCloseCb = opts.onClose || null;
  const m = buildMenu(items, 0);
  place(m.el, x, y, opts);
  m.el.focus();
  const onDown = e => { if (!stack.some(s => s.el.contains(e.target))) closeMenu(); };
  setTimeout(() => {
    document.addEventListener('mousedown', onDown, true);
    addEventListener('blur', closeMenu);
    addEventListener('resize', closeMenu);
  });
  menuCleanup = () => {
    document.removeEventListener('mousedown', onDown, true);
    removeEventListener('blur', closeMenu);
    removeEventListener('resize', closeMenu);
  };
  return m.el;
}

function place(el, x, y, opts = {}) {
  const r = el.getBoundingClientRect();
  let left = Math.max(4, Math.min(x, innerWidth - r.width - 4));
  let top = y;
  if (opts.alignBottom) top = Math.max(4, (opts.above ?? y) - r.height);
  else if (y + r.height > innerHeight - 4) top = Math.max(4, Math.min((opts.above ?? y) - r.height, innerHeight - r.height - 4));
  el.style.left = left + 'px';
  el.style.top = top + 'px';
}

function buildMenu(items, level, parentBtn = null) {
  const visible = items.filter(Boolean);
  const el = h('div.ctx-menu', { role: 'menu', tabindex: '-1' });
  const buttons = [];
  const m = { el, buttons, parentBtn, sel: -1 };
  let hoverTimer = 0;
  for (const it of visible) {
    if (it.separator) {
      if (el.lastChild && !el.lastChild.classList.contains('ctx-sep')) el.append(h('div.ctx-sep', { role: 'separator' }));
      continue;
    }
    const b = h('button.ctx-item' + (it.submenu ? '.has-submenu' : ''), {
      type: 'button',
      role: it.checked === undefined ? 'menuitem' : 'menuitemcheckbox',
      'aria-checked': it.checked === undefined ? undefined : String(!!it.checked),
      'aria-haspopup': it.submenu ? 'menu' : undefined,
      disabled: !!it.disabled,
    },
      h('span.ctx-check', it.checked ? icon('check') : null),
      h('span.ctx-label', it.label),
      it.submenu ? icon('chevron-right', 'ctx-submenu') : h('span.ctx-keys', it.keys ? keyLabel(it.keys) : ''));
    b._item = it;
    b.addEventListener('click', e => {
      e.stopPropagation();
      if (it.disabled) return;
      if (it.submenu) { openSub(m, b, level, true); return; }
      closeMenu();
      it.run?.();
    });
    b.addEventListener('mouseenter', () => {
      m.sel = buttons.indexOf(b);
      b.focus({ preventScroll: true });
      clearTimeout(hoverTimer);
      if (it.submenu) hoverTimer = setTimeout(() => openSub(m, b, level, false), 120);
      else hoverTimer = setTimeout(() => closeFrom(level + 1), 120);
    });
    buttons.push(b);
    el.append(b);
  }
  if (el.lastChild?.classList.contains('ctx-sep')) el.lastChild.remove();
  const move = d => {
    const enabled = buttons.filter(b => !b.disabled);
    if (!enabled.length) return;
    let i = enabled.indexOf(buttons[m.sel]);
    i = (i + d + enabled.length) % enabled.length;
    m.sel = buttons.indexOf(enabled[i]);
    enabled[i].focus();
  };
  el.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); move(-1); }
    else if (e.key === 'ArrowRight') {
      e.preventDefault(); e.stopPropagation();
      const b = buttons[m.sel];
      if (b?._item.submenu) openSub(m, b, level, true);
    } else if (e.key === 'ArrowLeft' && level > 0) {
      e.preventDefault(); e.stopPropagation();
      closeFrom(level);
      parentBtn?.focus();
    }
  });
  document.body.append(el);
  stack[level] = m;
  return m;
}

function openSub(m, b, level, focusFirst) {
  if (stack[level + 1]?.parentBtn === b) {
    if (focusFirst) { const s = stack[level + 1]; s.sel = 0; s.buttons.find(x => !x.disabled)?.focus(); }
    return;
  }
  closeFrom(level + 1);
  for (const x of m.buttons) x.classList.toggle('expanded', x === b);
  const sub = buildMenu(b._item.submenu(), level + 1, b);
  const r = b.getBoundingClientRect();
  const sr = sub.el.getBoundingClientRect();
  const left = r.right + sr.width + 2 > innerWidth ? r.left - sr.width - 2 : r.right + 2;
  sub.el.style.left = Math.max(4, left) + 'px';
  sub.el.style.top = Math.max(4, Math.min(r.top - 5, innerHeight - sr.height - 4)) + 'px';
  if (focusFirst) { sub.sel = sub.buttons.findIndex(x => !x.disabled); sub.buttons[sub.sel]?.focus(); }
}

// Opens a menu under (or above) an anchor element.
export function showMenuAt(items, anchor, opts = {}) {
  const r = anchor.getBoundingClientRect();
  return showMenu(items, r.left, r.bottom + 2, { above: r.top - 2, ...opts });
}

/* ---------- notifications ---------- */

let toasts = null;
const history = []; // { message, detail, severity, actions, time, el }
let doNotDisturb = false;
let unread = 0;
let center = null;

const sevIcon = sev => ({ info: 'info', warning: 'warning', error: 'error' }[sev] || 'info');

function notificationRow(n, { close, inCenter }) {
  return h('div.notification.' + n.severity,
    h('div.notification-row',
      icon(sevIcon(n.severity), 'notification-icon'),
      h('div.notification-msg', n.message, n.detail ? h('div.notification-detail', n.detail) : null),
      h('div.notification-toolbar',
        h('button.icon-btn', { type: 'button', title: inCenter ? 'Clear Notification' : 'Close', 'aria-label': 'Close', on: { click: close } }, icon('close')))),
    n.actions?.length ? h('div.notification-actions', n.actions.map(a =>
      h('button.btn' + (a.primary ? '.primary' : '.secondary'), { type: 'button', on: { click: () => { close(); a.run?.(); } } }, a.label))) : null);
}

/* notify(message, { severity: 'info'|'warning'|'error', detail, actions:
   [{ label, run, primary }], timeout }) shows a toast in the bottom-right
   corner and keeps it in the notification center, as VS Code does. Returns a
   handle with close(). */
export function notify(message, opts = {}) {
  const n = { message, detail: opts.detail, severity: opts.severity || 'info', actions: opts.actions, time: Date.now() };
  history.unshift(n);
  if (history.length > 50) history.pop();
  let el = null;
  const close = () => {
    if (el) { el.classList.add('leaving'); const x = el; setTimeout(() => x.remove(), 150); el = null; }
  };
  const quiet = doNotDisturb && n.severity !== 'error';
  if (!quiet && !center) {
    toasts ||= document.body.appendChild(h('div.toasts', { role: 'status', 'aria-live': 'polite' }));
    el = h('div.toast', notificationRow(n, { close }));
    toasts.append(el);
    const timeout = opts.timeout ?? (opts.actions?.length || n.severity === 'error' ? 0 : 5000);
    if (timeout) setTimeout(close, timeout);
  } else {
    unread++;
  }
  drawCenter();
  emit('notifications:changed', notificationState());
  return { close };
}

export const notificationState = () => ({ count: history.length, unread, doNotDisturb });

export function toggleDoNotDisturb() {
  doNotDisturb = !doNotDisturb;
  if (doNotDisturb) for (const t of toasts?.children || []) t.remove();
  drawCenter();
  emit('notifications:changed', notificationState());
}

export function clearNotifications() {
  history.length = 0;
  unread = 0;
  for (const t of [...(toasts?.children || [])]) t.remove();
  drawCenter();
  emit('notifications:changed', notificationState());
}

// The notification center, opened from the bell in the status bar.
export function toggleNotificationCenter(force) {
  const open = force ?? !center;
  if (!open) { center?.remove(); center = null; emit('notifications:changed', notificationState()); return; }
  if (center) return;
  unread = 0;
  for (const t of [...(toasts?.children || [])]) t.remove();
  center = h('div.notifications-center', { role: 'dialog', 'aria-label': 'Notifications' });
  document.body.append(center);
  drawCenter();
  emit('notifications:changed', notificationState());
}

function drawCenter() {
  if (!center) return;
  center.replaceChildren(
    h('div.notifications-center-header',
      h('span.notifications-center-title', history.length ? 'Notifications' : 'No New Notifications'),
      h('div.notification-toolbar',
        h('button.icon-btn', { type: 'button', title: 'Clear All Notifications', on: { click: clearNotifications } }, icon('clear-all')),
        h('button.icon-btn', { type: 'button', title: doNotDisturb ? 'Disable Do Not Disturb Mode' : 'Enable Do Not Disturb Mode', on: { click: toggleDoNotDisturb } }, icon('bell-slash')),
        h('button.icon-btn', { type: 'button', title: 'Hide Notifications', on: { click: () => toggleNotificationCenter(false) } }, icon('chevron-down')))),
    history.length ? h('div.notifications-list', history.map(n => notificationRow(n, {
      inCenter: true,
      close: () => { history.splice(history.indexOf(n), 1); drawCenter(); emit('notifications:changed', notificationState()); },
    }))) : null);
}

/* ---------- dialogs ---------- */

/* confirm({ message, detail, buttons: ['Save', "Don't Save"], cancel: 'Cancel',
   severity }) resolves to the index of the chosen button, or -1 for Cancel /
   Escape. The first button is the primary one. */
export function confirm({ message, detail, buttons = ['OK'], cancel = 'Cancel', severity = 'warning' }) {
  return new Promise(resolve => {
    const done = i => { overlay.remove(); prevFocus?.focus?.(); resolve(i); };
    const prevFocus = document.activeElement;
    const btns = buttons.map((b, i) => h('button.btn' + (i === 0 ? '.primary' : '.secondary'), { type: 'button', on: { click: () => done(i) } }, b));
    if (cancel) btns.push(h('button.btn.secondary', { type: 'button', on: { click: () => done(-1) } }, cancel));
    const box = h('div.dialog', { role: 'dialog', 'aria-modal': 'true' },
      h('div.dialog-toolbar', h('button.icon-btn', { type: 'button', title: 'Close Dialog', on: { click: () => done(-1) } }, icon('close'))),
      h('div.dialog-body', icon(severity === 'error' ? 'error' : severity === 'info' ? 'info' : 'warning', 'dialog-icon ' + severity),
        h('div.dialog-text', h('div.dialog-msg', message), detail ? h('div.dialog-detail', detail) : null)),
      h('div.dialog-buttons', btns));
    const overlay = h('div.dialog-overlay', box);
    overlay.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(-1); }
    });
    document.body.append(overlay);
    btns[0].focus();
  });
}

/* ---------- hover tooltip ---------- */

let tip = null;
let tipTimer = 0;

// Delayed tooltips for elements with data-tip, styled like VS Code hovers.
export function initTooltips() {
  document.addEventListener('mouseover', e => {
    const t = e.target.closest?.('[data-tip]');
    clearTimeout(tipTimer);
    if (!t) { tip?.remove(); tip = null; return; }
    tipTimer = setTimeout(() => {
      tip?.remove();
      tip = h('div.tooltip', t.dataset.tip);
      document.body.append(tip);
      const r = t.getBoundingClientRect();
      const tr = tip.getBoundingClientRect();
      const below = r.bottom + 6 + tr.height < innerHeight;
      tip.style.left = Math.max(4, Math.min(r.left + r.width / 2 - tr.width / 2, innerWidth - tr.width - 4)) + 'px';
      tip.style.top = (below ? r.bottom + 6 : r.top - tr.height - 6) + 'px';
    }, 600);
  });
  document.addEventListener('mousedown', () => { clearTimeout(tipTimer); tip?.remove(); tip = null; }, true);
}

/* ---------- view panes ---------- */

/* pane({ title, collapsed, grow, actions: () => [{ icon, title, run }],
   badge, onToggle }) is a collapsible section of a side bar view, like
   Explorer's Open Editors / folder / Outline. Returns { el, body, refresh,
   setBadge, expanded() }. */
export function pane(opts) {
  const body = h('div.pane-body');
  const actions = h('span.pane-actions');
  const badge = h('span.badge.pane-badge', { hidden: true });
  const twistie = h('span.pane-twistie', icon('chevron-right'));
  const head = h('div.pane-header', { tabindex: '0', role: 'button' },
    twistie,
    h('h3.pane-title', opts.title),
    actions,
    badge);
  const el = h('section.pane' + (opts.grow ? '.grow' : ''), head, body);
  let collapsed = !!opts.collapsed;
  const apply = () => {
    el.classList.toggle('collapsed', collapsed);
    twistie.replaceChildren(icon(collapsed ? 'chevron-right' : 'chevron-down'));
    head.setAttribute('aria-expanded', String(!collapsed));
    opts.onToggle?.(!collapsed);
  };
  const toggle = () => { collapsed = !collapsed; apply(); };
  head.addEventListener('click', e => { if (!e.target.closest('.pane-actions')) toggle(); });
  head.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  const refresh = () => {
    actions.replaceChildren(...(opts.actions?.() || []).map(a =>
      h('button.icon-btn', { type: 'button', title: a.title, 'aria-label': a.title, on: { click: e => { e.stopPropagation(); a.run(e.currentTarget); } } }, icon(a.icon))));
  };
  refresh();
  apply();
  return {
    el, body, head, refresh,
    setTitle: t => { head.querySelector('.pane-title').textContent = t; },
    setBadge: n => { badge.hidden = !n; badge.textContent = String(n || ''); },
    expanded: () => !collapsed,
    expand: () => { if (collapsed) toggle(); },
  };
}

/* promptText({ title, placeholder, value, ok }) asks for multi-line text in a
   modal (a review comment, say). Ctrl/Cmd+Enter accepts. Resolves to the
   text or null. */
export function promptText({ title, detail, placeholder = '', value = '', ok = 'OK' }) {
  return new Promise(resolve => {
    const prevFocus = document.activeElement;
    const ta = h('textarea.dialog-textarea', { placeholder, rows: 6, spellcheck: true });
    ta.value = value;
    const done = v => { overlay.remove(); prevFocus?.focus?.(); resolve(v); };
    const box = h('div.dialog.dialog-wide', { role: 'dialog', 'aria-modal': 'true' },
      h('div.dialog-toolbar', h('button.icon-btn', { type: 'button', title: 'Close Dialog', on: { click: () => done(null) } }, icon('close'))),
      h('div.dialog-text.dialog-text-only', h('div.dialog-msg', title), detail ? h('div.dialog-detail', detail) : null, ta),
      h('div.dialog-buttons',
        h('button.btn.primary', { type: 'button', on: { click: () => done(ta.value) } }, ok),
        h('button.btn.secondary', { type: 'button', on: { click: () => done(null) } }, 'Cancel')));
    const overlay = h('div.dialog-overlay', box);
    overlay.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); done(ta.value); }
    });
    document.body.append(overlay);
    ta.focus();
  });
}
