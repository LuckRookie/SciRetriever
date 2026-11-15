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
/** A reading position (spec 4.1) as one view hands it to another or to the jump history. */
export type ReadingAnchor =
  | {
      readonly kind: "doc";
      /** UTF-8 start of the block at the reading line, and the line's place in it. */
      readonly start: number;
      readonly ratio: number;
      readonly label: string;
      /** The block's one-based PDF page and region, when the structure gave them. */
      readonly page: number | null;
      readonly region: readonly [number, number, number, number] | null;
      readonly text: string;
      /** Where this lands in the PDF (spec 4.3); `exact` false when an earlier block's page stood in. */
      readonly pdf: {
        readonly page: number;
        readonly ratio: number;
        readonly exact: boolean;
      } | null;
    }
  | {
      readonly kind: "pdf";
      readonly page: number;
      readonly ratio: number;
      readonly label: string;
      /** Text to confirm the place on the page (spec 4.3), when it came from the full text. */
      readonly text?: string;
    };
export interface ReaderResourceEntry {
  reference: string;
  open(): Promise<void>;
}
/** One step of preparing a view (spec 6.3), as the loading actually goes. */
export interface LoadStep {
  readonly id: "download" | "verify" | "parse" | "read" | "layout";
  readonly label: string;
  readonly state: "done" | "current" | "waiting";
  /** Counted progress within the step, e.g. bytes or pages. */
  readonly done?: number;
  readonly total?: number;
  readonly unit?: "bytes" | "pages" | "blocks";
}
export interface LoadProgress {
  readonly steps: readonly LoadStep[];
  /** 0–1 over all steps. */
  readonly fraction: number;
}
export interface ReaderFrame {
  /**
   * The sheet's page header (spec 1.2): the engine puts it at the top of its
   * content; the reader page fills it. The reading line is measured below it.
   */
  header?: HTMLElement;
  /** The engine reports where its loading is (spec 6.3). */
  onLoadStep?: (
    id: LoadStep["id"],
    count?: { done: number; total: number },
  ) => void;
  onSegment?: (id: string) => void;
  pdfLocation?: {
    page: number;
    region: import("@sciretriever/contracts").PageRegion | null;
  };
  /** Metadata heading for presentation only, may carry publisher inline tags (see `title.ts`); source bytes and evidence offsets stay fixed. */
  documentTitle?: string;
  /** The scroll container, shared by the views of one engine. */
  body: HTMLElement;
  /** This view's own container inside `body`; the engine appends its content here. */
  layer?: HTMLElement;
  controls: HTMLElement;
  outline: HTMLElement;
  status: HTMLElement;
  findStatus: HTMLElement;
  onFind: (query: string) => void | Promise<void>;
  beforeLayout: () => () => void;
  /**
   * Set by the engine. The view leaves the screen (`hide`, after which its
   * layer is hidden) or returns to it (`show`, once its layer is shown again):
   * the material, the PDF document and its worker stay; the position is kept.
   * A PDF view keeps the canvases it showed (at most three) unless `release`
   * is true, as for an engine that is no longer the current tab (spec 5.3).
   */
  hide: (release?: boolean) => void;
  show: () => void;
  /** The view starts off screen and prepares its first screen there (spec 5.1). */
  startHidden?: boolean;
  /** Set by the engine: the anchor at the reading line now. */
  anchor?: () => ReadingAnchor | null;
  /** Set by the engine: whether that anchor's block is on screen. */
  isVisible?: (anchor: ReadingAnchor) => boolean;
  /**
   * Set by the engine: go to an anchor. Its own kind is restored exactly
   * (`jumped`: as a jump back, spec 4.4); the other kind is followed (spec 4.3).
   */
  follow?: (anchor: ReadingAnchor, jumped?: boolean) => void | Promise<void>;
  /** A follow asked before the engine set `follow`; the engine takes it over. */
  queuedFollow?: { anchor: ReadingAnchor; done: () => void };
  /** Called before the engine jumps (outline, link), to record where the reader was. */
  beforeJump?: () => void;
  /** The anchor moved (the reader scrolled or a change was absorbed). */
  onAnchor?: () => void;
  /** A one-line explanation for the status bar (spec 10), or null to clear it. */
  onNote?: (text: string | null) => void;
  /** The remembered full-text place belongs to another text version (spec 4.5). */
  remembered?: "same" | "other-version";
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
