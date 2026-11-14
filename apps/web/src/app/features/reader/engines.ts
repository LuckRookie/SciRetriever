import {
  parsePageRegion,
  type DocumentMaterialRef,
  type DocumentReadingRef,
} from "@sciretriever/contracts";
import type {
  DocumentLinkPreview,
  PdfControls,
  ReaderFrame,
  ReaderOutlineEntry,
  ReaderResourceEntry,
  ReadingAnchor,
  ReadingContext,
} from "../../../reading/contract.js";
import type { MarkSurface } from "../../../reading/marks.js";
import {
  READER_PROBE,
  probeCount,
  probeCountKey,
} from "../../../reading/probe.js";
import type { FixedSource } from "../../../reading/source.js";
import {
  readingPosition,
  recallReading,
  rememberReading,
  type ReadingState,
} from "../../../reading/state.js";
import { readPdfBytes } from "../../../reading/transport.js";
import { archiveJsonStream, archiveQuery, rows } from "../../data/archive.js";
import type { ApiClient } from "../../data/api.js";
import { record } from "../../data/wire.js";
import type { ReaderMode } from "../../data/url.js";
import { errorMessage } from "../../strings.js";
import {
  createFullTextLayer,
  type FullTextLayer,
} from "./translation/fulltext-layer.js";

export type ViewKind = "pdf" | "doc";
export const viewOf = (mode: ReaderMode): ViewKind | null =>
  mode === "pdf" || mode === "edit" ? "pdf" : mode === "doc" ? "doc" : null;

/** What a view shows in the reader's own controls; kept while the view is hidden. */
export interface ViewUi {
  pdf: PdfControls | null;
  pdfUrl: string;
  outline: ReaderOutlineEntry[];
  outlineNote: string;
  readingOffset: number | null;
  nextMatch: (() => void) | null;
  issue: { message: string; retry?: () => void | Promise<void> } | null;
  ready: boolean;
  resources: readonly ReaderResourceEntry[];
}
export const emptyUi = (): ViewUi => ({
  pdf: null,
  pdfUrl: "",
  outline: [],
  outlineNote: "",
  readingOffset: null,
  nextMatch: null,
  issue: null,
  ready: false,
  resources: [],
});
export type UiSetters = { [K in keyof ViewUi]: (value: ViewUi[K]) => void };
function applyUi(set: UiSetters, patch: Partial<ViewUi>) {
  for (const key of Object.keys(patch) as (keyof ViewUi)[])
    (set[key] as (value: unknown) => void)(patch[key]);
}

export interface ReaderSources {
  material: DocumentMaterialRef | null;
  document: DocumentReadingRef | null;
}
/** A newer resolution of the shown material, offered rather than swapped in (spec 5.2). */
export interface ReaderUpdate {
  kind: "text-version";
  apply(): void;
}
/** Stable hooks into the reader page; called at the time of use. */
export interface ReaderBindings {
  root(): HTMLElement | null;
  statusHost(): HTMLElement | null;
  findHost(): HTMLElement | null;
  set: UiSetters;
  frame: { current: ReaderFrame | null };
  twins: { current: FullTextLayer | null };
  appliedMode: WeakMap<FullTextLayer, string>;
  fullTextMode(): string;
  marksActive(): boolean;
  attachMarks(
    host: HTMLElement,
    material:
      | { kind: "pdf"; sha256: string }
      | { kind: "doc"; version: string },
    onJump: () => void,
  ): MarkSurface;
  openMark(id: string): void;
  image(src: string, alt: string): void;
  documentLink(preview: DocumentLinkPreview): void;
  openPaper(id: string, mode: ReaderMode, source: Record<string, string>): void;
  notify(message: string): void;
  retry(): void;
  /** Another view or engine became current. */
  viewChanged(): void;
  /** The update offered for the shown material, if any. */
  offer(update: ReaderUpdate | null): void;
  /** A one-line explanation for the status bar (spec 10), or null. */
  note(text: string | null): void;
  /** The way back after a jump (spec 4.4), when its place is off screen. */
  history(back: { label: string } | null): void;
  /** Shows another view of the current paper (a jump back into it). */
  changeView(kind: ViewKind): void;
}
/** One step of the jump history: which view and where. */
interface Visit {
  readonly kind: ViewKind;
  readonly anchor: ReadingAnchor;
}
const HISTORY_LIMIT = 20;
/** One material as the reader page resolved it. */
export interface EngineRequest {
  key: string;
  id: string;
  api: ApiClient;
  material: ReaderSources;
  source: FixedSource | null;
  reading: ReadingState;
  catalog: string | null;
  title: string;
  revision: number;
}

