// web/src/compare.js
// Comparing two files, as in VS Code: "Select for Compare" on one, "Compare
// with Selected" on another. The comparison is a diff editor with both files
// editable (the left one is the original).
import { basename } from './util.js';
import { openDiff } from './editors.js';
import { notify } from './ui.js';

let selected = '';

export const compareSelection = () => selected;

export function selectForCompare(path) {
  selected = path;
}

export function compareFiles(left, right) {
  if (!left || !right || left === right) {
    notify('Pick two different files to compare.');
    return null;
  }
  return openDiff({
    path: right, left: { path: left }, right: { path: right },
    title: `${basename(left)} ↔ ${basename(right)}`,
  });
}

export function compareWithSelected(path) {
  if (!selected) { notify('Select a file for compare first.'); return null; }
  return compareFiles(selected, path);
}
