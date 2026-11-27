import type {
  FullTextBlock,
  FullTextPage,
  ReadingMark,
} from "@sciretriever/contracts";
import type { PdfPageView } from "../../../../reading/contract.js";
import { markdown } from "../../../../reading/markdown.js";

export type FullTextMode = "off" | "pair" | "only";
/** Translation type in page points: it scales with the page like the print does. */
const START_PT = 10,
  TITLE_PT = 14,
  MIN_PT = 6;
/** Gap between a page and its twin, the same as fit zoom leaves for it. */
const GAP = 24;

const words = (s: string) =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\$[^$]*\$/gu, " ")
    .replace(/[^\p{L}\p{N}]+/gu, "");
/**
 * Where the text layer prints a block: the longest run of consecutive spans
 * whose letters all lie in the block's text, as 0–1000 page coordinates.
 * Null when that run covers less than 40 % of the block.
 */
function locate(
  block: FullTextBlock,
  view: PdfPageView,
): readonly [number, number, number, number] | null {
  const target = words(block.source);
  if (target.length < 8) return null;
  const spans = [...view.text.querySelectorAll<HTMLElement>("span")].filter(
    (s) => !s.querySelector("span"),
  );
  let best: HTMLElement[] = [],
    run: HTMLElement[] = [],
    covered = 0,
    bestCovered = 0;
  for (const span of spans) {
    const w = words(span.textContent ?? "");
    if (w.length >= 3 && target.includes(w)) {
      run.push(span);
      covered += w.length;
      if (covered > bestCovered) {
        best = [...run];
        bestCovered = covered;
      }
    } else if (w.length >= 3) {
      run = [];
      covered = 0;
    }
  }
  if (bestCovered < target.length * 0.4) return null;
  const page = view.element.getBoundingClientRect();
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const span of best) {
    const r = span.getBoundingClientRect();
    x0 = Math.min(x0, r.left);
    y0 = Math.min(y0, r.top);
    x1 = Math.max(x1, r.right);
    y1 = Math.max(y1, r.bottom);
  }
  const to = (v: number, from: number, size: number) =>
    Math.round(((v - from) / size) * 1000);
  return [
    to(x0, page.left, page.width),
    to(y0, page.top, page.height),
    to(x1, page.left, page.width),
    to(y1, page.top, page.height),
  ];
}
/** A mark sits in a block when one of its line boxes ([x, y, w, h] in page points) centres inside it. */
function marksIn(
  region: readonly [number, number, number, number],
  marks: readonly ReadingMark[],
  view: PdfPageView,
) {
  const [x0, y0, x1, y1] = region;
  return marks.filter((m) =>
    m.pdf?.rects.some(([rx, ry, rw, rh]) => {
      const cx = ((rx + rw / 2) * 1000) / view.width,
        cy = ((ry + rh / 2) * 1000) / view.height;
      return cx >= x0 - 4 && cx <= x1 + 4 && cy >= y0 - 4 && cy <= y1 + 4;
    }),
  );
}
/**
 * The largest type, in page points, at which the translation fits its block,
 * between `min` and `start`. The size is written in page points times the
 * page's scale (`--ft-scale` on the twin), so a page drawn wider or narrower
 * later keeps the same lines instead of spilling out of its box. A halving
 * search: a handful of layouts per block, not one per step.
 */
function fit(el: HTMLElement, start: number, min: number) {
  const set = (pt: number) => {
    el.style.fontSize = `calc(${pt.toFixed(2)}px * var(--ft-scale, 1))`;
  };
  const fits = () =>
    el.scrollHeight <= el.clientHeight + 1 &&
    el.scrollWidth <= el.clientWidth + 1;
  set(start);
  if (fits()) return;
  let low = min,
    high = start;
  for (let i = 0; i < 7 && high - low > 0.15; i++) {
    const mid = (low + high) / 2;
    set(mid);
    if (fits()) low = mid;
    else high = mid;
  }
  set(low);
  if (!fits()) el.dataset.overflow = "true";
}

/**
 * The translated page beside each PDF page (ADR 0051): a copy of the page
 * drawing with every translated block covered and written over in place.
 * It lives as long as one PDF mount; Reader feeds it pages, data and marks.
 */
