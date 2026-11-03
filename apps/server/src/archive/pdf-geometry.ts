import type { PageRegion, PdfBlockGeometry } from "@sciretriever/contracts";
import type { PdfPageInspection } from "../browser/pdf-region.js";
const median = (xs: readonly number[]) =>
  [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
/** Measure visible horizontal glyph runs in PDF points, never in a fictitious 1000x1000 page. */
export function measurePdfBlock(
  box: PageRegion | null,
  page: PdfPageInspection | undefined,
  rawSize: readonly [number, number] | undefined,
  columnBox: PageRegion | null = box,
): PdfBlockGeometry | undefined {
  const layout = page?.layout;
  if (
    !box ||
    page?.kind !== "text-layer" ||
    page.hidden_glyphs ||
    !layout ||
    !rawSize ||
    Math.abs(layout.width / layout.height / (rawSize[0] / rawSize[1]) - 1) >
      0.02 ||
    layout.items.length > 20000
  )
    return;
  const [x0, y0, x1, y1] = box;
  const items = layout.items
    .filter((i) => {
      const [a, b, c, d] = i.bbox,
        x = ((a + c) / 2 / layout.width) * 1000,
        y = ((b + d) / 2 / layout.height) * 1000;
      return x >= x0 - 4 && x <= x1 + 4 && y >= y0 - 4 && y <= y1 + 4;
    })
    .sort((a, b) => a.bbox[3] - b.bbox[3] || a.bbox[0] - b.bbox[0]);
  if (!items.length) return;
  const lines: {
    left: number;
    right: number;
    bottom: number;
    height: number;
  }[] = [];
  for (const i of items) {
    const [a, b, c, d] = i.bbox,
      h = d - b;
    const prior = lines.at(-1);
    if (
      prior &&
      Math.abs(d - prior.bottom) <=
        Math.max(0.5, Math.min(h, prior.height) * 0.45)
    ) {
      prior.left = Math.min(prior.left, a);
      prior.right = Math.max(prior.right, c);
      prior.height = Math.max(prior.height, h);
    } else lines.push({ left: a, right: c, bottom: d, height: h });
  }
  const blockLeft = Math.min(...lines.map((l) => l.left)),
    blockRight = Math.max(...lines.map((l) => l.right)),
    height = median(lines.map((l) => l.height)),
    fontSize = median(items.map((i) => i.font_size));
  if (!(blockRight > blockLeft && height > 0)) return;
  // A one-line fragment is not automatically a full column. The column's
  // envelope comes from other visible PDF runs of the same body size.
  const columnItems = layout.items.filter(
    (i) =>
      columnBox &&
      Math.abs(i.font_size - fontSize) <= Math.max(0.5, fontSize * 0.15) &&
      i.bbox[0] >= (columnBox[0] / 1000) * layout.width - 2 &&
      i.bbox[2] <= (columnBox[2] / 1000) * layout.width + 2,
  );
  const left = columnItems.length
      ? Math.min(blockLeft, ...columnItems.map((i) => i.bbox[0]))
      : blockLeft,
    right = columnItems.length
      ? Math.max(blockRight, ...columnItems.map((i) => i.bbox[2]))
      : blockRight,
    width = right - left;
  const fonts = new Map<string, number>();
  for (const i of items) fonts.set(i.font, (fonts.get(i.font) ?? 0) + i.length);
  return {
    line_count: lines.length,
    line_height: height,
    first_indent: (lines[0]!.left - left) / height,
    last_line_fill: Math.min(2, (lines.at(-1)!.right - left) / width),
    font_size: fontSize,
    font: [...fonts].sort((a, b) => b[1] - a[1])[0]![0],
  };
}
