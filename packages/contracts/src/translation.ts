import { ContractValidationError, parseLiteratureId } from "./index.js";

/** Reader translation (ADR 0049): request, result and the closed language list. */
export const TRANSLATION_LANGUAGES = [
  { code: "zh-Hans", label: "简体中文", name: "Simplified Chinese" },
  { code: "zh-Hant", label: "繁體中文", name: "Traditional Chinese" },
  { code: "en", label: "English", name: "English" },
  { code: "ja", label: "日本語", name: "Japanese" },
  { code: "ko", label: "한국어", name: "Korean" },
  { code: "de", label: "Deutsch", name: "German" },
  { code: "fr", label: "Français", name: "French" },
  { code: "es", label: "Español", name: "Spanish" },
  { code: "ru", label: "Русский", name: "Russian" },
] as const;
export type TranslationLanguage =
  (typeof TRANSLATION_LANGUAGES)[number]["code"];
export const TRANSLATION_DEFAULT_LANGUAGE: TranslationLanguage = "zh-Hans";
/** Longest selection sent at once, in Unicode code points. */
export const TRANSLATION_MAX_CHARS = 4000;
/**
 * Sentence cache entries. Archive translation puts every finished unit here
 * first so an interrupted step resumes without asking again: a long paper has
 * about 1,500 units and a few papers translate at once (ADR 0068).
 */
export const TRANSLATION_CACHE_LIMIT = 20_000;

export interface TranslationRequest {
  readonly text: string;
  readonly target_language: TranslationLanguage;
  /** A model registered when the service started; null uses analyze.model. */
  readonly model: string | null;
  /** Translate again even when the cache holds this sentence. */
  readonly force: boolean;
}
export interface TranslationResult {
  readonly translation: string;
  readonly target_language: TranslationLanguage;
  /** The model that produced this translation, possibly in an earlier request. */
  readonly model: string;
  readonly cached: boolean;
}
export interface TranslationCatalog {
  readonly models: readonly string[];
  readonly default_model: string | null;
  readonly languages: readonly {
    readonly code: TranslationLanguage;
    readonly label: string;
  }[];
  readonly max_chars: number;
}

export class TranslationInputError extends Error {
  readonly code = "translation-input-invalid" as const;
  constructor() {
    super("translation input invalid");
    this.name = "TranslationInputError";
  }
}
const LANGUAGE_CODES = new Set<string>(
  TRANSLATION_LANGUAGES.map((l) => l.code),
);
export function isTranslationLanguage(
  value: unknown,
): value is TranslationLanguage {
  return typeof value === "string" && LANGUAGE_CODES.has(value);
}
export function parseTranslationRequest(value: unknown): TranslationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TranslationInputError();
  const r = value as Record<string, unknown>;
  if (
    Object.keys(r).sort().join() !== "force,model,target_language,text" ||
    typeof r.text !== "string" ||
    !r.text.trim() ||
    [...r.text].length > TRANSLATION_MAX_CHARS ||
    !isTranslationLanguage(r.target_language) ||
    (r.model !== null &&
      (typeof r.model !== "string" || !r.model || r.model.length > 256)) ||
    typeof r.force !== "boolean"
  )
    throw new TranslationInputError();
  return {
    text: r.text,
    target_language: r.target_language,
    model: r.model as string | null,
    force: r.force,
  };
}

