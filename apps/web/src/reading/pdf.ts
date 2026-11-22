import {
  getDocument,
  PDFDataRangeTransport,
  PDFWorker,
  TextLayer,
  type PDFDocumentProxy,
  type RenderTask,
  type PDFPageProxy,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import { button, node } from "./dom.js";
import type { ReadingContext } from "./contract.js";
import type { ReadingPosition } from "./state.js";
import { readerProblem } from "./dom.js";
import type { ReaderFrame } from "./contract.js";
import { READER_PROBE, probeBitmap, probeCount } from "./probe.js";
import {
  anchorIndex,
  anchorRatio,
  placeDelta,
  readingArea,
  readingLine,
} from "./anchor.js";
import { canon, indexText, locate, PLACE, rangeOf } from "./mark-locate.js";
import { PDF_BLOCK, pdfProblem, type PdfSource } from "./pdf-bytes.js";
import type { ReadingAnchor } from "./contract.js";

type RenderedPage = {
  canvas: HTMLCanvasElement;
  text: HTMLDivElement;
  page?: PDFPageProxy;
  render?: RenderTask;
  layer?: TextLayer;
  /** The scale it was drawn at; shown at another scale it is stretched. */
  scale: number;
  /** Fully drawn and on its page. */
  drawn?: boolean;
};
type Bitmap = { img: HTMLImageElement; url: string; bytes: number };
/**
 * PDF.js asks this for the ranges it needs; they come from the shared source,
 * which downloads each block once. Nothing is handed over after `abort`.
 */
class SourceTransport extends PDFDataRangeTransport {
  private closed = false;
  constructor(
    private readonly source: PdfSource,
    private readonly arrived: () => void,
  ) {
    super(source.size, null);
  }
  override requestDataRange(begin: number, end: number) {
    // A failed read stops the view through `source.checked`.
    void this.source.read(begin, end).then(
      (chunk) => {
        if (this.closed) return;
        this.arrived();
        this.onDataRange(begin, chunk);
      },
      () => undefined,
    );
  }
  override abort() {
    this.closed = true;
  }
}
/** Spec 5.3: a page that leaves the drawn range keeps a picture at most this scale. */
const BITMAP_SCALE = 0.5,
  BITMAP_PAGES = 40,
  BITMAP_BYTES = 48 * 1024 * 1024,
  // After the last change of size, the visible pages are drawn sharp again.
  SHARPEN_MS = 120;
/**
 * Only visible and adjacent pages own canvas/text layers; while one is redrawn
 * sharp its stretched picture stays, so a page holds at most two canvases.
 * Pages further away keep a low-resolution bitmap. The PDF worker belongs to this mount.
 */
export async function renderPdf(
  ctx: ReadingContext,
  frame: ReaderFrame,
  state: ReadingPosition,
  source: PdfSource,
): Promise<void> {
  if (frame.pdfLocation) {
    state.page = frame.pdfLocation.page;
    state.pageOffset = 0;
    state.scroll = 0;
  }
  const parseStarted = performance.now();
  let paintStarted = 0,
    firstPaint = true;
  const controls = document.createElement("div");
  controls.className = "reading-controls";
  controls.innerHTML =
    '<button class="btn q sm" id="reader-previous">上一页</button><input id="reader-page" type="number" min="1" value="1" aria-label="PDF 页码"><span id="reader-page-count"></span><button class="btn q sm" id="reader-next">下一页</button><select id="reader-zoom" aria-label="PDF 缩放"><option value="fit">适宽</option><option value="0.75">75%</option><option value="1">100%</option><option value="1.25">125%</option><option value="1.5">150%</option><option value="2">200%</option></select>';
  if (!frame.onPdfControls) frame.controls.prepend(controls);
  const pageInput = node<HTMLInputElement>("#reader-page", controls),
    zoom = node<HTMLSelectElement>("#reader-zoom", controls);
  zoom.value = String(state.zoom);
  const pages = document.createElement("div");
  pages.className = "reading-pdf-pages library-pdf-reading";
  // The page header sits at the top of the page column (spec 1.2).
  if (frame.header) pages.append(frame.header);
  (frame.layer ?? frame.body).append(pages);
  const workerPort = new Worker("/reader/pdf.worker.mjs", { type: "module" });
  if (READER_PROBE) probeCount("workersStarted");
  const worker = PDFWorker.create({ port: workerPort });
  // Checked earlier in this session: the whole file at once. Otherwise by
  // ranges, the first page first; the rest and the check follow (spec 6.3).
  const verified = source.verifiedCopy();
  let firstData = !!verified;
  const loading = getDocument({
    ...(verified
      ? { data: verified }
      : {
          range: new SourceTransport(source, () => {
            if (firstData) return;
            firstData = true;
            frame.onLoadStep?.("parse");
          }),
          rangeChunkSize: PDF_BLOCK,
          // The source fills in the rest itself, shared by every reader.
          disableAutoFetch: true,
          disableStream: true,
        }),
    worker,
    enableXfa: false,
    cMapUrl: "/reader/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/reader/standard_fonts/",
    wasmUrl: "/reader/wasm/",
  });
  let pdf: PDFDocumentProxy | null = null,
    scale = 1,
    closed = false,
    kept: { el: HTMLElement; top: number; area: number } | null = null,
    // A place handed over from the full text, confirmed by its text once the page is drawn.
    confirm: { page: number; text: string; scroll: number } | null = null,
    pendingFollow: { anchor: ReadingAnchor; done: () => void } | null = null,
    // Off screen: no scroll handling and no drawing; position kept.
    hidden = !!frame.startHidden,
    // Started off screen: draws its first screen there so it can show at once.
    preparing = hidden,
    raf = 0,
    sharpTimer: ReturnType<typeof setTimeout> | undefined,
    bitmapBytes = 0;
  let baseWidth = 612,
    baseHeight = 792,
    lastWidth = 0,
    searchRevision = 0,
    query = "",
    // Every occurrence in reading order, and the one the reader is looking at.
    hits: { page: number; index: number }[] = [],
    current = -1,
    reveal = false,
    pageDraft = false;
  const placeholders: HTMLDivElement[] = [],
    sizes = new Map<number, { width: number; height: number }>(),
    // The picture on each page, and a sharper one being drawn to replace it.
    rendered = new Map<number, RenderedPage>(),
    drawing = new Map<number, RenderedPage>(),
    bitmaps = new Map<number, Bitmap>();
  const sizeOf = (n: number) =>
    sizes.get(n) ?? { width: baseWidth, height: baseHeight };
  const release = (r: RenderedPage) => {
    r.layer?.cancel();
    r.render?.cancel();
    r.canvas.width = r.canvas.height = 0;
    if (READER_PROBE) probeCount("canvasesReleased");
    r.text.replaceChildren();
    r.canvas.remove();
    r.text.remove();
  };
  const dropBitmap = (n: number) => {
    const b = bitmaps.get(n);
    if (!b) return;
    bitmaps.delete(n);
    bitmapBytes -= b.bytes;
    b.img.remove();
    URL.revokeObjectURL(b.url);
    if (READER_PROBE) {
      probeCount("objectUrlsRevoked");
      probeBitmap(-b.bytes, { count: bitmaps.size, bytes: bitmapBytes });
    }
    const p = placeholders[n - 1];
    if (p && !rendered.get(n)?.drawn) delete p.dataset.picture;
  };
  /** Keeps a low-resolution copy of a drawn page that leaves the drawn range (spec 5.3). */
  const stash = (n: number, r: RenderedPage) => {
    if (!r.drawn || bitmaps.has(n)) return;
    const size = sizeOf(n),
      ratio = Math.min(BITMAP_SCALE, scale),
      copy = document.createElement("canvas");
    copy.width = Math.max(1, Math.round(size.width * ratio));
    copy.height = Math.max(1, Math.round(size.height * ratio));
    copy.getContext("2d")?.drawImage(r.canvas, 0, 0, copy.width, copy.height);
    copy.toBlob((blob) => {
      const pixels = copy.width * copy.height * 4;
      copy.width = copy.height = 0;
      if (!blob || closed || rendered.get(n)?.drawn || bitmaps.has(n)) return;
      const url = URL.createObjectURL(blob),
        img = document.createElement("img");
      if (READER_PROBE) probeCount("objectUrlsCreated");
      img.className = "reading-pdf-bitmap";
      img.alt = "";
      img.src = url;
      const kept: Bitmap = { img, url, bytes: pixels + blob.size };
      evict(kept.bytes);
      bitmaps.set(n, kept);
      bitmapBytes += kept.bytes;
      if (READER_PROBE)
        probeBitmap(kept.bytes, { count: bitmaps.size, bytes: bitmapBytes });
      // Shown once decoded, so it never shows as an empty frame.
      void img
        .decode()
        .catch(() => undefined)
        .then(() => {
          const p = placeholders[n - 1];
          if (bitmaps.get(n) !== kept || !p || rendered.get(n)?.drawn) return;
          p.prepend(img);
          p.dataset.picture = "bitmap";
        });
    });
  };
  /** Spec 5.3: room for one more within 40 pages and 48 MB per paper; the farthest from the reader go first. */
  const evict = (bytes: number) => {
    while (
      bitmaps.size &&
      (bitmaps.size + 1 > BITMAP_PAGES || bitmapBytes + bytes > BITMAP_BYTES)
    ) {
      let far = 0,
        distance = -1;
      for (const n of bitmaps.keys()) {
        const d = Math.abs(n - state.page);
        if (d > distance) [far, distance] = [n, d];
      }
      dropBitmap(far);
    }
  };
  /** The page leaves the drawn range: its canvases go, a bitmap of it stays when `keep`. */
  const clearPage = (n: number, keepBitmap = true) => {
    const pending = drawing.get(n);
    if (pending) {
      drawing.delete(n);
      release(pending);
      pending.page?.cleanup();
    }
    const r = rendered.get(n);
    if (!r) return;
    rendered.delete(n);
    if (keepBitmap) stash(n, r);
    release(r);
    r.page?.cleanup();
    const p = placeholders[n - 1];
    p?.removeAttribute("data-rendered");
    if (p && !bitmaps.has(n)) delete p.dataset.picture;
  };
  /** A point held in place while the zoom changes (spec 4.2). */
  let held: {
    el: HTMLElement;
    ratioX: number;
    ratioY: number;
    x: number;
    y: number;
  } | null = null;
  frame.holdPoint = (point) => {
    if (!point) {
      if (!held) return;
      held = null;
      capture();
      return;
    }
    const boxes = placeholders.map((p) => p.getBoundingClientRect()),
      at = anchorIndex(boxes, point.y);
    if (at < 0) return;
    const box = boxes[at]!;
    held = {
      el: placeholders[at]!,
      ratioY: anchorRatio(box, point.y),
      // Within the page's width; outside it the page column stays centred.
      ratioX: Math.max(
        0,
        Math.min(1, (point.x - box.left) / Math.max(1, box.width)),
      ),
      x: point.x,
      y: point.y,
    };
  };
  const capture = () => {
    if (
      closed ||
      hidden ||
      !placeholders.length ||
      !frame.body.isConnected ||
      frame.body.clientHeight === 0
    )
      return;
    // The page being read (spec 1.2): the first below the page header that
    // reaches a quarter down the visible desk, so the last strip of the page
    // before (pages lie 16 px apart, spec 3.5) does not count.
    const area = readingArea(frame.body, frame.header),
      top = area.top,
      reach = Math.max(12, area.height / 4);
    const index = placeholders.findIndex(
      (p) => p.getBoundingClientRect().bottom > top + reach,
    );
    const n = index < 0 ? placeholders.length : index + 1;
    state.page = n;
    const r = placeholders[n - 1]!.getBoundingClientRect();
    state.pageOffset = Math.max(
      0,
      Math.min(1, (top - r.top) / Math.max(1, r.height)),
    );
    state.scroll = frame.body.scrollTop;
    // The page at the reading line (spec 4.1) and its top on screen.
    const y = line(),
      boxes = placeholders.map((p) => p.getBoundingClientRect()),
      at = anchorIndex(boxes, y);
    if (at >= 0) {
      state.anchorPage = at + 1;
      state.anchorRatio = anchorRatio(boxes[at]!, y);
      kept = {
        el: placeholders[at]!,
        top: boxes[at]!.top,
        area: frame.body.getBoundingClientRect().top,
      };
    }
    frame.onAnchor?.();
  };
  /** Spec 4.1: 28% down the visible desk, below the page header. */
  function line() {
    return readingLine(readingArea(frame.body, frame.header));
  }
  /** Spec 4.2: after a change of size, the anchor page goes back to where it was, before paint. */
  function keep() {
    if (held && !hidden && !closed && held.el.isConnected) {
      // The point under the pointer stays under it, across and along (spec 1.8.1).
      const box = held.el.getBoundingClientRect();
      const dy = box.top + held.ratioY * box.height - held.y,
        dx = box.left + held.ratioX * box.width - held.x;
      if (Math.abs(dy) >= 0.5) frame.body.scrollTop += dy;
      if (Math.abs(dx) >= 0.5) frame.body.scrollLeft += dx;
      return;
    }
    if (!kept || hidden || closed || !kept.el.isConnected) return;
    const delta = kept.el.getBoundingClientRect().top - kept.top;
    if (Math.abs(delta) >= 0.5) frame.body.scrollTop += delta;
    // The block kept its top; where the reading line falls in it may have changed.
    capture();
  }
  /** Puts the `ratio` point of a page on the reading line. */
  function place(page: number, ratio: number) {
    if (!pdf || closed) return;
    const n = Math.max(1, Math.min(pdf.numPages, Math.trunc(page) || 1));
    state.anchorPage = n;
    state.anchorRatio = ratio;
    // Opened but its pages not laid out yet (the first page is still being
    // read): the place is kept in `state` and taken once they are.
    const target = placeholders[n - 1];
    if (hidden || !target) return;
    frame.body.scrollTop += placeDelta(
      target.getBoundingClientRect(),
      ratio,
      line(),
    );
    capture();
    updateStatus();
    visible();
  }
  const dispose = () => {
    if (closed) return;
    capture();
    closed = true;
    searchRevision++;
    cancelAnimationFrame(raf);
    clearTimeout(sharpTimer);
    resize.disconnect();
    frame.body.removeEventListener("scroll", onScroll);
    marker?.off();
    for (const n of new Set([...rendered.keys(), ...drawing.keys()]))
      clearPage(n, false);
    for (const n of [...bitmaps.keys()]) dropBitmap(n);
    pages.replaceChildren();
    placeholders.length = 0;
    sizes.clear();
    pdf = null;
    worker.destroy();
    workerPort.terminate();
    if (READER_PROBE) probeCount("workersTerminated");
    void loading.destroy().catch((error) => {
      console.warn("PDF cleanup failed", error);
    });
  };
  ctx.signal.addEventListener("abort", dispose, { once: true });
  // The whole check failed, a response did not match or a read broke: the
  // PDF stops showing and its pages are released (ADR 0065 section 6 rule 6).
  // It overrides what an earlier problem said (a password, a broken file).
  let stopped = false;
  source.checked.catch((error: unknown) => {
    if (stopped || ctx.signal.aborted) return;
    stopped = true;
    const problem = pdfProblem(error),
      retry = () => ctx.refresh();
    if (frame.onIssue)
      frame.onIssue(problem.message, retry, {
        retained: problem.retained,
        detail: problem.detail,
      });
    else readerProblem(frame, `${problem.message}${problem.retained}`, retry);
    dispose();
    // Its bytes are of no use now.
    source.release();
  });
  loading.onPassword = () => {
    // The download it offers is the checked file: the check goes on.
    source.complete();
    readerProblem(
      frame,
      "此 PDF 需要密码，当前未提供解密输入。可下载同一份已核验文件。",
    );
    dispose();
  };
  workerPort.addEventListener(
    "error",
    (event) => {
      event.preventDefault();
      if (closed || ctx.signal.aborted) return;
      source.complete();
      readerProblem(
        frame,
        "PDF 阅读组件未能加载。可以重试，或下载同一份已核验文件。",
        () => ctx.refresh(),
      );
      dispose();
    },
    { once: true },
  );
  const updateStatus = () => {
    if (!pdf || closed) return;
    // A queued scroll frame must not replace a page number being edited.
    if (!pageDraft) pageInput.value = String(state.page);
    pageInput.max = String(pdf.numPages);
    node("#reader-page-count", controls).textContent = `/ ${pdf.numPages}`;
    node<HTMLButtonElement>("#reader-previous", controls).disabled =
      state.page <= 1;
    node<HTMLButtonElement>("#reader-next", controls).disabled =
      state.page >= pdf.numPages;
    frame.onPdfControls?.({
      page: state.page,
      total: pdf.numPages,
      zoom: state.zoom,
      scale,
      now: () => ({ zoom: state.zoom, scale }),
      go,
      zoomTo: (value) => {
        capture();
        state.zoom = value;
        reflow();
      },
    });
  };
  /** Wraps each occurrence inside its text-layer run, so only the matched words are tinted. */
  const highlight = (root: HTMLElement, page: number) => {
    const needle = query.toLocaleLowerCase();
    let index = 0;
    for (const span of root.querySelectorAll<HTMLElement>(
      "span:not(.markedContent)",
    )) {
      // Flatten marks from a previous query back into one text node.
      if (span.querySelector("mark"))
        span.replaceChildren(span.textContent ?? "");
      if ([...span.childNodes].some((node) => node.nodeType !== Node.TEXT_NODE))
        continue;
      const text = span.textContent ?? "",
        lower = text.toLocaleLowerCase();
      if (!needle || !lower.includes(needle)) continue;
      const parts: (string | HTMLElement)[] = [];
      let from = 0;
      for (
        let at = lower.indexOf(needle);
        at >= 0;
        at = lower.indexOf(needle, at + needle.length)
      ) {
        const mark = document.createElement("mark");
        mark.className = "pdf-search-hit";
        mark.dataset.hit = String(index++);
        mark.textContent = text.slice(at, at + needle.length);
        parts.push(text.slice(from, at), mark);
        from = at + needle.length;
      }
      parts.push(text.slice(from));
      span.replaceChildren(...parts);
    }
    const hit = hits[current];
    if (hit?.page !== page) return;
    const mark = root.querySelector<HTMLElement>(
      `mark[data-hit="${hit.index}"]`,
    );
    mark?.classList.add("pdf-search-current");
    if (mark && reveal) {
      reveal = false;
      // The page is already scrolled into place; only move again if the match
      // is still outside the viewport, so the page indicator stays truthful.
      mark.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  };
  const occurrences = (text: string, needle: string) => {
    let count = 0;
    for (
      let at = text.indexOf(needle);
      at >= 0;
      at = text.indexOf(needle, at + needle.length)
    )
      count++;
    return count;
  };
  /**
   * Draws page `n` at the current scale off the page, then puts it in place of
   * its stretched picture, bitmap or placeholder in one step (spec 5.3).
   */
  const draw = async (n: number, offScreen = false) => {
    if (!pdf || closed || (hidden && !offScreen)) return;
    if (rendered.get(n)?.scale === scale) return;
    const pending = drawing.get(n);
    if (pending?.scale === scale) return;
    if (pending) {
      drawing.delete(n);
      release(pending);
    }
    const placeholder = placeholders[n - 1]!;
    const entry: RenderedPage = {
      canvas: document.createElement("canvas"),
      text: document.createElement("div"),
      scale,
    };
    entry.text.className = "textLayer";
    if (READER_PROBE) probeCount("canvasesCreated");
    drawing.set(n, entry);
    const stale = () => closed || drawing.get(n) !== entry;
    try {
      const p = await pdf.getPage(n);
      entry.page = p;
      if (stale()) return;
      const base = p.getViewport({ scale: 1 }),
        known = sizeOf(n);
      sizes.set(n, { width: base.width, height: base.height });
      if (known.width !== base.width || known.height !== base.height) {
        placeholder.style.width = `${base.width * scale}px`;
        placeholder.style.height = `${base.height * scale}px`;
        // A page of another size: the anchor stays where it was.
        keep();
      }
      const viewport = p.getViewport({ scale: entry.scale });
      const ratio = Math.min(devicePixelRatio || 1, 2);
      entry.canvas.width = Math.ceil(viewport.width * ratio);
      entry.canvas.height = Math.ceil(viewport.height * ratio);
      entry.render = p.render({
        canvas: entry.canvas,
        viewport,
        ...(ratio === 1 ? {} : { transform: [ratio, 0, 0, ratio, 0, 0] }),
      });
      await entry.render.promise;
      if (stale()) return;
      entry.layer = new TextLayer({
        textContentSource: p.streamTextContent(),
        container: entry.text,
        viewport,
      });
      await entry.layer.render();
      if (stale()) return;
      // Replace in one step: the picture never leaves the page.
      drawing.delete(n);
      const old = rendered.get(n);
      rendered.set(n, entry);
      entry.drawn = true;
      entry.canvas.style.width = `${base.width * scale}px`;
      entry.canvas.style.height = `${base.height * scale}px`;
      placeholder.style.setProperty("--total-scale-factor", String(scale));
      if (old?.canvas.isConnected) {
        old.canvas.replaceWith(entry.canvas);
        if (old.text.isConnected) old.text.replaceWith(entry.text);
        else entry.canvas.after(entry.text);
      } else placeholder.prepend(entry.canvas, entry.text);
      if (old) release(old);
      dropBitmap(n);
      placeholder.dataset.picture = "canvas";
      placeholder.querySelector(".pdf-region-highlight")?.remove();
      if (frame.pdfLocation?.page === n && frame.pdfLocation.region) {
        const [x0, y0, x1, y1] = frame.pdfLocation.region,
          highlight = document.createElement("div");
        highlight.className = "pdf-region-highlight";
        highlight.setAttribute("aria-label", "证据对应区域");
        Object.assign(highlight.style, {
          left: `${x0 / 10}%`,
          top: `${y0 / 10}%`,
          width: `${(x1 - x0) / 10}%`,
          height: `${(y1 - y0) / 10}%`,
        });
        placeholder.append(highlight);
      }
      highlight(entry.text, n);
      placeholder.dataset.rendered = "true";
      // Off screen the scroll area belongs to the view on screen: confirm once shown.
      if (confirm?.page === n && !hidden) settle(entry.text);
      frame.onPdfPage?.({
        page: n,
        element: placeholder,
        text: entry.text,
        width: base.width,
        height: base.height,
      });
      ctx.root.dataset.readingReady = "true";
      // A page is on screen: the rest of the file and its check follow.
      source.complete();
      if (firstPaint && n === state.page) {
        firstPaint = false;
        performance.measure("sciretriever-pdf-first-paint", {
          start: paintStarted,
          end: performance.now(),
        });
      }
    } catch (error) {
      if (
        !stale() &&
        !(
          error instanceof Error && error.name === "RenderingCancelledException"
        )
      ) {
        console.warn("PDF page rendering failed", n, error);
        // Kept as the page's entry so the failed page is not drawn again and again.
        drawing.delete(n);
        const old = rendered.get(n);
        if (old) release(old);
        rendered.set(n, entry);
        placeholder.dataset.error = "true";
        const note = document.createElement("p");
        note.textContent = `第 ${n} 页暂时无法渲染`;
        placeholder.append(note);
      }
    }
  };
  /** Visible pages and one either side (spec 5.3), nearest the reading line first. */
  const range = () => {
    const rect = frame.body.getBoundingClientRect();
    const first = Math.max(
      0,
      placeholders.findIndex(
        (p) => p.getBoundingClientRect().bottom > rect.top,
      ),
    );
    let last = first;
    while (
      last + 1 < placeholders.length &&
      placeholders[last + 1]!.getBoundingClientRect().top < rect.bottom
    )
      last++;
    const wanted: number[] = [];
    for (
      let i = Math.max(0, first - 1);
      i <= Math.min(placeholders.length - 1, last + 1);
      i++
    )
      wanted.push(i + 1);
    return wanted.sort(
      (a, b) => Math.abs(a - state.anchorPage) - Math.abs(b - state.anchorPage),
    );
  };
  const visible = () => {
    if (!pdf || closed || hidden) return;
    const wanted = range(),
      inRange = new Set(wanted);
    for (const n of new Set([...rendered.keys(), ...drawing.keys()]))
      if (!inRange.has(n)) clearPage(n);
    // While the size is still changing, stretched pages wait for `sharpen`.
    for (const n of wanted)
      if (sharpTimer === undefined || !rendered.has(n)) void draw(n);
  };
  /** Spec 5.3: the size stopped changing; draw the stretched pages sharp, one by one. */
  const sharpen = () => {
    sharpTimer = undefined;
    visible();
  };
  const go = (page: number, offset = 0) => {
    if (!pdf || closed) return;
    state.page = Math.max(1, Math.min(pdf.numPages, Math.trunc(page) || 1));
    state.pageOffset = offset;
    // Hidden: remember the place; `show` scrolls there.
    const target = placeholders[state.page - 1];
    if (hidden || !target) return;
    // The first page's top is the column's top: the sheet as it opens (spec 3.5).
    if (state.page === 1 && offset === 0) frame.body.scrollTop = 0;
    else
      frame.body.scrollTop +=
        target.getBoundingClientRect().top -
        readingArea(frame.body, frame.header).top +
        target.clientHeight * offset -
        12;
    updateStatus();
    visible();
  };
  function onScroll() {
    if (hidden) return;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      capture();
      updateStatus();
      visible();
    });
  }
  /**
   * Spec 5.3: a new size stretches the drawn pictures at once, in the same
   * frame as the anchor (4.2); 120 ms after the last change they are drawn sharp.
   * Nothing is cleared first.
   */
  const columnsNow = () => Math.max(1, frame.pdfColumns ?? 1);
  /** Spec 3.5: one page's width at 适宽 — the sheet's, or a share of the desk beside a twin. */
  const fitWidth = () => {
    const desk = frame.body.clientWidth,
      columns = columnsNow();
    return frame.pageColumn
      ? frame.pageColumn(desk, null, columns).pageWidth
      : (desk - 52 - (columns - 1) * 24) / columns;
  };
  /** The page column where the sheet is, or centred with the spine when zoomed (spec 3.5). */
  const placeColumn = () => {
    const desk = frame.body.clientWidth,
      page = baseWidth * scale,
      column = frame.pageColumn?.(
        desk,
        state.zoom === "fit" ? null : page,
        columnsNow(),
      );
    // The page header spans the page column (spec 1.2).
    pages.style.setProperty("--pdf-page-width", `${page}px`);
    pages.style.setProperty("--pdf-column-left", `${column?.left ?? 0}px`);
  };
  const reflow = () => {
    if (!pdf || closed) return;
    const page = state.page,
      offset = state.pageOffset;
    scale =
      state.zoom === "fit"
        ? Math.max(0.15, Math.min(3, fitWidth() / baseWidth))
        : state.zoom;
    placeColumn();
    for (let i = 0; i < placeholders.length; i++) {
      const size = sizeOf(i + 1),
        p = placeholders[i]!;
      p.style.width = `${size.width * scale}px`;
      p.style.height = `${size.height * scale}px`;
      p.style.setProperty("--total-scale-factor", String(scale));
    }
    for (const [n, r] of rendered) {
      const size = sizeOf(n);
      r.canvas.style.width = `${size.width * scale}px`;
      r.canvas.style.height = `${size.height * scale}px`;
    }
    if (rendered.size || drawing.size) {
      clearTimeout(sharpTimer);
      sharpTimer = setTimeout(sharpen, SHARPEN_MS);
    }
    // The anchor page keeps its place across the new size (spec 4.2).
    if (kept?.el.isConnected && !hidden) {
      keep();
      updateStatus();
      visible();
    } else go(page, offset);
  };
  const resize = new ResizeObserver(() => {
    if (hidden) return;
    // A bar above or a narrower panel moves the pages; a new width refits them, in this frame.
    const width = frame.body.clientWidth,
      wider = Math.abs(lastWidth - width) >= 1;
    lastWidth = width;
    if (wider && state.zoom === "fit") reflow();
    else {
      // Zoomed: the same pages, centred again on the new desk.
      if (wider) placeColumn();
      keep();
    }
  });
  let left: { el: HTMLElement; offset: number } | null = null;
  frame.hide = (release = false) => {
    if (closed) return;
    if (!hidden) {
      // Measured when last read: the scroll area may already carry the next view's padding.
      left = kept ? { el: kept.el, offset: kept.top - kept.area } : null;
      hidden = true;
      cancelAnimationFrame(raf);
      clearTimeout(sharpTimer);
      sharpTimer = undefined;
    }
    // Released: no canvas stays; bitmaps of the pages shown do (spec 5.3).
    if (release)
      for (const n of new Set([...rendered.keys(), ...drawing.keys()]))
        clearPage(n);
  };
  frame.show = () => {
    if (closed || !hidden) return;
    hidden = false;
    preparing = false;
    if (!pdf) return;
    const width = frame.body.clientWidth;
    // The window, the side panel or the reading size (the sheet) changed
    // while hidden: fit again.
    if (
      state.zoom === "fit" &&
      (Math.abs(lastWidth - width) >= 1 ||
        Math.abs(fitWidth() - baseWidth * scale) >= 1)
    ) {
      lastWidth = width;
      kept = null;
      reflow();
    } else if (Math.abs(lastWidth - width) >= 1) {
      lastWidth = width;
      placeColumn();
    }
    // The anchor page returns to its distance from the top.
    if (left?.el.isConnected)
      frame.body.scrollTop +=
        left.el.getBoundingClientRect().top -
        frame.body.getBoundingClientRect().top -
        left.offset;
    else place(state.anchorPage, state.anchorRatio);
    left = null;
    capture();
    updateStatus();
    visible();
  };
  /** Spec 4.3: confirm a place from the full text by its words on the drawn page. */
  function settle(layer: HTMLElement) {
    const wanted = confirm;
    confirm = null;
    // The reader moved on meanwhile: leave the place alone.
    if (!wanted || Math.abs(frame.body.scrollTop - wanted.scroll) > 1) return;
    const index = indexText(layer),
      pattern = canon(wanted.text).slice(0, 160),
      found = pattern.length >= 12 ? locate(pattern, index.text) : null;
    if (!found || found.sim < PLACE) return;
    const box = rangeOf(index, found.start, found.end)?.getClientRects()[0];
    if (!box) return;
    frame.body.scrollTop += box.top - line();
    capture();
  }
  /**
   * Spec 3.5: from the full text, a 2 px line left of the paragraph's region
   * on its page; it fades after 3 s or at the reader's next scroll.
   */
  let marker: { el: HTMLElement; off: () => void } | null = null;
  const locator = (
    page: number,
    region: readonly [number, number, number, number],
  ) => {
    marker?.off();
    const host = placeholders[page - 1];
    if (!host) return;
    const el = document.createElement("div");
    el.className = "reading-pdf-locator";
    el.setAttribute("aria-hidden", "true");
    el.style.top = `${region[1] / 10}%`;
    el.style.height = `${Math.max(0, region[3] - region[1]) / 10}%`;
    el.style.left = `calc(${region[0] / 10}% - 8px)`;
    host.append(el);
    let armed = false;
    const fade = () => {
      if (marker?.el !== el) return;
      marker.off();
    };
    const onScroll = () => {
      if (armed) fade();
    };
    const timer = setTimeout(fade, 3000);
    // The next scroll by the reader, not the one that brought the page here.
    const arm = requestAnimationFrame(() =>
      requestAnimationFrame(() => (armed = true)),
    );
    frame.body.addEventListener("scroll", onScroll, { passive: true });
    marker = {
      el,
      off: () => {
        clearTimeout(timer);
        cancelAnimationFrame(arm);
        frame.body.removeEventListener("scroll", onScroll);
        marker = null;
        el.dataset.fading = "true";
        // Gone once faded; at once where no transition runs.
        const remove = () => el.remove();
        el.addEventListener("transitionend", remove, { once: true });
        setTimeout(remove, 400);
      },
    };
  };
  frame.anchor = () => {
    return {
      kind: "pdf",
      page: state.anchorPage,
      ratio: state.anchorRatio,
      label: `第 ${state.anchorPage} 页`,
    };
  };
  frame.isVisible = (anchor) => {
    if (anchor.kind !== "pdf" || hidden) return false;
    const el = placeholders[anchor.page - 1];
    if (!el) return false;
    const box = el.getBoundingClientRect(),
      area = frame.body.getBoundingClientRect();
    return box.bottom > area.top && box.top < area.bottom;
  };
  if (frame.queuedFollow) {
    pendingFollow = frame.queuedFollow;
    delete frame.queuedFollow;
  }
  frame.follow = (anchor) => {
    // Before the document is open and its pages are laid out the place
    // waits; the promise settles once it is taken.
    if (!pdf || !placeholders.length)
      return new Promise<void>((done) => {
        pendingFollow = { anchor, done };
      });
    if (anchor.kind === "pdf") {
      place(anchor.page, anchor.ratio);
      return;
    }
    // Full text → PDF: the block's page and region, else the nearest earlier block's.
    if (!anchor.pdf) {
      frame.onNote?.("PDF 中找不到这一段的对应位置。");
      return;
    }
    place(anchor.pdf.page, anchor.pdf.ratio);
    if (anchor.pdf.exact && anchor.region)
      locator(anchor.pdf.page, anchor.region);
    frame.onNote?.(
      anchor.pdf.exact
        ? null
        : `PDF 中找不到这一段的对应位置，已停在最接近处（第 ${anchor.pdf.page} 页）。`,
    );
    if (anchor.pdf.exact && anchor.text) {
      confirm = {
        page: anchor.pdf.page,
        text: anchor.text,
        scroll: frame.body.scrollTop,
      };
      const drawn = rendered.get(anchor.pdf.page);
      if (placeholders[anchor.pdf.page - 1]?.dataset.rendered && drawn)
        settle(drawn.text);
    }
  };
  try {
    pdf = await loading.promise;
    paintStarted = performance.now();
    performance.measure("sciretriever-pdf-parse", {
      start: parseStarted,
      end: paintStarted,
    });
    if (ctx.signal.aborted) {
      dispose();
      return;
    }
    // Spec 6.3: parsed, with its page count; the first screen is laid out next.
    frame.onLoadStep?.("parse", { done: pdf.numPages, total: pdf.numPages });
    frame.onLoadStep?.("layout");
    const first = await pdf.getPage(1),
      base = first.getViewport({ scale: 1 });
    baseWidth = base.width;
    baseHeight = base.height;
    first.cleanup();
    for (let n = 1; n <= pdf.numPages; n++) {
      const p = document.createElement("div");
      p.className = "reading-pdf-page";
      p.dataset.pdfPage = String(n);
      p.setAttribute("aria-label", `PDF 第 ${n} 页`);
      placeholders.push(p);
      pages.append(p);
    }
    frame.body.addEventListener("scroll", onScroll, { passive: true });
    frame.beforeLayout = () => {
      capture();
      return () => {
        if (state.zoom === "fit") reflow();
      };
    };
    pageInput.oninput = () => {
      pageDraft = true;
    };
    pageInput.onchange = () => {
      pageDraft = false;
      go(Number(pageInput.value));
    };
    zoom.onchange = () => {
      capture();
      state.zoom = zoom.value === "fit" ? "fit" : Number(zoom.value);
      reflow();
    };
    node("#reader-previous", controls).onclick = () => go(state.page - 1);
    node("#reader-next", controls).onclick = () => go(state.page + 1);
    lastWidth = frame.body.clientWidth;
    resize.observe(frame.body);
    reflow();
    // A place handed over or remembered goes on the reading line; else the page's top.
    // Assigned by `follow` meanwhile, which narrowing cannot see.
    const waiting = pendingFollow as {
      anchor: ReadingAnchor;
      done: () => void;
    } | null;
    if (waiting) {
      pendingFollow = null;
      void frame.follow(waiting.anchor);
      waiting.done();
    } else if (frame.remembered === "same")
      place(state.anchorPage, state.anchorRatio);
    if (preparing)
      // Off screen there is no layout: draw the page at the reading line and its neighbours.
      await Promise.all(
        [state.anchorPage, state.anchorPage - 1, state.anchorPage + 1]
          .filter((n) => n >= 1 && n <= pdf!.numPages)
          .map((n) => draw(n, true)),
      );
    else await draw(state.page);
    const outline = await pdf.getOutline();
    if (closed) return;
    frame.outline.replaceChildren();
    if (!outline?.length) {
      frame.outline.textContent = "此 PDF 没有内嵌目录。可使用页码或查找。";
      frame.onOutlineEmpty?.(frame.outline.textContent);
    }
    const appendOutline = (items: NonNullable<typeof outline>, level = 0) => {
      for (const item of items) {
        const activate = async () => {
          if (!pdf || closed) return;
          frame.beforeJump?.();
          const dest =
            typeof item.dest === "string"
              ? await pdf.getDestination(item.dest)
              : item.dest;
          if (!dest?.length) {
            frame.onNote?.("此目录项没有可定位的内部页码。");
            return;
          }
          const value = dest[0];
          const index =
            typeof value === "number" ? value : await pdf.getPageIndex(value);
          if (!closed) go(index + 1);
        };
        if (frame.onOutline)
          frame.onOutline({
            title: item.title || "未命名章节",
            level,
            activate,
          });
        else {
          const b = button(item.title || "未命名章节", activate);
          b.style.paddingInlineStart = `${8 + Math.min(level, 6) * 12}px`;
          frame.outline.append(b);
        }
        if (item.items?.length) appendOutline(item.items, level + 1);
      }
    };
    if (outline) appendOutline(outline);
    const status = () => {
      const pages = new Set(hits.map((hit) => hit.page)).size;
      frame.findStatus.textContent = `第 ${current + 1} / ${hits.length} 处 · ${pages} 页`;
    };
    const show = (index: number) => {
      current = index;
      reveal = true;
      const hit = hits[index]!;
      go(hit.page);
      for (const [n, entry] of rendered) highlight(entry.text, n);
      status();
      if (frame.onFindNext) frame.onFindNext(next);
      else frame.findStatus.append(button("下一处命中", () => next()));
    };
    const next = (step: 1 | -1 = 1) =>
      show((current + step + hits.length) % hits.length);
    frame.onFind = async (text) => {
      const revision = ++searchRevision,
        found: { page: number; index: number }[] = [],
        needle = text.toLocaleLowerCase();
      let hasText = false;
      query = text;
      hits = [];
      current = -1;
      frame.onFindNext?.(null);
      frame.findStatus.textContent = "正在查找 PDF 自带的文字…";
      for (let n = 1; pdf && n <= pdf.numPages; n++) {
        if (closed || revision !== searchRevision) return;
        const page = await pdf.getPage(n),
          content = await page.getTextContent();
        let index = 0;
        for (const item of content.items) {
          if (!("str" in item)) continue;
          if (item.str.trim()) hasText = true;
          // Count per text run, exactly as the text layer is highlighted.
          for (
            let k = needle
              ? occurrences(item.str.toLocaleLowerCase(), needle)
              : 0;
            k > 0;
            k--
          )
            found.push({ page: n, index: index++ });
        }
        if (!rendered.has(n) && !drawing.has(n)) page.cleanup();
      }
      if (closed || revision !== searchRevision) return;
      hits = found;
      frame.onFindHits?.([...new Set(found.map((hit) => hit.page))]);
      if (hits.length) show(0);
      else {
        frame.findStatus.textContent = hasText
          ? "未找到匹配关键词。"
          : "此 PDF 没有自带的文字可以检索，可能是扫描文件。";
        for (const [n, entry] of rendered) highlight(entry.text, n);
      }
    };
  } catch {
    // A file PDF.js cannot open may be one that does not match its record:
    // the whole check says which, and only a file that passed it is offered.
    if (!ctx.signal.aborted && !stopped) {
      source.complete();
      void source.checked.then(
        () => {
          if (!ctx.signal.aborted && !stopped)
            readerProblem(
              frame,
              "PDF 无法打开，文件读取或渲染未完成。可下载同一份已核验文件。",
            );
        },
        () => undefined,
      );
    }
    dispose();
  }
}
