// web/src/scm.js
// The Source Control view, as VS Code's: a commit message box and Commit
// button over the Merge Changes / Staged Changes / Changes groups, each file
// with inline Open File / Discard / Stage / Unstage actions, then the commit
// history (COMMITS) with each commit's files. Clicking a change opens it in
// the diff editor: Changes compare the index with the working tree (and stay
// editable on the right), Staged Changes compare HEAD with the index.
import { api, S } from './api.js';
import { h, icon, basename, dirname, on, emit, pref, setPref, keyLabel, relTime, debounce } from './util.js';
import { G, stage, stageAll, unstage, unstageAll, discard, commit, push, pull, sync, abortOperation, changeCount } from './git.js';
import { openDiff, openFile } from './editors.js';
import { showMenu, showMenuAt, confirm, notify, pane } from './ui.js';
import { fileIcon } from './icons.js';
import { run } from './commands.js';

let msgEl, commitBtn, groupsEl, banner, changesPane, commitsPane;
const collapsedGroups = new Set(pref('scm.collapsed', []));
const draftKey = () => 'scm.message:' + (S.meta?.root || '');

/* ---------- opening changes ---------- */

export function openChange(f, group, opts = {}) {
  const name = basename(f.path);
  const preview = opts.preview ?? true;
  if (group === 'conflicts' || (group === 'changes' && f.status === 'U')) return openFile(f.path, { preview });
  if (group === 'staged') {
    return openDiff({
      path: f.path,
      left: f.status === 'A' ? { empty: true } : { ref: 'HEAD', of: f.from || undefined },
      right: f.status === 'D' ? { empty: true } : { ref: 'INDEX' },
      title: `${name} (Index)`, preview, ...opts,
    });
  }
  return openDiff({
    path: f.path, left: { ref: 'INDEX' }, right: f.status === 'D' ? { empty: true } : { path: f.path },
    title: `${name} (${f.status === 'D' ? 'Deleted' : 'Working Tree'})`, preview, ...opts,
  });
}

// The change of path in the working tree (or the index), for "Open Changes".
export function openChangeOf(path) {
  const w = G.changes.find(f => f.path === path);
  if (w) return openChange(w, 'changes', { preview: false });
  const s = G.staged.find(f => f.path === path);
  if (s) return openChange(s, 'staged', { preview: false });
  notify(`'${basename(path)}' has no changes.`);
  return null;
}

/* ---------- commit ---------- */

async function doCommit({ amend = false, then = '' } = {}) {
  const message = msgEl.value.trim();
  if (!message && !amend) {
    notify('Please enter a commit message.', { severity: 'warning' });
    msgEl.focus();
    return;
  }
  if (!amend && !G.staged.length) {
    if (!G.changes.length) { notify('There are no changes to commit.'); return; }
    if (!pref('scm.smartCommit', false)) {
      const c = await confirm({
        message: 'There are no staged changes to commit.',
        detail: 'Would you like to stage all your changes and commit them directly?',
        buttons: ['Yes', 'Always'], severity: 'info',
      });
      if (c === -1) return;
      if (c === 1) setPref('scm.smartCommit', true);
    }
    if (!(await stageAll())) return;
  }
  const r = await commit(message, { amend });
  if (!r) return;
  msgEl.value = '';
  setPref(draftKey(), '');
  autosize();
  loadCommits();
  if (then === 'push') await push();
  if (then === 'sync') await sync();
}

function commitMenu(anchor) {
  showMenuAt([
    { label: 'Commit', run: () => doCommit() },
    { label: 'Commit (Amend)', run: () => doCommit({ amend: true }) },
    { separator: true },
    { label: 'Commit & Push', run: () => doCommit({ then: 'push' }) },
    { label: 'Commit & Sync', run: () => doCommit({ then: 'sync' }) },
  ], anchor);
}

export function moreMenu(anchor) {
  showMenuAt([
    { label: 'Pull', disabled: !G.upstream, run: () => pull().then(loadCommits) },
    { label: 'Push', run: () => push().then(loadCommits) },
    { label: 'Force Push (with lease)', run: async () => {
      if (await confirm({ message: 'Force push the current branch?', detail: 'This rewrites the remote branch (git push --force-with-lease). Use it after rebasing a branch that was already pushed.', buttons: ['Force Push'] }) === 0) push({ force: true }).then(loadCommits);
    } },
    { label: 'Sync', run: () => sync().then(loadCommits) },
    { separator: true },
    { label: 'Commit', run: () => doCommit() },
    { label: 'Commit (Amend)', run: () => doCommit({ amend: true }) },
    { label: 'Commit & Push', run: () => doCommit({ then: 'push' }) },
    { separator: true },
    { label: 'Stage All Changes', disabled: !G.changes.length, run: stageAll },
    { label: 'Unstage All Changes', disabled: !G.staged.length, run: unstageAll },
    { label: 'Discard All Changes', disabled: !G.changes.length, run: () => discardFiles(G.changes) },
    G.operation && { separator: true },
    G.operation && { label: `Abort ${G.operation[0].toUpperCase() + G.operation.slice(1)}`, run: abortOperation },
  ], anchor);
}

