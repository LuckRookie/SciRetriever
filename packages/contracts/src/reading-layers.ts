import { ContractValidationError } from "./index.js";
import {
  isTranslationLanguage,
  type TranslationLanguage,
} from "./translation.js";
import { SENTENCE_SPLIT_RULE } from "./sentence-split.js";

/**
 * Reading layers: the digest and the outline of points of one paper (ADR
 * 0069, document spec 10). One immutable file per literature, primary PDF and
 * proofread content version; the catalog registers its identity and counts
 * only. Points and digest texts are machine-written and never evidence; the
 * evidence they cite are positions in the original.
 */
export const READING_LAYERS_PROMPT_VERSION = "reading-layers-v1";
export const READING_LAYERS_TRANSLATION_PROMPT_VERSION =
  "reading-layers-translation-v1";
/** Initial values (plan 28 block 09 adjusts them after real papers). */
export const LAYERS_POINTS_MIN = 3;
export const LAYERS_POINTS_MAX = 40;
/** Body translatable units under this many code points get no layers. */
export const LAYERS_MIN_CODE_POINTS = 3000;
export const LAYERS_STATEMENT_MAX = 300;
export const LAYERS_DIGEST_TEXT_MAX = 600;
export const LAYERS_NOT_GIVEN_MAX = 300;
export const LAYERS_KEY_TERM_MAX = 40;
export const LAYERS_KEY_TERMS_PER_ITEM = 2;
export const LAYERS_EVIDENCE_PER_POINT = 3;
export const LAYERS_EVIDENCE_SENTENCES = 4;
export const LAYERS_DIGEST_UNITS = 6;
/** A translated point or digest item may run longer than its original. */
export const LAYERS_TRANSLATION_TEXT_MAX = 2 * LAYERS_DIGEST_TEXT_MAX;
export const LAYERS_DIGEST_ITEMS = ["nature", "limits", "advice"] as const;
export type LayersDigestItemName = (typeof LAYERS_DIGEST_ITEMS)[number];
export const LAYERS_NOT_APPLICABLE_REASONS = [
  "long-document",
  "too-short",
] as const;
export type LayersNotApplicableReason =
  (typeof LAYERS_NOT_APPLICABLE_REASONS)[number];
export type DocumentLayersStatus = "complete" | "not-applicable";
export type DocumentLayersState = "none" | "stale" | DocumentLayersStatus;

/** A place in the proofread text that supports a point (spec 10.2). */
export type LayersEvidence =
  | {
      readonly kind: "sentence";
      /** The translation unit (spec 9.2) the sentences belong to. */
      readonly unit_id: string;
      /** 1 to 4 consecutive sentences, UTF-8 half-open in the fixed Markdown. */
      readonly start_utf8: number;
      readonly end_utf8: number;
    }
  | {
      readonly kind: "block";
      /** A figure, scheme or table object of `layout.figure_groups`. */
      readonly segment_id: string;
    };
export interface LayersDigestItem {
  /** null when the paper gives nothing for it; never null for `nature`. */
  readonly text: string | null;
  /** What is missing, when `text` is null. */
  readonly not_given: string | null;
  readonly units: readonly string[];
  readonly key_terms: readonly string[];
}
export type LayersDigest = Readonly<
  Record<LayersDigestItemName, LayersDigestItem>
>;
export interface LayersPoint {
  readonly number: number;
  readonly statement: string;
  readonly evidence: readonly LayersEvidence[];
  readonly key_terms: readonly string[];
  /** From the first evidence's position; null when the paper has no headings. */
  readonly section_id: string | null;
}
export interface LayersDropped {
  readonly evidence: number;
  readonly points: number;
  readonly key_terms: number;
  readonly digest_units: number;
}
/** A translated text and the renderings of its key terms (null: none found). */
export interface LayersTranslatedText {
  readonly text: string | null;
  readonly key_terms: readonly (string | null)[];
}
/**
 * The translation part (spec 10.5), bound to one stored translation file by
 * its sha256. Arrays follow the points and their evidence by index.
 */
