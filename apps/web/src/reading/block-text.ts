/** What the full text adds beside the author's words in a translated reading. */
export const ADDED =
  ".reading-translation, .reading-untranslated, .reading-translation-marks";
/**
 * A block's own text, as the author wrote it (reading-experience 9: a
 * quotation is always of the original): without its translation and the
 * signs a reading puts beside it.
 */
export function blockSourceText(block: HTMLElement, rendered = true): string {
  if (!block.querySelector(ADDED))
    return (
      (rendered ? block.innerText : "") ||
      block.textContent ||
      ""
    ).trim();
  const copy = block.cloneNode(true) as HTMLElement;
  for (const el of copy.querySelectorAll(
    `${ADDED}, .reading-block-source, .reading-doubt, .katex-mathml, .reading-margin-note-below`,
  ))
    el.remove();
  return (copy.textContent ?? "").replace(/\s+/gu, " ").trim();
}
