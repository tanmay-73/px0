// web/src/commands.js
// The command registry and keybindings. Every action the UI offers is a
// command { id, title, category, keys, when, run }: the palette lists them,
// menus and buttons call them by id, and the key dispatcher runs them.
// Keys are written "Mod+Shift+P" (Mod is Cmd on a Mac, Ctrl elsewhere); a
// space separates the two halves of a chord ("Mod+K Mod+S").
import { isMac, emit } from './util.js';

const commands = new Map();

export function register(cmd) {
  commands.set(cmd.id, cmd);
  return cmd;
}

export function registerAll(list) {
  for (const c of list) register(c);
}

export const getCommand = id => commands.get(id);

export function allCommands() {
  return [...commands.values()].filter(c => c.title && !c.hidden && (!c.when || c.when()));
}

export async function run(id, ...args) {
  const c = commands.get(id);
  if (!c) { console.warn('unknown command', id); return; }
  if (c.when && !c.when()) return;
  emit('command:will-run', id);
  return c.run(...args);
}

// The combo an event spells, in the same form keys are written in.
function comboOf(e) {
  let key = e.key;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (e.code === 'Backquote') key = '`';
  else if (e.code === 'Backslash') key = '\\';
  else if (e.code === 'Comma') key = ',';
  else if (e.code === 'Period') key = '.';
  else if (e.code === 'Slash') key = '/';
  else if (e.code === 'BracketLeft') key = '[';
  else if (e.code === 'BracketRight') key = ']';
  else if (e.code === 'Equal') key = '=';
  else if (e.code === 'Minus') key = '-';
  else if (key === ' ') key = 'Space';
  else if (key.length === 1) key = key.toUpperCase();
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(key)) return '';
  const mod = isMac ? e.metaKey : e.ctrlKey;
  const parts = [];
  if (mod) parts.push('Mod');
  if (isMac && e.ctrlKey) parts.push('Ctrl');
  if (!isMac && e.metaKey) parts.push('Meta');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

const norm = k => k.split(' ').map(ch => ch.split('+').map(p => (p.length === 1 ? p.toUpperCase() : p)).join('+')).join(' ');

let chordPrefix = '';
let chordTimer = 0;

// terminal.js may narrow which commands keep their keys inside a terminal
// (terminal.integrated.sendKeybindingsToShell).
let terminalKeyFilter = (cmd, allowed) => allowed;
export const setTerminalKeyFilter = fn => { terminalKeyFilter = fn; };

/* Keys go through the window in the capture phase, before Monaco or any input
   sees them, so global shortcuts work everywhere. While a text field (not
   Monaco) has focus only `global` commands run. While a terminal has focus
   the keys belong to the shell, as in VS Code: only commands marked
   `terminal` (true, or a list of their keys) run. */
export function initKeybindings() {
  addEventListener('keydown', e => {
    if (e.isComposing) return;
    const combo = comboOf(e);
    if (!combo) return;
    const typed = chordPrefix ? chordPrefix + ' ' + combo : combo;
    const inTerminal = e.target instanceof HTMLElement && !!e.target.closest('.terminal-instance');
    const inField = !inTerminal && e.target instanceof HTMLElement && e.target.closest('input, textarea, select, [contenteditable="true"]') &&
      !e.target.closest('.monaco-editor');
    const allowed = (c, nk) => (inTerminal
      ? terminalKeyFilter(c, c.terminal === true || (Array.isArray(c.terminal) && c.terminal.map(norm).includes(nk)))
      : (!inField || c.global));
    let prefixMatch = false;
    for (const c of commands.values()) {
      for (const k of c.keys || []) {
        const nk = norm(k);
        if (nk === typed) {
          if (c.when && !c.when(e)) continue;
          if (!allowed(c, nk)) continue;
          e.preventDefault();
          e.stopPropagation();
          chordPrefix = '';
          clearTimeout(chordTimer);
          emit('status:chord', '');
          run(c.id);
          return;
        }
        if (!chordPrefix && nk.startsWith(typed + ' ') && allowed(c, nk)) prefixMatch = true;
      }
    }
    if (prefixMatch) {
      e.preventDefault();
      e.stopPropagation();
      chordPrefix = combo;
      emit('status:chord', combo);
      clearTimeout(chordTimer);
      chordTimer = setTimeout(() => { chordPrefix = ''; emit('status:chord', ''); }, 2500);
      return;
    }
    if (chordPrefix) {
      chordPrefix = '';
      emit('status:chord', '');
    }
  }, true);
}

export function keysFor(id) {
  return commands.get(id)?.keys?.[0] || '';
}
