/**
 * Ratcliff/Obershelp matching as in Python's difflib.SequenceMatcher without junk
 * heuristics: the longest common run first, then the same on each side of it.
 */
export interface MatchingBlock {
  readonly a: number;
  readonly b: number;
  readonly size: number;
}
export type Opcode = readonly [
  "equal" | "replace" | "delete" | "insert",
  number,
  number,
  number,
  number,
];

export function matchingBlocks<T>(
  a: readonly T[],
  b: readonly T[],
): readonly MatchingBlock[] {
  const where = new Map<T, number[]>();
  b.forEach((item, j) => {
    const list = where.get(item);
    if (list) list.push(j);
    else where.set(item, [j]);
  });
  const longest = (alo: number, ahi: number, blo: number, bhi: number) => {
    let besti = alo,
      bestj = blo,
      bestsize = 0;
    let lengths = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const next = new Map<number, number>();
      for (const j of where.get(a[i]!) ?? []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (lengths.get(j - 1) ?? 0) + 1;
        next.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
      lengths = next;
    }
    return { a: besti, b: bestj, size: bestsize };
  };
  const found: MatchingBlock[] = [];
  const queue: [number, number, number, number][] = [
    [0, a.length, 0, b.length],
  ];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop()!;
    const m = longest(alo, ahi, blo, bhi);
    if (!m.size) continue;
    found.push(m);
    if (alo < m.a && blo < m.b) queue.push([alo, m.a, blo, m.b]);
    if (m.a + m.size < ahi && m.b + m.size < bhi)
      queue.push([m.a + m.size, ahi, m.b + m.size, bhi]);
  }
  found.sort((x, y) => x.a - y.a || x.b - y.b);
  const merged: MatchingBlock[] = [];
  for (const m of found) {
    const last = merged.at(-1);
    if (last && last.a + last.size === m.a && last.b + last.size === m.b)
      merged[merged.length - 1] = {
        a: last.a,
        b: last.b,
        size: last.size + m.size,
      };
    else merged.push(m);
  }
  return merged;
}

export function opcodes<T>(
  a: readonly T[],
  b: readonly T[],
): readonly Opcode[] {
  const out: Opcode[] = [];
  let i = 0,
    j = 0;
  for (const m of [
    ...matchingBlocks(a, b),
    { a: a.length, b: b.length, size: 0 },
  ]) {
    const tag =
      i < m.a && j < m.b
        ? "replace"
        : i < m.a
          ? "delete"
          : j < m.b
            ? "insert"
            : null;
    if (tag) out.push([tag, i, m.a, j, m.b]);
    if (m.size) out.push(["equal", m.a, m.a + m.size, m.b, m.b + m.size]);
    i = m.a + m.size;
    j = m.b + m.size;
  }
  return out;
}

/** 2·matches / total length, as difflib's ratio(). */
export function similarity(a: string, b: string): number {
  const x = [...a],
    y = [...b];
  if (!x.length && !y.length) return 1;
  const matches = matchingBlocks(x, y).reduce((n, m) => n + m.size, 0);
  return (2 * matches) / (x.length + y.length);
}
