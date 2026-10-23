// web/src/lsp.js
// Language intelligence for Monaco, from px0's language-server endpoints
// (lsp.go): hover, go to definition, find references, document symbols
// (outline, breadcrumbs, Ctrl+Shift+O) and diagnostics as editor markers.
// When no language server is ready, definitions fall back to px0's own index
// (/api/def) and symbols to its regex outline (/api/outline), so navigation
// still works in any language.
//
// Positions: Monaco counts lines and columns from 1 in UTF-16 units; the API
// takes 1-based lines and 0-based UTF-16 columns.
import { monaco } from './monaco.js';
import { api } from './api.js';
import { emit, on } from './util.js';
import { pathOfUri, fileUri, openDoc, allDocs } from './models.js';

const state = new Map(); // path -> { state, server, missing }

export const lspState = path => state.get(path) || { state: 'off', server: '' };

function setState(path, j) {
  if (!j || j.state === undefined) return;
  const prev = state.get(path);
  const next = { state: j.state, server: j.server || '', missing: j.missing || '' };
  state.set(path, next);
  if (!prev || prev.state !== next.state || prev.server !== next.server) emit('lsp:state', { path, ...next });
}

export async function warm(path, tries = 0) {
  if (!path || path.startsWith('/') || tries > 25) return;
  let j;
  try { j = await api('api/lsp/warm', { path, wait: tries ? 1200 : 1 }); } catch { return; }
  setState(path, j);
  if (j.state === 'starting' || j.state === 'indexing') setTimeout(() => warm(path, tries + 1), 900);
  else if (j.state === 'ready') refreshDiagnostics(path);
}

const ready = path => ['ready', 'indexing'].includes(lspState(path).state);

const pos = (model, p) => ({ path: pathOfUri(model.uri), line: p.lineNumber, col: p.column - 1 });

// A location for a hit { path, line, pre, mid }: the hit's word if the line can be read.
function location(hit) {
  const line = hit.line || 1;
  const col = (hit.pre || '').length + 1;
  const len = (hit.mid || '').length;
  const uri = hit.path.startsWith('/') ? fileUri(hit.path) : fileUri(hit.path);
  return { uri, range: new monaco.Range(line, len ? col : 1, line, len ? col + len : 1) };
}

// Peek widgets need the target files as models.
async function ensureModels(hits) {
  const paths = [...new Set(hits.map(h => h.path))].slice(0, 40);
  await Promise.allSettled(paths.map(p => (monaco.editor.getModel(fileUri(p)) ? null : openDoc(p))));
}

const KIND = {
  func: 'Function', function: 'Function', method: 'Method', class: 'Class', struct: 'Struct', interface: 'Interface',
  type: 'Class', enum: 'Enum', const: 'Constant', constant: 'Constant', var: 'Variable', variable: 'Variable',
  field: 'Field', property: 'Property', module: 'Module', namespace: 'Namespace', package: 'Package', heading: 'String',
  section: 'String', key: 'Key', constructor: 'Constructor', event: 'Event', operator: 'Operator', typeparam: 'TypeParameter',
};

export async function documentSymbols(path) {
  let syms = [];
  if (ready(path)) {
    try {
      const j = await api('api/lsp/symbols', { path });
      setState(path, j);
      syms = j.symbols || [];
    } catch {}
  }
  if (!syms.length) {
    try { syms = (await api('api/outline', { path })).symbols || []; } catch {}
  }
  return syms;
}

// Flat symbols with indent levels -> Monaco's nested DocumentSymbols.
function toTree(syms, model) {
  const out = [];
  const stack = [];
  const lines = model.getLineCount();
  for (const s of syms) {
    const line = Math.min(Math.max(1, s.line), lines);
    const end = Math.min(Math.max(line, s.end || line), lines);
    const text = model.getLineContent(line);
    const at = Math.max(0, text.indexOf(s.name));
    const kindName = KIND[(s.kind || '').toLowerCase()] || 'Variable';
    const sym = {
      name: s.name, detail: s.detail || '', kind: monaco.languages.SymbolKind[kindName], tags: [],
      range: new monaco.Range(line, 1, end, model.getLineMaxColumn(end)),
      selectionRange: new monaco.Range(line, at + 1, line, at + 1 + s.name.length),
      children: [], _indent: s.indent || 0,
    };
    while (stack.length && stack[stack.length - 1]._indent >= sym._indent) stack.pop();
    (stack.length ? stack[stack.length - 1].children : out).push(sym);
    stack.push(sym);
  }
  return out;
}

