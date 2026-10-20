import {
  canonicalJsonBytes,
  parseProofreadBlocksV1,
  type Sha256,
  parseRawBlocksV1,
  parseRawParse,
  sha256,
  type RawParse,
} from "@sciretriever/contracts";
import type { PdfPageInspection } from "../browser/pdf-region.js";
import { cleanRawBlocks } from "./clean.js";
import { markdownDraft } from "./markdown-draft.js";
import { proofreadId, type DraftBlock, type RemovedText } from "./contract.js";
import { textTokens } from "./suspects.js";
export interface ProofreadInputReader {
  readArtifact(
    id: string,
    kind: "blocks" | "markdown" | "image",
    reference?: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
}
/** Legacy paragraphs must have one monotone page assignment; no similarity threshold. */
export function locateMarkdown(
  markdown: string,
  pages: readonly PdfPageInspection[],
) {
  const drafts = markdownDraft(markdown),
    pageTokens = pages.map((p) => new Set(textTokens(p.text)));
  let previous = 0;
  return drafts.map((d) => {
    const tokens = textTokens(d.html ?? d.text);
    if (!tokens.length) throw new Error("proofread-needs-parse");
    const candidates = pages.filter(
      (p, i) =>
        p.kind === "text-layer" &&
        i >= previous &&
        tokens.every((t) => pageTokens[i]!.has(t)),
    );
    if (candidates.length !== 1) throw new Error("proofread-needs-parse");
    const page = candidates[0]!.page;
    previous = page;
    return {
      ...d,
      page,
      raw_ref: d.raw_ref.map(([, index]) => [page, index] as const),
      page_text: [{ page, text: d.html ?? d.text }],
    };
  });
}
export async function prepareDraft(
  rawValue: RawParse,
  reader: ProofreadInputReader,
  pages: readonly PdfPageInspection[],
  signal?: AbortSignal,
) {
  const raw = await parseRawParse(rawValue);
  signal?.throwIfAborted();
  if (raw.page_count !== pages.length)
    throw new Error("proofread-input-mismatch");
  const expected = raw.blocks ?? raw.markdown;
  if (expected.byte_size > 32 * 1024 * 1024)
    throw new Error("proofread-input-limit");
  const bytes = await reader.readArtifact(
    raw.raw_parse_id,
    raw.blocks ? "blocks" : "markdown",
    "",
    signal,
  );
  if (
    bytes.length !== expected.byte_size ||
    (await sha256(bytes)) !== expected.sha256
  )
    throw new Error("proofread-input-integrity");
  const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const cleaned = raw.blocks
    ? cleanRawBlocks(
        parseRawBlocksV1(
          JSON.parse(value),
          raw.resources.map((r) => r.reference),
        ),
      )
    : { blocks: locateMarkdown(value, pages), removed: [] as RemovedText[] };
  const drafts: DraftBlock[] = await Promise.all(
    cleaned.blocks.map(async (d) => ({
      ...d,
      block_id: proofreadId(["draft-block-v2", raw.source_asset_id, d.raw_ref]),
      draft_sha256: await sha256(canonicalJsonBytes(d)),
    })),
  );
  return { raw, drafts, removed: cleaned.removed };
}

/** Persisted draft is a single parser source, not a mutable editor buffer. */
export async function parseStoredDraft(
  value: unknown,
  pageCount: number,
  resources: readonly string[],
): Promise<DraftBlock> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("proofread-draft-integrity");
  const r = value as Record<string, unknown>,
    { block_id, draft_sha256, ...candidate } = r;
  if (
    typeof candidate.known_defect !== "boolean" ||
    !Array.isArray(candidate.page_text)
  )
    throw new Error("proofread-draft-integrity");
  const { known_defect, page_text, ...fields } = candidate;
  const block = parseProofreadBlocksV1(
    {
      schema_version: 1,
      page_count: pageCount,
      blocks: [
        {
          ...fields,
          block_id,
          basis: "text-layer",
          uncertainty: null,
          edit_refs: [],
        },
      ],
    },
    resources,
  ).blocks[0]!;
  if (block.text_source !== "parser" && block.text_source !== "rule")
    throw new Error("proofread-draft-integrity");
  const parts = page_text.map((value: unknown) => {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).sort().join() !== "page,text"
    )
      throw new Error("proofread-draft-integrity");
    const p = value as Record<string, unknown>;
    if (
      !Number.isSafeInteger(p.page) ||
      Number(p.page) < 0 ||
      Number(p.page) >= pageCount ||
      typeof p.text !== "string"
    )
      throw new Error("proofread-draft-integrity");
    return { page: Number(p.page), text: p.text };
  });
  const {
    basis: _basis,
    uncertainty: _uncertainty,
    edit_refs: _edits,
    block_id: id,
    ...content
  } = block;
  void _basis;
  void _uncertainty;
  void _edits;
  const d = { ...content, known_defect, page_text: parts };
  if ((await sha256(canonicalJsonBytes(d))) !== draft_sha256)
    throw new Error("proofread-draft-integrity");
  return { ...d, block_id: id, draft_sha256: draft_sha256 as Sha256 };
}
