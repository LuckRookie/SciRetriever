import type { DocumentTextMode } from "../contract.js";
import { changeLayer, type LayerChange } from "./change.js";
import { outlineLeaf, overviewLeaf, relationsHTML, rulesHTML } from "./leaf.js";
import { createMap, type LayersMap } from "./map.js";
import {
  READING_LAYERS,
  layersModel,
  type LayersModel,
  type LayersPort,
  type ReadingLayer,
} from "./model.js";
import {
  clearNotes,
  notesSide,
  wrapNotes,
  type PlacedEvidence,
} from "./notes.js";
import type { ReadLayers } from "./read.js";

/**
 * The reading layers on the sheet (reading-experience 3, ADR 0070): 全文 is
 * the full-text engine's article with the notes beside it; 概览 and 脉络 are
 * leaves of their own in the same sheet; 导图 is a fold-out leaf. One of
 * them shows at a time (`data-layer` on the sheet). The view owns what the
 * layers add; the article's blocks stay the engine's.
 */
export interface LayersView {
  layer(): ReadingLayer;
  /** Shows a layer; `point` is the note to arrive at, `start` a place of the full text. */
  setLayer(
    layer: ReadingLayer,
    target?: {
      point?: number | null;
      start?: number | null;
      instant?: boolean;
    },
  ): void;
  /** The full text was painted again (more text, another reading). */
  painted(): void;
  setText(mode: DocumentTextMode): void;
  /** Alt and the wheel: `delta` pixels toward 全文 (negative) or 概览 (positive). */
  wheel(deltaY: number): boolean;
  /** Whether stressed words are marked (排版 → 标出重点词). */
  setKeyTerms(on: boolean): void;
  /** While 概览 or 脉络 shows: the first evidence of the note being read; else null. */
  readingStart(): number | null;
  destroy(): void;
}
export interface LayersViewOptions {
  layer: ReadingLayer;
  text: DocumentTextMode;
  keyTerms: boolean;
  /** The layer shown changed, by the view itself or as asked. */
  onLayer(layer: ReadingLayer): void;
  /** Maps a segment id to its UTF-8 start. */
  offsetOf(segmentId: string): number | null;
  /**
   * A note or a sentence was pressed while a PDF stands beside the reading
   * copy (ADR 0071): true when the PDF showed the place, and the reading
   * copy then stays where it is.
   */
  onPick?(start: number): boolean;
}

const GAP = 18;
const el = (tag: string, cls: string) => {
  const node = document.createElement(tag);
  node.className = cls;
  return node;
};