async function discardFiles(files) {
  if (!files.length) return;
  const untracked = files.filter(f => f.status === 'U');
  const one = files.length === 1;
  const c = await confirm({
    message: one
      ? (untracked.length ? `Are you sure you want to DELETE ${basename(files[0].path)}?` : `Are you sure you want to discard changes in ${basename(files[0].path)}?`)
      : `Are you sure you want to discard ALL changes in ${files.length} files?`,
    detail: untracked.length ? `This is IRREVERSIBLE! ${untracked.length} untracked file${untracked.length > 1 ? 's' : ''} will be deleted from disk.` : 'This is IRREVERSIBLE! Your current working set will be FOREVER LOST.',
    buttons: [one ? (untracked.length ? 'Delete File' : 'Discard File') : 'Discard All ' + files.length + ' Files'],
  });
  if (c !== 0) return;
  await discard(files.map(f => f.path));
  emit('fs:changed');
}

/* ---------- rendering ---------- */

function autosize() {
  msgEl.style.height = 'auto';
  msgEl.style.height = Math.min(220, Math.max(26, msgEl.scrollHeight)) + 'px';
}

function drawButton() {
  const n = changeCount();
  const branch = G.branch || (G.detached ? G.head : '');
  msgEl.placeholder = `Message (${keyLabel('Mod+Enter')} to commit${branch ? ` on "${branch}"` : ''})`;
  const main = commitBtn.querySelector('.scm-commit-main');
  const drop = commitBtn.querySelector('.scm-commit-drop');
  if (!n && (G.ahead || G.behind)) {
    main.replaceChildren(icon('sync'), ` Sync Changes ${G.behind ? G.behind + '↓ ' : ''}${G.ahead ? G.ahead + '↑' : ''}`);
    main.onclick = () => sync().then(loadCommits);
    drop.hidden = true;
  } else if (!n && G.branch && !G.upstream && G.git && G.head) {
    main.replaceChildren(icon('cloud-upload'), ' Publish Branch');
    main.onclick = () => push().then(loadCommits);
    drop.hidden = true;
  } else {
    main.replaceChildren(icon('check'), ' Commit');
    main.onclick = () => doCommit();
    drop.hidden = false;
  }
  main.disabled = !!G.busy;
}

function fileRow(f, group) {
  const name = basename(f.path);
  const dir = dirname(f.path);
  const letterCls = { M: 'git-modified', A: 'git-added', D: 'git-deleted', U: 'git-untracked', R: 'git-renamed', C: 'git-renamed', T: 'git-modified' }[f.status] || (group === 'conflicts' ? 'git-conflict' : 'git-modified');
  const acts = [];
  const act = (ic, title, fn) => h('button.icon-btn', { type: 'button', title, on: { click: e => { e.stopPropagation(); fn(); } } }, icon(ic));
  if (f.status !== 'D') acts.push(act('go-to-file', 'Open File', () => openFile(f.path, { preview: false })));
  if (group === 'changes') {
    acts.push(act('discard', f.status === 'U' ? 'Delete File' : 'Discard Changes', () => discardFiles([f])));
    acts.push(act('add', 'Stage Changes', () => stage([f.path])));
  } else if (group === 'staged') {
    acts.push(act('remove', 'Unstage Changes', () => unstage([f.path])));
  } else if (group === 'conflicts') {
    acts.push(act('add', 'Stage Changes (mark resolved)', () => stage([f.path])));
  }
  const row = h('div.list-row.scm-row', { tabindex: '-1', title: `${f.path}${f.from ? ' ← ' + f.from : ''} • ${statusTitle(f.status, group)}` },
    fileIcon(f.path),
    h('span.scm-name' + (f.status === 'D' ? '.strike' : '') + ' ' + letterCls, name),
    h('span.scm-dir', dir),
    h('span.scm-actions', acts),
    h('span.scm-letter.' + letterCls, group === 'conflicts' ? '!' : f.status));
  row.addEventListener('click', () => openChange(f, group));
  row.addEventListener('dblclick', () => openChange(f, group, { preview: false }));
  row.addEventListener('contextmenu', e => {
    e.preventDefault();
    showMenu([
      { label: 'Open Changes', run: () => openChange(f, group, { preview: false }) },
      f.status !== 'D' && { label: 'Open File', run: () => openFile(f.path, { preview: false }) },
      { separator: true },
      group === 'changes' && { label: 'Stage Changes', run: () => stage([f.path]) },
      group === 'staged' && { label: 'Unstage Changes', run: () => unstage([f.path]) },
      group === 'changes' && { label: f.status === 'U' ? 'Delete File' : 'Discard Changes', run: () => discardFiles([f]) },
      { separator: true },
      { label: 'Copy Relative Path', run: () => run('copyRelativeFilePath', f.path) },
      f.status !== 'D' && { label: 'Reveal in Explorer View', run: () => run('workbench.files.action.showActiveFileInExplorer', f.path) },
    ], e.clientX, e.clientY);
  });
  return row;
}

