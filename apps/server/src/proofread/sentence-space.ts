import type {
  ArrangementLeaf,
  CorrectOperation,
} from "@sciretriever/contracts";
import type { PdfPageInspection } from "../browser/pdf-region.js";
import type { PageReviewPlan } from "./page-review.js";
import { matchingBlocks } from "./sequence.js";

/**
 * ADR 0074 §3: a space the parse lost after a sentence period is put back where the
 * page's text layer prints one. Only on trusted text-layer pages; where the text layer
 * is glued too (a contents number, code) or the place cannot be found, nothing changes.
 */
export const SENTENCE_SPACE_RULE = "sentence-space-v1";
/** Running-text leaves; table HTML, images and display equations are not checked. */
const TYPES = new Set([
  "title",
  "text",
  "list",
  "caption",
  "footnote",
  "reference",
]);
/** A letter, digit, `)`, `]` or `%`, a period, then an upper-case letter and a letter. */
const GLUED = /(?<=[\p{L}\p{N})\]%])\.(?=\p{Lu}\p{L})/gu;
const WORD = /[\p{L}\p{N}]+/gu;
const REASON = "space after the period, as the text layer prints it";

/** UTF-16 ranges of `$…$` and `$$…$$`; an unclosed `$` runs to the end of the text. */
function formulas(text: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "$" || (i > 0 && text[i - 1] === "\\")) continue;
    const fence = text[i + 1] === "$" ? "$$" : "$";
    let close = text.indexOf(fence, i + fence.length);
    while (close > 0 && text[close - 1] === "\\")
      close = text.indexOf(fence, close + 1);
    const end = close < 0 ? text.length : close + fence.length;
    out.push({ start: i, end });
    i = end - 1;
  }
  return out;
}
const plain = (w: string) =>
  w.normalize("NFKC").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
interface Token {
  readonly word: string;
  readonly start: number;
  readonly end: number;
}
function tokens(text: string): Token[] {
  return [...text.matchAll(WORD)].map((m) => ({
    word: plain(m[0]),
    start: m.index,
    end: m.index + m[0].length,
  }));
}
/**
 * The text layer between two words: "spaced" when whitespace or a line break follows
 * the period there, "glued" when it does not, null when the characters between them
 * are not the leaf's.
 */
function verdict(between: string, gap: string): "spaced" | "glued" | null {
  if (gap.replace(/\s+/gu, "") !== between) return null;
  const after = gap.slice(gap.lastIndexOf(".") + 1);
  return after ? "spaced" : "glued";
}

/** The program's sentence-space corrections of one page, recorded like page corrections. */
export function sentenceSpaceCorrections(
  page: PdfPageInspection,
  plan: PageReviewPlan,
  leaves: readonly ArrangementLeaf[],
): (CorrectOperation & { readonly rule: string })[] {
  if (page.kind !== "text-layer" || !plan.trusted) return [];
  let layer: { text: string; words: Token[]; plain: string[] } | null = null;
  const out: (CorrectOperation & { readonly rule: string })[] = [];
  for (const leaf of leaves) {
    const text = leaf.original_text;
    // Figure text has no stretch of the text layer to compare with.
    if (!TYPES.has(leaf.type) || !plan.windows.get(leaf.leaf_id)) continue;
    const math = formulas(text),
      places = [...text.matchAll(GLUED)]
        .map((m) => m.index)
        .filter((at) => !math.some((f) => at >= f.start && at < f.end));
    if (!places.length) continue;
    if (!layer) {
      const value = page.text.normalize("NFKC"),
        words = tokens(value);
      layer = { text: value, words, plain: words.map((w) => w.word) };
    }
    // LaTeX commands and tags are not printed words; blanking them keeps the offsets.
    const lt = tokens(
      text.replace(/\\[A-Za-z]+|<\/?[A-Za-z][^>]*>/gu, (m) =>
        " ".repeat(m.length),
      ),
    );
    const mapped = new Map<number, number>();
    for (const b of matchingBlocks(
      lt.map((t) => t.word),
      layer.plain,
    ))
      for (let d = 0; d < b.size; d++) mapped.set(b.a + d, b.b + d);
    for (const at of places) {
      const right = lt.findIndex((t) => t.start === at + 1),
        left = right - 1;
      if (left < 0) continue;
      // The text layer at the same place: the two words, aligned with the leaf.
      const k =
        mapped.get(left) ??
        (mapped.has(right) ? mapped.get(right)! - 1 : undefined);
      if (
        k === undefined ||
        k < 0 ||
        layer.plain[k] !== lt[left]!.word ||
        layer.plain[k + 1] !== lt[right]!.word
      )
        continue;
      const between = text
          .slice(lt[left]!.end, at + 1)
          .replace(/[\s$^_{}]/gu, ""),
        gap = layer.text.slice(layer.words[k]!.end, layer.words[k + 1]!.start);
      if (verdict(between, gap) !== "spaced") continue;
      const start = [...text.slice(0, at)].length;
      out.push({
        kind: "correct",
        leaf_id: leaf.leaf_id,
        start,
        end: start + 1,
        original: ".",
        replacement: ". ",
        basis_page_index: page.page,
        reason: REASON,
        rule: SENTENCE_SPACE_RULE,
      });
    }
  }
  return out;
}