export function initLsp() {
  const ids = monaco.languages.getLanguages().map(l => l.id);
  const sel = ids.map(language => ({ language, scheme: 'file' }));

  monaco.languages.registerHoverProvider(sel, {
    async provideHover(model, p) {
      const at = pos(model, p);
      if (!at.path || !ready(at.path)) return null;
      try {
        const j = await api('api/lsp/hover', { ...at, wait: 2000 });
        setState(at.path, j);
        if (j.empty || (!j.signature && !j.doc)) return null;
        const word = model.getWordAtPosition(p);
        const contents = [];
        if (j.signature) contents.push({ value: '```' + model.getLanguageId() + '\n' + j.signature + '\n```' });
        if (j.doc) contents.push({ value: j.doc });
        return { contents, range: word ? new monaco.Range(p.lineNumber, word.startColumn, p.lineNumber, word.endColumn) : undefined };
      } catch { return null; }
    },
  });

  monaco.languages.registerDefinitionProvider(sel, {
    async provideDefinition(model, p) {
      const at = pos(model, p);
      if (!at.path) return null;
      let hits = [];
      if (ready(at.path) || lspState(at.path).state === 'starting') {
        try {
          const j = await api('api/lsp/def', { ...at, wait: ready(at.path) ? 5000 : 15000 });
          setState(at.path, j);
          hits = j.hits || [];
        } catch {}
      }
      if (!hits.length) {
        const word = model.getWordAtPosition(p)?.word;
        if (!word) return null;
        try { hits = (await api('api/def', { sym: word, path: at.path })).defs || []; } catch {}
      }
      if (!hits.length) return null;
      await ensureModels(hits);
      return hits.map(location);
    },
  });

  monaco.languages.registerReferenceProvider(sel, {
    async provideReferences(model, p) {
      const at = pos(model, p);
      if (!at.path || !ready(at.path)) return null;
      try {
        const j = await api('api/lsp/refs', { ...at, wait: 8000 });
        setState(at.path, j);
        const hits = j.hits || [];
        await ensureModels(hits);
        return hits.map(location);
      } catch { return null; }
    },
  });

  monaco.languages.registerDocumentSymbolProvider(sel, {
    displayName: 'px0',
    async provideDocumentSymbols(model) {
      const path = pathOfUri(model.uri);
      if (!path) return [];
      return toTree(await documentSymbols(path), model);
    },
  });

  on('doc:saved', d => setTimeout(() => refreshDiagnostics(d.path), 600));
  setInterval(() => {
    if (document.hidden) return;
    for (const d of allDocs()) if (d.model && ready(d.path)) refreshDiagnostics(d.path);
  }, 4000);
}

/* ---------- diagnostics ---------- */

const SEV = () => ({ 1: monaco.MarkerSeverity.Error, 2: monaco.MarkerSeverity.Warning, 3: monaco.MarkerSeverity.Info, 4: monaco.MarkerSeverity.Hint });

export async function refreshDiagnostics(path) {
  const model = monaco.editor.getModel(fileUri(path));
  if (!model) return;
  let j;
  try { j = await api('api/lsp/diagnostics', { path }); } catch { return; }
  setState(path, j);
  const sev = SEV();
  const markers = (j.diagnostics || []).map(d => ({
    severity: sev[d.severity] || monaco.MarkerSeverity.Info,
    message: d.message,
    source: d.source || j.server || '',
    code: d.code || undefined,
    startLineNumber: d.line,
    startColumn: (d.col || 0) + 1,
    endLineNumber: d.endLine || d.line,
    endColumn: (d.endCol ?? d.col ?? 0) + 1 + (d.endCol === undefined && !d.endLine ? 1 : 0),
  }));
  if (model.isDisposed()) return;
  monaco.editor.setModelMarkers(model, 'lsp', markers);
}