/** Full-text translation (ADR 0051): one page of translated blocks placed by their regions. */
export const FULLTEXT_TRANSLATION_LIMIT = 50;
export interface FullTextBlock {
  readonly leaf_id: string;
  readonly type: string;
  readonly role: string;
  /** 0–1000 page coordinates [x0, y0, x1, y1]; null when the parser gave none. */
  readonly region: readonly [number, number, number, number] | null;
  /** "text-layer" when the region is missing or lies over a figure (ADR 0051 §3). */
  readonly placement: "region" | "text-layer";
  readonly source: string;
  /** null when the model did not return this block after a second request. */
  readonly translation: string | null;
}
export interface FullTextPage {
  readonly literature_id: string;
  readonly page_index: number;
  readonly target_language: TranslationLanguage;
  readonly model: string | null;
  /** The page came from the saved translation without a model request. */
  readonly saved: boolean;
  readonly blocks: readonly FullTextBlock[];
  /** The stored translation the blocks come from (ADR 0068); added, never required. */
  readonly state?: DocumentTranslationState;
}
export interface FullTextSummary {
  readonly literature_id: string;
  readonly target_language: TranslationLanguage;
  readonly page_count: number;
  readonly pages: readonly {
    readonly page_index: number;
    readonly blocks: number;
    readonly saved: boolean;
  }[];
  /** The stored translation the pages come from (ADR 0068); added, never required. */
  readonly state?: DocumentTranslationState;
}
export interface FullTextPageRequest {
  readonly literature_id: string;
  readonly page_index: number;
  /** Absent reads the library default language (ADR 0072). */
  readonly target_language?: TranslationLanguage;
  readonly model: string | null;
  readonly force: boolean;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
export function parseFullTextPageRequest(value: unknown): FullTextPageRequest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TranslationInputError();
  const r = value as Record<string, unknown>;
  const languaged = Object.hasOwn(r, "target_language");
  if (
    Object.keys(r).sort().join() !==
      (languaged
        ? "force,literature_id,model,page_index,target_language"
        : "force,literature_id,model,page_index") ||
    typeof r.literature_id !== "string" ||
    !UUID.test(r.literature_id) ||
    !Number.isSafeInteger(r.page_index) ||
    (r.page_index as number) < 0 ||
    (r.page_index as number) > 10000 ||
    (languaged && !isTranslationLanguage(r.target_language)) ||
    (r.model !== null &&
      (typeof r.model !== "string" || !r.model || r.model.length > 256)) ||
    typeof r.force !== "boolean"
  )
    throw new TranslationInputError();
  return {
    literature_id: r.literature_id,
    page_index: r.page_index as number,
    ...(languaged
      ? { target_language: r.target_language as TranslationLanguage }
      : {}),
    model: r.model as string | null,
    force: r.force,
  };
}

/**
 * Stored full-text translation (ADR 0068, document spec 9). One immutable file
 * per literature, primary PDF, proofread content version and language; the
 * catalog registers its identity and counts only.
 */
export const DOCUMENT_TRANSLATION_PROMPT_VERSION = "document-translation-v2";
/**
 * How each translation language writes the label of a figure, a table and a
 * scheme before its number (“图 8”, “表 3”), one space between. The document
 * translation prompt (v2) asks for these, in captions and in the text. The
 * reader shows what was stored and rewrites nothing.
 */
export const TRANSLATION_FIGURE_WORDS: Readonly<
  Record<
    TranslationLanguage,
    Readonly<Record<"figure" | "table" | "scheme", string>>
  >
> = {
  "zh-Hans": { figure: "图", table: "表", scheme: "方案" },
  "zh-Hant": { figure: "圖", table: "表", scheme: "方案" },
  ja: { figure: "図", table: "表", scheme: "スキーム" },
  ko: { figure: "그림", table: "표", scheme: "스킴" },
  en: { figure: "Fig.", table: "Table", scheme: "Scheme" },
  de: { figure: "Abb.", table: "Tab.", scheme: "Schema" },
  fr: { figure: "Fig.", table: "Tableau", scheme: "Schéma" },
  es: { figure: "Fig.", table: "Tabla", scheme: "Esquema" },
  ru: { figure: "Рис.", table: "Таблица", scheme: "Схема" },
};
/** Initial batch limits (plan 28, 8.8 adjusts them after real papers). */
export const TRANSLATION_BATCH_MAX_CODE_POINTS = 6000;
export const TRANSLATION_BATCH_MAX_UNITS = 60;
export type DocumentTranslationStatus =
  | "complete"
  | "partial"
  | "same-language";
export type DocumentTranslationState =
  | "none"
  | "stale"
  | DocumentTranslationStatus;
