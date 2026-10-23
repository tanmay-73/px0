// web/src/terminal.js
// The TERMINAL panel, as VS Code's integrated terminal: shells running on the
// server in pseudo-terminals (terminal.go), drawn by xterm.js. Terminals sit
// in groups; a group shows its terminals side by side (Split Terminal), and
// the tabs list on the right switches groups once there is more than one
// terminal. A terminal keeps running when the page reloads: on load the panel
// re-attaches to every shell the server still has and replays its screen.
//
// Output is acknowledged once xterm has drawn it (flow control: the server
// holds the shell back while too much is outstanding), and bash's shell
// integration marks (OSC 633, terminal_bash.sh) become a decoration beside
// each command showing whether it failed, with Rerun and Copy Output.
import { Terminal } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { S, api, post, apiURL } from './api.js';
import { h, icon, on, emit, pref, setPref, debounce, isMac, keyLabel } from './util.js';
import { showMenu, notify } from './ui.js';
import { inputBox } from './quickinput.js';
import { setting, EDITOR_FONT } from './settings.js';
import { isDark } from './theme.js';
import { openFile } from './editors.js';
import { keysFor, setTerminalKeyFilter } from './commands.js';
import { showPanel, setPanelVisible, activePanelId } from './layout.js';

const T = {
  enabled: false,
  reason: '',
  loaded: false,
  groups: [],       // [{ id, instances: [inst], focused: inst, el }]
  active: null,     // the group shown
  view: null,       // panel container
  groupsEl: null,
  tabsEl: null,
};
let groupSeq = 0;
let visible = false;
let loading = null;
const ensureLoaded = () => (loading ||= load());

const layoutKey = () => 'terminal.groups:' + (S.meta?.root || '');
const allInstances = () => T.groups.flatMap(g => g.instances);
export const activeTerminal = () => T.active?.focused || null;
export const isTerminalFocused = () => !!document.activeElement?.closest?.('.terminal-instance');

/* ---------- appearance ---------- */

// VS Code's default ANSI palette (terminalColorRegistry.ts), per scheme.
const ANSI = {
  dark: ['#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
    '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#e5e5e5'],
  light: ['#000000', '#cd3131', '#107c10', '#949800', '#0451a5', '#bc05bc', '#0598bc', '#555555',
    '#666666', '#f14c4c', '#14ce14', '#b5ba00', '#3b8eea', '#d670d6', '#29b8db', '#a5a5a5'],
};
const ANSI_NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'];

function xtermTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fb = '') => cs.getPropertyValue('--' + name).trim() || fb;
  const palette = ANSI[isDark() ? 'dark' : 'light'];
  const theme = {
    background: v('term-bg', v('panel-bg', v('bg2'))),
    foreground: v('term-fg', v('fg')),
    cursor: v('term-cursor', v('fg')),
    cursorAccent: v('term-bg', v('panel-bg', v('bg2'))),
    selectionBackground: v('term-sel', v('sel')),
    scrollbarSliderBackground: v('scrollbar'),
    scrollbarSliderHoverBackground: v('scrollbar-hover'),
    scrollbarSliderActiveBackground: v('scrollbar-active'),
  };
  // A theme may set its own ANSI colours as --ansi-red, --ansi-bright-red, ...
  ANSI_NAMES.forEach((n, i) => { theme[n] = v('ansi-' + n.replace(/[A-Z]/g, c => '-' + c.toLowerCase()), palette[i]); });
  return theme;
}

const decorationsSetting = () => setting('terminal.integrated.shellIntegration.decorationsEnabled', 'both');
const gutterDecorations = () => ['both', 'gutter'].includes(decorationsSetting());
const rulerDecorations = () => ['both', 'overviewRuler'].includes(decorationsSetting());

// The options settings control (applied again when they change).
function xtermOptions() {
  return {
    fontFamily: setting('terminal.integrated.fontFamily', '') || setting('editor.fontFamily', '') || EDITOR_FONT,
    fontSize: Number(setting('terminal.integrated.fontSize', 14)) || 14,
    fontWeight: setting('terminal.integrated.fontWeight', 'normal'),
    fontWeightBold: setting('terminal.integrated.fontWeightBold', 'bold'),
    letterSpacing: Number(setting('terminal.integrated.letterSpacing', 0)) || 0,
    lineHeight: Number(setting('terminal.integrated.lineHeight', 1)) || 1,
    cursorBlink: !!setting('terminal.integrated.cursorBlinking', false),
    cursorStyle: setting('terminal.integrated.cursorStyle', 'block'),
    scrollback: Number(setting('terminal.integrated.scrollback', 1000)) || 1000,
    minimumContrastRatio: Number(setting('terminal.integrated.minimumContrastRatio', 4.5)) || 1,
    altClickMovesCursor: setting('terminal.integrated.altClickMovesCursor', true) !== false,
    overviewRuler: rulerDecorations() ? { width: 10 } : {},
    theme: xtermTheme(),
  };
}

// VS Code's defaults for what settings do not cover.
const XTERM_FIXED = {
  allowProposedApi: true,
  macOptionIsMeta: false,
  rightClickSelectsWord: isMac,
  drawBoldTextInBrightColors: true,
  customGlyphs: true,
  rescaleOverlappingGlyphs: true,
  fastScrollSensitivity: 5,
  scrollSensitivity: 1,
  wordSeparator: ' ()[]{}\',"`─‘’“”|',
};

/* ---------- instances ---------- */

