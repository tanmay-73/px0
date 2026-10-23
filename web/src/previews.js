// web/src/previews.js
// Viewers for editor tabs that are not text: the Markdown preview (Ctrl+Shift+V,
// or to the side with Ctrl+K V), CSV/TSV tables, images and binary files.
//
// The server renders Markdown with goldmark and passes raw HTML through, so
// nothing it returns is trusted: mdSanitize rebuilds it against an allowlist in
// an inert document before any of it reaches the page.
import { api, apiURL } from './api.js';
import { h, icon, basename, extname, on, debounce } from './util.js';
import { registerViewer, openFile, rerenderView } from './editors.js';
import { renderMermaidBlocks } from './mermaid.js';

/* ---------- Markdown sanitising (from the previous px0 preview) ---------- */

const HTML_NS = 'http://www.w3.org/1999/xhtml';
// Removed along with everything inside them.
const MD_DROP = new Set(('script style iframe frame frameset object embed applet template noscript noembed ' +
  'svg math form textarea select option button link meta base title audio video source track canvas dialog').split(' '));
// Kept. Any other element is unwrapped: its children stay, the element goes.
const MD_KEEP = new Set(('a abbr b bdi bdo blockquote br caption center cite code col colgroup dd del details dfn div dl dt ' +
  'em figcaption figure h1 h2 h3 h4 h5 h6 hr i img input ins kbd li mark ol p pre q rp rt ruby s samp section small span ' +
  'strike strong sub summary sup table tbody td tfoot th thead tr tt u ul var wbr').split(' '));
// Attributes that can neither run script nor reach the network.
const MD_ATTRS = new Set(('align valign alt title lang dir width height colspan rowspan start reversed open checked ' +
  'disabled type data-line data-lang').split(' '));
// Token classes from the server's highlighter, allowed on <i>.
const MD_TOKENS = new Set('k kt nf nc nb nv no na nt nd np s m o p c cp gi gd gh ge gs err g'.split(' '));
const MD_SCHEME = /^([a-z][a-z0-9+.-]*):/i;
// Relative references resolve against this stand-in origin; landing anywhere else means they were not relative.
const MD_ORIGIN = 'http://px0.invalid';

/* The URL parser drops tabs and newlines anywhere and control characters at
   either end, so "java&#9;script:" still has a scheme. Test what it will see. */
const mdURL = ref => ref.replace(/[\t\n\r]/g, '').replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '');

/* Parsing into a DOMParser document runs no script and loads nothing, so the
   markup can be cleaned there and only the survivors adopted into the page. */
function mdSanitize(html, docPath) {
  const body = new DOMParser().parseFromString(html, 'text/html').body;
  const dir = docPath.slice(0, docPath.lastIndexOf('/') + 1);
  const base = MD_ORIGIN + '/' + dir.split('/').map(encodeURIComponent).join('/');
  for (const el of [...body.querySelectorAll('*')]) {
    if (!body.contains(el)) continue; // inside something already removed
    const tag = el.localName;
    if (el.namespaceURI !== HTML_NS || MD_DROP.has(tag)) { el.remove(); continue; }
    if (!MD_KEEP.has(tag) || (tag === 'input' && el.getAttribute('type') !== 'checkbox')) {
      el.replaceWith(...el.childNodes);
      continue;
    }
    const attrs = {};
    for (const a of [...el.attributes]) { attrs[a.name] = a.value; el.removeAttribute(a.name); }
    for (const name in attrs) if (MD_ATTRS.has(name)) el.setAttribute(name, attrs[name]);
    // Prefixed so a heading called "status" cannot shadow the status bar's id.
    const id = attrs.id || (tag === 'a' && attrs.name);
    if (id) el.id = 'md-' + id;
    if (attrs.class) {
      const keep = attrs.class.split(/\s+/).filter(c =>
        c === 'md-code' || c.startsWith('footnote') || (tag === 'i' && MD_TOKENS.has(c)));
      if (keep.length) el.className = keep.join(' ');
    }
    if (tag === 'input') /** @type {HTMLInputElement} */ (el).disabled = true;
    if (tag === 'img') mdSetImage(el, mdURL(attrs.src || ''), base);
    if (tag === 'a' && attrs.href) mdSetLink(el, mdURL(attrs.href), base);
  }
  const frag = document.createDocumentFragment();
  while (body.firstChild) frag.appendChild(document.adoptNode(body.firstChild));
  return frag;
}

/* A reference without a scheme names a file in the workspace, relative to the
   Markdown file's directory, or to the root when it starts with /, as on GitHub.
   Returns null for anything that does not resolve that way. */
function mdLocal(ref, base) {
  let u;
  try { u = new URL(ref, base); } catch { return null; }
  if (u.origin !== MD_ORIGIN) return null;
  let path = u.pathname;
  try { path = decodeURIComponent(path); } catch {}
  return { path: path.slice(1), hash: u.hash.slice(1) };
}

