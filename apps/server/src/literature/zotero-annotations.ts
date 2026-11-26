import {
  MARK_LIMITS,
  type IntakeAnnotation,
  type IntakeAnnotationReason,
  type MarkColor,
  type MarkRect,
} from "@sciretriever/contracts";

/*
 * Zotero annotations as reading marks (literature materials 6.4.13). Pure
 * functions: an annotation in, a reason or a mark request out. Positions are
 * converted only through the page's own frame; nothing is guessed.
 */

/** Page frame: PDF user space to the reader's page space at scale 1, origin top-left. */
export interface PdfPageFrame {
  readonly width: number;
  readonly height: number;
  /** [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f. */
  readonly matrix: readonly [number, number, number, number, number, number];
}

/**
 * The frame of a page from its visible box (CropBox within MediaBox, in user
 * space) and its /Rotate, as pdf.js renders a viewport at scale 1 and MuPDF
 * computes a page transform: subtract the box offset, flip y, then rotate
 * clockwise by the page's rotation.
 */
export function pageFrame(
  box: readonly [number, number, number, number],
  rotate: number,
): PdfPageFrame {
  const x1 = Math.min(box[0], box[2]),
    x2 = Math.max(box[0], box[2]),
    y1 = Math.min(box[1], box[3]),
    y2 = Math.max(box[1], box[3]);
  const r = (((Math.round(rotate / 90) * 90) % 360) + 360) % 360;
  const w = x2 - x1,
    h = y2 - y1;
  const frame = (
    width: number,
    height: number,
    m: PdfPageFrame["matrix"],
  ): PdfPageFrame => ({
    width,
    height,
    // No negative zeros: frames compare equal however they were computed.
    matrix: m.map((n) => n + 0) as unknown as PdfPageFrame["matrix"],
  });
  switch (r) {
    case 90:
      return frame(h, w, [0, 1, 1, 0, -y1, -x1]);
    case 180:
      return frame(w, h, [-1, 0, 0, 1, x2, -y1]);
    case 270:
      return frame(h, w, [0, -1, -1, 0, y2, x2]);
    default:
      return frame(w, h, [1, 0, 0, -1, -x1, y2]);
  }
}

/** Rectangles may overrun the page edge by this much (points) before they count as outside it. */
const EDGE_TOLERANCE = 1;
const round = (n: number) => Math.round(n * 100) / 100;
/**
 * Zotero rectangles (corners in user space) as reading-mark rectangles
 * `[x, y, width, height]` on the page frame; null when any rectangle lies
 * outside the page or is empty.
 */
export function frameRects(
  rects: IntakeAnnotation["rects"],
  frame: PdfPageFrame,
): MarkRect[] | null {
  if (!rects.length || rects.length > MARK_LIMITS.rects) return null;
  const [a, b, c, d, e, f] = frame.matrix;
  const out: MarkRect[] = [];
  for (const rect of rects) {
    if (rect.length !== 4 || rect.some((n) => !Number.isFinite(n))) return null;
    const xs: number[] = [],
      ys: number[] = [];
    for (const [x, y] of [
      [rect[0], rect[1]],
      [rect[2], rect[3]],
    ] as const) {
      xs.push(a * x + c * y + e);
      ys.push(b * x + d * y + f);
    }
    let left = Math.min(...xs),
      top = Math.min(...ys),
      right = Math.max(...xs),
      bottom = Math.max(...ys);
    if (
      left < -EDGE_TOLERANCE ||
      top < -EDGE_TOLERANCE ||
      right > frame.width + EDGE_TOLERANCE ||
      bottom > frame.height + EDGE_TOLERANCE
    )
      return null;
    left = Math.max(0, left);
    top = Math.max(0, top);
    right = Math.min(frame.width, right);
    bottom = Math.min(frame.height, bottom);
    const width = round(right - left),
      height = round(bottom - top);
    if (
      width <= 0 ||
      height <= 0 ||
      right > MARK_LIMITS.coordinate ||
      bottom > MARK_LIMITS.coordinate
    )
      return null;
    out.push([round(left) + 0, round(top) + 0, width, height]);
  }
  return out;
}