function makeInstance(info, group) {
  // Start at the shell's own size, so replayed output lays out as it was drawn.
  const size = info.cols && info.rows ? { cols: info.cols, rows: info.rows } : {};
  const term = new Terminal({ ...XTERM_FIXED, ...xtermOptions(), ...size });
  const fit = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(new WebLinksAddon((e, uri) => { if (e.ctrlKey || e.metaKey) window.open(uri, '_blank', 'noopener'); }));
  const uni = new Unicode11Addon();
  term.loadAddon(uni);
  term.unicode.activeVersion = '11';
  // OSC 8 hyperlinks (ls --hyperlink, compiler diagnostics): Ctrl+click.
  term.options.linkHandler = {
    allowNonHttpProtocols: true,
    activate: (e, uri) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (/^file:/i.test(uri)) { try { openTerminalPath(inst, decodeURIComponent(new URL(uri).pathname), 0, 0); } catch {} }
      else if (/^https?:/i.test(uri)) window.open(uri, '_blank', 'noopener');
    },
  };
  const host = h('div.terminal-xterm-host');
  const findBox = findWidget(term, search);
  const el = h('div.terminal-instance', { dataset: { id: info.id } }, host, findBox.el);
  const inst = {
    id: info.id, name: info.name || 'bash', title: info.title || info.name || 'bash', cwd: info.cwd || '', shell: info.shell || '',
    renamed: !!info.name && info.name !== (info.shell || '').split('/').pop(),
    term, fit, search, findBox, el, host, ws: null, group, exited: false, disposed: false, retries: 0, opened: false,
    webgl: null, replaying: false, unacked: 0, ackTimer: 0, held: null, heldBytes: 0, resync: false, bell: false, killing: false,
    commands: [], current: null, // shell integration: finished commands, the one being typed or run
  };
  const encoder = new TextEncoder();
  term.onData(d => sendBytes(inst, encoder.encode(d)));
  // Mouse reports in the legacy encoding are bytes, not text.
  term.onBinary(d => sendBytes(inst, Uint8Array.from(d, c => c.charCodeAt(0) & 255)));
  // While replaying, sizes come from the server; the final one is sent after.
  term.onResize(({ cols, rows }) => { if (!inst.replaying) send(inst, { type: 'resize', cols, rows }); });
  term.onBell(() => ringBell(inst));
  // Command decorations belong to the shell, not to full-screen programs.
  term.buffer.onBufferChange(b => el.classList.toggle('alt-buffer', b.type === 'alternate'));
  term.onSelectionChange(debounce(() => {
    if (setting('terminal.integrated.copyOnSelection', false) && term.hasSelection()) navigator.clipboard?.writeText(term.getSelection()).catch(() => {});
  }, 150));
  term.attachCustomKeyEventHandler(e => terminalKey(inst, e));
  term.registerLinkProvider(fileLinks(inst));
  term.parser.registerOscHandler(633, data => shellIntegration(inst, data));
  term.parser.registerOscHandler(52, data => osc52(data));
  el.addEventListener('mousedown', () => focusInstance(inst, false));
  el.addEventListener('contextmenu', e => { e.preventDefault(); instanceMenu(inst, e.clientX, e.clientY); });
  return inst;
}

function openXterm(inst) {
  if (inst.opened || !inst.host.isConnected) return;
  inst.opened = true;
  inst.term.open(inst.host);
  inst.term.textarea?.addEventListener('focus', () => focusInstance(inst, false));
  useRenderer(inst);
  fitSoon(inst);
}

// The GPU renderer, as VS Code's terminal.integrated.gpuAcceleration: much
// faster under heavy output; xterm's DOM renderer when WebGL is unavailable
// or its context is lost.
function useRenderer(inst) {
  const want = setting('terminal.integrated.gpuAcceleration', 'auto') !== 'off';
  if (!want) { inst.webgl?.dispose(); inst.webgl = null; return; }
  if (inst.webgl || !inst.opened) return;
  try {
    const gl = new WebglAddon();
    gl.onContextLoss(() => { gl.dispose(); if (inst.webgl === gl) inst.webgl = null; });
    inst.term.loadAddon(gl);
    inst.webgl = gl;
  } catch {
    inst.webgl = null;
  }
}

// OSC 52: programs (vim, tmux) copying to the clipboard. Reading it is
// refused, as in VS Code: any program could otherwise read what you copied.
function osc52(data) {
  const [, b64] = data.split(';');
  if (!b64 || b64 === '?') return true;
  try {
    const text = new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
    navigator.clipboard?.writeText(text).catch(() => {});
  } catch {}
  return true;
}

function ringBell(inst) {
  if (!setting('terminal.integrated.enableBell', false)) return;
  inst.bell = true;
  drawTabs();
  drawChrome();
  clearTimeout(inst.bellTimer);
  inst.bellTimer = setTimeout(() => { inst.bell = false; drawTabs(); drawChrome(); }, 1000);
}

function send(inst, msg) {
  if (inst.ws?.readyState === WebSocket.OPEN) inst.ws.send(JSON.stringify(msg));
}

function sendBytes(inst, bytes) {
  if (inst.ws?.readyState === WebSocket.OPEN) inst.ws.send(bytes);
}

// Acknowledges drawn output, a few at a time.
function ack(inst, n) {
  inst.unacked += n;
  if (inst.unacked >= 32768) { flushAck(inst); return; }
  if (!inst.ackTimer) inst.ackTimer = setTimeout(() => flushAck(inst), 16);
}

function flushAck(inst) {
  clearTimeout(inst.ackTimer);
  inst.ackTimer = 0;
  if (inst.unacked) send(inst, { type: 'ack', bytes: inst.unacked });
  inst.unacked = 0;
}

// While the page is hidden the browser runs xterm's timers rarely, so
// output is acknowledged as it arrives and held until the page is shown;
// past a few megabytes it is dropped, and the terminal replays its screen
// from the server instead.
const HOLD_LIMIT = 8 << 20;

function receive(inst, bytes) {
  if (document.hidden || inst.held) {
    inst.held ||= [];
    ack(inst, bytes.length);
    if (inst.resync) return;
    inst.heldBytes += bytes.length;
    if (inst.heldBytes > HOLD_LIMIT) { inst.resync = true; inst.held = []; return; }
    inst.held.push(bytes);
    return;
  }
  const ws = inst.ws; // output from an earlier socket is not this one's to acknowledge
  inst.term.write(bytes, () => { if (inst.ws === ws) ack(inst, bytes.length); });
}

// after runs once xterm has drawn everything received before it.
function after(inst, fn) {
  if (document.hidden || inst.held) {
    inst.held ||= [];
    if (!inst.resync) inst.held.push(fn);
    return;
  }
  inst.term.write('', fn);
}

function releaseHeld(inst) {
  if (!inst.held) return;
  const held = inst.held;
  inst.held = null;
  inst.heldBytes = 0;
  if (inst.resync) {
    inst.resync = false;
    inst.ws?.close(); // reconnects, and replays the screen
    return;
  }
  for (const b of held) {
    if (typeof b === 'function') inst.term.write('', b);
    else inst.term.write(b);
  }
}

