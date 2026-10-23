// web/src/pr.js
// Pull request review (px0 <pr-url>, or a PR opened from the workbench): the
// PULL REQUEST view with the PR's description, the files it changes, the
// discussion, your draft review and merging. Review comments are drafted
// from the editor (right-click > Add Review Comment, on the line or selection)
// and sent together with Submit Review, as on GitHub. Existing and draft
// comments show as gutter icons with the comment on hover.
import { api, post, S } from './api.js';
import { h, icon, basename, dirname, on, emit, relTime, debounce } from './util.js';
import { notify, confirm, promptText, pane } from './ui.js';
import { openDiff } from './editors.js';
import { fileIcon } from './icons.js';
import { monaco } from './monaco.js';
import { pathOfUri } from './models.js';
import { inputBox } from './quickinput.js';

const P = { meta: null, existing: { issueComments: [], reviewComments: [] }, drafts: [], merge: null };
let panes = {};

async function loadMeta() {
  try { P.meta = await api('api/pr/meta'); } catch (e) { notify('Could not load the pull request: ' + e.message, { severity: 'error' }); }
}
async function loadComments() {
  try { P.existing = await api('api/pr/existing-comments'); } catch { P.existing = { issueComments: [], reviewComments: [] }; }
}
async function loadDrafts() {
  try { P.drafts = (await api('api/pr/comments')).comments || []; } catch { P.drafts = []; }
}
async function loadMerge() {
  try { P.merge = await api('api/pr/merge-status'); } catch (e) { P.merge = { error: e.message }; }
}

export async function refreshPR() {
  await Promise.all([loadMeta(), loadComments(), loadDrafts(), loadMerge()]);
  drawAll();
  emit('pr:changed');
}

/* ---------- opening a PR file ---------- */

export function openPRFile(path, status, opts = {}) {
  const name = basename(path);
  return openDiff({
    path,
    left: status === 'A' ? { empty: true } : { ref: 'BASE' },
    right: status === 'D' ? { empty: true } : { path },
    title: `${name} (PR #${P.meta?.number || ''})`, preview: true, ...opts,
  });
}

/* ---------- drawing ---------- */

const md = text => h('div.pr-body', text || '');

function drawOverview() {
  const m = P.meta;
  if (!m || !panes.overview) return;
  const state = m.merged ? 'Merged' : (m.state || 'open');
  panes.overview.body.replaceChildren(h('div.pr-overview',
    h('div.pr-title', h('span.pr-state.' + (m.merged ? 'merged' : String(m.state).toLowerCase()), icon(m.merged ? 'git-merge' : 'git-pull-request'), ' ', state), ' ', m.title, ' ', h('span.pr-num', '#' + m.number)),
    h('div.pr-sub', icon('account'), ' ', m.author || '', ' wants to merge ', h('code', m.head || ''), ' into ', h('code', m.base || '')),
    m.diffBaseWarning ? h('div.pr-warn', icon('warning'), ' ', m.diffBaseWarning) : null,
    m.readOnly ? h('div.pr-warn', icon('lock'), ' Read only: no token for this forge, so reviews cannot be submitted. ',
      h('button.btn.secondary', { type: 'button', on: { click: connectForge } }, 'Connect...')) : null,
    h('div.pr-links',
      m.url ? h('a.btn.secondary', { href: m.url, target: '_blank', rel: 'noopener' }, icon('link-external'), ' Open on ' + (S.meta?.forge?.info?.label || 'the forge')) : null)));
}

function drawFiles() {
  if (!panes.files || !P.meta) return;
  const files = Object.entries(P.meta.files || {}).sort((a, b) => a[0].localeCompare(b[0]));
  panes.files.setBadge(files.length);
  const draftsBy = new Map();
  for (const d of P.drafts) draftsBy.set(d.path, (draftsBy.get(d.path) || 0) + 1);
  const commentsBy = new Map();
  for (const c of P.existing.reviewComments || []) commentsBy.set(c.path, (commentsBy.get(c.path) || 0) + 1);
  panes.files.body.replaceChildren(...(files.length ? files.map(([path, st]) => {
    const cls = { M: 'git-modified', A: 'git-added', D: 'git-deleted', R: 'git-renamed' }[st] || 'git-modified';
    const row = h('div.list-row.scm-row', { title: path },
      fileIcon(path), h('span.scm-name', basename(path)), h('span.scm-dir', dirname(path)),
      commentsBy.get(path) ? h('span.pr-count', { title: 'comments' }, icon('comment'), commentsBy.get(path)) : null,
      draftsBy.get(path) ? h('span.pr-count.draft', { title: 'draft comments' }, icon('edit'), draftsBy.get(path)) : null,
      h('span.scm-letter.' + cls, st));
    row.addEventListener('click', () => openPRFile(path, st));
    row.addEventListener('dblclick', () => openPRFile(path, st, { preview: false }));
    return row;
  }) : [h('div.pane-empty', 'This pull request changes no files.')]));
}

