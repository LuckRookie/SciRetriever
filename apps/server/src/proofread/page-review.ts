import type {
  ArrangementLeaf,
  CorrectOperation,
} from "@sciretriever/contracts";
import type { PdfPageInspection } from "../browser/pdf-region.js";
import { matchingBlocks, opcodes, similarity } from "./sequence.js";

/**
 * ADR 0047: one proofreading request per page. The host compares each retained leaf
 * with the PDF text layer, sends the differences with the page image, and checks every
 * edit the model returns before it applies. An edit that fails a check leaves the parse
 * as it is.
 */
export const PAGE_REVIEW_METHOD = "page-review-guards-v1";
/** Share of a leaf's words the text layer must hold for the leaf to be checked against it. */
const LEAF_COVERAGE = 0.3;
/** Share of a page's checked words the text layer must match for the page to be trusted. */
const PAGE_TRUST = 0.9;

export const PAGE_REVIEW_SYSTEM = `You proofread one page of a scientific article against its page image.
The goal is a transcript that matches what is printed on this page, character for character. You are not an editor.
You receive the page image (the authority), the parsed text of each retained leaf, the places where the parsed text differs from the PDF text layer, and the leaves whose text is drawn inside figures, schemes or tables (no text layer exists for them).
The parsed text comes from layout parsing of the image. The PDF text layer comes from the fonts and is often wrong itself: lost fi/ff/fl ligatures, "(" read as "8", "+" as "þ", μ as "l" or "m", γ as "y", missing or extra spaces. A difference is only a hint.
Rules:
- Reproduce the print. Keep the authors' own spelling, typos, inconsistent terms and grammar exactly as printed, even when the abstract or another page uses a different word.
- Change a leaf only where the image clearly shows different characters at that place. Restoring printed text the parse dropped (a superscript citation, a missing table cell, a compound number with its yield) is allowed.
- Inside a chemical structure drawing, never transcribe atom, bond, group or substituent labels (O, N, Me, Ph, R1, n-Bu, OMe and the like). Only printed text outside the drawings counts: compound numbers, yields, conditions, captions, headings and table cells.
- Never delete content. If some text looks duplicated, misplaced or not printed, do not remove or replace it: list it under uncertain.
- Keep LaTeX markup and the spacing inside formulas as they are. Dashes and quotes follow the print: where the image prints an en dash (–) or em dash (—) the parse's hyphen becomes that dash, and printed curly quotes replace straight ones; never turn a printed hyphen into a dash.
- Two units or names that the image prints apart but the parse fused are separated: \\mathrm{mgcm} or 5mgcm for "5 mg cm" becomes 5\\,\\mathrm{mg}\\,\\mathrm{cm} in math, "5 mg cm" in text.
- Text drawn inside a figure or scheme (panel letters A, B, C, axis labels, reaction arrows and conditions) never goes into a caption, a table cell or the running text.
- Every superscript or subscript you add or change is written in LaTeX, in running text and in table cells alike: $^{7}$, $^{4b,8,9}$, $^{a,b}$, $\\mathrm{Cs_2CO_3}$, $\\mathrm{D_p}$. Never write <sup> or <sub> tags and never introduce Unicode superscript or subscript characters (⁷, ₂, ᵃ); existing notation stays as it is.
- Check especially: misspelled words; l/I/1, O/0, rn/m, cl/d confusions; letters in chemical and compound names; digits, decimal points and signs; sub- and superscripts; Greek letters; author and place names; every figure_leaves text against the drawing.
Answer with exactly one submit_corrections call: corrections (original must be an exact substring of that leaf's text) and uncertain (places you could not settle from the image), either may be empty.`;

const GREEK: Readonly<Record<string, string>> = {
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  epsilon: "ε",
  varepsilon: "ε",
  theta: "θ",
  lambda: "λ",
  mu: "μ",
  nu: "ν",
  pi: "π",
  rho: "ρ",
  sigma: "σ",
  tau: "τ",
  phi: "φ",
  varphi: "φ",
  chi: "χ",
  psi: "ψ",
  omega: "ω",
  Delta: "Δ",
  Omega: "Ω",
  pm: "±",
  times: "×",
  circ: "°",
  degree: "°",
  sim: "~",
  cdot: "·",
  AA: "Å",
  approx: "≈",
  leq: "≤",
  geq: "≥",
  le: "≤",
  ge: "≥",
  rightarrow: "→",
  to: "→",
};

