// web/src/linediff.js
// A line diff for the editor's quick diff bars (dirtydiff.js). No imports, so
// it can be tested on its own (linediff.test.js).

/* Myers' O(ND) diff of two line arrays, as hunks
   { a, aLen, b, bLen } (0-based starts). */
export function diffLines(A, B) {
  const n = A.length, m = B.length;
  const max = n + m;
  const v = new Int32Array(2 * max + 2);
  const trace = [];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[max + k - 1] < v[max + k + 1])) ? v[max + k + 1] : v[max + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) { x++; y++; }
      v[max + k] = x;
      if (x >= n && y >= m) { found = true; break; }
    }
    if (d > 4000) return null; // too different to be worth marking
  }
  // Walk back to collect the edit script.
  const edits = [];
  let x = n, y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const vd = trace[d];
    const k = x - y;
    const prevK = (k === -d || (k !== d && vd[max + k - 1] < vd[max + k + 1])) ? k + 1 : k - 1;
    const px = vd[max + prevK];
    const py = px - prevK;
    while (x > px && y > py) { x--; y--; }
    if (x === px) edits.push({ type: 'ins', a: x, b: py });
    else edits.push({ type: 'del', a: px, b: y });
    x = px; y = py;
  }
  edits.reverse();
  const hunks = [];
  for (const e of edits) {
    const last = hunks[hunks.length - 1];
    const a = e.type === 'del' ? e.a : e.a;
    const b = e.type === 'ins' ? e.b : e.b;
    if (last && last.a + last.aLen === a && last.b + last.bLen === b) {
      if (e.type === 'del') last.aLen++; else last.bLen++;
    } else {
      hunks.push({ a, aLen: e.type === 'del' ? 1 : 0, b, bLen: e.type === 'ins' ? 1 : 0 });
    }
  }
  return hunks;
}
