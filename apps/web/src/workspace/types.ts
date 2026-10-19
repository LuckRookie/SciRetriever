import type {
  LibraryQuery,
  LibrarySort,
  LiteratureSearchItem,
  LiteratureDetail,
  KnowledgeContextItem,
  KnowledgeContextRequest,
  ProcessorBatchRequest,
} from "@sciretriever/contracts";
import type { WorkbenchApi } from "./api.js";
import type { ProcessorResultsState } from "./processor-results.js";
import type { ReadingState } from "../reading/state.js";
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
  total: number | null;
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
  retrieval: RetrievalState;
  processor: ProcessorFormState;
  processorResults: ProcessorResultsState;
  reading: ReadingState;
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

/** Ephemeral workspace state, never a second copy of library facts. */
export interface RetrievalState {
  draft: {
    query: string;
    scope: string;
    kinds: string;
    count: string;
    bytes: string;
  };
  items: KnowledgeContextItem[];
  next: string | null;
  current: KnowledgeContextRequest | null;
  basket: Map<string, KnowledgeContextItem>;
  status: string;
}

export interface ProcessorFormState {
  kind: "records" | "labels";
  scope: "selection" | "query";
  meaning: string;
  inclusion: string;
  question: string;
  answerType: "boolean" | "string" | "enum";
  choices: string;
  reading: "full" | "search";
  readingQuery: string;
  fields: {
    name: string;
    description: string;
    type: "string" | "number" | "boolean";
    unit: string;
  }[];
  submission: null | {
    fingerprint: string;
    request: ProcessorBatchRequest;
    jobId: string | null;
    started: boolean;
    note: string;
  };
}
