/**
 * Key-term matching `key-term-match-v1` (document spec 10.7): where a key
 * term is marked in a point, a digest item, an evidence sentence or the full
 * text. Computed when shown, never stored; one implementation for the server
 * and the Web reader.
 *
 * Latin and other cased or alphabetic scripts: case-insensitive, from the
 * start of a word, and the word may end with one more `s` or `es`; a match
 * never starts or ends inside a word. Chinese, Japanese and Korean characters
 * match character by character, with no word boundary.
 */
export const KEY_TERM_MATCH_RULE = "key-term-match-v1" as const;

export interface KeyTermRange {
  /** Half-open JavaScript string indices. */
  readonly start: number;
  readonly end: number;
}
const CJK =
  "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}";
const CJK_CHAR = new RegExp(`[${CJK}]`, "u");
const WORD_CHAR = /[\p{L}\p{N}]/u;
/** A letter or digit of a script with word boundaries, i.e. not CJK. */
const BOUNDED = `(?:(?![${CJK}])[\\p{L}\\p{N}])`;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&");

function pattern(term: string): RegExp | null {
  const t = term.trim();
  if (!t) return null;
  const chars = [...t];
  const first = chars[0]!,
    last = chars.at(-1)!;
  const bounded = (c: string) => WORD_CHAR.test(c) && !CJK_CHAR.test(c);
  const head = bounded(first) ? `(?<!${BOUNDED})` : "";
  const plural = /\p{L}/u.test(last) && bounded(last) ? "(?:es|s)?" : "";
  const tail = bounded(last) ? `(?!${BOUNDED})` : "";
  return new RegExp(`${head}${escape(t)}${plural}${tail}`, "giu");
}

/** Every place a key term matches in a text, in order. */
export function matchKeyTerm(text: string, term: string): KeyTermRange[] {
  const re = pattern(term);
  if (!re) return [];
  const out: KeyTermRange[] = [];
  for (const m of text.matchAll(re))
    if (m[0].length) out.push({ start: m.index, end: m.index + m[0].length });
  return out;
}

/**
 * The marks of several terms in one text: sorted and never overlapping; on
 * an overlap the earlier term in the list wins, then the earlier position.
 */
export function markKeyTerms(
  text: string,
  terms: readonly string[],
): (KeyTermRange & { readonly term: number })[] {
  const taken: (KeyTermRange & { term: number })[] = [];
  terms.forEach((term, index) => {
    for (const r of matchKeyTerm(text, term))
      if (!taken.some((t) => t.start < r.end && r.start < t.end))
        taken.push({ ...r, term: index });
  });
  return taken.sort((a, b) => a.start - b.start);
}
