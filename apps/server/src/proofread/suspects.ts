import type {
  ProofreadBlock,
  ProofreadSuspect,
  ProofreadSuspectKind,
} from "@sciretriever/contracts";
import type { PdfPageInspection } from "../browser/pdf-region.js";
import { semanticTokens, normalizeForComparison } from "./normalize.js";
import { proofreadId, type DraftBlock, type RemovedText } from "./contract.js";
export const SUSPECTS_VERSION = "text-layer-multiset-v2";
export function textTokens(text: string): string[] {
  return [
    ...semanticTokens(
      normalizeForComparison(text)
        .replace(/<[^>]+>/gu, " ")
        .replace(/!\[[^\]]*\]\([^)]*\)/gu, " ")
        .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
        .replace(/&(?:amp|lt|gt|quot|apos);/gu, " "),
    ).sequence,
  ].filter((t) => /[\p{L}\p{N}%‰°_^]/u.test(t));
}
function difference(left: readonly string[], right: readonly string[]) {
  const counts = new Map<string, number>();
  for (const t of right) counts.set(t, (counts.get(t) ?? 0) + 1);
  return left.flatMap((token, index) => {
    const n = counts.get(token) ?? 0;
    if (n) {
      counts.set(token, n - 1);
      return [];
    }
    return [{ token, index }];
  });
}
function groups(values: readonly { token: string; index: number }[]) {
  const result: { token: string; index: number }[][] = [];
  for (const v of values) {
    const last = result.at(-1);
    if (last && last.at(-1)!.index + 1 === v.index) last.push(v);
    else result.push([v]);
  }
  return result;
}
function pageText(
  block: Pick<ProofreadBlock, "block_id" | "page" | "text" | "html">,
  page: number,
  drafts: readonly DraftBlock[],
) {
  const original = drafts.find((d) => d.block_id === block.block_id);
  if (
    original &&
    original.text === block.text &&
    original.html === block.html &&
    original.page === block.page
  )
    return original.page_text
      .filter((p) => p.page === page)
      .map((p) => p.text)
      .join(" ");
  return block.page === page ? (block.html ?? block.text) : "";
}
/** Word/number multiset comparison identifies questions, never a readiness score. */
export function findSuspects(
  pages: readonly PdfPageInspection[],
  blocks: readonly Pick<
    ProofreadBlock,
    "block_id" | "page" | "text" | "html"
  >[],
  removed: readonly RemovedText[],
  drafts: readonly DraftBlock[] = [],
) {
  const output: ProofreadSuspect[] = [];
  const byPage = pages.map((page) =>
    blocks.flatMap((block) =>
      textTokens(pageText(block, page.page, drafts)).map((token) => ({
        token,
        block_id: block.block_id,
      })),
    ),
  );
  const locations = new Map<string, Set<string>>();
  // A misplaced candidate must be excess on the other page. Merely occurring
  // elsewhere (common words, repeated units) is not evidence of a page error.
  for (const page of pages) {
    if (page.kind !== "text-layer") continue;
    const entries = byPage[page.page]!;
    for (const extra of difference(
      entries.map((e) => e.token),
      textTokens(page.text),
    )) {
      const id = entries[extra.index]!.block_id;
      const ids = locations.get(extra.token) ?? new Set<string>();
      ids.add(id);
      locations.set(extra.token, ids);
    }
  }
  const blockPages = new Map(blocks.map((b) => [b.block_id, b.page]));
  for (const page of pages) {
    if (page.kind !== "text-layer") continue;
    const source = textTokens(page.text),
      entries = byPage[page.page]!,
      current = entries.map((e) => e.token),
      classified = removed
        .filter((r) => r.page === page.page)
        .flatMap((r) => textTokens(r.text));
    const missing = difference(source, [...current, ...classified]),
      extra = difference(current, source);
    const pageIds = [...new Set(entries.map((e) => e.block_id))];
    const own = pageIds.length === 1 ? pageIds : [];
    const add = (
      kind: ProofreadSuspectKind,
      values: readonly { token: string; index: number }[],
      sourceSide: boolean,
      idsFor: (token: string, index: number) => readonly string[],
    ) => {
      for (const group of groups(values)) {
        const ids = [
          ...new Set(group.flatMap((v) => idsFor(v.token, v.index))),
        ];
        const first = group[0]!;
        // Approximate character location is only a visual hint. Token position also
        // distinguishes repeated missing words without imposing reading order.
        const tokenOffset = sourceSide ? first.index : 0;
        const normalizedPrefix = source.slice(0, tokenOffset).join(" ");
        const body = {
          page: page.page,
          kind,
          tokens: group.map((v) => v.token),
          block_ids: ids,
          text_offset: Math.min(page.text.length, normalizedPrefix.length),
        };
        output.push({
          ...body,
          suspect_id: proofreadId([SUSPECTS_VERSION, body, first.index]),
          disposition: null,
        });
      }
    };
    const elsewhere = (token: string) =>
      [...(locations.get(token) ?? [])].filter(
        (id) => blockPages.get(id) !== page.page,
      );
    const misplaced = missing.filter((v) => elsewhere(v.token).length);
    add("page-misplaced", misplaced, true, (token) => elsewhere(token));
    add(
      "missing",
      missing.filter((v) => !elsewhere(v.token).length),
      true,
      () => own,
    );
    add("extra", extra, false, (_token, index) => [entries[index]!.block_id]);
    const scientific = (token: string) =>
      /[\d%‰°_^]/u.test(token) || /^(?:[A-Z][a-z]?){1,}$/u.test(token);
    add(
      "token-mismatch",
      missing.filter((v) => scientific(v.token)),
      true,
      () => own,
    );
    add(
      "token-mismatch",
      extra.filter((v) => scientific(v.token)),
      false,
      (_token, index) => [entries[index]!.block_id],
    );
    for (const b of blocks.filter((b) => b.page === page.page)) {
      const defects = [
        ...(b.html ?? b.text).matchAll(/[\uFFFD\p{Co}\p{Cc}]/gu),
      ];
      add(
        "extra",
        defects
          .filter((m) => !["\t", "\r", "\n"].includes(m[0]))
          .map((m) => ({
            token: `U+${m[0].codePointAt(0)!.toString(16).toUpperCase()}`,
            index: m.index,
          })),
        false,
        () => [b.block_id],
      );
    }
  }
  return output;
}
