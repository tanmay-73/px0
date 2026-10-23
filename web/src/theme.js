// web/src/theme.js
// Colour themes. A theme is a CSS rule [data-theme="<id>"] in web/themes/*.css
// (joined by the server into static/themes.css) that sets the px0 tokens:
// surfaces --bg..--bg4, text --fg/--dim/--faint, --line, --accent, syntax
// tokens --k, --s, --c, ... and diff colours. The workbench chrome reads them
// straight from CSS; Monaco cannot, so monacoTheme() turns the computed values
// into a Monaco theme each time the theme changes. Shared with the workbench
// page (workbench.js), so it imports nothing but util.js.
import { emit, pref, setPref } from './util.js';

export const DEFAULT_THEME = 'vscode-dark-2026';
const THEME_SELECTOR = /^(?::root|html)?\[data-theme=["']?([\w-]+)["']?\]$/;

let themes = null;

export function listThemes() {
  if (themes) return themes;
  const found = new Map();
  const walk = rules => {
    for (const r of rules) {
      if (r.styleSheet) { try { walk(r.styleSheet.cssRules); } catch {} continue; }
      if (!r.selectorText) { if (r.cssRules) walk(r.cssRules); continue; }
      for (const part of r.selectorText.split(',')) {
        const m = part.trim().match(THEME_SELECTOR);
        if (!m) continue;
        const t = found.get(m[1]) || { id: m[1], name: m[1], scheme: '' };
        const name = r.style.getPropertyValue('--theme-name').trim().replace(/^["']|["']$/g, '');
        const scheme = r.style.getPropertyValue('color-scheme').trim();
        if (name) t.name = name;
        if (scheme) t.scheme = scheme;
        found.set(m[1], t);
      }
    }
  };
  for (const sheet of document.styleSheets) {
    try { walk(sheet.cssRules); } catch {}
  }
  themes = [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
  return themes;
}

export const currentTheme = () => document.documentElement.dataset.theme;
export const isDark = () => (listThemes().find(t => t.id === currentTheme())?.scheme || 'dark') !== 'light';

/* setTheme applies a theme; persist also remembers it in this browser and in
   settings.json (workbench.colorTheme), which the workbench page and every
   workspace read. */
export function setTheme(id, persist = true, saveSetting = null) {
  if (!listThemes().some(t => t.id === id)) return false;
  const changed = currentTheme() !== id;
  document.documentElement.dataset.theme = id;
  if (persist) {
    setPref('theme', id);
    saveSetting?.(id);
  }
  if (changed) emit('theme:changed', id);
  return true;
}

// The theme to start with: one picked in this browser, else the configured one.
export function initialTheme(configured) {
  const saved = pref('theme', null);
  if (configured && configured !== DEFAULT_THEME) return configured;
  return saved || configured || DEFAULT_THEME;
}

/* ---------- Monaco ---------- */

let probe = null;

// A CSS colour as Monaco wants it: #rrggbb or #rrggbbaa.
function hex(value, fallback = '#000000') {
  const v = (value || '').trim();
  if (!v) return fallback;
  if (/^#[0-9a-f]{3,8}$/i.test(v)) {
    if (v.length === 4) return '#' + [...v.slice(1)].map(c => c + c).join('');
    return v;
  }
  probe ||= document.createElement('canvas').getContext('2d');
  probe.fillStyle = '#000';
  probe.fillStyle = v;
  const out = probe.fillStyle; // "#rrggbb" or "rgba(r, g, b, a)"
  if (out.startsWith('#')) return out;
  const m = out.match(/rgba?\(([^)]+)\)/);
  if (!m) return fallback;
  const [r, g, b, a = '1'] = m[1].split(',').map(s => s.trim());
  const to2 = n => Math.round(Number(n)).toString(16).padStart(2, '0');
  return '#' + to2(r) + to2(g) + to2(b) + (Number(a) < 1 ? to2(Number(a) * 255) : '');
}

const alpha = (color, a) => hex(color).slice(0, 7) + Math.round(a * 255).toString(16).padStart(2, '0');

export function themeTokens() {
  const cs = getComputedStyle(document.documentElement);
  const v = name => cs.getPropertyValue('--' + name).trim();
  const t = {};
  for (const k of ['bg', 'bg2', 'bg3', 'bg4', 'fg', 'dim', 'faint', 'line', 'accent', 'accent-fg', 'on-accent', 'sel',
    'mark', 'mark-active', 'cur', 'k', 'kt', 'nf', 'nc', 'nb', 'nv', 'no', 'na', 'nt', 'nd', 'np', 's', 'm', 'o', 'p',
    'c', 'cp', 'err', 'gi', 'gd', 'gi-bg', 'gd-bg', 'input-bg', 'input-border', 'list-hover', 'list-selection', 'list-active',
    'list-active-fg', 'quick-input-bg', 'widget-bg', 'widget-border', 'line-number', 'cursor', 'comment-style', 'focus',
    'editor-bg', 'editor-fg', 'line-number-active', 'gutter-added', 'gutter-modified', 'gutter-deleted', 'diff-ins-text',
    'diff-del-text', 'diff-ins-line', 'diff-del-line', 'find-match', 'find-match-hl', 'word-hl', 'sel-hl', 'sel-inactive',
    'bracket-match', 'indent-guide', 'indent-guide-active', 'whitespace', 'suggest-selected', 'scrollbar', 'scrollbar-hover',
    'scrollbar-active', 'highlight-fg', 'menu-bg', 'menu-hover', 'warn', 'info', 'error-icon', 'card-border', 'option-active-bg',
    'option-active-border', 'sidebar-bg']) t[k] = v(k);
  return t;
}

/* monacoTheme maps px0 tokens onto Monaco's token types (Monarch scopes) and
   workbench colours, so the editor reads as part of the same theme. Themes
   may set VS Code's own editor colours (--editor-bg, --gutter-added, ...);
   otherwise they are derived from the base tokens. */
export function monacoTheme() {
  const t = themeTokens();
  const c = name => hex(t[name]).slice(1);
  const or = (name, fallback) => (t[name] ? hex(t[name]) : fallback);
  const bg = or('editor-bg', hex(t.bg));
  const rules = [
    { token: '', foreground: hex(t['editor-fg'] || t.fg).slice(1) },
    { token: 'comment', foreground: c('c'), fontStyle: t['comment-style'] === 'normal' ? '' : 'italic' },
    { token: 'comment.doc', foreground: c('c'), fontStyle: t['comment-style'] === 'normal' ? '' : 'italic' },
    { token: 'string', foreground: c('s') },
    { token: 'string.escape', foreground: c('o') },
    { token: 'string.key', foreground: c('np') },
    { token: 'string.value', foreground: c('s') },
    { token: 'regexp', foreground: c('s') },
    { token: 'keyword', foreground: c('k') },
    { token: 'keyword.flow', foreground: c('k') },
    { token: 'storage', foreground: c('k') },
    { token: 'number', foreground: c('m') },
    { token: 'constant', foreground: c('no') },
    { token: 'type', foreground: c('kt') },
    { token: 'type.identifier', foreground: c('nc') },
    { token: 'class', foreground: c('nc') },
    { token: 'function', foreground: c('nf') },
    { token: 'predefined', foreground: c('nb') },
    { token: 'identifier', foreground: c('nv') },
    { token: 'variable', foreground: c('nv') },
    { token: 'variable.predefined', foreground: c('nb') },
    { token: 'variable.parameter', foreground: c('nv') },
    { token: 'delimiter', foreground: c('p') },
    { token: 'delimiter.bracket', foreground: c('p') },
    { token: 'operator', foreground: c('o') },
    { token: 'operators', foreground: c('o') },
    { token: 'tag', foreground: c('nt') },
    { token: 'metatag', foreground: c('cp') },
    { token: 'attribute.name', foreground: c('na') },
    { token: 'attribute.value', foreground: c('s') },
    { token: 'annotation', foreground: c('nd') },
    { token: 'key', foreground: c('np') },
    { token: 'namespace', foreground: c('nc') },
    { token: 'invalid', foreground: c('err') },
    { token: 'emphasis', fontStyle: 'italic' },
    { token: 'strong', fontStyle: 'bold' },
    { token: 'keyword.md', foreground: c('k') },
    { token: 'string.link', foreground: c('accent-fg'), fontStyle: 'underline' },
  ];
  const widget = or('widget-bg', hex(t.bg2));
  const widgetBorder = or('widget-border', hex(t.bg4));
  const colors = {
    'editor.background': bg,
    'editor.foreground': or('editor-fg', hex(t.fg)),
    'editorLineNumber.foreground': hex(t['line-number'] || t.faint),
    'editorLineNumber.activeForeground': or('line-number-active', hex(t.fg)),
    'editor.lineHighlightBackground': hex(t.cur),
    'editor.lineHighlightBorder': hex(t.cur),
    'editor.selectionBackground': hex(t.sel),
    'editor.inactiveSelectionBackground': or('sel-inactive', alpha(t.sel, 0.5)),
    'editor.selectionHighlightBackground': or('sel-hl', alpha(t.sel, 0.6)),
    'editor.wordHighlightBackground': or('word-hl', alpha(t.sel, 0.6)),
    'editor.wordHighlightStrongBackground': or('word-hl', alpha(t.sel, 0.6)),
    'editor.findMatchBackground': or('find-match', alpha(t['mark-active'], 0.45)),
    'editor.findMatchHighlightBackground': or('find-match-hl', hex(t.mark)),
    'editorCursor.foreground': hex(t.cursor || t.accent),
    'editorWhitespace.foreground': or('whitespace', alpha(t.faint, 0.5)),
    'editorIndentGuide.background1': or('indent-guide', alpha(t.faint, 0.25)),
    'editorIndentGuide.activeBackground1': or('indent-guide-active', alpha(t.faint, 0.6)),
    'editorRuler.foreground': alpha(t.faint, 0.3),
    'editorBracketMatch.background': or('bracket-match', alpha(t.accent, 0.15)),
    'editorBracketMatch.border': widgetBorder,
    'editorGutter.background': bg,
    'editorGutter.addedBackground': or('gutter-added', hex(t.gi)),
    'editorGutter.modifiedBackground': or('gutter-modified', hex(t['accent-fg'])),
    'editorGutter.deletedBackground': or('gutter-deleted', hex(t.gd)),
    'editorWidget.background': widget,
    'editorWidget.foreground': hex(t.fg),
    'editorWidget.border': widgetBorder,
    'editorHoverWidget.background': widget,
    'editorHoverWidget.border': widgetBorder,
    'editorSuggestWidget.background': widget,
    'editorSuggestWidget.border': widgetBorder,
    'editorSuggestWidget.foreground': hex(t.fg),
    'editorSuggestWidget.selectedBackground': or('suggest-selected', hex(t.bg3)),
    'editorSuggestWidget.highlightForeground': or('highlight-fg', hex(t['accent-fg'])),
    'editorError.foreground': or('error-icon', hex(t.err)),
    'editorWarning.foreground': or('warn', hex(t['mark-active'])),
    'editorInfo.foreground': or('info', hex(t['accent-fg'])),
    'editorOverviewRuler.border': or('card-border', alpha(t.line, 0)),
    'editorStickyScroll.background': bg,
    'editorStickyScroll.border': or('card-border', hex(t.line)),
    'editorStickyScrollHover.background': widget,
    'peekView.border': widgetBorder,
    'peekViewEditor.background': or('sidebar-bg', hex(t.bg2)),
    'peekViewResult.background': or('sidebar-bg', hex(t.bg2)),
    'peekViewTitle.background': hex(t.bg3),
    'peekViewEditor.matchHighlightBackground': or('find-match-hl', hex(t.mark)),
    'peekViewResult.matchHighlightBackground': or('find-match-hl', hex(t.mark)),
    'diffEditor.insertedTextBackground': or('diff-ins-text', alpha(t.gi, 0.22)),
    'diffEditor.removedTextBackground': or('diff-del-text', alpha(t.gd, 0.22)),
    'diffEditor.insertedLineBackground': or('diff-ins-line', hex(t['gi-bg'])),
    'diffEditor.removedLineBackground': or('diff-del-line', hex(t['gd-bg'])),
    'diffEditor.diagonalFill': alpha(t.faint, 0.2),
    'diffEditor.unchangedRegionBackground': or('sidebar-bg', hex(t.bg2)),
    'diffEditor.unchangedRegionForeground': hex(t.dim),
    'diffEditorGutter.insertedLineBackground': or('diff-ins-line', hex(t['gi-bg'])),
    'diffEditorGutter.removedLineBackground': or('diff-del-line', hex(t['gd-bg'])),
    'scrollbar.shadow': '#00000000',
    'scrollbarSlider.background': or('scrollbar', alpha(t.faint, 0.25)),
    'scrollbarSlider.hoverBackground': or('scrollbar-hover', alpha(t.faint, 0.4)),
    'scrollbarSlider.activeBackground': or('scrollbar-active', alpha(t.faint, 0.55)),
    'minimap.background': bg,
    'minimapSlider.background': or('scrollbar', alpha(t.faint, 0.15)),
    'minimapSlider.hoverBackground': or('scrollbar-hover', alpha(t.faint, 0.25)),
    'minimapSlider.activeBackground': or('scrollbar-active', alpha(t.faint, 0.35)),
    'focusBorder': or('focus', alpha(t.accent, 0.8)),
    'input.background': hex(t['input-bg'] || t.bg),
    'input.border': or('input-border', hex(t.bg4)),
    'input.foreground': hex(t.fg),
    'inputOption.activeBorder': or('option-active-border', hex(t.accent)),
    'inputOption.activeBackground': or('option-active-bg', alpha(t.accent, 0.2)),
    'list.hoverBackground': hex(t['list-hover'] || t.bg3),
    'list.activeSelectionBackground': or('list-active', hex(t['list-selection'] || t.bg4)),
    'list.activeSelectionForeground': or('list-active-fg', hex(t.fg)),
    'list.inactiveSelectionBackground': hex(t['list-selection'] || t.bg4),
    'list.focusBackground': or('list-active', hex(t.bg3)),
    'list.focusOutline': or('focus', hex(t.accent)),
    'list.highlightForeground': or('highlight-fg', hex(t['accent-fg'])),
    'menu.background': or('menu-bg', hex(t.bg2)),
    'menu.foreground': hex(t.fg),
    'menu.selectionBackground': or('menu-hover', hex(t.bg4)),
    'quickInput.background': hex(t['quick-input-bg'] || t.bg2),
    'textLink.foreground': hex(t['accent-fg']),
    'widget.border': widgetBorder,
    'widget.shadow': '#00000024',
  };
  return { base: isDark() ? 'vs-dark' : 'vs', inherit: true, rules, colors };
}
