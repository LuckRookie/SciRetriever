import type {
  MarkColor,
  MarkDocumentAnchor,
  MarkPdfAnchor,
  MarkRect,
  MarkTarget,
  ReadingMark,
} from "@sciretriever/contracts";
import type { PdfPageView } from "./contract.js";
import { recordedPlace, relocate, wantsSearch } from "./mark-relocate.js";
import {
  APPROXIMATE,
  PLACE,
  canon,
  indexText,
  locate,
  rangeOf,
} from "./mark-locate.js";

/**
 * Draws a paper's reading marks on the reader engines and turns pointer
 * gestures into drafts (ADR 0046). Framework-neutral: React owns the marks
 * and the toolbars, this layer owns geometry. PDF marks sit in two layers per
 * drawn page, sized in percent of the page so zoom never redraws them; the
 * full text uses CSS highlights, so its DOM is never changed.
 */
export type MarkTool = "select" | "pen" | "region";
export interface SelectionDraft {
  readonly quote: string;
  readonly prefix: string;
  readonly suffix: string;
  readonly pdf: MarkPdfAnchor | null;
  readonly document: MarkDocumentAnchor | null;
  readonly anchor: DOMRect;
}
export interface RegionDraft {
  readonly pdf: MarkPdfAnchor;
  readonly anchor: DOMRect;
}
export interface MarkSurfaceEvents {
  hot(id: string | null): void;
  activate(id: string, anchor: DOMRect, viaMarker: boolean): void;
  /** A mark found on another material (9.4): record where, with how close. */
  record?(id: string, target: MarkTarget, similarity: number): void;
  /** Whether a mark belongs to the part shown (9.4 “只在同一部分里找”). */
  samePart?(mark: ReadingMark): boolean;
  /** A PDF note marker hovered (spec 3.5): show its note, or stop (null). */
  peek?(id: string | null, anchor: DOMRect | null): void;
  selection(draft: SelectionDraft | null): void;
  region(draft: RegionDraft): void;
  /** A mark found its place on this material; React saves the second anchor. */
  place(
    id: string,
    anchor: { pdf?: MarkPdfAnchor; document?: MarkDocumentAnchor },
  ): void;
  /** Marks this view shows, and those only approximately placed. */
  placed?(placed: ReadonlySet<string>, approximate: ReadonlySet<string>): void;
}
export interface MarkSurface {
  setMarks(marks: readonly ReadingMark[]): void;
  setHot(id: string | null): void;
  setTool(tool: MarkTool): void;
  preview(color: MarkColor | null): void;
  reveal(id: string): boolean;
  /** The full-text block a mark starts in (its note goes below it, spec 2.5). */
  blockOf?(id: string): HTMLElement | null;
  /** The mark under the pointer of this event, if any (the context menu's target). */
  markAt(event: MouseEvent): string | null;
  anchorRect(id: string): DOMRect | null;
  clearSelection(): void;
  /** Where each placed mark sits along the scroll height, 0-1. */
  positions(): { id: string; color: MarkColor; at: number }[];
  /** Copies a region from its drawn page into `target`; false while the page is not drawn. */
  drawThumbnail(id: string, target: HTMLCanvasElement): boolean;
  pdfPage(view: PdfPageView): void;
  documentPainted(): void;
  destroy(): void;
}

const norm = (s: string) => s.replace(/\s+/gu, " ").trim();
const reduced = () =>
  document.documentElement.dataset.reducedMotion === "true" ||
  matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Merge the browser's per-fragment rectangles into one per line and column, in page units. */
