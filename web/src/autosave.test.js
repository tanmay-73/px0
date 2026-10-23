import { test, expect } from 'bun:test';
import { initAutoSave } from './autosave.js';

function setup(mode = 'afterDelay', delay = 1000) {
  const values = { 'files.autoSave': mode, 'files.autoSaveDelay': delay };
  const docs = [];
  const saves = [];
  const listeners = new Map();
  const timers = new Map();
  let now = 0, nextId = 0;
  const window = new EventTarget();
  const document = new EventTarget();
  const emit = (event, value) => { for (const fn of listeners.get(event) || []) fn(value); };
  const dispose = initAutoSave({
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => listeners.get(event).delete(fn);
    },
    setting: (key, fallback) => values[key] ?? fallback,
    allDocs: () => docs,
    isDirty: d => d.dirty,
    save: (d, options) => { saves.push({ d, options }); d.dirty = false; },
    window, document,
    setTimer(fn, ms) { const id = ++nextId; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimer: id => timers.delete(id),
  });
  const tick = ms => {
    const end = now + ms;
    while (true) {
      const first = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!first || first[1].at > end) break;
      now = first[1].at;
      timers.delete(first[0]);
      first[1].fn();
    }
    now = end;
  };
  const doc = (props = {}) => {
    const d = { dirty: false, model: { isDisposed: () => false }, ...props };
    docs.push(d);
    return d;
  };
  const edit = d => { d.dirty = true; emit('doc:changed', d); };
  const update = patch => { Object.assign(values, patch); emit('settings:changed', Object.keys(patch)); };
  return { doc, docs, saves, emit, edit, update, tick, window, document, dispose, timers };
}

test('saves each document after its own last edit', () => {
  const h = setup();
  const a = h.doc(), b = h.doc();
  h.edit(a);
  h.tick(400);
  h.edit(b);
  h.tick(400);
  h.edit(a);
  h.tick(600);
  expect(h.saves.map(s => s.d)).toEqual([b]);
  h.tick(400);
  expect(h.saves.map(s => s.d)).toEqual([b, a]);
  expect(h.saves.every(s => s.options.automatic)).toBe(true);
});

test('disabling cancels pending saves and ignores later edits', () => {
  const h = setup();
  const d = h.doc();
  h.edit(d);
  h.tick(500);
  h.update({ 'files.autoSave': 'off' });
  h.tick(1000);
  h.edit(d);
  h.tick(1000);
  expect(h.saves).toHaveLength(0);
  expect(d.dirty).toBe(true);
});

test('enabling schedules files that already have unsaved changes', () => {
  const h = setup('off');
  const d = h.doc();
  h.edit(d);
  h.tick(2000);
  h.update({ 'files.autoSave': 'afterDelay' });
  h.tick(999);
  expect(h.saves).toHaveLength(0);
  h.tick(1);
  expect(h.saves[0].d).toBe(d);
});

test('changing the delay reschedules pending files; unrelated settings do not', () => {
  const h = setup();
  h.edit(h.doc());
  h.tick(500);
  h.update({ 'files.autoSaveDelay': 2000 });
  h.tick(1500);
  expect(h.saves).toHaveLength(0);
  h.update({ 'editor.fontSize': 18 });
  h.tick(500);
  expect(h.saves).toHaveLength(1);
});

test('zero delay works and invalid delays fall back to one second', () => {
  for (const delay of [0, -1, Infinity, 'invalid', 2147483648]) {
    const h = setup('afterDelay', delay);
    h.edit(h.doc());
    h.tick(0);
    expect(h.saves).toHaveLength(delay === 0 ? 1 : 0);
    h.tick(1000);
    expect(h.saves).toHaveLength(1);
  }
});

test('manual saves, discards, closed models and conflicts cannot trigger an automatic write', () => {
  const h = setup();
  const docs = [h.doc(), h.doc(), h.doc(), h.doc()];
  docs.forEach(h.edit);
  docs[0].dirty = false;
  docs[1].model.isDisposed = () => true;
  h.docs.splice(h.docs.indexOf(docs[2]), 1);
  docs[3].conflict = true;
  h.tick(1000);
  expect(h.saves).toHaveLength(0);
});

test('skips read-only, binary, oversized, deleted and conflicted documents', () => {
  const h = setup();
  for (const key of ['readonly', 'binary', 'tooLarge', 'deleted', 'conflict']) h.edit(h.doc({ [key]: true }));
  h.tick(1000);
  expect(h.saves).toHaveLength(0);
});

test('focus mode saves the editor being left, including a diff document', () => {
  const h = setup('onFocusChange');
  const a = h.doc(), b = h.doc();
  h.emit('editor:active', { doc: a });
  h.edit(a);
  h.tick(5000);
  expect(h.saves).toHaveLength(0);
  h.emit('editor:active', { doc: a }); // Same document in another group.
  expect(h.saves).toHaveLength(0);
  h.emit('editor:active', { kind: 'diff', doc: b });
  expect(h.saves.map(s => s.d)).toEqual([a]);
  h.edit(b);
  h.emit('doc:blur', b); // Focus moved into the sidebar or another widget.
  expect(h.saves.map(s => s.d)).toEqual([a, b]);
});

test('focus mode saves dirty documents on window blur and hidden page', () => {
  const h = setup('onFocusChange');
  const a = h.doc(), b = h.doc();
  h.edit(a);
  h.edit(b);
  h.window.dispatchEvent(new Event('blur'));
  expect(h.saves.map(s => s.d)).toEqual([a, b]);
  h.edit(a);
  h.document.hidden = true;
  h.document.dispatchEvent(new Event('visibilitychange'));
  expect(h.saves.map(s => s.d)).toEqual([a, b, a]);
  h.update({ 'files.autoSave': 'off' });
  h.edit(b);
  h.window.dispatchEvent(new Event('blur'));
  expect(h.saves).toHaveLength(3);
});

test('switching from delay to focus mode cancels pending timers', () => {
  const h = setup();
  const d = h.doc();
  h.edit(d);
  h.update({ 'files.autoSave': 'onFocusChange' });
  h.tick(2000);
  expect(h.saves).toHaveLength(0);
  h.emit('doc:blur', d);
  expect(h.saves).toHaveLength(1);
});

test('edits made while saving are scheduled again when the save finishes', () => {
  const h = setup();
  const d = h.doc();
  h.edit(d);
  h.tick(1000);
  h.edit(d);
  h.tick(300);
  h.emit('doc:dirty', d); // The saved version is older than the current text.
  h.tick(1000);
  expect(h.saves).toHaveLength(2);
});

test('dispose cancels pending work and removes focus and settings listeners', () => {
  const h = setup();
  const d = h.doc();
  h.edit(d);
  h.dispose();
  h.tick(1000);
  h.update({ 'files.autoSave': 'onFocusChange' });
  h.window.dispatchEvent(new Event('blur'));
  h.emit('doc:blur', d);
  expect(h.saves).toHaveLength(0);
  expect(h.timers.size).toBe(0);
});
