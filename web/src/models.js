// web/src/models.js
// Text documents. Every open file is one Monaco model shared by every editor
// showing it (a tab, the right side of its diff, a split), so an edit in one
// shows in all and the file is dirty in one place. A document remembers the
// file's mtime when it was read or saved: a save that finds the file changed
// on disk asks before overwriting, and documents whose file changed while they
// had no unsaved edits are reloaded quietly (checkDisk).
//
// Read-only "original" models (a file at HEAD, in the index, at a commit) are
// kept separately for the diff editors, keyed by path and ref.
import { monaco, languageFor } from './monaco.js';
import { api, post } from './api.js';
import { emit, basename } from './util.js';
import { notify, confirm } from './ui.js';
import { setting } from './settings.js';

const docs = new Map(); // path -> doc

export const fileUri = path => monaco.Uri.from({ scheme: 'file', path: '/' + path });
export const pathOfUri = uri => (uri.scheme === 'file' ? uri.path.replace(/^\//, '') : null);

export function getDoc(path) {
  return docs.get(path) || null;
}

export function allDocs() {
  return [...docs.values()];
}

export const isDirty = d => !!d && !d.readonly && d.model && d.model.getAlternativeVersionId() !== d.savedVersion;

/* openDoc loads path (once) and returns its document:
   { path, model, savedVersion, mtime, eol, refs, readonly, binary, tooLarge, deleted } */
export async function openDoc(path) {
  let d = docs.get(path);
  if (d) {
    if (d.loading) await d.loading;
    return d;
  }
  d = { path, model: null, savedVersion: 0, mtime: 0, refs: 0, readonly: false, binary: false, tooLarge: false, deleted: false };
  docs.set(path, d);
  d.loading = (async () => {
    let j;
    try {
      j = await api('api/file/text', { path });
    } catch (e) {
      docs.delete(path);
      throw e;
    }
    d.mtime = j.mtime || 0;
    d.size = j.size || 0;
    d.binary = !!j.binary;
    d.tooLarge = !!j.tooLarge;
    d.eol = j.eol || '\n';
    // Outside the workspace (a library a language server pointed at): read only.
    d.readonly = d.binary || d.tooLarge || path.startsWith('/');
    const uri = fileUri(path);
    monaco.editor.getModel(uri)?.dispose();
    d.model = monaco.editor.createModel(d.binary || d.tooLarge ? '' : j.text, languageFor(path), uri);
    d.model.setEOL(d.eol === '\r\n' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
    d.savedVersion = d.model.getAlternativeVersionId();
    let wasDirty = false;
    d.model.onDidChangeContent(() => {
      const now = isDirty(d);
      if (now !== wasDirty) { wasDirty = now; emit('doc:dirty', d); }
      emit('doc:changed', d);
    });
  })();
  await d.loading;
  d.loading = null;
  return d;
}

export function retain(d) { d.refs++; }

// Drops a reference; the model goes once nothing shows it and it is saved.
export function release(d) {
  d.refs = Math.max(0, d.refs - 1);
  if (d.refs === 0 && !isDirty(d) && !d.saving) {
    d.model?.dispose();
    docs.delete(d.path);
  }
}

/* save writes the model to disk. If the file changed on disk since it was
   read, the user chooses between overwriting it and keeping the disk copy. */
export async function save(d, { force = false, automatic = false } = {}) {
  if (!d) return false;
  // Serialize manual and automatic saves so an older request cannot overwrite
  // newer text, or replace the mtime remembered by a later save.
  while (d.saving) {
    const ok = await d.saving;
    if (automatic && !ok) return false;
  }
  if (d.readonly || !d.model || d.model.isDisposed()) return false;
  if (automatic && (!['afterDelay', 'onFocusChange'].includes(setting('files.autoSave', 'off')) ||
    !isDirty(d) || d.conflict || d.deleted)) return false;
  d.saving = writeDoc(d, { force, automatic });
  try {
    return await d.saving;
  } finally {
    d.saving = null;
    if (d.refs === 0 && !isDirty(d)) release(d);
  }
}

function beforeSave(model) {
  const edits = [];
  if (setting('files.trimTrailingWhitespace', false)) {
    for (let i = 1; i <= model.getLineCount(); i++) {
      const line = model.getLineContent(i);
      const trimmed = line.replace(/\s+$/, '');
      if (trimmed.length !== line.length) edits.push({ range: new monaco.Range(i, trimmed.length + 1, i, line.length + 1), text: '' });
    }
  }
  if (setting('files.insertFinalNewline', false)) {
    const last = model.getLineCount();
    if (model.getLineContent(last) !== '') edits.push({ range: new monaco.Range(last, model.getLineMaxColumn(last), last, model.getLineMaxColumn(last)), text: model.getEOL() });
  }
  if (edits.length) model.pushEditOperations([], edits, () => null);
}

async function writeDoc(d, { force, automatic }) {
  beforeSave(d.model);
  const content = d.model.getValue();
  const version = d.model.getAlternativeVersionId();
  try {
    const j = await post('api/file/save', force ? { path: d.path, content } : { path: d.path, content, mtime: d.mtime || undefined });
    if (j.conflict) throw Object.assign(new Error(j.error), { status: 409, body: j });
    d.mtime = j.mtime || d.mtime;
    d.savedVersion = version;
    d.deleted = false;
    d.conflict = false;
    emit('doc:dirty', d);
    emit('doc:saved', d);
    return true;
  } catch (e) {
    if (e.status === 409) {
      if (automatic) {
        d.conflict = true;
        emit('doc:dirty', d);
        notify(`Auto Save paused for '${basename(d.path)}': the file changed on disk. Save manually to resolve the conflict.`, { severity: 'warning' });
        return false;
      }
      const choice = await confirm({
        message: `Failed to save '${basename(d.path)}': the content of the file is newer.`,
        detail: 'The file was changed on disk after it was opened. Overwrite it with your changes, or discard them and load the version on disk?',
        buttons: ['Overwrite', 'Revert to Disk'],
      });
      if (choice === 0) return writeDoc(d, { force: true, automatic: false });
      if (choice === 1) await revert(d);
      return false;
    }
    notify(`Failed to save '${basename(d.path)}': ${e.message}`, { severity: 'error' });
    return false;
  }
}

// Replaces the model's text, keeping undo history and (as far as Monaco can) the cursor.
function replaceText(d, text) {
  if (d.model.getValue() === text) return;
  d.model.pushEditOperations([], [{ range: d.model.getFullModelRange(), text }], () => null);
  d.model.pushStackElement();
}

export async function revert(d) {
  const j = await api('api/file/text', { path: d.path });
  replaceText(d, j.text || '');
  d.mtime = j.mtime || 0;
  d.savedVersion = d.model.getAlternativeVersionId();
  d.conflict = false;
  d.deleted = false;
  emit('doc:dirty', d);
}

let checking = false;

/* checkDisk compares every open document's mtime with the disk: unchanged
   documents follow the file, dirty ones are flagged, deleted ones marked. */
export async function checkDisk() {
  if (checking) return;
  const list = allDocs().filter(d => d.model && !d.loading && !d.saving && !d.path.startsWith('/'));
  if (!list.length) return;
  checking = true;
  try {
    const j = await post('api/file/stat', { paths: list.map(d => d.path) });
    for (const d of list) {
      if (d.saving || d.model.isDisposed()) continue;
      const st = j.files?.[d.path];
      if (!st) continue;
      if (!st.exists) {
        if (!d.deleted) { d.deleted = true; emit('doc:dirty', d); }
        continue;
      }
      if (d.deleted) { d.deleted = false; emit('doc:dirty', d); }
      if (st.mtime && d.mtime && st.mtime !== d.mtime) {
        if (isDirty(d)) {
          if (!d.conflict) {
            d.conflict = true;
            notify(`'${basename(d.path)}' changed on disk while you have unsaved changes.`, {
              severity: 'warning',
              actions: [
                { label: 'Revert to Disk', run: () => revert(d) },
                { label: 'Keep Mine', run: () => { d.conflict = true; } },
              ],
            });
          }
        } else {
          try { await revert(d); } catch {}
        }
      }
    }
  } catch {} finally {
    checking = false;
  }
}

/* ---------- originals for diffs ---------- */

const originals = new Map(); // key -> { model, ref, path, exists }

/* originalModel returns a read-only model of path at ref ("HEAD", "INDEX",
   "BASE", "<sha>", "<sha>^"), fetched from /api/git/show. refresh re-reads it
   (the index or HEAD moved). */
export async function originalModel(path, ref, { refresh = false } = {}) {
  const key = ref + '\0' + path;
  let o = originals.get(key);
  if (o && !refresh) return o;
  const j = await api('api/git/show', { path, ref });
  const text = j.binary ? '(binary file)' : j.tooLarge ? '(file too large to show)' : (j.text || '');
  if (o) {
    if (o.model.getValue() !== text) o.model.setValue(text);
    o.exists = !!j.exists;
    return o;
  }
  const uri = monaco.Uri.from({ scheme: 'git', path: '/' + path, query: ref });
  monaco.editor.getModel(uri)?.dispose();
  o = { model: monaco.editor.createModel(text, languageFor(path), uri), ref, path, exists: !!j.exists };
  originals.set(key, o);
  return o;
}

// Re-reads every cached original (after a commit, stage, checkout...).
export async function refreshOriginals() {
  await Promise.allSettled([...originals.values()].filter(o => !/^[0-9a-f]{7,40}\^?$/.test(o.ref))
    .map(o => originalModel(o.path, o.ref, { refresh: true })));
}

export function releaseOriginal(o) {
  // Kept for reuse; dropped only when many accumulate.
  if (originals.size > 60) {
    for (const [k, v] of originals) {
      if (v === o) continue;
      v.model.dispose();
      originals.delete(k);
      if (originals.size <= 40) break;
    }
  }
}

/* A read-only model of arbitrary text (a deleted file's empty side, a file
   inside a commit). */
export function textModel(text, path, tag) {
  const uri = monaco.Uri.from({ scheme: 'px0-text', path: '/' + path, query: tag || String(Date.now()) });
  monaco.editor.getModel(uri)?.dispose();
  return monaco.editor.createModel(text, languageFor(path), uri);
}