function socketURL(id) {
  const u = new URL(apiURL('api/terminal/ws', { id }));
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.href;
}

function connect(inst) {
  if (inst.disposed || inst.exited) return;
  const ws = new WebSocket(socketURL(inst.id));
  ws.binaryType = 'arraybuffer';
  inst.ws = ws;
  let gotData = false;
  ws.onopen = () => {
    inst.retries = 0;
    // The server replays the screen: start from a clean terminal.
    inst.term.reset();
    resetCommands(inst);
    inst.held = null;
    inst.heldBytes = 0;
    inst.resync = false;
    clearTimeout(inst.ackTimer);
    inst.ackTimer = 0;
    inst.unacked = 0;
    inst.replaying = true;
  };
  ws.onmessage = e => {
    if (ws !== inst.ws) return;
    if (typeof e.data !== 'string') { gotData = true; receive(inst, new Uint8Array(e.data)); return; }
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'size') {
      // The replay comes in parts, each drawn at the size the terminal had
      // then (bash redraws its prompt for every resize).
      after(inst, () => { if (inst.replaying) inst.term.resize(msg.cols, msg.rows); });
    } else if (msg.type === 'replayed') {
      after(inst, () => {
        inst.replaying = false;
        fitInstance(inst);
        send(inst, { type: 'resize', cols: inst.term.cols, rows: inst.term.rows });
      });
    } else if (msg.type === 'info') {
      if (msg.title) inst.title = msg.title;
      if (msg.cwd) inst.cwd = msg.cwd;
      drawTabs();
      drawChrome();
    } else if (msg.type === 'exit') onExit(inst, msg.code);
  };
  ws.onclose = () => {
    if (inst.ws !== ws || inst.disposed || inst.exited) return;
    inst.ws = null;
    // The server drops a socket that falls behind, or px0 restarted: try
    // again, and give up once the server no longer knows this terminal.
    if (++inst.retries > 4 && !gotData) { checkGone(inst); return; }
    setTimeout(() => connect(inst), Math.min(2000, 100 * inst.retries));
  };
}

async function checkGone(inst) {
  try {
    const j = await api('api/terminal/list');
    if (j.terminals?.some(t => t.id === inst.id)) { inst.retries = 0; connect(inst); return; }
  } catch {}
  onExit(inst, null);
}

function onExit(inst, code) {
  if (inst.exited || inst.disposed) return;
  inst.exited = true;
  inst.ws?.close();
  // As VS Code: a clean exit (or Kill Terminal) closes the terminal; a
  // failure stays to be read.
  if (code === 0 || inst.killing) { disposeInstance(inst); return; }
  const why = code === null ? 'The terminal process is no longer running.'
    : `The terminal process "${inst.shell || inst.name}" terminated with exit code: ${code}.`;
  inst.term.write(`\r\n\x1b[0m\x1b[7m * \x1b[0m ${why}\r\n\x1b[0m\x1b[7m * \x1b[0m Press any key to close the terminal.\r\n`);
  const sub = inst.term.onKey(() => { sub.dispose(); disposeInstance(inst); });
  drawChrome();
}

function disposeInstance(inst) {
  if (inst.disposed) return;
  inst.disposed = true;
  inst.ws?.close();
  clearTimeout(inst.ackTimer);
  clearTimeout(inst.bellTimer);
  inst.term.dispose();
  const g = inst.group;
  g.instances = g.instances.filter(x => x !== inst);
  if (g.focused === inst) g.focused = g.instances[g.instances.length - 1] || null;
  if (!g.instances.length) {
    const i = T.groups.indexOf(g);
    T.groups.splice(i, 1);
    if (T.active === g) T.active = T.groups[Math.min(i, T.groups.length - 1)] || null;
  }
  saveLayout();
  render();
  if (T.active?.focused && visible) focusInstance(T.active.focused, true);
}

async function killInstance(inst) {
  if (!inst) return;
  if (inst.exited) { disposeInstance(inst); return; }
  inst.killing = true;
  try { await post('api/terminal/kill', { id: inst.id }); } catch (e) { notify(e.message, { severity: 'error' }); }
  // The exit message closes it; if the socket is gone, close it here.
  setTimeout(() => { if (!inst.disposed) { inst.exited = true; disposeInstance(inst); } }, 2500);
}

/* ---------- creating ---------- */

// The size of a character cell, measured as xterm measures it.
function cellSize() {
  const o = xtermOptions();
  const ctx = (cellSize.ctx ||= document.createElement('canvas').getContext('2d'));
  ctx.font = `${o.fontWeight} ${o.fontSize}px ${o.fontFamily}`;
  const m = ctx.measureText('W');
  const height = Math.ceil(m.fontBoundingBoxAscent + m.fontBoundingBoxDescent) || Math.ceil(o.fontSize * 1.2);
  return { w: m.width + o.letterSpacing, h: Math.floor(height * o.lineHeight) };
}

// The size a new terminal will have in the panel, so its shell starts at it
// and draws its first prompt once (bash redraws the prompt on a resize).
function estimateSize(split) {
  const g = T.groupsEl;
  let width = g?.clientWidth || 800;
  if (allInstances().length >= 1 && T.tabsEl?.hidden) width -= pref('terminal.tabsWidth', 160) + 4; // the tabs list appears
  const panes = split && T.active ? T.active.instances.length + 1 : 1;
  const paneWidth = (width - (panes - 1)) / panes - 20 - 14; // gutter, scrollbar
  const height = (g?.clientHeight || 240) - 6;
  const cell = cellSize();
  return { cols: Math.max(20, Math.floor(paneWidth / cell.w)), rows: Math.max(4, Math.floor(height / cell.h)) };
}

/* newTerminal({ cwd, split, name }) starts a shell. cwd is relative to the
   workspace root; split puts it beside the active terminal. */
