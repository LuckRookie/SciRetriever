import {
  TRANSLATION_LANGUAGES,
  type TranslationLanguage,
} from "@sciretriever/contracts";
import { preferences } from "../../../data/preferences.js";

/**
 * The language the reader reads translations in (ADR 0072): one choice in
 * this browser, shared by every paper; null until chosen, and then the
 * library's own language is read.
 */
const KEY = "sciretriever:reader:translation-language:v1";
const CODES = TRANSLATION_LANGUAGES.map((l) => l.code) as readonly string[];
let chosen: TranslationLanguage | null | undefined;
const listeners = new Set<() => void>();
export const translationLanguage = {
  get(): TranslationLanguage | null {
    if (chosen === undefined) {
      const stored = preferences.read(KEY);
      chosen =
        stored && CODES.includes(stored)
          ? (stored as TranslationLanguage)
          : null;
    }
    return chosen;
  },
  set(next: TranslationLanguage) {
    if (next === translationLanguage.get()) return;
    chosen = next;
    preferences.write(KEY, next);
    for (const listener of listeners) listener();
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
/** A language's own name, as the menu writes it. */
export const languageName = (code: string) =>
  TRANSLATION_LANGUAGES.find((l) => l.code === code)?.label ?? code;
