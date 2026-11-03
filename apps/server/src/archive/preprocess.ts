import type {
  ArchiveDropReason,
  ArrangementSourceBlock,
} from "@sciretriever/contracts";
export const CHROME_RULE = "page-chrome-v1";
const TYPE_REASON: Partial<
  Record<ArrangementSourceBlock["type"], ArchiveDropReason>
> = {
  header: "header",
  footer: "footer",
  "page-number": "footer",
  aside: "interface",
};
export function chromeTextKey(text: string) {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\p{N}+/gu, "#")
    .replace(/[^\p{L}#]/gu, "");
}
/** Returns decisions without mutating the immutable raw source. Restored roots are exempt. */
export function programChromeDrops(
  blocks: readonly ArrangementSourceBlock[],
  pageCount: number,
  restoredRoots: ReadonlySet<string> = new Set(),
) {
  const edge = (b: ArrangementSourceBlock) =>
    !b.region_hint
      ? null
      : b.region_hint[3] <= 90
        ? "top"
        : b.region_hint[1] >= 910
          ? "bottom"
          : null;
  const known = new Set(
    blocks
      .filter((b) => ["header", "footer", "page-number"].includes(b.type))
      .map((b) => chromeTextKey(b.text)),
  );
  const repeated = new Map<string, Set<number>>();
  for (const b of blocks) {
    const where = edge(b),
      key = chromeTextKey(b.text);
    if (
      !where ||
      b.type !== "text" ||
      (key.match(/\p{L}/gu)?.length ?? 0) < 4 ||
      b.text.trim().split(/\s+/u).length > 80
    )
      continue;
    const k = `${where}:${key}`,
      pages = repeated.get(k) ?? new Set<number>();
    pages.add(b.page_hint);
    repeated.set(k, pages);
  }
  const result = new Map<
    string,
    { reason: ArchiveDropReason; source: "program"; rule: string }
  >();
  for (const b of blocks) {
    if (restoredRoots.has(b.root_block_id)) continue;
    let reason = TYPE_REASON[b.type],
      rule = reason ? `${CHROME_RULE}/mineru-${b.type}` : null;
    const where = edge(b),
      key = chromeTextKey(b.text),
      words = b.text.trim().split(/\s+/u).length;
    if (!reason && b.type === "text" && where) {
      const count = repeated.get(`${where}:${key}`)?.size ?? 0;
      if (
        /^\s*(?:page\s*)?(?:\d{1,5}|[ivxlcdm]{1,8})(?:\s*(?:of|\/)\s*\d{1,5})?\s*$/iu.test(
          b.text,
        )
      )
        rule = `${CHROME_RULE}/edge-page-number`;
      else if (
        words <= 80 &&
        (count >= 3 || (count >= 2 && count / pageCount >= 0.3))
      )
        rule = `${CHROME_RULE}/repeated-edge`;
      else if (words <= 25 && key && known.has(key))
        rule = `${CHROME_RULE}/known-chrome`;
      if (rule) reason = where === "top" ? "header" : "footer";
    }
    if (reason && rule)
      result.set(b.root_block_id, { reason, source: "program", rule });
  }
  return result;
}

/** First-page author/date matter is rendered outside the body flow. */
export function articleInformationText(text: string) {
  return (
    !/^(?:[■*]\s*)?(?:acknowledg|associated content|conflicts?|data availability|references|funding|author contributions)/iu.test(
      text.trimStart(),
    ) &&
    /\b(?:universit\p{L}*|institut\p{L}*|department|faculty|laborator\p{L}*|correspond\p{L}*|equal(?:ly)? contribut\p{L}*|contribut\p{L}* equally|received|accepted|revised|published|present address)\b|\S+@\S+/iu.test(
      text,
    )
  );
}
