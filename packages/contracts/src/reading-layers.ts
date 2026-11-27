import { ContractValidationError } from "./index.js";
import {
  isTranslationLanguage,
  type TranslationLanguage,
} from "./translation.js";
import { SENTENCE_SPLIT_RULE } from "./sentence-split.js";

/**
 * Reading layers written paragraph by paragraph (ADR 0073, document spec 10):
 * one note per paragraph, one line per section, and the document's digest,
 * trunk, relations and data. One immutable file per literature, primary PDF
 * and proofread content version; the catalog registers its identity and
 * counts only. Notes, lines, digest and data rows are machine-written and
 * never evidence; the evidence they cite are positions in the original.
 */
export const READING_LAYERS_PROMPT_VERSION = "reading-layers-v3";
export const READING_LAYERS_SECTION_PROMPT_VERSION =
  "reading-layers-section-v3";
export const READING_LAYERS_TRANSLATION_PROMPT_VERSION =
  "reading-layers-translation-v3";
/**
 * The file layout. Version 3 is ADR 0073's (spec 10.2); a stored file of
 * another version reads as stale (spec 10.6) and is redone.
 */
export const LAYERS_FILE_SCHEMA_VERSION = 3;
/**
 * At most one note per paragraph; long documents (more than 50 pages) have
 * no layers, so a file holds far fewer.
 */
export const LAYERS_POINTS_MAX = 2000;
/** Body translatable units under this many code points get no layers. */
export const LAYERS_MIN_CODE_POINTS = 3000;
/** A note: one sentence, 40 CJK characters or 20 words, 300 code points. */
export const LAYERS_STATEMENT_MAX = 300;
export const LAYERS_STATEMENT_MAX_CJK = 40;
export const LAYERS_STATEMENT_MAX_WORDS = 20;
/** A reason: one sentence, 60 CJK characters or 30 words. */
export const LAYERS_REASON_MAX = 450;
export const LAYERS_REASON_MAX_CJK = 60;
export const LAYERS_REASON_MAX_WORDS = 30;
/** A label (题): 8 CJK characters or 3 words, found in its statement. */
export const LAYERS_LABEL_MAX = 80;
export const LAYERS_LABEL_MAX_CJK = 8;
export const LAYERS_LABEL_MAX_WORDS = 3;
export const LAYERS_NOT_GIVEN_MAX = 300;
export const LAYERS_KEY_TERM_MAX = 40;
export const LAYERS_KEY_TERMS_PER_ITEM = 2;
/** Evidence sentences of a note: 1 to 2, up to 3 in a paragraph of 7 or more. */
export const LAYERS_EVIDENCE_SENTENCES = 2;
export const LAYERS_EVIDENCE_SENTENCES_LONG = 3;
export const LAYERS_LONG_PARAGRAPH_SENTENCES = 7;
/** Up to three sentence ranges, and a caption's own figure or table. */
export const LAYERS_EVIDENCE_PER_POINT = 4;
/** Figures and tables of its section a note may name (`see`). */
export const LAYERS_SEE_MAX = 3;
export const LAYERS_DIGEST_UNITS = 6;
/** The trunk of the whole document: 3 to 5 notes. */
export const LAYERS_PRIMARY_MIN = 3;
export const LAYERS_PRIMARY_MAX = 5;
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
/** A section is asked in parts above 40 paragraphs or 12,000 code points (spec 10.3). */
export const LAYERS_PART_UNITS = 40;
export const LAYERS_PART_CODE_POINTS = 12_000;
/** A translated digest text may run longer than its original. */
export const LAYERS_TRANSLATION_TEXT_MAX = 1200;
/** What a note is (spec 10.2): 背景、问题、方法、结果、分析、结论、局限. */
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
/** How a note refers on (spec 10.2): 见、承接、依据、解释、总结、引申自. `see` points at figures and tables only. */
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

/** A place in the proofread text that supports a note (spec 10.2). */
export type LayersEvidence =
  | {
      readonly kind: "sentence";
      /** The translation unit (spec 9.2) the sentences belong to. */
      readonly unit_id: string;
      /** Consecutive sentences, UTF-8 half-open in the fixed Markdown. */
      readonly start_utf8: number;
      readonly end_utf8: number;
    }
  | {
      readonly kind: "block";
      /** A figure, scheme or table object of `layout.figure_groups`. */
      readonly segment_id: string;
    };
/** A relation's target: another note by number, or a figure or table. */
export type LayersRelationTarget =
  | { readonly kind: "point"; readonly number: number }
  | { readonly kind: "block"; readonly segment_id: string };
