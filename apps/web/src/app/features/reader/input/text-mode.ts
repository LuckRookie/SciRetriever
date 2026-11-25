import type { DocumentTranslationSummary } from "@sciretriever/contracts";
import { preferences } from "../../../data/preferences.js";
import type { DocumentTextMode } from "../../../../reading/contract.js";

/**
 * How the full text is read (reading-experience 9): 原文, 译文 or 对照, one
 * choice in this browser that every paper shares.
 */
const KEY = "sciretriever:reader:text-mode:v1";
const MODES: readonly DocumentTextMode[] = [
  "original",
  "translation",
  "bilingual",
];
let mode: DocumentTextMode | null = null;
const listeners = new Set<() => void>();
export const textMode = {
  get(): DocumentTextMode {
    if (mode === null) {
      const stored = preferences.read(KEY);
      mode = MODES.includes(stored as DocumentTextMode)
        ? (stored as DocumentTextMode)
        : "original";
    }
    return mode;
  },
  set(next: DocumentTextMode) {
    if (next === textMode.get()) return;
    mode = next;
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
/** A paper has a translation to read: complete, or with some paragraphs missing. */
export const hasTranslation = (summary: DocumentTranslationSummary | null) =>
  summary?.state === "complete" || summary?.state === "partial";
/**
 * The reading shown for a paper: the one chosen, unless this paper has no
 * translation; then its original, and the choice stays as it was.
 */
export const shownTextMode = (
  chosen: DocumentTextMode,
  summary: DocumentTranslationSummary | null,
): DocumentTextMode => (hasTranslation(summary) ? chosen : "original");