function mdSetImage(img, src, base) {
  img.setAttribute('loading', 'lazy');
  img.setAttribute('decoding', 'async');
  img.classList.add('md-zoomable');
  const m = MD_SCHEME.exec(src);
  if (m) {
    if (/^https?$/i.test(m[1]) || /^data:image\//i.test(src)) {
      img.setAttribute('src', src);
      img.dataset.origSrc = src;
    }
  } else if (src.startsWith('//')) {
    img.setAttribute('src', src);
    img.dataset.origSrc = src;
  } else if (src) {
    const t = mdLocal(src, base);
    if (t) {
      const rawUrl = new URL('api/raw?path=' + encodeURIComponent(t.path), document.baseURI || location.href).href;
      img.setAttribute('src', rawUrl);
      img.dataset.rawPath = t.path;
      img.dataset.origSrc = src;
    }
  }
}

/* Links within the file scroll the preview, links to workspace files open them
   in px0, web links open a new browser tab, and any other scheme loses its href. */
function mdSetLink(a, href, base) {
  if (href.startsWith('#')) {
    a.setAttribute('href', href);
    a.dataset.anchor = href.slice(1);
    return;
  }
  const m = MD_SCHEME.exec(href);
  if (m || href.startsWith('//')) {
    if (m && !/^(https?|mailto)$/i.test(m[1])) return;
    a.setAttribute('href', href);
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return;
  }
  const t = mdLocal(href, base);
  if (!t) return;
  const rawUrl = new URL('api/raw?path=' + encodeURIComponent(t.path), document.baseURI || location.href).href;
  a.setAttribute('href', rawUrl);
  a.dataset.path = t.path;
  if (t.hash) a.dataset.anchor = t.hash;
}

/* ---------- presentation ---------- */

const MD_ALERTS = { note: 'Note', tip: 'Tip', important: 'Important', warning: 'Warning', caution: 'Caution' };

function mdEnhance(mdArticle) {
  for (const q of mdArticle.querySelectorAll('blockquote')) mdAlert(q);
  for (const pre of mdArticle.querySelectorAll('pre')) {
    const wrap = document.createElement('div');
    wrap.className = 'md-pre';
    if (pre.dataset.lang) wrap.dataset.lang = pre.dataset.lang;
    pre.replaceWith(wrap);
    const copy = document.createElement('button');
    copy.className = 'md-copy';
    copy.title = 'Copy code';
    copy.setAttribute('aria-label', 'Copy code');
    // An icon, not a label: find in the preview walks text nodes.
    copy.innerHTML = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.5V3a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5"/></svg>';
    wrap.append(pre, copy);
  }
}

function mdAlert(q) {
  const p = q.firstElementChild;
  const t = p && p.localName === 'p' && p.firstChild;
  if (!t || t.nodeType !== 3) return;
  const m = /^\s*\[!(\w+)\][ \t]*\n?/.exec(t.nodeValue);
  const kind = m && m[1].toLowerCase();
  if (!kind || !MD_ALERTS[kind]) return;
  t.nodeValue = t.nodeValue.slice(m[0].length);
  if (!t.nodeValue) t.remove();
  if (p.firstChild && p.firstChild.localName === 'br') p.firstChild.remove();
  if (!p.textContent.trim() && !p.children.length) p.remove();
  const title = document.createElement('p');
  title.className = 'md-alert-title';
  title.textContent = MD_ALERTS[kind];
  q.prepend(title);
  q.classList.add('md-alert', 'md-alert-' + kind);
}

/* ---------- viewers ---------- */

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif']);

