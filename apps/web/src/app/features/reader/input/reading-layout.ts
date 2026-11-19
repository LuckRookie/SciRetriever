import { preferences } from "../../../data/preferences.js";

/**
 * “排版” (plan 25 block 30): the full text's line length and line spacing,
 * one choice each in this browser that every paper shares, as the reading
 * size is (reading-experience 4.5). Settings → 外观 shows the same line
 * length as “阅读行宽”.
 */
export type Measure = "narrow" | "medium" | "wide";
export type Leading = "tight" | "medium" | "loose";
/** The text column in em: 34 em is spec 1.1's column (适中). */
export const MEASURE_EM: Readonly<Record<Measure, number>> = {
  narrow: 30,
  medium: 34,
  wide: 40,
};
/** Line height as a multiple of spec 2.2's (1.85 Chinese, 1.7 Latin). */
export const LEADING_SCALE: Readonly<Record<Leading, number>> = {
  tight: 0.9,
  medium: 1,
  loose: 1.12,
};
export const MEASURE_LABELS: Readonly<Record<Measure, string>> = {
  narrow: "窄",
  medium: "适中",
  wide: "宽",
};
export const LEADING_LABELS: Readonly<Record<Leading, string>> = {
  tight: "紧",
  medium: "适中",
  loose: "松",
};
const KEYS = {
  measure: "sciretriever:reading:measure:v1",
  leading: "sciretriever:reading:leading:v1",
} as const;
/** The default width that settings kept before the redesign, and its successors. */
const RETIRED_WIDTH = "sciretriever:reading:width:v1";
const RETIRED_MEASURE: Readonly<Record<string, Measure>> = {
  comfortable: "medium",
  wide: "wide",
  full: "wide",
};
/** A line length never chosen takes the retired default width's place, once. */
function migrate(): string | null {
  const old = preferences.read(RETIRED_WIDTH);
  if (old === null) return null;
  preferences.remove(RETIRED_WIDTH);
  const measure = Object.hasOwn(RETIRED_MEASURE, old)
    ? RETIRED_MEASURE[old]!
    : null;
  if (measure) preferences.write(KEYS.measure, measure);
  return measure;
}
export interface ReadingLayout {
  measure: Measure;
  leading: Leading;
}
const read = (): ReadingLayout => {
  const measure = preferences.read(KEYS.measure) ?? migrate(),
    leading = preferences.read(KEYS.leading);
  return {
    measure:
      measure && Object.hasOwn(MEASURE_EM, measure)
        ? (measure as Measure)
        : "medium",
    leading:
      leading && Object.hasOwn(LEADING_SCALE, leading)
        ? (leading as Leading)
        : "medium",
  };
};
let value: ReadingLayout | null = null;
const listeners = new Set<() => void>();
export const readingLayout = {
  get(): ReadingLayout {
    value ??= read();
    return value;
  },
  set(patch: Partial<ReadingLayout>) {
    const next = { ...readingLayout.get(), ...patch };
    if (next.measure === value?.measure && next.leading === value.leading)
      return;
    value = next;
    preferences.write(KEYS.measure, next.measure);
    preferences.write(KEYS.leading, next.leading);
    for (const listener of listeners) listener();
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
