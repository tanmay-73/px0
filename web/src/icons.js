// VS Code's Seti file icons, shared by the explorer, editor tabs and pickers.
// The font and associations are bundled locally; no runtime fetch is needed.
import { h, icon } from './util.js';
import { languageFor } from './monaco.js';
import { definitions, extensions, filenames, languages, defaultIcon } from './gen/seti.js';

export function fileIcon(path, cls = '') {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  let id = filenames[name];
  // Match compound extensions (e.g. test.ts) before their shorter suffixes.
  if (!id) {
    const parts = name.split('.');
    for (let i = 1; i < parts.length && !id; i++) id = extensions[parts.slice(i).join('.')];
  }
  id ||= languages[languageFor(path)] || defaultIcon;
  const [glyph, dark, light] = definitions[id];
  return h('span.file-icon.seti-icon', {
    class: cls, 'aria-hidden': 'true', style: { color: `light-dark(${light}, ${dark})` },
  }, glyph);
}

export function folderIcon(open, cls = '') {
  return icon(open ? 'folder-opened' : 'folder', 'folder-icon' + (cls ? ' ' + cls : ''));
}
