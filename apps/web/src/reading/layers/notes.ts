import type { LayersReadEvidence } from "@sciretriever/contracts";
import type { DocumentTextMode } from "../contract.js";
import { ADDED } from "../block-text.js";
import { PLACE, canon, indexText, locate, rangeOf } from "../mark-locate.js";
import {
  KIND_NAMES,
  langOf,
  markTerms,
  numberHTML,
  pointWords,
  richHTML,
  type LayersModel,
  type LayersPort,
} from "./model.js";
import type { ReadLayersPoint } from "./read.js";

/**
 * The notes on the full text (reading-experience 3.4, ADR 0070 section 3):
 * each sentence a note stands on is wrapped where it lies, its stressed
 * words set in the commentator's ink, the note's number at its end; the note
 * itself is written in the margin by the view.
 *
 * The author's text is not changed: only elements are put around its text
 * nodes, and the number is drawn by CSS from an attribute, so what a reader
 * selects, copies or searches is the text as it was.
 */
const SIGNS =
  ".reading-block-source, .reading-doubt, .katex-mathml, .reading-margin-note-below, .rl-below";
/** In a block's own text: the signs beside it and its translation are not the author's words. */
const SKIP = `${ADDED}, ${SIGNS}`;
/** Inside a block's translation. */
const SKIP_TRANSLATED =
  ".reading-untranslated, .reading-translation-marks, .katex-mathml";
type Sentence = Extract<LayersReadEvidence, { kind: "sentence" }>;

let revision = 0;
/** Says a block's text nodes were split or joined: marks index it again. */
const touched = (node: Node | null) => {
  const block = (
    node instanceof Element ? node : node?.parentElement
  )?.closest<HTMLElement>("section[data-byte-start]");
  if (block) block.dataset.textRevision = String(++revision);
};
/** Takes the layers' elements out of the article; the text nodes join again. */
export function clearNotes(article: HTMLElement): void {
  const parents = new Set<Node>();
  for (const el of article.querySelectorAll(".rl-kt, .rl-ev")) {
    const parent = el.parentNode;
    if (!parent) continue;
    parents.add(parent);
    el.replaceWith(...el.childNodes);
  }
  for (const parent of parents) {
    parent.normalize();
    touched(parent);
  }
  for (const el of article.querySelectorAll(".rl-below")) el.remove();
}

/** The text nodes (or whole formulas) a range covers, each as its own range. */
function pieces(range: Range, skip: string): (Range | HTMLElement)[] {
  const root =
    range.commonAncestorContainer.nodeType === Node.TEXT_NODE
      ? range.commonAncestorContainer.parentNode!
      : range.commonAncestorContainer;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const out: (Range | HTMLElement)[] = [];
  const formulas = new Set<HTMLElement>();
  for (
    let n = walker.nextNode() as Text | null;
    n;
    n = walker.nextNode() as Text | null
  ) {
    if (!range.intersectsNode(n) || !n.data.length) continue;
    const parent = n.parentElement;
    // A formula is taken whole: its inner spans are KaTeX's to lay out. It
    // is found by its TeX, which KaTeX keeps out of sight.
    const formula = parent?.closest<HTMLElement>(".katex");
    if (formula) {
      if (!formula.closest(skip) && !formulas.has(formula)) {
        formulas.add(formula);
        out.push(formula);
      }
      continue;
    }
    if (parent?.closest(skip)) continue;
    const start = n === range.startContainer ? range.startOffset : 0,
      end = n === range.endContainer ? range.endOffset : n.data.length;
    if (end <= start) continue;
    const piece = document.createRange();
    piece.setStart(n, start);
    piece.setEnd(n, end);
    out.push(piece);
  }
  return out;
}

export interface PlacedEvidence {
  readonly point: number;
  readonly index: number;
  /** The elements around the sentence's words, in text order; empty when it was not found. */
  readonly spans: readonly HTMLElement[];
  /** The block the sentence lies in. */
  readonly block: HTMLElement | null;
}

/** A sentence as marked in a block: its words, and the translation when it has one. */
export type MarkedSentence = Pick<Sentence, "start_utf8" | "text"> & {
  readonly translation?: Sentence["translation"];
};
/**
 * Whether a text node is left out when a sentence is looked for. A formula is
 * read as its TeX (KaTeX keeps it in an annotation), as the layers write it:
 * its drawn glyphs ("400nm") would never match "$400\mathrm{nm}$".
 */
