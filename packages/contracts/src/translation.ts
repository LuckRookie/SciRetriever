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
export const TRANSLATION_CACHE_LIMIT = 1000;

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
}
export interface FullTextPageRequest {
  readonly literature_id: string;
  readonly page_index: number;
  readonly target_language: TranslationLanguage;
  readonly model: string | null;
  readonly force: boolean;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
export function parseFullTextPageRequest(value: unknown): FullTextPageRequest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TranslationInputError();
  const r = value as Record<string, unknown>;
  if (
    Object.keys(r).sort().join() !==
      "force,literature_id,model,page_index,target_language" ||
    typeof r.literature_id !== "string" ||
    !UUID.test(r.literature_id) ||
    !Number.isSafeInteger(r.page_index) ||
    (r.page_index as number) < 0 ||
    (r.page_index as number) > 10000 ||
    !isTranslationLanguage(r.target_language) ||
    (r.model !== null &&
      (typeof r.model !== "string" || !r.model || r.model.length > 256)) ||
    typeof r.force !== "boolean"
  )
    throw new TranslationInputError();
  return {
    literature_id: r.literature_id,
    page_index: r.page_index as number,
    target_language: r.target_language,
    model: r.model as string | null,
    force: r.force,
  };
}
