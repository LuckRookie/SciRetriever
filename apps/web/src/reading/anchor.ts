/**
 * Reading anchors (spec "reading experience" 4.1–4.3), as plain arithmetic on
 * boxes so they can be tested without a browser. A box is in viewport pixels;
 * a region is a PDF page area in thousandths of the page, [x0, y0, x1, y1].
 */

/**
 * The reading line: this share of the visible reading area's height, measured
 * from its upper edge. Until the new layout the edge is the scroll area's top
 * (spec 10); afterwards the header rule (spec 4.1). Only the edge changes.
 */
export const READING_LINE = 0.28;
export interface Area {
  readonly top: number;
  readonly height: number;
}
export const readingLine = (area: Area, share = READING_LINE) =>
  area.top + area.height * share;

export interface Box {
  readonly top: number;
  readonly bottom: number;
}
/**
 * The block the line crosses; between two blocks the lower one; above every
 * block the first; below every block the last. -1 when there are no blocks.
 * Blocks are in reading order, so the search halves.
 */
export function anchorIndex(blocks: readonly Box[], line: number): number {
  if (!blocks.length) return -1;
  let low = 0,
    high = blocks.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (blocks[mid]!.bottom > line) high = mid;
    else low = mid + 1;
  }
  return Math.min(low, blocks.length - 1);
}
/** Where the line falls inside the block, from its top: 0–1. */
export function anchorRatio(block: Box, line: number): number {
  const height = Math.max(1, block.bottom - block.top);
  return Math.min(1, Math.max(0, (line - block.top) / height));
}
/** The scroll needed to put the block's `ratio` point back on the line. */
export function placeDelta(block: Box, ratio: number, line: number): number {
  return block.top + ratio * (block.bottom - block.top) - line;
}

/** A full-text block as the reading position knows it. */
export interface TextBlock {
  /** UTF-8 offset where the block starts in its document version. */
  readonly start: number;
  /** One-based PDF page the block came from, when known. */
  readonly page: number | null;
  readonly region: readonly [number, number, number, number] | null;
}
export interface PdfPlace {
  readonly page: number;
  /** Vertical place on the page, 0–1. */
  readonly ratio: number;
  /** False when the block had no page and an earlier block's page was used. */
  readonly exact: boolean;
}
/**
 * Full text → PDF (spec 4.3): the block's page and the top of its region,
 * which goes on the reading line (spec 8.2 measures that top edge); a block
 * without a page stops at the nearest earlier block that has one, at the
 * bottom of its region. Null when no earlier block has a page.
 */
export function textToPdf(
  blocks: readonly TextBlock[],
  index: number,
): PdfPlace | null {
  const block = blocks[index];
  if (block?.page != null)
    return {
      page: block.page,
      ratio: (block.region?.[1] ?? 0) / 1000,
      exact: true,
    };
  for (let i = Math.min(index, blocks.length) - 1; i >= 0; i--) {
    const before = blocks[i]!;
    if (before.page != null)
      return {
        page: before.page,
        ratio: (before.region?.[3] ?? 1000) / 1000,
        exact: false,
      };
  }
  return null;
}
export interface TextPlace {
  /** Index of the block in the list given. */
  readonly index: number;
  readonly ratio: number;
  readonly exact: boolean;
}
/**
 * PDF → full text (spec 4.3): the block on that page whose region covers the
 * place; else the last block on the page that starts above it; a page without
 * blocks stops at the nearest earlier page's last block. Null when nothing on
 * or before the page has a page.
 */
export function pdfToText(
  blocks: readonly TextBlock[],
  page: number,
  ratio: number,
): TextPlace | null {
  const y = Math.min(1, Math.max(0, ratio)) * 1000;
  let above = -1,
    first = -1;
  for (const [i, block] of blocks.entries()) {
    if (block.page !== page) continue;
    if (first < 0) first = i;
    const [, y0, , y1] = block.region ?? [0, 0, 1000, 1000];
    if (y >= y0 && y <= y1)
      return {
        index: i,
        ratio: y1 > y0 ? (y - y0) / (y1 - y0) : 0,
        exact: true,
      };
    if (y0 <= y) above = i;
  }
  if (above >= 0) return { index: above, ratio: 1, exact: true };
  if (first >= 0) return { index: first, ratio: 0, exact: true };
  let earlier = -1;
  for (const [i, block] of blocks.entries())
    if (block.page != null && block.page < page) earlier = i;
  return earlier >= 0 ? { index: earlier, ratio: 1, exact: false } : null;
}

/**
 * A remembered offset in a new text version (spec 4.5): the block that starts
 * at or before it. -1 when the offset lies past the new text: open from the top.
 */
export function nearestBlock(
  starts: readonly number[],
  offset: number,
  end: number,
): number {
  if (!starts.length || offset >= end) return -1;
  let low = 0,
    high = starts.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (starts[mid]! <= offset) low = mid + 1;
    else high = mid;
  }
  return Math.max(0, low - 1);
}
