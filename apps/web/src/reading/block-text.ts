/** What the full text adds beside the author's words in a translated reading. */
export const ADDED =
  ".reading-translation, .reading-untranslated, .reading-translation-marks";
/**
 * Everything the reader puts inside a block that is not the author's words:
 * the translation, the source control every checked segment carries (hidden
 * unless sources are shown), doubts, MathML and margin notes set below.
 */
const NOT_THE_TEXT = `${ADDED}, .reading-block-source, .reading-doubt, .katex-mathml, .reading-margin-note-below`;
/**
 * A block's own text, as the author wrote it (reading-experience 9: a
 * quotation is always of the original): without its translation and the
 * signs a reading puts beside it. A caption read this way starts with its
 * own “Fig. 8”, which names the figure on the layers.
 */
export function blockSourceText(block: HTMLElement, rendered = true): string {
  if (!block.querySelector(NOT_THE_TEXT))
    return (
      (rendered ? block.innerText : "") ||
      block.textContent ||
      ""
    ).trim();
  const copy = block.cloneNode(true) as HTMLElement;
  for (const el of copy.querySelectorAll(NOT_THE_TEXT)) el.remove();
  return (copy.textContent ?? "").replace(/\s+/gu, " ").trim();
}
