import {
  ContractValidationError,
  parseAssetId,
  parseEvidenceRef,
  type EvidenceRef,
} from "./index.js";
import {
  DOCUMENT_READ_MAX_EVIDENCE,
  DOCUMENT_SLICE_TEXTS,
  parseDocumentReadingRef,
  type DocumentReadingRef,
  type DocumentSliceText,
} from "./document-read.js";
import { parseTextLevel, type TextLevel } from "./draft-document.js";
import {
  LAYERS_POINT_KINDS,
  LAYERS_POINTS_MAX,
  LAYERS_RELATION_WORDS,
  type LayersPointKind,
  type LayersRelationWord,
} from "./reading-layers.js";
import {
  isTranslationLanguage,
  type TranslationLanguage,
} from "./translation.js";

/** The `layers` document read (spec 10.7): only stored layers, never a model call. */
export const LAYERS_PARTS = ["overview", "outline"] as const;
export type LayersPart = (typeof LAYERS_PARTS)[number];
export const LAYERS_FORMATS = ["json", "markdown"] as const;
export type LayersFormat = (typeof LAYERS_FORMATS)[number];
export const LAYERS_OUTLINE_MAX_LIMIT = 50;
export const LAYERS_OUTLINE_DEFAULT_LIMIT = 20;
/** The first line of every Markdown export (spec 10.7). */
export const LAYERS_MACHINE_NOTE =
  "批语与提要由机器写成，不是证据；依据是原文里的句子与图表。";
export const LAYERS_MACHINE_TRANSLATION_NOTE = "译文为机器翻译。";

export interface DocumentLayersRequest {
  readonly document_version_id: string;
  readonly part: LayersPart;
  readonly text: DocumentSliceText;
  readonly format: LayersFormat;
  /** Points per outline page (and per Markdown page of the outline), 1 to 50. */
  readonly limit: number;
  readonly cursor: string | null;
  /**
   * The language asked for with `text: translation | bilingual` (ADR 0072);
   * absent means the library default. A translation part in another language
   * reads as `translation-unavailable`.
   */
  readonly target_language?: TranslationLanguage;
}
export interface LayersReadUnitRef {
  readonly unit_id: string;
  /** The unit's first segment's number in this version, from 1. */
  readonly paragraph: number;
}
type BlockKind = "figure" | "scheme" | "table";
/** A figure, scheme or table as a read gives it. */
export interface LayersReadBlockRef {
  readonly kind: "block";
  readonly segment_id: string;
  readonly block_kind: BlockKind;
  readonly paragraph: number;
}
/** The digest's summary (spec 10.2.1). */
export interface LayersReadSummary {
  readonly text: string;
  readonly key_terms: readonly string[];
  readonly units: readonly LayersReadUnitRef[];
  /** `text: translation`: whether `text` is the translation. */
  readonly translated?: boolean;
  /** `text: bilingual`: the translation beside the original. */
  readonly translation?: {
    readonly text: string | null;
    readonly key_terms: readonly string[];
  };
}
export interface LayersReadLimit {
  readonly text: string;
  readonly units: readonly LayersReadUnitRef[];
  readonly translated?: boolean;
  readonly translation?: { readonly text: string | null };
}
/** A place the advice names; in `text: translation` the words are the translation's. */
export interface LayersReadPlace {
  readonly text: string;
  readonly target:
    | {
        readonly kind: "section";
        readonly segment_id: string;
        readonly section_id: string | null;
        readonly title: string | null;
        readonly paragraph: number;
      }
    | LayersReadBlockRef;
}
export interface LayersReadAdvice {
  readonly text: string | null;
  readonly not_given: string | null;
  readonly key_terms: readonly string[];
  readonly units: readonly LayersReadUnitRef[];
  readonly places: readonly LayersReadPlace[];
  readonly translated?: boolean;
  readonly translation?: {
    readonly text: string | null;
    readonly key_terms: readonly string[];
    /** The rendering of each place's words, by index; null when not found. */
    readonly places: readonly (string | null)[];
  };
}
export interface LayersReadDataRow {
  readonly quantity: string;
  /** Never translated. */
  readonly value: string;
  readonly source:
    | ({ readonly kind: "unit" } & LayersReadUnitRef)
    | LayersReadBlockRef;
  readonly translated?: boolean;
  readonly translation?: { readonly quantity: string | null };
}
export type LayersReadRelationTarget =
  | {
      readonly kind: "point";
      readonly number: number;
      /** The target note's paragraph (spec 10.7). */
      readonly paragraph: number;
    }
  | LayersReadBlockRef;
