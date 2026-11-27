import type { DocumentTextMode } from "../contract.js";
import { changeLayer, type LayerChange } from "./change.js";
import { outlineLeaf, overviewLeaf, relationsHTML, rulesHTML } from "./leaf.js";
import { createMap, type LayersMap } from "./map.js";
import {
  READING_LAYERS,
  escape,
  layersModel,
  type LayersModel,
  type LayersPort,
  type ReadingLayer,
} from "./model.js";
import {
  clearNotes,
  markSentence,
  notesSide,
  wrapNotes,
  type MarkedSentence,
  type PlacedEvidence,
} from "./notes.js";
import type { ReadLayers, ReadLayersPoint } from "./read.js";
import { canon } from "../mark-locate.js";

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
  /** Closes what clicks opened in 概览 or 脉络; false when nothing was open. */
  fold(): boolean;
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

  // ── 概览 and 脉络: a click opens more in place (reading-experience 3.2,
  //    3.3). A sentence opens to its whole paragraph, a main note of 概览 to
  //    its sentences; a click on what opened closes it. The reader stays on
  //    the layer: only relations and the depth bar go elsewhere. ──
  type Opened = { p: ReadLayersPoint; i: number | string; e: MarkedSentence };
  /** The sentence a 目 line stands for: one of its note's, or a main note's ground in 概览. */
  const lineSentence = (line: Element): Opened | null => {
    const [n, which] = (line.getAttribute("data-ev") ?? "").split(":");
    const p = model.byNumber.get(Number(n));
    if (!p) return null;
    if (which === "basis") {
      const basis = model.primary.find((q) => q.number === p.number)?.basis;
      if (basis?.kind !== "sentence") return null;
      // The same sentence among the note's own carries its translation.
      const i = p.evidence.findIndex(
        (e) => e.kind === "sentence" && e.start_utf8 === basis.start_utf8,
      );
      const same = p.evidence[i];
      return same?.kind === "sentence"
        ? { p, i, e: same }
        : { p, i: "basis", e: basis };
    }
    const e = p.evidence[Number(which)];
    return e?.kind === "sentence" ? { p, i: Number(which), e } : null;
  };
  /** The author's paragraph at a place, as the reading shows it, with these sentences marked. */
  const paragraph = (
    start: number,
    marks: readonly Opened[],
  ): HTMLElement | null => {
    const block = port.blockAt(start);
    if (!block || block.closest(".rl-leaf")) return null;
    const copy = block.cloneNode(true) as HTMLElement;
    clearNotes(copy);
    for (const x of copy.querySelectorAll(
      ".reading-block-source, .reading-doubt, .reading-margin-note-below, .reading-untranslated, .reading-translation-marks",
    ))
      x.remove();
    // The paragraph is the unit that opens: every note's sentences in it are
    // marked, each with its own number, not only the one pressed.
    const from = Number(block.dataset.byteStart),
      to = Number(block.dataset.byteEnd);
    const all: Opened[] = [...marks];
    for (const p of model.points)
      p.evidence.forEach((e, i) => {
        if (
          e.kind === "sentence" &&
          e.start_utf8 < to &&
          e.end_utf8 > from &&
          !all.some((m) => m.p === p && m.i === i)
        )
          all.push({ p, i, e });
      });
    all.sort((a, b) => a.e.start_utf8 - b.e.start_utf8);
    for (const m of all) markSentence(copy, m.p, m.i, m.e, mode);
    const translation = copy.querySelector(":scope > .reading-translation");
    if (mode === "original") translation?.remove();
    else if (mode === "translation" && translation)
      for (const child of [...copy.children])
        if (child !== translation) child.remove();
    const para = el("div", "rl-para");
    para.dataset.start = block.dataset.byteStart ?? String(start);
    const number = el("span", "rl-pn");
    number.innerHTML = `<i>¶${escape(block.dataset.paragraph ?? "")}</i>`;
    const text = el("div", "rl-para-t");
    text.append(...copy.childNodes);
    para.append(number, text);
    return para;
  };
  // ── how what opens moves (reading-experience 3.3.5), after TextFold: the
  //    words already on the page stay and move. The sentence's words fly one
  //    by one from the line to their places in the paragraph; the rest of
  //    the paragraph's ink comes in around them once they are on the way;
  //    the slip it lies on grows from the line's height to its own, so what
  //    follows makes room smoothly. Closing plays it back. The place pressed
  //    stays put on every frame, and what stands in the margin follows. ──
  const DUR = 560,
    EASE = "cubic-bezier(0.2, 0, 0, 1)";
  let moving = 0,
    held: { el: Element; top: number } | null = null,
    anchoring: string | null = null;
  /** Motions waiting for the place pressed to be held (they measure where things end up). */
  let queued: (() => void)[] = [];
  /** The browser's own scroll anchoring is held off while things move: it would pick its own anchor (spec 4.2). */
  const anchorOff = () => {
    if (anchoring !== null) return;
    anchoring = port.body.style.overflowAnchor;
    port.body.style.overflowAnchor = "none";
  };
  const anchorBack = () => {
    if (anchoring === null) return;
    port.body.style.overflowAnchor = anchoring;
    anchoring = null;
  };
  const hold = () => {
    if (!held?.el.isConnected) return;
    const drift = held.el.getBoundingClientRect().top - held.top;
    if (Math.abs(drift) > 0.5) port.body.scrollTop += drift;
  };
  const follow = () => {
    if (destroyed) return;
    hold();
    place();
    if (moving > 0) requestAnimationFrame(follow);
    else {
      held = null;
      anchorBack();
    }
  };
  const begin = () => {
    anchorOff();
    if (moving++ === 0) requestAnimationFrame(follow);
  };
  const end = () => {
    moving = Math.max(0, moving - 1);
  };

  /** A word, a CJK character or a whole formula, where it stands on the screen. */
  type Token = {
    key: string;
    r: DOMRect;
    text: string | null;
    from: Element;
  };
  const WORD =
    /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}|[^\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
  /** The words under `root` (those `keep` accepts), in reading order. */
  const tokensOf = (
    root: Element,
    keep: (el: Element) => boolean = () => true,
  ): Token[] => {
    const out: Token[] = [];
    const formulas = new Set<Element>();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (
      let n = walker.nextNode() as Text | null;
      n;
      n = walker.nextNode() as Text | null
    ) {
      const parent = n.parentElement;
      if (!parent || !keep(parent) || parent.closest(".rl-pn")) continue;
      const formula = parent.closest(".katex");
      if (formula) {
        if (formulas.has(formula)) continue;
        formulas.add(formula);
        const tex =
          formula.querySelector('annotation[encoding="application/x-tex"]')
            ?.textContent ?? formula.textContent;
        out.push({
          key: `$${canon(tex ?? "")}`,
          r: formula.getBoundingClientRect(),
          text: null,
          from: formula,
        });
        continue;
      }
      for (const m of n.data.matchAll(WORD)) {
        const key = canon(m[0]);
        if (!key) continue;
        const range = document.createRange();
        range.setStart(n, m.index);
        range.setEnd(n, m.index + m[0].length);
        const r = range.getClientRects()[0] ?? range.getBoundingClientRect();
        if (!r.width && !r.height) continue;
        out.push({ key, r, text: m[0], from: parent });
      }
    }
    return out;
  };
  /** The same words in two readings of a sentence, paired in order (the longest common run). */
  const pair = (a: Token[], b: Token[]): [Token, Token][] => {
    const n = a.length,
      m = b.length;
    if (!n || !m || n * m > 600_000) return [];
    const w = m + 1,
      dp = new Uint16Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[i * w + j] =
          a[i]!.key === b[j]!.key
            ? dp[(i + 1) * w + j + 1]! + 1
            : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!);
    const out: [Token, Token][] = [];
    for (let i = 0, j = 0; i < n && j < m; )
      if (a[i]!.key === b[j]!.key) out.push([a[i++]!, b[j++]!]);
      else if (dp[(i + 1) * w + j]! >= dp[i * w + j + 1]!) i++;
      else j++;
    return out;
  };
  /** A copy of a word drawn over the page where it stood, to move or fade. */
  const ghostOf = (t: Token): HTMLElement => {
    const style = getComputedStyle(
      t.text === null ? t.from.parentElement! : t.from,
    );
    let g: HTMLElement;
    if (t.text === null) g = t.from.cloneNode(true) as HTMLElement;
    else {
      g = document.createElement("span");
      g.textContent = t.text;
    }
    g.classList.add("rl-ghost");
    Object.assign(g.style, {
      position: "absolute",
      left: `${t.r.left}px`,
      top: `${t.r.top}px`,
      margin: "0",
      whiteSpace: "pre",
      lineHeight: "normal",
      font: style.font,
      letterSpacing: style.letterSpacing,
      color: style.color,
    });
    stage.append(g);
    return g;
  };
  /**
   * The words of `from` fly to their places in `to`; those without a place
   * fade where they were. Resolves when they have arrived.
   */
  const fly = (from: Token[], to: Token[]): Promise<void> => {
    const pairs = pair(from, to);
    const moved = new Set(pairs.map(([a]) => a));
    const runs: Animation[] = [];
    for (const [a, b] of pairs) {
      const g = ghostOf(a);
      runs.push(
        g.animate(
          [
            { transform: "none" },
            {
              transform: `translate(${b.r.left - a.r.left}px, ${b.r.top - a.r.top}px)`,
            },
          ],
          { duration: DUR, easing: EASE, fill: "forwards" },
        ),
      );
    }
    for (const a of from)
      if (!moved.has(a))
        runs.push(
          ghostOf(a).animate([{ opacity: 1 }, { opacity: 0 }], {
            duration: DUR * 0.45,
            easing: "ease-in",
            fill: "forwards",
          }),
        );
    return Promise.all(runs.map((r) => r.finished))
      .catch(() => undefined)
      .then(() => {
        for (const r of runs) (r.effect as KeyframeEffect).target?.remove();
      });
  };
  /** The words of an opened paragraph that belong to the lines it stands for. */
  const markedTokens = (para: HTMLElement) => {
    const keys = new Set((para.dataset.lines ?? "").split(" ").filter(Boolean));
    return tokensOf(para, (el) => {
      const ev = el.closest<HTMLElement>(".rl-ev");
      return !!ev?.dataset.ev && keys.has(ev.dataset.ev);
    });
  };
  /** While its sentences' words fly, the paragraph's own copies of them are hidden; they show when the words arrive. */
  const flying = (para: HTMLElement, on: boolean) => {
    const keys = new Set((para.dataset.lines ?? "").split(" ").filter(Boolean));
    for (const ev of para.querySelectorAll<HTMLElement>(".rl-ev"))
      if (ev.dataset.ev && keys.has(ev.dataset.ev))
        ev.classList.toggle("rl-flying", on);
  };
  /** The words of a 目 line as they show (its paragraph number aside). */
  const lineTokens = (lines: readonly Element[]) =>
    lines.flatMap((l) => tokensOf(l));

  /**
   * A paragraph opening on its slip: grows from `line` px high, the line's
   * words flying in, the rest of the ink coming in once they are on the way.
   */
  const grow = (para: HTMLElement, line: number, from: Token[]) => {
    if (port.reducedMotion() || !para.isConnected) return;
    const whole = para.getBoundingClientRect().height;
    const to = markedTokens(para);
    const text = para.querySelector<HTMLElement>(":scope > .rl-para-t");
    const slip = getComputedStyle(para);
    flying(para, true);
    para.style.overflow = "hidden";
    begin();
    const runs = [
      para.animate(
        [
          {
            height: `${line}px`,
            backgroundColor: "transparent",
            borderColor: "transparent",
          },
          {
            height: `${whole}px`,
            backgroundColor: slip.backgroundColor,
            borderColor: slip.borderTopColor,
          },
        ],
        { duration: DUR, easing: EASE },
      ),
    ];
    if (text)
      runs.push(
        text.animate(
          [{ color: "transparent" }, { color: getComputedStyle(text).color }],
          {
            duration: DUR * 0.55,
            delay: DUR * 0.4,
            easing: "ease-out",
            fill: "backwards",
          },
        ),
      );
    void Promise.all([
      fly(from, to),
      ...runs.map((r) => r.finished.catch(() => undefined)),
    ]).then(() => {
      flying(para, false);
      para.style.overflow = "";
      end();
    });
  };
  /**
   * A paragraph closing: its marked words fly back to the line, the rest of
   * its ink goes, the slip shrinks to the line's height; then the line is
   * there again.
   */
  const shrink = (para: HTMLElement, done: () => void) => {
    if (port.reducedMotion() || !para.isConnected) return done();
    const box = para.parentElement;
    const lines = linesOf(para);
    const own = lines.filter((l) => l.parentElement === box),
      others = lines.filter((l) => l.parentElement !== box);
    const from = markedTokens(para);
    // Where the lines' words will stand once they are back: measured as
    // they will be, then put away again before anything is painted.
    para.style.display = "none";
    for (const l of lines) l.classList.remove("rl-open");
    const to = lineTokens(lines);
    const line = own[0]?.getBoundingClientRect().height ?? 0;
    const heights = others.map((l) => l.getBoundingClientRect().height);
    for (const l of own) l.classList.add("rl-open");
    para.style.display = "";
    // Another note's lines grow back where they were while their words fly home.
    others.forEach((l, i) => land(l, heights[i]!, false));
    const whole = para.getBoundingClientRect().height;
    const text = para.querySelector<HTMLElement>(":scope > .rl-para-t");
    const slip = getComputedStyle(para);
    flying(para, true);
    para.style.overflow = "hidden";
    begin();
    const runs = [
      para.animate(
        [
          {
            height: `${whole}px`,
            backgroundColor: slip.backgroundColor,
            borderColor: slip.borderTopColor,
          },
          {
            height: `${line}px`,
            backgroundColor: "transparent",
            borderColor: "transparent",
          },
        ],
        { duration: DUR, easing: EASE, fill: "forwards" },
      ),
    ];
    if (text)
      runs.push(
        text.animate(
          [{ color: getComputedStyle(text).color }, { color: "transparent" }],
          { duration: DUR * 0.45, easing: "ease-in", fill: "forwards" },
        ),
      );
    void Promise.all([
      fly(from, to),
      ...runs.map((r) => r.finished.catch(() => undefined)),
    ]).then(() => {
      for (const l of others) l.classList.remove("rl-landing");
      done();
      end();
    });
  };
  /**
   * Another note's line in the paragraph that opened: its words fly into
   * the paragraph while its place closes up (or, closing, opens again).
   */
  const land = (line: HTMLElement, height: number, leaving: boolean) => {
    line.classList.add("rl-landing");
    line.style.overflow = "hidden";
    const frames = [
      { height: `${height}px`, marginTop: getComputedStyle(line).marginTop },
      { height: "0px", marginTop: "0px" },
    ];
    begin();
    void line
      .animate(leaving ? frames : frames.reverse(), {
        duration: DUR,
        easing: EASE,
      })
      .finished.catch(() => undefined)
      .then(() => {
        line.style.overflow = "";
        if (leaving) line.classList.add("rl-open");
        else line.classList.remove("rl-landing");
        end();
      });
  };
  /** The 目 lines an opened paragraph stands for, wherever they are on the leaf. */
  const linesOf = (para: HTMLElement): HTMLElement[] =>
    (para.dataset.from ?? "")
      .split(" ")
      .filter(Boolean)
      .map((key) =>
        column.querySelector<HTMLElement>(
          `.rl-mu-s[data-ev="${CSS.escape(key)}"]`,
        ),
      )
      .filter((l): l is HTMLElement => !!l);
  /** Something without a line under it (a ¶n's paragraph) opens or closes on its slip, by its ink alone. */
  const fade = (para: HTMLElement, closing: boolean, done?: () => void) => {
    if (port.reducedMotion() || !para.isConnected) return done?.();
    const whole = para.getBoundingClientRect().height;
    para.style.overflow = "hidden";
    begin();
    const frames = [
      { height: "0px", opacity: 0 },
      { height: `${whole}px`, opacity: 1 },
    ];
    void para
      .animate(closing ? frames.reverse() : frames, {
        duration: closing ? DUR * 0.7 : DUR,
        easing: EASE,
        fill: closing ? "forwards" : "none",
      })
      .finished.catch(() => undefined)
      .then(() => {
        if (!closing) para.style.overflow = "";
        done?.();
        end();
      });
  };

  /** Opens a 目 line to its paragraph; the note's other lines in that paragraph open with it. */
  const openLine = (line: HTMLElement): HTMLElement | null => {
    const s = lineSentence(line);
    const block = s ? port.blockAt(s.e.start_utf8) : undefined;
    const box = line.parentElement;
    if (!s || !block || !box) return null;
    const from = Number(block.dataset.byteStart),
      to = Number(block.dataset.byteEnd);
    // Every 目 line on the leaf whose sentence lies in this paragraph goes
    // into it, whichever note it is under: the paragraph shows each once.
    const lines = [
      ...column.querySelectorAll<HTMLElement>(
        ".rl-mu-s[data-ev]:not(.rl-open, .rl-landing)",
      ),
    ].filter((l) => {
      const x = lineSentence(l);
      return !!x && x.e.start_utf8 >= from && x.e.start_utf8 < to;
    });
    if (!lines.includes(line)) lines.unshift(line);
    const own = lines.filter((l) => l.parentElement === box),
      others = lines.filter((l) => l.parentElement !== box);
    const para = paragraph(
      s.e.start_utf8,
      lines.map(lineSentence).filter((x): x is Opened => !!x),
    );
    if (!para) return null;
    const words = lineTokens(lines);
    const height = own[0]!.getBoundingClientRect().height;
    const heights = others.map((l) => l.getBoundingClientRect().height);
    para.dataset.lines = lines
      .map((l) => {
        const x = lineSentence(l)!;
        return `${x.p.number}:${x.i}`;
      })
      .join(" ");
    para.dataset.from = lines.map((l) => l.dataset.ev).join(" ");
    own[0]!.before(para);
    for (const l of own) l.classList.add("rl-open");
    fillImages(para);
    queued.push(() => {
      grow(para, height, words);
      others.forEach((l, i) =>
        port.reducedMotion()
          ? l.classList.add("rl-open")
          : land(l, heights[i]!, true),
      );
    });
    return para;
  };
  /** Takes an opened paragraph away at once; gives back the first line it stood for, if any. */
  const removePara = (para: HTMLElement): Element | null => {
    const box = para.parentElement;
    let first: Element | null = null;
    for (const line of linesOf(para)) {
      line.classList.remove("rl-open", "rl-landing");
      if (line.parentElement === box) first ??= line;
    }
    const row = para.closest(".rl-para-row");
    const host = row?.previousElementSibling ?? null;
    (row ?? para).remove();
    return first ?? host;
  };
  /** Closes an opened paragraph back into its lines; gives back what stands there meanwhile. */
  const closePara = (para: HTMLElement): Element | null => {
    if (para.dataset.closing) return para;
    if (port.reducedMotion()) return removePara(para);
    para.dataset.closing = "true";
    const lined = !!para.dataset.from;
    queued.push(() =>
      lined
        ? shrink(para, () => removePara(para))
        : fade(para, true, () => removePara(para)),
    );
    return para;
  };
  /** 概览: a ¶n after a datum or a limit opens that paragraph under it. */
  const toggleSource = (a: HTMLElement): Element | null => {
    const start = Number(a.dataset.start);
    const row = a.closest("tr"),
      item = row ?? a.closest("li, p");
    if (!item || !Number.isFinite(start)) return null;
    const open = row
      ? row.nextElementSibling?.matches(`.rl-para-row[data-at="${start}"]`)
        ? row.nextElementSibling.querySelector<HTMLElement>(".rl-para")
        : null
      : item.querySelector<HTMLElement>(
          `:scope > .rl-para[data-at="${start}"]`,
        );
    if (open) {
      closePara(open);
      return item;
    }
    const para = paragraph(start, []);
    if (!para) return null;
    if (row) {
      const tr = el("tr", "rl-para-row");
      tr.dataset.at = String(start);
      const td = el("td", "") as HTMLTableCellElement;
      td.colSpan = row.children.length;
      td.append(para);
      tr.append(td);
      row.after(tr);
    } else item.append(para);
    para.dataset.at = String(start);
    fillImages(para);
    queued.push(() => fade(para, false));
    return item;
  };
  /**
   * A note pressed: in 脉络 all its sentences open (or close) to their
   * paragraphs; in 概览 a main note opens to the paragraph it stands on.
   */
  const toggleNote = (gang: HTMLElement): void => {
    const box = gang.querySelector<HTMLElement>(":scope > .rl-mu");
    if (!box) return;
    const open = [
      ...box.querySelectorAll<HTMLElement>(
        ":scope > .rl-para:not([data-closing])",
      ),
    ];
    const shut = [
      ...box.querySelectorAll<HTMLElement>(
        ":scope > .rl-mu-s[data-ev]:not(.rl-open)",
      ),
    ];
    if (layer === "overview" ? open.length > 0 : !shut.length) {
      for (const para of open) closePara(para);
      return;
    }
    for (const line of layer === "overview" ? shut.slice(0, 1) : shut)
      if (line.isConnected && !line.classList.contains("rl-open"))
        openLine(line);
  };
  /** Changes what is open while the place pressed stays where it was on the screen, on every frame. */
  const keepPlace = (at: Element, change: () => Element | null | void) => {
    const before = at.getBoundingClientRect().top;
    anchorOff();
    const after = change() || at;
    held = { el: after.isConnected ? after : at, top: before };
    hold();
    place();
    const motions = queued;
    queued = [];
    for (const m of motions) m();
    if (moving === 0) {
      held = null;
      anchorBack();
    }
  };
  /** The opened paragraph nearest the reading line: where 全文 opens from here. */
  const openedStart = (): number | null => {
    const y = third();
    let best: number | null = null,
      distance = Infinity;
    for (const para of column.querySelectorAll<HTMLElement>(
      ".rl-para:not([data-closing])",
    )) {
      const r = para.getBoundingClientRect();
      const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
      if (d < distance && Number.isFinite(Number(para.dataset.start))) {
        distance = d;
        best = Number(para.dataset.start);
      }
    }
    return best;
  };
  const fold = (): boolean => {
    if (layer !== "overview" && layer !== "outline") return false;
    const opened = [
      ...column.querySelectorAll<HTMLElement>(".rl-para:not([data-closing])"),
    ];
    if (!opened.length) return false;
    const point = reading();
    const at =
      (point != null &&
        column.querySelector(`.rl-gang[data-point="${point}"]`)) ||
      opened[0]!.closest(".rl-gang") ||
      column;
    keepPlace(at, () => {
      for (const para of opened) closePara(para);
    });
    return true;
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
    // From 概览 or 脉络 with a paragraph open, 全文 opens at that paragraph.
    const start =
      target?.start ??
      (!target && next === "full" && layer !== "full" && layer !== "map"
        ? openedStart()
        : null);
    const goal = { point, start };
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
    const selecting = !!getSelection()?.toString();
    // What a click opened: a click on it closes it (a link inside still works).
    const para = t.closest<HTMLElement>(".rl-leaf .rl-para");
    if (para && !t.closest("a")) {
      if (!selecting) keepPlace(para, () => closePara(para));
      return;
    }
    // 精读建议: a figure enlarges; a section is where to begin reading, in 全文.
    const where = t.closest<HTMLElement>("[data-place]");
    if (where) {
      const [, id] = where.dataset.place!.split(/:(.*)/su) as [string, string];
      if (port.figure(id)) return enlarge(id);
      return setLayer("full", { point: null, start: options.offsetOf(id) });
    }
    // 概览: a datum's or a limit's ¶n opens its paragraph under it.
    const source = t.closest<HTMLElement>("a[data-start]");
    if (source) {
      const start = Number(source.dataset.start);
      if (!source.dataset.start || !Number.isFinite(start)) return;
      options.onPick?.(start);
      if (layer === "full") return;
      return keepPlace(source, () => toggleSource(source));
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
    if (layer === "full" || selecting) return;
    // 概览, 脉络: a sentence opens to its paragraph; a note to its sentences.
    // Beside a PDF, the PDF shows the place as well.
    const sentence = t.closest<HTMLElement>(".rl-mu-s[data-start]");
    if (sentence) {
      options.onPick?.(Number(sentence.dataset.start));
      return keepPlace(sentence, () => openLine(sentence));
    }
    const pressed = t.closest<HTMLElement>(".rl-gang, .rl-pi[data-point]");
    if (!pressed) return;
    const number = Number(pressed.dataset.point);
    const start = firstStart(number);
    if (start !== null) options.onPick?.(start);
    const gang = column.querySelector<HTMLElement>(
      `.rl-gang[data-point="${number}"]`,
    );
    if (gang) {
      keepPlace(gang, () => toggleNote(gang));
      light(String(number));
    }
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
    fold,
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
