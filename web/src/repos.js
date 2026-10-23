// web/src/repos.js
// Moving between repositories. A workspace the workbench opened
// (S.meta.workbench, workbench.go) asks it for what was opened before and for
// every repository found on the machine, and opens any of them in this tab or
// a new one. Used by the REPOSITORIES view, the status bar's remote indicator,
// the Switch Repository picker and the explorer's "Open Repository".
import { S, wb, wbURL, inWorkbench } from './api.js';
import { h, icon, debounce } from './util.js';
import { notify, showMenu } from './ui.js';
import { quickPick } from './quickinput.js';

export function currentWorkspaceID() {
  const m = /\/w\/([^/]+)\/$/.exec(S.meta?.basePath || '');
  return m ? m[1] : '';
}

const tildify = (p, home) => (home && (p === home || p.startsWith(home + '/')) ? '~' + p.slice(home.length) : p);

/* openInWorkbench({ target } | { id }, newTab). A new tab is opened at once,
   inside the user's gesture, so popup blockers leave it alone. */
export async function openInWorkbench(what, newTab = false) {
  const tab = newTab ? window.open('about:blank', '_blank') : null;
  const go = href => { if (tab) tab.location.href = href; else location.href = href; };
  try {
    const r = await wb('api/wb/open', what);
    if (r.needClone) { go(wbURL('?open=' + encodeURIComponent(what.target || ''))); return; }
    go(new URL(r.href, location.origin).href);
  } catch (e) {
    tab?.close();
    notify(e.message || 'Could not open the repository', { severity: 'error' });
  }
}

/* Everything the switcher lists: recent workspaces first, then the other
   repositories found on the machine. */
export async function listRepositories({ rescan = false } = {}) {
  if (!inWorkbench()) return { items: [], home: '' };
  const [st, rp] = await Promise.allSettled([wb('api/wb/state'), wb('api/wb/repos' + (rescan ? '?refresh=1' : ''))]);
  const state = st.status === 'fulfilled' ? st.value : { items: [] };
  const repos = rp.status === 'fulfilled' ? rp.value.repos || [] : [];
  const home = state.home || '';
  const here = currentWorkspaceID();
  const seen = new Set();
  const items = [];
  for (const it of state.items || []) {
    seen.add(it.id);
    const pr = it.kind === 'pr';
    items.push({
      id: it.id, kind: it.kind, recent: true, pinned: it.pinned, state: it.state, current: it.id === here,
      name: pr ? `${it.repo}#${it.number}` : (it.path.split('/').pop() || it.path),
      title: pr ? it.title || '' : '', path: it.path || '', sub: pr ? it.title || 'pull request' : tildify(it.path, home),
      lastOpened: it.lastOpened, open: { id: it.id },
    });
  }
  for (const r of repos) {
    if (seen.has(r.id)) continue;
    items.push({ id: r.id, kind: 'dir', name: r.name, path: r.path, sub: tildify(r.path, home), open: { target: r.path } });
  }
  return { items, home, roots: rp.status === 'fulfilled' ? rp.value.roots || [] : [] };
}

export async function pickRepository() {
  if (!inWorkbench()) {
    notify('Switching repositories needs the workbench: start px0 without a folder argument, then open this folder from it.');
    return;
  }
  const { items } = await listRepositories();
  const rows = [];
  const recent = items.filter(i => i.recent);
  const others = items.filter(i => !i.recent);
  if (recent.length) rows.push({ separator: true, label: 'recently opened' }, ...recent.map(asPick));
  if (others.length) rows.push({ separator: true, label: 'repositories' }, ...others.map(asPick));
  quickPick({
    placeholder: 'Switch to a repository (Ctrl/Cmd+Enter opens it in a new tab), or type a path',
    items: rows,
    acceptEmpty: q => { if (q.trim()) openInWorkbench({ target: q.trim() }); },
    onAccept: (it, { newTab }) => { if (!it.current || newTab) openInWorkbench(it.open, newTab); },
  });
}

function asPick(it) {
  return {
    label: it.name, description: it.sub, icon: it.kind === 'pr' ? 'git-pull-request' : 'repo', open: it.open, current: it.current,
    badge: it.current ? 'current' : it.state === 'running' ? 'running' : '',
  };
}

/* ---------- the REPOSITORIES view ---------- */

const status = new Map(); // path -> wbRepoStatus | { error }