export interface LayersRelation {
  readonly word: LayersRelationWord;
  readonly targets: readonly LayersRelationTarget[];
}
/** One paragraph's note (批语). */
export interface LayersPoint {
  /** From 1 in reading order; the interface names a note by its paragraph. */
  readonly number: number;
  /** The paragraph (translation unit) it annotates. */
  readonly unit_id: string;
  readonly statement: string;
  /** Reads on from the statement; null for a one-sentence paragraph or when dropped. */
  readonly reason: string | null;
  /** Its sentence evidence, and a caption's own figure or table last. */
  readonly evidence: readonly LayersEvidence[];
  readonly key_terms: readonly string[];
  /** The paragraph's section; null when the paper has no headings. */
  readonly section_id: string | null;
  /** One of the 3 to 5 notes of the document's trunk. */
  readonly primary: boolean;
  /** The topic, copied from the statement; null when dropped. */
  readonly label: string | null;
  /** null when the model gave none of the fixed kinds. */
  readonly kind: LayersPointKind | null;
  readonly relations: readonly LayersRelation[];
  /** A primary note's first evidence, set by the program; null on the others. */
  readonly basis: LayersEvidence | null;
}
/** A section's line (节旨): what the section establishes in the paper. */
export interface LayersSectionLine {
  /** null only when the paper has no titled section. */
  readonly section_id: string | null;
  readonly statement: string;
  readonly label: string | null;
}
/** A place named in the reading advice: the exact words and what they point to. */
export interface LayersPlace {
  readonly text: string;
  readonly target:
    | { readonly kind: "section"; readonly segment_id: string }
    | { readonly kind: "block"; readonly segment_id: string };
}
export interface LayersDigest {
  /** Two or three sentences: the object, the method, the conclusion. Never empty. */
  readonly summary: {
    readonly text: string;
    readonly units: readonly string[];
    readonly key_terms: readonly string[];
  };
  /** 0 to 5 limitations the authors state. */
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
/** What the checks dropped (spec 10.3), by item. */
export interface LayersDropped {
  /** Paragraphs whose part got no valid answer, or that the answer left out. */
  readonly unanswered: number;
  /** Notes dropped whole: an overlong statement, or no evidence left. */
  readonly points: number;
  readonly evidence: number;
  readonly key_terms: number;
  readonly kinds: number;
  readonly labels: number;
  readonly reasons: number;
  readonly see: number;
  /** Section lines empty, overlong or not given. */
  readonly sections: number;
  readonly relations: number;
  readonly primary: number;
  readonly digest_units: number;
  readonly data: number;
  readonly places: number;
  readonly limits: number;
}
/** A note written in the target language (spec 10.5). */
export interface LayersTranslatedPoint {
  readonly statement: string;
  readonly reason: string | null;
  readonly label: string | null;
  readonly key_terms: readonly string[];
  /**
   * By index of the note's evidence: a UTF-8 half-open range inside the
   * unit's stored translation, or null (a block, or not confirmed).
   */
  readonly evidence: readonly ({
    readonly start_utf8: number;
    readonly end_utf8: number;
  } | null)[];
}
export interface LayersTranslatedLine {
  readonly statement: string;
  readonly label: string | null;
}
/** A digest text written in the target language and its own key terms. */
export interface LayersTranslatedText {
  readonly text: string | null;
  readonly key_terms: readonly string[];
}
/**
 * The translation part (spec 10.5), written directly in the target language
 * and bound to one stored translation file by its sha256. Arrays follow the
 * notes, section lines, limits, places and data rows by index; null where a
 * text got no version. Kinds, the trunk, relations, data values and sources
 * are the original's.
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
      /** Each place's words, found in the advice's version. */
      readonly places: readonly (string | null)[];
    };
  };
  readonly sections: readonly (LayersTranslatedLine | null)[];
  readonly points: readonly (LayersTranslatedPoint | null)[];
  /** The `quantity` of each data row. */
  readonly data: readonly (string | null)[];
  readonly dropped: {
    readonly points: number;
    readonly sections: number;
    readonly reasons: number;
    readonly labels: number;
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
  readonly sections: readonly LayersSectionLine[];
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
const sameEvidence = (a: LayersEvidence, b: LayersEvidence) =>
  a.kind === "block"
    ? b.kind === "block" && a.segment_id === b.segment_id
    : b.kind === "sentence" &&
      a.unit_id === b.unit_id &&
      a.start_utf8 === b.start_utf8 &&
      a.end_utf8 === b.end_utf8;
const segmentTarget = <K extends string>(v: unknown, kinds: readonly K[]) => {
  const r = exact(v, ["kind", "segment_id"]);
  if (!kinds.includes(r.kind as K)) fail();
  return { kind: r.kind as K, segment_id: id(r.segment_id) };
};
const nullableTexts = (v: unknown, length: number, max: number) => {
  const out = list(v, length, (x) => text(x, max, true));
  if (out.length !== length) fail();
  return out;
};
const CJK =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
/**
 * A length rule of spec 10.2: a text with CJK characters counts those, any
 * other text its whitespace-separated words; never more than `max` code
 * points, never empty.
 */
export function layersTextFits(
  value: string,
  cjkMax: number,
  wordsMax: number,
  max: number,
): boolean {
  const t = value.trim();
  if (!t || codePoints(t) > max) return false;
  const cjk = t.match(CJK);
  if (cjk) return cjk.length <= cjkMax;
  return t.split(/\s+/u).length <= wordsMax;
}
export const layersStatementFits = (value: string) =>
  layersTextFits(
    value,
    LAYERS_STATEMENT_MAX_CJK,
    LAYERS_STATEMENT_MAX_WORDS,
    LAYERS_STATEMENT_MAX,
  );
export const layersReasonFits = (value: string) =>
  layersTextFits(
    value,
    LAYERS_REASON_MAX_CJK,
    LAYERS_REASON_MAX_WORDS,
    LAYERS_REASON_MAX,
  );
/** A label: at most 3 words, or at most 8 CJK characters. */
export const layersLabelFits = (value: string) =>
  layersTextFits(
    value,
    LAYERS_LABEL_MAX_CJK,
    LAYERS_LABEL_MAX_WORDS,
    LAYERS_LABEL_MAX,
  );
const folded = (s: string) => s.replace(/\s+/gu, " ").trim().toLowerCase();
/**
 * A label is copied from its statement (spec 10.2): found in it verbatim,
 * whitespace runs and Latin case aside.
 */
export function layersLabelInStatement(
  statement: string,
  label: string,
): boolean {
  const l = folded(label);
  return !!l && folded(statement).includes(l);
}
function line(v: unknown) {
  const r = exact(v, ["statement", "label"]);
  const statement = text(r.statement, LAYERS_STATEMENT_MAX, false) as string;
  const label = text(r.label, LAYERS_LABEL_MAX, true);
  if (
    !layersStatementFits(statement) ||
    (label !== null &&
      (!layersLabelFits(label) || !layersLabelInStatement(statement, label)))
  )
    fail();
  return { statement, label };
}

/** The `schema_version` of a stored layers file, without checking the rest. */
export function documentLayersFileVersion(value: unknown): number | null {
  const v =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as { schema_version?: unknown }).schema_version
      : undefined;
  return Number.isSafeInteger(v) ? (v as number) : null;
}