/** Notation that is not a transcription difference: LaTeX markup, dashes, quotes, ligatures. */
export function reviewNormalize(value: string, layer = false): string {
  let s = value.normalize("NFKC");
  if (layer) s = s.replace(/([\p{L}\p{N}_])-\n([\p{L}\p{N}_])/gu, "$1$2");
  // Inside $...$ spacing is notation: UO_2 and Gd_2O_3 read as UO2 and Gd2O3.
  s = s.replace(/\$+([^$]*)\$+/gu, (_, inner: string) => {
    const x = inner.replace(
      /\\([A-Za-z]+)/gu,
      (_m, g: string) => GREEK[g] ?? "",
    );
    return " " + x.replace(/[\s^_{}~\\,;!]/gu, "") + " ";
  });
  s = s.replace(/\\([A-Za-z]+)/gu, (_m, g: string) => GREEK[g] ?? " ");
  s = s.replace(/[\\$^_{}~]/gu, " ");
  return s
    .replace(/[−–—‐‑]/gu, "-")
    .replace(/[’‘]/gu, "'")
    .replace(/[“”]/gu, '"');
}
export function reviewTokens(value: string, layer = false): string[] {
  return reviewNormalize(value, layer).match(/[\p{L}\p{N}]+/gu) ?? [];
}
/** Letters compared without accents: the text layer may store an umlaut as a separate mark. */
function plain(word: string): string {
  return word.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}
/** Markup is not printed text: <sup>, <td> and LaTeX commands are not words. */
function words(value: string): string[] {
  return reviewTokens(value.replace(/<\/?[A-Za-z][^>]*>/gu, " "));
}
function counts(items: readonly string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const x of items) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
}
/** Items of `a` left after removing `b`, by count. */
function minus(a: readonly string[], b: readonly string[]): string[] {
  const left = counts(b);
  return a.filter((x) => {
    const n = left.get(x) ?? 0;
    if (!n) return true;
    left.set(x, n - 1);
    return false;
  });
}

export interface PageReviewPlan {
  /** Whole-page: no trustworthy text layer, the model compares every leaf with the image. */
  readonly mode: "differences" | "whole-page";
  readonly differences: readonly {
    readonly leaf_id: string;
    readonly parsed: string;
    readonly text_layer: string;
  }[];
  /** Leaves the text layer does not hold: text drawn inside figures, schemes or tables. */
  readonly figure_leaf_ids: readonly string[];
  readonly trusted: boolean;
  readonly clean: boolean;
  /** Each leaf's stretch of text-layer words; null for figure text. */
  readonly windows: ReadonlyMap<string, readonly string[] | null>;
}
export function pageReviewPlan(
  page: PdfPageInspection,
  retained: readonly ArrangementLeaf[],
): PageReviewPlan {
  const layer = page.kind === "text-layer" ? reviewTokens(page.text, true) : [];
  const windows = new Map<string, readonly string[] | null>(),
    figure: string[] = [],
    differences: { leaf_id: string; parsed: string; text_layer: string }[] = [];
  let total = 0,
    matched = 0;
  // Align each leaf on its own: page reading order differs across columns and figures.
  for (const leaf of retained) {
    const lt = reviewTokens(leaf.original_text);
    if (!lt.length) continue;
    const blocks = layer.length ? matchingBlocks(lt, layer) : [];
    if (
      !blocks.length ||
      blocks.reduce((n, b) => n + b.size, 0) < LEAF_COVERAGE * lt.length
    ) {
      windows.set(leaf.leaf_id, null);
      figure.push(leaf.leaf_id);
      continue;
    }
    const j0 = blocks[0]!.b,
      j1 = blocks.at(-1)!.b + blocks.at(-1)!.size,
      span = layer.slice(j0, j1);
    windows.set(leaf.leaf_id, layer.slice(Math.max(0, j0 - 3), j1 + 3));
    total += lt.length;
    for (const [tag, i1, i2, k1, k2] of opcodes(lt, span)) {
      if (tag === "equal") {
        matched += i2 - i1;
        continue;
      }
      const a = lt.slice(i1, i2),
        b = span.slice(k1, k2);
      // Only where the words are split differently: notation, not a difference.
      if (a.join("") !== b.join(""))
        differences.push({
          leaf_id: leaf.leaf_id,
          parsed: a.join(" "),
          text_layer: b.join(" "),
        });
    }
  }
  const trusted =
    page.kind === "text-layer" && total > 0 && matched / total >= PAGE_TRUST;
  return {
    mode: trusted ? "differences" : "whole-page",
    differences: trusted ? differences : [],
    figure_leaf_ids: figure,
    trusted,
    clean: page.unmapped_glyphs === 0,
    windows,
  };
}

export type PageReviewRule =
  | "not-in-leaf"
  | "locked"
  | "insert-from-nothing"
  | "copyright"
  | "shrinks"
  | "drops-digits"
  | "structure-labels"
  | "mark-not-printed"
  | "not-printed"
  | "near-miss"
  | "conflict";

const COPYRIGHT =
  /©|\(c\)\s*\d{4}|all rights reserved|creative commons|published by/iu;
