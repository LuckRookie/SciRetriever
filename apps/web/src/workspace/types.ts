import type {
  LibraryQuery,
  LibrarySort,
  LiteratureSearchItem,
  LiteratureDetail,
} from "@sciretriever/contracts";
import type { WorkbenchApi } from "./api.js";
export type Section =
  | "lib"
  | "disc"
  | "ins"
  | "ask"
  | "syn"
  | "ext"
  | "task"
  | "web"
  | "set";
export type ReaderMode = "pdf" | "doc" | "know";
export interface SavedView {
  id: string;
  name: string;
  query: LibraryQuery;
  sort: LibrarySort;
}
export interface LibraryState {
  query: LibraryQuery;
  sort: LibrarySort;
  items: readonly LiteratureSearchItem[];
  total: number;
  cursor: string | null;
  selected: Set<string>;
  peek: string | null;
  views: SavedView[];
  viewId: string;
}
export interface AppContext {
  api: WorkbenchApi;
  root: HTMLElement;
  signal: AbortSignal;
  library: LibraryState;
  details: Map<string, LiteratureDetail>;
  navigate(section: Section, parameters?: Record<string, string>): void;
  openPaper(
    id: string,
    mode?: ReaderMode,
    source?: Record<string, string>,
  ): void;
  refresh(): void;
  updateNavigation(): void;
  onTasksChanged(): void;
  scopeIds(): Promise<string[]>;
  upload(id: string, file: File): Promise<void>;
  operate(operation: string, ids: readonly string[]): Promise<void>;
}
