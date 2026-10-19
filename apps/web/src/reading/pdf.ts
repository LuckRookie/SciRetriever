import {
  getDocument,
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

type RenderedPage = {
  canvas: HTMLCanvasElement;
  text: HTMLDivElement;
  page?: PDFPageProxy;
  render?: RenderTask;
  layer?: TextLayer;
  generation: number;
};
/** Only visible and adjacent pages own canvas/text layers. The PDF worker belongs to this mount. */
export async function renderPdf(
  ctx: ReadingContext,
  frame: ReaderFrame,
  state: ReadingPosition,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<void> {
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
  frame.body.append(pages);
  const workerPort = new Worker("/reader/pdf.worker.mjs", { type: "module" });
  const worker = PDFWorker.create({ port: workerPort });
  const loading = getDocument({
    data: bytes.slice(),
    worker,
    enableXfa: false,
    cMapUrl: "/reader/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/reader/standard_fonts/",
    wasmUrl: "/reader/wasm/",
  });
  let pdf: PDFDocumentProxy | null = null,
    scale = 1,
    generation = 0,
    closed = false,
    raf = 0,
    resizeTimer: ReturnType<typeof setTimeout> | undefined;
  let baseWidth = 612,
    baseHeight = 792,
    lastWidth = 0,
    searchRevision = 0,
    query = "",
    pageDraft = false;
  const placeholders: HTMLDivElement[] = [],
    sizes = new Map<number, { width: number; height: number }>(),
    rendered = new Map<number, RenderedPage>();
  const clearPage = (n: number) => {
    const r = rendered.get(n);
    if (!r) return;
    rendered.delete(n);
    r.layer?.cancel();
    r.render?.cancel();
    r.canvas.width = r.canvas.height = 0;
    r.text.replaceChildren();
    r.canvas.remove();
    r.text.remove();
    r.page?.cleanup();
    placeholders[n - 1]?.removeAttribute("data-rendered");
  };
  const capture = () => {
    if (
      closed ||
      !placeholders.length ||
      !frame.body.isConnected ||
      frame.body.clientHeight === 0
    )
      return;
    const top = frame.body.getBoundingClientRect().top;
    const index = placeholders.findIndex(
      (p) => p.getBoundingClientRect().bottom > top + 12,
    );
    const n = index < 0 ? placeholders.length : index + 1;
    state.page = n;
    const r = placeholders[n - 1]!.getBoundingClientRect();
    state.pageOffset = Math.max(
      0,
      Math.min(1, (top - r.top) / Math.max(1, r.height)),
    );
    state.scroll = frame.body.scrollTop;
  };
  const dispose = () => {
    if (closed) return;
    capture();
    closed = true;
    generation++;
    searchRevision++;
    cancelAnimationFrame(raf);
    clearTimeout(resizeTimer);
    resize.disconnect();
    frame.body.removeEventListener("scroll", onScroll);
    for (const n of rendered.keys()) clearPage(n);
    pages.replaceChildren();
    placeholders.length = 0;
    sizes.clear();
    pdf = null;
    worker.destroy();
    workerPort.terminate();
    void loading.destroy().catch((error) => {
      console.warn("PDF cleanup failed", error);
    });
  };
  ctx.signal.addEventListener("abort", dispose, { once: true });
  loading.onPassword = () => {
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
    frame.status.textContent = `固定 PDF · 第 ${state.page} / ${pdf.numPages} 页 · ${state.zoom === "fit" ? "适宽" : `${Math.round(state.zoom * 100)}%`}`;
    frame.onPdfControls?.({
      page: state.page,
      total: pdf.numPages,
      zoom: state.zoom,
      go,
      zoomTo: (value) => {
        capture();
        state.zoom = value;
        reflow();
      },
    });
  };
  const highlight = (root: HTMLElement) => {
    for (const el of root.querySelectorAll<HTMLElement>("span"))
      el.classList.toggle(
        "pdf-search-hit",
        !!query &&
          (el.textContent ?? "")
            .toLocaleLowerCase()
            .includes(query.toLocaleLowerCase()),
      );
  };
  const draw = async (n: number) => {
    if (!pdf || closed || rendered.has(n)) return;
    const placeholder = placeholders[n - 1]!;
    const entry: RenderedPage = {
      canvas: document.createElement("canvas"),
      text: document.createElement("div"),
      generation,
    };
    entry.text.className = "textLayer";
    rendered.set(n, entry);
    try {
      const p = await pdf.getPage(n);
      entry.page = p;
      if (
        closed ||
        rendered.get(n) !== entry ||
        entry.generation !== generation
      ) {
        p.cleanup();
        return;
      }
      const base = p.getViewport({ scale: 1 });
      sizes.set(n, { width: base.width, height: base.height });
      const viewport = p.getViewport({ scale });
      placeholder.style.width = `${viewport.width}px`;
      placeholder.style.height = `${viewport.height}px`;
      placeholder.style.setProperty("--total-scale-factor", String(scale));
      const ratio = Math.min(devicePixelRatio || 1, 2);
      entry.canvas.width = Math.ceil(viewport.width * ratio);
      entry.canvas.height = Math.ceil(viewport.height * ratio);
      entry.canvas.style.width = `${viewport.width}px`;
      entry.canvas.style.height = `${viewport.height}px`;
      entry.text.style.width = `${viewport.width}px`;
      entry.text.style.height = `${viewport.height}px`;
      placeholder.append(entry.canvas, entry.text);
      entry.render = p.render({
        canvas: entry.canvas,
        viewport,
        ...(ratio === 1 ? {} : { transform: [ratio, 0, 0, ratio, 0, 0] }),
      });
      await entry.render.promise;
      if (
        closed ||
        rendered.get(n) !== entry ||
        entry.generation !== generation
      )
        return;
      entry.layer = new TextLayer({
        textContentSource: p.streamTextContent(),
        container: entry.text,
        viewport,
      });
      await entry.layer.render();
      if (closed || rendered.get(n) !== entry) return;
      highlight(entry.text);
      placeholder.dataset.rendered = "true";
      ctx.root.dataset.readingReady = "true";
      if (firstPaint && n === state.page) {
        firstPaint = false;
        performance.measure("sciretriever-pdf-first-paint", {
          start: paintStarted,
          end: performance.now(),
        });
      }
    } catch (error) {
      if (
        !closed &&
        rendered.get(n) === entry &&
        !(
          error instanceof Error && error.name === "RenderingCancelledException"
        )
      ) {
        console.warn("PDF page rendering failed", n, error);
        placeholder.dataset.error = "true";
        const note = document.createElement("p");
        note.textContent = `第 ${n} 页暂时无法渲染`;
        placeholder.append(note);
      }
    }
  };
  const visible = () => {
    if (!pdf || closed) return;
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
    const wanted = new Set<number>();
    for (
      let i = Math.max(0, first - 1);
      i <= Math.min(placeholders.length - 1, last + 1);
      i++
    )
      wanted.add(i + 1);
    for (const n of rendered.keys()) if (!wanted.has(n)) clearPage(n);
    for (const n of wanted) void draw(n);
  };
  const go = (page: number, offset = 0) => {
    if (!pdf || closed) return;
    state.page = Math.max(1, Math.min(pdf.numPages, Math.trunc(page) || 1));
    state.pageOffset = offset;
    const target = placeholders[state.page - 1]!;
    frame.body.scrollTop +=
      target.getBoundingClientRect().top -
      frame.body.getBoundingClientRect().top +
      target.clientHeight * offset -
      12;
    updateStatus();
    visible();
  };
  function onScroll() {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      capture();
      updateStatus();
      visible();
    });
  }
  const reflow = () => {
    if (!pdf || closed) return;
    const page = state.page,
      offset = state.pageOffset;
    generation++;
    for (const n of rendered.keys()) clearPage(n);
    scale =
      state.zoom === "fit"
        ? Math.max(0.15, Math.min(3, (frame.body.clientWidth - 52) / baseWidth))
        : state.zoom;
    for (let i = 0; i < placeholders.length; i++) {
      const size = sizes.get(i + 1) ?? { width: baseWidth, height: baseHeight };
      placeholders[i]!.style.width = `${size.width * scale}px`;
      placeholders[i]!.style.height = `${size.height * scale}px`;
    }
    go(page, offset);
  };
  const resize = new ResizeObserver(() => {
    const width = frame.body.clientWidth;
    if (Math.abs(lastWidth - width) < 1) return;
    lastWidth = width;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (state.zoom === "fit") reflow();
    }, 80);
  });
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
    await draw(state.page);
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
          const dest =
            typeof item.dest === "string"
              ? await pdf.getDestination(item.dest)
              : item.dest;
          if (!dest?.length) {
            frame.status.textContent = "此目录项没有可定位的内部页码。";
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
    frame.onFind = async (text) => {
      const revision = ++searchRevision,
        matches: number[] = [];
      let hasText = false;
      query = text;
      frame.onFindNext?.(null);
      frame.findStatus.textContent = "正在查找 PDF 文字层…";
      for (let n = 1; pdf && n <= pdf.numPages; n++) {
        if (closed || revision !== searchRevision) return;
        const page = await pdf.getPage(n),
          content = await page.getTextContent();
        const textValue = content.items
          .flatMap((item) => ("str" in item ? [item.str] : []))
          .join(" ");
        if (textValue.trim()) hasText = true;
        if (textValue.toLocaleLowerCase().includes(text.toLocaleLowerCase()))
          matches.push(n);
        if (!rendered.has(n)) page.cleanup();
      }
      if (closed || revision !== searchRevision) return;
      frame.findStatus.textContent = matches.length
        ? `命中 ${matches.length} 页`
        : hasText
          ? "未找到匹配关键词。"
          : "此 PDF 没有可检索文字层，可能是扫描文件。";
      if (matches.length) {
        go(matches[0]!);
        const next = () => {
          const i = matches.indexOf(state.page);
          go(matches[(i + 1) % matches.length]!);
        };
        if (frame.onFindNext) frame.onFindNext(next);
        else frame.findStatus.append(button("下一处命中", next));
      }
      for (const entry of rendered.values()) highlight(entry.text);
    };
  } catch (error) {
    if (!ctx.signal.aborted)
      readerProblem(
        frame,
        `PDF 无法打开：${error instanceof Error ? error.message : "格式或 worker 不可用"}。可下载同一份已核验文件。`,
      );
    dispose();
  }
}
