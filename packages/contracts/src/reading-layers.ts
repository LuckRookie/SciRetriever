import { ContractValidationError } from "./index.js";
import {
  isTranslationLanguage,
  type TranslationLanguage,
} from "./translation.js";
import { SENTENCE_SPLIT_RULE } from "./sentence-split.js";

/**
 * Reading layers: the digest and the outline of points of one document (ADR
 * 0069 and 0070, document spec 10). One immutable file per literature,
 * primary PDF and proofread content version; the catalog registers its
 * identity and counts only. Points, labels, digest and data rows are
 * machine-written and never evidence; the evidence they cite are positions in
 * the original.
 */
export const READING_LAYERS_PROMPT_VERSION = "reading-layers-v2";
export const READING_LAYERS_TRANSLATION_PROMPT_VERSION =
  "reading-layers-translation-v2";
/**
 * The file layout. Version 2 adds ADR 0070's content (spec 10.2.1); a stored
 * file of another version reads as stale (spec 10.6) and is redone.
 */
export const LAYERS_FILE_SCHEMA_VERSION = 2;
/** Initial values (plan 28 block 09 adjusts them after real papers). */
export const LAYERS_POINTS_MIN = 3;
export const LAYERS_POINTS_MAX = 40;
/** Body translatable units under this many code points get no layers. */
export const LAYERS_MIN_CODE_POINTS = 3000;
export const LAYERS_STATEMENT_MAX = 300;
export const LAYERS_NOT_GIVEN_MAX = 300;
export const LAYERS_KEY_TERM_MAX = 40;
export const LAYERS_KEY_TERMS_PER_ITEM = 2;
export const LAYERS_EVIDENCE_PER_POINT = 3;
export const LAYERS_EVIDENCE_SENTENCES = 4;
export const LAYERS_DIGEST_UNITS = 6;
/** The trunk of the whole document: 3 to 5 primary points. */
export const LAYERS_PRIMARY_MIN = 3;
export const LAYERS_PRIMARY_MAX = 5;
/** A label is at most 6 words, or 12 CJK characters (spec 10.2.1). */
export const LAYERS_LABEL_MAX_WORDS = 6;
export const LAYERS_LABEL_MAX_CJK = 12;
export const LAYERS_LABEL_MAX = 80;
export const LAYERS_RELATIONS_PER_POINT = 3;
export const LAYERS_RELATION_TARGETS = 5;
export const LAYERS_SUMMARY_MAX = 400;
export const LAYERS_LIMITS_MAX = 5;
export const LAYERS_LIMIT_TEXT_MAX = 200;
export const LAYERS_ADVICE_MAX = 300;
export const LAYERS_PLACES_MAX = 6;
export const LAYERS_PLACE_TEXT_MAX = 40;
export const LAYERS_DATA_MAX = 8;
export const LAYERS_QUANTITY_MAX = 60;
export const LAYERS_VALUE_MAX = 60;
/** A translated text may run longer than its original. */
export const LAYERS_TRANSLATION_TEXT_MAX = 1200;
/** What a point is (spec 10.2.1): 背景、问题、方法、结果、分析、结论、局限. */
export const LAYERS_POINT_KINDS = [
  "context",
  "question",
  "method",
  "result",
  "analysis",
  "claim",
  "limit",
] as const;
export type LayersPointKind = (typeof LAYERS_POINT_KINDS)[number];
/** How a point refers on (spec 10.2.1): 见、承接、依据、解释、总结、引申自. `see` points at figures and tables only. */
export const LAYERS_RELATION_WORDS = [
  "see",
  "follows",
  "based_on",
  "explains",
  "sums_up",
  "extends",
] as const;
export type LayersRelationWord = (typeof LAYERS_RELATION_WORDS)[number];
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
/** A relation's target: another point by number, or a figure or table. */
export type LayersRelationTarget =
  | { readonly kind: "point"; readonly number: number }
  | { readonly kind: "block"; readonly segment_id: string };