/** One paragraph's note (批语, ADR 0073). */
export interface LayersReadPoint {
  readonly number: number;
  /** The paragraph it annotates and its number in this version. */
  readonly unit_id: string;
  readonly paragraph: number;
  readonly statement: string;
  /** In `text: translation`, the version's reason when the note has one. */
  readonly reason: string | null;
  readonly key_terms: readonly string[];
  readonly section_id: string | null;
  readonly section_title: string | null;
  readonly primary: boolean;
  /** In `text: translation`, the translated label when there is one. */
  readonly label: string | null;
  readonly kind: LayersPointKind | null;
  readonly relations: readonly {
    readonly word: LayersRelationWord;
    readonly targets: readonly LayersReadRelationTarget[];
  }[];
  readonly translated?: boolean;
  readonly translation?: {
    readonly statement: string | null;
    readonly reason: string | null;
    readonly key_terms: readonly string[];
    readonly label: string | null;
  };
}
/** A section's line (节旨) with its title; `statement` null when it has none. */
export interface LayersReadSection {
  readonly section_id: string | null;
  readonly title: string | null;
  readonly statement: string | null;
  readonly label: string | null;
  readonly translated?: boolean;
  readonly translation?: {
    readonly statement: string | null;
    readonly label: string | null;
  };
}
export type LayersReadEvidence =
  | {
      readonly kind: "sentence";
      readonly unit_id: string;
      /** The segments the range touches. */
      readonly segment_ids: readonly string[];
      /** Original UTF-8 positions in the fixed Markdown, always. */
      readonly start_utf8: number;
      readonly end_utf8: number;
      /** Display numbers ¶paragraph·sentences (spec 3.5), computed on read. */
      readonly paragraph: number;
      readonly sentences: readonly number[];
      readonly text: string;
      /** `text: translation`: `text` is translated; aligned when the translated sentences were confirmed. */
      readonly translated?: boolean;
      readonly aligned?: boolean;
      /** `text: bilingual`. */
      readonly translation?: {
        readonly text: string | null;
        readonly aligned: boolean;
      };
    }
  | {
      readonly kind: "block";
      readonly segment_id: string;
      readonly block_kind: "figure" | "scheme" | "table";
      readonly caption: string | null;
      readonly paragraph: number;
    };
/**
 * What the overview shows under a primary point (spec 10.2.1): a part of a
 * sentence evidence or a block evidence, always original text. `fallback`
 * when the point had no basis and its first evidence stands in.
 */
export type LayersReadBasis = (
  | {
      readonly kind: "sentence";
      readonly unit_id: string;
      readonly segment_ids: readonly string[];
      readonly start_utf8: number;
      readonly end_utf8: number;
      readonly paragraph: number;
      readonly sentences: readonly number[];
      readonly text: string;
    }
  | {
      readonly kind: "block";
      readonly segment_id: string;
      readonly block_kind: BlockKind;
      readonly caption: string | null;
      readonly paragraph: number;
    }
) & { readonly fallback: boolean };
interface LayersReadCommon {
  readonly text_level?: TextLevel;
  readonly document: DocumentReadingRef;
  readonly part: LayersPart;
  readonly text: DocumentSliceText;
  readonly state: "complete";
  /** Points and digest are machine-written; their evidence is the original. */
  readonly machine_written: true;
  readonly model: string;
  readonly prompt_version: string;
  /** Present only for `text: translation | bilingual`. */
  readonly machine_translation?: true;
  readonly target_language?: TranslationLanguage;
  /** Points and digest texts that have no translation. */
  readonly untranslated?: number;
}
export interface DocumentLayersOverviewResult extends LayersReadCommon {
  readonly part: "overview";
  readonly format: "json";
  readonly title: string | null;
  readonly summary: LayersReadSummary;
  /** The 3 to 5 primary points, each with what it rests on. */
  readonly primary: readonly (LayersReadPoint & {
    readonly basis: LayersReadBasis;
  })[];
  readonly data: readonly LayersReadDataRow[];
  readonly limits: readonly LayersReadLimit[];
  readonly advice: LayersReadAdvice;
  /** Every section in order: its line and all its notes, without evidence. */
  readonly sections: readonly (LayersReadSection & {
    readonly points: readonly LayersReadPoint[];
  })[];
}
export interface DocumentLayersOutlineResult extends LayersReadCommon {
  readonly part: "outline";
  readonly format: "json";
  readonly points: readonly (LayersReadPoint & {
    readonly evidence: readonly LayersReadEvidence[];
  })[];
  /** The lines of the sections this page's notes belong to, in order. */
  readonly sections: readonly LayersReadSection[];
  /** Evidence references of the page's evidence, as `slice` returns them. */
  readonly evidence: readonly EvidenceRef[];
  readonly total: number;
  readonly next_cursor: string | null;
}
export interface DocumentLayersMarkdownResult extends LayersReadCommon {
  readonly format: "markdown";
  readonly markdown: string;
  readonly total: number;
  readonly next_cursor: string | null;
}
export type DocumentLayersResult =
  | DocumentLayersOverviewResult
  | DocumentLayersOutlineResult
  | DocumentLayersMarkdownResult;

