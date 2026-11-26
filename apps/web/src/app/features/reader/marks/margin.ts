/**
 * The right margin's notes (reading-experience 2.5 “页边的避让”): in reading
 * order, top to bottom, at least 10 px apart; a note pushed more than 120 px
 * from its line shows its first line only. Pure, for spec 8.1 “标记”.
 */
export const MARGIN = { gap: 10, far: 120 } as const;
export interface MarginItem {
  id: string;
  /** Where its line is: the top the note wants. */
  want: number;
  height: number;
  /** Its height folded to the first line, when pushed too far. */
  firstLine: number;
}
export interface MarginPlace {
  id: string;
  top: number;
  want: number;
  folded: boolean;
}
/**
 * `taken`: stretches of the margin something else stands in (the machine's
 * notes of an annotated copy, ADR 0070): a reader's note goes below them.
 */
export function layoutMargin(
  items: readonly MarginItem[],
  taken: readonly { top: number; bottom: number }[] = [],
): MarginPlace[] {
  const sorted = [...items].sort((a, b) => a.want - b.want);
  const blocks = [...taken].sort((a, b) => a.top - b.top);
  const out: MarginPlace[] = [];
  let bottom = -Infinity;
  for (const item of sorted) {
    let top = Math.max(item.want, bottom + MARGIN.gap);
    for (const block of blocks)
      if (
        top < block.bottom + MARGIN.gap &&
        top + item.height > block.top - MARGIN.gap
      )
        top = block.bottom + MARGIN.gap;
    const folded = top - item.want > MARGIN.far;
    out.push({ id: item.id, top, want: item.want, folded });
    bottom = top + (folded ? item.firstLine : item.height);
  }
  return out;
}
