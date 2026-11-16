import {
  ContractValidationError,
  parseAssetId,
  parseLiteratureId,
  parseUtcTimestamp,
} from "./index.js";
import { tagInteger, tagRecord, tagText } from "./tags.js";

/**
 * Reading marks (ADR 0046): a person's highlights, region captures and notes
 * on one paper. They are user data, never literature facts, and each one keeps
 * the quote it was made on so it can be placed again on another material.
 */
export const MARK_COLORS = [
  "yellow",
  "blue",
  "green",
  "red",
  "purple",
] as const;
export type MarkColor = (typeof MARK_COLORS)[number];
/** Default meanings; the colour itself is what is stored. */
export const MARK_COLOR_LABELS: Readonly<Record<MarkColor, string>> = {
  yellow: "重点",
  blue: "方法",
  green: "结论",
  red: "疑问",
  purple: "待查",
};
export const MARK_KINDS = ["highlight", "region"] as const;
export type MarkKind = (typeof MARK_KINDS)[number];
export const MARK_LIMITS = Object.freeze({
  quote: 4000,
  context: 200,
  note: 20000,
  rects: 400,
  coordinate: 20000,
});
/** Page-relative rectangles in PDF units at scale 1, top-left origin: [x, y, width, height]. */
export type MarkRect = readonly [number, number, number, number];
export interface MarkPdfAnchor {
  readonly sha256: string;
  readonly page: number;
  readonly rects: readonly MarkRect[];
}
export interface MarkDocumentAnchor {
  readonly document_version_id: string;
  readonly start_utf8: number;
  readonly end_utf8: number;
}
export const MARK_LOCATE_METHOD = "mark-locate-v1";
export type MarkTarget =
  | { readonly pdf: MarkPdfAnchor }
  | { readonly document: MarkDocumentAnchor };
export interface MarkPlace {
  readonly target: MarkTarget;
  readonly similarity: number;
  readonly method: string;
  readonly located_at: string;
}
export interface ReadingMark {
  readonly mark_id: string;
  readonly literature_id: string;
  readonly kind: MarkKind;
  readonly color: MarkColor;
  readonly note: string;
  readonly tags: readonly string[];
  readonly quote: string;
  readonly quote_prefix: string;
  readonly quote_suffix: string;
  readonly pdf: MarkPdfAnchor | null;
  readonly document: MarkDocumentAnchor | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly deleted_at: string | null;
  readonly places: readonly MarkPlace[];
}
export interface MarkContent {
  readonly color: MarkColor;
  readonly note: string;
  readonly quote: string;
  readonly quote_prefix: string;
  readonly quote_suffix: string;
  readonly pdf: MarkPdfAnchor | null;
  readonly document: MarkDocumentAnchor | null;
}
export type MarkOperation =
  | { operation: "list"; request: { literature_id: string } }
  | {
      operation: "export";
      request: { literature_id: string; format: "markdown" | "json" };
    }
  | {
      operation: "create";
      request: MarkContent & {
        literature_id: string;
        kind: MarkKind;
        mark_id: string | null;
      };
    }
  | {
      operation: "update";
      request: {
        mark_id: string;
        color?: MarkColor;
        note?: string;
        pdf?: MarkPdfAnchor;
        document?: MarkDocumentAnchor;
      };
    }
  | { operation: "delete" | "restore"; request: { mark_id: string } }
  | {
      operation: "place";
      request: {
        mark_id: string;
        target: MarkTarget;
        similarity: number;
        method: string;
      };
    };

