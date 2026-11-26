/**
 * Where a key term is in a text: rule `key-term-match-v1` (technical 04
 * §10.7, last item). Latin script ignores case and matches from a word's
 * start; the word may end in one more `s` or `es`. Chinese, Japanese and
 * Korean match character for character.
 *
 * 待换成 contracts 的实现: the rule has one implementation, in the contracts
 * package, shared by the service and the page; until the backend's is merged
 * the page uses this one, which is to follow it exactly.
 */
export const KEY_TERM_RULE = "key-term-match-v1";
const CJK =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const WORD = /[\p{L}\p{N}]/u;
/** A match: UTF-16 offsets in `text`, half-open, and which term it is. */
export interface KeyMatch {
  readonly start: number;
  readonly end: number;
  readonly term: number;
}
const wordAt = (text: string, at: number) =>
  at >= 0 && at < text.length && WORD.test(text[at]!);
/**
 * Every place of each term in `text`, in text order; where two overlap, the
 * earlier (then the longer) wins.
 */
export function matchKeyTerms(
  text: string,
  terms: readonly string[],
): KeyMatch[] {
  const found: KeyMatch[] = [];
  const lower = text.toLowerCase();
  terms.forEach((term, index) => {
    if (!term) return;
    if (CJK.test(term)) {
      for (
        let at = text.indexOf(term);
        at >= 0;
        at = text.indexOf(term, at + 1)
      )
        found.push({ start: at, end: at + term.length, term: index });
      return;
    }
    const needle = term.toLowerCase();
    for (
      let at = lower.indexOf(needle);
      at >= 0;
      at = lower.indexOf(needle, at + 1)
    ) {
      // From a word's start only.
      if (wordAt(text, at - 1) && WORD.test(needle[0]!)) continue;
      let end = at + needle.length;
      if (WORD.test(needle[needle.length - 1]!) && wordAt(text, end)) {
        // One more `s` or `es` ends the word; anything else is another word.
        if (lower.startsWith("es", end) && !wordAt(text, end + 2)) end += 2;
        else if (lower[end] === "s" && !wordAt(text, end + 1)) end += 1;
        else continue;
      }
      found.push({ start: at, end, term: index });
    }
  });
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: KeyMatch[] = [];
  for (const m of found)
    if (!out.length || m.start >= out[out.length - 1]!.end) out.push(m);
  return out;
}