function lineRects(range: Range, page: HTMLElement, scale: number): MarkRect[] {
  const box = page.getBoundingClientRect();
  const raw = [...range.getClientRects()]
    .filter((r) => r.width > 0.5 && r.height > 3)
    .filter((r) => {
      const x = r.left + r.width / 2,
        y = r.top + r.height / 2;
      return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
    })
    .map((r) => ({
      x: (r.left - box.left) / scale,
      y: (r.top - box.top) / scale,
      w: r.width / scale,
      h: r.height / scale,
    }))
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: { x: number; y: number; w: number; h: number }[] = [];
  for (const r of raw) {
    const line = lines.find(
      (l) =>
        Math.min(l.y + l.h, r.y + r.h) - Math.max(l.y, r.y) >
          Math.min(l.h, r.h) * 0.5 &&
        r.x <= l.x + l.w + 10 &&
        r.x + r.w >= l.x - 10,
    );
    if (line) {
      const x2 = Math.max(line.x + line.w, r.x + r.w),
        y2 = Math.max(line.y + line.h, r.y + r.h);
      line.x = Math.min(line.x, r.x);
      line.y = Math.min(line.y, r.y);
      line.w = x2 - line.x;
      line.h = y2 - line.y;
    } else lines.push({ ...r });
  }
  return lines
    .slice(0, 400)
    .map((l) => [l.x - 0.5, l.y, l.w + 1, l.h] as const);
}
function context(range: Range, root: Node) {
  const before = document.createRange(),
    after = document.createRange();
  before.setStart(root, 0);
  before.setEnd(range.startContainer, range.startOffset);
  after.setStart(range.endContainer, range.endOffset);
  after.setEnd(root, root.childNodes.length);
  return {
    prefix: norm(before.toString()).slice(-80),
    suffix: norm(after.toString()).slice(0, 80),
  };
}
/** Pointer moves are read once per frame; selection and clicks after the press settles. */
function pointerTracking(
  body: HTMLElement,
  handlers: {
    move(event: PointerEvent): void;
    up(event: PointerEvent, moved: boolean): void;
    down?(event: PointerEvent): void;
  },
) {
  let frame = 0,
    last: PointerEvent | null = null,
    down: { x: number; y: number } | null = null;
  const move = (event: PointerEvent) => {
    last = event;
    if (!frame)
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (last) handlers.move(last);
      });
  };
  const press = (event: PointerEvent) => {
    down = { x: event.clientX, y: event.clientY };
    handlers.down?.(event);
  };
  const release = (event: PointerEvent) => {
    const moved =
      !!down && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4;
    down = null;
    setTimeout(() => handlers.up(event, moved), 0);
  };
  body.addEventListener("pointermove", move, { passive: true });
  body.addEventListener("pointerdown", press);
  body.addEventListener("pointerup", release);
  return () => {
    cancelAnimationFrame(frame);
    body.removeEventListener("pointermove", move);
    body.removeEventListener("pointerdown", press);
    body.removeEventListener("pointerup", release);
  };
}

