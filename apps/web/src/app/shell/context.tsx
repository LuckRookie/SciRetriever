import { createContext, useContext } from "react";
import type { ReaderMode } from "../data/url.js";
import type { ReadingState } from "../../reading/state.js";
import type { Theme } from "../data/preferences.js";
export interface ShellState {
  selected: ReadonlySet<string>;
  setSelected(value: ReadonlySet<string>): void;
  openPaper(
    id: string,
    mode?: ReaderMode,
    source?: Record<string, string>,
    title?: string,
  ): void;
  notify(message: string): void;
  reading: ReadingState;
  theme: Theme;
  setTheme(value: Theme): void;
}
export const ShellContext = createContext<ShellState | null>(null);
export function useShell(): ShellState {
  const shell = useContext(ShellContext);
  if (!shell) throw new Error("ShellContext is missing");
  return shell;
}
