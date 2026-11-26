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
  LAYERS_DIGEST_ITEMS,
  LAYERS_POINTS_MAX,
  type LayersDigestItemName,
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
  "要点与提要由机器写成，不是证据；依据是原文里的句子与图表。";
export const LAYERS_MACHINE_TRANSLATION_NOTE = "译文为机器翻译。";

export interface DocumentLayersRequest {
  readonly document_version_id: string;
  readonly part: LayersPart;
  readonly text: DocumentSliceText;
  readonly format: LayersFormat;
  /** Points per outline page (and per Markdown page of the outline), 1 to 50. */
  readonly limit: number;
  readonly cursor: string | null;
}
export interface LayersReadDigestItem {
  readonly name: LayersDigestItemName;
  readonly text: string | null;
  readonly not_given: string | null;
  readonly key_terms: readonly string[];
  readonly units: readonly {
    readonly unit_id: string;
    readonly paragraph: number;
  }[];
  /** `text: translation`: whether `text` is the translation. */
  readonly translated?: boolean;
  /** `text: bilingual`: the translation beside the original. */
  readonly translation?: {
    readonly text: string | null;
    readonly key_terms: readonly string[];
  };
}
export interface LayersReadPoint {
  readonly number: number;
  readonly statement: string;
  readonly key_terms: readonly string[];
  readonly section_id: string | null;
  readonly section_title: string | null;
  readonly translated?: boolean;
  readonly translation?: {
    readonly statement: string | null;
    readonly key_terms: readonly string[];
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
  readonly digest: readonly LayersReadDigestItem[];
  readonly sections: readonly {
    readonly section_id: string | null;
    readonly title: string | null;
    readonly points: readonly LayersReadPoint[];
  }[];
}
export interface DocumentLayersOutlineResult extends LayersReadCommon {
  readonly part: "outline";
  readonly format: "json";
  readonly points: readonly (LayersReadPoint & {
    readonly evidence: readonly LayersReadEvidence[];
  })[];
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
  const optional = ["text", "format", "limit", "cursor"];
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
  return Object.freeze({
    document_version_id: String(parseAssetId(r.document_version_id)),
    part,
    text,
    format,
    limit,
    cursor: next,
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
        !isTranslationLanguage(r.target_language)))
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
function point(v: unknown, mode: DocumentSliceText, withEvidence: boolean) {
  const r = exact(v, [
    "number",
    "statement",
    "key_terms",
    "section_id",
    "section_title",
    ...modeKeys(mode, ["translation"]),
    ...(withEvidence ? ["evidence"] : []),
  ]);
  return {
    number: count(r.number, 1, LAYERS_POINTS_MAX),
    statement: string(r.statement),
    key_terms: strings(r.key_terms),
    section_id: nullableId(r.section_id),
    section_title: nullableString(r.section_title),
    ...(mode === "translation"
      ? { translated: r.translated === true }
      : mode === "bilingual"
        ? (() => {
            const t = exact(r.translation, ["statement", "key_terms"]);
            return {
              translation: {
                statement: nullableString(t.statement),
                key_terms: strings(t.key_terms),
              },
            };
          })()
        : {}),
    ...(withEvidence
      ? {
          evidence: (() => {
            if (!Array.isArray(r.evidence) || !r.evidence.length) fail();
            return r.evidence.map((e) => readEvidence(e, mode));
          })(),
        }
      : {}),
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
    const r = exact(value, [...keys, "title", "digest", "sections"]);
    if (!Array.isArray(r.digest) || r.digest.length !== 3) fail();
    const digest = r.digest.map((v, i): LayersReadDigestItem => {
      const d = exact(v, [
        "name",
        "text",
        "not_given",
        "key_terms",
        "units",
        ...modeKeys(request.text, ["translation"]),
      ]);
      if (d.name !== LAYERS_DIGEST_ITEMS[i]) fail();
      if (!Array.isArray(d.units)) fail();
      return {
        name: d.name as LayersDigestItemName,
        text: nullableString(d.text),
        not_given: nullableString(d.not_given),
        key_terms: strings(d.key_terms),
        units: d.units.map((u) => {
          const x = exact(u, ["unit_id", "paragraph"]);
          return { unit_id: id(x.unit_id), paragraph: count(x.paragraph, 1) };
        }),
        ...(request.text === "translation"
          ? { translated: d.translated === true }
          : request.text === "bilingual"
            ? (() => {
                const t = exact(d.translation, ["text", "key_terms"]);
                return {
                  translation: {
                    text: nullableString(t.text),
                    key_terms: strings(t.key_terms),
                  },
                };
              })()
            : {}),
      };
    });
    if (!Array.isArray(r.sections)) fail();
    const sections = r.sections.map((s) => {
      const x = exact(s, ["section_id", "title", "points"]);
      if (!Array.isArray(x.points) || !x.points.length) fail();
      return {
        section_id: nullableId(x.section_id),
        title: nullableString(x.title),
        points: x.points.map((p) => point(p, request.text, false)),
      };
    });
    return Object.freeze({
      ...common(r, request),
      part: "overview" as const,
      format: "json" as const,
      title: nullableString(r.title),
      digest,
      sections,
    });
  }
  const r = exact(value, [
    ...keys,
    "points",
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
        point(p, request.text, true) as LayersReadPoint & {
          evidence: LayersReadEvidence[];
        },
    ),
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
