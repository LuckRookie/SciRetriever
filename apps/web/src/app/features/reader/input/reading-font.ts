import { preferences } from "../../../data/preferences.js";
import { textSize } from "./scale.js";

/**
 * The full text's reading size (reading-experience 4.5): one value in this
 * browser that every paper shares, the same the settings page shows as
 * “默认阅读字号”. Written 300 ms after the last change, and at once when the
 * page is hidden or closed.
 */
const KEY = "sciretriever:reading:font:v1";
let size: number | null = null,
  timer: ReturnType<typeof setTimeout> | undefined,
  bound = false;
const listeners = new Set<() => void>();
const flush = () => {
  if (timer === undefined || size === null) return;
  clearTimeout(timer);
  timer = undefined;
  preferences.write(KEY, String(size));
};
export const readingFont = {
  get(): number {
    size ??= textSize(preferences.read(KEY));
    return size;
  },
  set(value: number, persist: "later" | "now" = "later") {
    const next = textSize(value, readingFont.get());
    if (next !== size) {
      size = next;
      for (const listener of listeners) listener();
    }
    if (!bound && typeof window !== "undefined") {
      bound = true;
      window.addEventListener("pagehide", flush);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") flush();
      });
    }
    clearTimeout(timer);
    timer = setTimeout(flush, persist === "now" ? 0 : 300);
    if (persist === "now") flush();
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
