import { test, expect } from 'bun:test';
import { diffLines } from './linediff.js';

test('identical inputs have no hunks', () => {
  expect(diffLines(['a', 'b'], ['a', 'b'])).toEqual([]);
});

test('a changed line is one hunk replacing one line', () => {
  expect(diffLines(['a', 'b', 'c'], ['a', 'X', 'c'])).toEqual([{ a: 1, aLen: 1, b: 1, bLen: 1 }]);
});

test('insertions and deletions', () => {
  expect(diffLines(['a', 'c'], ['a', 'b', 'c'])).toEqual([{ a: 1, aLen: 0, b: 1, bLen: 1 }]);
  expect(diffLines(['a', 'b', 'c'], ['a', 'c'])).toEqual([{ a: 1, aLen: 1, b: 1, bLen: 0 }]);
  expect(diffLines([], ['x', 'y'])).toEqual([{ a: 0, aLen: 0, b: 0, bLen: 2 }]);
  expect(diffLines(['x'], [])).toEqual([{ a: 0, aLen: 1, b: 0, bLen: 0 }]);
});

test('separate edits stay separate hunks', () => {
  const h = diffLines(['1', '2', '3', '4', '5'], ['1', 'two', '3', '4', 'five', '6']);
  expect(h).toEqual([{ a: 1, aLen: 1, b: 1, bLen: 1 }, { a: 4, aLen: 1, b: 4, bLen: 2 }]);
});
