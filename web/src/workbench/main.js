// web/src/workbench/main.js
// The workbench page (web/workbench.html), what a bare `px0` opens, laid out
// like VS Code's Welcome page: Start (open a folder or a pull request, with
// folder completion), Recent, every Repository found on the machine with its
// branch and pending changes, and a folder browser. Each workspace opens as
// its own px0 under /w/<id>/ (workbench.go): a click opens it here,
// Ctrl/Cmd-click or the ↗ button in a new tab.
import '../../../node_modules/@vscode/codicons/dist/codicon.css';
import '../css/workbench.css';
import { h, icon, esc, debounce, relTime, formatBytes, isMac } from '../util.js';
import { listThemes, currentTheme, setTheme, initialTheme } from '../theme.js';
import { quickPick } from '../quickinput.js';

const req = async (path, body) => {
  const opts = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const r = await fetch(new URL(path, document.baseURI), opts);
  const j = await r.json().catch(() => ({ error: r.statusText }));
  if (j.error) throw new Error(j.error);
  return j;
};

let state = { items: [], cwd: '', home: '', sep: '/', roots: [] };
let browsePath = '';
let pendingPR = '';
let lastSig = '';
const E = {};

const tildify = p => (state.home && (p === state.home || p.startsWith(state.home + state.sep)) ? '~' + p.slice(state.home.length) : p);
const looksLikeURL = v => /^[a-z]+:\/\//i.test(v.trim());
const newTab = () => window.open('about:blank', '_blank');
const msg = text => { E.msg.textContent = text || ''; E.msg.hidden = !text; };

/* ---------- theme ---------- */

setTheme(initialTheme(currentTheme()), false);

function pickTheme() {
  const before = currentTheme();
  quickPick({
    placeholder: 'Select Color Theme (Up/Down Keys to Preview)',
    items: listThemes().map(t => ({ label: t.name, description: t.scheme, id: t.id, picked: t.id === before })),
    onActive: it => setTheme(it.id, false),
    onAccept: it => setTheme(it.id, true, id => req('api/settings', { 'workbench.colorTheme': id }).catch(() => {})),
    onCancel: () => setTheme(before, false),
  });
}

/* ---------- opening ---------- */

async function open(target, clone, tab = null) {
  msg('');
  try {
    const r = await req('api/wb/open', clone ? { target, clone } : { target });
    if (r.needClone) { tab?.close(); askForClone(target, r.repo, r.managed); return; }
    const href = new URL(r.href, document.baseURI).href;
    if (tab) tab.location.href = href; else location.href = href;
  } catch (e) {
    tab?.close();
    msg(e.message);
  }
}

const useFolder = (path, inNewTab = false) => (pendingPR ? open(pendingPR, path) : open(path, undefined, inNewTab ? newTab() : null));

function askForClone(prURL, repo, managed) {
  pendingPR = prURL;
  E.cloneRepo.textContent = repo;
  E.cloneDest.textContent = `into ${managed}, once; later pull requests reuse it`;
  E.clone.hidden = false;
  E.openHere.textContent = 'Use as Clone';
  E.clonePath.value = '';
  E.clonePath.focus();
}

function cancelClone() {
  pendingPR = '';
  E.clone.hidden = true;
  E.openHere.textContent = 'Open This Folder';
}

/* ---------- folder completion ---------- */