interface ReaderView {
  kind: ViewKind;
  layer: HTMLDivElement;
  status: HTMLElement;
  findStatus: HTMLElement;
  marker: HTMLElement;
  ui: ViewUi;
  frame: ReaderFrame;
  twins: FullTextLayer | null;
  surface: MarkSurface | null;
  settled: boolean;
  /** Followed another view and the reader has not moved in it since (wheel, keys, pointer). */
  arrived: boolean;
}
interface ReaderEngine {
  request: EngineRequest;
  offered: EngineRequest | null;
  container: HTMLDivElement;
  /** Shown or hidden as a whole; `kind` is the view it shows. */
  show(kind: ViewKind | null): void;
  hide(): void;
  /** Builds or switches the view while off screen, ready to show. */
  prepare(kind: ViewKind | null): void;
  activate(kind: ViewKind | null): void;
  settled(): boolean;
  onSettled: (() => void) | null;
  /** Spec 4.4: back and forward through this paper's jumps; false when there is none. */
  back(): boolean;
  forward(): boolean;
  destroy(): void;
}

/**
 * The live reader engines of one reader page (spec 5.1): the current tab's
 * and the previous tab's. A third material releases the least recently used
 * engine first, so at most two PDF workers exist. A new engine prepares off
 * screen and replaces the old picture once its first screen can show, or after
 * 300 ms (spec 6.2).
 */
export function createReaderEngines(b: ReaderBindings) {
  const engines = new Map<string, ReaderEngine>();
  let current: ReaderEngine | null = null,
    pending: ReaderEngine | null = null,
    host: HTMLElement | null = null,
    kind: ViewKind | null = null,
    timer: ReturnType<typeof setTimeout> | undefined;
  const offer = () => {
    const engine = current;
    b.offer(
      engine?.offered
        ? {
            kind: "text-version",
            apply: () => {
              if (current === engine && engine.offered) replace(engine.offered);
            },
          }
        : null,
    );
  };
  // A replaced engine (a new text version of the same material) is no longer
  // listed; it goes for good once something else shows.
  const retire = (engine: ReaderEngine | null) => {
    if (!engine) return;
    if (engines.get(engine.request.key) !== engine) engine.destroy();
    else engine.hide();
  };
  const swap = (next: ReaderEngine) => {
    if (pending !== next) return;
    clearTimeout(timer);
    pending = null;
    next.onSettled = null;
    const previous = current;
    current = next;
    retire(previous);
    if (host) host.dataset.literatureId = next.request.id;
    next.show(kind);
    offer();
  };
  const destroy = (engine: ReaderEngine) => {
    if (engines.get(engine.request.key) === engine)
      engines.delete(engine.request.key);
    if (pending === engine) {
      pending = null;
      clearTimeout(timer);
    }
    if (current === engine) {
      current = null;
      if (host) delete host.dataset.literatureId;
      b.offer(null);
    }
    engine.destroy();
  };
  /** Build `request` and swap it in for whatever shows now. */
  const replace = (request: EngineRequest) => {
    if (pending) destroy(pending);
    const old = engines.get(request.key);
    if (old && old !== current) destroy(old);
    else if (old) engines.delete(request.key);
    // At most two engines: the one showing now and the new one.
    const live = () =>
      engines.size +
      (current && engines.get(current.request.key) !== current ? 1 : 0);
    for (const engine of [...engines.values()])
      if (engine !== current && live() >= 2) destroy(engine);
    const next = build(request, b, host!);
    engines.set(request.key, next);
    pending = next;
    if (!current) return swap(next);
    next.prepare(kind);
    next.onSettled = () => swap(next);
    if (next.settled()) return swap(next);
    timer = setTimeout(() => swap(next), 300);
  };
  return {
    open(request: EngineRequest, scroller: HTMLElement) {
      if (host !== scroller) {
        // The page was rebuilt: its engines lived in the old container.
        for (const engine of [...engines.values()]) destroy(engine);
        host = scroller;
      }
      const engine = engines.get(request.key);
      if (!engine || engine.request.revision !== request.revision)
        return replace(request);
      if (engine.request.material !== request.material) {
        const same =
          engine.request.material.material?.asset_sha256 ===
          request.material.material?.asset_sha256;
        // A new PDF replaces the view; a new text version is only offered.
        if (!same) return replace(request);
        const changed =
          engine.request.material.document?.document_version_id !==
          request.material.document?.document_version_id;
        engine.offered = changed ? request : null;
        if (!changed) engine.request = { ...engine.request, ...request };
      }
      engines.delete(request.key);
      engines.set(request.key, engine);
      if (engine === pending || engine === current) {
        if (engine === current) offer();
        return;
      }
      if (pending) destroy(pending);
      const previous = current;
      current = engine;
      retire(previous);
      if (host) host.dataset.literatureId = engine.request.id;
      engine.show(kind);
      offer();
    },
    view(next: ViewKind | null) {
      kind = next;
      current?.activate(next);
      pending?.prepare(next);
    },
    back: () => current?.back() ?? false,
    forward: () => current?.forward() ?? false,
    /** A closed tab releases its engines. */
    close(literatureId: string) {
      for (const engine of [...engines.values()])
        if (engine.request.id === literatureId) destroy(engine);
    },
    destroy() {
      for (const engine of [...engines.values()]) destroy(engine);
      if (pending) destroy(pending);
      if (current) destroy(current);
    },
  };
}
export type ReaderEngines = ReturnType<typeof createReaderEngines>;

