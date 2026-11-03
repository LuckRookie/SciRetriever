import type { ArrangementLeaf, LeafDestination } from "@sciretriever/contracts";
import type { ArchiveTextSource } from "./text-source.js";
import { pageColumns, columnFor } from "./reading-order.js";
const terminal = /[.?!:;。？！：；]["'”’»)\]）】]*$/u;
const label =
  /^(?:\(?(?:[a-zA-Z]|\d{1,3})[.)]\s|[•●▪*-]\s|(?:fig(?:ure)?\.?|table|scheme|chart)\s*\d+[a-z]?[.:]|\[\d+\]|\d+\.\s)/iu;
export function paragraphBreakEvidence(
  source: ArchiveTextSource,
  leaves: readonly ArrangementLeaf[],
  destinations: ReadonlyMap<string, LeafDestination>,
) {
  const roots = new Map(source.blocks.map((b) => [b.root_block_id, b]));
  const geometry = (l: ArrangementLeaf) => {
    const root = roots.get(l.source.root_block_id);
    return root &&
      root.page_hint === l.page_index &&
      l.source.start === 0 &&
      l.source.end === [...root.text].length
      ? root.pdf_geometry
      : undefined;
  };
  const body = (l: ArrangementLeaf) => {
    const d = destinations.get(l.leaf_id);
    return (
      d?.kind === "assigned" &&
      d.presentation.kind === "content" &&
      [
        "introduction",
        "methods",
        "results-discussion",
        "conclusion",
        "additional",
      ].includes(d.target.role)
    );
  };
  const prose = (l: ArrangementLeaf) =>
    body(l) &&
    l.type === "text" &&
    !label.test(l.original_text.trimStart()) &&
    !/^(?:https?:|doi:|\S+@)/iu.test(l.original_text.trimStart());
  const measured = leaves.filter(
    (l) => prose(l) && (geometry(l)?.line_count ?? 0) >= 3,
  );
  const indented =
    measured.length >= 5 &&
    measured.filter((l) => (geometry(l)?.first_indent ?? 0) > 0.8).length /
      measured.length >=
      0.6;
  const byPage = new Map<number, ArrangementLeaf[]>();
  for (const l of leaves.filter(prose)) {
    const p = byPage.get(l.page_index) ?? [];
    p.push(l);
    byPage.set(l.page_index, p);
  }
  const columns = new Map(
    [...byPage].map(([page, ls]) => [
      page,
      pageColumns(ls.map((l) => ({ type: l.type, region_hint: l.region }))),
    ]),
  );
  const boundary = (
    left: ArrangementLeaf,
    right: ArrangementLeaf,
    skipped: readonly ArrangementLeaf[],
  ): "page" | "column" | "float" | null => {
    const a = byPage.get(left.page_index) ?? [],
      b = byPage.get(right.page_index) ?? [];
    if (
      right.page_index === left.page_index + 1 &&
      a.at(-1) === left &&
      b[0] === right
    )
      return "page";
    if (left.page_index !== right.page_index) return null;
    const lb = left.region,
      rb = right.region;
    // A short column may have fewer than three paragraphs, so test its actual
    // gutter and first/last body positions independently of full-page clustering.
    if (
      lb &&
      rb &&
      lb[2] + 12 < rb[0] &&
      lb[2] - lb[0] > 150 &&
      rb[2] - rb[0] > 150 &&
      Math.abs((lb[2] - lb[0]) / (rb[2] - rb[0]) - 1) < 0.35 &&
      a.every(
        (l) =>
          !l.region ||
          l === left ||
          l.region[0] >= lb[2] ||
          l.region[2] <= lb[0] ||
          l.region[1] < lb[1],
      ) &&
      a.every(
        (l) =>
          !l.region ||
          l === right ||
          l.region[0] >= rb[2] ||
          l.region[2] <= rb[0] ||
          l.region[1] > rb[1],
      )
    )
      return "column";
    const cols = columns.get(left.page_index) ?? [],
      lc = columnFor(left.region, cols),
      rc = columnFor(right.region, cols);
    if (
      lc !== null &&
      rc === lc + 1 &&
      a.filter((l) => columnFor(l.region, cols) === lc).at(-1) === left &&
      a.find((l) => columnFor(l.region, cols) === rc) === right
    )
      return "column";
    if (
      skipped.some(
        (l) =>
          destinations.get(l.leaf_id)?.kind !== "dropped" &&
          ["image", "table", "caption", "footnote"].includes(l.type),
      )
    )
      return "float";
    return null;
  };
  return (
    left: ArrangementLeaf,
    right: ArrangementLeaf,
    skipped: readonly ArrangementLeaf[],
  ) => {
    const a = left.original_text.trimEnd(),
      b = right.original_text.trimStart(),
      at = boundary(left, right, skipped);
    const unfinished = !terminal.test(a),
      hyphen = /\p{L}-$/u.test(a) && /^\p{Ll}/u.test(b);
    const automatic =
      !!at &&
      prose(left) &&
      prose(right) &&
      (hyphen || (unfinished && /^\p{Ll}/u.test(b)));
    const g = geometry(left),
      h = geometry(right);
    const layout = !!(
      terminal.test(a) &&
      !/[:;：；]["'”’»)\]）】]*$/u.test(a) &&
      indented &&
      prose(left) &&
      prose(right) &&
      (at === "page" || at === "column") &&
      g &&
      h &&
      g.last_line_fill >= 0.93 &&
      h.first_indent < 0.3
    );
    return {
      candidate: a.length > 0 && b.length > 0 && (unfinished || layout),
      basis: layout ? ("layout" as const) : ("text" as const),
      boundary: at,
      automatic,
    };
  };
}
