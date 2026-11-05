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
/** One drawn PDF page: its box, its text layer and its size in PDF units at scale 1. */
export interface PdfPageView {
  readonly page: number;
  readonly element: HTMLElement;
  readonly text: HTMLElement;
  readonly width: number;
  readonly height: number;
}
export interface ReaderOutlineEntry {
  /** null: the paper has no heading here; show the role name instead (ADR 0054). */
  readonly title: string | null;
  readonly role?: string | null;
  readonly level: number;
  /** UTF-8 offset where the section starts in the full text, for following the reading position. */
  readonly start?: number;
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
  /** Metadata heading for presentation only, may carry publisher inline tags (see `title.ts`); source bytes and evidence offsets stay fixed. */
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
  /** Columns that share the PDF width at 适宽: 2 while a translation twin sits beside each page (ADR 0051). */
  pdfColumns?: number;
  /** A page's text layer is drawn; called again for every redraw after zoom or resize. */
  onPdfPage?: (view: PdfPageView) => void;
  /** Full-text blocks were painted or extended. */
  onDocumentPaint?: () => void;
  onOutline?: (entry: ReaderOutlineEntry) => void;
  /** The full text's first visible block moved to this UTF-8 offset. */
  onPosition?: (offset: number) => void;
  onOutlineEmpty?: (message: string) => void;
  onFindNext?: (next: (() => void) | null) => void;
  onIssue?: (
    message: string | null,
    retry?: () => void | Promise<void>,
  ) => void;
}