function fail(): never {
  throw new ContractValidationError();
}
const MARK_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
export function parseMarkId(value: unknown): string {
  if (typeof value !== "string" || !MARK_ID.test(value)) fail();
  return value;
}
function color(value: unknown): MarkColor {
  if (!(MARK_COLORS as readonly unknown[]).includes(value)) fail();
  return value as MarkColor;
}
function kind(value: unknown): MarkKind {
  if (!(MARK_KINDS as readonly unknown[]).includes(value)) fail();
  return value as MarkKind;
}
/** Text from the reader: control characters other than line breaks and tabs are refused. */
function text(value: unknown, max: number): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  )
    fail();
  return value.normalize("NFC");
}
function sha256(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) fail();
  return value;
}
function coordinate(value: unknown, min: number): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > MARK_LIMITS.coordinate
  )
    fail();
  return Math.round(value * 100) / 100;
}
export function parseMarkPdfAnchor(value: unknown): MarkPdfAnchor {
  const r = tagRecord(value, ["sha256", "page", "rects"]);
  if (
    !Array.isArray(r.rects) ||
    !r.rects.length ||
    r.rects.length > MARK_LIMITS.rects
  )
    fail();
  return Object.freeze({
    sha256: sha256(r.sha256),
    page: tagInteger(r.page, 1),
    rects: Object.freeze(
      r.rects.map((rect: unknown) => {
        if (!Array.isArray(rect) || rect.length !== 4) fail();
        const [x, y, w, h] = rect as unknown[];
        const width = coordinate(w, 0),
          height = coordinate(h, 0);
        if (width <= 0 || height <= 0) fail();
        return Object.freeze([
          coordinate(x, -10),
          coordinate(y, -10),
          width,
          height,
        ] as const);
      }),
    ),
  });
}
export function parseMarkDocumentAnchor(value: unknown): MarkDocumentAnchor {
  const r = tagRecord(value, ["document_version_id", "start_utf8", "end_utf8"]);
  const start = tagInteger(r.start_utf8),
    end = tagInteger(r.end_utf8, 1);
  if (end <= start) fail();
  return Object.freeze({
    document_version_id: parseAssetId(r.document_version_id),
    start_utf8: start,
    end_utf8: end,
  });
}
export function parseMarkTarget(value: unknown): MarkTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  if ("pdf" in value)
    return { pdf: parseMarkPdfAnchor(tagRecord(value, ["pdf"]).pdf) };
  return {
    document: parseMarkDocumentAnchor(tagRecord(value, ["document"]).document),
  };
}
function similarity(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0.7 ||
    value > 1
  )
    fail();
  return value;
}
export function parseMarkPlace(value: unknown): MarkPlace {
  const r = tagRecord(value, ["target", "similarity", "method", "located_at"]);
  return Object.freeze({
    target: parseMarkTarget(r.target),
    similarity: similarity(r.similarity),
    method: tagText(r.method),
    located_at: parseUtcTimestamp(r.located_at),
  });
}
/** `#标签` words in a note, in order of first use. */
export function markTags(note: string): string[] {
  return [
    ...new Set(
      [...note.matchAll(/#([\p{L}\p{N}_-]{1,40})/gu)].map((m) => m[1]!),
    ),
  ];
}
const optional = (r: Record<string, unknown>, keys: readonly string[]) => {
  for (const key of Object.keys(r)) if (!keys.includes(key)) fail();
};
export function parseMarkOperation(value: unknown): MarkOperation {
  const e = tagRecord(value, ["operation", "request"]),
    op = e.operation;
  if (!e.request || typeof e.request !== "object" || Array.isArray(e.request))
    fail();
  const r = e.request as Record<string, unknown>;
  if (op === "list") {
    tagRecord(r, ["literature_id"]);
    return {
      operation: op,
      request: { literature_id: parseLiteratureId(r.literature_id) },
    };
  }
  if (op === "export") {
    tagRecord(r, ["literature_id", "format"]);
    if (r.format !== "markdown" && r.format !== "json") fail();
    return {
      operation: op,
      request: {
        literature_id: parseLiteratureId(r.literature_id),
        format: r.format,
      },
    };
  }
  if (op === "delete" || op === "restore") {
    tagRecord(r, ["mark_id"]);
    return { operation: op, request: { mark_id: parseMarkId(r.mark_id) } };
  }
  if (op === "place") {
    tagRecord(r, ["mark_id", "target", "similarity", "method"]);
    return {
      operation: op,
      request: {
        mark_id: parseMarkId(r.mark_id),
        target: parseMarkTarget(r.target),
        similarity: similarity(r.similarity),
        method: tagText(r.method),
      },
    };
  }
  if (op === "create") {
    optional(r, [
      "literature_id",
      "kind",
      "color",
      "note",
      "quote",
      "quote_prefix",
      "quote_suffix",
      "pdf",
      "document",
      "mark_id",
    ]);
    const markKind = kind(r.kind),
      pdf = r.pdf == null ? null : parseMarkPdfAnchor(r.pdf),
      document =
        r.document == null ? null : parseMarkDocumentAnchor(r.document),
      quote = text(r.quote ?? "", MARK_LIMITS.quote);
    // A region lives on a PDF page; a highlight needs its words and a place.
    if (markKind === "region" ? !pdf : !quote.trim() || (!pdf && !document))
      fail();
    return {
      operation: op,
      request: {
        literature_id: parseLiteratureId(r.literature_id),
        kind: markKind,
        color: color(r.color),
        note: text(r.note ?? "", MARK_LIMITS.note),
        quote,
        quote_prefix: text(r.quote_prefix ?? "", MARK_LIMITS.context),
        quote_suffix: text(r.quote_suffix ?? "", MARK_LIMITS.context),
        pdf,
        document,
        mark_id: r.mark_id == null ? null : parseMarkId(r.mark_id),
      },
    };
  }
  if (op === "update") {
    optional(r, ["mark_id", "color", "note", "pdf", "document"]);
    if (Object.keys(r).length < 2) fail();
    return {
      operation: op,
      request: {
        mark_id: parseMarkId(r.mark_id),
        ...(r.color === undefined ? {} : { color: color(r.color) }),
        ...(r.note === undefined
          ? {}
          : { note: text(r.note, MARK_LIMITS.note) }),
        ...(r.pdf === undefined ? {} : { pdf: parseMarkPdfAnchor(r.pdf) }),
        ...(r.document === undefined
          ? {}
          : { document: parseMarkDocumentAnchor(r.document) }),
      },
    };
  }
  return fail();
}
export function parseReadingMark(value: unknown): ReadingMark {
  const r = tagRecord(value, [
    "mark_id",
    "literature_id",
    "kind",
    "color",
    "note",
    "tags",
    "quote",
    "quote_prefix",
    "quote_suffix",
    "pdf",
    "document",
    "created_at",
    "updated_at",
    "deleted_at",
    "places",
  ]);
  if (!Array.isArray(r.places)) fail();
  const note = text(r.note, MARK_LIMITS.note);
  if (
    !Array.isArray(r.tags) ||
    JSON.stringify(r.tags) !== JSON.stringify(markTags(note))
  )
    fail();
  return Object.freeze({
    mark_id: parseMarkId(r.mark_id),
    literature_id: parseLiteratureId(r.literature_id),
    kind: kind(r.kind),
    color: color(r.color),
    note,
    tags: Object.freeze(markTags(note)),
    quote: text(r.quote, MARK_LIMITS.quote),
    quote_prefix: text(r.quote_prefix, MARK_LIMITS.context),
    quote_suffix: text(r.quote_suffix, MARK_LIMITS.context),
    pdf: r.pdf === null ? null : parseMarkPdfAnchor(r.pdf),
    document: r.document === null ? null : parseMarkDocumentAnchor(r.document),
    created_at: parseUtcTimestamp(r.created_at),
    updated_at: parseUtcTimestamp(r.updated_at),
    deleted_at: r.deleted_at === null ? null : parseUtcTimestamp(r.deleted_at),
    places: Object.freeze(r.places.map(parseMarkPlace)),
  });
}
export interface MarkExportPaper {
  readonly title: string;
  readonly byline: string;
}
/** Reading order: page, then top to bottom; marks only on the full text come last. */
export function sortMarks(marks: readonly ReadingMark[]): ReadingMark[] {
  return [...marks].sort(
    (a, b) =>
      (a.pdf?.page ?? Number.MAX_SAFE_INTEGER) -
        (b.pdf?.page ?? Number.MAX_SAFE_INTEGER) ||
      (a.pdf?.rects[0]?.[1] ?? 0) - (b.pdf?.rects[0]?.[1] ?? 0) ||
      (a.document?.start_utf8 ?? 0) - (b.document?.start_utf8 ?? 0) ||
      a.created_at.localeCompare(b.created_at),
  );
}
/** Markdown that pastes into a notes app: grouped by page, quotes kept with their meaning. */
export function marksMarkdown(
  paper: MarkExportPaper,
  marks: readonly ReadingMark[],
): string {
  const lines = [`# ${paper.title}`, "", paper.byline];
  let group: string | null = null;
  for (const mark of sortMarks(marks)) {
    const heading = mark.pdf ? `第 ${mark.pdf.page} 页` : "全文";
    if (heading !== group) {
      group = heading;
      lines.push("", `## ${heading}`, "");
    }
    const label = MARK_COLOR_LABELS[mark.color];
    lines.push(
      mark.kind === "region"
        ? `- **${label}** 框选区域${mark.pdf ? `（第 ${mark.pdf.page} 页）` : ""}`
        : `- **${label}** > ${mark.quote.replace(/\s+/gu, " ").trim()}`,
    );
    for (const line of mark.note.trim() ? mark.note.trim().split("\n") : [])
      lines.push(`  ${line}`);
  }
  return `${lines.join("\n")}\n`;
}