export async function newTerminal({ cwd, split = false, name } = {}) {
  await ensureLoaded();
  if (!T.enabled) { notify(T.reason || 'The integrated terminal is not available.', { severity: 'warning' }); return null; }
  let info;
  try {
    // A split starts where the terminal it splits is (the server follows
    // its shell's working directory).
    info = await post('api/terminal/new', { cwd: cwd ?? '', from: split && cwd == null ? activeTerminal()?.id : undefined, name, ...estimateSize(split && cwd == null) });
  } catch (e) {
    notify('Could not create the terminal: ' + e.message, { severity: 'error' });
    return null;
  }
  let g = split && T.active ? T.active : null;
  if (!g) {
    g = { id: ++groupSeq, instances: [], focused: null, el: null };
    T.groups.push(g);
  }
  const inst = makeInstance(info, g);
  g.instances.push(inst);
  g.focused = inst;
  T.active = g;
  saveLayout();
  render();
  connect(inst);
  focusInstance(inst, true);
  return inst;
}

// Re-attaches to the shells the server is running (after a reload).
async function load() {
  let j;
  try { j = await api('api/terminal/list'); } catch (e) { T.enabled = false; T.reason = e.message; T.loaded = true; return; }
  T.enabled = !!j.enabled;
  T.reason = j.reason || '';
  T.loaded = true;
  const byId = new Map((j.terminals || []).map(t => [t.id, t]));
  const saved = pref(layoutKey(), []);
  const used = new Set();
  const groups = [];
  for (const ids of Array.isArray(saved) ? saved : []) {
    const list = (ids || []).filter(id => byId.has(id) && !used.has(id));
    list.forEach(id => used.add(id));
    if (list.length) groups.push(list);
  }
  for (const t of j.terminals || []) if (!used.has(t.id)) groups.push([t.id]);
  for (const ids of groups) {
    const g = { id: ++groupSeq, instances: [], focused: null, el: null };
    for (const id of ids) {
      const inst = makeInstance(byId.get(id), g);
      g.instances.push(inst);
      g.focused = inst;
    }
    T.groups.push(g);
  }
  T.active = T.groups[pref(layoutKey() + ':active', 0)] || T.groups[0] || null;
  render();
  for (const inst of allInstances()) connect(inst);
}

function saveLayout() {
  setPref(layoutKey(), T.groups.map(g => g.instances.map(i => i.id)));
  setPref(layoutKey() + ':active', Math.max(0, T.groups.indexOf(T.active)));
}

/* ---------- focus and layout ---------- */

function focusInstance(inst, focusXterm = true) {
  if (!inst || inst.disposed) return;
  const groupChanged = T.active !== inst.group;
  const changed = groupChanged || inst.group.focused !== inst;
  T.active = inst.group;
  inst.group.focused = inst;
  // Switching groups swaps the panes; within a group only the highlight
  // moves, so a click that focuses a pane is not lost to a redraw.
  if (groupChanged) render();
  else if (changed) { drawTabs(); drawChrome(); }
  if (changed) saveLayout();
  if (focusXterm) requestAnimationFrame(() => inst.term.focus());
  for (const x of allInstances()) x.el.classList.toggle('focused', x === inst);
}

export function focusTerminal() {
  const inst = activeTerminal();
  if (inst) focusInstance(inst, true);
}

const fitSoon = inst => requestAnimationFrame(() => fitInstance(inst));

function fitInstance(inst) {
  if (!inst.opened || inst.disposed || inst.replaying || !inst.host.clientWidth || !inst.host.clientHeight) return;
  try { inst.fit.fit(); } catch {}
}

const fitAll = debounce(() => { for (const inst of T.active?.instances || []) fitInstance(inst); }, 30);

/* ---------- drawing ---------- */

function render() {
  if (!T.view) return;
  if (!T.enabled) {
    T.view.replaceChildren(h('div.panel-message', T.loaded ? (T.reason || 'The integrated terminal is not available.') : 'Starting…'));
    drawChrome();
    return;
  }
  if (!T.view.contains(T.groupsEl)) T.view.replaceChildren(T.groupsEl, T.tabsSash, T.tabsEl);
  const g = T.active;
  // Rebuild the panes only when they change: moving a focused xterm's
  // element would drop its focus.
  const want = g ? g.instances.map(i => i.el) : [];
  const have = [...T.groupsEl.children].filter(c => c.classList.contains('terminal-instance'));
  if (want.length !== have.length || want.some((el, i) => el !== have[i]) || !g) {
    T.groupsEl.replaceChildren();
    if (g) {
      g.instances.forEach((inst, i) => {
        if (i) T.groupsEl.append(splitSash(g, i));
        inst.el.style.flex = inst.flex ? `${inst.flex} 1 0` : '1 1 0';
        T.groupsEl.append(inst.el);
      });
    } else {
      T.groupsEl.append(h('div.panel-message', 'No terminals are open.'));
    }
  }
  for (const inst of g?.instances || []) {
    if (!inst.opened) openXterm(inst);
    else if (!inst.shown) requestAnimationFrame(() => inst.term.refresh(0, inst.term.rows - 1));
  }
  for (const x of allInstances()) x.shown = x.group === g;
  for (const x of allInstances()) x.el.classList.toggle('focused', x === g?.focused);
  drawTabs();
  drawChrome();
  fitAll();
}

function splitSash(g, i) {
  const s = h('div.sash.sash-v.terminal-sash');
  s.addEventListener('pointerdown', e => {
    e.preventDefault();
    s.setPointerCapture(e.pointerId);
    const left = g.instances[i - 1], right = g.instances[i];
    const lw = left.el.getBoundingClientRect().width, rw = right.el.getBoundingClientRect().width;
    const x0 = e.clientX;
    const move = ev => {
      const d = ev.clientX - x0;
      left.flex = Math.max(80, lw + d); right.flex = Math.max(80, rw - d);
      left.el.style.flex = `${left.flex} 1 0`; right.el.style.flex = `${right.flex} 1 0`;
      fitAll();
    };
    const up = () => { s.removeEventListener('pointermove', move); s.removeEventListener('pointerup', up); };
    s.addEventListener('pointermove', move);
    s.addEventListener('pointerup', up);
  });
  return s;
}

// As VS Code: the foreground process, unless the user renamed the terminal.
const instLabel = inst => (inst.renamed ? inst.name : inst.title) || inst.name;

