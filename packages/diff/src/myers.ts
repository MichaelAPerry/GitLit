export type Op = { kind: "equal" | "delete" | "insert"; a?: number; b?: number };

/**
 * Myers greedy diff, O(ND). Well suited to manuscript revision, where the edit
 * distance D is small relative to the document even for a long book.
 * Falls back to a plain replace if the edit script would be pathological.
 */
export function diffSequences<T>(a: T[], b: T[], eq: (x: T, y: T) => boolean): Op[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) return [];

  const LIMIT = 4_000_000;
  if (n * m > LIMIT && Math.abs(n - m) > 2000) {
    return [
      ...a.map((_, i) => ({ kind: "delete" as const, a: i })),
      ...b.map((_, i) => ({ kind: "insert" as const, b: i })),
    ];
  }

  const offset = max;
  const v = new Int32Array(2 * max + 1);
  const trace: Int32Array[] = [];

  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) x = v[offset + k + 1]!;
      else x = v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && eq(a[x]!, b[y]!)) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, n, m, offset, d);
    }
  }
  return [];
}

function backtrack<T>(
  trace: Int32Array[], _a: T[], _b: T[], n: number, m: number, offset: number, d: number,
): Op[] {
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let dd = d; dd > 0; dd--) {
    const v = trace[dd]!;
    const k = x - y;
    let prevK: number;
    if (k === -dd || (k !== dd && v[offset + k - 1]! < v[offset + k + 1]!)) prevK = k + 1;
    else prevK = k - 1;
    const prevX = v[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push({ kind: "equal", a: --x, b: --y }); }
    if (dd > 0) {
      if (x === prevX) ops.push({ kind: "insert", b: --y });
      else ops.push({ kind: "delete", a: --x });
    }
  }
  while (x > 0 && y > 0) ops.push({ kind: "equal", a: --x, b: --y });
  while (x > 0) ops.push({ kind: "delete", a: --x });
  while (y > 0) ops.push({ kind: "insert", b: --y });
  return ops.reverse();
}