const DROPPED_KEYS = [
  "unanswered",
  "points",
  "evidence",
  "key_terms",
  "kinds",
  "labels",
  "reasons",
  "see",
  "sections",
  "relations",
  "primary",
  "digest_units",
  "data",
  "places",
  "limits",
] as const;
const PART_DROPPED_KEYS = [
  "points",
  "sections",
  "reasons",
  "labels",
  "key_terms",
  "evidence",
  "places",
] as const;
const counts = <K extends string>(v: unknown, keys: readonly K[]) => {
  const r = exact(v, keys);
  return Object.freeze(
    Object.fromEntries(keys.map((k) => [k, count(r[k])])),
  ) as Readonly<Record<K, number>>;
};

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
    "sections",
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
  const sections = list(r.sections, LAYERS_POINTS_MAX, (x) => {
    const o = record(x);
    const { section_id, ...rest } = o;
    if (!Object.hasOwn(o, "section_id")) fail();
    return Object.freeze({
      section_id: section_id === null ? null : id(section_id),
      ...line(rest),
    });
  });
  if (new Set(sections.map((x) => x.section_id)).size !== sections.length)
    fail();
  const points = list(r.points, LAYERS_POINTS_MAX, (x) => {
    const p = exact(x, [
      "number",
      "unit_id",
      "statement",
      "reason",
      "evidence",
      "key_terms",
      "section_id",
      "primary",
      "label",
      "kind",
      "relations",
      "basis",
    ]);
    const unit_id = id(p.unit_id);
    const ev = list(p.evidence, LAYERS_EVIDENCE_PER_POINT, evidence);
    const sentences = ev.filter((e) => e.kind === "sentence");
    // Sentence evidence lies in the note's own paragraph; a block is last.
    if (
      !sentences.length ||
      sentences.length > LAYERS_EVIDENCE_SENTENCES_LONG ||
      sentences.some((e) => e.unit_id !== unit_id) ||
      ev.length - sentences.length > 1 ||
      (ev.length > sentences.length && ev.at(-1)!.kind !== "block") ||
      typeof p.primary !== "boolean"
    )
      fail();
    if (
      p.kind !== null &&
      !LAYERS_POINT_KINDS.includes(p.kind as LayersPointKind)
    )
      fail();
    const statement = text(p.statement, LAYERS_STATEMENT_MAX, false) as string;
    const reason = text(p.reason, LAYERS_REASON_MAX, true);
    const label = text(p.label, LAYERS_LABEL_MAX, true);
    if (
      !layersStatementFits(statement) ||
      (reason !== null && !layersReasonFits(reason)) ||
      (label !== null &&
        (!layersLabelFits(label) || !layersLabelInStatement(statement, label)))
    )
      fail();
    const basis = p.basis === null ? null : evidence(p.basis);
    // The basis is a primary note's first evidence (spec 10.2).
    if (p.primary ? !basis || !sameEvidence(basis, ev[0]!) : basis !== null)
      fail();
    return Object.freeze({
      number: count(p.number, 1, LAYERS_POINTS_MAX),
      unit_id,
      statement,
      reason,
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
            (rel.word === "see"
              ? targets.length > LAYERS_SEE_MAX ||
                targets.some((t) => t.kind !== "block")
              : targets.some((t) => t.kind !== "point"))
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
    points.some((p, i) => p.number !== i + 1) ||
    new Set(points.map((p) => p.unit_id)).size !== points.length ||
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
  const dropped = counts(r.dropped, DROPPED_KEYS) as LayersDropped;
  let translation: LayersTranslationPart | null = null;
  if (r.translation !== null) {
    const t = exact(r.translation, [
      "target_language",
      "translation_sha256",
      "model",
      "prompt_version",
      "digest",
      "sections",
      "points",
      "data",
      "dropped",
    ]);
    if (!isTranslationLanguage(t.target_language)) fail();
    const td = exact(t.digest, ["summary", "limits", "advice"]);
    const ts = exact(td.summary, ["text", "key_terms"]);
    const ta = exact(td.advice, ["text", "key_terms", "places"]);
    const summary = {
      text: text(ts.text, LAYERS_TRANSLATION_TEXT_MAX, true),
      key_terms: terms(ts.key_terms),
    };
    const adviceText = text(ta.text, LAYERS_TRANSLATION_TEXT_MAX, true);
    const adviceKeyTerms = terms(ta.key_terms);
    if (
      (summary.text === null && summary.key_terms.length) ||
      (adviceText === null && adviceKeyTerms.length) ||
      (digestValue.advice.text === null && adviceText !== null)
    )
      fail();
    const tl = list(t.sections, LAYERS_POINTS_MAX, (x) =>
      x === null ? null : Object.freeze(line(x)),
    );
    const tp = list(t.points, LAYERS_POINTS_MAX, (x) => x);
    if (tl.length !== sections.length || tp.length !== points.length) fail();
    translation = Object.freeze({
      target_language: t.target_language,
      translation_sha256: digest(t.translation_sha256),
      model: text(t.model, 256, false) as string,
      prompt_version: text(t.prompt_version, 128, false) as string,
      digest: Object.freeze({
        summary: Object.freeze(summary),
        limits: nullableTexts(
          td.limits,
          digestValue.limits.length,
          LAYERS_TRANSLATION_TEXT_MAX,
        ),
        advice: Object.freeze({
          text: adviceText,
          key_terms: adviceKeyTerms,
          places: nullableTexts(
            ta.places,
            digestValue.advice.places.length,
            LAYERS_TRANSLATION_TEXT_MAX,
          ),
        }),
      }),
      sections: Object.freeze(tl),
      points: Object.freeze(
        tp.map((x, i) => {
          if (x === null) return null;
          const p = exact(x, [
            "statement",
            "reason",
            "label",
            "key_terms",
            "evidence",
          ]);
          const statement = text(
            p.statement,
            LAYERS_STATEMENT_MAX,
            false,
          ) as string;
          const reason = text(p.reason, LAYERS_REASON_MAX, true);
          const label = text(p.label, LAYERS_LABEL_MAX, true);
          if (
            !layersStatementFits(statement) ||
            (reason !== null && !layersReasonFits(reason)) ||
            (label !== null &&
              (!layersLabelFits(label) ||
                !layersLabelInStatement(statement, label)))
          )
            fail();
          const ev = list(p.evidence, LAYERS_EVIDENCE_PER_POINT, (e) =>
            e === null ? null : byteRange(e),
          );
          if (
            ev.length !== points[i]!.evidence.length ||
            ev.some(
              (e, k) =>
                e !== null && points[i]!.evidence[k]!.kind !== "sentence",
            )
          )
            fail();
          return Object.freeze({
            statement,
            reason,
            label,
            key_terms: terms(p.key_terms),
            evidence: Object.freeze(ev),
          });
        }),
      ),
      data: nullableTexts(t.data, data.length, LAYERS_TRANSLATION_TEXT_MAX),
      dropped: counts(t.dropped, PART_DROPPED_KEYS),
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
    sections: Object.freeze(sections),
    points: Object.freeze(points),
    data: Object.freeze(data),
    model: text(r.model, 256, false) as string,
    prompt_version: text(r.prompt_version, 128, false) as string,
    dropped,
    translation,
  });
}
function record(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
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