function statusTitle(s, group) {
  if (group === 'conflicts') return 'Conflict';
  return ({ M: 'Modified', A: 'Added', D: 'Deleted', U: 'Untracked', R: 'Renamed', C: 'Copied', T: 'Type Changed' }[s] || s) + (group === 'staged' ? ' (Index)' : '');
}

function group(id, title, files, actions) {
  const collapsed = collapsedGroups.has(id);
  const head = h('div.list-row.scm-group-head',
    icon(collapsed ? 'chevron-right' : 'chevron-down', 'scm-twistie'),
    h('span.scm-group-title', title),
    h('span.scm-actions', actions.map(([ic, t, fn]) => h('button.icon-btn', { type: 'button', title: t, on: { click: e => { e.stopPropagation(); fn(); } } }, icon(ic)))),
    h('span.badge.scm-count', String(files.length)));
  head.addEventListener('click', () => {
    if (collapsedGroups.has(id)) collapsedGroups.delete(id); else collapsedGroups.add(id);
    setPref('scm.collapsed', [...collapsedGroups]);
    drawGroups();
  });
  return h('div.scm-group', head, collapsed ? null : files.map(f => fileRow(f, id)));
}

function drawGroups() {
  if (!groupsEl) return;
  drawButton();
  banner.hidden = !G.operation;
  if (G.operation) {
    banner.replaceChildren(icon('warning'),
      h('span', `A ${G.operation} is in progress. Resolve the conflicts and stage the files, or abort.`),
      h('button.btn.secondary', { type: 'button', on: { click: abortOperation } }, 'Abort'));
  }
  if (!S.meta?.git || !G.git) {
    groupsEl.replaceChildren(h('div.pane-empty', 'The folder currently open doesn\'t have a git repository.'));
    return;
  }
  const out = [];
  if (G.conflicts.length) out.push(group('conflicts', 'Merge Changes', G.conflicts, [['add', 'Stage All Merge Changes', () => stage(G.conflicts.map(f => f.path))]]));
  if (G.staged.length) out.push(group('staged', 'Staged Changes', G.staged, [
    ['remove', 'Unstage All Changes', unstageAll],
  ]));
  out.push(group('changes', 'Changes', G.changes, [
    ['discard', 'Discard All Changes', () => discardFiles(G.changes)],
    ['add', 'Stage All Changes', stageAll],
  ]));
  if (G.truncated) out.push(h('div.pane-empty', 'Too many changes: only the first 5000 are shown.'));
  groupsEl.replaceChildren(...out);
}

/* ---------- commits ---------- */

let commits = [];
let unpushed = new Set();
const openCommits = new Map(); // sha -> files | 'loading'

async function loadCommits(more = false) {
  if (!S.meta?.git || !commitsPane) return;
  try {
    const [log, up] = await Promise.all([
      api('api/git/log', { limit: Math.min(200, more ? commits.length + 50 : Math.max(50, commits.length)) }),
      api('api/unpushed').catch(() => ({ commits: [] })),
    ]);
    commits = log.commits || [];
    unpushed = new Set((up.commits || []).map(c => c.sha || c.full || c.hash));
  } catch { commits = []; }
  drawCommits();
}