export function createPdfMarkSurface(
  body: HTMLElement,
  sha256: string,
  events: MarkSurfaceEvents,
): MarkSurface {
  let peekTimer: ReturnType<typeof setTimeout> | undefined,
    peekShown = false,
    peekShownAt = -Infinity;
  let marks: readonly ReadingMark[] = [],
    hot: string | null = null,
    tool: MarkTool = "select",
    draft: SelectionDraft | null = null,
    pendingFlash: string | null = null;
  const pages = new Map<number, PdfPageView>();
  const tried = new Set<string>();
  /**
   * Where each mark is on this PDF (user organization 9.4): its own anchor;
   * else the place recorded for this file; else where this session found
   * it. Marks of another file found nowhere here are not drawn.
   */
  const found = new Map<
    string,
    { page: number; rects: MarkRect[]; sim: number }
  >();
  const anchorOf = (m: ReadingMark) => {
    if (m.pdf?.sha256 === sha256)
      return { page: m.pdf.page, rects: m.pdf.rects, sim: 1 };
    const recorded = recordedPlace(m, { kind: "pdf", sha256 });
    if (recorded && "pdf" in recorded.target)
      return {
        page: recorded.target.pdf.page,
        rects: recorded.target.pdf.rects,
        sim: recorded.similarity,
      };
    return found.get(m.mark_id) ?? null;
  };
  const pdfOf = (m: ReadingMark) => anchorOf(m)!;
  const onPage = (m: ReadingMark) => !!anchorOf(m);
  const layers = (view: PdfPageView) => {
    let under = view.element.querySelector<HTMLElement>(":scope > .mark-under"),
      over = view.element.querySelector<HTMLElement>(":scope > .mark-over");
    if (!under) {
      under = document.createElement("div");
      under.className = "mark-under";
      view.element.append(under);
    }
    if (!over) {
      over = document.createElement("div");
      over.className = "mark-over";
      view.element.append(over);
    }
    return { under, over };
  };
  const box = (view: PdfPageView, [x, y, w, h]: MarkRect) => ({
    left: `${(x / view.width) * 100}%`,
    top: `${(y / view.height) * 100}%`,
    width: `${(w / view.width) * 100}%`,
    height: `${(h / view.height) * 100}%`,
  });
  const scaleOf = (view: PdfPageView) =>
    view.element.clientWidth / view.width || 1;
  const draw = (n: number, sweep?: string) => {
    const view = pages.get(n);
    if (!view || !view.element.isConnected) return;
    const { under, over } = layers(view);
    under.replaceChildren();
    over.replaceChildren();
    let note = 0;
    for (const m of marks) {
      if (!onPage(m) || pdfOf(m).page !== n) continue;
      const first = pdfOf(m).rects[0]!;
      if (m.kind === "region") {
        const region = document.createElement("div");
        region.className = "mark-region";
        region.dataset.color = m.color;
        region.dataset.id = m.mark_id;
        if (m.mark_id === hot) region.dataset.hot = "";
        Object.assign(region.style, box(view, first));
        over.append(region);
      } else
        pdfOf(m).rects.forEach((rect, i) => {
          const hl = document.createElement("div");
          hl.className = "mark-highlight";
          // Found on this file only approximately (9.4, 5.3): a dashed line.
          if (pdfOf(m).sim < PLACE) hl.dataset.near = "";
          hl.dataset.color = m.color;
          hl.dataset.id = m.mark_id;
          if (m.mark_id === hot) hl.dataset.hot = "";
          if (m.mark_id === sweep && !reduced()) {
            hl.dataset.sweep = "";
            hl.style.animationDelay = `${i * 45}ms`;
          }
          Object.assign(hl.style, box(view, rect));
          under.append(hl);
        });
      if (m.note.trim()) {
        const marker = document.createElement("button");
        marker.type = "button";
        marker.className = "mark-note";
        marker.dataset.color = m.color;
        marker.dataset.id = m.mark_id;
        marker.dataset.side =
          first[0] + first[2] / 2 < view.width / 2 ? "left" : "right";
        marker.textContent = String(++note);
        marker.setAttribute("aria-label", `打开笔记 ${note}`);
        if (m.mark_id === hot) marker.dataset.hot = "";
        marker.style.top = `${(first[1] / view.height) * 100}%`;
        // Spec 3.5: resting on the dot shows the note too, with the hint's
        // timing (design core): 500 ms, at once right after another.
        marker.onpointerenter = () => {
          clearTimeout(peekTimer);
          const show = () => {
            peekShown = true;
            events.peek?.(m.mark_id, marker.getBoundingClientRect());
          };
          if (performance.now() - peekShownAt < 1000) show();
          else peekTimer = setTimeout(show, 500);
        };
        marker.onpointerleave = () => {
          clearTimeout(peekTimer);
          if (peekShown) peekShownAt = performance.now();
          peekShown = false;
          events.peek?.(null, null);
        };
        over.append(marker);
      }
    }
    if (
      pendingFlash &&
      marks.some(
        (m) => m.mark_id === pendingFlash && onPage(m) && pdfOf(m).page === n,
      )
    ) {
      const id = pendingFlash;
      pendingFlash = null;
      flash(id);
    }
  };
  /** Marks made on the full text try to find their words on each drawn page. */
  const placeMissing = (view: PdfPageView) => {
    const key = (m: ReadingMark) => `${m.mark_id}:${view.page}`;
    // Marks made on the full text, and (9.4) highlights of another PDF of
    // this part not yet found here: looked for on each drawn page, once a
    // session, never on opening the whole file.
    const missing = marks.filter(
      (m) =>
        !tried.has(key(m)) &&
        !found.has(m.mark_id) &&
        // A full-text mark of a part that cannot be told is not looked for.
        ((!m.pdf && m.kind === "highlight" && (events.samePart?.(m) ?? true)) ||
          (!!m.pdf &&
            wantsSearch(
              m,
              { kind: "pdf", sha256 },
              events.samePart?.(m) ?? true,
            ))),
    );
    if (!missing.length) return;
    const index = indexText(view.text);
    let drew = false;
    for (const m of missing) {
      tried.add(key(m));
      if (!m.pdf) {
        const hit = locate(canon(m.quote), index.text, {
          prefix: m.quote_prefix,
          suffix: m.quote_suffix,
        });
        if (!hit || hit.sim < PLACE) continue;
        const range = rangeOf(index, hit.start, hit.end);
        if (!range) continue;
        const rects = lineRects(range, view.element, scaleOf(view));
        if (rects.length)
          events.place(m.mark_id, { pdf: { sha256, page: view.page, rects } });
        continue;
      }
      const hit = relocate(m, index.text);
      if (!hit) continue;
      const range = rangeOf(index, hit.start, hit.end);
      if (!range) continue;
      const rects = lineRects(range, view.element, scaleOf(view));
      if (!rects.length) continue;
      found.set(m.mark_id, { page: view.page, rects, sim: hit.similarity });
      drew = true;
      // Recorded once (9.4): the next opening reads it, not looking again.
      events.record?.(
        m.mark_id,
        { pdf: { sha256, page: view.page, rects } },
        hit.similarity,
      );
    }
    if (drew) {
      draw(view.page);
      report();
    }
  };
  const report = () =>
    events.placed?.(
      new Set(marks.filter(onPage).map((m) => m.mark_id)),
      new Set(
        marks
          .filter((m) => onPage(m) && anchorOf(m)!.sim < PLACE)
          .map((m) => m.mark_id),
      ),
    );
  const hitTest = (event: PointerEvent | MouseEvent): string | null => {
    const target = event.target as Element | null;
    const marker = target?.closest<HTMLElement>(".mark-note");
    if (marker) return marker.dataset.id ?? null;
    const page = target?.closest<HTMLElement>(".reading-pdf-page");
    if (!page) return null;
    const n = Number(page.dataset.pdfPage),
      view = pages.get(n);
    if (!view) return null;
    const r = page.getBoundingClientRect(),
      s = scaleOf(view),
      x = (event.clientX - r.left) / s,
      y = (event.clientY - r.top) / s;
    let found: string | null = null;
    for (const m of marks) {
      if (!onPage(m) || pdfOf(m).page !== n) continue;
      if (
        pdfOf(m).rects.some(
          ([rx, ry, rw, rh]) =>
            x >= rx - 1 && x <= rx + rw + 1 && y >= ry - 1 && y <= ry + rh + 1,
        )
      ) {
        found = m.mark_id;
        if (m.kind === "highlight") break;
      }
    }
    return found;
  };
  const setHot = (id: string | null) => {
    if (id === hot) return;
    for (const el of body.querySelectorAll<HTMLElement>("[data-hot]"))
      delete el.dataset.hot;
    hot = id;
    if (id)
      for (const el of body.querySelectorAll<HTMLElement>(
        `[data-id="${CSS.escape(id)}"]`,
      ))
        el.dataset.hot = "";
  };
  const readSelection = (): SelectionDraft | null => {
    const selection = getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount)
      return null;
    const range = selection.getRangeAt(0),
      start = (
        range.startContainer.nodeType === 1
          ? range.startContainer
          : range.startContainer.parentElement
      ) as Element | null;
    const layer = start?.closest<HTMLElement>(".textLayer"),
      page = layer?.closest<HTMLElement>(".reading-pdf-page");
    if (!layer || !page || !body.contains(page)) return null;
    const n = Number(page.dataset.pdfPage),
      view = pages.get(n);
    const quote = norm(selection.toString()).slice(0, 4000);
    if (!view || !quote) return null;
    const rects = lineRects(range, page, scaleOf(view));
    const first = range.getClientRects()[0];
    if (!rects.length || !first) return null;
    return {
      quote,
      ...context(range, layer),
      pdf: { sha256, page: n, rects },
      document: null,
      anchor: first,
    };
  };
  let marquee: {
    page: HTMLElement;
    view: PdfPageView;
    x: number;
    y: number;
    el: HTMLElement;
    pointer: number;
  } | null = null;
  const stopTracking = pointerTracking(body, {
    down(event) {
      if (event.button !== 0) return;
      const page = (event.target as Element).closest<HTMLElement>(
        ".reading-pdf-page",
      );
      if (!page || (event.target as Element).closest(".mark-note")) return;
      if (!(tool === "region" || event.altKey)) return;
      const view = pages.get(Number(page.dataset.pdfPage));
      if (!view) return;
      event.preventDefault();
      getSelection()?.removeAllRanges();
      const r = page.getBoundingClientRect(),
        el = document.createElement("div");
      el.className = "mark-marquee";
      el.innerHTML = "<b></b>";
      layers(view).over.append(el);
      marquee = {
        page,
        view,
        x: event.clientX - r.left,
        y: event.clientY - r.top,
        el,
        pointer: event.pointerId,
      };
      page.setPointerCapture?.(event.pointerId);
    },
    move(event) {
      if (marquee) {
        const r = marquee.page.getBoundingClientRect(),
          x = Math.max(0, Math.min(r.width, event.clientX - r.left)),
          y = Math.max(0, Math.min(r.height, event.clientY - r.top));
        const left = Math.min(x, marquee.x),
          top = Math.min(y, marquee.y),
          w = Math.abs(x - marquee.x),
          h = Math.abs(y - marquee.y),
          s = scaleOf(marquee.view);
        Object.assign(marquee.el.style, {
          left: `${left}px`,
          top: `${top}px`,
          width: `${w}px`,
          height: `${h}px`,
        });
        marquee.el.firstElementChild!.textContent = `第 ${marquee.view.page} 页 · ${Math.round(w / s)} × ${Math.round(h / s)} pt`;
        return;
      }
      if (event.buttons) return;
      const id = hitTest(event);
      if (id !== hot) {
        setHot(id);
        events.hot(id);
      }
    },
    up(event, moved) {
      if (marquee) {
        const m = marquee;
        marquee = null;
        m.page.releasePointerCapture?.(m.pointer);
        const el = m.el.getBoundingClientRect(),
          r = m.page.getBoundingClientRect(),
          s = scaleOf(m.view);
        m.el.remove();
        if (el.width < 10 || el.height < 10) return;
        events.region({
          pdf: {
            sha256,
            page: m.view.page,
            rects: [
              [
                (el.left - r.left) / s,
                (el.top - r.top) / s,
                el.width / s,
                el.height / s,
              ],
            ],
          },
          anchor: el,
        });
        return;
      }
      draft = readSelection();
      if (draft) {
        events.selection(draft);
        return;
      }
      events.selection(null);
      if (moved) return;
      const id = hitTest(event);
      if (id) {
        const viaMarker = !!(event.target as Element).closest(".mark-note");
        events.activate(
          id,
          anchorRect(id) ?? new DOMRect(event.clientX, event.clientY, 0, 0),
          viaMarker,
        );
      }
    },
  });
  const keyup = (event: KeyboardEvent) => {
    if (event.shiftKey && event.key.startsWith("Arrow")) {
      draft = readSelection();
      events.selection(draft);
    }
  };
  body.addEventListener("keyup", keyup);
  const anchorRect = (id: string): DOMRect | null => {
    const m = marks.find((x) => x.mark_id === id);
    if (!m || !onPage(m)) return null;
    const page = body.querySelector<HTMLElement>(
        `.reading-pdf-page[data-pdf-page="${pdfOf(m).page}"]`,
      ),
      view = pages.get(pdfOf(m).page);
    if (!page || !view) return null;
    const r = page.getBoundingClientRect(),
      s = scaleOf(view),
      [x, y, w, h] = pdfOf(m).rects[0]!;
    return new DOMRect(r.left + x * s, r.top + y * s, w * s, h * s);
  };
  const flash = (id: string) => {
    const m = marks.find((x) => x.mark_id === id);
    const view = m && onPage(m) ? pages.get(pdfOf(m).page) : undefined;
    if (!m || !view) return;
    const { over } = layers(view);
    for (const rect of pdfOf(m).rects) {
      const f = document.createElement("div");
      f.className = "mark-flash";
      f.dataset.color = m.color;
      Object.assign(f.style, box(view, rect));
      over.append(f);
      setTimeout(() => f.remove(), 1000);
    }
  };
  let previewing: HTMLElement[] = [];
  return {
    setMarks(next) {
      marks = next;
      for (const n of pages.keys()) draw(n);
      for (const view of pages.values()) placeMissing(view);
      report();
    },
    setHot,
    setTool(next) {
      tool = next;
      body.dataset.markTool = next;
    },
    preview(color) {
      for (const el of previewing) el.remove();
      previewing = [];
      body.classList.toggle("marks-previewing", !!color);
      if (!color || !draft?.pdf) return;
      const view = pages.get(draft.pdf.page);
      if (!view) return;
      const { under } = layers(view);
      previewing = draft.pdf.rects.map((rect) => {
        const el = document.createElement("div");
        el.className = "mark-highlight";
        el.dataset.color = color;
        el.dataset.preview = "";
        Object.assign(el.style, box(view, rect));
        under.append(el);
        return el;
      });
    },
    markAt: (event) => hitTest(event),
    reveal(id) {
      const m = marks.find((x) => x.mark_id === id);
      if (!m || !onPage(m)) return false;
      const page = body.querySelector<HTMLElement>(
        `.reading-pdf-page[data-pdf-page="${pdfOf(m).page}"]`,
      );
      if (!page) return false;
      const s =
        page.clientWidth /
        (pages.get(pdfOf(m).page)?.width ?? page.clientWidth);
      const target =
        page.offsetTop + pdfOf(m).rects[0]![1] * s - body.clientHeight * 0.3;
      const distance = Math.abs(body.scrollTop - target);
      body.scrollTo({
        top: target,
        behavior: reduced() || distance > 6000 ? "auto" : "smooth",
      });
      if (pages.has(pdfOf(m).page))
        setTimeout(
          () => flash(id),
          reduced() ? 0 : Math.min(450, 120 + distance / 6),
        );
      else pendingFlash = id;
      return true;
    },
    anchorRect,
    clearSelection() {
      draft = null;
      getSelection()?.removeAllRanges();
    },
    positions() {
      const total = Math.max(1, body.scrollHeight);
      return marks.filter(onPage).flatMap((m) => {
        const page = body.querySelector<HTMLElement>(
          `.reading-pdf-page[data-pdf-page="${pdfOf(m).page}"]`,
        );
        if (!page) return [];
        const width = pages.get(pdfOf(m).page)?.width;
        const s = width ? page.clientWidth / width : 1;
        return [
          {
            id: m.mark_id,
            color: m.color,
            at: (page.offsetTop + pdfOf(m).rects[0]![1] * s) / total,
          },
        ];
      });
    },
    drawThumbnail(id, target) {
      const m = marks.find((x) => x.mark_id === id);
      const view = m && onPage(m) ? pages.get(pdfOf(m).page) : undefined;
      const canvas = view?.element.querySelector("canvas");
      if (!m || !view || !canvas?.width) return false;
      const [x, y, w, h] = pdfOf(m).rects[0]!,
        k = canvas.width / view.width,
        fit = Math.min(1, 640 / (w * k));
      target.width = Math.max(1, Math.round(w * k * fit));
      target.height = Math.max(1, Math.round(h * k * fit));
      target
        .getContext("2d")
        ?.drawImage(
          canvas,
          x * k,
          y * k,
          w * k,
          h * k,
          0,
          0,
          target.width,
          target.height,
        );
      return true;
    },
    pdfPage(view) {
      pages.set(view.page, view);
      draw(view.page);
      placeMissing(view);
    },
    documentPainted() {},
    destroy() {
      stopTracking();
      body.removeEventListener("keyup", keyup);
      body.classList.remove("marks-previewing");
      delete body.dataset.markTool;
      for (const el of body.querySelectorAll(".mark-under, .mark-over"))
        el.remove();
    },
  };
}

