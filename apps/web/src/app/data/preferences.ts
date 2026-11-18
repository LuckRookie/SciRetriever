/** Browser-only preferences for the current React interface. */
const prefix = "sciretriever:react:";
export const preferences = {
  read(key: string): string | null {
    try {
      return localStorage.getItem(prefix + key);
    } catch {
      return null;
    }
  },
  write(key: string, value: string): void {
    try {
      localStorage.setItem(prefix + key, value);
    } catch {
      /* Storage is optional; controlled components retain session state. */
    }
  },
};
/**
 * Design core “主题”: seven reading themes. 纸墨 and 夜读 keep the ids of the
 * light and dark palettes they replace.
 */
export const THEMES = [
  { id: "light", name: "纸墨", time: "day" },
  { id: "oldbook", name: "旧书", time: "day" },
  { id: "xuan", name: "宣纸", time: "day" },
  { id: "bean", name: "豆绿", time: "day" },
  { id: "eink", name: "墨水屏", time: "day" },
  { id: "dark", name: "夜读", time: "night" },
  { id: "candle", name: "烛光", time: "night" },
] as const;
export type ThemeId = (typeof THEMES)[number]["id"];
/** A theme, or “跟随系统”: the day theme in light mode, the night one in dark. */
export type Theme = ThemeId | "system";
export type ThemeTime = "day" | "night";
export interface ThemeChoice {
  theme: Theme;
  day: ThemeId;
  night: ThemeId;
}
export const THEME_KEY = "sciretriever:theme:v1";
export const THEME_TIME_KEYS: Readonly<Record<ThemeTime, string>> = {
  day: "sciretriever:theme:day:v1",
  night: "sciretriever:theme:night:v1",
};
const DEFAULT_TIME: Readonly<Record<ThemeTime, ThemeId>> = {
  day: "light",
  night: "dark",
};
/** The themes this set replaced: 蓝白 and 暖白 become 纸墨, 墨绿 becomes 豆绿. */
const RETIRED: Readonly<Record<string, ThemeId>> = {
  warm: "light",
  green: "bean",
};
const themeIds: ReadonlySet<string> = new Set(THEMES.map((t) => t.id));
export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && themeIds.has(value);
}
/** Reads a stored theme; a retired name is rewritten once as its successor. */
function readThemeKey(key: string): ThemeId | "system" | null {
  const value = preferences.read(key);
  if (value === "system" || isThemeId(value)) return value;
  const next = value ? RETIRED[value] : undefined;
  if (!next) return null;
  preferences.write(key, next);
  return next;
}
export function readTheme(): Theme {
  return readThemeKey(THEME_KEY) ?? "light";
}
export function readThemeChoice(): ThemeChoice {
  const time = (t: ThemeTime) => {
    const value = readThemeKey(THEME_TIME_KEYS[t]);
    return value && value !== "system" ? value : DEFAULT_TIME[t];
  };
  return { theme: readTheme(), day: time("day"), night: time("night") };
}
/** The theme on screen now: an explicit choice, or the system's day or night. */
export function resolveTheme(choice: ThemeChoice, dark: boolean): ThemeId {
  return choice.theme === "system"
    ? dark
      ? choice.night
      : choice.day
    : choice.theme;
}
/** Puts the chosen theme on the root; “跟随系统” follows the OS as it changes. */
export function bindTheme(choice: ThemeChoice | Theme): () => void {
  const value: ThemeChoice =
    typeof choice === "string"
      ? { theme: choice, day: DEFAULT_TIME.day, night: DEFAULT_TIME.night }
      : choice;
  const media = matchMedia("(prefers-color-scheme: dark)");
  const apply = () => {
    document.documentElement.dataset.theme = resolveTheme(value, media.matches);
  };
  apply();
  if (value.theme !== "system") return () => {};
  media.addEventListener("change", apply);
  return () => media.removeEventListener("change", apply);
}
/** “跟随系统” first, then the seven themes (design core “主题”). */
export const themeOptions: readonly { value: Theme; label: string }[] = [
  { value: "system", label: "跟随系统" },
  ...THEMES.map((t) => ({ value: t.id, label: t.name })),
];
