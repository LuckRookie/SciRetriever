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
export function layoutMargin(items: readonly MarginItem[]): MarginPlace[] {
  const sorted = [...items].sort((a, b) => a.want - b.want);
  const out: MarginPlace[] = [];
  let bottom = -Infinity;
  for (const item of sorted) {
    const top = Math.max(item.want, bottom + MARGIN.gap);
    const folded = top - item.want > MARGIN.far;
    out.push({ id: item.id, top, want: item.want, folded });
    bottom = top + (folded ? item.firstLine : item.height);
  }
  return out;
}