function fail(): never {
  throw new ContractValidationError();
}
function record(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}
function exact(value: unknown, keys: readonly string[]) {
  const r = record(value);
  if (Object.keys(r).sort().join() !== [...keys].sort().join()) fail();
  return r;
}
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const id = (v: unknown) => {
  if (typeof v !== "string" || !ID.test(v)) fail();
  return v;
};
const nullableId = (v: unknown) => (v === null ? null : id(v));
const count = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  if (!Number.isSafeInteger(v) || (v as number) < min || (v as number) > max)
    fail();
  return v as number;
};
const string = (v: unknown) => {
  if (typeof v !== "string") fail();
  return v;
};
const nullableString = (v: unknown) => (v === null ? null : string(v));
const strings = (v: unknown) => {
  if (!Array.isArray(v) || v.length > 10_000) fail();
  return v.map(string);
};
const cursor = (v: unknown) => {
  if (v === null) return null;
  if (typeof v !== "string" || v.length > 1024 || !/^[A-Za-z0-9_-]+$/u.test(v))
    fail();
  return v;
};

export function parseDocumentLayersRequest(
  value: unknown,
): DocumentLayersRequest {
  const r = record(value);
  const optional = ["text", "format", "limit", "cursor", "target_language"];
  if (
    !Object.hasOwn(r, "document_version_id") ||
    !Object.hasOwn(r, "part") ||
    Object.keys(r).some(
      (k) => !["document_version_id", "part", ...optional].includes(k),
    )
  )
    fail();
  const part = r.part as LayersPart;
  if (!LAYERS_PARTS.includes(part)) fail();
  const text = (r.text ?? "original") as DocumentSliceText;
  const format = (r.format ?? "json") as LayersFormat;
  if (!DOCUMENT_SLICE_TEXTS.includes(text) || !LAYERS_FORMATS.includes(format))
    fail();
  const limit =
    r.limit === undefined
      ? LAYERS_OUTLINE_DEFAULT_LIMIT
      : count(r.limit, 1, LAYERS_OUTLINE_MAX_LIMIT);
  const next = cursor(r.cursor ?? null);
  // The overview is one page.
  if (part === "overview" && next !== null) fail();
  const language = Object.hasOwn(r, "target_language")
    ? r.target_language
    : undefined;
  if (language !== undefined && !isTranslationLanguage(language)) fail();
  return Object.freeze({
    document_version_id: String(parseAssetId(r.document_version_id)),
    part,
    text,
    format,
    limit,
    cursor: next,
    ...(language !== undefined ? { target_language: language } : {}),
  });
}