export function renderRepos(container) {
  container.classList.add('repos-view');
  if (!inWorkbench()) {
    container.append(h('div.pane-empty', 'Open this folder from the px0 workbench (run px0 without a folder) to browse and switch between every repository on the machine.'));
    return;
  }
  const filter = h('input.view-filter', { type: 'text', placeholder: 'Filter repositories', spellcheck: false });
  const list = h('div.repo-list');
  container.append(h('div.view-filter-box', filter), list);
  let data = { items: [] };
  const draw = () => {
    const words = filter.value.toLowerCase().split(/\s+/).filter(Boolean);
    const shown = data.items.filter(it => words.every(w => (it.name + ' ' + it.sub).toLowerCase().includes(w)));
    const sec = (title, arr) => arr.length ? [h('div.repo-sep', title), ...arr.map(row)] : [];
    list.replaceChildren(
      ...sec('Recently Opened', shown.filter(i => i.recent)),
      ...sec('Repositories', shown.filter(i => !i.recent)));
    if (!shown.length) list.append(h('div.pane-empty', data.items.length ? 'No repository matches.' : 'Looking for repositories…'));
    io.disconnect();
    for (const el of list.querySelectorAll('.repo-row[data-path]')) if (!status.has(el.dataset.path)) io.observe(el);
  };
  const row = it => {
    const st = status.get(it.path);
    const el = h('div.repo-row' + (it.current ? '.current' : ''), { dataset: { path: it.kind === 'dir' ? it.path : '' }, title: it.path || it.sub },
      icon(it.kind === 'pr' ? 'git-pull-request' : 'repo', 'repo-icon'),
      h('div.repo-text', h('div.repo-name', it.name, it.current ? h('span.repo-current', 'current') : null), h('div.repo-sub', it.sub)),
      h('div.repo-meta',
        h('span.repo-branch', st?.branch ? [icon('git-branch'), st.branch] : ''),
        h('span.repo-changes', changes(st)),
        it.state === 'running' || it.state === 'starting' ? h('span.repo-state.' + it.state, '●') : null));
    el.addEventListener('click', e => { if (!it.current || e.ctrlKey || e.metaKey) openInWorkbench(it.open, e.ctrlKey || e.metaKey); });
    el.addEventListener('auxclick', e => { if (e.button === 1) { e.preventDefault(); openInWorkbench(it.open, true); } });
    el.addEventListener('contextmenu', e => {
      e.preventDefault();
      showMenu([
        { label: 'Open', disabled: it.current, run: () => openInWorkbench(it.open) },
        { label: 'Open in New Tab', run: () => openInWorkbench(it.open, true) },
        it.path && { separator: true },
        it.path && { label: 'Copy Path', run: () => navigator.clipboard?.writeText(it.path) },
      ], e.clientX, e.clientY);
    });
    return el;
  };
  const changes = st => {
    if (!st) return '';
    if (st.error) return h('span.err', { title: st.error }, '!');
    const out = [];
    const n = (st.changed || 0) + (st.untracked || 0) + (st.staged || 0);
    if (n) out.push(h('span.ch', { title: `${st.changed} changed, ${st.staged} staged, ${st.untracked} untracked` }, String(n)));
    if (st.ahead) out.push(h('span.ab', { title: `${st.ahead} to push` }, st.ahead + '↑'));
    if (st.behind) out.push(h('span.ab', { title: `${st.behind} to pull` }, st.behind + '↓'));
    return out;
  };
  const queue = [];
  let inflight = 0;
  const pump = () => {
    while (inflight < 4 && queue.length) {
      const p = queue.shift();
      inflight++;
      wb('api/wb/repostatus?path=' + encodeURIComponent(p))
        .then(s => status.set(p, s), e => status.set(p, { error: e.message }))
        .finally(() => { inflight--; drawSoon(); pump(); });
    }
  };
  const drawSoon = debounce(draw, 50);
  const io = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      const p = e.target.dataset.path;
      if (p && !status.has(p) && !queue.includes(p)) queue.push(p);
    }
    pump();
  }, { root: list });
  filter.addEventListener('input', draw);
  const load = async (rescan = false) => {
    data = await listRepositories({ rescan });
    if (rescan) status.clear();
    draw();
  };
  container._reload = load;
  load();
}

export function reloadReposView(view, rescan) {
  view?.container?._reload?.(rescan);
}