export interface LayersTranslationPart {
  readonly target_language: TranslationLanguage;
  readonly translation_sha256: string;
  readonly model: string;
  readonly prompt_version: string;
  readonly digest: Readonly<Record<LayersDigestItemName, LayersTranslatedText>>;
  readonly points: readonly (LayersTranslatedText & {
    /** UTF-8 half-open range inside the unit's stored translation, or null. */
    readonly evidence: readonly ({
      readonly start_utf8: number;
      readonly end_utf8: number;
    } | null)[];
  })[];
  readonly dropped: { readonly key_terms: number; readonly evidence: number };
}
export interface DocumentLayersFile {
  readonly schema_version: 1;
  readonly literature_id: string;
  readonly asset_id: string;
  readonly document_version_id: string;
  readonly annotation_id: string;
  /** archiveContentVersion(document_version_id, annotation_id). */
  readonly content_version: string;
  readonly sentence_rule: typeof SENTENCE_SPLIT_RULE;
  readonly digest: LayersDigest;
  readonly points: readonly LayersPoint[];
  readonly model: string;
  readonly prompt_version: string;
  readonly dropped: LayersDropped;
  readonly translation: LayersTranslationPart | null;
}
/** `describe.layers` (spec 10.7). */
export interface DocumentLayersSummary {
  readonly state: DocumentLayersState;
  readonly points: number;
  /** The translation part's language; null when there is none. */
  readonly target_language: TranslationLanguage | null;
  readonly reason: LayersNotApplicableReason | null;
}

const DIGEST = /^[0-9a-f]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
function fail(): never {
  throw new ContractValidationError();
}
function exact(value: unknown, keys: readonly string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== [...keys].sort().join()
  )
    fail();
  return value as Record<string, unknown>;
}
const id = (v: unknown) => {
  if (typeof v !== "string" || !ID.test(v)) fail();
  return v;
};
const digest = (v: unknown) => {
  if (typeof v !== "string" || !DIGEST.test(v)) fail();
  return v;
};
const count = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  if (!Number.isSafeInteger(v) || (v as number) < min || (v as number) > max)
    fail();
  return v as number;
};
const codePoints = (s: string) => [...s].length;
const text = (v: unknown, max: number, nullable: boolean) => {
  if (v === null && nullable) return null;
  if (typeof v !== "string" || !v.trim() || codePoints(v) > max) fail();
  return v;
};
const list = <T>(v: unknown, max: number, item: (x: unknown) => T): T[] => {
  if (!Array.isArray(v) || v.length > max) fail();
  return v.map(item);
};
const term = (v: unknown) => text(v, LAYERS_KEY_TERM_MAX, false) as string;
const terms = (v: unknown) => list(v, LAYERS_KEY_TERMS_PER_ITEM, term);
const byteRange = (v: unknown) => {
  const r = exact(v, ["start_utf8", "end_utf8"]);
  const start = count(r.start_utf8),
    end = count(r.end_utf8);
  if (end <= start) fail();
  return { start_utf8: start, end_utf8: end };
};
function evidence(v: unknown): LayersEvidence {
  const kind = (v as { kind?: unknown } | null)?.kind;
  if (kind === "sentence") {
    const r = exact(v, ["kind", "unit_id", "start_utf8", "end_utf8"]);
    return {
      kind: "sentence",
      unit_id: id(r.unit_id),
      ...byteRange({ start_utf8: r.start_utf8, end_utf8: r.end_utf8 }),
    };
  }
  const r = exact(v, ["kind", "segment_id"]);
  if (r.kind !== "block") fail();
  return { kind: "block", segment_id: id(r.segment_id) };
}
function translatedText(v: unknown, keys: number): LayersTranslatedText {
  const r = exact(v, ["text", "key_terms"]);
  const key_terms = list(r.key_terms, LAYERS_KEY_TERMS_PER_ITEM, (k) =>
    k === null ? null : term(k),
  );
  if (key_terms.length !== keys) fail();
  return {
    text: text(r.text, LAYERS_TRANSLATION_TEXT_MAX, true),
    key_terms,
  };
}