async function renderMarkdown(t, root) {
  root.classList.add('md-view');
  const article = h('article.md');
  root.append(article);
  const my = (t.renderSeq = (t.renderSeq || 0) + 1);
  let j;
  try {
    j = await api('api/markdown', { path: t.path });
  } catch (e) {
    article.append(h('div.view-message', icon('warning'), ' ', e.message));
    return;
  }
  if (my !== t.renderSeq) return;
  article.replaceChildren(mdSanitize(j.html || '', t.path));
  mdEnhance(article);
  renderMermaidBlocks(article, () => my === t.renderSeq && article.isConnected).catch(() => {});
  article.addEventListener('click', e => {
    const copy = e.target.closest('.md-copy');
    if (copy) {
      const code = copy.parentElement.querySelector('pre')?.innerText || '';
      navigator.clipboard?.writeText(code).then(() => { copy.classList.add('copied'); setTimeout(() => copy.classList.remove('copied'), 1200); });
      return;
    }
    const a = e.target.closest('a');
    if (!a || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (a.dataset.path !== undefined && a.dataset.path) {
      e.preventDefault();
      if (/\.(md|markdown)$/i.test(a.dataset.path)) openMarkdownPreview(a.dataset.path);
      else openFile(a.dataset.path);
    } else if (a.dataset.anchor) {
      e.preventDefault();
      article.querySelector('#' + CSS.escape('md-' + a.dataset.anchor))?.scrollIntoView({ block: 'start' });
    }
  });
}

export function openMarkdownPreview(path, opts = {}) {
  return import('./editors.js').then(({ openView }) => openView('markdown', path, { title: 'Preview ' + basename(path), ...opts }));
}

async function renderTable(t, root) {
  root.classList.add('table-view');
  let j;
  try {
    j = await api('api/table', { path: t.path });
  } catch (e) {
    root.append(h('div.view-message', icon('warning'), ' ', e.message));
    return;
  }
  const cols = Math.max(j.cols || 0, (j.header || []).length);
  const head = h('tr', h('th.tv-ln', '#'), [...Array(cols)].map((_, i) => h('th', (j.header || [])[i] ?? '')));
  const body = (j.rows || []).map(r => h('tr', h('td.tv-ln', String(r.line)), [...Array(cols)].map((_, i) => h('td', r.cells[i] ?? ''))));
  root.append(
    h('div.tv-toolbar',
      h('span', `${(j.rows || []).length} rows × ${cols} columns${j.truncated ? ' (truncated)' : ''}`),
      h('button.btn.secondary', { type: 'button', on: { click: () => openFile(t.path, { asText: true }) } }, icon('code'), ' Open as Text')),
    h('div.tv-scroll', h('table.tv', h('thead', head), h('tbody', body))));
}

function renderImage(t, root) {
  root.classList.add('image-view');
  let zoom = 0; // 0 = fit
  const img = h('img', { src: apiURL('api/raw', { path: t.path, v: Date.now() }), alt: basename(t.path), draggable: 'false' });
  const info = h('span.iv-info');
  const canvas = h('div.iv-canvas', img);
  const apply = () => {
    img.style.width = zoom ? img.naturalWidth * zoom + 'px' : '';
    canvas.classList.toggle('fit', !zoom);
    zoomLabel.textContent = zoom ? Math.round(zoom * 100) + '%' : 'Fit';
  };
  const zoomLabel = h('span.iv-zoom', 'Fit');
  const step = d => {
    const cur = zoom || (img.clientWidth / (img.naturalWidth || 1));
    const levels = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8];
    zoom = d > 0 ? levels.find(l => l > cur + 1e-3) || 8 : [...levels].reverse().find(l => l < cur - 1e-3) || 0.1;
    apply();
  };
  img.addEventListener('load', () => { info.textContent = `${img.naturalWidth} × ${img.naturalHeight}`; apply(); });
  img.addEventListener('error', () => { canvas.replaceChildren(h('div.view-message', icon('warning'), ' The image could not be displayed.')); });
  canvas.addEventListener('wheel', e => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); step(e.deltaY < 0 ? 1 : -1); } }, { passive: false });
  canvas.addEventListener('click', e => { if (e.altKey) step(-1); else step(1); });
  root.append(
    h('div.iv-toolbar', info, h('span.grow'),
      h('button.icon-btn', { type: 'button', title: 'Zoom Out', on: { click: () => step(-1) } }, icon('zoom-out')),
      zoomLabel,
      h('button.icon-btn', { type: 'button', title: 'Zoom In', on: { click: () => step(1) } }, icon('zoom-in')),
      h('button.icon-btn', { type: 'button', title: 'Fit', on: { click: () => { zoom = 0; apply(); } } }, icon('screen-normal')),
      h('button.icon-btn', { type: 'button', title: 'Actual Size', on: { click: () => { zoom = 1; apply(); } } }, icon('screen-full')),
      extname(t.path) === 'svg' ? h('button.btn.secondary', { type: 'button', on: { click: () => openFile(t.path, { asText: true }) } }, icon('code'), ' Open as Text') : null),
    canvas);
}

function renderBinary(t, root) {
  root.classList.add('binary-view');
  root.append(h('div.view-message.center',
    icon('file-binary', 'big'),
    h('p', t.info === 'large'
      ? 'The file is not displayed in the text editor because it is very large.'
      : 'The file is not displayed in the text editor because it is either binary or uses an unsupported text encoding.'),
    h('a.btn.secondary', { href: apiURL('api/raw', { path: t.path }), target: '_blank', rel: 'noopener' }, icon('link-external'), ' Open Raw')));
}

export function initPreviews() {
  registerViewer('markdown', { render: renderMarkdown });
  registerViewer('table', { render: renderTable });
  registerViewer('image', { render: renderImage });
  registerViewer('binary', { render: renderBinary });
  // A saved Markdown file refreshes its preview; the theme changes Mermaid's colours.
  on('doc:saved', d => rerenderView(t => t.path === d.path && t.view === 'markdown'));
  on('doc:changed', debounce(d => rerenderView(t => t.path === d.path && t.view === 'markdown' && t.live), 400));
  on('theme:changed', () => rerenderView(t => t.view === 'markdown'));
}

export const isImagePath = p => IMAGE_EXT.has(extname(p));
export const isTablePath = p => ['csv', 'tsv'].includes(extname(p));
export const isMarkdownPath = p => /\.(md|markdown)$/i.test(p);
