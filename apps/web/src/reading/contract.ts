import type { TranslationLanguage } from "@sciretriever/contracts";
import type { ReadingLayer } from "./layers/model.js";
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
  /** The zoom drawn now, also at 适合宽度 (1 is 100%). */
  readonly scale: number;
  /** The zoom as it is at this moment, between reports. */
  now(): { zoom: ReadingPosition["zoom"]; scale: number };
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
  /** UTF-8 offset where the section ends (the spine's part lengths, spec 1.5). */
  readonly end?: number;
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
  readonly id: "download" | "parse" | "read" | "layout";
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
/** The full text read as written, as its stored translation, or both (reading-experience 9). */
export type DocumentTextMode = "original" | "translation" | "bilingual";
export interface ReaderFrame {
  /**
   * The sheet's page header (spec 1.2): the engine puts it at the top of its
   * content; the reader page fills it. The reading line is measured below it.
   */
  header?: HTMLElement;
  /**
   * The full text's reading the engine opens with (reading-experience 9);
   * it opens in the original when this version has no translation to read.
   */
  textMode?: DocumentTextMode;
  /**
   * Set by the full-text engine: show another reading, keeping the place
   * (spec 4.2); true once the reading shown changed.
   */
  setTextMode?: (mode: DocumentTextMode) => Promise<boolean>;
  /**
   * Set by the full-text engine: switch to 对照 and put the block starting at
   * this UTF-8 offset on the reading line, as a jump (a marked paragraph read
   * in translation, spec 9).
   */
  revealInBilingual?: (start: number) => Promise<void>;
  /** The engine switched the reading itself (from a paragraph's mark sign). */
  onTextMode?: (mode: DocumentTextMode) => void;
  /** Set by the full-text engine: the stored translation of a block, null when it has none. */
  translationOf?: (block: HTMLElement) => Promise<string | null>;
  /** Set by the full-text engine: how many marks each block holds, by its UTF-8 start. */
  markBlocks?: (counts: ReadonlyMap<number, number>) => void;
  /** Words the full-text engine writes in the margins of a translation. */
  textLabels?: {
    untranslated: string;
    marks(count: number): string;
    marksAction(count: number): string;
    loadFailed: string;
  };
  /** The engine reports where its loading is (spec 6.3). */
  onLoadStep?: (
    id: LoadStep["id"],
    count?: { done: number; total: number },
  ) => void;
  /** A block's source: its PDF page, given for a draft (no proofread leaf to look up). */
  onSegment?: (id: string, page?: number) => void;
  /** “疑点” of a draft segment pressed: its differences (reading-experience 2.5). */
  onDoubt?: (anchor: HTMLElement, segmentId: string) => void;
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
  findStatus: HTMLElement;
  /** Looks for `query`; `stay` finds again in place, without going to the first match. */
  onFind: (query: string, stay?: boolean) => void | Promise<void>;
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
  /**
   * Set by the engine (reading-experience 4.2, 1.8.1): the point under
   * (x, y) stays there through the size changes that follow, until released
   * (null); then the reading anchor is measured again at the reading line.
   */
  holdPoint?: (point: { x: number; y: number } | null) => void;
  /** Called before the engine jumps (outline, link), to record where the reader was. */
  beforeJump?: () => void;
  /** The anchor moved (the reader scrolled or a change was absorbed). */
  onAnchor?: () => void;
  /** A one-line explanation under the page header (spec 1.2), or null to clear it. */
  onNote?: (text: string | null) => void;
  /** The level of the text being read (reading-experience 3.4). */
  onTextLevel?: (level: import("@sciretriever/contracts").TextLevel) => void;
  /** The material has nothing to read: spec 3.9 says so on the sheet. */
  onEmpty?: (what: "text" | "pdf") => void;
  /** The remembered full-text place belongs to another text version (spec 4.5). */
  remembered?: "same" | "other-version";
  animateNavigation?: () => boolean;
  onResources?: (resources: readonly ReaderResourceEntry[]) => void;
  onDocumentLink?: (preview: DocumentLinkPreview) => void;
  onImage?: (url: string, label: string) => void;
  onPdfControls?: (controls: PdfControls) => void;
  /** Columns that share the PDF width at 适宽: 2 while a translation twin sits beside each page (ADR 0051). */
  pdfColumns?: number;
  /**
   * The PDF's page column on the desk (spec 3.5): one page's width and the
   * column's width and left edge, for the zoomed page width or 适宽 (null).
   */
  pageColumn?: (
    desk: number,
    pageWidth: number | null,
    columns: number,
  ) => { pageWidth: number; width: number; left: number };
  /** A page's text layer is drawn; called again for every redraw after zoom or resize. */
  onPdfPage?: (view: PdfPageView) => void;
  /** Full-text blocks were painted or extended. */
  onDocumentPaint?: () => void;
  onOutline?: (entry: ReaderOutlineEntry) => void;
  /** The full text's first visible block moved to this UTF-8 offset. */
  onPosition?: (offset: number) => void;
  onOutlineEmpty?: (message: string) => void;
  /** Where the matches are, for the spine (spec 1.5): byte starts, or PDF pages. */
  onFindHits?: (units: readonly number[]) => void;
  /** The way to the next match (1) or the one before (−1), once there are matches. */
  onFindNext?: (next: ((step?: 1 | -1) => void) | null) => void;
  /**
   * A problem said in the reader's error notice: `message` for people;
   * `retained` what still shows; `detail` the internal cause, for the
   * notice's technical details.
   */
  onIssue?: (
    message: string | null,
    retry?: () => void | Promise<void>,
    more?: { retained?: string; detail?: string },
  ) => void;
  /**
   * The reading layer the full text opens in (reading-experience 3.3.1) when
   * this version has layers; 全文 otherwise.
   */
  readingLayer?: ReadingLayer;
  /** Whether stressed words are marked (排版 → 标出重点词). */
  keyTerms?: boolean;
  /**
   * The language the reader reads translations in (ADR 0072); absent or
   * null reads the library's own language.
   */
  translationLanguage?: TranslationLanguage | null;
  /**
   * Set by the full-text engine once the layers are on the sheet: shows a
   * layer, arriving at a note or at a place of the full text.
   */
  setLayer?: (
    layer: ReadingLayer,
    target?: {
      point?: number | null;
      start?: number | null;
      instant?: boolean;
    },
  ) => void;
  /**
   * Set by the full-text engine once the layers are on the sheet: closes what
   * clicks opened in 概览 or 脉络 (Esc, the depth bar's current layer); false
   * when nothing was open.
   */
  foldLayers?: () => boolean;
  /**
   * Set by the full-text engine: the reading anchor of the block holding a
   * UTF-8 offset, as `anchor()` gives it for the reading line (its PDF page
   * and region with it), so that a PDF beside the text can show it.
   */
  anchorAt?: (start: number) => ReadingAnchor | null;
  /**
   * Set by the full-text engine: while 概览 or 脉络 shows, where the note
   * being read stands in the text (its first evidence); null on 全文.
   */
  layerStart?: () => number | null;
  /**
   * Set by the reader while a PDF stands beside the reading copy (ADR 0071):
   * a note or one of its sentences was pressed; true when the PDF showed it,
   * and the reading copy then stays on its layer.
   */
  onPick?: (start: number) => boolean;
  /** Set with `setLayer`: Alt and the wheel move the change by hand; true when taken. */
  layerWheel?: (deltaY: number) => boolean;
  setKeyTerms?: (on: boolean) => void;
  /** The layers are on the sheet (true), or could not be read (false). */
  onLayers?: (ready: boolean) => void;
  /** The layer shown changed. */
  onLayer?: (layer: ReadingLayer) => void;
}