// The tabs list on the right, shown once there is more than one terminal.
function drawTabs() {
  if (!T.tabsEl) return; // the panel has not been shown yet
  const show = allInstances().length > 1;
  T.tabsEl.hidden = !show;
  T.tabsSash.hidden = !show;
  if (!show) return;
  const rows = [];
  for (const g of T.groups) {
    g.instances.forEach((inst, i) => {
      const tree = g.instances.length < 2 ? '' : i === 0 ? '┌' : i === g.instances.length - 1 ? '└' : '├';
      const row = h('div.terminal-tab' + (g === T.active && inst === g.focused ? '.active' : '') + (g === T.active ? '.in-active-group' : ''),
        { title: `${instLabel(inst)}\n${inst.cwd || ''}`, dataset: { id: inst.id } },
        tree ? h('span.terminal-tab-tree', tree) : null,
        icon(inst.bell ? 'bell' : 'terminal', 'terminal-tab-icon'),
        h('span.terminal-tab-label', instLabel(inst) + (inst.exited ? ' (exited)' : '')),
        h('span.terminal-tab-actions',
          h('button.icon-btn', { type: 'button', title: `Split Terminal (${keyLabel(keysFor('workbench.action.terminal.split'))})`, on: { click: e => { e.stopPropagation(); focusInstance(inst, false); newTerminal({ split: true }); } } }, icon('split-horizontal')),
          h('button.icon-btn', { type: 'button', title: 'Kill Terminal', on: { click: e => { e.stopPropagation(); killInstance(inst); } } }, icon('trash'))));
      row.addEventListener('click', () => focusInstance(inst, true));
      row.addEventListener('dblclick', () => renameTerminal(inst));
      row.addEventListener('contextmenu', e => { e.preventDefault(); instanceMenu(inst, e.clientX, e.clientY); });
      rows.push(row);
    });
  }
  T.tabsEl.replaceChildren(...rows);
}

// The panel title: the terminal's name while there is no tabs list.
export function terminalWidget() {
  const inst = activeTerminal();
  if (!inst || allInstances().length > 1) return h('span');
  return h('span.terminal-title', { title: inst.cwd || '' }, icon(inst.bell ? 'bell' : 'terminal'), h('span', instLabel(inst)));
}

export const terminalActions = () => [
  { icon: 'add', title: `New Terminal (${keyLabel(keysFor('workbench.action.terminal.new'))})`, run: () => newTerminal() },
  { icon: 'split-horizontal', title: `Split Terminal (${keyLabel(keysFor('workbench.action.terminal.split'))})`, run: () => (activeTerminal() ? newTerminal({ split: true }) : newTerminal()) },
  { icon: 'trash', title: 'Kill Terminal', disabled: !activeTerminal(), run: () => killInstance(activeTerminal()) },
  { icon: 'ellipsis', title: 'More Actions...', run: el => { const r = el.getBoundingClientRect(); terminalMoreMenu(r.left, r.bottom + 2); } },
];

const drawChrome = debounce(() => emit('panel:actions'), 0);

/* ---------- shell integration ---------- */

// OSC 633 values escape backslash, semicolon and control characters.
const unescape633 = v => v.replace(/\\(\\|x([0-9a-f]{2}))/gi, (_, c, hex) => (hex ? String.fromCharCode(parseInt(hex, 16)) : '\\'));

/* The marks bash's integration script writes: A prompt start, B prompt end
   (typing starts), E the command line, C its output starts, D;code it
   finished, P;Cwd= the working directory. A command is kept with markers
   at its prompt and its output, which survive scrolling and reflow. */
function shellIntegration(inst, data) {
  const term = inst.term;
  const [kind, ...args] = data.split(';');
  const cur = inst.current;
  switch (kind) {
    case 'A':
      if (cur && !cur.done) disposeCommand(cur);
      inst.current = { prompt: term.registerMarker(0), command: '', output: null, end: null, exitCode: undefined, deco: null, done: false, time: 0 };
      break;
    case 'E':
      if (cur) cur.command = unescape633(args[0] || '');
      break;
    case 'C':
      if (cur && !cur.output) {
        cur.output = term.registerMarker(0);
        cur.time = Date.now();
        decorate(inst, cur);
      }
      break;
    case 'D':
      if (cur?.output && !cur.done) {
        cur.done = true;
        cur.exitCode = args.length && args[0] !== '' ? Number(args[0]) : undefined;
        cur.end = term.registerMarker(0);
        cur.paint?.();
        inst.commands.push(cur);
        if (inst.commands.length > 500) disposeCommand(inst.commands.shift());
      }
      if (cur && !cur.output) disposeCommand(cur); // an empty line: nothing ran
      inst.current = null;
      break;
    case 'P': {
      const [key, ...v] = args.join(';').split('=');
      if (key === 'Cwd' && v.length) { inst.cwd = unescape633(v.join('=')); drawTabs(); drawChrome(); }
      break;
    }
  }
  return true;
}

function disposeCommand(c) {
  c.deco?.dispose();
  for (const m of [c.prompt, c.output, c.end]) m?.dispose();
}

function resetCommands(inst) {
  for (const c of inst.commands) disposeCommand(c);
  if (inst.current) disposeCommand(inst.current);
  inst.commands = [];
  inst.current = null;
}

// VS Code's command decoration colours (terminalCommandDecoration.*).
const decorationColor = state => (state === 'error' ? (isDark() ? '#f14c4c' : '#e51400')
  : state === 'success' ? (isDark() ? '#1b81a8' : '#2090d3') : (isDark() ? '#ffffff40' : '#00000040'));
const commandState = c => (!c.done || c.exitCode === undefined ? 'default' : c.exitCode === 0 ? 'success' : 'error');