export function createFullTextLayer(
  container: () => HTMLElement | null,
  onMark: (markId: string) => void,
) {
  const views = new Map<number, PdfPageView>(),
    data = new Map<number, FullTextPage>(),
    /** The page data each twin was last laid out from. */
    drawn = new Map<number, FullTextPage | undefined>();
  let marks: readonly ReadingMark[] = [],
    mode: FullTextMode = "off";
  const clear = (view: PdfPageView) => {
    view.element.querySelector(":scope > .ft-twin")?.remove();
    drawn.delete(view.page);
  };
  const draw = (n: number) => {
    const view = views.get(n);
    if (!view || !view.element.isConnected) return;
    if (mode === "off") return clear(view);
    let twin = view.element.querySelector<HTMLElement>(":scope > .ft-twin");
    if (!twin) {
      twin = document.createElement("div");
      twin.className = "ft-twin";
      twin.setAttribute("aria-label", `第 ${n} 页译文`);
      view.element.append(twin);
    }
    container()?.style.setProperty(
      "--ft-page-width",
      `${view.element.clientWidth + GAP}px`,
    );
    // The page drawing underneath: figures, formulas and kept text stay visible.
    const source =
      view.element.querySelector<HTMLCanvasElement>(":scope > canvas");
    let canvas = twin.querySelector("canvas");
    if (source && source.width) {
      if (!canvas) {
        canvas = document.createElement("canvas");
        twin.prepend(canvas);
      }
      canvas.width = source.width;
      canvas.height = source.height;
      canvas.getContext("2d")?.drawImage(source, 0, 0);
    }
    for (const el of twin.querySelectorAll(".ft-block, .ft-unplaced"))
      el.remove();
    const page = data.get(n);
    twin.dataset.state = page ? "ready" : "pending";
    drawn.set(n, page);
    if (!page) return;
    const scale = view.element.clientWidth / view.width,
      unplaced: FullTextBlock[] = [];
    twin.style.setProperty("--ft-scale", String(scale));
    const pageMarks = marks.filter((m) => m.pdf?.page === n);
    // Every place is read before anything is written, so the text layer is
    // measured once rather than after each block.
    const placed: {
      block: FullTextBlock;
      translation: string;
      region: readonly [number, number, number, number];
    }[] = [];
    for (const block of page.blocks) {
      const translation = block.translation;
      if (!translation) continue;
      const region =
        block.placement === "region" ? block.region : locate(block, view);
      if (region) placed.push({ block, translation, region });
      else unplaced.push(block);
    }
    const fitting: { el: HTMLElement; start: number }[] = [];
    for (const { block, translation, region } of placed) {
      const [x0, y0, x1, y1] = region,
        el = document.createElement("div");
      el.className = "ft-block";
      el.dataset.type = block.type;
      el.dataset.role = block.role;
      Object.assign(el.style, {
        left: `${x0 / 10}%`,
        top: `${y0 / 10}%`,
        width: `${(x1 - x0) / 10}%`,
        height: `${(y1 - y0) / 10}%`,
      });
      el.innerHTML = markdown.parseInline(translation, {
        async: false,
      }) as string;
      el.title = translation;
      const inside = marksIn(region, pageMarks, view);
      if (inside.length) {
        const latest = inside.reduce((a, b) =>
          a.updated_at > b.updated_at ? a : b,
        );
        el.dataset.color = latest.color;
        el.dataset.marks = String(inside.length);
        el.tabIndex = 0;
        el.setAttribute("role", "button");
        el.setAttribute(
          "aria-label",
          `这段有 ${inside.length} 条批注，点按在原文中查看`,
        );
        el.onclick = () => onMark(latest.mark_id);
        el.onkeydown = (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onMark(latest.mark_id);
          }
        };
      }
      twin.append(el);
      fitting.push({ el, start: block.type === "title" ? TITLE_PT : START_PT });
    }
    for (const { el, start } of fitting) fit(el, start, MIN_PT);
    // A face still on its way measures with the fallback's widths: fit again
    // once the page's fonts are in.
    if (document.fonts && document.fonts.status !== "loaded")
      void document.fonts.ready.then(() => {
        if (twin?.isConnected && drawn.get(n) === page)
          for (const { el, start } of fitting)
            if (el.isConnected) {
              delete el.dataset.overflow;
              fit(el, start, MIN_PT);
            }
      });
    // Region marks keep their box on the translated page.
    for (const m of pageMarks)
      if (m.kind === "region" && m.pdf)
        for (const [rx, ry, rw, rh] of m.pdf.rects) {
          const box = document.createElement("div");
          box.className = "ft-block ft-region-mark";
          box.dataset.color = m.color;
          Object.assign(box.style, {
            left: `${(rx / view.width) * 100}%`,
            top: `${(ry / view.height) * 100}%`,
            width: `${(rw / view.width) * 100}%`,
            height: `${(rh / view.height) * 100}%`,
          });
          twin.append(box);
        }
    if (unplaced.length) {
      const badge = document.createElement("div");
      badge.className = "ft-unplaced";
      badge.textContent = `${unplaced.length} 段未放置`;
      badge.title = unplaced.map((b) => b.translation).join("\n\n");
      twin.append(badge);
    }
  };
  return {
    /** A PDF page was drawn (again): copy it and lay its translation over it. */
    page(view: PdfPageView) {
      views.set(view.page, view);
      // Only drawn pages keep a copy; pages scrolled away let theirs go.
      for (const [n, v] of views)
        if (n !== view.page && !v.element.dataset.rendered) {
          v.element.querySelector(":scope > .ft-twin canvas")?.remove();
          views.delete(n);
        }
      draw(view.page);
    },
    setPages(pages: ReadonlyMap<number, FullTextPage>) {
      data.clear();
      for (const [index, page] of pages) data.set(index + 1, page);
      // Pages come back one by one: only a page whose translation changed is
      // laid out again, not every page drawn so far.
      for (const n of views.keys())
        if (drawn.get(n) !== data.get(n) || !drawn.has(n)) draw(n);
    },
    setMarks(next: readonly ReadingMark[]) {
      marks = next;
      if (mode !== "off") for (const n of views.keys()) draw(n);
    },
    setMode(next: FullTextMode) {
      if (next === mode) return;
      mode = next;
      const root = container();
      if (root) {
        if (next === "off") delete root.dataset.fulltext;
        else root.dataset.fulltext = next;
      }
      for (const n of views.keys()) draw(n);
    },
    destroy() {
      for (const view of views.values()) clear(view);
      views.clear();
      data.clear();
      drawn.clear();
      const root = container();
      if (root) delete root.dataset.fulltext;
    },
  };
}
export type FullTextLayer = ReturnType<typeof createFullTextLayer>;