export function parseDocumentLayersFile(value: unknown): DocumentLayersFile {
  const r = exact(value, [
    "schema_version",
    "literature_id",
    "asset_id",
    "document_version_id",
    "annotation_id",
    "content_version",
    "sentence_rule",
    "digest",
    "points",
    "model",
    "prompt_version",
    "dropped",
    "translation",
  ]);
  if (r.schema_version !== 1 || r.sentence_rule !== SENTENCE_SPLIT_RULE) fail();
  const d = exact(r.digest, LAYERS_DIGEST_ITEMS);
  const digestItems = Object.fromEntries(
    LAYERS_DIGEST_ITEMS.map((name) => {
      const item = exact(d[name], ["text", "not_given", "units", "key_terms"]);
      const parsed: LayersDigestItem = {
        text: text(item.text, LAYERS_DIGEST_TEXT_MAX, name !== "nature"),
        not_given: text(item.not_given, LAYERS_NOT_GIVEN_MAX, true),
        units: list(item.units, LAYERS_DIGEST_UNITS, id),
        key_terms: terms(item.key_terms),
      };
      if (parsed.text !== null && parsed.not_given !== null) fail();
      if (parsed.text === null && parsed.key_terms.length) fail();
      return [name, Object.freeze(parsed)];
    }),
  ) as unknown as LayersDigest;
  const points = list(r.points, LAYERS_POINTS_MAX, (x) => {
    const p = exact(x, [
      "number",
      "statement",
      "evidence",
      "key_terms",
      "section_id",
    ]);
    const ev = list(p.evidence, LAYERS_EVIDENCE_PER_POINT, evidence);
    if (!ev.length) fail();
    return Object.freeze({
      number: count(p.number, 1, LAYERS_POINTS_MAX),
      statement: text(p.statement, LAYERS_STATEMENT_MAX, false) as string,
      evidence: Object.freeze(ev),
      key_terms: terms(p.key_terms),
      section_id: p.section_id === null ? null : id(p.section_id),
    });
  });
  if (
    points.length < LAYERS_POINTS_MIN ||
    points.some((p, i) => p.number !== i + 1)
  )
    fail();
  const dr = exact(r.dropped, [
    "evidence",
    "points",
    "key_terms",
    "digest_units",
  ]);
  const dropped = {
    evidence: count(dr.evidence),
    points: count(dr.points),
    key_terms: count(dr.key_terms),
    digest_units: count(dr.digest_units),
  };
  let translation: LayersTranslationPart | null = null;
  if (r.translation !== null) {
    const t = exact(r.translation, [
      "target_language",
      "translation_sha256",
      "model",
      "prompt_version",
      "digest",
      "points",
      "dropped",
    ]);
    if (!isTranslationLanguage(t.target_language)) fail();
    const td = exact(t.digest, LAYERS_DIGEST_ITEMS);
    const tp = list(t.points, LAYERS_POINTS_MAX, (x) => x);
    if (tp.length !== points.length) fail();
    const tdr = exact(t.dropped, ["key_terms", "evidence"]);
    translation = Object.freeze({
      target_language: t.target_language,
      translation_sha256: digest(t.translation_sha256),
      model: text(t.model, 256, false) as string,
      prompt_version: text(t.prompt_version, 128, false) as string,
      digest: Object.freeze(
        Object.fromEntries(
          LAYERS_DIGEST_ITEMS.map((name) => [
            name,
            translatedText(td[name], digestItems[name].key_terms.length),
          ]),
        ),
      ) as LayersTranslationPart["digest"],
      points: Object.freeze(
        tp.map((x, i) => {
          const p = exact(x, ["text", "key_terms", "evidence"]);
          const ev = list(p.evidence, LAYERS_EVIDENCE_PER_POINT, (e) =>
            e === null ? null : byteRange(e),
          );
          if (ev.length !== points[i]!.evidence.length) fail();
          return {
            ...translatedText(
              { text: p.text, key_terms: p.key_terms },
              points[i]!.key_terms.length,
            ),
            evidence: Object.freeze(ev),
          };
        }),
      ),
      dropped: {
        key_terms: count(tdr.key_terms),
        evidence: count(tdr.evidence),
      },
    });
  }
  return Object.freeze({
    schema_version: 1,
    literature_id: id(r.literature_id),
    asset_id: id(r.asset_id),
    document_version_id: id(r.document_version_id),
    annotation_id: digest(r.annotation_id),
    content_version: digest(r.content_version),
    sentence_rule: SENTENCE_SPLIT_RULE,
    digest: Object.freeze(digestItems),
    points: Object.freeze(points),
    model: text(r.model, 256, false) as string,
    prompt_version: text(r.prompt_version, 128, false) as string,
    dropped: Object.freeze(dropped),
    translation,
  });
}

const LAYERS_STATES: readonly DocumentLayersState[] = [
  "none",
  "stale",
  "complete",
  "not-applicable",
];
export function parseDocumentLayersSummary(
  value: unknown,
  draft: boolean,
): DocumentLayersSummary {
  const r = exact(value, ["state", "points", "target_language", "reason"]);
  const state = r.state as DocumentLayersState;
  if (
    !LAYERS_STATES.includes(state) ||
    (draft && state !== "none") ||
    (r.target_language !== null &&
      (state !== "complete" || !isTranslationLanguage(r.target_language))) ||
    (state === "not-applicable") !==
      LAYERS_NOT_APPLICABLE_REASONS.includes(
        r.reason as LayersNotApplicableReason,
      ) ||
    (state !== "not-applicable" && r.reason !== null)
  )
    fail();
  const points = count(r.points, 0, LAYERS_POINTS_MAX);
  if (state !== "complete" && points !== 0) fail();
  return Object.freeze({
    state,
    points,
    target_language: r.target_language as TranslationLanguage | null,
    reason: r.reason as LayersNotApplicableReason | null,
  });
}