const LABEL =
  /^(?:[A-Z][a-z]?\d?|R\d*|n|[a-z]?-?Bu|Ph|Me|Et|Pr|OMe|OHC|CO2Et|CO2Me|MeO|\d)$/u;
/** G3: three or more drawing labels inserted in a row are atom/group labels, not printed text. */
function structureLabels(original: string, replacement: string): boolean {
  const strip = (s: string) =>
    s
      .replace(/<\/?[A-Za-z][^>]*>/gu, " ")
      .split(/\s+/u)
      .filter(Boolean);
  const a = strip(original),
    b = strip(replacement);
  for (const [tag, , , j1, j2] of opcodes(a, b)) {
    if (tag !== "insert" && tag !== "replace") continue;
    let run = 0;
    for (const w of b.slice(j1, j2)) {
      run = LABEL.test(w) ? run + 1 : 0;
      if (run >= 3) return true;
    }
  }
  return false;
}

const MARKS = "–—‘’“”";
// Some publishers (ACS) store a printed range or compound dash as the minus sign.
const SAME_MARK: Readonly<Record<string, string>> = {
  "–": "–−",
  "—": "—−",
  "‘": "‘",
  "’": "’",
  "“": "“",
  "”": "”",
};
/** G7: each dash or curly quote an edit adds is printed there, between the words around it. */
function marksPrinted(
  text: string,
  original: string,
  replacement: string,
  layer: string,
): boolean {
  const flat = layer.replace(/\s+/gu, " "),
    at = text.indexOf(original),
    head = at >= 0 ? text.slice(0, at) : "",
    tail = at >= 0 ? text.slice(at + original.length) : "";
  const chars = [...replacement];
  for (let k = 0; k < chars.length; k++) {
    const ch = chars[k]!;
    const count = (s: string) => [...s].filter((x) => x === ch).length;
    if (!MARKS.includes(ch) || count(replacement) <= count(original)) continue;
    const left = (head + chars.slice(0, k).join(""))
        .match(/[\p{L}\p{N}]+/gu)
        ?.at(-1),
      right = (chars.slice(k + 1).join("") + tail).match(/[\p{L}\p{N}]+/u)?.[0];
    if (!left || !right) return false;
    const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const m = new RegExp(`${escape(left)}(.{0,8}?)${escape(right)}`, "u").exec(
      flat,
    );
    if (!m || ![...SAME_MARK[ch]!].some((x) => m[1]!.includes(x))) return false;
  }
  return true;
}

/**
 * Text-layer words printed where `original` sits in the leaf, between the matched words
 * around it: `strict` holds only those, `loose` two more on each side for alignment noise.
 * Null when the edit cannot be placed on the text layer.
 */
function atPlace(
  text: string,
  original: string,
  window: readonly string[],
  slack = 2,
): { strict: readonly string[]; loose: readonly string[] } | null {
  const i = text.indexOf(original);
  if (i < 0 || !window.length) return null;
  const lt = words(text),
    k0 = words(text.slice(0, i)).length,
    k1 = k0 + words(original).length;
  const mapped = new Map<number, number>();
  for (const b of matchingBlocks(lt.map(plain), window.map(plain)))
    for (let d = 0; d < b.size; d++) mapped.set(b.a + d, b.b + d);
  let before: number | undefined, after: number | undefined;
  for (let k = k0 - 1; k >= 0 && before === undefined; k--)
    before = mapped.get(k);
  for (let k = k1; k < lt.length && after === undefined; k++)
    after = mapped.get(k);
  if (before === undefined && after === undefined) return null;
  const j0 =
      before !== undefined
        ? before + 1
        : Math.max(0, after! - (k1 - k0) - slack),
    j1 =
      after !== undefined
        ? after
        : Math.min(window.length, j0 + (k1 - k0) + slack);
  return {
    strict: window.slice(j0, j1),
    loose: window.slice(Math.max(0, j0 - slack), j1 + slack),
  };
}
const GROUP = /[\^_]\{[^}]*\}|<su[pb]>.*?<\/su[pb]>/gu;
const SCRIPT =
  /(?<=[\^_]\{)[^}]*(?=\})|(?<=<sup>).*?(?=<\/sup>)|(?<=<sub>).*?(?=<\/sub>)/gu;
const scripts = (s: string) => words((s.match(SCRIPT) ?? []).join(" "));

