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
/** Shrink the type until the translation fits its block, down to `min`. */
function fit(el: HTMLElement, start: number, min: number) {
  let size = start;
  const step = Math.max(0.25, start / 40);
  el.style.fontSize = `${size}px`;
  while (
    size > min &&
    (el.scrollHeight > el.clientHeight + 1 ||
      el.scrollWidth > el.clientWidth + 1)
  ) {
    size = Math.max(min, size - step);
    el.style.fontSize = `${size}px`;
  }
  if (el.scrollHeight > el.clientHeight + 1) el.dataset.overflow = "true";
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
    data = new Map<number, FullTextPage>();
  let marks: readonly ReadingMark[] = [],
    mode: FullTextMode = "off";
  const clear = (view: PdfPageView) =>
    view.element.querySelector(":scope > .ft-twin")?.remove();
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
    if (!page) return;
    const scale = view.element.clientWidth / view.width,
      min = Math.max(3, MIN_PT * scale),
      unplaced: FullTextBlock[] = [];
    const pageMarks = marks.filter((m) => m.pdf?.page === n);
    for (const block of page.blocks) {
      if (!block.translation) continue;
      const region =
        block.placement === "region" ? block.region : locate(block, view);
      if (!region) {
        unplaced.push(block);
        continue;
      }
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
      el.innerHTML = markdown.parseInline(block.translation, {
        async: false,
      }) as string;
      el.title = block.translation;
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
      fit(el, (block.type === "title" ? TITLE_PT : START_PT) * scale, min);
    }
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
      for (const n of views.keys()) draw(n);
    },
    setMarks(next: readonly ReadingMark[]) {
      marks = next;
      if (mode !== "off") for (const n of views.keys()) draw(n);
    },
    setMode(next: FullTextMode) {
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
      const root = container();
      if (root) delete root.dataset.fulltext;
    },
  };
}
export type FullTextLayer = ReturnType<typeof createFullTextLayer>;