function commentCard(c, { reply = false, draft = false } = {}) {
  const card = h('div.pr-comment' + (draft ? '.draft' : ''),
    h('div.pr-comment-head',
      c.avatarUrl ? h('img.pr-avatar', { src: c.avatarUrl, alt: '', referrerpolicy: 'no-referrer' }) : icon(draft ? 'edit' : 'account'),
      h('b', draft ? 'Draft' : c.author || ''),
      c.path ? h('a.pr-loc', { href: '#', on: { click: e => { e.preventDefault(); openPRFile(c.path, P.meta?.files?.[c.path] || 'M', { line: c.line }); } } }, `${basename(c.path)}:${c.line}`) : null,
      h('span.grow'),
      c.createdAt ? h('span.pr-when', relTime(Date.parse(c.createdAt))) : null,
      draft ? h('button.icon-btn', { type: 'button', title: 'Delete draft', on: { click: () => deleteDraft(c) } }, icon('trash')) : null,
      reply ? h('button.icon-btn', { type: 'button', title: 'Reply', on: { click: () => replyTo(c) } }, icon('reply')) : null,
      c.url ? h('a.icon-btn', { href: c.url, target: '_blank', rel: 'noopener', title: 'Open on the forge' }, icon('link-external')) : null),
    md(c.body));
  return card;
}

function drawComments() {
  if (!panes.comments) return;
  const issue = [...(P.existing.issueComments || [])].sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  const review = [...(P.existing.reviewComments || [])].sort((a, b) => (a.path || '').localeCompare(b.path || '') || a.line - b.line);
  panes.comments.setBadge(issue.length + review.length);
  const box = h('textarea.pr-input', { rows: 3, placeholder: 'Leave a comment (Ctrl+Enter to post)' });
  const postIt = async () => {
    const body = box.value.trim();
    if (!body) return;
    try { await post('api/pr/comments/issue', { body }); box.value = ''; await loadComments(); drawComments(); }
    catch (e) { notify(e.message, { severity: 'error' }); }
  };
  box.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); postIt(); } });
  panes.comments.body.replaceChildren(
    ...issue.map(c => commentCard(c)),
    review.length ? h('div.pr-sep', 'On files') : null,
    ...review.map(c => commentCard(c, { reply: !c.inReplyTo })),
    !issue.length && !review.length ? h('div.pane-empty', 'No comments yet.') : null,
    P.meta?.readOnly ? null : h('div.pr-compose', box, h('button.btn.secondary', { type: 'button', on: { click: postIt } }, 'Comment')));
}

function drawReview() {
  if (!panes.review) return;
  panes.review.setBadge(P.drafts.length);
  const body = h('textarea.pr-input', { rows: 3, placeholder: 'Review summary (optional for Comment)' });
  const submit = async event => {
    if (event === 'COMMENT' && !P.drafts.length && !body.value.trim()) { notify('Write a comment or a summary first.'); return; }
    try {
      await post('api/pr/submit', { event, body: body.value });
      notify(event === 'APPROVE' ? 'Approved.' : event === 'REQUEST_CHANGES' ? 'Changes requested.' : 'Review submitted.');
      body.value = '';
      await refreshPR();
    } catch (e) { notify(e.message, { severity: 'error' }); }
  };
  panes.review.body.replaceChildren(
    P.drafts.length ? null : h('div.pane-empty', 'No draft comments. Right-click a line in a PR file and choose Add Review Comment.'),
    ...P.drafts.map(d => commentCard(d, { draft: true })),
    P.meta?.readOnly ? h('div.pane-empty', 'Connect a token to submit reviews.') : h('div.pr-compose', body,
      h('div.pr-buttons',
        h('button.btn.primary', { type: 'button', on: { click: () => submit('COMMENT') } }, 'Submit Review'),
        P.meta?.writeAccess ? h('button.btn.secondary', { type: 'button', on: { click: () => submit('APPROVE') } }, icon('check'), ' Approve') : null,
        P.meta?.writeAccess ? h('button.btn.secondary', { type: 'button', on: { click: () => submit('REQUEST_CHANGES') } }, 'Request Changes') : null)));
}

