import type { LeafSourceMap } from "./render.js";

/** Count source-map-preserving decompositions, stopping as soon as ambiguity is proven. */
export function mapMarkdownEdit(
  original: Uint8Array,
  next: string,
  ranges: readonly LeafSourceMap[],
) {
  if (Buffer.byteLength(next) > 8 * 1024 * 1024 || next.includes("\0"))
    throw new Error("archive-markdown-invalid");
  const old = Buffer.from(original),
    ordered = [...ranges].sort((a, b) => a.start_utf8 - b.start_utf8),
    before = ordered.length
      ? old.subarray(0, ordered[0]!.start_utf8).toString("utf8")
      : old.toString("utf8");
  const conflict = () => ({
    status: "mapping-conflict" as const,
    code: "archive-markdown-mapping-conflict",
    leaf_ids: ordered.map((r) => r.leaf_id).slice(0, 200),
  });
  if (old.toString("utf8") === next)
    return { status: "mapped" as const, changes: [] };
  const oldText = old.toString("utf8");
  let prefix = 0,
    suffix = 0;
  while (
    prefix < oldText.length &&
    prefix < next.length &&
    oldText[prefix] === next[prefix]
  )
    prefix++;
  while (
    suffix < oldText.length - prefix &&
    suffix < next.length - prefix &&
    oldText[oldText.length - 1 - suffix] === next[next.length - 1 - suffix]
  )
    suffix++;
  const from = Buffer.byteLength(oldText.slice(0, prefix)),
    through = Buffer.byteLength(oldText.slice(0, oldText.length - suffix));
  const local = ordered.filter(
    (r) => r.start_utf8 <= from && r.end_utf8 >= through,
  );
  if (local.length === 1) {
    const r = local[0]!,
      start = old.subarray(0, r.start_utf8).toString("utf8").length,
      end = old.subarray(0, r.end_utf8).toString("utf8").length;
    return {
      status: "mapped" as const,
      changes: [
        {
          leaf_id: r.leaf_id,
          text: next.slice(start, next.length - (oldText.length - end)),
        },
      ],
    };
  }
  if (!ordered.length || ordered.length > 1000 || !next.startsWith(before))
    return conflict();
  const delimiters = ordered.map((r, i) =>
    old
      .subarray(r.end_utf8, ordered[i + 1]?.start_utf8 ?? old.length)
      .toString("utf8"),
  );
  let work = 0;
  const memo = new Map<string, { count: number; values: string[] }>();
  const visit = (
    index: number,
    start: number,
  ): { count: number; values: string[] } => {
    if (++work > 200000) return { count: 2, values: [] };
    const key = `${index}:${start}`,
      cached = memo.get(key);
    if (cached) return cached;
    const delimiter = delimiters[index]!;
    if (index === ordered.length - 1) {
      const end = next.length - delimiter.length;
      return end >= start && next.endsWith(delimiter)
        ? { count: 1, values: [next.slice(start, end)] }
        : { count: 0, values: [] };
    }
    // A changed run crossing two merged payloads has no unique boundary.
    if (delimiter.length === 0) return { count: 2, values: [] };
    let at = next.indexOf(delimiter, start),
      count = 0,
      values: string[] = [];
    while (at >= 0) {
      const tail = visit(index + 1, at + delimiter.length);
      if (tail.count) {
        count += tail.count;
        values = [next.slice(start, at), ...tail.values];
        if (count > 1) break;
      }
      at = next.indexOf(delimiter, at + 1);
    }
    const result = { count: Math.min(2, count), values };
    memo.set(key, result);
    return result;
  };
  const mapped = visit(0, before.length);
  if (mapped.count !== 1) return conflict();
  return {
    status: "mapped" as const,
    changes: ordered.flatMap((r, i) =>
      old.subarray(r.start_utf8, r.end_utf8).toString("utf8") ===
      mapped.values[i]
        ? []
        : [{ leaf_id: r.leaf_id, text: mapped.values[i]! }],
    ),
  };
}
