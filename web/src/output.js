// web/src/output.js
// The OUTPUT panel: named channels of log lines, picked from a drop-down in
// the panel title, as VS Code's. Other modules write to it through the event
// bus (emit('output', { channel, text })) so they need not import it; git
// operations and language server state changes land here.
import { h, on, emit, pref, setPref } from './util.js';

const channels = new Map(); // name -> [lines]
const MAX = 2000;
let current = pref('output.channel', 'Git');
let body = null;
let select = null;

const stamp = () => {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
};

export function appendOutput(channel, text, level = 'info') {
  if (!channels.has(channel)) { channels.set(channel, []); drawSelect(); }
  const lines = channels.get(channel);
  for (const t of String(text).split('\n')) lines.push(`${stamp()} [${level}] ${t}`);
  if (lines.length > MAX) lines.splice(0, lines.length - MAX);
  if (channel === current) draw();
}

function draw() {
  if (!body) return;
  const lines = channels.get(current) || [];
  const atEnd = body.scrollTop + body.clientHeight >= body.scrollHeight - 4;
  body.textContent = lines.join('\n');
  if (atEnd) body.scrollTop = body.scrollHeight;
}

function drawSelect() {
  if (!select) return;
  const names = [...channels.keys()].sort();
  if (!names.includes(current) && names.length) current = names[0];
  select.replaceChildren(...names.map(n => h('option', { value: n, selected: n === current }, n)));
}

export function renderOutput(container) {
  container.classList.add('output-view');
  body = h('pre.output-body', { tabindex: '0' });
  container.append(body);
  draw();
}

// The channel picker shown in the panel title while OUTPUT is active.
export function outputWidget() {
  select ||= h('select.panel-select', { title: 'Output channel', 'aria-label': 'Output channel', on: { change: () => { current = select.value; setPref('output.channel', current); draw(); } } });
  drawSelect();
  return select;
}

export const outputActions = () => [
  { icon: 'clear-all', title: 'Clear Output', run: () => { channels.set(current, []); draw(); } },
];

export function initOutput() {
  for (const n of ['Git', 'Language Server', 'px0']) channels.set(n, []);
  on('output', ({ channel, text, level }) => appendOutput(channel, text, level));
  const lastState = new Map(); // server -> state, so each transition is logged once
  on('lsp:state', s => {
    const server = s.server || 'language server';
    if (lastState.get(server) === s.state) return;
    lastState.set(server, s.state);
    appendOutput('Language Server', `${server}: ${s.state}`, s.state === 'failed' ? 'error' : 'info');
  });
  emit('badges:changed');
}