function common(
  r: Record<string, unknown>,
  request: DocumentLayersRequest,
): LayersReadCommon {
  const document = parseDocumentReadingRef(r.document);
  if (document.document_version_id !== request.document_version_id) fail();
  const translated = request.text !== "original";
  if (
    r.part !== request.part ||
    r.text !== request.text ||
    r.state !== "complete" ||
    r.machine_written !== true ||
    (translated &&
      (r.machine_translation !== true ||
        !isTranslationLanguage(r.target_language) ||
        (request.target_language !== undefined &&
          r.target_language !== request.target_language)))
  )
    fail();
  return {
    ...(Object.hasOwn(r, "text_level")
      ? { text_level: parseTextLevel(r.text_level) }
      : {}),
    document,
    part: request.part,
    text: request.text,
    state: "complete",
    machine_written: true,
    model: string(r.model),
    prompt_version: string(r.prompt_version),
    ...(translated
      ? {
          machine_translation: true as const,
          target_language: r.target_language as TranslationLanguage,
          untranslated: count(r.untranslated),
        }
      : {}),
  };
}
function commonKeys(value: unknown, request: DocumentLayersRequest) {
  return [
    "document",
    "part",
    "text",
    "state",
    "machine_written",
    "model",
    "prompt_version",
    "format",
    ...(value && typeof value === "object" && Object.hasOwn(value, "text_level")
      ? ["text_level"]
      : []),
    ...(request.text !== "original"
      ? ["machine_translation", "target_language", "untranslated"]
      : []),
  ];
}
function modeKeys(mode: DocumentSliceText, translationKeys: string[]) {
  return mode === "translation"
    ? ["translated"]
    : mode === "bilingual"
      ? translationKeys
      : [];
}
function list<T>(v: unknown, item: (x: unknown) => T, max = 10_000): T[] {
  if (!Array.isArray(v) || v.length > max) fail();
  return v.map(item);
}
const blockKind = (v: unknown) => {
  if (!["figure", "scheme", "table"].includes(String(v))) fail();
  return v as BlockKind;
};
function unitRef(v: unknown): LayersReadUnitRef {
  const x = exact(v, ["unit_id", "paragraph"]);
  return { unit_id: id(x.unit_id), paragraph: count(x.paragraph, 1) };
}
function blockRef(v: unknown): LayersReadBlockRef {
  const x = exact(v, ["kind", "segment_id", "block_kind", "paragraph"]);
  if (x.kind !== "block") fail();
  return {
    kind: "block",
    segment_id: id(x.segment_id),
    block_kind: blockKind(x.block_kind),
    paragraph: count(x.paragraph, 1),
  };
}
/** The mode's fields of a translated item: `translated`, or `translation` of the given shape. */
function modeFields<T>(
  r: Record<string, unknown>,
  mode: DocumentSliceText,
  translation: (t: unknown) => T,
): { translated?: boolean; translation?: T } {
  return mode === "translation"
    ? { translated: r.translated === true }
    : mode === "bilingual"
      ? { translation: translation(r.translation) }
      : {};
}
function point(v: unknown, mode: DocumentSliceText, extra: readonly string[]) {
  const r = exact(v, [
    "number",
    "unit_id",
    "paragraph",
    "statement",
    "reason",
    "key_terms",
    "section_id",
    "section_title",
    "primary",
    "label",
    "kind",
    "relations",
    ...modeKeys(mode, ["translation"]),
    ...extra,
  ]);
  if (
    typeof r.primary !== "boolean" ||
    (r.kind !== null && !LAYERS_POINT_KINDS.includes(r.kind as LayersPointKind))
  )
    fail();
  return {
    number: count(r.number, 1, LAYERS_POINTS_MAX),
    unit_id: id(r.unit_id),
    paragraph: count(r.paragraph, 1),
    statement: string(r.statement),
    reason: nullableString(r.reason),
    key_terms: strings(r.key_terms),
    section_id: nullableId(r.section_id),
    section_title: nullableString(r.section_title),
    primary: r.primary,
    label: nullableString(r.label),
    kind: r.kind as LayersPointKind | null,
    relations: list(r.relations, (x) => {
      const rel = exact(x, ["word", "targets"]);
      if (!LAYERS_RELATION_WORDS.includes(rel.word as LayersRelationWord))
        fail();
      return {
        word: rel.word as LayersRelationWord,
        targets: list(rel.targets, (t): LayersReadRelationTarget => {
          if (record(t).kind === "point") {
            const o = exact(t, ["kind", "number", "paragraph"]);
            return {
              kind: "point",
              number: count(o.number, 1),
              paragraph: count(o.paragraph, 1),
            };
          }
          return blockRef(t);
        }),
      };
    }),
    ...modeFields(r, mode, (t) => {
      const x = exact(t, ["statement", "reason", "key_terms", "label"]);
      return {
        statement: nullableString(x.statement),
        reason: nullableString(x.reason),
        key_terms: strings(x.key_terms),
        label: nullableString(x.label),
      };
    }),
    ...(extra.includes("evidence")
      ? {
          evidence: (() => {
            if (!Array.isArray(r.evidence) || !r.evidence.length) fail();
            return r.evidence.map((e) => readEvidence(e, mode));
          })(),
        }
      : {}),
    ...(extra.includes("basis") ? { basis: readBasis(r.basis) } : {}),
  };
}
function sectionLine(v: unknown, mode: DocumentSliceText): LayersReadSection {
  const r = exact(v, [
    "section_id",
    "title",
    "statement",
    "label",
    ...modeKeys(mode, ["translation"]),
  ]);
  return {
    section_id: nullableId(r.section_id),
    title: nullableString(r.title),
    statement: nullableString(r.statement),
    label: nullableString(r.label),
    ...modeFields(r, mode, (t) => {
      const x = exact(t, ["statement", "label"]);
      return {
        statement: nullableString(x.statement),
        label: nullableString(x.label),
      };
    }),
  };
}
function readBasis(v: unknown): LayersReadBasis {
  const r = record(v);
  if (typeof r.fallback !== "boolean") fail();
  const { fallback, ...rest } = r;
  return { ...readEvidence(rest, "original"), fallback } as LayersReadBasis;
}
function overviewParts(r: Record<string, unknown>, mode: DocumentSliceText) {
  const s = exact(r.summary, [
    "text",
    "key_terms",
    "units",
    ...modeKeys(mode, ["translation"]),
  ]);
  const a = exact(r.advice, [
    "text",
    "not_given",
    "key_terms",
    "units",
    "places",
    ...modeKeys(mode, ["translation"]),
  ]);
  return {
    summary: {
      text: string(s.text),
      key_terms: strings(s.key_terms),
      units: list(s.units, unitRef),
      ...modeFields(s, mode, (t) => {
        const x = exact(t, ["text", "key_terms"]);
        return {
          text: nullableString(x.text),
          key_terms: strings(x.key_terms),
        };
      }),
    },
    limits: list(r.limits, (v): LayersReadLimit => {
      const l = exact(v, ["text", "units", ...modeKeys(mode, ["translation"])]);
      return {
        text: string(l.text),
        units: list(l.units, unitRef),
        ...modeFields(l, mode, (t) => ({
          text: nullableString(exact(t, ["text"]).text),
        })),
      };
    }),
    advice: {
      text: nullableString(a.text),
      not_given: nullableString(a.not_given),
      key_terms: strings(a.key_terms),
      units: list(a.units, unitRef),
      places: list(a.places, (v): LayersReadPlace => {
        const p = exact(v, ["text", "target"]);
        const t = record(p.target);
        return {
          text: string(p.text),
          target:
            t.kind === "section"
              ? (() => {
                  const x = exact(t, [
                    "kind",
                    "segment_id",
                    "section_id",
                    "title",
                    "paragraph",
                  ]);
                  return {
                    kind: "section" as const,
                    segment_id: id(x.segment_id),
                    section_id: nullableId(x.section_id),
                    title: nullableString(x.title),
                    paragraph: count(x.paragraph, 1),
                  };
                })()
              : blockRef(t),
        };
      }),
      ...modeFields(a, mode, (t) => {
        const x = exact(t, ["text", "key_terms", "places"]);
        return {
          text: nullableString(x.text),
          key_terms: strings(x.key_terms),
          places: list(x.places, nullableString),
        };
      }),
    },
    data: list(r.data, (v): LayersReadDataRow => {
      const d = exact(v, [
        "quantity",
        "value",
        "source",
        ...modeKeys(mode, ["translation"]),
      ]);
      const src = record(d.source);
      return {
        quantity: string(d.quantity),
        value: string(d.value),
        source:
          src.kind === "unit"
            ? (() => {
                const x = exact(src, ["kind", "unit_id", "paragraph"]);
                return {
                  kind: "unit" as const,
                  ...unitRef({ unit_id: x.unit_id, paragraph: x.paragraph }),
                };
              })()
            : blockRef(src),
        ...modeFields(d, mode, (t) => ({
          quantity: nullableString(exact(t, ["quantity"]).quantity),
        })),
      };
    }),
    primary: list(
      r.primary,
      (p) =>
        point(p, mode, ["basis"]) as LayersReadPoint & {
          basis: LayersReadBasis;
        },
    ),
  };
}
function readEvidence(v: unknown, mode: DocumentSliceText): LayersReadEvidence {
  const kind = record(v).kind;
  if (kind === "block") {
    const r = exact(v, [
      "kind",
      "segment_id",
      "block_kind",
      "caption",
      "paragraph",
    ]);
    if (!["figure", "scheme", "table"].includes(String(r.block_kind))) fail();
    return {
      kind: "block",
      segment_id: id(r.segment_id),
      block_kind: r.block_kind as "figure" | "scheme" | "table",
      caption: nullableString(r.caption),
      paragraph: count(r.paragraph, 1),
    };
  }
  const r = exact(v, [
    "kind",
    "unit_id",
    "segment_ids",
    "start_utf8",
    "end_utf8",
    "paragraph",
    "sentences",
    "text",
    ...(mode === "translation"
      ? ["translated", "aligned"]
      : mode === "bilingual"
        ? ["translation"]
        : []),
  ]);
  if (kind !== "sentence") fail();
  const start = count(r.start_utf8),
    end = count(r.end_utf8);
  if (end <= start || !Array.isArray(r.sentences)) fail();
  return {
    kind: "sentence",
    unit_id: id(r.unit_id),
    segment_ids: strings(r.segment_ids).map(id),
    start_utf8: start,
    end_utf8: end,
    paragraph: count(r.paragraph, 1),
    sentences: r.sentences.map((n) => count(n, 1)),
    text: string(r.text),
    ...(mode === "translation"
      ? { translated: r.translated === true, aligned: r.aligned === true }
      : mode === "bilingual"
        ? (() => {
            const t = exact(r.translation, ["text", "aligned"]);
            return {
              translation: {
                text: nullableString(t.text),
                aligned: t.aligned === true,
              },
            };
          })()
        : {}),
  };
}

