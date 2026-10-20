import type { ReadingPosition } from "./state.js";

/** Framework-neutral access supplied by either application shell. */
export interface ReadingContext {
  readonly root: HTMLElement;
  readonly signal: AbortSignal;
  readonly api: {
    query(
      name: string,
      request: unknown,
      signal?: AbortSignal,
    ): Promise<Record<string, unknown>>;
    fetch(path: string, init?: RequestInit): Promise<Response>;
  };
  refresh(): void;
}
export interface PdfControls {
  readonly page: number;
  readonly total: number;
  readonly zoom: ReadingPosition["zoom"];
  go(page: number): void;
  zoomTo(zoom: ReadingPosition["zoom"]): void;
}
export interface ReaderOutlineEntry {
  readonly title: string;
  readonly level: number;
  activate(): void | Promise<void>;
}
export interface DocumentLinkPreview {
  anchor: HTMLElement;
  title: string;
  text: string;
  activate(): void;
}
export interface ReaderResourceEntry {
  reference: string;
  open(): Promise<void>;
}
export interface ReaderFrame {
  onSegment?: (id: string) => void;
  pdfLocation?: {
    page: number;
    region: import("@sciretriever/contracts").PageRegion | null;
  };
  /** Metadata heading for presentation only; source bytes and evidence offsets stay fixed. */
  documentTitle?: string;
  body: HTMLElement;
  controls: HTMLElement;
  outline: HTMLElement;
  status: HTMLElement;
  findStatus: HTMLElement;
  onFind: (query: string) => void | Promise<void>;
  beforeLayout: () => () => void;
  animateNavigation?: () => boolean;
  onResources?: (resources: readonly ReaderResourceEntry[]) => void;
  onDocumentLink?: (preview: DocumentLinkPreview) => void;
  onImage?: (url: string, label: string) => void;
  onPdfControls?: (controls: PdfControls) => void;
  onOutline?: (entry: ReaderOutlineEntry) => void;
  onOutlineEmpty?: (message: string) => void;
  onFindNext?: (next: (() => void) | null) => void;
  onIssue?: (
    message: string | null,
    retry?: () => void | Promise<void>,
  ) => void;
}