function drawCommits() {
  const body = commitsPane.body;
  if (!commits.length) { body.replaceChildren(h('div.pane-empty', S.meta?.git ? 'No commits yet.' : '')); return; }
  const rows = [];
  for (const c of commits) {
    const sha = c.full || c.sha;
    const isOpen = openCommits.has(sha);
    const up = unpushed.has(sha) || unpushed.has(c.hash);
    const row = h('div.list-row.commit-row' + (isOpen ? '.open' : ''), {
      title: `${c.subject}\n\n${c.author}${c.email ? ' <' + c.email + '>' : ''}\n${c.time ? new Date(c.time * 1000).toLocaleString() : c.date}\n${sha}`,
    },
      icon(isOpen ? 'chevron-down' : 'chevron-right', 'scm-twistie'),
      icon(up ? 'cloud-upload' : 'git-commit', 'commit-icon' + (up ? ' unpushed' : '')),
      h('span.commit-subject', c.subject),
      h('span.commit-author', c.author),
      h('span.commit-when', c.time ? relTime(c.time * 1000) : c.date || ''));
    row.addEventListener('click', () => toggleCommit(sha));
    row.addEventListener('contextmenu', e => {
      e.preventDefault();
      showMenu([
        { label: 'Copy Commit ID', run: () => navigator.clipboard?.writeText(sha) },
        { label: 'Copy Commit Message', run: () => navigator.clipboard?.writeText(c.subject) },
      ], e.clientX, e.clientY);
    });
    rows.push(row);
    if (isOpen) {
      const files = openCommits.get(sha);
      if (files === 'loading') rows.push(h('div.pane-empty.commit-file', 'Loading…'));
      else for (const f of files) rows.push(commitFileRow(c, sha, f));
    }
  }
  if (commits.length >= 50 && commits.length < 200) rows.push(h('div.commit-more', { on: { click: () => loadCommits(true) } }, 'Load More Commits...'));
  body.replaceChildren(...rows);
}

function commitFileRow(c, sha, f) {
  const name = basename(f.path);
  const cls = { M: 'git-modified', A: 'git-added', D: 'git-deleted', R: 'git-renamed', C: 'git-renamed' }[f.status] || 'git-modified';
  const row = h('div.list-row.scm-row.commit-file',
    fileIcon(f.path), h('span.scm-name', name), h('span.scm-dir', dirname(f.path)),
    f.binary ? null : h('span.commit-stat', h('span.add', '+' + f.add), ' ', h('span.del', '−' + f.del)),
    h('span.scm-letter.' + cls, f.status));
  const short = (c.short || c.hash || sha.slice(0, 7));
  row.addEventListener('click', () => openDiff({
    path: f.path,
    left: f.status === 'A' ? { empty: true } : { ref: sha + '^', of: f.from || undefined },
    right: f.status === 'D' ? { empty: true } : { ref: sha },
    title: `${name} (${short})`, preview: true,
  }));
  return row;
}

async function toggleCommit(sha) {
  if (openCommits.has(sha)) { openCommits.delete(sha); drawCommits(); return; }
  openCommits.set(sha, 'loading');
  drawCommits();
  try {
    const j = await api('api/commitfiles', { sha });
    openCommits.set(sha, j.files || []);
  } catch (e) {
    openCommits.delete(sha);
    notify(e.message, { severity: 'error' });
  }
  drawCommits();
}

/* ---------- view ---------- */

export function renderScm(container) {
  container.classList.add('panes');
  msgEl = h('textarea.scm-input', { rows: 1, spellcheck: true, 'aria-label': 'Commit message' });
  msgEl.value = pref(draftKey(), '');
  msgEl.addEventListener('input', () => { autosize(); saveDraft(); });
  msgEl.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doCommit(); }
  });
  commitBtn = h('div.scm-commit',
    h('button.btn.primary.scm-commit-main', { type: 'button' }),
    h('button.btn.primary.scm-commit-drop', { type: 'button', title: 'More Actions...', on: { click: e => commitMenu(e.currentTarget) } }, icon('chevron-down')));
  banner = h('div.scm-banner', { hidden: true });
  groupsEl = h('div.scm-groups');
  changesPane = pane({
    title: 'Changes', grow: true,
    actions: () => [],
  });
  changesPane.body.append(h('div.scm-box', msgEl, commitBtn), banner, groupsEl);
  commitsPane = pane({
    title: 'Commits',
    collapsed: pref('scm.commitsCollapsed', false),
    onToggle: open => { setPref('scm.commitsCollapsed', !open); if (open) loadCommits(); },
    actions: () => [{ icon: 'refresh', title: 'Refresh', run: () => loadCommits() }],
  });
  container.append(changesPane.el, commitsPane.el);
  drawGroups();
  loadCommits();
  setTimeout(autosize, 0);
}

const saveDraft = debounce(() => setPref(draftKey(), msgEl.value), 300);

export const focusCommitInput = () => msgEl?.focus();

export function initScm() {
  on('git:changed', () => { drawGroups(); emit('badges:changed'); });
  on('git:busy', () => drawButton());
  on('git:after-op', name => { if (['commit', 'push', 'pull', 'abort'].includes(name)) loadCommits(); });
  on('stream:git', debounce(() => { if (commitsPane?.expanded()) loadCommits(); }, 1500));
}