export interface LayersRelation {
  readonly word: LayersRelationWord;
  readonly targets: readonly LayersRelationTarget[];
}
export interface LayersPoint {
  readonly number: number;
  readonly statement: string;
  readonly evidence: readonly LayersEvidence[];
  readonly key_terms: readonly string[];
  /** From the first evidence's position; null when the paper has no headings. */
  readonly section_id: string | null;
  /** One of the 3 to 5 points of the document's trunk. */
  readonly primary: boolean;
  /** A short label for the map, in the document's language; null when dropped. */
  readonly label: string | null;
  /** null when the model gave none of the fixed kinds. */
  readonly kind: LayersPointKind | null;
  readonly relations: readonly LayersRelation[];
  /**
   * What the overview shows under a primary point: a part of one of its
   * sentence evidence (a range inside it) or one of its block evidence.
   * Always null on other points; null on a primary point means "its first
   * evidence".
   */
  readonly basis: LayersEvidence | null;
}
/** A place named in the reading advice: the exact words and what they point to. */
export interface LayersPlace {
  readonly text: string;
  readonly target:
    | { readonly kind: "section"; readonly segment_id: string }
    | { readonly kind: "block"; readonly segment_id: string };
}
export interface LayersDigest {
  /** Two or three sentences: the object, the method, the conclusion. Never null. */
  readonly summary: {
    readonly text: string;
    readonly units: readonly string[];
    readonly key_terms: readonly string[];
  };
  /** 0 to 5 limitations and open questions. */
  readonly limits: readonly {
    readonly text: string;
    readonly units: readonly string[];
  }[];
  /** null when the document gives nothing for it, with `not_given`. */
  readonly advice: {
    readonly text: string | null;
    readonly not_given: string | null;
    readonly units: readonly string[];
    readonly key_terms: readonly string[];
    readonly places: readonly LayersPlace[];
  };
}
/** One row of key data; `value` keeps the document's digits. */
export interface LayersDataRow {
  readonly quantity: string;
  readonly value: string;
  readonly source:
    | { readonly kind: "unit"; readonly unit_id: string }
    | { readonly kind: "block"; readonly segment_id: string };
}
export interface LayersDropped {
  readonly evidence: number;
  readonly points: number;
  readonly key_terms: number;
  readonly digest_units: number;
  readonly kinds: number;
  readonly labels: number;
  readonly relations: number;
  readonly basis: number;
  readonly data: number;
  readonly places: number;
  readonly limits: number;
  /** Primary marks beyond the first five. */
  readonly primary: number;
}
/** A translated text and the renderings of its key terms (null: none found). */
export interface LayersTranslatedText {
  readonly text: string | null;
  readonly key_terms: readonly (string | null)[];
}
/**
 * The translation part (spec 10.5, 10.2.1), bound to one stored translation
 * file by its sha256. Arrays follow the points, evidence, limits, places and
 * data rows by index. Data values are not translated.
 */