function attachComplete(input, list, onFolder) {
  let items = [], sel = -1, seq = 0;
  const close = () => { list.hidden = true; items = []; sel = -1; };
  const render = () => {
    const prefix = (input.value.match(/[^/\\]*$/) || [''])[0];
    list.replaceChildren(...items.map((e, i) => h('li' + (i === sel ? '.selected' : ''), { dataset: { i } },
      icon('folder'), h('span.sg-name', { html: `<b>${esc(e.name.slice(0, prefix.length))}</b>${esc(e.name.slice(prefix.length))}` }),
      e.git ? h('span.wb-git', 'git') : null, h('span.sg-path', e.path))));
    list.hidden = !items.length;
    list.children[sel]?.scrollIntoView({ block: 'nearest' });
  };
  const fetchNow = async () => {
    const q = input.value;
    if (!q.trim() || looksLikeURL(q)) { close(); return; }
    const my = ++seq;
    let r;
    try { r = await req('api/wb/complete?' + new URLSearchParams({ q })); } catch { return; }
    if (my !== seq || document.activeElement !== input) return;
    items = r.entries || [];
    sel = -1;
    render();
  };
  const refresh = debounce(fetchNow, 60);
  const accept = i => { const e = items[i]; if (!e) return; input.value = e.path; onFolder?.(e.path); input.focus(); fetchNow(); };
  input.addEventListener('input', refresh);
  input.addEventListener('focus', () => { if (input.value) refresh(); });
  input.addEventListener('blur', () => setTimeout(close, 150));
  input.addEventListener('keydown', e => {
    if (list.hidden || !items.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + items.length + 1) % (items.length + 1);
      if (sel === items.length) sel = -1;
      render();
    } else if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); accept(sel >= 0 ? sel : 0); }
    else if (e.key === 'Enter' && sel >= 0) { input.value = items[sel].path; close(); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  list.addEventListener('mousedown', e => {
    const li = e.target.closest('li[data-i]');
    if (!li) return;
    e.preventDefault();
    accept(Number(li.dataset.i));
  });
}

/* ---------- recent ---------- */

function recentRow(it) {
  const pr = it.kind === 'pr';
  const title = pr ? (it.title || `#${it.number}`) : (it.title || it.path).split('/').pop() || it.path;
  const sub = it.state === 'starting' && it.progress ? it.progress : pr ? `${it.repo}#${it.number}` : tildify(it.path);
  const st = it.state === 'stopped' && !it.error ? null : h('span.wb-state.' + it.state, { title: it.error || it.state }, it.state === 'stopped' ? 'exited' : it.state);
  const act = (a, ic, title, on) => h('button.icon-btn' + (on ? '.on' : ''), { type: 'button', dataset: { act: a }, title }, icon(ic));
  return h('li', h('a.wb-row', { href: it.href, dataset: { id: it.id } },
    icon(pr ? 'git-pull-request' : 'repo', 'wb-ico' + (pr ? ' pr' : '')),
    h('span.wb-text', h('span.wb-title', title), h('span.wb-sub', sub)),
    st,
    h('span.wb-when', relTime(it.lastOpened)),
    h('span.wb-acts',
      act('pin', it.pinned ? 'pinned' : 'pin', it.pinned ? 'Unpin' : 'Pin to top', it.pinned),
      it.state === 'running' ? act('stop', 'debug-stop', 'Stop this workspace') : null,
      act('remove', 'close', 'Remove from the list'))));
}

function renderRecent() {
  const pinned = state.items.filter(i => i.pinned);
  const rest = state.items.filter(i => !i.pinned);
  E.recent.replaceChildren(...pinned.map(recentRow), ...(pinned.length && rest.length ? [h('li.wb-sep')] : []), ...rest.map(recentRow));
  E.recentEmpty.hidden = state.items.length > 0;
  const n = state.items.filter(i => i.state === 'running').length;
  E.running.textContent = n ? `${n} running` : '';
}

async function refresh() {
  try { state = await req('api/wb/state'); } catch (e) { msg(e.message); return; }
  const sig = JSON.stringify(state.items);
  if (sig !== lastSig) { lastSig = sig; renderRecent(); renderRepos(); }
  E.ver.textContent = state.version ? 'v' + state.version : '';
  E.cwd.hidden = !state.cwd;
  E.cwd.replaceChildren(icon('folder-opened'), ' Open ', h('code', tildify(state.cwd)));
  if (!browsePath) browse(state.cwd);
}

/* ---------- repositories ---------- */