/** Zotero's eight annotation colours and the five reading-mark colours they become. */
const PALETTE: readonly (readonly [number, number, number, MarkColor])[] = [
  [0xff, 0xd4, 0x00, "yellow"], // yellow
  [0xf1, 0x98, 0x37, "yellow"], // orange
  [0xff, 0x66, 0x66, "red"], // red
  [0x5f, 0xb2, 0x36, "green"], // green
  [0x2e, 0xa8, 0xe5, "blue"], // blue
  [0xaa, 0xaa, 0xaa, "blue"], // grey
  [0xa2, 0x8a, 0xe5, "purple"], // purple
  [0xe5, 0x6e, 0xee, "purple"], // magenta
];
/** The nearest Zotero colour decides; a colour that cannot be read becomes blue. */
export function markColor(value: string | null): MarkColor {
  const hex = value?.trim().toLowerCase() ?? "";
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/u.exec(hex);
  if (!match) return "blue";
  const digits =
    match[1]!.length === 3
      ? [...match[1]!].map((d) => d + d).join("")
      : match[1]!;
  const [r, g, b] = [0, 2, 4].map((i) =>
    Number.parseInt(digits.slice(i, i + 2), 16),
  ) as [number, number, number];
  let best = PALETTE[0]!,
    distance = Infinity;
  for (const entry of PALETTE) {
    const d = (entry[0] - r) ** 2 + (entry[1] - g) ** 2 + (entry[2] - b) ** 2;
    if (d < distance) {
      distance = d;
      best = entry;
    }
  }
  return best[3];
}

/** Reading-mark text refuses control characters other than line breaks and tabs. */
export function markText(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "");
}

/**
 * What can be decided before the file arrives: the kind, the comment, the
 * quote and the shape of the position. null when only the file can decide.
 */
export function annotationReason(
  annotation: IntakeAnnotation,
): IntakeAnnotationReason | null {
  if (!["highlight", "underline", "region"].includes(annotation.kind))
    return "unsupported-kind";
  if (markText(annotation.note).normalize("NFC").length > MARK_LIMITS.note)
    return "comment-too-long";
  if (annotation.kind !== "region") {
    const quote = markText(annotation.quote).normalize("NFC");
    if (!quote.trim() || quote.length > MARK_LIMITS.quote)
      return "quote-invalid";
  }
  if (
    annotation.coordinate_space !== "pdf-bottom-left" ||
    annotation.page_index === null ||
    !annotation.rects.length ||
    annotation.rects.length > MARK_LIMITS.rects ||
    annotation.rects.some(
      (r) => r.length !== 4 || r.some((n) => !Number.isFinite(n)),
    )
  )
    return "position-invalid";
  return null;
}

/** The reading-mark create request for an annotation on a PDF whose frames are known. */
export function annotationMarkRequest(
  annotation: IntakeAnnotation,
  target: {
    readonly literature_id: string;
    readonly sha256: string;
    readonly mark_id: string;
    readonly page_count: number;
    readonly frames: ReadonlyMap<number, PdfPageFrame>;
  },
): { readonly reason: IntakeAnnotationReason } | { readonly request: unknown } {
  const reason = annotationReason(annotation);
  if (reason) return { reason };
  const page = annotation.page_index!;
  const frame = target.frames.get(page);
  if (page >= target.page_count || !frame)
    return { reason: "position-invalid" };
  const rects = frameRects(annotation.rects, frame);
  if (!rects) return { reason: "position-invalid" };
  const region = annotation.kind === "region";
  return {
    request: {
      operation: "create",
      request: {
        mark_id: target.mark_id,
        literature_id: target.literature_id,
        kind: region ? "region" : "highlight",
        color: markColor(annotation.color),
        note: markText(annotation.note),
        quote: region ? "" : markText(annotation.quote).trim(),
        pdf: { sha256: target.sha256, page: page + 1, rects },
        document: null,
      },
    },
  };
}