// The circle in the gutter beside a command's prompt: hollow while it runs,
// blue once it succeeded, red if it failed; click for its actions.
function decorate(inst, cmd) {
  if (decorationsSetting() === 'never' || cmd.prompt.isDisposed) return;
  // The overview ruler mark can only be recoloured if it existed from the start.
  const ruler = () => ({ color: rulerDecorations() && cmd.done ? decorationColor(commandState(cmd)) : 'transparent', position: 'left' });
  const deco = inst.term.registerDecoration({ marker: cmd.prompt, overviewRulerOptions: ruler() });
  if (!deco) return;
  cmd.deco = deco;
  let el = null;
  const paint = () => {
    const state = commandState(cmd);
    deco.options.overviewRulerOptions = ruler();
    if (!el) return;
    // Keep xterm's own classes on the element (xterm-decoration, ...).
    el.classList.remove(...[...el.classList].filter(c => c.startsWith('codicon') || ['default', 'success', 'error'].includes(c)));
    el.classList.add('terminal-command-decoration', 'codicon', 'codicon-' + (state === 'error' ? 'error-small' : state === 'success' ? 'primitive-dot' : 'circle-outline'), state);
    el.classList.toggle('off', !gutterDecorations());
    el.style.color = decorationColor(state);
    el.title = !cmd.done ? 'Running' : state === 'error' ? `Command failed (exit code ${cmd.exitCode})` : state === 'success' ? 'Command succeeded' : 'Command finished';
  };
  cmd.paint = paint;
  deco.onRender(e => {
    if (el !== e) {
      el = e;
      el.addEventListener('mousedown', ev => { ev.preventDefault(); ev.stopPropagation(); });
      el.addEventListener('click', ev => {
        ev.stopPropagation();
        const r = el.getBoundingClientRect();
        commandMenu(inst, cmd, r.left, r.bottom + 2);
      });
    }
    paint();
  });
}

