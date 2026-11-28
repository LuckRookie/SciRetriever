/**
 * Sentence split `sentence-split-v2` (document spec 3.5): a fixed program
 * rule, never a model. One implementation for the server and the Web reader.
 * It gives display numbers only (¶13·2), computed from text positions on
 * read; a later rule changes the numbers shown, never the positions stored,
 * and never makes a stored result stale.
 */
export const SENTENCE_SPLIT_RULE = "sentence-split-v2" as const;
/** Every rule a stored file may name; the numbers shown always use the current one. */
export const SENTENCE_SPLIT_RULES = [
  "sentence-split-v1",
  SENTENCE_SPLIT_RULE,
] as const;
export type SentenceSplitRule = (typeof SENTENCE_SPLIT_RULES)[number];

/** A sentence as a half-open range of JavaScript string indices. */
export interface SentenceRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Common abbreviations after which a period never ends a sentence. Matched
 * without case, at a word start.
 */
export const SENTENCE_ABBREVIATIONS: readonly string[] = [
  "e.g.",
  "i.e.",
  "et al.",
  "fig.",
  "figs.",
  "eq.",
  "eqs.",
  "vs.",
  "no.",
  "nos.",
  "dr.",
  "ref.",
  "refs.",
  "cf.",
  "ca.",
  "tab.",
];
const CJK_END = new Set(["。", "！", "？"]);
const LATIN_END = new Set(["!", "?"]);
/** Quotes and brackets that follow a sentence end belong to that sentence. */
const CLOSERS = new Set([
  '"',
  "'",
  "”",
  "’",
  "»",
  "）",
  ")",
  "]",
  "」",
  "』",
  "】",
  "》",
]);
const OPENING_QUOTES = new Set(['"', "“", "'", "‘", "«", "「", "『"]);
const SPACE = /\s/u;
const NEXT_SENTENCE = /[\p{Lu}\p{Lt}\p{N}]/u;
const LETTER = /[\p{L}\p{N}]/u;

function abbreviationBefore(text: string, period: number): boolean {
  const head = text.slice(Math.max(0, period - 8), period + 1).toLowerCase();
  for (const abbreviation of SENTENCE_ABBREVIATIONS) {
    if (!head.endsWith(abbreviation)) continue;
    const before = period + 1 - abbreviation.length - 1;
    if (before < 0 || !LETTER.test(text[before]!)) return true;
  }
  return false;
}
/** End of an inline `$…$` span starting at `at`, or -1 (an unmatched `$` is text). */
function inlineMathEnd(text: string, at: number): number {
  for (let i = at + 1; i < text.length; i++) {
    if (text[i] === "\\") {
      i++;
      continue;
    }
    if (text[i] === "\n" && text[i + 1] === "\n") return -1;
    if (text[i] === "$") return i + 1;
  }
  return -1;
}

/**
 * v2 on top of v1 (ADR 0074 §1). A citation right after a period, then
 * whitespace and the start of a sentence (an upper-case letter, a digit, a
 * quote or a formula), ends the sentence after the citation; a period, then
 * whitespace and an inline formula, ends it at the period. A citation is
 * `$^{…}$` (right after the period or after whitespace) or `[…]` right after
 * the period, holding only digits, commas, whitespace and dashes. A period
 * with no whitespace after it never ends a sentence here.
 */
