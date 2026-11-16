/**
 * The spine (reading-experience 1.5): the whole paper in one strip beside
 * the sheet. Pure arithmetic on “units” — UTF-8 bytes of the version read in
 * the full text, pages in the PDF — so the mapping can be checked without a
 * browser (spec 8.1 “书脊映射”).
 */
export const SPINE = {
  /** Padding above and below the segments. */
  pad: 6,
  /** Between two segments. */
  gap: 3,
  /** The shortest segment. */
  min: 3,
  /** Ticks closer than this become one. */
  merge: 3,
} as const;

export interface SpinePart {
  /** “4 讨论”: what the hover says. */
  label: string;
  start: number;
  end: number;
}
export interface SpineSegment extends SpinePart {
  index: number;
  top: number;
  height: number;
}
/**
 * The parts of the full text: one per top-level heading (the abstract its
 * own), what comes before the first in the first part; one part without
 * headings. Lengths are the parts' bytes, never their laid-out height.
 */
export function textParts(
  entries: readonly {
    title: string | null;
    role?: string | null;
    level: number;
    start?: number;
    end?: number;
  }[],
  total: number,
): SpinePart[] {
  const located = entries.filter(
    (entry): entry is typeof entry & { start: number } =>
      typeof entry.start === "number",
  );
  const top = Math.min(...located.map((entry) => entry.level));
  const heads = located.filter(
    (entry) => entry.level === top || entry.role === "abstract",
  );
  const end = Math.max(
    total,
    ...located.map((entry) => entry.end ?? entry.start),
  );
  if (!heads.length || end <= 0)
    return [{ label: "", start: 0, end: Math.max(end, 1) }];
  return heads.map((head, index) => ({
    label: head.title ?? "",
    start: index === 0 ? 0 : head.start,
    end: heads[index + 1]?.start ?? end,
  }));
}
/**
 * The PDF (spec 1.5): each part from the page of its top-level heading (the
 * abstract its own) to the page of the next, the pages taken from the
 * parsed text's blocks; one part when there is no parsed text.
 */
export function pdfParts(
  sections: readonly {
    title: string | null;
    role?: string | null;
    level: number;
    page: number | null;
  }[],
  pages: number,
): SpinePart[] {
  const total = Math.max(1, pages);
  const located = sections.filter(
    (s): s is typeof s & { page: number } => typeof s.page === "number",
  );
  const top = Math.min(...located.map((s) => s.level));
  const heads = located.filter((s) => s.level === top || s.role === "abstract");
  if (!heads.length) return pageParts(total);
  return heads.map((head, index) => ({
    label: head.title ?? "",
    start: index === 0 ? 0 : Math.min(total, head.page - 1),
    end: Math.min(total, (heads[index + 1]?.page ?? total + 1) - 1),
  }));
}
/** The PDF without parsed text: one part, its pages. */
export const pageParts = (pages: number): SpinePart[] => [
  { label: "", start: 0, end: Math.max(1, pages) },
];
/**
 * Segments on a spine `height` px tall: proportional to their length, the
 * shortest 3 px (taken from the others in proportion), 3 px apart.
 */
export function spineSegments(
  parts: readonly SpinePart[],
  height: number,
): SpineSegment[] {
  const room = Math.max(
    0,
    height - 2 * SPINE.pad - SPINE.gap * Math.max(0, parts.length - 1),
  );
  const lengths = parts.map((part) => Math.max(0, part.end - part.start));
  const total = lengths.reduce((sum, value) => sum + value, 0) || 1;
  let sizes = lengths.map((value) => (room * value) / total);
  // Short parts get the minimum; the others give it up in proportion.
  const short = sizes.map((size) => size < SPINE.min);
  const deficit = sizes.reduce(
    (sum, size, i) => sum + (short[i] ? SPINE.min - size : 0),
    0,
  );
  const rest = sizes.reduce((sum, size, i) => sum + (short[i] ? 0 : size), 0);
  if (deficit > 0 && rest > 0)
    sizes = sizes.map((size, i) =>
      short[i] ? SPINE.min : size - (deficit * size) / rest,
    );
  let top = SPINE.pad;
  return parts.map((part, index) => {
    const segment = { ...part, index, top, height: sizes[index]! };
    top += sizes[index]! + SPINE.gap;
    return segment;
  });
}
/** Where `unit` lies on the spine: inside its part, in proportion. */
export function spineY(segments: readonly SpineSegment[], unit: number) {
  if (!segments.length) return 0;
  const segment =
    segments.find((s) => unit < s.end) ?? segments[segments.length - 1]!;
  const length = Math.max(1, segment.end - segment.start);
  const within = Math.max(0, Math.min(1, (unit - segment.start) / length));
  return segment.top + within * segment.height;
}
/** The window over what shows, from the first to the last unit on screen. */
export function spineWindow(
  segments: readonly SpineSegment[],
  from: number,
  to: number,
) {
  const top = spineY(segments, from),
    bottom = spineY(segments, Math.max(from, to));
  return { top, height: Math.max(2, bottom - top) };
}
export type TickKind = "mark" | "find";
export interface SpineTick {
  y: number;
  kind: TickKind;
  /** The marks drawn here, for hovering and opening one. */
  ids: string[];
}
/** Ticks closer than 3 px become one; a find hit outranks a mark (spec 1.5). */
export function spineTicks(
  segments: readonly SpineSegment[],
  items: readonly { unit: number; kind: TickKind; id?: string }[],
): SpineTick[] {
  const placed = items
    .map((item) => ({ ...item, y: spineY(segments, item.unit) }))
    .sort((a, b) => a.y - b.y);
  const ticks: SpineTick[] = [];
  for (const item of placed) {
    const last = ticks.at(-1);
    if (last && item.y - last.y < SPINE.merge) {
      if (item.kind === "find") last.kind = "find";
      if (item.id) last.ids.push(item.id);
      continue;
    }
    ticks.push({ y: item.y, kind: item.kind, ids: item.id ? [item.id] : [] });
  }
  return ticks;
}
/** The hover's side: right of the spine when the desk leaves room, else left. */
export function tipSide(roomRight: number, tipWidth: number) {
  return roomRight >= tipWidth + 16 ? "right" : "left";
}