const COLORS: readonly MarkColor[] = [
  "yellow",
  "blue",
  "green",
  "red",
  "purple",
];
export function createDocumentMarkSurface(
  body: HTMLElement,
  documentVersionId: string,
  events: MarkSurfaceEvents,
): MarkSurface {
  let marks: readonly ReadingMark[] = [],
    hot: string | null = null,
    draft: SelectionDraft | null = null;
  const ranges = new Map<string, Range>(),
    approximate = new Set<string>(),
    persisted = new Set<string>();
  // Searches that found nothing in the text loaded so far (9.4, once a session).
  const missed = new Set<string>();
  const registry =
    typeof CSS !== "undefined" && "highlights" in CSS ? CSS.highlights : null;
  const sections = () => [
    ...body.querySelectorAll<HTMLElement>("section[data-byte-start]"),
  ];
  const indexed = new WeakMap<
    HTMLElement,
    { content: string; index: ReturnType<typeof indexText> }
  >();
  const skip = (node: Text) =>
    !!node.parentElement?.closest(
      ".reading-block-source, .reading-margin-note",
    );
  /**
   * The highlights this surface painted. The registry is the document's, so a
   * surface going away removes only its own: a newer surface's marks stay.
   */
  const painted = new Map<string, Highlight>();
  const paintHighlights = () => {
    if (!registry) return;
    for (const c of COLORS) {
      registry.delete(`mark-${c}`);
      registry.delete(`mark-near-${c}`);
    }
    registry.delete("mark-hot");
    const groups = new Map<string, Range[]>();
    for (const m of marks) {
      const range = ranges.get(m.mark_id);
      if (!range) continue;
      const name = `${approximate.has(m.mark_id) ? "mark-near" : "mark"}-${m.color}`;
      groups.set(name, [...(groups.get(name) ?? []), range]);
    }
    for (const [name, list] of groups) {
      const highlight = new Highlight(...list);
      registry.set(name, highlight);
      painted.set(name, highlight);
    }
    const h = hot && ranges.get(hot);
    if (h) {
      const highlight = new Highlight(h);
      highlight.priority = 1;
      registry.set("mark-hot", highlight);
      painted.set("mark-hot", highlight);
    }
  };
  /** Find every mark in the loaded text; marks from the PDF save their place once found. */
  const place = () => {
    ranges.clear();
    approximate.clear();
    const all = sections();
    if (!all.length) {
      paintHighlights();
      return;
    }
    const spans = all.map((el) => {
      // Index a section again only when its text changed (an image replacing
      // its placeholder); painted sections otherwise keep their text nodes.
      const content = el.textContent ?? "",
        cached = indexed.get(el);
      if (cached?.content === content) return { el, index: cached.index };
      const index = indexText(el, skip);
      indexed.set(el, { content, index });
      return { el, index };
    });
    const searchIn = (list: typeof spans) => {
      let text = "";
      const at: { span: (typeof spans)[number]; offset: number }[] = [];
      for (const span of list) {
        at.push({ span, offset: text.length });
        text += span.index.text;
      }
      return { text, at };
    };
    const here = { kind: "document" as const, version: documentVersionId };
    for (const m of marks) {
      if (m.kind !== "highlight") continue;
      let candidates = spans;
      // User organization 9.4: on another text version, the place recorded
      // for this one first; else a search (in this part only), once for the
      // text loaded so far, recorded when found.
      const recorded =
        m.document && m.document.document_version_id !== documentVersionId
          ? recordedPlace(m, here)
          : null;
      const searching =
        !!m.document &&
        !recorded &&
        m.document.document_version_id !== documentVersionId;
      if (searching) {
        if (!wantsSearch(m, here, events.samePart?.(m) ?? true)) continue;
        const attempt = `${m.mark_id}:${spans.length}`;
        if (missed.has(attempt)) continue;
        missed.add(attempt);
      }
      const span =
        recorded && "document" in recorded.target
          ? recorded.target.document
          : m.document?.document_version_id === documentVersionId
            ? m.document
            : null;
      if (span) {
        const a = span.start_utf8,
          b = span.end_utf8;
        candidates = spans.filter(
          (s) =>
            Number(s.el.dataset.byteEnd) > a &&
            Number(s.el.dataset.byteStart) < b,
        );
      } else if (m.pdf) {
        const near = spans.filter(
          (s) => Math.abs(Number(s.el.dataset.page ?? NaN) - m.pdf!.page) <= 1,
        );
        if (near.length) candidates = near;
      }
      const tryIn = (list: typeof spans) => {
        if (!list.length) return null;
        const joined = searchIn(list);
        const hit = locate(canon(m.quote), joined.text, {
          prefix: m.quote_prefix,
          suffix: m.quote_suffix,
        });
        return hit ? { hit, joined } : null;
      };
      let found = tryIn(candidates);
      if ((!found || found.hit.sim < APPROXIMATE) && candidates !== spans)
        found = tryIn(spans);
      if (!found || found.hit.sim < APPROXIMATE) continue;
      const { hit, joined } = found;
      const locateIn = (pos: number) => {
        let k = joined.at.length - 1;
        while (k > 0 && joined.at[k]!.offset > pos) k--;
        return { span: joined.at[k]!.span, local: pos - joined.at[k]!.offset };
      };
      const a = locateIn(hit.start),
        b = locateIn(hit.end - 1);
      const sa = a.span.index,
        sb = b.span.index;
      const range = document.createRange();
      range.setStart(sa.nodes[a.local]!, sa.offsets[a.local]!);
      range.setEnd(sb.nodes[b.local]!, sb.offsets[b.local]! + 1);
      ranges.set(m.mark_id, range);
      if (searching) {
        missed.delete(`${m.mark_id}:${spans.length}`);
        if (!persisted.has(m.mark_id)) {
          persisted.add(m.mark_id);
          events.record?.(
            m.mark_id,
            {
              document: {
                document_version_id: documentVersionId,
                start_utf8: Number(a.span.el.dataset.byteStart),
                end_utf8: Number(b.span.el.dataset.byteEnd),
              },
            },
            Math.round(hit.sim * 1000) / 1000,
          );
        }
      }
      if (hit.sim < PLACE) approximate.add(m.mark_id);
      else if (!m.document && !persisted.has(m.mark_id)) {
        persisted.add(m.mark_id);
        events.place(m.mark_id, {
          document: {
            document_version_id: documentVersionId,
            start_utf8: Number(a.span.el.dataset.byteStart),
            end_utf8: Number(b.span.el.dataset.byteEnd),
          },
        });
      }
    }
    paintHighlights();
    events.placed?.(new Set(ranges.keys()), new Set(approximate));
  };
  /** The pointer is over a mark when it is inside one of the mark's line boxes. */
  const hitTest = (event: PointerEvent | MouseEvent): string | null => {
    for (const [id, range] of ranges)
      for (const r of range.getClientRects())
        if (
          event.clientX >= r.left &&
          event.clientX <= r.right &&
          event.clientY >= r.top &&
          event.clientY <= r.bottom
        )
          return id;
    return null;
  };
  const readSelection = (): SelectionDraft | null => {
    const selection = getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount)
      return null;
    const range = selection.getRangeAt(0);
    const el = (n: Node) =>
      n.nodeType === 1 ? (n as Element) : n.parentElement;
    const first = el(range.startContainer)?.closest<HTMLElement>(
        "section[data-byte-start]",
      ),
      last = el(range.endContainer)?.closest<HTMLElement>(
        "section[data-byte-start]",
      );
    const quote = norm(selection.toString()).slice(0, 4000);
    const anchor = range.getClientRects()[0];
    if (!first || !last || !body.contains(first) || !quote || !anchor)
      return null;
    const article = first.closest("article") ?? body;
    return {
      quote,
      ...context(range, article),
      pdf: null,
      document: {
        document_version_id: documentVersionId,
        start_utf8: Number(first.dataset.byteStart),
        end_utf8: Math.max(
          Number(last.dataset.byteEnd),
          Number(first.dataset.byteStart) + 1,
        ),
      },
      anchor,
    };
  };
  const setHot = (id: string | null) => {
    if (id === hot) return;
    hot = id;
    paintHighlights();
  };
  const stopTracking = pointerTracking(body, {
    move(event) {
      if (event.buttons) return;
      const id = hitTest(event);
      if (id !== hot) {
        setHot(id);
        events.hot(id);
      }
    },
    up(event, moved) {
      draft = readSelection();
      if (draft) {
        events.selection(draft);
        return;
      }
      events.selection(null);
      if (moved) return;
      const id = hitTest(event);
      if (id)
        events.activate(
          id,
          ranges.get(id)!.getClientRects()[0] ??
            new DOMRect(event.clientX, event.clientY, 0, 0),
          false,
        );
    },
  });
  const keyup = (event: KeyboardEvent) => {
    if (event.shiftKey && event.key.startsWith("Arrow")) {
      draft = readSelection();
      events.selection(draft);
    }
  };
  body.addEventListener("keyup", keyup);
  return {
    setMarks(next) {
      marks = next;
      place();
    },
    setHot,
    setTool() {},
    preview(color) {
      if (!registry) return;
      registry.delete("mark-preview");
      for (const c of COLORS) registry.delete(`mark-preview-${c}`);
      body.classList.toggle("marks-previewing", !!color);
      const selection = getSelection();
      if (!color || !selection?.rangeCount) return;
      const highlight = new Highlight(selection.getRangeAt(0).cloneRange());
      highlight.priority = 2;
      registry.set(`mark-preview-${color}`, highlight);
      painted.set(`mark-preview-${color}`, highlight);
    },
    blockOf: (id) => {
      const node = ranges.get(id)?.startContainer;
      const el = node instanceof Element ? node : node?.parentElement;
      return el?.closest<HTMLElement>("section[data-byte-start]") ?? null;
    },
    markAt: (event) => hitTest(event),
    reveal(id) {
      const range = ranges.get(id);
      if (!range) return false;
      const r = range.getBoundingClientRect(),
        top = body.getBoundingClientRect().top;
      body.scrollBy({
        top: r.top - top - body.clientHeight * 0.3,
        behavior: reduced() ? "auto" : "smooth",
      });
      if (registry) {
        const flash = new Highlight(range);
        flash.priority = 3;
        registry.set("mark-flash", flash);
        painted.set("mark-flash", flash);
        setTimeout(() => {
          if (registry.get("mark-flash") === flash)
            registry.delete("mark-flash");
        }, 900);
      }
      return true;
    },
    anchorRect(id) {
      return ranges.get(id)?.getClientRects()[0] ?? null;
    },
    clearSelection() {
      draft = null;
      getSelection()?.removeAllRanges();
    },
    positions() {
      return [];
    },
    drawThumbnail() {
      return false;
    },
    pdfPage() {},
    documentPainted() {
      place();
    },
    destroy() {
      stopTracking();
      body.removeEventListener("keyup", keyup);
      body.classList.remove("marks-previewing");
      if (registry)
        for (const [name, highlight] of painted)
          if (registry.get(name) === highlight) registry.delete(name);
      painted.clear();
    },
  };
}