const CITE_MATH = /^\$\s*\^\{?\s*[\d,\s‐-―−-]+\}?\s*\$/u;
const CITE_BRACKET = /^\[[\d,\s‐-―−-]+\]/u;
const URLISH = /(?:https?:\/\/|www\.|doi\.org)\S*$/u;
/** What may stand before a period these cuts read as a sentence end. */
const BEFORE_PERIOD = /[\p{L}\p{N})\]%$°]/u;
/** An initial such as the "J" of "J. Smith". */
const INITIAL = /(?:^|[\s(["“'‘])\p{Lu}$/u;
const AFTER_CITATION = /[\p{Lu}\p{Lt}\p{N}$"“'‘«「『]/u;

/** Inline `$…$` spans of `text` in [from, to), as [start, end). */
function mathSpans(text: string, from: number, to: number) {
  const spans: [number, number][] = [];
  for (let i = from; i < to; i++) {
    if (text[i] === "\\") {
      i++;
      continue;
    }
    if (text[i] !== "$") continue;
    const end = inlineMathEnd(text, i);
    if (end < 0 || end > to) continue;
    spans.push([i, end]);
    i = end - 1;
  }
  return spans;
}
/** Extra sentence ends inside one v1 sentence [from, to), as string indices. */
function extraCuts(text: string, from: number, to: number): number[] {
  // Display math is a sentence of its own (v1).
  if (text.startsWith("$$", from)) return [];
  const spans = mathSpans(text, from, to);
  const inMath = (k: number) => spans.some(([a, b]) => k > a && k < b);
  const formulaAt = (k: number) => spans.some(([a]) => a === k);
  const cuts: number[] = [];
  for (let k = from; k < to; k++) {
    if (text[k] !== "." || inMath(k)) continue;
    const head = text.slice(Math.max(from, k - 60), k);
    if (
      !BEFORE_PERIOD.test(text[k - 1] ?? "") ||
      INITIAL.test(head) ||
      abbreviationBefore(text, k) ||
      URLISH.test(head)
    )
      continue;
    let after = k + 1;
    while (after < to && SPACE.test(text[after]!)) after++;
    const spaced = after > k + 1;
    const at = spaced ? after : k + 1;
    const rest = text.slice(at, to);
    const cite =
      CITE_MATH.exec(rest) ?? (spaced ? null : CITE_BRACKET.exec(rest));
    if (cite) {
      // The citation belongs to the sentence before it.
      const cut = at + cite[0].length;
      let next = cut;
      while (next < to && SPACE.test(text[next]!)) next++;
      if (next > cut && next < to && AFTER_CITATION.test(text[next]!)) {
        cuts.push(cut);
        k = cut - 1;
      }
      continue;
    }
    if (spaced && after < to && formulaAt(after)) cuts.push(k + 1);
  }
  return cuts;
}

/**
 * Split one segment's text into sentences. Ends are `。！？` always and
 * `! ?` before whitespace or the end; a period ends a sentence only before
 * whitespace and an upper-case letter, a digit or a quote, or at the end of
 * the text, and never after a listed abbreviation, inside a number or inside
 * an ellipsis. Closing quotes and brackets join the sentence before them.
 * Semicolons, colons and line breaks never split. Inline math belongs to its
 * sentence; display math (`$$…$$`) is a sentence of its own. With `whole`
 * (a heading, a caption, a table title, a display formula) the text is one
 * sentence. Whitespace between sentences belongs to neither. v2 then cuts
 * after a citation that follows a period and before a formula that opens a
 * sentence (see `extraCuts`).
 */
export function splitSentences(
  text: string,
  options: { readonly whole?: boolean } = {},
): SentenceRange[] {
  const out: SentenceRange[] = [];
  const push = (from: number, to: number) => {
    while (from < to && SPACE.test(text[from]!)) from++;
    while (to > from && SPACE.test(text[to - 1]!)) to--;
    if (to > from) out.push({ start: from, end: to });
  };
  if (options.whole) {
    push(0, text.length);
    return out;
  }
  const absorb = (at: number, ends: ReadonlySet<string>) => {
    while (at < text.length && (ends.has(text[at]!) || CLOSERS.has(text[at]!)))
      at++;
    return at;
  };
  let start = 0,
    i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "$" && text[i + 1] === "$") {
      const close = text.indexOf("$$", i + 2);
      if (close >= 0) {
        push(start, i);
        push(i, close + 2);
        start = i = close + 2;
        continue;
      }
    } else if (ch === "$") {
      const end = inlineMathEnd(text, i);
      if (end > 0) {
        i = end;
        continue;
      }
    } else if (CJK_END.has(ch)) {
      const end = absorb(i + 1, new Set([...CJK_END, ...LATIN_END]));
      push(start, end);
      start = i = end;
      continue;
    } else if (LATIN_END.has(ch)) {
      const end = absorb(i + 1, LATIN_END);
      if (end === text.length || SPACE.test(text[end]!)) {
        push(start, end);
        start = i = end;
        continue;
      }
      i = end;
      continue;
    } else if (ch === ".") {
      // Inside an ellipsis nothing splits; its last dot is read as a period.
      let run = i;
      while (text[run] === ".") run++;
      if (run - i === 1 && abbreviationBefore(text, i)) {
        i = run;
        continue;
      }
      const end = absorb(run, new Set());
      let next = end;
      while (next < text.length && SPACE.test(text[next]!)) next++;
      if (
        end === text.length ||
        next === text.length ||
        (next > end &&
          (NEXT_SENTENCE.test(text[next]!) || OPENING_QUOTES.has(text[next]!)))
      ) {
        push(start, end);
        start = i = end;
        continue;
      }
      i = run;
      continue;
    }
    i++;
  }
  push(start, text.length);
  // v2: citations after a period and formulas opening a sentence.
  return out.flatMap((r) => {
    const cuts = extraCuts(text, r.start, r.end);
    if (!cuts.length) return [r];
    const pieces: SentenceRange[] = [];
    let from = r.start;
    for (const cut of [...cuts, r.end]) {
      let a = from,
        b = cut;
      while (a < b && SPACE.test(text[a]!)) a++;
      while (b > a && SPACE.test(text[b - 1]!)) b--;
      if (b > a) pieces.push({ start: a, end: b });
      from = cut;
    }
    return pieces;
  });
}

/** UTF-8 byte offset of a JavaScript string index. */
export function utf8Offset(text: string, index: number): number {
  let bytes = 0;
  for (let i = 0; i < index; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < index) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/** Sentences as half-open UTF-8 byte ranges relative to the text's first byte. */
export function splitSentencesUtf8(
  text: string,
  options: { readonly whole?: boolean } = {},
): { readonly start_utf8: number; readonly end_utf8: number }[] {
  return splitSentences(text, options).map((s) => ({
    start_utf8: utf8Offset(text, s.start),
    end_utf8: utf8Offset(text, s.end),
  }));
}

/**
 * The 1-based numbers of the sentences a UTF-8 range touches; a range that
 * starts inside a sentence counts that sentence (spec 3.5).
 */
export function sentenceNumbers(
  sentences: readonly {
    readonly start_utf8: number;
    readonly end_utf8: number;
  }[],
  start_utf8: number,
  end_utf8: number,
): number[] {
  const numbers: number[] = [];
  sentences.forEach((s, i) => {
    if (s.end_utf8 > start_utf8 && s.start_utf8 < end_utf8) numbers.push(i + 1);
  });
  return numbers;
}
