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
export type Theme = "light" | "dark" | "green" | "warm" | "system";
export function readTheme(): Theme {
  const value = preferences.read("sciretriever:theme:v1");
  return value === "dark" ||
    value === "green" ||
    value === "warm" ||
    value === "system"
    ? value
    : "light";
}
/** System preference selects one of the existing blue light/dark palettes. */
export function bindTheme(theme: Theme): () => void {
  const media = matchMedia("(prefers-color-scheme: dark)");
  const apply = () => {
    document.documentElement.dataset.theme =
      theme === "system" ? (media.matches ? "dark" : "light") : theme;
  };
  apply();
  if (theme !== "system") return () => {};
  media.addEventListener("change", apply);
  return () => media.removeEventListener("change", apply);
}
