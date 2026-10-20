import { MAX_DOCUMENT_STRUCTURE_BYTES } from "./builder.js";
import {
  canonicalJsonBytes,
  parseProofreadVersion,
  parseProofreadBlocksV1,
  sha256,
  type ProofreadVersion,
  type RawBlockType,
} from "@sciretriever/contracts";
import {
  parseDocumentStructureV2,
  type DocumentStructureV2,
  type ProofreadSegmentKind,
} from "@sciretriever/contracts";
import { renderBlocks } from "../proofread/render.js";
export const PROOFREAD_DOCUMENT_BUILDER_VERSION = "proofread-blocks-v1";
const kinds: Partial<Record<RawBlockType, ProofreadSegmentKind>> = {
  title: "heading",
  text: "text",
  list: "list",
  table: "table",
  equation: "equation",
  image: "image",
  caption: "caption",
  footnote: "footnote",
  reference: "reference-item",
  aside: "text",
};
/** Build one readable segment per corrected block; it cannot consume ParserResult or failed proofreading. */
export async function buildProofreadStructure(
  value: ProofreadVersion,
  blockBytes: Uint8Array,
  markdown: Uint8Array,
) {
  const v = await parseProofreadVersion(value);
  if (v.status !== "complete") throw new Error("proofread-document-incomplete");
  if (
    blockBytes.length !== v.blocks.byte_size ||
    (await sha256(blockBytes)) !== v.blocks.sha256 ||
    markdown.length !== v.markdown.byte_size ||
    (await sha256(markdown)) !== v.markdown.sha256
  )
    throw new Error("proofread-document-integrity");
  const blocks = parseProofreadBlocksV1(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(blockBytes)),
    v.resources.map((r) => r.reference),
  );
  const rendered = renderBlocks(blocks.blocks, v.resources);
  if (!Buffer.from(rendered.markdown).equals(Buffer.from(markdown)))
    throw new Error("proofread-document-integrity");
  const sections: {
    section_id: string;
    title: string;
    level: number;
    start_utf8: number;
    end_utf8: number;
    role: null;
    role_source: null;
  }[] = [];
  const segments: DocumentStructureV2["segments"][number][] = [];
  const stack: typeof sections = [];
  for (let i = 0; i < blocks.blocks.length; i++) {
    const block = blocks.blocks[i]!,
      range = rendered.ranges[i]!,
      kind = kinds[block.type];
    if (!kind) throw new Error("proofread-document-block-type");
    if (block.type === "title") {
      while (stack.length && stack.at(-1)!.level >= block.title_level!)
        stack.pop()!.end_utf8 = range.start_utf8;
      const section = {
        section_id: `s${sections.length + 1}`,
        title: block.text,
        level: block.title_level!,
        start_utf8: range.start_utf8,
        end_utf8: markdown.length,
        role: null,
        role_source: null,
      };
      sections.push(section);
      stack.push(section);
    }
    segments.push({
      segment_id: block.block_id,
      block_id: block.block_id,
      kind,
      section_id: stack.at(-1)?.section_id ?? null,
      start_utf8: range.start_utf8,
      end_utf8: range.end_utf8,
      page: block.page,
      region: block.region,
      continuation_regions: block.continuation_regions,
      locate: block.locate,
      source: block.text_source,
      basis: block.basis,
      uncertainty: block.uncertainty,
    });
  }
  const structure = parseDocumentStructureV2(
    {
      schema_version: 2,
      text_encoding: "utf8",
      page_count: blocks.page_count,
      sections,
      segments,
    },
    markdown.length,
  );
  const bytes = canonicalJsonBytes(structure);
  if (bytes.byteLength > MAX_DOCUMENT_STRUCTURE_BYTES)
    throw new Error("proofread-document-structure-limit");
  return { structure, bytes, sha256: await sha256(bytes) };
}
