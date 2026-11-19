import { createContext, useContext } from "react";
import type { ReaderMode } from "../data/url.js";
import type { LiteratureChoice } from "../data/library.js";
import type { ReadingState } from "../../reading/state.js";
import type {
  Theme,
  ThemeChoice,
  ThemeId,
  ThemeTime,
} from "../data/preferences.js";
import type { CloseKind, PaperTab } from "./paper-tabs.js";
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
   * Page specs “入库 · 检索”: papers the library hands to citation expansion
   * as its seeds. They stay in the page, never in the address; the intake
   * page takes them once (`takeCitationSeeds`).
   */
  citationSeeds: readonly LiteratureChoice[] | null;
  /** Opens 入库 → 检索 → 引用扩展 with these papers as the seeds. */
  expandCitations(seeds: readonly LiteratureChoice[]): void;
  takeCitationSeeds(): void;
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
  /** The paper tabs (reading-experience 1.8.3), for the reader's keys and menus. */
  tabs: {
    list: readonly PaperTab[];
    current: string | null;
    /** Goes back to an open tab, in the view it was left in. */
    show(id: string): void;
    /** Closes from tab `on` (the current one when absent). */
    close(kind: CloseKind, on?: string): void;
    reopen(): void;
    canReopen: boolean;
    cycle(step: 1 | -1): void;
    openMenu(on: string, x: number, y: number, keyboard: boolean): void;
  };
  theme: Theme;
  setTheme(value: Theme): void;
  /** The chosen theme with the day and night themes “跟随系统” uses. */
  themes: ThemeChoice;
  setThemeTime(time: ThemeTime, value: ThemeId): void;
}
/** The reader announces its first drawn screen; page warming waits for it. */
export const READER_PAINTED = "sciretriever:reader-painted";
export const ShellContext = createContext<ShellState | null>(null);
export function useShell(): ShellState {
  const shell = useContext(ShellContext);
  if (!shell) throw new Error("ShellContext is missing");
  return shell;
}