function drawMerge() {
  if (!panes.merge) return;
  const m = P.merge;
  if (!m) { panes.merge.body.replaceChildren(h('div.pane-empty', 'Loading…')); return; }
  if (m.error) { panes.merge.body.replaceChildren(h('div.pane-empty', m.error)); return; }
  if (P.meta?.merged) { panes.merge.body.replaceChildren(h('div.pane-empty', 'This pull request has been merged.')); return; }
  const st = m.status || {};
  const methods = st.methods?.length ? st.methods : ['merge', 'squash', 'rebase'];
  const sel = h('select.setting-select', methods.map(x => h('option', { value: x }, { merge: 'Create a merge commit', squash: 'Squash and merge', rebase: 'Rebase and merge' }[x] || x)));
  const title = h('input.setting-input', { type: 'text' });
  const msg = h('textarea.pr-input', { rows: 3 });
  const fill = () => { const d = m.defaults?.[sel.value] || {}; title.value = d.title || ''; msg.value = d.message || ''; title.disabled = msg.disabled = sel.value === 'rebase'; };
  sel.addEventListener('change', fill);
  fill();
  const blocked = !m.canMerge || m.stale || m.inProgress || m.unpushed > 0 || m.rewritten;
  const why = m.stale ? 'The PR has new commits on the forge: pull them first.'
    : m.inProgress ? 'A rebase or merge is in progress in this checkout.'
    : m.unpushed > 0 ? `${m.unpushed} local commit(s) are not pushed to the PR yet.`
    : m.rewritten ? 'The branch was rewritten locally: force-push it first.'
    : !m.canMerge ? (st.reason || `Not mergeable (${st.state || 'unknown'}).`) : '';
  panes.merge.body.replaceChildren(h('div.pr-merge',
    h('div.pr-merge-state', icon(blocked ? 'circle-slash' : 'check'), ' ', blocked ? why : 'This branch can be merged.'),
    sel, title, msg,
    h('button.btn.primary', { type: 'button', disabled: blocked, on: { click: async () => {
      if (await confirm({ message: `Merge pull request #${P.meta.number} into ${m.base || 'the base branch'}?`, buttons: ['Merge'], severity: 'info' }) !== 0) return;
      try { await post('api/pr/merge', { method: sel.value, title: title.value, message: msg.value }); notify('Pull request merged.'); await refreshPR(); }
      catch (e) { notify(e.message, { severity: 'error' }); }
    } } }, icon('git-merge'), ' Merge Pull Request')));
}

function drawAll() {
  drawOverview(); drawFiles(); drawComments(); drawReview(); drawMerge();
  for (const ed of monaco.editor.getEditors()) decorate(ed);
}

/* ---------- actions ---------- */

async function deleteDraft(d) {
  try { await post('api/pr/comments/delete', {}, { params: { id: d.id } }); await loadDrafts(); drawAll(); }
  catch (e) { notify(e.message, { severity: 'error' }); }
}

async function replyTo(c) {
  const body = await promptText({ title: `Reply to ${c.author}`, detail: c.body.slice(0, 200), placeholder: 'Your reply', ok: 'Reply' });
  if (!body?.trim()) return;
  try { await post('api/pr/comments/review-reply', { commentId: c.id, body }); await loadComments(); drawAll(); }
  catch (e) { notify(e.message, { severity: 'error' }); }
}

