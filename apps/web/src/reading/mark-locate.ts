/**
 * Places a mark's quote in rendered text (a PDF text layer or the full-text
 * article), tolerant of how the two materials write the same words: spaces,
 * ligatures, dashes, quotes, line-end hyphens and markup are ignored, and a
 * near match is found by edit distance. Measured on real archived papers
 * (ADR 0046): sim >= 0.85 places a mark, 0.7-0.85 is shown as approximate.
 */
const DASH = /[‐-―−­﹣－-]/u;
function canonChar(ch: string): string {
  const c = ch.normalize("NFKC").toLowerCase();
  if (DASH.test(c)) return "-";
  if (/[‘’‚′`]/u.test(c)) return "'";
  if (/[“”„″]/u.test(c)) return '"';
  if (/\s/u.test(c) || /[*#$\\{}^_~|]/u.test(c)) return "";
  return c;
}
export function canon(text: string): string {
  let out = "";
  for (const ch of text) out += canonChar(ch);
  return out;
}
interface Indexed {
  readonly text: string;
  /** For each canonical char: the text node and offset it came from. */
  readonly nodes: Text[];
  readonly offsets: number[];
}
/** Canonical text of a subtree with a map back to DOM positions. */
export function indexText(
  root: Node,
  skip: (node: Text) => boolean = () => false,
): Indexed {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let text = "";
  const nodes: Text[] = [],
    offsets: number[] = [];
  for (
    let n = walker.nextNode() as Text | null;
    n;
    n = walker.nextNode() as Text | null
  ) {
    if (skip(n)) continue;
    const data = n.data;
    for (let i = 0; i < data.length; i++) {
      // A hyphen ending a PDF text-layer line is the break, not the word.
      if (
        i === data.length - 1 &&
        data[i] === "-" &&
        /[a-z]/iu.test(data[i - 1] ?? "") &&
        n.parentElement?.closest(".textLayer")
      )
        continue;
      const c = canonChar(data[i]!);
      for (const x of c) {
        text += x;
        nodes.push(n);
        offsets.push(i);
      }
    }
  }
  return { text, nodes, offsets };
}
/** Edit distance of `p` against the best-matching substring of `t`. */
function sellers(p: string, t: string): { dist: number; end: number } {
  const n = p.length;
  let prev = new Uint16Array(n + 1),
    cur = new Uint16Array(n + 1);
  for (let i = 0; i <= n; i++) prev[i] = i;
  let best = n,
    end = 0;
  for (let j = 1; j <= t.length; j++) {
    cur[0] = 0;
    const tc = t.charCodeAt(j - 1);
    for (let i = 1; i <= n; i++) {
      const sub = prev[i - 1]! + (p.charCodeAt(i - 1) === tc ? 0 : 1);
      cur[i] = Math.min(sub, prev[i]! + 1, cur[i - 1]! + 1);
    }
    if (cur[n]! < best) {
      best = cur[n]!;
      end = j;
    }
    [prev, cur] = [cur, prev];
  }
  return { dist: best, end };
}
const Q = 6;
export interface Located {
  readonly start: number;
  readonly end: number;
  readonly sim: number;
}
/** Best place of pattern `p` in `t`; exact hits are tie-broken by the surrounding words. */
export function locate(
  p: string,
  t: string,
  context: { prefix?: string; suffix?: string } = {},
): Located | null {
  if (!p) return null;
  const exact: number[] = [];
  for (
    let at = t.indexOf(p);
    at >= 0 && exact.length < 32;
    at = t.indexOf(p, at + 1)
  )
    exact.push(at);
  if (exact.length) {
    const prefix = canon(context.prefix ?? "").slice(-24),
      suffix = canon(context.suffix ?? "").slice(0, 24);
    const score = (at: number) =>
      (prefix && t.slice(Math.max(0, at - prefix.length), at) === prefix
        ? 1
        : 0) +
      (suffix &&
      t.slice(at + p.length, at + p.length + suffix.length) === suffix
        ? 1
        : 0);
    const at = exact.reduce(
      (best, x) => (score(x) > score(best) ? x : best),
      exact[0]!,
    );
    return { start: at, end: at + p.length, sim: 1 };
  }
  // Long quotes: place the head and the tail, which keeps the work small.
  if (p.length > 360) {
    const head = locate(p.slice(0, 160), t),
      tail = locate(p.slice(-160), t);
    if (
      !head ||
      !tail ||
      tail.end <= head.start ||
      tail.end - head.start > p.length * 1.5
    )
      return null;
    return {
      start: head.start,
      end: tail.end,
      sim: Math.min(head.sim, tail.sim),
    };
  }
  const votes = new Map<number, number>();
  const grams = new Map<string, number[]>();
  for (let i = 0; i + Q <= t.length; i++) {
    const g = t.slice(i, i + Q);
    let list = grams.get(g);
    if (!list) grams.set(g, (list = []));
    if (list.length < 48) list.push(i);
  }
  for (let k = 0; k + Q <= p.length; k += 2)
    for (const pos of grams.get(p.slice(k, k + Q)) ?? []) {
      const d = Math.round((pos - k) / 8);
      votes.set(d, (votes.get(d) ?? 0) + 1);
    }
  let best: Located | null = null;
  for (const [d] of [...votes.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)) {
    const a = Math.max(0, d * 8 - Math.ceil(p.length * 0.25) - 8),
      b = Math.min(t.length, d * 8 + Math.ceil(p.length * 1.25) + 8);
    const r = sellers(p, t.slice(a, b)),
      sim = 1 - r.dist / p.length;
    if (!best || sim > best.sim)
      best = { start: Math.max(a, a + r.end - p.length), end: a + r.end, sim };
  }
  return best;
}
/** A DOM range for canonical positions [start, end). */
export function rangeOf(
  index: Indexed,
  start: number,
  end: number,
): Range | null {
  const a = index.nodes[start],
    b = index.nodes[end - 1];
  if (!a || !b) return null;
  const range = document.createRange();
  range.setStart(a, index.offsets[start]!);
  range.setEnd(b, index.offsets[end - 1]! + 1);
  return range;
}
export const PLACE = 0.85,
  APPROXIMATE = 0.7;
