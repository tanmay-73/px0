// One delay per document. Settings changes cancel pending saves immediately;
// focus changes also cover switching tabs and leaving an editor for the sidebar.
export function initAutoSave({ on, setting, allDocs, isDirty, save, window, document, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const timers = new Map();
  const mode = () => setting('files.autoSave', 'off');
  const eligible = d => d && allDocs().includes(d) && d.model && !d.model.isDisposed() &&
    !d.readonly && !d.binary && !d.tooLarge && !d.deleted && !d.conflict && isDirty(d);
  const cancel = d => { clearTimer(timers.get(d)); timers.delete(d); };
  const saveNow = d => { if (eligible(d)) return save(d, { automatic: true }); };
  const schedule = d => {
    cancel(d);
    if (mode() !== 'afterDelay' || !eligible(d)) return;
    const delay = Number(setting('files.autoSaveDelay', 1000));
    timers.set(d, setTimer(() => {
      timers.delete(d);
      if (mode() === 'afterDelay') saveNow(d);
    }, Number.isFinite(delay) && delay >= 0 && delay <= 2147483647 ? delay : 1000));
  };
  const focusChanged = d => { if (mode() === 'onFocusChange') saveNow(d); };
  const blur = () => { if (mode() === 'onFocusChange') allDocs().forEach(saveNow); };
  const visibility = () => { if (document.hidden) blur(); };
  let activeDoc = null;
  const subscriptions = [
    on('doc:changed', schedule),
    on('doc:dirty', schedule),
    on('doc:blur', focusChanged),
    on('editor:active', t => {
      const next = t?.doc || null;
      if (activeDoc !== next) focusChanged(activeDoc);
      activeDoc = next;
    }),
    on('settings:changed', keys => {
      if (keys && !keys.some(k => k === 'files.autoSave' || k === 'files.autoSaveDelay')) return;
      for (const d of timers.keys()) cancel(d);
      allDocs().forEach(schedule);
    }),
  ];
  window.addEventListener('blur', blur);
  document.addEventListener('visibilitychange', visibility);
  allDocs().forEach(schedule);
  return () => {
    subscriptions.forEach(dispose => dispose());
    for (const d of timers.keys()) cancel(d);
    window.removeEventListener('blur', blur);
    document.removeEventListener('visibilitychange', visibility);
  };
}