export function parseDocumentLayersResult(
  value: unknown,
  request: DocumentLayersRequest,
): DocumentLayersResult {
  const keys = commonKeys(value, request);
  const r0 = record(value);
  if (r0.format !== request.format) fail();
  if (request.format === "markdown") {
    const r = exact(value, [...keys, "markdown", "total", "next_cursor"]);
    const next = cursor(r.next_cursor);
    if (request.cursor !== null && next === request.cursor) fail();
    return Object.freeze({
      ...common(r, request),
      format: "markdown" as const,
      markdown: string(r.markdown),
      total: count(r.total, 0, LAYERS_POINTS_MAX),
      next_cursor: next,
    });
  }
  if (request.part === "overview") {
    const r = exact(value, [
      ...keys,
      "title",
      "summary",
      "primary",
      "data",
      "limits",
      "advice",
      "sections",
    ]);
    const parts = overviewParts(r, request.text);
    if (!Array.isArray(r.sections)) fail();
    const sections = r.sections.map((s) => {
      const { points, ...rest } = record(s);
      if (!Array.isArray(points)) fail();
      return {
        ...sectionLine(rest, request.text),
        points: points.map((p) => point(p, request.text, [])),
      };
    });
    return Object.freeze({
      ...common(r, request),
      part: "overview" as const,
      format: "json" as const,
      title: nullableString(r.title),
      ...parts,
      sections,
    });
  }
  const r = exact(value, [
    ...keys,
    "points",
    "sections",
    "evidence",
    "total",
    "next_cursor",
  ]);
  if (
    !Array.isArray(r.points) ||
    r.points.length > request.limit ||
    !Array.isArray(r.evidence) ||
    r.evidence.length > DOCUMENT_READ_MAX_EVIDENCE
  )
    fail();
  const next = cursor(r.next_cursor);
  if (request.cursor !== null && next === request.cursor) fail();
  const total = count(r.total, 0, LAYERS_POINTS_MAX);
  if (total < r.points.length) fail();
  return Object.freeze({
    ...common(r, request),
    part: "outline" as const,
    format: "json" as const,
    points: r.points.map(
      (p) =>
        point(p, request.text, ["evidence"]) as LayersReadPoint & {
          evidence: LayersReadEvidence[];
        },
    ),
    sections: list(r.sections, (x) => sectionLine(x, request.text)),
    evidence: r.evidence.map((e) => {
      const ref = parseEvidenceRef(e);
      if (
        ref.target_kind !== "document" ||
        ref.document_version_id !== request.document_version_id
      )
        fail();
      return ref;
    }),
    total,
    next_cursor: next,
  });
}