function skipped(node: Text, skip: string): boolean {
  const el = node.parentElement;
  if (!el) return false;
  const formula = el.closest(".katex");
  if (formula)
    return (
      !el.closest('annotation[encoding="application/x-tex"]') ||
      !!formula.closest(skip)
    );
  return !!el.closest(skip);
}
/** Puts the note's marks around one sentence's words under `root`; empty when not found word for word. */
function wrap(
  p: ReadLayersPoint,
  i: number | string,
  e: MarkedSentence,
  root: HTMLElement,
  text: string,
  terms: readonly string[],
  skip: string,
): HTMLElement[] {
  const index = indexText(root, (node) => skipped(node, skip));
  const found = locate(canon(text), index.text);
  if (!found || found.sim < PLACE) return [];
  const range = rangeOf(index, found.start, found.end);
  if (!range) return [];
  const spans: HTMLElement[] = [];
  for (const piece of pieces(range, skip)) {
    const span = document.createElement("span");
    span.className = "rl-ev";
    span.dataset.point = String(p.number);
    span.dataset.ev = `${p.number}:${i}`;
    if (piece instanceof HTMLElement) {
      // Already inside another note's sentence: leave it there.
      if (piece.parentElement?.closest(".rl-ev")) continue;
      piece.replaceWith(span);
      span.append(piece);
    } else {
      if (piece.startContainer.parentElement?.closest(".rl-ev")) continue;
      piece.surroundContents(span);
    }
    spans.push(span);
  }
  for (const span of spans) markTerms(span, terms);
  const first = spans[0],
    last = spans.at(-1);
  if (first) {
    first.dataset.f = `ev:${p.number}:${i}`;
    first.dataset.startUtf8 = String(e.start_utf8);
    touched(first);
  }
  if (last) {
    last.classList.add("rl-ev-end");
    last.dataset.no = String(p.number);
    if (p.primary) last.classList.add("rl-ring");
  }
  return spans;
}

/**
 * Marks one sentence of a note in a block of the full text, or in a copy of
 * one, as the reading shows it: the original's words, the translation's, or
 * both (the number at the original's end only).
 */
export function markSentence(
  block: HTMLElement,
  p: ReadLayersPoint,
  i: number | string,
  e: MarkedSentence,
  mode: DocumentTextMode,
): HTMLElement[] {
  const translation = block.querySelector<HTMLElement>(
    ":scope > .reading-translation",
  );
  let spans: HTMLElement[] = [];
  if (mode !== "translation" || !translation)
    spans = wrap(p, i, e, block, e.text, p.key_terms, SKIP);
  if (mode !== "original" && translation && e.translation?.text) {
    const more = wrap(
      p,
      i,
      e,
      translation,
      e.translation.text,
      p.translation?.key_terms ?? [],
      SKIP_TRANSLATED,
    );
    // 对照: both are marked; the number stands at the original's end only.
    if (spans.length)
      for (const span of more) {
        span.classList.remove("rl-ev-end", "rl-ring");
        delete span.dataset.no;
        delete span.dataset.f;
      }
    else spans = more;
  }
  return spans;
}

/**
 * Wraps every sentence evidence in the text shown. A sentence that cannot be
 * found word for word (a formula written another way) is left unwrapped; its
 * note still stands beside its paragraph.
 */
export function wrapNotes(
  model: LayersModel,
  port: LayersPort,
  mode: DocumentTextMode,
): PlacedEvidence[] {
  clearNotes(port.article);
  const placed: PlacedEvidence[] = [];
  for (const p of model.points)
    p.evidence.forEach((e, i) => {
      if (e.kind !== "sentence") return;
      const block =
        port
          .blocks()
          .find(
            (b) =>
              Number(b.dataset.byteStart) < e.end_utf8 &&
              Number(b.dataset.byteEnd) > e.start_utf8,
          ) ?? null;
      const spans = block ? markSentence(block, p, i, e, mode) : [];
      placed.push({ point: p.number, index: i, spans, block });
    });
  return placed;
}

/** The margin of the full text: a note for each point, in the commentator's hand and ink. */
export function notesSide(
  model: LayersModel,
  port: LayersPort,
  mode: DocumentTextMode,
  relations: (p: ReadLayersPoint) => string,
): string {
  let side = "";
  for (const p of model.points) {
    const w = pointWords(p, mode);
    const rel = relations(p);
    side +=
      `<aside class="rl-pi${p.primary ? " rl-main" : ""}" data-point="${p.number}"><div class="rl-pi-h">` +
      numberHTML(p, "rl-pi-no", `no:${p.number}`) +
      (p.kind
        ? `<span class="rl-pi-kind" data-f="kind:${p.number}">${KIND_NAMES[p.kind]}</span>`
        : "") +
      `</div><p class="rl-pi-t" data-f="note:${p.number}" lang="${langOf(w.text)}">${richHTML(w.text, w.terms)}</p>` +
      (rel ? `<p class="rl-pi-x" data-f="rel:${p.number}">${rel}</p>` : "") +
      `</aside>`;
  }
  return side;
}
