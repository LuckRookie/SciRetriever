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
