import type { DocumentTextMode } from "../contract.js";
import { changeLayer, type LayerChange } from "./change.js";
import {
  outlineItems,
  outlineLeaf,
  overviewLeaf,
  paragraphOf,
  relationsHTML,
  rulesHTML,
} from "./leaf.js";
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
  blockCopy,
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
  /** Where a note's paragraph starts in the text. */
  const unitStart = (p: ReadLayersPoint) => options.offsetOf(p.unit_id);
  // A note is named by its paragraph's number as the full text shows it.
  const model: LayersModel = layersModel(data, (p) =>
    paragraphOf(port, unitStart(p), p.paragraph),
  );
  const sheet = port.sheet;
  let layer: ReadingLayer = "full",
    mode = options.text,
    placed: PlacedEvidence[] = [],
    noteBlocks = new Map<number, HTMLElement>(),
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
    return p ? relationsHTML(model, p, port, mode) : "";
  };
  const renderFull = (notify = true) => {
    ({ placed, blocks: noteBlocks } = wrapNotes(model, port, mode, unitStart));
    if (margin())
      side.innerHTML =
        rulesHTML() + notesSide(model, mode, (p) => relations(p.number));
    else {
      // A narrow sheet: each note under its paragraph.
      side.innerHTML = "";
      const box = el("div", "rl-side-tmp");
      box.innerHTML = notesSide(model, mode, (p) => relations(p.number));
      for (const note of [...box.children] as HTMLElement[]) {
        const block = noteBlocks.get(Number(note.dataset.point));
        if (!block) continue;
        note.classList.add("rl-below");
        let after: Element = block;
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
        ? outlineLeaf(
            model,
            port,
            mode,
            margin(),
            outlineItems(model, port, mode, unitStart),
          )
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
    if (layer === "full") {
      // A note stands beside its paragraph's first line.
      for (const [number, block] of noteBlocks) {
        const line =
          block
            .querySelector(
              ":scope > :not(.reading-block-source, .reading-doubt)",
            )
            ?.getClientRects()[0] ?? block.getBoundingClientRect();
        if (line.height) first.set(String(number), line.top - top0);
      }
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
        if (!first.has(key)) first.set(key, a);
      }
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
      ".rl-ev, .rl-pi, .rl-stroke, .rl-gang, .rl-oplate, .reading-article > section[data-point]",
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
          noteBlocks.get(target.point) ??
          port.article.querySelector(`.rl-ev[data-point="${target.point}"]`) ??
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
    // The paragraph is the unit that opens: every note's sentences in it are
    // marked, not only the one pressed.
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
    const copy = blockCopy(block, mode, (c) => {
      for (const m of all) markSentence(c, m.p, m.i, m.e, mode);
    });
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
  //    the slip it lies on opens from the line's height to its own, and what
  //    follows slides down to make room. Closing plays it back.
  //
  //    Everything is measured first, the page is laid out once, and the
  //    motion is only moves, clips and fades: nothing is laid out again
  //    while it plays. ──
  const DUR = 560,
    EASE = "cubic-bezier(0.2, 0, 0, 1)";
  /**
   * A motion waiting for the page to be laid out: `measure` only reads (all
   * of them read in one go, against one layout), `start` only writes.
   */
  type Motion = { measure(): void; start(): void };
  let queued: Motion[] = [];
  /** What a running motion draws itself: the slide leaves it alone. */
  const busy = new Set<Element>();

  /** A word, a CJK character or a whole formula, where it stands on the screen. */
  type Token = {
    key: string;
    r: DOMRect;
    text: string | null;
    from: Element;
    /** Where a word's letters are in their text node. */
    node?: Text;
    at?: number;
    end?: number;
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
        out.push({
          key,
          r,
          text: m[0],
          from: parent,
          node: n,
          at: m.index,
          end: m.index + m[0].length,
        });
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
  type Look = { font: string; spacing: string; color: string };
  /** How each word looks, read while the page is still as it was. */
  const looksOf = (tokens: readonly Token[]): Look[] => {
    const styles = new Map<Element, Look>();
    return tokens.map((t) => {
      const el = t.text === null ? t.from.parentElement! : t.from;
      let st = styles.get(el);
      if (!st) {
        const cs = getComputedStyle(el);
        st = { font: cs.font, spacing: cs.letterSpacing, color: cs.color };
        styles.set(el, st);
      }
      return st;
    });
  };
  /**
   * The words of `from` (as `looks` says they looked) fly to their places in
   * `to`; those without a place fade where they were. The copies go in at
   * once. Resolves when they have arrived.
   */
  const fly = (
    from: readonly Token[],
    looks: readonly Look[],
    to: readonly Token[],
  ): Promise<void> => {
    const target = new Map(pair([...from], [...to]));
    const vector = (a: Token) => {
      const b = target.get(a);
      return b ? [b.r.left - a.r.left, b.r.top - a.r.top] : null;
    };
    // Words of one text node, on one line, that move by the same step go
    // as one copy: a line of CJK is one copy, not one per character.
    type Run = { first: Token; last: Token; look: Look; move: number[] | null };
    const runs: Run[] = [];
    from.forEach((t, i) => {
      const move = vector(t);
      const run = runs.at(-1);
      if (
        run &&
        t.node &&
        run.last.node === t.node &&
        /^\s*$/u.test(t.node.data.slice(run.last.end, t.at)) &&
        Math.abs(run.last.r.top - t.r.top) < 1 &&
        (move === null) === (run.move === null) &&
        (!move ||
          (Math.abs(move[0]! - run.move![0]!) < 1.5 &&
            Math.abs(move[1]! - run.move![1]!) < 1))
      ) {
        run.last = t;
        return;
      }
      runs.push({ first: t, last: t, look: looks[i]!, move });
    });
    const frag = document.createDocumentFragment();
    const ghosts = runs.map(({ first, last, look }) => {
      let g: HTMLElement;
      if (first.text === null) g = first.from.cloneNode(true) as HTMLElement;
      else {
        g = document.createElement("span");
        g.textContent =
          first === last
            ? first.text
            : first.node!.data.slice(first.at, last.end);
      }
      g.className = "rl-word";
      Object.assign(g.style, {
        left: `${first.r.left}px`,
        top: `${first.r.top}px`,
        font: look.font,
        letterSpacing: look.spacing,
        color: look.color,
      });
      frag.append(g);
      return g;
    });
    stage.append(frag);
    const motion = runs.map(({ move }, i) =>
      move
        ? ghosts[i]!.animate(
            [
              { transform: "none" },
              { transform: `translate(${move[0]}px, ${move[1]}px)` },
            ],
            { duration: DUR, easing: EASE, fill: "forwards" },
          )
        : ghosts[i]!.animate([{ opacity: 1 }, { opacity: 0 }], {
            duration: DUR * 0.45,
            easing: "ease-in",
            fill: "forwards",
          }),
    );
    return Promise.all(motion.map((r) => r.finished))
      .catch(() => undefined)
      .then(() => {
        for (const g of ghosts) g.remove();
      });
  };
  /** The slip's clip at a height; wide enough sideways to keep its ¶n. */
  const clipAt = (height: number) =>
    `polygon(-400px 0px, calc(100% + 400px) 0px, calc(100% + 400px) ${height}px, -400px ${height}px)`;
  /** The keys of the sentences an opened paragraph stands for. */
  const keysOf = (para: HTMLElement) =>
    new Set((para.dataset.lines ?? "").split(" ").filter(Boolean));
  /** While its sentences' words fly, the paragraph's own copies of them are hidden; they show when the words arrive. */
  const flying = (root: HTMLElement, keys: Set<string>, on: boolean) => {
    for (const ev of root.querySelectorAll<HTMLElement>(".rl-ev"))
      if (ev.dataset.ev && keys.has(ev.dataset.ev))
        ev.classList.toggle("rl-flying", on);
  };
  /** The words of an opened paragraph that belong to the lines it stands for. */
  const markedTokens = (para: HTMLElement) => {
    const keys = keysOf(para);
    return tokensOf(para, (el) => {
      const ev = el.closest<HTMLElement>(".rl-ev");
      return !!ev?.dataset.ev && keys.has(ev.dataset.ev);
    });
  };
  /** The words of 目 lines as they show (their paragraph numbers aside). */
  const lineTokens = (lines: readonly Element[]) =>
    lines.flatMap((l) => tokensOf(l));
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

  /** The blocks of the leaf and its margin near the screen, each moved as one (none inside another). */
  const blocksNear = (): HTMLElement[] => {
    const h = window.innerHeight;
    return [
      ...column.querySelectorAll<HTMLElement>(
        ":scope > :not(.rl-gang, .rl-osec), .rl-osec > :not(.rl-gang, table), .rl-dt tr, .rl-gang > :not(.rl-mu), .rl-mu > *",
      ),
      ...side.querySelectorAll<HTMLElement>(":scope > *"),
    ].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.height > 0 && r.bottom > -h && r.top < 2 * h;
    });
  };
  /** A paragraph about to open from 目 lines: read while the page is as it was. */
  type Opening = {
    para: HTMLElement;
    own: HTMLElement[];
    others: HTMLElement[];
    words: Token[];
    looks: Look[];
    height: number;
  };
  /** Builds the paragraph a 目 line opens to, with every line on the leaf that lies in it. */
  const prepareOpen = (line: HTMLElement): Opening | null => {
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
        ".rl-mu-s[data-ev]:not(.rl-open)",
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
    para.dataset.lines = lines
      .map((l) => {
        const x = lineSentence(l)!;
        return `${x.p.number}:${x.i}`;
      })
      .join(" ");
    para.dataset.from = lines.map((l) => l.dataset.ev).join(" ");
    const words = lineTokens(lines);
    return {
      para,
      own,
      others,
      words,
      looks: looksOf(words),
      height: own[0]!.getBoundingClientRect().height,
    };
  };
  /** Puts an opening paragraph in place of its lines and starts its motion once laid out. */
  const commitOpen = (o: Opening): HTMLElement => {
    const { para } = o;
    o.own[0]!.before(para);
    for (const l of [...o.own, ...o.others]) l.classList.add("rl-open");
    fillImages(para);
    if (port.reducedMotion()) return para;
    const keys = keysOf(para);
    flying(para, keys, true);
    busy.add(para);
    let whole = 0,
      to: Token[] = [];
    queued.push({
      measure: () => {
        whole = para.getBoundingClientRect().height;
        to = markedTokens(para);
      },
      start: () => {
        const text = para.querySelector<HTMLElement>(":scope > .rl-para-t");
        const runs = [
          para.animate(
            [{ clipPath: clipAt(o.height) }, { clipPath: clipAt(whole) }],
            {
              duration: DUR,
              easing: EASE,
            },
          ),
        ];
        if (text)
          runs.push(
            text.animate([{ opacity: 0 }, { opacity: 1 }], {
              duration: DUR * 0.55,
              delay: DUR * 0.4,
              easing: "ease-out",
              fill: "backwards",
            }),
          );
        void Promise.all([
          fly(o.words, o.looks, to),
          ...runs.map((r) => r.finished.catch(() => undefined)),
        ]).then(() => {
          flying(para, keys, false);
          busy.delete(para);
        });
      },
    });
    return para;
  };
  /** Opens a 目 line to its paragraph. */
  const openLine = (line: HTMLElement): HTMLElement | null => {
    const o = prepareOpen(line);
    return o ? commitOpen(o) : null;
  };

  /** Takes an opened paragraph away at once; gives back the first line it stood for, if any. */
  const removePara = (para: HTMLElement): Element | null => {
    const box = para.parentElement;
    let first: Element | null = null;
    for (const line of linesOf(para)) {
      line.classList.remove("rl-open");
      if (line.parentElement === box) first ??= line;
    }
    const row = para.closest(".rl-para-row");
    const host = row?.previousElementSibling ?? null;
    (row ?? para).remove();
    return first ?? host;
  };
  /** A paragraph about to close: read while the page is as it was. */
  type Closing = {
    para: HTMLElement;
    words: Token[];
    looks: Look[];
    box: DOMRect;
    look: CSSStyleDeclaration;
  };
  const prepareClose = (para: HTMLElement): Closing | null => {
    if (para.dataset.closing || !para.isConnected) return null;
    const words = para.dataset.from ? markedTokens(para) : [];
    return {
      para,
      words,
      looks: looksOf(words),
      box: para.getBoundingClientRect(),
      look: getComputedStyle(para),
    };
  };
  /**
   * The page goes back to its lines at once; a copy of the slip stays over
   * it, closing from its height to the line's while its words fly home and
   * its ink goes. Gives back what stands where the paragraph was.
   */
  const commitClose = (c: Closing): Element | null => {
    const { para } = c;
    para.dataset.closing = "true";
    const lines = linesOf(para);
    const keys = keysOf(para);
    if (port.reducedMotion()) return removePara(para);
    const copy = para.cloneNode(true) as HTMLElement;
    flying(copy, keys, true);
    copy.classList.add("rl-para-copy");
    const cs = c.look;
    Object.assign(copy.style, {
      position: "absolute",
      left: `${c.box.left}px`,
      top: `${c.box.top}px`,
      width: `${c.box.width}px`,
      height: `${c.box.height}px`,
      margin: "0",
      boxSizing: "border-box",
      font: cs.font,
      lineHeight: cs.lineHeight,
      letterSpacing: cs.letterSpacing,
      color: cs.color,
      textAlign: cs.textAlign,
    });
    const back = removePara(para);
    for (const l of lines) l.classList.add("rl-landing");
    stage.append(copy);
    let to: Token[] = [],
      height = 0;
    queued.push({
      measure: () => {
        to = lineTokens(lines);
        const own = lines.find((l) => back === l) ?? lines[0];
        height = own?.getBoundingClientRect().height ?? 0;
      },
      start: () => {
        const text = copy.querySelector<HTMLElement>(":scope > .rl-para-t");
        const runs = [
          copy.animate(
            [{ clipPath: clipAt(c.box.height) }, { clipPath: clipAt(height) }],
            { duration: DUR, easing: EASE, fill: "forwards" },
          ),
        ];
        if (text)
          runs.push(
            text.animate([{ opacity: 1 }, { opacity: 0 }], {
              duration: DUR * 0.45,
              easing: "ease-in",
              fill: "forwards",
            }),
          );
        if (!c.words.length)
          runs.push(
            copy.animate([{ opacity: 1 }, { opacity: 0 }], {
              duration: DUR * 0.7,
              easing: EASE,
              fill: "forwards",
            }),
          );
        void Promise.all([
          fly(c.words, c.looks, to),
          ...runs.map((r) => r.finished.catch(() => undefined)),
        ]).then(() => {
          for (const l of lines) l.classList.remove("rl-landing");
          copy.remove();
        });
      },
    });
    return back;
  };
  /** Closes an opened paragraph back into its lines; gives back what stands there now. */
  const closePara = (para: HTMLElement): Element | null => {
    const c = prepareClose(para);
    return c ? commitClose(c) : null;
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
    if (!port.reducedMotion()) {
      let whole = 0;
      queued.push({
        measure: () => {
          whole = para.getBoundingClientRect().height;
        },
        start: () => {
          para.animate(
            [
              { clipPath: clipAt(0), opacity: 0 },
              { clipPath: clipAt(whole), opacity: 1 },
            ],
            { duration: DUR, easing: EASE },
          );
        },
      });
    }
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
      const closing = open.map(prepareClose).filter((c): c is Closing => !!c);
      for (const c of closing) commitClose(c);
      return;
    }
    // Read every paragraph before any goes in: each one moves what follows.
    const openings: Opening[] = [];
    for (const line of layer === "overview" ? shut.slice(0, 1) : shut) {
      if (openings.some((o) => o.own.includes(line) || o.others.includes(line)))
        continue;
      const o = prepareOpen(line);
      if (o) openings.push(o);
    }
    for (const o of openings) commitOpen(o);
  };
  /**
   * Changes what is open while the place pressed stays where it was on the
   * screen. Read, write, lay out once, read, write: the page is measured,
   * changed and laid out a single time; every new place is read against
   * that one layout (the margin's from what was written to it); then what
   * moved slides from where it was, and the motions start.
   */
  const keepPlace = (at: Element, change: () => Element | null | void) => {
    const before = at.getBoundingClientRect().top;
    const was = blocksNear().map((el) => ({
      el,
      top: el.getBoundingClientRect().top,
      placed: parseFloat(el.style.top) || 0,
    }));
    const anchoring = port.body.style.overflowAnchor;
    port.body.style.overflowAnchor = "none";
    const after = change() || at;
    const scrolled = port.body.scrollTop;
    if (after.isConnected)
      port.body.scrollTop += after.getBoundingClientRect().top - before;
    const shift = port.body.scrollTop - scrolled;
    const motions = queued;
    queued = [];
    const animate = !port.reducedMotion();
    if (animate) for (const m of motions) m.measure();
    const moves: [HTMLElement, number][] = [];
    if (animate)
      for (const w of was) {
        if (!w.el.isConnected || busy.has(w.el) || side.contains(w.el))
          continue;
        const dy = w.top - w.el.getBoundingClientRect().top;
        if (Math.abs(dy) > 0.5) moves.push([w.el, dy]);
      }
    place();
    if (animate) {
      // The margin's new places are what was just written to it.
      for (const w of was) {
        if (!w.el.isConnected || !side.contains(w.el)) continue;
        const dy = shift - ((parseFloat(w.el.style.top) || 0) - w.placed);
        if (Math.abs(dy) > 0.5) moves.push([w.el, dy]);
      }
      for (const m of motions) m.start();
      for (const [el, dy] of moves)
        el.animate(
          [{ transform: `translateY(${dy}px)` }, { transform: "none" }],
          { duration: DUR, easing: EASE },
        );
    }
    port.body.style.overflowAnchor = anchoring;
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
      const closing = opened.map(prepareClose).filter((c): c is Closing => !!c);
      for (const c of closing) commitClose(c);
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