let repos = [];
let reposLoaded = false;
let repoSel = 0;
const repoStatus = new Map();
const repoWanted = [];
let repoInFlight = 0;

async function loadRepos(rescan = false) {
  if (rescan) E.reposNote.textContent = 'Looking for repositories…';
  let r;
  try { r = await req('api/wb/repos' + (rescan ? '?refresh=1' : '')); } catch (e) { E.reposNote.textContent = e.message; return; }
  repos = r.repos || [];
  reposLoaded = true;
  if (rescan) repoStatus.clear();
  const where = (r.roots || []).map(tildify).join(', ');
  E.reposNote.textContent = (where ? 'Looked in ' + where : '') + (r.truncated ? ' — stopped early; start px0 with -roots to look in fewer places' : '');
  renderRepos();
}

function filteredRepos() {
  const words = E.repoQ.value.toLowerCase().split(/\s+/).filter(Boolean);
  return words.length ? repos.filter(r => words.every(w => (r.name + ' ' + tildify(r.path)).toLowerCase().includes(w))) : repos;
}

function changes(st) {
  if (!st) return [];
  if (st.error) return [h('span.err', { title: st.error }, st.error)];
  const out = [];
  if (st.conflicts) out.push(h('span.cf', { title: `${st.conflicts} with conflicts` }, '⚠' + st.conflicts));
  if (st.staged) out.push(h('span.st', { title: `${st.staged} staged` }, '✚' + st.staged));
  if (st.changed) out.push(h('span.ch', { title: `${st.changed} changed` }, '●' + st.changed));
  if (st.untracked) out.push(h('span.ut', { title: `${st.untracked} untracked` }, '?' + st.untracked));
  if (st.ahead) out.push(h('span.ab', { title: `${st.ahead} to push` }, '↑' + st.ahead));
  if (st.behind) out.push(h('span.ab', { title: `${st.behind} to pull` }, '↓' + st.behind));
  return out.length ? out : [h('span.clean', 'clean')];
}

let observer = null;

function renderRepos() {
  if (!E.repoList) return;
  const list = filteredRepos();
  repoSel = Math.max(0, Math.min(repoSel, list.length - 1));
  E.repoList.replaceChildren(...(list.length ? list.map((r, i) => {
    const it = state.items.find(x => x.id === r.id);
    const st = repoStatus.get(r.path);
    return h('li', h('div.wb-row', { role: 'option', dataset: { path: r.path, i }, 'aria-selected': String(i === repoSel) },
      icon('repo', 'wb-ico'),
      h('span.wb-text', h('span.wb-title', r.name), h('span.wb-sub', tildify(r.path))),
      h('span.wb-branch', st?.branch ? [icon('git-branch'), ' ', st.branch] : ''),
      h('span.wb-changes', changes(st)),
      it && (it.state === 'running' || it.state === 'starting') ? h('span.wb-state.' + it.state, it.state) : null,
      h('span.wb-acts.always',
        h('button.btn.secondary.small', { type: 'button', dataset: { act: 'open' }, title: `Open ${r.name} here` }, 'Open'),
        h('button.icon-btn', { type: 'button', dataset: { act: 'tab' }, title: `Open ${r.name} in a new tab` }, icon('link-external')))));
  }) : [h('li.wb-empty', repos.length ? 'No repository matches.' : reposLoaded ? 'No git repositories found.' : 'Looking for repositories…')]));
  E.reposCount.textContent = repos.length ? (list.length === repos.length ? String(repos.length) : `${list.length} / ${repos.length}`) : '';
  observer?.disconnect();
  observer = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      observer.unobserve(e.target);
      const p = e.target.dataset.path;
      if (!repoStatus.has(p) && !repoWanted.includes(p)) repoWanted.push(p);
    }
    pump();
  }, { root: E.repoList });
  for (const row of E.repoList.querySelectorAll('.wb-row[data-path]')) if (!repoStatus.has(row.dataset.path)) observer.observe(row);
}

