import { randomUUID } from "node:crypto";
import {
  canonicalJsonBytes,
  parseProofreadBlocksV1,
  parseProofreadEdit,
  parseAssetId,
  type ProofreadBlock,
  type ProofreadBlocksV1,
  type ProofreadEditRecord,
} from "@sciretriever/contracts";
import { markdownDraft } from "./markdown-draft.js";
import { renderBlocks } from "./render.js";

export interface ManualDocument {
  readonly blocks: ProofreadBlocksV1;
  readonly edits: readonly ProofreadEditRecord[];
  readonly changed_ids: readonly string[];
}
export function parseManualDocument(
  text: string,
  resources: readonly string[],
): ManualDocument {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("proofread-manual-invalid");
  const r = value as Record<string, unknown>;
  if (
    Object.keys(r).sort().join() !== "blocks,changed_ids,edits" ||
    !Array.isArray(r.edits) ||
    !Array.isArray(r.changed_ids) ||
    r.changed_ids.some((id) => typeof id !== "string")
  )
    throw new Error("proofread-manual-invalid");
  const blocks = parseProofreadBlocksV1(r.blocks, resources);
  return {
    blocks,
    edits: r.edits.map((value) => {
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).sort().join() !== "edit,edit_id"
      )
        throw new Error("proofread-manual-invalid");
      const item = value as Record<string, unknown>;
      return {
        edit_id: String(parseAssetId(item.edit_id)),
        edit: parseProofreadEdit(item.edit, blocks.page_count, resources),
      };
    }),
    changed_ids: r.changed_ids.map((id) => String(parseAssetId(id))),
  };
}

/** Exact unchanged runs retain identity and provenance. Edited gaps are parsed as Markdown. */
export function editDocument(
  old: ProofreadBlocksV1,
  markdown: string,
  resources: Parameters<typeof renderBlocks>[1],
  pageStarts?: readonly number[],
) {
  if (Buffer.byteLength(markdown) > 8 * 1024 * 1024 || markdown.includes("\0"))
    throw new Error("proofread-edit-invalid");
  const rendered = renderBlocks(old.blocks, resources),
    original = new TextDecoder().decode(rendered.markdown);
  if (
    pageStarts &&
    (pageStarts.length !== old.page_count ||
      pageStarts[0] !== 0 ||
      pageStarts.some(
        (n, i) =>
          !Number.isSafeInteger(n) ||
          n < 0 ||
          n > markdown.length ||
          (i > 0 && n < pageStarts[i - 1]!),
      ))
  )
    throw new Error("proofread-edit-pages-invalid");
  const next: ProofreadBlock[] = [],
    changed = new Set<string>(),
    edits: ProofreadEditRecord[] = [];
  let cursor = 0,
    oldCursor = 0;
  const pageAt = (position: number, fallback: number) =>
    pageStarts
      ? Math.max(0, pageStarts.filter((n) => n <= position).length - 1)
      : fallback;
  if (
    markdown === original &&
    (!pageStarts ||
      rendered.ranges.every(
        (r, i) =>
          pageAt(
            Buffer.from(original).subarray(0, r.start_utf8).toString("utf8")
              .length,
            old.blocks[i]!.page,
          ) === old.blocks[i]!.page,
      ))
  )
    return { blocks: old, changed: [], edits: [] as ProofreadEditRecord[] };
  const gap = (end: number, oldEnd: number) => {
    const removed = old.blocks.slice(oldCursor, oldEnd),
      text = markdown.slice(cursor, end);
    const boundaries = [
      cursor,
      ...new Set((pageStarts ?? []).filter((n) => n > cursor && n < end)),
      end,
    ];
    const candidates = boundaries
      .slice(0, -1)
      .flatMap((from, i) =>
        markdownDraft(markdown.slice(from, boundaries[i + 1])).map(
          (candidate) => ({ candidate, from }),
        ),
      );
    if (!candidates.length && !removed.length) return;
    const fallback =
      removed[0]?.page ?? next.at(-1)?.page ?? old.blocks[oldEnd]?.page ?? 0;
    const replacing = removed.length === 1 && candidates.length === 1;
    for (const block of removed) {
      changed.add(block.block_id);
      if (!replacing)
        edits.push({
          edit_id: randomUUID(),
          edit: {
            kind: "delete",
            block_id: block.block_id,
            basis_page: block.page,
            reason: "manual-document-edit",
          },
        });
    }
    let local = 0;
    for (const { candidate, from } of candidates) {
      const canonical = candidate.html ?? candidate.text;
      const position = text.indexOf(canonical, local);
      if (position >= 0) local = position;
      const base = replacing ? removed[0]! : null;
      const block: ProofreadBlock = {
        block_id: base?.block_id ?? randomUUID(),
        page: pageAt(
          pageStarts ? from : cursor + local,
          base?.page ?? fallback,
        ),
        region: base?.region ?? null,
        continuation_regions: base?.continuation_regions ?? [],
        locate: base?.locate ?? "page",
        type: candidate.type,
        title_level: candidate.title_level,
        text: candidate.text,
        html: candidate.html,
        image_ref: candidate.image_ref,
        text_source: "manual",
        basis: "manual",

        raw_ref: base?.raw_ref ?? [
          ...new Map(
            removed
              .flatMap((b) => b.raw_ref)
              .map((ref) => [`${ref[0]}:${ref[1]}`, ref]),
          ).values(),
        ],
        edit_refs: base?.edit_refs ?? [],
      };
      changed.add(block.block_id);
      edits.push({
        edit_id: randomUUID(),
        edit: replacing
          ? {
              kind: "replace",
              block_id: block.block_id,
              text: block.html ?? block.text,
              basis_page: block.page,
              reason: "manual-document-edit",
            }
          : {
              kind: "insert_after",
              after_block_id: next.at(-1)?.block_id ?? null,
              block: {
                page: block.page,
                region: block.region,
                type: block.type,
                title_level: block.title_level,
                text: block.text,
                html: block.html,
                image_ref: block.image_ref,
              },
              basis_page: block.page,
              reason: "manual-document-edit",
            },
      });
      next.push(block);
      local += canonical.length;
    }
  };
  for (let i = 0; i < old.blocks.length; i++) {
    const block = old.blocks[i]!,
      needle = new TextDecoder()
        .decode(renderBlocks([block], resources).markdown)
        .trimEnd();
    let found = markdown.indexOf(needle, cursor);
    while (
      found >= 0 &&
      ((found > 0 && markdown[found - 1] !== "\n") ||
        (found + needle.length < markdown.length &&
          markdown[found + needle.length] !== "\n"))
    )
      found = markdown.indexOf(needle, found + 1);
    if (found < 0 || pageAt(found, block.page) !== block.page) continue;
    gap(found, i);
    next.push(block);
    cursor = found + needle.length;
    while (markdown[cursor] === "\n") cursor++;
    oldCursor = i + 1;
  }
  gap(markdown.length, old.blocks.length);
  const blocks = parseProofreadBlocksV1(
    { schema_version: 1, page_count: old.page_count, blocks: next },
    resources.map((r) => r.reference),
  );
  renderBlocks(blocks.blocks, resources);
  return { blocks, changed: [...changed], edits };
}

export const encodeManualDocument = (value: ManualDocument) =>
  new TextDecoder().decode(canonicalJsonBytes(value));