export function attachLayers(
  port: LayersPort,
  data: ReadLayers,
  options: LayersViewOptions,
): LayersView {
  const model: LayersModel = layersModel(data);
  const sheet = port.sheet;
  let layer: ReadingLayer = "full",
    mode = options.text,
    placed: PlacedEvidence[] = [],
    change: LayerChange | null = null,
    destroyed = false;
  const rule = el("div", "rl-rule"),
    strokes = el("div", "rl-strokes"),
    leaf = el("div", "rl-leaf"),
    column = el("article", "rl-col library-reading-text"),
    side = el("div", "rl-side"),
    mapHost = el("div", "rl-map"),
    stage = el("div", "rl-stage library-reading-text");
  leaf.append(column);
  leaf.hidden = true;
  mapHost.hidden = true;
  sheet.append(rule, strokes, leaf, side, mapHost);
  document.body.append(stage);
  sheet.dataset.annotated = "true";
  sheet.dataset.keyTerms = String(options.keyTerms);

  /** Whether the sheet has a margin for notes (a wide desk). */
  const margin = () =>
    (parseFloat(
      getComputedStyle(sheet).getPropertyValue("--sheet-note-width"),
    ) || 0) > 0;
  const top = () => sheet.getBoundingClientRect().top;
  /** The line a place is put on: a third of the way down the desk. */
  const third = () => {
    const area = port.body.getBoundingClientRect();
    return area.top + area.height / 3;
  };
  const scrollBy = (delta: number, smooth = false) => {
    if (smooth && !port.reducedMotion())
      port.body.scrollTo({
        top: port.body.scrollTop + delta,
        behavior: "smooth",
      });
    else port.body.scrollTop += delta;
  };
  const reveal = (target: Element | null | undefined, smooth = false) => {
    if (target) scrollBy(target.getBoundingClientRect().top - third(), smooth);
  };

  // ── pictures: the engine reads them; the leaves ask for them once shown ──
  const fillImages = (root: ParentNode) => {
    for (const img of root.querySelectorAll<HTMLImageElement>(
      "img[data-image]:not([src])",
    )) {
      const figure = port.figure(img.dataset.image!);
      // A picture not kept leaves its figure's other pictures; a figure
      // with none left is taken away.
      const drop = () => {
        const plate = img.closest(".rl-plate, .rl-oplate, .rl-mplate");
        img.remove();
        if (plate && !plate.querySelector("img")) plate.remove();
        place();
      };
      if (!figure) {
        drop();
        continue;
      }
      void figure.image().then(
        (url) => {
          if (destroyed || !img.isConnected) return;
          if (!url) return drop();
          img.onload = () => place();
          img.src = url;
        },
        () => !destroyed && drop(),
      );
    }
  };

  // ── 全文: the sentences, the strokes on the rule, the notes in the margin ──
  const relations = (number: number) => {
    const p = model.byNumber.get(number);
    return p ? relationsHTML(p, port, mode) : "";
  };
  const renderFull = (notify = true) => {
    placed = wrapNotes(model, port, mode);
    if (margin())
      side.innerHTML =
        rulesHTML() + notesSide(model, port, mode, (p) => relations(p.number));
    else {
      // A narrow sheet: each note under the paragraph of its first sentence.
      side.innerHTML = "";
      const box = el("div", "rl-side-tmp");
      box.innerHTML = notesSide(model, port, mode, (p) => relations(p.number));
      for (const note of [...box.children] as HTMLElement[]) {
        const first = placed.find(
          (e) => String(e.point) === note.dataset.point && e.block,
        );
        if (!first?.block) continue;
        note.classList.add("rl-below");
        let after: Element = first.block;
        while (after.nextElementSibling?.classList.contains("rl-below"))
          after = after.nextElementSibling;
        after.after(note);
      }
    }
    if (notify) port.repainted();
  };
  const renderLeaf = () => {
    const made =
      layer === "outline"
        ? outlineLeaf(model, port, mode, margin())
        : overviewLeaf(model, port, mode, options.offsetOf);
    column.innerHTML = made.column;
    side.innerHTML = margin() ? made.side : "";
    fillImages(leaf);
    fillImages(side);
  };
  let map: LayersMap | null = null;
  const render = () => {
    sheet.dataset.layer = layer;
    leaf.hidden = layer === "full" || layer === "map";
    mapHost.hidden = layer !== "map";
    port.away(layer !== "full");
    if (layer === "map") {
      clearNotes(port.article);
      side.innerHTML = "";
      strokes.innerHTML = "";
      port.body.scrollTop = 0;
      // A fold-out leaf: as tall as the desk shows.
      const area = port.body.getBoundingClientRect();
      const head = port.header?.getBoundingClientRect().height ?? 0;
      mapHost.style.height = `${Math.max(320, Math.round(area.height - head - 44))}px`;
      map ??= createMap(mapHost, model, port, {
        mode: () => mode,
        open: (target, number) => setLayer(target, { point: number }),
        enlarge,
      });
      map.show(mode);
      return;
    }
    if (layer === "full") renderFull();
    else {
      clearNotes(port.article);
      renderLeaf();
    }
    place();
  };

  /** Where things go that depend on the lines: the strokes, and what stands in the margin. */
  function place(): void {
    if (destroyed || layer === "map") return;
    const top0 = top();
    const first = new Map<string, number>();
    let st = "";
    if (layer === "full")
      for (const e of placed) {
        let a: number, b: number;
        if (e.spans.length) {
          const head = e.spans[0]!.getClientRects()[0],
            tail = [...e.spans.at(-1)!.getClientRects()].at(-1);
          if (!head || !tail) continue;
          a = head.top - top0;
          b = tail.bottom - top0;
        } else if (e.block) {
          const box = e.block.getBoundingClientRect();
          if (!box.height) continue;
          a = box.top - top0;
          b = box.bottom - top0;
        } else continue;
        st += `<i class="rl-stroke" data-point="${e.point}" style="top:${Math.round(a + 6)}px;height:${Math.max(6, Math.round(b - a - 12))}px"></i>`;
        const key = String(e.point);
        if (!first.has(key) || a < first.get(key)!) first.set(key, a);
      }
    strokes.innerHTML = margin() ? st : "";
    const shown = layer === "full" ? port.article : column;
    const columnBox = shown.getBoundingClientRect();
    rule.style.top = `${Math.round(columnBox.top - top0)}px`;
    rule.style.height = `${Math.round(columnBox.height)}px`;
    const rules = side.querySelector<HTMLElement>(".rl-rules");
    if (rules) rules.style.top = `${Math.round(columnBox.top - top0 + 4)}px`;
    const notes = [...side.querySelectorAll<HTMLElement>(".rl-pi, .rl-oplate")]
      .map((n) => {
        const key = n.dataset.point ?? "";
        let y = 0;
        if (layer === "full") y = first.get(key) ?? 0;
        else {
          const gang = column.querySelector(`.rl-gang[data-point="${key}"]`);
          y = gang
            ? gang.getBoundingClientRect().top -
              top0 +
              (n.matches(".rl-oplate") ? 6 : 8)
            : 0;
        }
        return { n, y: y + 2 };
      })
      .sort((a, b) => a.y - b.y);
    let floor = rules
      ? rules.getBoundingClientRect().bottom - top0 + 28
      : -Infinity;
    for (const o of notes) {
      const y = Math.max(o.y, floor);
      o.n.style.top = `${Math.round(y)}px`;
      floor = y + o.n.offsetHeight + GAP;
    }
    // The margin may run below the text: the sheet is as long as both.
    side.style.minHeight = "";
    const need = Math.round(floor - GAP);
    sheet.style.setProperty("--rl-side-end", `${Math.max(0, need)}px`);
  }

  /** A note, its sentences, its strokes and its numbers answer the pointer together. */
  const light = (number: string | null) => {
    for (const node of sheet.querySelectorAll<HTMLElement>(
      ".rl-ev, .rl-pi, .rl-stroke, .rl-gang, .rl-oplate",
    ))
      node.classList.toggle(
        "rl-lit",
        !!number && node.dataset.point === number,
      );
  };
  /** Where a note stands in the text: its first evidence. */
  const firstStart = (number: number): number | null => {
    const p = model.byNumber.get(number);
    const e = p?.evidence[0];
    if (!e) return null;
    return e.kind === "sentence"
      ? e.start_utf8
      : (port.figure(e.segment_id)?.start ?? options.offsetOf(e.segment_id));
  };
  /** The note being read: the one nearest a third of the way down the desk. */
  const reading = (): number | null => {
    if (layer === "map") return map?.selected() ?? null;
    if (port.body.scrollTop < 80) return null;
    const y = third();
    let best: string | null = null,
      distance = Infinity;
    const root = layer === "full" ? port.article : column;
    for (const node of root.querySelectorAll<HTMLElement>("[data-point]")) {
      const r = node.getBoundingClientRect();
      if (!r.height) continue;
      const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
      if (d < distance) {
        distance = d;
        best = node.dataset.point ?? null;
      }
    }
    return best === null ? null : Number(best);
  };
  const targetOf = (
    target: { point?: number | null; start?: number | null } | undefined,
  ): Element | null => {
    if (!target) return null;
    if (layer === "full") {
      if (target.start != null) {
        const at = sheet.querySelector(
          `.rl-ev[data-start-utf8="${target.start}"]`,
        );
        return at ?? port.blockAt(target.start) ?? null;
      }
      if (target.point != null)
        return (
          port.article.querySelector(`.rl-ev[data-point="${target.point}"]`) ??
          placed.find((e) => e.point === target.point)?.block ??
          null
        );
      return null;
    }
    return target.point != null
      ? column.querySelector(`.rl-gang[data-point="${target.point}"]`)
      : null;
  };
  const enlarge = (segmentId: string) => {
    const figure = port.figure(segmentId);
    if (!figure) return;
    void figure.image().then((url) => {
      if (url && !destroyed) port.enlarge(url, figure.label);
    });
  };

  function setLayer(
    next: ReadingLayer,
    target?: {
      point?: number | null;
      start?: number | null;
      instant?: boolean;
    },
  ): void {
    if (destroyed) return;
    change?.finish();
    const point = target?.point === undefined ? reading() : target.point;
    const goal = { point, start: target?.start ?? null };
    if (next === layer && !target) return;
    const from = layer;
    const animated =
      from !== next &&
      from !== "map" &&
      next !== "map" &&
      !target?.instant &&
      !port.reducedMotion();
    if (animated) {
      change = changeLayer({
        sheet,
        stage,
        body: port.body,
        from,
        to: next,
        point,
        primary: model.primary.map((p) => p.number),
        third,
        show: (l) => {
          layer = l;
          render();
        },
        target: () => targetOf(goal),
        anchor: (key) =>
          sheet.querySelector<HTMLElement>(
            `:is(.rl-leaf:not([hidden]), .rl-side, .reading-article) [data-f="${key}"]`,
          ),
        done: (ended) => {
          change = null;
          if (ended && point != null) light(String(point));
          options.onLayer(layer);
        },
      });
      return;
    }
    layer = next;
    render();
    if (next === "map") {
      map?.arrive(point);
      options.onLayer(layer);
      return;
    }
    const to = targetOf(goal);
    if (to) reveal(to);
    else if (from !== next) port.body.scrollTop = 0;
    if (point != null) light(String(point));
    options.onLayer(layer);
  }

  // ── the pointer ──
  const over = (event: Event) => {
    if (layer === "map") return;
    const t = (event.target as Element).closest?.<HTMLElement>("[data-point]");
    light(t && !t.matches("a") ? (t.dataset.point ?? null) : null);
  };
  const click = (event: MouseEvent) => {
    if (layer === "map" || change) return;
    const t = event.target as Element;
    const go = t.closest<HTMLElement>("[data-layer-go]");
    if (go) return setLayer(go.dataset.layerGo as ReadingLayer);
    const zoom = t.closest<HTMLElement>("[data-zoom]");
    if (zoom) return enlarge(zoom.dataset.zoom!);
    const where = t.closest<HTMLElement>("[data-place]");
    if (where) {
      const [, id] = where.dataset.place!.split(/:(.*)/su) as [string, string];
      const start = port.figure(id)?.start ?? options.offsetOf(id);
      return setLayer("full", { point: null, start });
    }
    const source = t.closest<HTMLElement>("a[data-start]");
    if (source) {
      const start = Number(source.dataset.start);
      if (source.dataset.start && Number.isFinite(start))
        setLayer("full", { point: null, start });
      return;
    }
    const link = t.closest<HTMLElement>(".rl-pi-x a, .rl-mu-s.rl-fig a");
    if (link) {
      if (link.dataset.fig) {
        const figure = port.figure(link.dataset.fig);
        // 全文: the figure in the text; 脉络: its plate beside (or under) the
        // first note that names it; otherwise the picture enlarged.
        const block =
          layer === "full" && figure
            ? port.blockAt(figure.start)
            : (column.querySelector<HTMLElement>(
                `.rl-plate[data-fig="${CSS.escape(link.dataset.fig)}"]`,
              ) ??
              side.querySelector<HTMLElement>(
                `.rl-mplate[data-fig="${CSS.escape(link.dataset.fig)}"]`,
              ));
        if (block) reveal(block, true);
        else enlarge(link.dataset.fig);
      } else if (link.dataset.point) {
        const number = Number(link.dataset.point);
        reveal(targetOf({ point: number }), true);
        setTimeout(() => light(String(number)), 350);
      }
      return;
    }
    // 全文: a note in the margin goes to its sentence; a sentence's number to its note.
    const note = t.closest<HTMLElement>(".rl-pi[data-point]");
    if (note && layer === "full") {
      const number = Number(note.dataset.point);
      reveal(targetOf({ point: number }), true);
      // Beside a PDF, the PDF shows the note's place too.
      const start = firstStart(number);
      if (start !== null) options.onPick?.(start);
      return;
    }
    const sentence = t.closest<HTMLElement>(".rl-mu-s[data-start]");
    if (sentence && options.onPick?.(Number(sentence.dataset.start))) return;
    const pressed = t.closest<HTMLElement>(".rl-gang, .rl-pi[data-point]");
    if (pressed && !getSelection()?.toString()) {
      const start = firstStart(Number(pressed.dataset.point));
      if (start !== null && options.onPick?.(start)) {
        light(pressed.dataset.point ?? null);
        return;
      }
    }
    if (sentence) {
      const gang = sentence.closest<HTMLElement>(".rl-gang");
      return setLayer("full", {
        point: gang ? Number(gang.dataset.point) : null,
        start: Number(sentence.dataset.start),
      });
    }
    const gang = t.closest<HTMLElement>(".rl-gang");
    if (gang && !getSelection()?.toString())
      setLayer(layer === "overview" ? "outline" : "full", {
        point: Number(gang.dataset.point),
      });
  };
  sheet.addEventListener("mouseover", over);
  sheet.addEventListener("click", click);
  const resized = new ResizeObserver(() => {
    if (change) return;
    // A margin that came or went (the desk's width) sets the notes again.
    const had = !!side.firstChild || layer === "map";
    if (layer !== "map" && had !== margin()) render();
    else place();
  });
  resized.observe(sheet);
  void document.fonts?.ready.then(() => place());

  // The layer asked for at the start, without a move.
  if (options.layer !== "full") {
    layer = options.layer;
  }
  render();
  if (layer !== "full") port.body.scrollTop = 0;

  let rest = 0;
  return {
    layer: () => layer,
    setLayer,
    painted() {
      if (destroyed || layer !== "full" || change) return;
      renderFull(false);
      place();
    },
    setText(next) {
      if (next === mode) return;
      mode = next;
      // The full text's own reading is the engine's; it paints, and `painted` follows.
      if (layer !== "full") render();
    },
    wheel(deltaY) {
      if (layer === "map" || port.reducedMotion()) return false;
      const toward = deltaY < 0 ? 1 : -1;
      if (!change) {
        const at = READING_LAYERS.indexOf(layer) + toward;
        if (at < 0 || at >= READING_LAYERS.length) return true;
        const point = reading();
        change = changeLayer({
          sheet,
          stage,
          body: port.body,
          from: layer,
          to: READING_LAYERS[at]!,
          point,
          primary: model.primary.map((p) => p.number),
          third,
          manual: toward,
          show: (l) => {
            layer = l;
            render();
          },
          target: () => targetOf({ point }),
          anchor: (key) =>
            sheet.querySelector<HTMLElement>(
              `:is(.rl-leaf:not([hidden]), .rl-side, .reading-article) [data-f="${key}"]`,
            ),
          done: (ended) => {
            change = null;
            if (ended && point != null) light(String(point));
            options.onLayer(layer);
          },
        });
      }
      change.push(toward, Math.abs(deltaY));
      clearTimeout(rest);
      rest = window.setTimeout(() => change?.settle(), 170);
      return true;
    },
    setKeyTerms(on) {
      sheet.dataset.keyTerms = String(on);
    },
    readingStart() {
      if (layer === "full" || layer === "map") return null;
      const point = reading() ?? model.points[0]?.number ?? null;
      return point === null ? null : firstStart(point);
    },
    destroy() {
      destroyed = true;
      change?.finish();
      clearTimeout(rest);
      resized.disconnect();
      sheet.removeEventListener("mouseover", over);
      sheet.removeEventListener("click", click);
      map?.destroy();
      clearNotes(port.article);
      for (const node of [rule, strokes, leaf, side, mapHost, stage])
        node.remove();
      delete sheet.dataset.layer;
      delete sheet.dataset.annotated;
      delete sheet.dataset.keyTerms;
      port.away(false);
    },
  };
}