// The command's output: the lines from where it started writing to where its
// prompt came back.
function commandOutput(inst, cmd) {
  if (!cmd.output || !cmd.end || cmd.output.isDisposed || cmd.end.isDisposed) return '';
  const buf = inst.term.buffer.normal;
  const lines = [];
  for (let y = cmd.output.line; y < cmd.end.line; y++) {
    const line = buf.getLine(y);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  return lines.join('\n').replace(/\s+$/, '');
}

function commandMenu(inst, cmd, x, y) {
  const output = commandOutput(inst, cmd);
  showMenu([
    { label: 'Rerun Command', disabled: !cmd.command || !cmd.done, run: () => { sendBytes(inst, new TextEncoder().encode(cmd.command + '\r')); inst.term.focus(); } },
    { label: 'Copy Command', disabled: !cmd.command, run: () => writeClipboard(inst, cmd.command) },
    { label: 'Copy Output', disabled: !output, run: () => writeClipboard(inst, output) },
    { separator: true },
    { label: cmd.done && cmd.exitCode !== undefined ? `Exit code ${cmd.exitCode}` : 'Running', disabled: true },
  ], x, y);
}

// Scroll to Previous/Next Command (Ctrl+Up/Down), by their prompts.
function scrollToCommand(inst, dir) {
  const term = inst.term;
  const lines = inst.commands.concat(inst.current && inst.current.output ? [inst.current] : [])
    .filter(c => !c.prompt.isDisposed).map(c => c.prompt.line);
  if (!lines.length) { term.scrollLines(dir); return; }
  const top = term.buffer.active.viewportY;
  const target = dir < 0 ? lines.filter(l => l < top).pop() : lines.find(l => l > top);
  if (target === undefined) { if (dir > 0) term.scrollToBottom(); else term.scrollToLine(lines[0]); return; }
  term.scrollToLine(target);
}

/* ---------- menus and commands ---------- */

function terminalMoreMenu(x, y) {
  const inst = activeTerminal();
  showMenu([
    { label: 'New Terminal', keys: keysFor('workbench.action.terminal.new'), run: () => newTerminal() },
    { label: 'Split Terminal', keys: keysFor('workbench.action.terminal.split'), disabled: !inst, run: () => newTerminal({ split: true }) },
    { separator: true },
    { label: 'Clear Terminal', disabled: !inst, run: () => clearTerminal() },
    { label: 'Rename...', disabled: !inst, run: () => renameTerminal(inst) },
    { label: 'Find', keys: 'Mod+F', disabled: !inst, run: () => findInTerminal() },
    { separator: true },
    { label: 'Kill Terminal', disabled: !inst, run: () => killInstance(inst) },
    { label: 'Kill All Terminals', disabled: !inst, run: () => allInstances().forEach(killInstance) },
  ], x, y);
}

function instanceMenu(inst, x, y) {
  focusInstance(inst, false);
  const sel = inst.term.hasSelection();
  showMenu([
    { label: 'Copy', keys: isMac ? 'Mod+C' : 'Mod+Shift+C', disabled: !sel, run: () => copySelection(inst) },
    { label: 'Paste', keys: isMac ? 'Mod+V' : 'Mod+Shift+V', run: () => pasteInto(inst) },
    { label: 'Select All', run: () => inst.term.selectAll() },
    { separator: true },
    { label: 'Clear Terminal', run: () => clearTerminal(inst) },
    { label: 'Split Terminal', keys: keysFor('workbench.action.terminal.split'), run: () => newTerminal({ split: true }) },
    { label: 'Rename...', run: () => renameTerminal(inst) },
    { separator: true },
    { label: 'Kill Terminal', run: () => killInstance(inst) },
  ], x, y);
}

export async function renameTerminal(inst = activeTerminal()) {
  if (!inst) return;
  const name = await inputBox({ prompt: 'Enter terminal name', value: instLabel(inst) });
  if (name === null) return;
  inst.name = name.trim() || inst.title;
  inst.renamed = !!name.trim();
  post('api/terminal/rename', { id: inst.id, name: inst.name }).catch(() => {});
  drawTabs();
  drawChrome();
}

export function clearTerminal(inst = activeTerminal()) {
  inst?.term.clear();
}

// The async clipboard needs a secure page (https or localhost); elsewhere
// copying falls back to the older execCommand.
async function writeClipboard(inst, text) {
  if (!text) return;
  try { await navigator.clipboard.writeText(text); return; } catch {}
  const ta = h('textarea', { style: { position: 'fixed', top: '0', left: '0', opacity: '0' } });
  ta.value = text;
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch {}
  ta.remove();
  inst.term.focus();
  if (!ok) notify('Could not copy to the clipboard', { severity: 'error' });
}

const copySelection = inst => writeClipboard(inst, inst.term.getSelection());

async function pasteInto(inst) {
  try { const text = await navigator.clipboard.readText(); if (text) inst.term.paste(text); }
  catch { notify(`Use the keyboard to paste here (${isMac ? 'Cmd+V' : 'Ctrl+Shift+V or Shift+Insert'}): the browser allows the Paste menu item only on https or localhost.`, { severity: 'info' }); }
  inst.term.focus();
}

/* Keys the terminal handles itself rather than sending to the shell, as
   VS Code's: copy and paste, Find, scrolling, and stepping between
   commands. The workbench's own shortcuts (commands with `terminal: true`)
   never reach xterm: commands.js takes them first. */
function terminalKey(inst, e) {
  if (e.type !== 'keydown') return true;
  const term = inst.term;
  const mod = isMac ? e.metaKey : e.ctrlKey;
  const k = e.key.toLowerCase();
  const stop = () => { e.preventDefault(); e.stopPropagation(); return false; };
  if (isMac ? (e.metaKey && k === 'c') : (e.ctrlKey && e.shiftKey && k === 'c')) {
    if (term.hasSelection()) { copySelection(inst); return stop(); }
    return !isMac;
  }
  if (isMac ? (e.metaKey && k === 'v') : (e.ctrlKey && e.shiftKey && k === 'v')) {
    // Let the browser paste into xterm's textarea; xterm sends it on.
    return false;
  }
  if (mod && !e.shiftKey && !e.altKey && k === 'f') { inst.findBox.open(); return stop(); }
  // Delete a word with Ctrl+Backspace / Ctrl+Delete (Alt on a Mac), as
  // VS Code sends them: readline's unix-word-rubout and kill-word.
  if ((isMac ? e.altKey : e.ctrlKey) && !e.shiftKey && !(isMac ? e.ctrlKey : e.altKey) && !e.metaKey) {
    if (e.key === 'Backspace') { sendBytes(inst, Uint8Array.of(0x17)); return stop(); }
    if (e.key === 'Delete') { sendBytes(inst, Uint8Array.of(0x1b, 0x64)); return stop(); }
  }
  const normal = term.buffer.active.type === 'normal'; // full-screen programs scroll themselves
  if (normal && mod && !e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    if (e.shiftKey) term.scrollLines(e.key === 'ArrowUp' ? -1 : 1);
    else scrollToCommand(inst, e.key === 'ArrowUp' ? -1 : 1);
    return stop();
  }
  if (normal && e.shiftKey && !mod && !e.altKey && (e.key === 'PageUp' || e.key === 'PageDown')) {
    term.scrollPages(e.key === 'PageUp' ? -1 : 1);
    return stop();
  }
  if (normal && mod && !e.shiftKey && !e.altKey && (e.key === 'Home' || e.key === 'End')) {
    if (e.key === 'Home') term.scrollToTop(); else term.scrollToBottom();
    return stop();
  }
  if (isMac && e.metaKey && k === 'k') { term.clear(); return stop(); }
  if (isMac && e.metaKey) return false; // Cmd combinations are the browser's and px0's, not the shell's
  return true;
}

export function findInTerminal() {
  activeTerminal()?.findBox.open();
}

// A small find widget over the terminal, like the editor's.
function findWidget(term, search) {
  const input = h('input.terminal-find-input', { type: 'text', placeholder: 'Find', spellcheck: false, 'aria-label': 'Find' });
  const count = h('span.terminal-find-count');
  const opts = { regex: false, caseSensitive: false, wholeWord: false };
  const decorations = { matchOverviewRuler: '#d186167e', activeMatchColorOverviewRuler: '#a0a0a0cc', matchBackground: '#62331c', activeMatchBackground: '#515c6a' };
  const run = back => {
    const q = input.value;
    if (!q) { search.clearDecorations(); count.textContent = ''; return; }
    (back ? search.findPrevious(q, { ...opts, decorations }) : search.findNext(q, { ...opts, decorations, incremental: !back }));
  };
  search.onDidChangeResults?.(r => { count.textContent = input.value ? (r.resultCount ? `${r.resultIndex + 1} of ${r.resultCount}` : 'No results') : ''; });
  const toggle = (name, ic, title) => {
    const b = h('button.input-toggle', { type: 'button', title }, icon(ic));
    b.addEventListener('click', () => { opts[name] = !opts[name]; b.classList.toggle('on', opts[name]); run(false); input.focus(); });
    return b;
  };
  const el = h('div.terminal-find', { hidden: true },
    h('div.terminal-find-box', input, toggle('caseSensitive', 'case-sensitive', 'Match Case'), toggle('wholeWord', 'whole-word', 'Match Whole Word'), toggle('regex', 'regex', 'Use Regular Expression')),
    count,
    h('button.icon-btn', { type: 'button', title: 'Previous Match (Shift+Enter)', on: { click: () => run(true) } }, icon('arrow-up')),
    h('button.icon-btn', { type: 'button', title: 'Next Match (Enter)', on: { click: () => run(false) } }, icon('arrow-down')),
    h('button.icon-btn', { type: 'button', title: 'Close (Escape)', on: { click: () => close() } }, icon('close')));
  const close = () => { el.hidden = true; search.clearDecorations(); term.clearSelection(); term.focus(); };
  input.addEventListener('input', debounce(() => run(false), 80));
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); run(e.shiftKey); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  });
  return {
    el,
    open: () => {
      el.hidden = false;
      const sel = term.getSelection();
      if (sel && !sel.includes('\n')) input.value = sel;
      input.focus();
      input.select();
      if (input.value) run(false);
    },
  };
}

/* File links: "path/to/file.go:12:3" in the output opens the file, relative
   to the terminal's working directory, on Ctrl/Cmd+click as in VS Code. */
