import type {
  ArrangementSourceBlock,
  PageRegion,
} from "@sciretriever/contracts";
export const READING_ORDER_ENABLED = false;
/** Conservative columns: at least three aligned text boxes per column and a visible gutter. */
export function pageColumns(
  blocks: readonly { region_hint: PageRegion | null; type: string }[],
): readonly { left: number; right: number }[] {
  const boxes = blocks
    .filter(
      (b) =>
        ["text", "reference"].includes(b.type) &&
        b.region_hint &&
        b.region_hint[2] - b.region_hint[0] >= 150 &&
        b.region_hint[2] - b.region_hint[0] <= 560,
    )
    .map((b) => b.region_hint!)
    .sort((a, b) => a[0] - b[0]);
  const clusters: PageRegion[][] = [];
  for (const b of boxes) {
    const c = clusters.find(
      (c) => Math.abs(c[0]![0] - b[0]) < 45 && Math.abs(c[0]![2] - b[2]) < 60,
    );
    if (c) c.push(b);
    else clusters.push([b]);
  }
  const cols = clusters
    .filter((c) => c.length >= 3)
    .map((c) => ({
      left: Math.min(...c.map((b) => b[0])),
      right: Math.max(...c.map((b) => b[2])),
    }));
  if (
    cols.length < 2 ||
    cols.length > 3 ||
    cols.some((c, i) => i > 0 && c.left - cols[i - 1]!.right < 12)
  )
    return [];
  return cols;
}
export function columnFor(
  box: PageRegion | null,
  columns: ReturnType<typeof pageColumns>,
) {
  if (!box) return null;
  const hits = columns.flatMap((c, i) =>
    box[0] >= c.left - 30 && box[2] <= c.right + 30 ? [i] : [],
  );
  return hits.length === 1 ? hits[0]! : null;
}
/** Explicitly gated. Full-width blocks partition bands; ambiguous pages keep their source order. */
export function correctReadingOrder(
  blocks: readonly ArrangementSourceBlock[],
  enabled = READING_ORDER_ENABLED,
): readonly ArrangementSourceBlock[] {
  if (!enabled) return blocks;
  const pages = new Map<number, ArrangementSourceBlock[]>();
  for (const b of blocks) {
    const p = pages.get(b.page_hint) ?? [];
    p.push(b);
    pages.set(b.page_hint, p);
  }
  return [...pages]
    .sort((a, b) => a[0] - b[0])
    .flatMap(([, page]) => {
      const cols = pageColumns(page);
      if (!cols.length || page.some((b) => !b.region_hint)) return page;
      const result = [...page];
      const anchors = page
        .filter(
          (b) =>
            ["title", "text", "equation"].includes(b.type) &&
            columnFor(b.region_hint, cols) === null,
        )
        .map((b) => b.region_hint![1])
        .sort((a, b) => a - b);
      const bands = new Map<number, number[]>();
      page.forEach((b, i) => {
        if (
          ![
            "text",
            "list",
            "reference",
            "image",
            "table",
            "caption",
            "footnote",
          ].includes(b.type) ||
          columnFor(b.region_hint, cols) === null
        )
          return;
        const band = anchors.filter((y) => y < b.region_hint![1]).length,
          indices = bands.get(band) ?? [];
        indices.push(i);
        bands.set(band, indices);
      });
      for (const indices of bands.values()) {
        const items = indices.map((i) => page[i]!);
        const flow = items.filter((b) =>
          ["text", "list", "reference"].includes(b.type),
        );
        const contradictory = flow.some(
          (b, i) =>
            i > 0 &&
            columnFor(b.region_hint, cols)! <
              columnFor(flow[i - 1]!.region_hint, cols)!,
        );
        if (!contradictory) continue;
        flow.sort(
          (a, b) =>
            columnFor(a.region_hint, cols)! - columnFor(b.region_hint, cols)! ||
            a.region_hint![1] - b.region_hint![1],
        );
        for (const f of items
          .filter((b) => !flow.includes(b))
          .sort((a, b) => a.region_hint![1] - b.region_hint![1])) {
          let prior = -1;
          flow.forEach((b, i) => {
            if (
              columnFor(b.region_hint, cols) ===
                columnFor(f.region_hint, cols) &&
              b.region_hint![1] <= f.region_hint![1]
            )
              prior = i;
          });
          flow.splice(prior < 0 ? 0 : prior + 1, 0, f);
        }
        indices.forEach((at, i) => {
          result[at] = flow[i]!;
        });
      }
      return result;
    });
}