export interface LayersTranslationPart {
  readonly target_language: TranslationLanguage;
  readonly translation_sha256: string;
  readonly model: string;
  readonly prompt_version: string;
  readonly digest: {
    readonly summary: LayersTranslatedText;
    readonly limits: readonly (string | null)[];
    readonly advice: LayersTranslatedText & {
      /** The rendering of each place's words, found in the advice's translation. */
      readonly places: readonly (string | null)[];
    };
  };
  readonly points: readonly (LayersTranslatedText & {
    readonly label: string | null;
    /** UTF-8 half-open range inside the unit's stored translation, or null. */
    readonly evidence: readonly ({
      readonly start_utf8: number;
      readonly end_utf8: number;
    } | null)[];
  })[];
  /** The translated `quantity` of each data row. */
  readonly data: readonly (string | null)[];
  readonly dropped: {
    readonly key_terms: number;
    readonly evidence: number;
    readonly places: number;
  };
}
export interface DocumentLayersFile {
  readonly schema_version: typeof LAYERS_FILE_SCHEMA_VERSION;
  readonly literature_id: string;
  readonly asset_id: string;
  readonly document_version_id: string;
  readonly annotation_id: string;
  /** archiveContentVersion(document_version_id, annotation_id). */
  readonly content_version: string;
  readonly sentence_rule: typeof SENTENCE_SPLIT_RULE;
  readonly digest: LayersDigest;
  readonly points: readonly LayersPoint[];
  readonly data: readonly LayersDataRow[];
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
const units = (v: unknown) => list(v, LAYERS_DIGEST_UNITS, id);
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
const segmentTarget = <K extends string>(v: unknown, kinds: readonly K[]) => {
  const r = exact(v, ["kind", "segment_id"]);
  if (!kinds.includes(r.kind as K)) fail();
  return { kind: r.kind as K, segment_id: id(r.segment_id) };
};
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
const nullableTexts = (v: unknown, length: number, max: number) => {
  const out = list(v, length, (x) => text(x, max, true));
  if (out.length !== length) fail();
  return out;
};
/** A label: at most 6 words, or at most 12 CJK characters. */
export function layersLabelFits(label: string): boolean {
  const t = label.trim();
  if (!t || codePoints(t) > LAYERS_LABEL_MAX) return false;
  const cjk = t.match(
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu,
  );
  if (cjk) return cjk.length <= LAYERS_LABEL_MAX_CJK;
  return t.split(/\s+/u).length <= LAYERS_LABEL_MAX_WORDS;
}

/** The `schema_version` of a stored layers file, without checking the rest. */
export function documentLayersFileVersion(value: unknown): number | null {
  const v =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as { schema_version?: unknown }).schema_version
      : undefined;
  return Number.isSafeInteger(v) ? (v as number) : null;
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
    "data",
    "model",
    "prompt_version",
    "dropped",
    "translation",
  ]);
  if (
    r.schema_version !== LAYERS_FILE_SCHEMA_VERSION ||
    r.sentence_rule !== SENTENCE_SPLIT_RULE
  )
    fail();
  const d = exact(r.digest, ["summary", "limits", "advice"]);
  const s = exact(d.summary, ["text", "units", "key_terms"]);
  const a = exact(d.advice, [
    "text",
    "not_given",
    "units",
    "key_terms",
    "places",
  ]);
  const digestValue: LayersDigest = Object.freeze({
    summary: Object.freeze({
      text: text(s.text, LAYERS_SUMMARY_MAX, false) as string,
      units: units(s.units),
      key_terms: terms(s.key_terms),
    }),
    limits: Object.freeze(
      list(d.limits, LAYERS_LIMITS_MAX, (x) => {
        const l = exact(x, ["text", "units"]);
        return Object.freeze({
          text: text(l.text, LAYERS_LIMIT_TEXT_MAX, false) as string,
          units: units(l.units),
        });
      }),
    ),
    advice: Object.freeze({
      text: text(a.text, LAYERS_ADVICE_MAX, true),
      not_given: text(a.not_given, LAYERS_NOT_GIVEN_MAX, true),
      units: units(a.units),
      key_terms: terms(a.key_terms),
      places: Object.freeze(
        list(a.places, LAYERS_PLACES_MAX, (x) => {
          const p = exact(x, ["text", "target"]);
          return Object.freeze({
            text: text(p.text, LAYERS_PLACE_TEXT_MAX, false) as string,
            target: segmentTarget(p.target, ["section", "block"] as const),
          });
        }),
      ),
    }),
  });
  if (
    digestValue.advice.text === null &&
    (digestValue.advice.key_terms.length || digestValue.advice.places.length)
  )
    fail();
  if (digestValue.advice.text !== null && digestValue.advice.not_given !== null)
    fail();
  const points = list(r.points, LAYERS_POINTS_MAX, (x) => {
    const p = exact(x, [
      "number",
      "statement",
      "evidence",
      "key_terms",
      "section_id",
      "primary",
      "label",
      "kind",
      "relations",
      "basis",
    ]);
    const ev = list(p.evidence, LAYERS_EVIDENCE_PER_POINT, evidence);
    if (!ev.length || typeof p.primary !== "boolean") fail();
    if (
      p.kind !== null &&
      !LAYERS_POINT_KINDS.includes(p.kind as LayersPointKind)
    )
      fail();
    const label = text(p.label, LAYERS_LABEL_MAX, true);
    if (label !== null && !layersLabelFits(label)) fail();
    const basis = p.basis === null ? null : evidence(p.basis);
    // A basis lies inside one of the point's own evidence.
    if (
      basis &&
      (!p.primary ||
        !ev.some((e) =>
          basis.kind === "block"
            ? e.kind === "block" && e.segment_id === basis.segment_id
            : e.kind === "sentence" &&
              e.unit_id === basis.unit_id &&
              e.start_utf8 <= basis.start_utf8 &&
              basis.end_utf8 <= e.end_utf8,
        ))
    )
      fail();
    return Object.freeze({
      number: count(p.number, 1, LAYERS_POINTS_MAX),
      statement: text(p.statement, LAYERS_STATEMENT_MAX, false) as string,
      evidence: Object.freeze(ev),
      key_terms: terms(p.key_terms),
      section_id: p.section_id === null ? null : id(p.section_id),
      primary: p.primary,
      label,
      kind: p.kind as LayersPointKind | null,
      relations: Object.freeze(
        list(p.relations, LAYERS_RELATIONS_PER_POINT, (x) => {
          const rel = exact(x, ["word", "targets"]);
          if (!LAYERS_RELATION_WORDS.includes(rel.word as LayersRelationWord))
            fail();
          const targets = list(
            rel.targets,
            LAYERS_RELATION_TARGETS,
            (t): LayersRelationTarget => {
              if ((t as { kind?: unknown } | null)?.kind === "point") {
                const o = exact(t, ["kind", "number"]);
                return {
                  kind: "point",
                  number: count(o.number, 1, LAYERS_POINTS_MAX),
                };
              }
              return segmentTarget(t, ["block"] as const);
            },
          );
          if (
            !targets.length ||
            (rel.word === "see" && targets.some((t) => t.kind !== "block"))
          )
            fail();
          return Object.freeze({
            word: rel.word as LayersRelationWord,
            targets: Object.freeze(targets),
          });
        }),
      ),
      basis,
    });
  });
  const primaries = points.filter((p) => p.primary).length;
  if (
    points.length < LAYERS_POINTS_MIN ||
    points.some((p, i) => p.number !== i + 1) ||
    primaries < LAYERS_PRIMARY_MIN ||
    primaries > LAYERS_PRIMARY_MAX ||
    points.some((p) =>
      p.relations.some((rel) =>
        rel.targets.some(
          (t) =>
            t.kind === "point" &&
            (t.number === p.number || t.number > points.length),
        ),
      ),
    )
  )
    fail();
  const data = list(r.data, LAYERS_DATA_MAX, (x) => {
    const row = exact(x, ["quantity", "value", "source"]);
    const source = row.source as { kind?: unknown } | null;
    return Object.freeze({
      quantity: text(row.quantity, LAYERS_QUANTITY_MAX, false) as string,
      value: text(row.value, LAYERS_VALUE_MAX, false) as string,
      source:
        source?.kind === "unit"
          ? (() => {
              const o = exact(source, ["kind", "unit_id"]);
              return { kind: "unit" as const, unit_id: id(o.unit_id) };
            })()
          : segmentTarget(source, ["block"] as const),
    });
  });
  const dr = exact(r.dropped, [
    "evidence",
    "points",
    "key_terms",
    "digest_units",
    "kinds",
    "labels",
    "relations",
    "basis",
    "data",
    "places",
    "limits",
    "primary",
  ]);
  const dropped = Object.freeze(
    Object.fromEntries(Object.entries(dr).map(([k, v]) => [k, count(v)])),
  ) as unknown as LayersDropped;
  let translation: LayersTranslationPart | null = null;
  if (r.translation !== null) {
    const t = exact(r.translation, [
      "target_language",
      "translation_sha256",
      "model",
      "prompt_version",
      "digest",
      "points",
      "data",
      "dropped",
    ]);
    if (!isTranslationLanguage(t.target_language)) fail();
    const td = exact(t.digest, ["summary", "limits", "advice"]);
    const ta = exact(td.advice, ["text", "key_terms", "places"]);
    const tp = list(t.points, LAYERS_POINTS_MAX, (x) => x);
    if (tp.length !== points.length) fail();
    const tdr = exact(t.dropped, ["key_terms", "evidence", "places"]);
    translation = Object.freeze({
      target_language: t.target_language,
      translation_sha256: digest(t.translation_sha256),
      model: text(t.model, 256, false) as string,
      prompt_version: text(t.prompt_version, 128, false) as string,
      digest: Object.freeze({
        summary: translatedText(
          td.summary,
          digestValue.summary.key_terms.length,
        ),
        limits: nullableTexts(
          td.limits,
          digestValue.limits.length,
          LAYERS_TRANSLATION_TEXT_MAX,
        ),
        advice: {
          ...translatedText(
            { text: ta.text, key_terms: ta.key_terms },
            digestValue.advice.key_terms.length,
          ),
          places: nullableTexts(
            ta.places,
            digestValue.advice.places.length,
            LAYERS_TRANSLATION_TEXT_MAX,
          ),
        },
      }),
      points: Object.freeze(
        tp.map((x, i) => {
          const p = exact(x, ["text", "key_terms", "label", "evidence"]);
          const ev = list(p.evidence, LAYERS_EVIDENCE_PER_POINT, (e) =>
            e === null ? null : byteRange(e),
          );
          if (ev.length !== points[i]!.evidence.length) fail();
          return {
            ...translatedText(
              { text: p.text, key_terms: p.key_terms },
              points[i]!.key_terms.length,
            ),
            label: text(p.label, LAYERS_TRANSLATION_TEXT_MAX, true),
            evidence: Object.freeze(ev),
          };
        }),
      ),
      data: nullableTexts(t.data, data.length, LAYERS_TRANSLATION_TEXT_MAX),
      dropped: {
        key_terms: count(tdr.key_terms),
        evidence: count(tdr.evidence),
        places: count(tdr.places),
      },
    });
  }
  return Object.freeze({
    schema_version: LAYERS_FILE_SCHEMA_VERSION,
    literature_id: id(r.literature_id),
    asset_id: id(r.asset_id),
    document_version_id: id(r.document_version_id),
    annotation_id: digest(r.annotation_id),
    content_version: digest(r.content_version),
    sentence_rule: SENTENCE_SPLIT_RULE,
    digest: digestValue,
    points: Object.freeze(points),
    data: Object.freeze(data),
    model: text(r.model, 256, false) as string,
    prompt_version: text(r.prompt_version, 128, false) as string,
    dropped,
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
