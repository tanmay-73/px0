import { test, expect } from 'bun:test';
import { fuzzy, highlight } from './quickinput.js';

test('fuzzy prefers contiguous matches', () => {
  expect(fuzzy('scm', 'scm.js').pos).toEqual([0, 1, 2]);
  expect(fuzzy('sjs', 'scm.js').pos).toEqual([0, 4, 5]);
  expect(fuzzy('xyz', 'scm.js')).toBeNull();
  expect(fuzzy('scm', 'scm.js').score).toBeGreaterThan(fuzzy('sjs', 'scm.js').score);
});

test('highlight escapes and bolds', () => {
  expect(highlight('<a>', [1])).toBe('&lt;<b>a</b>&gt;');
  expect(highlight('abc', [])).toBe('abc');
});