const FILE_RE = /(?:^|[\s'"(\[<])((?:\.{1,2}\/|\/)?(?:[\w@.+-]+\/)*[\w@+-][\w@.+-]*\.[A-Za-z0-9]{1,10})(?::(\d+)(?::(\d+))?|\((\d+),(\d+)\))?/g;

function fileLinks(inst) {
  return {
    provideLinks(y, callback) {
      const line = inst.term.buffer.active.getLine(y - 1)?.translateToString(true) || '';
      const links = [];
      FILE_RE.lastIndex = 0;
      let m;
      while ((m = FILE_RE.exec(line))) {
        const path = m[1];
        if (/^\w+:\/\//.test(path) || /^\d+(\.\d+)+$/.test(path)) continue;
        const start = m.index + m[0].indexOf(path);
        const text = m[0].slice(m[0].indexOf(path));
        const lineNo = +(m[2] || m[4] || 0), col = +(m[3] || m[5] || 0);
        links.push({
          range: { start: { x: start + 1, y }, end: { x: start + text.length, y } },
          text,
          decorations: { pointerCursor: true, underline: true },
          activate: (e) => { if (e.ctrlKey || e.metaKey) openTerminalPath(inst, path, lineNo, col); },
        });
      }
      callback(links.length ? links : undefined);
    },
  };
}

async function openTerminalPath(inst, path, line, col) {
  const root = (S.meta?.root || '').replace(/\/$/, '');
  let abs = path.startsWith('/') ? path : (inst.cwd || root) + '/' + path;
  const parts = [];
  for (const p of abs.split('/')) { if (p === '..') parts.pop(); else if (p && p !== '.') parts.push(p); }
  abs = '/' + parts.join('/');
  const rel = abs === root ? '' : abs.startsWith(root + '/') ? abs.slice(root.length + 1) : abs;
  const t = await openFile(rel, { line: line || undefined, col: col || undefined, quiet: true });
  if (!t) notify(`Unable to open '${path}': no such file in the workspace.`, { severity: 'warning' });
}

/* ---------- panel ---------- */

export function renderTerminal(container) {
  T.view = container;
  container.classList.add('terminal-view');
  T.groupsEl = h('div.terminal-groups');
  T.tabsSash = h('div.sash.sash-v.terminal-tabs-sash', { hidden: true });
  T.tabsEl = h('div.terminal-tabs', { hidden: true, role: 'list', style: { width: pref('terminal.tabsWidth', 160) + 'px' } });
  T.tabsSash.addEventListener('pointerdown', e => {
    e.preventDefault();
    T.tabsSash.setPointerCapture(e.pointerId);
    const w0 = T.tabsEl.getBoundingClientRect().width, x0 = e.clientX;
    const move = ev => { T.tabsEl.style.width = Math.max(80, Math.min(480, w0 - (ev.clientX - x0))) + 'px'; fitAll(); };
    const up = () => { setPref('terminal.tabsWidth', parseInt(T.tabsEl.style.width, 10)); T.tabsSash.removeEventListener('pointermove', move); T.tabsSash.removeEventListener('pointerup', up); };
    T.tabsSash.addEventListener('pointermove', move);
    T.tabsSash.addEventListener('pointerup', up);
  });
  new ResizeObserver(() => fitAll()).observe(T.groupsEl);
  render();
}

/* showTerminal({ create, split, cwd }) shows the TERMINAL panel and focuses
   the active terminal, starting one when asked or when there is none. */
export async function showTerminal({ create = false, split = false, cwd } = {}) {
  await ensureLoaded();
  noAutoCreate = true;
  showPanel('terminal');
  noAutoCreate = false;
  if (!T.enabled) return; // the panel says why
  if (create || !allInstances().length) await newTerminal({ split: split && !!activeTerminal(), cwd });
  else focusTerminal();
}

// Toggle Terminal (Ctrl+`): hide it when it has focus, otherwise show and focus it.
export function toggleTerminal() {
  if (activePanelId() === 'terminal' && isTerminalFocused()) { setPanelVisible(false); return; }
  showTerminal();
}

export const killTerminal = () => killInstance(activeTerminal());

let noAutoCreate = false;

// Called when the TERMINAL panel is shown: VS Code opens a terminal if there is none.
export async function onTerminalShown({ focus }) {
  visible = true;
  const auto = !noAutoCreate;
  await ensureLoaded();
  render();
  if (auto && T.enabled && !allInstances().length) await newTerminal();
  else if (focus) focusTerminal();
  fitAll();
}

export const terminalCount = () => allInstances().length;

// Commands that still run when Send Keybindings to Shell gives every other
// key to the shell.
const ALWAYS_WORKBENCH = new Set(['workbench.action.terminal.toggleTerminal', 'workbench.action.terminal.new', 'workbench.action.terminal.split', 'workbench.action.showCommands']);

export function initTerminal() {
  on('theme:changed', () => {
    const theme = xtermTheme();
    for (const i of allInstances()) { i.term.options.theme = theme; i.commands.forEach(c => c.paint?.()); }
  });
  on('settings:changed', () => {
    const o = xtermOptions();
    for (const i of allInstances()) {
      for (const [k, v] of Object.entries(o)) if (k !== 'theme' && JSON.stringify(i.term.options[k]) !== JSON.stringify(v)) i.term.options[k] = v;
      useRenderer(i);
      i.commands.forEach(c => c.paint?.());
      fitInstance(i);
    }
  });
  setTerminalKeyFilter((cmd, allowed) => (setting('terminal.integrated.sendKeybindingsToShell', false) ? ALWAYS_WORKBENCH.has(cmd.id) : allowed));
  // A web font that finishes loading after a terminal opened changes the
  // cell size: measure again.
  document.fonts?.addEventListener?.('loadingdone', () => {
    for (const i of allInstances()) {
      const f = i.term.options.fontFamily;
      i.term.options.fontFamily = f + ', monospace';
      i.term.options.fontFamily = f;
      i.webgl?.clearTextureAtlas();
      fitInstance(i);
    }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) allInstances().forEach(releaseHeld); });
  // Ctrl+W deletes a word in bash but closes the browser tab, and a page
  // cannot stop that: ask first when it happens with a terminal focused, as
  // VS Code in a browser does (window.confirmBeforeClose: keyboardOnly).
  let modDown = 0;
  addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && isTerminalFocused()) modDown = Date.now(); }, true);
  addEventListener('keyup', e => { if (e.key === 'Control' || e.key === 'Meta') modDown = 0; }, true);
  addEventListener('beforeunload', e => {
    if (modDown && Date.now() - modDown < 5000 && allInstances().some(i => !i.exited)) { e.preventDefault(); e.returnValue = ''; }
  });
  on('layout:changed', L => { visible = L.panelVisible && L.panel === 'terminal'; if (visible) fitAll(); });
  // Re-attach to shells that survived a reload without waiting for the panel.
  ensureLoaded();
}
