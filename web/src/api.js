// web/src/api.js
// The px0 server's HTTP API. Paths are relative to the page's <base>, which the
// server sets to the workspace's base path (/w/<id>/ under the workbench), so
// the same code works on its own port and behind the workbench proxy.

export const S = {
  meta: null, // /api/meta, set by main.js
};

const url = (path, params) => {
  const u = new URL(path.replace(/^\//, ''), document.baseURI);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
  }
  return u;
};

async function parse(r) {
  const text = await r.text();
  let j;
  try { j = text ? JSON.parse(text) : {}; } catch { j = { error: text || r.statusText }; }
  if (!r.ok || (j && j.error && !j.conflict)) {
    const e = new Error((j && j.error) || r.statusText || 'request failed');
    e.status = r.status;
    e.body = j;
    throw e;
  }
  return j;
}

export async function api(path, params, opts = {}) {
  return parse(await fetch(url(path, params), { signal: opts.signal }));
}

export async function post(path, body, opts = {}) {
  return parse(await fetch(url(path, opts.params), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal: opts.signal,
  }));
}

export const apiURL = (path, params) => url(path, params).href;

/* The workbench (workbench.go), when this workspace is one of its children:
   its API lives at S.meta.workbench on the same origin. */
export const inWorkbench = () => !!S.meta?.workbench;

export async function wb(path, body) {
  const u = new URL(S.meta.workbench.replace(/\/?$/, '/') + path, location.origin);
  const r = await fetch(u, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return parse(r);
}

export const wbURL = path => new URL(S.meta.workbench.replace(/\/?$/, '/') + path, location.origin).href;
