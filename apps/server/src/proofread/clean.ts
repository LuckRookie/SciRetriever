import type { RawBlocksV1 } from "@sciretriever/contracts";
import type { DraftCandidate, RemovedText } from "./contract.js";
export const CLEAN_RULES_VERSION = "clean-v3";
// Sentence boundaries are explicit. Commas, colons and semicolons are not sentence endings.
export const SENTENCE_ENDINGS = /[.!?。！？][\s"'’”）)\]]*$/u;
const NUMBERED_START =
  /^(?:\[?\d+(?:\.\d+)*\]?[.)、]?\s|[IVXLCDM]+[.)]\s|[A-Za-z][.)]\s|[一二三四五六七八九十]+[、.])/u;
const BULLET_START = /^(?:[•●▪◦‣⁃]|[-*+]\s|[–—]\s)/u;
const REMOVED = new Set(["header", "footer", "page-number", "discarded"]);
export function hasKnownTextDefect(value: string): boolean {
  return /[\p{Co}\p{Cc}]/u.test(value.replace(/[\n\r\t]/gu, ""));
}
export function cleanRawBlocks(input: RawBlocksV1) {
  const result: DraftCandidate[] = [];
  const removed: RemovedText[] = [];
  let referenceLevel: number | null = null;
  for (const raw of input.blocks) {
    if (REMOVED.has(raw.type)) {
      removed.push({
        page: raw.page,
        type: raw.type,
        text: raw.text,
        raw_ref: [raw.page, raw.index],
      });
      continue;
    }
    if (raw.type === "title") {
      if (
        /^(?:\d+[.\s]*)?(?:references|bibliography|参考文献)[:：]?$/iu.test(
          raw.text.trim(),
        )
      )
        referenceLevel = raw.title_level;
      else if (referenceLevel !== null && raw.title_level! <= referenceLevel)
        referenceLevel = null;
    }
    const next: DraftCandidate = {
      page: raw.page,
      region: raw.bbox,
      locate: raw.bbox ? "region" : "page",
      text_source: "parser",
      page_text: [{ page: raw.page, text: raw.html ?? raw.text }],
      continuation_regions: [],
      type:
        ["text", "list"].includes(raw.type) && referenceLevel !== null
          ? "reference"
          : raw.type === "text" && BULLET_START.test(raw.text.trimStart())
            ? "list"
            : raw.type,
      title_level: raw.title_level,
      text: raw.text,
      html: raw.html,
      image_ref: raw.image_ref,
      raw_ref: [[raw.page, raw.index]],
      known_defect:
        hasKnownTextDefect(raw.text) || hasKnownTextDefect(raw.html ?? ""),
    };
    const previous = result.at(-1);
    if (
      previous?.type === "text" &&
      next.type === "text" &&
      previous.text.trim() &&
      next.text.trim() &&
      !previous.html &&
      !next.html &&
      !previous.image_ref &&
      !next.image_ref &&
      !SENTENCE_ENDINGS.test(previous.text.trimEnd()) &&
      !NUMBERED_START.test(next.text.trimStart())
    ) {
      const a = previous.text.trimEnd(),
        b = next.text.trimStart();
      const text =
        /-$/u.test(a) && /^[a-z]/u.test(b) ? a.slice(0, -1) + b : `${a} ${b}`;
      result[result.length - 1] = {
        ...previous,
        text,
        text_source: "rule",
        page_text: [...previous.page_text, ...next.page_text],
        raw_ref: [...previous.raw_ref, ...next.raw_ref],
        known_defect: previous.known_defect || next.known_defect,
        continuation_regions: [
          ...previous.continuation_regions,
          ...(next.region ? [{ page: next.page, region: next.region }] : []),
          ...next.continuation_regions,
        ],
      };
    } else result.push(next);
  }
  return { blocks: result, removed };
}