function pump() {
  while (repoInFlight < 4 && repoWanted.length) {
    const p = repoWanted.shift();
    repoInFlight++;
    req('api/wb/repostatus?' + new URLSearchParams({ path: p }))
      .then(st => repoStatus.set(p, st), e => repoStatus.set(p, { error: e.message }))
      .finally(() => {
        repoInFlight--;
        const row = E.repoList.querySelector(`.wb-row[data-path="${CSS.escape(p)}"]`);
        if (row) {
          const st = repoStatus.get(p);
          row.querySelector('.wb-branch').replaceChildren(...(st?.branch ? [icon('git-branch'), ' ', st.branch] : []));
          row.querySelector('.wb-changes').replaceChildren(...changes(st));
        }
        pump();
      });
  }
}

function moveRepoSel(d) {
  const rows = E.repoList.querySelectorAll('.wb-row[data-i]');
  if (!rows.length) return;
  rows[repoSel]?.setAttribute('aria-selected', 'false');
  repoSel = (repoSel + d + rows.length) % rows.length;
  rows[repoSel].setAttribute('aria-selected', 'true');
  rows[repoSel].scrollIntoView({ block: 'nearest' });
}

/* ---------- browse ---------- */

async function browse(path) {
  const params = new URLSearchParams({ path });
  if (E.hidden.checked) params.set('hidden', '1');
  let r;
  try { r = await req('api/wb/browse?' + params); } catch (e) { msg(e.message); return; }
  browsePath = r.path;
  E.path.replaceChildren(h('bdi', tildify(r.path)));
  E.path.title = r.path;
  E.up.disabled = !r.parent;
  E.up.dataset.path = r.parent || '';
  E.dirs.replaceChildren(...(r.entries.length ? r.entries.map(e => h('li', h('div.wb-row', { tabindex: '0', dataset: { path: e.path } },
    icon('folder', 'wb-ico'), h('span.wb-text', h('span.wb-title', e.name)),
    e.git ? h('span.wb-git', 'git') : null,
    h('span.wb-acts', h('button.btn.secondary.small', { type: 'button', dataset: { act: 'open' }, title: `Open ${e.name}` }, pendingPR ? 'Use' : 'Open'))))) : [h('li.wb-empty', 'No folders here.')]));
}

/* ---------- metrics ---------- */

async function refreshMetrics() {
  try {
    const m = await req('api/metrics');
    E.metrics.textContent = `${Number(m.cpuUsage || 0).toFixed(1)}% · ${formatBytes(m.rssBytes || 0)}${m.lspMemBytes ? ' · LSP ' + formatBytes(m.lspMemBytes) : ''}`;
    E.metrics.title = (m.parts || []).map(p => `${p.name}: ${formatBytes(p.rssBytes || 0)}, ${Number(p.cpuUsage || 0).toFixed(1)}% CPU`).join('\n');
  } catch {}
}

/* ---------- page ---------- */