/** The program checks for one model edit (ADR 0047 §2); null when the edit may apply. */
export function guardEdit(
  page: PdfPageInspection,
  plan: PageReviewPlan,
  leaf: ArrangementLeaf,
  original: string,
  replacement: string,
): PageReviewRule | null {
  const text = leaf.original_text;
  if (!original.trim()) return "insert-from-nothing"; // G5: figure text or dropped content
  if (!text.includes(original) || original === replacement)
    return "not-in-leaf";
  if (COPYRIGHT.test(replacement) && !COPYRIGHT.test(original))
    return "copyright"; // G6
  const o = [...original].length,
    n = [...replacement].length;
  if (o >= 20 && n < 0.5 * o) return "shrinks"; // G2
  const digits = (s: string) => s.match(/\d+/gu) ?? [];
  if (minus(digits(original), digits(replacement)).length && n < o)
    return "drops-digits";
  if (structureLabels(original, replacement)) return "structure-labels"; // G3
  if (
    page.kind === "text-layer" &&
    !marksPrinted(text, original, replacement, page.text)
  )
    return "mark-not-printed"; // G7; an unverifiable mark keeps the parse's hyphen
  const window = plan.windows.get(leaf.leaf_id);
  if (!window) return null;
  const place = atPlace(text, original, window);
  // Superscripts sit elsewhere in the text layer's reading order: check them in the window.
  const removed = minus(words(original), words(replacement)),
    // A fused word split apart (yielda -> yield + a) adds no new spelling.
    split = (w: string) => removed.some((r) => plain(r).includes(plain(w))),
    added = minus(
      words(replacement.replace(GROUP, " ")),
      words(original.replace(GROUP, " ")),
    ).filter((w) => !split(w)),
    addedScripts = minus(
      minus(scripts(replacement), scripts(original)),
      words(original),
    );
  if (plan.trusted && plan.clean) {
    // G1: every added word, letter or digit is what the text layer prints there.
    // An initial or a short number must sit exactly there; longer words get some slack.
    const printed = (w: string) =>
        new Set(
          (place
            ? [...w].length <= 2
              ? place.strict
              : place.loose
            : window
          ).map(plain),
        ).has(plain(w)),
      inWindow = new Set(window.map(plain)),
      flat = window.map(plain).join("");
    if (
      added.some(
        (w) =>
          (place !== null || (/^\p{L}+$/u.test(w) && w.length >= 3)) &&
          !printed(w),
      ) ||
      addedScripts.some(
        (w) => !inWindow.has(plain(w)) && !flat.includes(plain(w)),
      )
    )
      return "not-printed";
  }
  // G1b on any page: the text layer prints a third spelling close to the new word there.
  if (place) {
    const there = place.loose.map(plain);
    for (const w of added) {
      const p = plain(w);
      if (
        /^\p{L}{4,}$/u.test(w) &&
        !there.includes(p) &&
        there.some((t) => similarity(p, t) >= 0.8)
      )
        return "near-miss";
    }
  }
  return null;
}

const IDENT =
  /(?:10\.\d{4,9}\/[^\s,;<>"]+|https?:\/\/[^\s<>"]+|[\p{L}\p{N}_.+-]+@[\p{L}\p{N}_-]+\.[\p{L}\p{N}_.-]+)/gu;
const idents = (s: string) =>
  (s.match(IDENT) ?? []).map((x) => x.replace(/\.+$/u, ""));
/** G4: DOIs, URLs and e-mail addresses a few characters off from the text layer take its form. */
export function identifierFixes(
  page: PdfPageInspection,
  retained: readonly ArrangementLeaf[],
): readonly { leaf_id: string; original: string; replacement: string }[] {
  if (page.kind !== "text-layer") return [];
  const layer = page.text.normalize("NFKC"),
    flat = layer.replace(/\s+/gu, ""),
    printed = [...new Set(idents(layer))];
  return retained.flatMap((leaf) =>
    [...new Set(idents(leaf.original_text))].flatMap((id) => {
      if (flat.includes(id) || !printed.length) return [];
      const best = printed.reduce((x, y) =>
        similarity(id, y) > similarity(id, x) ? y : x,
      );
      return similarity(id, best) >= 0.85
        ? [{ leaf_id: leaf.leaf_id, original: id, replacement: best }]
        : [];
    }),
  );
}

/** One model edit becomes a correction at every place its original occurs in the leaf. */
export function editOperations(
  leaf: ArrangementLeaf,
  original: string,
  replacement: string,
  pageIndex: number,
  reason: string,
): CorrectOperation[] {
  const text = leaf.original_text,
    out: CorrectOperation[] = [];
  const line = reason.split(/\r?\n/u)[0]!.trim();
  const note = [...(line || "transcription")].slice(0, 120).join("");
  for (
    let at = text.indexOf(original);
    at >= 0 && original;
    at = text.indexOf(original, at + original.length)
  ) {
    const start = [...text.slice(0, at)].length;
    out.push({
      kind: "correct",
      leaf_id: leaf.leaf_id,
      start,
      end: start + [...original].length,
      original,
      replacement,
      basis_page_index: pageIndex,
      reason: note,
    });
  }
  return out;
}
