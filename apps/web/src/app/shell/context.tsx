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
  /**
   * Spec 1.3: on the reader page the shell's top bar holds the navigation
   * button and the paper tabs; the reader puts its controls into this slot.
   */
  readerBar: HTMLElement | null;
  /** The top bar's width, which decides what it folds away. */
  readerBarWidth: number;
  /** Spec 1.7: focus mode, in which the top bar folds up and the side panel closes. */
  readerFocus: boolean;
  setReaderFocus(value: boolean): void;
  reading: ReadingState;
  theme: Theme;
  setTheme(value: Theme): void;
}
/** The reader announces its first drawn screen; page warming waits for it. */
export const READER_PAINTED = "sciretriever:reader-painted";
export const ShellContext = createContext<ShellState | null>(null);
export function useShell(): ShellState {
  const shell = useContext(ShellContext);
  if (!shell) throw new Error("ShellContext is missing");
  return shell;
}
