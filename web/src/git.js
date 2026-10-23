// web/src/git.js
// Git state for the whole UI: /api/git/status (branch, upstream, staged and
// unstaged changes, conflicts), refetched whenever the server's event stream
// says something changed. The Source Control view renders it, the explorer and
// tabs colour files by it, the status bar shows the branch and sync counts.
import { api, post, S } from './api.js';
import { emit, on, debounce } from './util.js';
import { notify } from './ui.js';

export const G = {
  git: false,
  branch: '', detached: false, head: '', upstream: '', ahead: 0, behind: 0,
  operation: '',
  staged: [], changes: [], conflicts: [],
  byPath: new Map(), // path -> { status, staged, conflict } (worktree status wins for display)
  dirtyDirs: new Set(),
  busy: '', // name of a running operation (commit, push, pull...)
  loaded: false,
};

const UNTRACKED = 'U';

export async function refreshGit() {
  if (!S.meta?.git) { G.loaded = true; emit('git:changed', G); return G; }
  let j;
  try { j = await api('api/git/status'); } catch { return G; }
  Object.assign(G, {
    git: !!j.git, branch: j.branch || '', detached: !!j.detached, head: j.head || '', upstream: j.upstream || '',
    ahead: j.ahead || 0, behind: j.behind || 0, operation: j.operation || '',
    staged: j.staged || [], changes: j.changes || [], conflicts: j.conflicts || [], truncated: !!j.truncated, loaded: true,
  });
  const byPath = new Map();
  for (const f of G.staged) byPath.set(f.path, { status: f.status, staged: true });
  for (const f of G.changes) byPath.set(f.path, { status: f.status, staged: byPath.has(f.path), untracked: f.status === UNTRACKED });
  for (const f of G.conflicts) byPath.set(f.path, { status: '!', conflict: true });
  G.byPath = byPath;
  const dirs = new Set();
  for (const p of byPath.keys()) {
    let i = p.lastIndexOf('/');
    while (i > 0) { dirs.add(p.slice(0, i)); i = p.lastIndexOf('/', i - 1); }
  }
  G.dirtyDirs = dirs;
  emit('git:changed', G);
  return G;
}

export const refreshGitSoon = debounce(refreshGit, 120);

export const changeCount = () => G.staged.length + G.changes.length + G.conflicts.length;

// The letter VS Code shows beside a file, and the colour class for it.
export function decoration(path) {
  const s = G.byPath.get(path);
  if (!s) return null;
  if (s.conflict) return { letter: '!', cls: 'git-conflict', title: 'Conflicting changes' };
  switch (s.status) {
    case 'U': return { letter: 'U', cls: 'git-untracked', title: 'Untracked' };
    case 'A': return { letter: 'A', cls: 'git-added', title: 'Index Added' };
    case 'D': return { letter: 'D', cls: 'git-deleted', title: s.staged ? 'Index Deleted' : 'Deleted' };
    case 'R': return { letter: 'R', cls: 'git-renamed', title: 'Index Renamed' };
    case 'C': return { letter: 'C', cls: 'git-renamed', title: 'Index Copied' };
    default: return { letter: 'M', cls: s.staged && !G.changes.some(f => f.path === path) ? 'git-staged' : 'git-modified', title: s.staged ? 'Index Modified' : 'Modified' };
  }
}

/* Every git operation goes through run(): one at a time, shown in the status
   bar, errors reported as notifications, status refetched afterwards. */
async function op(name, fn) {
  if (G.busy) return null;
  G.busy = name;
  emit('git:busy', name);
  emit('output', { channel: 'Git', text: `> git ${name}` });
  try {
    const r = await fn();
    emit('output', { channel: 'Git', text: `git ${name}: done` });
    return r;
  } catch (e) {
    emit('output', { channel: 'Git', text: `git ${name}: ${e.message || e}`, level: 'error' });
    notify(e.message || String(e), { severity: 'error', detail: 'git ' + name });
    return null;
  } finally {
    G.busy = '';
    emit('git:busy', '');
    await refreshGit();
    emit('git:after-op', name);
  }
}

export const stage = paths => op('add', () => post('api/git/stage', { paths }));
export const stageAll = () => op('add', () => post('api/git/stage', { all: true }));
export const unstage = paths => op('reset', () => post('api/git/unstage', { paths }));
export const unstageAll = () => op('reset', () => post('api/git/unstage', { all: true }));
export const discard = paths => op('restore', () => post('api/git/discard', { paths }));
export const commit = (message, { amend = false } = {}) => op('commit', () => post('api/git/commit', { message, amend }));
export const push = (opts = {}) => op('push', () => post('api/git/push', opts));
export const pull = () => op('pull', () => post('api/git/pull', {}));
export const abortOperation = () => op('abort', () => post('api/git/abort', {}));

export async function sync() {
  if (G.behind) { const r = await pull(); if (!r) return; }
  if (G.ahead || !G.upstream) await push();
}

export function initGit() {
  on('stream:git', refreshGitSoon);
  on('doc:saved', refreshGitSoon);
  on('fs:changed', refreshGitSoon);
  return refreshGit();
}