export async function addReviewComment(editor) {
  const model = editor.getModel();
  const path = model && pathOfUri(model.uri);
  if (!path || !P.meta) return;
  if (!P.meta.files?.[path]) { notify('Review comments can only be left on files this pull request changes.'); return; }
  const sel = editor.getSelection();
  const line = sel.endLineNumber;
  const quoted = sel.isEmpty() ? '' : model.getValueInRange(sel);
  const body = await promptText({ title: `Comment on ${basename(path)}:${line}`, detail: quoted ? quoted.slice(0, 300) : '', placeholder: 'Leave a review comment (Ctrl+Enter to add it to your review)', ok: 'Add Comment' });
  if (!body?.trim()) return;
  try {
    await post('api/pr/comments', { path, line, side: 'RIGHT', body });
    await loadDrafts();
    drawAll();
    notify('Draft comment added. Submit it from the Pull Request view.', { timeout: 2500 });
  } catch (e) { notify(e.message, { severity: 'error' }); }
}

export async function connectForge() {
  const f = S.meta?.forge || {};
  const setup = f.setup || {};
  if (setup.url) window.open(setup.url, '_blank', 'noopener');
  const token = await inputBox({ prompt: `Paste a ${f.info?.label || 'forge'} token${setup.steps?.length ? ' (' + setup.steps.join('; ') + ')' : ''}`, placeholder: 'token' });
  if (!token) return;
  let extra = '';
  if (setup.extra) extra = (await inputBox({ prompt: setup.extra.label || setup.extra.key, placeholder: setup.extra.placeholder || '' })) || '';
  try {
    const r = await post('api/forge/connect', { token, extra });
    notify(r.validated ? 'Connected.' : 'Token saved.');
    if (S.meta?.forge) S.meta.forge.hasToken = true;
    if (S.meta?.pr) await refreshPR();
  } catch (e) { notify(e.message, { severity: 'error' }); }
}

/* ---------- editor decorations ---------- */

const collections = new WeakMap();

function decorate(ed) {
  const model = ed.getModel();
  const path = model && pathOfUri(model.uri);
  let coll = collections.get(ed);
  if (!coll) { coll = ed.createDecorationsCollection(); collections.set(ed, coll); }
  if (!path || !P.meta) { coll.clear(); return; }
  const byLine = new Map();
  for (const c of P.existing.reviewComments || []) if (c.path === path && c.line) (byLine.get(c.line) || byLine.set(c.line, []).get(c.line)).push({ ...c, draft: false });
  for (const d of P.drafts) if (d.path === path && d.line) (byLine.get(d.line) || byLine.set(d.line, []).get(d.line)).push({ ...d, draft: true, author: 'Draft' });
  const max = model.getLineCount();
  coll.set([...byLine].filter(([l]) => l <= max).map(([line, cs]) => ({
    range: new monaco.Range(line, 1, line, 1),
    options: {
      isWholeLine: true,
      glyphMarginClassName: 'pr-glyph codicon codicon-' + (cs.some(c => c.draft) ? 'comment-draft' : 'comment'),
      glyphMarginHoverMessage: cs.map(c => ({ value: `**${c.author}**${c.draft ? ' (draft)' : ''}\n\n${c.body}` })),
      className: 'pr-line',
    },
  })));
}

/* ---------- view ---------- */

export function renderPR(container) {
  container.classList.add('panes');
  panes.overview = pane({ title: 'Overview' });
  panes.files = pane({ title: 'Files Changed', grow: true });
  panes.comments = pane({ title: 'Comments', collapsed: false });
  panes.review = pane({ title: 'Your Review' });
  panes.merge = pane({ title: 'Merge', collapsed: true, onToggle: open => { if (open) loadMerge().then(drawMerge); } });
  container.append(panes.overview.el, panes.files.el, panes.comments.el, panes.review.el, panes.merge.el);
  drawAll();
}

export const prActions = () => [
  { icon: 'refresh', title: 'Refresh', run: refreshPR },
  P.meta?.url ? { icon: 'link-external', title: 'Open on the Forge', run: () => window.open(P.meta.url, '_blank', 'noopener') } : null,
].filter(Boolean);

export function initPR() {
  refreshPR();
  on('editor:created', ed => {
    ed.updateOptions({ glyphMargin: true });
    ed.addAction({
      id: 'px0.pr.addComment', label: 'Add Review Comment', contextMenuGroupId: 'navigation', contextMenuOrder: 0,
      run: () => addReviewComment(ed),
    });
    ed.onDidChangeModel(() => decorate(ed));
    decorate(ed);
  });
  on('stream:git', debounce(async () => { await loadMeta(); drawFiles(); }, 2000));
}

export const prFiles = () => P.meta?.files || {};