function build() {
  const section = (title, ...body) => h('section.wb-section', h('h2', title), ...body);
  E.target = h('input.wb-input', { type: 'text', spellcheck: false, autocapitalize: 'off', placeholder: '~/path/to/folder or https://github.com/owner/repo/pull/123', 'aria-label': 'Folder path or pull request URL' });
  E.suggest = h('ul.wb-suggest', { hidden: true });
  E.msg = h('p.wb-msg', { hidden: true });
  E.cwd = h('button.wb-link', { type: 'button', hidden: true });
  E.cloneRepo = h('b');
  E.cloneDest = h('span.wb-faint.wb-clone-dest');
  E.clonePath = h('input.wb-input', { type: 'text', spellcheck: false, placeholder: '~/path/to/your/clone' });
  E.cloneSuggest = h('ul.wb-suggest', { hidden: true });
  E.clone = h('section.wb-clone', { hidden: true },
    h('p', 'No local clone of ', E.cloneRepo, ' found.'),
    h('p.wb-faint', 'Pull requests open as git worktrees of a clone of their repository, so nothing is cloned twice. Point px0 at your clone, or let it make one.'),
    h('form.wb-open', { autocomplete: 'off', on: { submit: e => { e.preventDefault(); const p = E.clonePath.value.trim(); if (p && pendingPR) open(pendingPR, p); } } },
      h('div.wb-field', E.clonePath, E.cloneSuggest), h('button.btn.primary', { type: 'submit' }, 'Use This Clone')),
    h('p.wb-clone-actions',
      h('button.btn.secondary', { type: 'button', on: { click: () => pendingPR && open(pendingPR, 'managed') } }, 'Let px0 Clone It'), E.cloneDest,
      h('button.btn.secondary', { type: 'button', on: { click: cancelClone } }, 'Cancel')));
  E.recent = h('ul.wb-list');
  E.recentEmpty = h('p.wb-empty', { hidden: true }, 'Nothing opened yet. Paste a pull request URL above, or pick a folder.');
  E.repoQ = h('input.wb-input.small', { type: 'text', spellcheck: false, placeholder: 'Filter repositories by name or path' });
  E.repoList = h('ul.wb-list.wb-repo-list', { role: 'listbox' });
  E.reposCount = h('span.wb-count');
  E.reposNote = h('p.wb-note');
  E.hidden = h('input', { type: 'checkbox' });
  E.up = h('button.icon-btn', { type: 'button', title: 'Parent folder' }, icon('arrow-up'));
  E.path = h('span.wb-path');
  E.openHere = h('button.btn.secondary.small', { type: 'button' }, 'Open This Folder');
  E.dirs = h('ul.wb-list.wb-dirs');
  E.ver = h('span.status-item');
  E.running = h('span.status-item');
  E.metrics = h('span.status-item');

  const app = document.getElementById('app');
  app.classList.add('workbench');
  app.append(
    h('header.titlebar',
      h('div.title-left', h('span.app-icon', { title: 'px0 workbench' }, h('span.app-icon-mark', '0'))),
      h('div.title-center', h('button.command-center', { type: 'button', title: 'Open a folder or pull request (/)', on: { click: () => E.target.focus() } }, h('span.command-center-label', 'Open a folder or pull request'))),
      h('div.title-right', h('div.layout-controls', h('button.icon-btn', { type: 'button', title: 'Color Theme', on: { click: pickTheme } }, icon('color-mode'))))),
    h('div.workbench-main', h('div.editor-area.part.wb-editor', h('div.editor-group.active',
    h('div.tabs-bar', h('div.tabs', h('div.tab.active', h('span.tab-edge'), h('span.tab-label', icon('home', 'tab-icon'), h('span.tab-name', 'Welcome'))))),
    h('div.wb-scroll', h('main.wb-main',
      h('div.wb-hero', h('h1', 'px', h('span.wb-accent', '[0]')), h('p.wb-faint', 'Editing evolved: open a folder, a repository or a pull request.')),
      h('div.wb-grid',
        h('div.wb-col',
          section('Start',
            h('form.wb-open', { autocomplete: 'off', on: { submit: e => { e.preventDefault(); const t = E.target.value.trim(); if (t) { cancelClone(); open(t); } } } },
              h('div.wb-field', E.target, E.suggest), h('button.btn.primary', { type: 'submit' }, 'Open')),
            h('p.wb-keys', h('kbd', '/'), ' focus · ', h('kbd', 'Tab'), ' complete folder · ', h('kbd', 'Enter'), ' open · ', h('kbd', isMac ? '⌘' : 'Ctrl'), '+click opens in a new tab'),
            E.msg, E.clone, E.cwd),
          section(h('span', 'Recent'), E.recent, E.recentEmpty),
          section(h('span', 'Browse ', h('label.wb-check', E.hidden, ' hidden')),
            h('div.wb-crumbs', E.up, E.path, E.openHere), E.dirs)),
        h('div.wb-col',
          section(h('span', 'Repositories ', E.reposCount, h('button.wb-link.right', { type: 'button', on: { click: () => loadRepos(true) } }, icon('refresh'), ' Rescan')),
            E.repoQ, E.repoList, E.reposNote)))))))),
    h('footer.statusbar', h('div.status-left', h('span.status-item.status-remote', icon('remote'), h('span.status-label', 'px0')), E.ver, E.running), h('div.status-right', E.metrics)));

  attachComplete(E.target, E.suggest, p => browse(p));
  attachComplete(E.clonePath, E.cloneSuggest, p => browse(p));
  E.cwd.addEventListener('click', e => useFolder(state.cwd, e.ctrlKey || e.metaKey));
  E.openHere.addEventListener('click', e => browsePath && useFolder(browsePath, e.ctrlKey || e.metaKey));
  E.up.addEventListener('click', () => { if (E.up.dataset.path) browse(E.up.dataset.path); });
  E.hidden.addEventListener('change', () => browse(browsePath));
  E.recent.addEventListener('click', async e => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    e.preventDefault();
    const id = btn.closest('.wb-row').dataset.id;
    const it = state.items.find(i => i.id === id);
    try {
      if (btn.dataset.act === 'pin') await req('api/wb/pin', { id, pinned: !it?.pinned });
      else if (btn.dataset.act === 'stop') await req('api/wb/stop', { id });
      else if (btn.dataset.act === 'remove') await req('api/wb/remove', { id });
    } catch (err) { msg(err.message); }
    refresh();
  });
  E.repoQ.addEventListener('input', () => { repoSel = 0; renderRepos(); });
  E.repoQ.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); moveRepoSel(e.key === 'ArrowDown' ? 1 : -1); }
    else if (e.key === 'Enter') { e.preventDefault(); const row = E.repoList.querySelectorAll('.wb-row[data-i]')[repoSel]; if (row) useFolder(row.dataset.path, e.metaKey || e.ctrlKey); }
    else if (e.key === 'Escape' && E.repoQ.value) { e.preventDefault(); E.repoQ.value = ''; renderRepos(); }
  });
  E.repoList.addEventListener('click', e => {
    const row = e.target.closest('.wb-row[data-path]');
    if (!row) return;
    const act = e.target.closest('button[data-act]')?.dataset.act;
    useFolder(row.dataset.path, act === 'tab' || (act !== 'open' && (e.metaKey || e.ctrlKey)));
  });
  E.repoList.addEventListener('auxclick', e => { const row = e.target.closest('.wb-row[data-path]'); if (row && e.button === 1) { e.preventDefault(); useFolder(row.dataset.path, true); } });
  E.dirs.addEventListener('click', e => {
    const row = e.target.closest('.wb-row');
    if (!row) return;
    if (e.target.closest('button[data-act]')) useFolder(row.dataset.path, e.metaKey || e.ctrlKey);
    else browse(row.dataset.path);
  });
  E.dirs.addEventListener('keydown', e => {
    const row = e.target.closest('.wb-row');
    if (row && e.key === 'Enter' && e.target === row) { if (e.metaKey || e.ctrlKey) useFolder(row.dataset.path); else browse(row.dataset.path); }
  });
  document.addEventListener('keydown', e => {
    if (e.key === '/' && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) { e.preventDefault(); E.target.focus(); }
  });
}

build();
const tick = () => { if (!document.hidden) { refresh(); refreshMetrics(); } };
setInterval(tick, 2000);
document.addEventListener('visibilitychange', tick);
tick();
loadRepos();

// ?open=<url> comes from a workspace's holding page when a PR has no known clone.
const openParam = new URLSearchParams(location.search).get('open');
if (openParam) {
  history.replaceState(null, '', location.pathname);
  E.target.value = openParam;
  open(openParam);
}