export interface DocumentTranslationUnit {
  /** The first segment (leaf) of the rendered paragraph. */
  readonly unit_id: string;
  /** Every segment of the paragraph, in order; a merged paragraph has several. */
  readonly segment_ids: readonly string[];
  /** SHA-256 of the unit's source text (UTF-8, not normalized). */
  readonly source_sha256: string;
  /** null while missing. */
  readonly translation: string | null;
  readonly model: string | null;
  readonly prompt_version: string | null;
}
export interface DocumentTranslationFile {
  readonly schema_version: 1;
  readonly literature_id: string;
  readonly asset_id: string;
  readonly document_version_id: string;
  readonly annotation_id: string;
  /** archiveContentVersion(document_version_id, annotation_id). */
  readonly content_version: string;
  readonly target_language: TranslationLanguage;
  readonly status: DocumentTranslationStatus;
  readonly units: readonly DocumentTranslationUnit[];
}
export interface DocumentTranslationSummary {
  readonly target_language: TranslationLanguage;
  readonly state: DocumentTranslationState;
  readonly units: number;
  readonly translated: number;
}
const DIGEST = /^[0-9a-f]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
function exactRecord(value: unknown, keys: readonly string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== [...keys].sort().join()
  )
    throw new ContractValidationError();
  return value as Record<string, unknown>;
}
const nullableText = (value: unknown, max: number) => {
  if (value === null) return null;
  if (typeof value !== "string" || !value || value.length > max)
    throw new ContractValidationError();
  return value;
};
export function parseDocumentTranslationFile(
  value: unknown,
): DocumentTranslationFile {
  const r = exactRecord(value, [
    "schema_version",
    "literature_id",
    "asset_id",
    "document_version_id",
    "annotation_id",
    "content_version",
    "target_language",
    "status",
    "units",
  ]);
  if (
    r.schema_version !== 1 ||
    ![r.literature_id, r.asset_id, r.document_version_id].every(
      (v) => typeof v === "string" && ID.test(v),
    ) ||
    ![r.annotation_id, r.content_version].every(
      (v) => typeof v === "string" && DIGEST.test(v),
    ) ||
    !isTranslationLanguage(r.target_language) ||
    !["complete", "partial", "same-language"].includes(String(r.status)) ||
    !Array.isArray(r.units) ||
    r.units.length > 100_000
  )
    throw new ContractValidationError();
  const seen = new Set<string>();
  const units = r.units.map((item): DocumentTranslationUnit => {
    const u = exactRecord(item, [
      "unit_id",
      "segment_ids",
      "source_sha256",
      "translation",
      "model",
      "prompt_version",
    ]);
    if (
      typeof u.unit_id !== "string" ||
      !ID.test(u.unit_id) ||
      seen.has(u.unit_id) ||
      !Array.isArray(u.segment_ids) ||
      !u.segment_ids.length ||
      u.segment_ids[0] !== u.unit_id ||
      u.segment_ids.some((s) => typeof s !== "string" || !ID.test(s)) ||
      typeof u.source_sha256 !== "string" ||
      !DIGEST.test(u.source_sha256)
    )
      throw new ContractValidationError();
    seen.add(u.unit_id);
    const translation =
      u.translation === null ? null : nullableText(u.translation, 1_000_000);
    const model = nullableText(u.model, 256),
      prompt = nullableText(u.prompt_version, 128);
    if (
      (translation === null) !== (model === null) ||
      (model === null) !== (prompt === null)
    )
      throw new ContractValidationError();
    return {
      unit_id: u.unit_id,
      segment_ids: Object.freeze([...(u.segment_ids as string[])]),
      source_sha256: u.source_sha256,
      translation,
      model,
      prompt_version: prompt,
    };
  });
  const translated = units.filter((u) => u.translation !== null).length;
  if (
    (r.status === "same-language" && translated !== 0) ||
    (r.status === "complete" && translated !== units.length) ||
    (r.status === "partial" && translated === units.length)
  )
    throw new ContractValidationError();
  return Object.freeze({
    schema_version: 1,
    literature_id: r.literature_id as string,
    asset_id: r.asset_id as string,
    document_version_id: r.document_version_id as string,
    annotation_id: r.annotation_id as string,
    content_version: r.content_version as string,
    target_language: r.target_language,
    status: r.status as DocumentTranslationStatus,
    units: Object.freeze(units),
  });
}

/**
 * Translate one paper into a language on request (ADR 0072, document spec
 * 9.6.1): maintenance operation `document-translate`. It runs only the
 * archive `translate` step, as a task.
 */
export interface DocumentTranslateRequest {
  readonly literature_id: string;
  readonly target_language: TranslationLanguage;
}
export interface DocumentTranslateResult {
  readonly literature_id: string;
  readonly target_language: TranslationLanguage;
  /** `skipped`: this content already has the language (complete or same-language). */
  readonly outcome: "queued" | "skipped";
  /** The state of the stored translation in the language when skipped. */
  readonly state: DocumentTranslationState | null;
  /** The queued task (a `build-archive` task with `translate_only`), or null when skipped. */
  readonly job: { readonly job_id: string } | null;
}
export function parseDocumentTranslateRequest(
  value: unknown,
): DocumentTranslateRequest {
  const r = exactRecord(value, ["literature_id", "target_language"]);
  if (!isTranslationLanguage(r.target_language))
    throw new ContractValidationError();
  return Object.freeze({
    literature_id: String(parseLiteratureId(r.literature_id)),
    target_language: r.target_language,
  });
}