function build(
  request: EngineRequest,
  b: ReaderBindings,
  host: HTMLElement,
): ReaderEngine {
  const { api, id, material, reading, catalog } = request;
  if (READER_PROBE) probeCountKey("engines", "material");
  const controller = new AbortController(),
    fixed = new URLSearchParams(request.key),
    urls = new Set<string>(),
    views = new Map<ViewKind, ReaderView>();
  const container = document.createElement("div");
  container.className = "reader-engine";
  container.dataset.literatureId = id;
  container.hidden = true;
  host.append(container);
  let visible = false,
    active: ReaderView | null = null,
    target: ViewKind | null = null;
  const shows = (view: ReaderView) => visible && active === view;
  const update = (view: ReaderView, patch: Partial<ViewUi>) => {
    Object.assign(view.ui, patch);
    if (shows(view)) applyUi(b.set, patch);
  };
  const syncReady = (view: ReaderView | null) => {
    const root = b.root();
    if (!root) return;
    if (view?.marker.dataset.readingReady === "true")
      root.dataset.readingReady = "true";
    else delete root.dataset.readingReady;
  };
  const settle = (view: ReaderView) => {
    view.settled = true;
    if (view.kind === target) engine.onSettled?.();
  };
  const buildView = (kind: ViewKind, offScreen: boolean): ReaderView => {
    const layer = document.createElement("div");
    layer.className = "reader-view";
    layer.dataset.view = kind;
    layer.hidden = true;
    container.append(layer);
    const statusText = document.createElement("span");
    statusText.textContent = "正在读取并核验固定材料…";
    const view: ReaderView = {
      kind,
      layer,
      status: statusText,
      findStatus: document.createElement("span"),
      // Engines mark readiness here; it reaches the reader while the view shows.
      marker: document.createElement("div"),
      ui: emptyUi(),
      twins: null,
      surface: null,
      frame: null as unknown as ReaderFrame,
      settled: false,
      arrived: false,
    };
    const observer = new MutationObserver(() => {
      if (view.marker.dataset.readingReady === "true") settle(view);
      if (shows(view)) syncReady(view);
    });
    observer.observe(view.marker, { attributes: true });
    controller.signal.addEventListener("abort", () => observer.disconnect(), {
      once: true,
    });
    const ctx: ReadingContext = {
      api,
      signal: controller.signal,
      root: view.marker,
      refresh: () => b.retry(),
    };
    const key = [
      catalog,
      id,
      kind,
      kind === "pdf" ? material.material : material.document,
    ];
    const fresh = !reading.entries.has(JSON.stringify(key));
    const position = readingPosition(reading, key, id);
    // A paper opened anew starts where it was left in this browser (spec 4.5).
    let remembered: ReaderFrame["remembered"];
    if (fresh) {
      const memory = recallReading(catalog, id);
      if (kind === "doc" && memory.doc && material.document) {
        position.textOffset = memory.doc.start;
        position.blockOffset = memory.doc.ratio;
        remembered =
          memory.doc.version === material.document.document_version_id
            ? "same"
            : "other-version";
      }
      if (
        kind === "pdf" &&
        memory.pdf &&
        memory.pdf.sha256 === material.material?.asset_sha256
      ) {
        position.anchorPage = memory.pdf.page;
        position.anchorRatio = memory.pdf.ratio;
        position.zoom = memory.pdf.zoom;
        remembered = "same";
      }
    }
    let saving: ReturnType<typeof setTimeout> | undefined;
    const save = () => {
      clearTimeout(saving);
      saving = setTimeout(() => {
        if (controller.signal.aborted) return;
        if (kind === "doc" && material.document)
          rememberReading(catalog, id, {
            doc: {
              version: material.document.document_version_id,
              start: position.textOffset,
              ratio: position.blockOffset,
            },
          });
        if (kind === "pdf" && material.material)
          rememberReading(catalog, id, {
            pdf: {
              sha256: material.material.asset_sha256,
              page: position.anchorPage,
              ratio: position.anchorRatio,
              zoom: position.zoom,
            },
          });
      }, 400);
    };
    const frame: ReaderFrame = {
      onSegment: (segment) => {
        const pdfMaterial = material.material;
        if (!pdfMaterial) return;
        void leafPage(api, pdfMaterial.asset_id, segment, controller.signal)
          .then((page) =>
            b.openPaper(id, "edit", {
              asset: pdfMaterial.asset_id,
              assetHash: pdfMaterial.asset_sha256,
              page: String(page),
            }),
          )
          .catch((error) => {
            if (!controller.signal.aborted) b.notify(errorMessage(error));
          });
      },
      ...(fixed.has("page")
        ? {
            pdfLocation: {
              page: Math.max(
                1,
                Math.min(10000, Number(fixed.get("page")) || 1),
              ),
              region: fixed.get("region")
                ? parsePageRegion(JSON.parse(fixed.get("region")!))
                : null,
            },
          }
        : {}),
      documentTitle: request.title,
      animateNavigation: () =>
        document.documentElement.dataset.reducedMotion !== "true",
      onResources: (resources) => {
        if (!controller.signal.aborted) update(view, { resources });
      },
      onImage: (src, alt) => {
        if (shows(view)) b.image(src, alt);
      },
      onDocumentLink: (preview) => {
        if (!controller.signal.aborted && shows(view)) b.documentLink(preview);
      },
      body: host,
      layer,
      controls: document.createElement("div"),
      outline: document.createElement("nav"),
      status: statusText,
      findStatus: view.findStatus,
      onFind: () => {},
      beforeLayout: () => () => {},
      hide: () => {},
      show: () => {},
      // Until the engine is running, a place to follow waits for it.
      follow: (anchor) =>
        new Promise<void>((done) => {
          frame.queuedFollow = { anchor, done };
        }),
      startHidden: offScreen,
      ...(remembered ? { remembered } : {}),
      onAnchor: () => {
        save();
        if (shows(view)) publishHistory();
      },
      onNote: (text) => {
        if (shows(view)) b.note(text);
      },
      beforeJump: () => {
        const anchor = view.frame.anchor?.();
        if (!anchor) return;
        past.push({ kind, anchor });
        if (past.length > HISTORY_LIMIT) past.shift();
        future.length = 0;
        publishHistory();
      },
      onPdfControls: (value) => {
        const previous = view.ui.pdf;
        if (
          controller.signal.aborted ||
          (previous?.page === value.page &&
            previous.total === value.total &&
            previous.zoom === value.zoom)
        )
          return;
        update(view, { pdf: value });
      },
      onOutline: (entry) => {
        if (!controller.signal.aborted)
          update(view, { outline: [...view.ui.outline, entry] });
      },
      onOutlineEmpty: (note) => update(view, { outlineNote: note }),
      onPosition: (offset) => {
        view.ui.readingOffset = offset;
        // Scroll reports arrive per frame; the outline needs at most one update each.
        if (controller.signal.aborted || !shows(view) || positionFrame) return;
        positionFrame = requestAnimationFrame(() => {
          positionFrame = 0;
          if (!controller.signal.aborted && shows(view))
            b.set.readingOffset(view.ui.readingOffset);
        });
      },
      onFindNext: (value) => {
        if (!controller.signal.aborted) update(view, { nextMatch: value });
      },
      onIssue: (message, again) => {
        if (!controller.signal.aborted)
          update(view, {
            issue: message
              ? { message, ...(again ? { retry: again } : {}) }
              : null,
          });
      },
    };
    view.frame = frame;
    if (kind === "pdf") {
      // The translated twin pages live as long as this PDF document (ADR 0051).
      const twins = createFullTextLayer(
        () => layer.querySelector<HTMLElement>(".reading-pdf-pages"),
        (markId) => b.openMark(markId),
      );
      view.twins = twins;
      frame.pdfColumns = b.fullTextMode() === "pair" ? 2 : 1;
      twins.setMode(
        b.fullTextMode() as Parameters<FullTextLayer["setMode"]>[0],
      );
      b.appliedMode.set(twins, b.fullTextMode());
      frame.onPdfPage = (page) => {
        view.surface?.pdfPage(page);
        twins.page(page);
      };
    } else frame.onDocumentPaint = () => view.surface?.documentPainted();
    const run = async () => {
      if (kind === "pdf") {
        if (!material.material) {
          statusText.textContent = "尚无 PDF。可从信息栏上传或显式获取。";
          return;
        }
        const started = performance.now(),
          bytes = await readPdfBytes(ctx, material.material);
        performance.measure("sciretriever-pdf-read-verify", {
          start: started,
          end: performance.now(),
        });
        controller.signal.throwIfAborted();
        const url = URL.createObjectURL(
          new Blob([bytes], { type: "application/pdf" }),
        );
        urls.add(url);
        if (READER_PROBE) probeCount("objectUrlsCreated");
        update(view, { pdfUrl: url });
        const pdfEngine = await import("../../../reading/pdf.js");
        controller.signal.throwIfAborted();
        await pdfEngine.renderPdf(ctx, frame, position, bytes);
      } else {
        if (!material.document) {
          statusText.textContent = "尚无已发布全文；阅读不会启动解析。";
          return;
        }
        const documentEngine = await import("../../../reading/document.js");
        controller.signal.throwIfAborted();
        await documentEngine.renderDocument(
          ctx,
          frame,
          position,
          material.document,
          request.source,
        );
      }
      if (!controller.signal.aborted) update(view, { ready: true });
    };
    void run()
      .catch((error) => {
        if (!controller.signal.aborted) {
          statusText.textContent = errorMessage(error);
          update(view, {
            issue: {
              message: errorMessage(error),
              retry: () => b.retry(),
            },
          });
        }
      })
      .finally(() => {
        // Nothing to draw (no material, a failure) still replaces the old picture.
        if (!controller.signal.aborted) settle(view);
      });
    views.set(kind, view);
    return view;
  };
  let positionFrame = 0;
  // The reader moving in a view ends its "followed, not read on" state.
  for (const type of ["wheel", "keydown", "pointerdown", "touchmove"])
    host.addEventListener(
      type,
      () => {
        if (visible && active) active.arrived = false;
      },
      { passive: true, signal: controller.signal },
    );
  // This paper's jumps (spec 4.4); not remembered past the session.
  const past: Visit[] = [],
    future: Visit[] = [];
  let historyFrame = 0;
  /** The way back shows only while its place is off screen. */
  const publishHistory = () => {
    if (historyFrame) return;
    historyFrame = requestAnimationFrame(() => {
      historyFrame = 0;
      if (!visible || !active) return;
      const last = past.at(-1);
      const onScreen =
        last?.kind === active.kind && !!active.frame.isVisible?.(last.anchor);
      b.history(last && !onScreen ? { label: last.anchor.label } : null);
    });
  };
  /** Pending place for a view about to show: a jump back into it. */
  let returning: ReadingAnchor | null = null;
  const travel = (from: Visit[], to: Visit[]) => {
    const target = from.pop();
    const here = active?.frame.anchor?.();
    if (!target || !active || !here) return false;
    to.push({ kind: active.kind, anchor: here });
    if (target.kind === active.kind)
      void active.frame.follow?.(target.anchor, true);
    else {
      returning = target.anchor;
      b.changeView(target.kind);
    }
    publishHistory();
    return true;
  };
  /** Hides the active view; a hidden engine keeps no canvases (spec 5.3). */
  const leave = (view: ReaderView, release: boolean) => {
    view.frame.hide(release);
    view.layer.hidden = true;
    view.surface?.destroy();
    view.surface = null;
  };
  const enter = (view: ReaderView) => {
    view.layer.hidden = false;
    b.frame.current = view.frame;
    b.twins.current = view.twins;
    b.statusHost()?.replaceChildren(view.status);
    b.findHost()?.replaceChildren(view.findStatus);
    applyUi(b.set, view.ui);
    syncReady(view);
    if (b.marksActive()) {
      if (view.kind === "pdf" && material.material)
        view.surface = b.attachMarks(
          host,
          { kind: "pdf", sha256: material.material.asset_sha256 },
          () => view.frame.beforeJump?.(),
        );
      else if (view.kind === "doc" && material.document) {
        view.surface = b.attachMarks(
          host,
          { kind: "doc", version: material.document.document_version_id },
          () => view.frame.beforeJump?.(),
        );
        if (view.marker.dataset.readingReady === "true")
          view.surface.documentPainted();
      }
    }
    view.frame.show();
    b.viewChanged();
    b.note(null);
    publishHistory();
  };
  const clearPage = () => {
    b.frame.current = null;
    b.twins.current = null;
    b.statusHost()?.replaceChildren();
    b.findHost()?.replaceChildren();
    applyUi(b.set, emptyUi());
    syncReady(null);
    b.viewChanged();
  };
  const engine: ReaderEngine = {
    request,
    offered: null,
    container,
    onSettled: null,
    settled: () => (target ? !!views.get(target)?.settled : true),
    prepare(kind) {
      target = kind;
      if (visible) return engine.activate(kind);
      if (!kind) return;
      const view = views.get(kind) ?? buildView(kind, true);
      if (view.settled) engine.onSettled?.();
    },
    activate(kind) {
      target = kind;
      if (!visible) return engine.prepare(kind);
      const next = kind ? (views.get(kind) ?? buildView(kind, false)) : null;
      if (next === active) return;
      // Spec 4.3: the place carries over, unless the reader went straight back
      // without reading on; then each view keeps its own.
      const from = active,
        anchor = from?.frame.anchor?.() ?? null,
        unread = !!from?.arrived;
      // The current material's hidden PDF view keeps its canvases (spec 5.3).
      if (from) leave(from, false);
      active = next;
      if (!next) return clearPage();
      enter(next);
      if (kind) rememberReading(catalog, id, { view: kind });
      const back = returning;
      returning = null;
      const carried = back ?? (anchor && !unread ? anchor : null);
      if (!carried) return;
      next.arrived = !back;
      void next.frame.follow?.(carried, !!back);
    },
    back: () => travel(past, future),
    forward: () => travel(future, past),
    show(kind) {
      visible = true;
      container.hidden = false;
      active = null;
      target = kind;
      const next = kind ? (views.get(kind) ?? buildView(kind, false)) : null;
      active = next;
      if (next) enter(next);
      else clearPage();
    },
    hide() {
      visible = false;
      for (const view of views.values()) {
        if (view === active) leave(view, true);
        else view.frame.hide(true);
      }
      active = null;
      container.hidden = true;
      b.history(null);
    },
    destroy() {
      visible = false;
      controller.abort();
      for (const view of views.values()) {
        view.surface?.destroy();
        view.twins?.destroy();
        if (b.twins.current === view.twins) b.twins.current = null;
        if (b.frame.current === view.frame) clearPage();
      }
      for (const url of urls) {
        URL.revokeObjectURL(url);
        if (READER_PROBE) probeCount("objectUrlsRevoked");
      }
      urls.clear();
      container.remove();
    },
  };
  return engine;
}

/** The 1-based PDF page a reading segment came from, for arranged and old drafts alike. */
async function leafPage(
  api: ApiClient,
  asset: string,
  segment: string,
  signal: AbortSignal,
) {
  const request = {
    asset_id: asset,
    block_id: segment,
    limit: 1,
    unresolved_only: false,
  };
  const head = record(
    await archiveQuery(
      api,
      "proofread-inspect",
      { ...request, offset: 0 },
      signal,
    ),
    "inspect",
  );
  if (head.format === "arranged-v2") {
    const { value } = await archiveJsonStream(
      api,
      "proofread-inspect",
      request,
      "offset",
      signal,
    );
    const leaf = rows(value, "leaves")[0]?.leaf;
    return leaf && typeof leaf === "object" && "page_index" in leaf
      ? Number(leaf.page_index) + 1
      : 1;
  }
  const item = rows(head)[0];
  const block = item?.block ?? item?.draft;
  return block && typeof block === "object" && "page" in block
    ? Number(block.page) + 1
    : 1;
}
