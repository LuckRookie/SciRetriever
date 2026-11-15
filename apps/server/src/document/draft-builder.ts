import { setImmediate as turn } from "node:timers/promises";
import { createHash } from "node:crypto";
import {
  canonicalJsonBytes,
  parseArtifactRef,
  parseDraftContent,
  parseDraftDocumentRef,
  parseDraftDocumentStructure,
  type ArrangementLeaf,
  type DraftBasis,
  type DraftContent,
  type DraftDifference,
  type DraftDocumentRef,
  type DraftFailureCode,
  type DraftMethod,
  type DocumentStructureV2,
  type RawParseResource,
  type Sha256,
  type RawParse,
  type DocumentMaterialRef,
  type DraftOperation,
  type ProofreadSegmentKind,
  MAX_DRAFT_CONTENT_BYTES,
  parseDocumentMaterialRef,
  ContractValidationError,
} from "@sciretriever/contracts";
import {
  byteHash,
  textHash,
  textId,
  prepareArrangementSource,
  ArchiveTextError,
} from "../archive/text-source.js";
import {
  arrangementLeafId,
  PARAGRAPH_BREAK_RULE,
} from "../archive/arrangement.js";
import { programChromeDrops, CHROME_RULE } from "../archive/preprocess.js";
import { paragraphBreakEvidenceForBody } from "../archive/paragraph-breaks.js";
import { READING_ORDER_ENABLED } from "../archive/reading-order.js";
import type { ProofreadInputReader } from "../proofread/draft.js";
import { renderLeafPayload } from "../archive/render.js";
import { headingStyleLevels } from "../archive/source-layout.js";
import { textLayerPage } from "../archive/arrangement-service.js";
import { alignReviewTokens, reviewTokens } from "../proofread/page-review.js";
import { textTokens } from "../proofread/suspects.js";
import { parserMarkdownReferences } from "../parsing/markdown-resources.js";
import { pdfPageText, type PdfPageInspection } from "../browser/pdf-region.js";
import {
  MAX_DOCUMENT_MARKDOWN_BYTES,
  MAX_DOCUMENT_STRUCTURE_BYTES,
} from "./limits.js";

export const DRAFT_BUILDER = "draft-leaves-v1";
export const DRAFT_COMPARISON = "draft-compare-v1";
export class DraftBuildError extends Error {
  constructor(
    readonly code: DraftFailureCode,
    options?: ErrorOptions,
  ) {
    super("draft document construction failed", options);
    this.name = "DraftBuildError";
  }
}
async function checkpoint(index: number, signal?: AbortSignal) {
  if (index % 64 === 0) await turn();
  if (signal?.aborted) throw new DraftBuildError("cancelled");
}
export const draftMethodHash = (method: DraftMethod): Sha256 =>
  textHash(method) as Sha256;
/** Shared by the builder and metadata-only backfill selection; no inputs are read. */
export const currentDraftMethod = (
  correctReadingOrder = READING_ORDER_ENABLED,
): DraftMethod => ({
  chrome: CHROME_RULE,
  breaks: PARAGRAPH_BREAK_RULE,
  reading_order: correctReadingOrder,
  comparison: DRAFT_COMPARISON,
  builder: DRAFT_BUILDER,
});
export const currentDraftMethodHash = (): Sha256 =>
  draftMethodHash(currentDraftMethod());
export const pageLayerHash = (pages: readonly PdfPageInspection[]): Sha256 =>
  textHash(pages.map(pdfPageText)) as Sha256;

/** HTML is removed before entity decoding; encoded printed angle brackets survive. */
export function draftComparisonText(text: string): string {
  const named: Readonly<Record<string, string>> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return text
    .replace(/<\/?[A-Za-z][^>]*>/gu, " ")
    .replace(
      /&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/giu,
      (_whole, code: string) => {
        if (!code.startsWith("#")) return named[code] ?? " ";
        const number = Number.parseInt(
          code.slice(code[1]?.toLowerCase() === "x" ? 2 : 1),
          code[1]?.toLowerCase() === "x" ? 16 : 10,
        );
        return number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff)
          ? String.fromCodePoint(number)
          : " ";
      },
    );
}
export async function compareDraftLeaves(
  leaves: readonly ArrangementLeaf[],
  pages: readonly PdfPageInspection[],
  signal?: AbortSignal,
): Promise<DraftContent["leaves"]> {
  const layers: string[][] = [],
    elsewhere: Map<string, number>[] = [];
  for (const [i, page] of pages.entries()) {
    await checkpoint(i, signal);
    layers.push(
      page.kind === "text-layer" ? reviewTokens(page.text, true) : [],
    );
    const counts = new Map<string, number>();
    if (page.kind === "text-layer")
      for (const token of textTokens(page.text))
        counts.set(token, (counts.get(token) ?? 0) + 1);
    elsewhere.push(counts);
  }
  const results: DraftContent["leaves"][number][] = [];
  for (const [i, leaf] of leaves.entries()) {
    await checkpoint(i, signal);
    const page = pages[leaf.page_index];
    if (!page) throw new DraftBuildError("source-integrity");
    let basis: DraftBasis = "no-text-layer";
    const differences: DraftDifference[] = [];
    if (page.kind === "text-layer") {
      const text = draftComparisonText(leaf.original_text),
        tokens = reviewTokens(text);
      if (tokens.length) {
        const aligned = alignReviewTokens(
          tokens,
          layers[leaf.page_index]!,
          0.3,
        );
        if (!aligned || aligned.coverage < 0.3 * tokens.length) {
          const other = textLayerPage(text, leaf.page_index, elsewhere);
          if (other !== null) {
            basis = "text-layer-differs";
            differences.push({
              leaf_id: leaf.leaf_id,
              page_index: leaf.page_index,
              kind: "elsewhere",
              parsed: tokens.join(" "),
              text_layer: "",
              other_page_index: other,
            });
          }
        } else {
          for (const difference of aligned.differences)
            differences.push({
              leaf_id: leaf.leaf_id,
              page_index: leaf.page_index,
              kind: "mismatch",
              ...difference,
              other_page_index: null,
            });
          basis = differences.length
            ? "text-layer-differs"
            : "text-layer-match";
        }
      }
    }
    results.push({
      leaf_id: leaf.leaf_id,
      page_index: leaf.page_index,
      basis,
      differences,
    });
  }
  return results;
}

async function contentLeaves(
  content: Pick<DraftContent, "raw" | "source_blocks">,
  signal?: AbortSignal,
): Promise<ArrangementLeaf[]> {
  const leaves: ArrangementLeaf[] = [];
  for (const [i, root] of content.source_blocks.entries()) {
    await checkpoint(i, signal);
    if (
      byteHash(Buffer.from(root.text)) !== root.source_sha256 ||
      textId(["archive-source-v1", content.raw.result_sha256, root.locator]) !==
        root.root_block_id
    )
      throw new DraftBuildError("source-integrity");
    const end = [...root.text].length;
    leaves.push({
      leaf_id: arrangementLeafId(
        root.root_block_id,
        0,
        end,
        content.raw.result_sha256,
      ),
      source: {
        root_block_id: root.root_block_id,
        source_sha256: root.source_sha256,
        start: 0,
        end,
      },
      type: root.type,
      original_text: root.text,
      page_index: root.page_hint,
      region: root.region_hint,
      image_ref: root.image_ref,
    });
  }
  return leaves;
}
const worstBasis = (values: readonly DraftBasis[]): DraftBasis =>
  values.includes("text-layer-differs")
    ? "text-layer-differs"
    : values.includes("no-text-layer")
      ? "no-text-layer"
      : "text-layer-match";

/** Re-render from sealed content only: no page tools, comparison or raw-block reader. */
export async function renderDraftContent(
  value: DraftContent,
  available: readonly RawParseResource[],
  signal?: AbortSignal,
) {
  await checkpoint(0, signal);
  const content = parseDraftContent(value);
  if (draftMethodHash(content.method) !== content.draft_method_sha256)
    throw new DraftBuildError("source-integrity");
  const all = await contentLeaves(content, signal),
    dropped = new Set(
      content.operations
        .filter((op) => op.kind === "drop")
        .map((op) => op.leaf_id),
    ),
    retained = all.filter((l) => !dropped.has(l.leaf_id)),
    rows = new Map(content.leaves.map((l) => [l.leaf_id, l]));
  const positions = new Map(all.map((l, i) => [l.leaf_id, i]));
  if (
    dropped.size + retained.length !== all.length ||
    content.leaves.length !== retained.length ||
    retained.some(
      (leaf, i) =>
        leaf.leaf_id !== content.leaves[i]!.leaf_id ||
        leaf.page_index !== content.leaves[i]!.page_index,
    ) ||
    content.operations.some(
      (op) => op.kind === "drop" && !positions.has(op.leaf_id),
    )
  )
    throw new DraftBuildError("source-integrity");
  const roots = new Map(content.source_blocks.map((b) => [b.root_block_id, b]));
  const headings = retained.filter((l) => l.type === "title");
  const styles = headingStyleLevels(
    headings,
    (l) => roots.get(l.source.root_block_id)?.pdf_geometry,
  );
  const levels = new Map(
    headings.map((l, i) => {
      const numbering = /^\s*(\d+(?:\.\d+)*)(?:\.?\s+|[)．]\s*)\p{L}/u.exec(
        l.original_text.replace(/^\s*#{1,6}\s+/u, ""),
      );
      const level = numbering
        ? numbering[1]!.split(".").length + 1
        : styles.reliable
          ? styles.guessed[i]!
          : (roots.get(l.source.root_block_id)!.title_level ?? 1) + 1;
      return [l.leaf_id, Math.min(6, level)] as const;
    }),
  );
  const merges = content.operations.filter((op) => op.kind === "merge"),
    byFirst = new Map(merges.map((op) => [op.leaf_ids[0]!, op])),
    tails = new Set(merges.flatMap((op) => op.leaf_ids.slice(1))),
    byId = new Map(retained.map((l) => [l.leaf_id, l]));
  for (const [ordinal, op] of merges.entries()) {
    await checkpoint(ordinal, signal);
    let previous = -1;
    for (const [i, id] of op.leaf_ids.entries()) {
      const at = positions.get(id) ?? -1,
        leaf = byId.get(id);
      if (
        !leaf ||
        leaf.type !== "text" ||
        at <= previous ||
        (i > 0 &&
          op.joiners[i - 1] !==
            (byId
              .get(op.leaf_ids[i - 1]!)!
              .original_text.trimEnd()
              .endsWith("-")
              ? ""
              : " ")) ||
        (previous >= 0 &&
          all
            .slice(previous + 1, at)
            .some(
              (l) =>
                !dropped.has(l.leaf_id) &&
                !["image", "table", "footnote", "caption"].includes(l.type),
            ))
      )
        throw new DraftBuildError("source-integrity");
      previous = at;
    }
  }
  type Section = {
    -readonly [K in keyof DocumentStructureV2["sections"][number]]: DocumentStructureV2["sections"][number][K];
  };
  const sections: Section[] = [],
    stack: Section[] = [],
    segments: DocumentStructureV2<DraftBasis>["segments"][number][] = [],
    resources = new Map<string, RawParseResource>(),
    segment_leaves: {
      segment_id: string;
      leaf_ids: readonly string[];
      differences: readonly DraftDifference[];
    }[] = [];
  const chunks: string[] = [];
  let offset = 0;
  const append = (text: string) => {
    offset += Buffer.byteLength(text);
    if (offset > MAX_DOCUMENT_MARKDOWN_BYTES)
      throw new DraftBuildError("draft-too-large");
    chunks.push(text);
  };
  for (const [i, leaf] of retained.entries()) {
    await checkpoint(i, signal);
    if (tails.has(leaf.leaf_id)) continue;
    const heading = levels.has(leaf.leaf_id),
      group = byFirst.get(leaf.leaf_id),
      ids = group?.leaf_ids ?? [leaf.leaf_id];
    const title = leaf.original_text.replace(/^\s*#{1,6}\s+/u, "");
    if (heading || !stack.length) {
      const level = heading ? levels.get(leaf.leaf_id)! : 2;
      while (stack.length && stack.at(-1)!.level >= level)
        stack.pop()!.end_utf8 = offset;
      const section: Section = {
        section_id: `${heading ? "h" : "s"}-${leaf.leaf_id}`,
        title: heading ? title : null,
        level,
        start_utf8: offset,
        end_utf8: 0,
        role: null,
        role_source: null,
      };
      stack.push(section);
      sections.push(section);
    }
    const start = offset;
    if (heading) append("#".repeat(levels.get(leaf.leaf_id)!) + " ");
    for (const [j, id] of ids.entries()) {
      if (j) append(group!.joiners[j - 1]!);
      const part = byId.get(id)!;
      for (const resource of renderLeafPayload(
        part,
        heading ? title : part.original_text,
        available,
        { structure: append, payload: append },
      ))
        resources.set(resource.reference, resource);
    }
    if (offset === start) append("\n");
    const kind: ProofreadSegmentKind = heading
      ? "heading"
      : leaf.type === "reference"
        ? "reference-item"
        : [
              "aside",
              "header",
              "footer",
              "page-number",
              "discarded",
              "title",
            ].includes(leaf.type)
          ? "text"
          : (leaf.type as ProofreadSegmentKind);
    segments.push({
      segment_id: leaf.leaf_id,
      block_id: leaf.leaf_id,
      kind,
      section_id: stack.at(-1)!.section_id,
      start_utf8: start,
      end_utf8: offset,
      page: leaf.page_index,
      region: leaf.region,
      continuation_regions: ids.slice(1).flatMap((id) => {
        const l = byId.get(id)!;
        return l.region ? [{ page: l.page_index, region: l.region }] : [];
      }),
      locate: leaf.region ? "region" : "page",
      source: group ? "rule" : "parser",
      basis: worstBasis(ids.map((id) => rows.get(id)!.basis)),
    });
    segment_leaves.push({
      segment_id: leaf.leaf_id,
      leaf_ids: ids,
      differences: ids.flatMap((id) => rows.get(id)!.differences),
    });
    append("\n\n");
  }
  if (!offset) append("\n");
  for (const section of stack) section.end_utf8 = offset;
  const markdown = Buffer.from(chunks.join("")),
    structure = parseDraftDocumentStructure(
      {
        schema_version: 2,
        text_encoding: "utf8",
        page_count: content.pages.length,
        sections,
        segments,
      },
      markdown.length,
    ),
    structure_bytes = canonicalJsonBytes(structure);
  try {
    if (
      parserMarkdownReferences(markdown.toString("utf8")).some(
        (reference) => !resources.has(reference),
      )
    )
      throw new DraftBuildError("source-integrity");
  } catch (error) {
    if (error instanceof DraftBuildError) throw error;
    throw new DraftBuildError("source-integrity", { cause: error });
  }
  if (structure_bytes.length > MAX_DOCUMENT_STRUCTURE_BYTES)
    throw new DraftBuildError("draft-too-large");
  return {
    markdown,
    structure,
    structure_bytes,
    resources: [...resources.values()].sort((a, b) =>
      a.reference < b.reference ? -1 : a.reference > b.reference ? 1 : 0,
    ),
    segment_leaves,
    counts: {
      differs_segments: segments.filter((s) => s.basis === "text-layer-differs")
        .length,
      differences: content.leaves.reduce((n, l) => n + l.differences.length, 0),
      image_only_pages: content.pages.filter((p) => p.kind === "image-only")
        .length,
    },
  };
}
export function draftRepresentationHash(document: DraftDocumentRef): Sha256 {
  const {
    document_id: _document,
    document_version_id: _version,
    representation_sha256: _hash,
    ...representation
  } = parseDraftDocumentRef(document);
  void _document;
  void _version;
  void _hash;
  return textHash(representation) as Sha256;
}
export function draftArtifact(bytes: Uint8Array, media_type: string) {
  return parseArtifactRef({
    sha256: byteHash(bytes),
    byte_size: bytes.length,
    media_type,
  });
}
/** The identity algorithm is the same fixed namespace used by proofread publication. */
export function draftVersionId(documentId: string, representation: string) {
  const h = createHash("sha256")
    .update(`document-version\0${documentId}\0${representation}`)
    .digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
export function draftDocumentId(literatureId: string, assetId: string) {
  const h = createHash("sha256")
    .update(`document\0${literatureId}\0${assetId}`)
    .digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
export interface DraftBuildOptions {
  readonly signal?: AbortSignal;
  readonly correct_reading_order?: boolean;
}
/** Only caller-supplied immutable inputs are read; no store, model or network port. */
export async function buildDraftDocument(
  raw: RawParse,
  reader: ProofreadInputReader,
  pages: readonly PdfPageInspection[] | null,
  materialValue: DocumentMaterialRef,
  options: DraftBuildOptions = {},
) {
  const signal = options.signal;
  await checkpoint(0, signal);
  if (pages === null) throw new DraftBuildError("page-tools-unavailable");
  try {
    const material = parseDocumentMaterialRef(materialValue);
    if (
      raw.source_asset_id !== material.asset_id ||
      raw.source_sha256 !== material.asset_sha256
    )
      throw new DraftBuildError("source-integrity");
    const method = currentDraftMethod(options.correct_reading_order);
    const guardedReader: ProofreadInputReader = {
      readArtifact: async (...args) => {
        try {
          return await reader.readArtifact(...args);
        } catch (error) {
          throw new DraftBuildError(
            signal?.aborted ? "cancelled" : "source-integrity",
            { cause: error },
          );
        }
      },
    };
    const source = await prepareArrangementSource(
      raw,
      guardedReader,
      pages,
      signal,
      { correct_reading_order: method.reading_order, cooperative: true },
    );
    if (!source.raw.blocks) {
      // The shared source factory keeps wordless Markdown at the preceding
      // page. It is unique only if the next known page leaves no other choice.
      const next = new Array<number>(source.blocks.length);
      const hasWords: boolean[] = [];
      for (const [i, block] of source.blocks.entries()) {
        await checkpoint(i, signal);
        hasWords.push(textTokens(block.text).length > 0);
      }
      let upper = pages.length - 1;
      for (let i = source.blocks.length - 1; i >= 0; i--) {
        await checkpoint(i, signal);
        if (hasWords[i]) upper = source.blocks[i]!.page_hint;
        next[i] = upper;
      }
      let lower = 0;
      for (const [i, block] of source.blocks.entries()) {
        await checkpoint(i, signal);
        if (hasWords[i]) lower = block.page_hint;
        else if (lower !== next[i]) throw new DraftBuildError("needs-parse");
      }
    }
    const verify = async (
      kind: "markdown" | "image",
      artifact: import("@sciretriever/contracts").ArtifactRef,
      reference = "",
    ) => {
      let bytes: Uint8Array;
      try {
        bytes = await reader.readArtifact(
          source.raw.raw_parse_id,
          kind,
          reference,
          signal,
        );
      } catch (error) {
        throw new DraftBuildError(
          signal?.aborted ? "cancelled" : "source-integrity",
          { cause: error },
        );
      }
      if (
        bytes.length !== artifact.byte_size ||
        byteHash(bytes) !== artifact.sha256
      )
        throw new DraftBuildError("source-integrity");
    };
    if (raw.blocks) await verify("markdown", raw.markdown);
    for (const [i, resource] of source.raw.resources.entries()) {
      await checkpoint(i, signal);
      await verify("image", resource.artifact, resource.reference);
    }
    const all = await contentLeaves(
      { source_blocks: source.blocks, raw: source.raw },
      signal,
    );
    // §8.2 keeps interface text: reuse chrome detection unchanged, selecting only
    // its header/footer decisions. Proofread callers retain its aside handling.
    const chrome = programChromeDrops(source.blocks, pages.length),
      operations: DraftOperation[] = [],
      dropped = new Set<string>();
    for (const [i, leaf] of all.entries()) {
      await checkpoint(i, signal);
      const decision = chrome.get(leaf.source.root_block_id);
      if (
        decision &&
        (decision.reason === "header" || decision.reason === "footer")
      ) {
        dropped.add(leaf.leaf_id);
        operations.push({
          kind: "drop",
          leaf_id: leaf.leaf_id,
          reason: decision.reason,
          source: decision.source,
          rule: decision.rule,
        });
      }
    }
    const body = (leaf: ArrangementLeaf) =>
      !dropped.has(leaf.leaf_id) && leaf.type === "text";
    const evidence = paragraphBreakEvidenceForBody(source, all, body, (l) =>
      dropped.has(l.leaf_id),
    );
    const groups: string[][] = [];
    let previous: ArrangementLeaf | undefined,
      group: string[] | undefined,
      skipped: ArrangementLeaf[] = [];
    for (const [i, leaf] of all.entries()) {
      await checkpoint(i, signal);
      if (!body(leaf)) {
        if (
          dropped.has(leaf.leaf_id) ||
          ["footnote", "image", "table", "caption"].includes(leaf.type)
        )
          skipped.push(leaf);
        else {
          previous = undefined;
          group = undefined;
          skipped = [];
        }
        continue;
      }
      if (previous && evidence(previous, leaf, skipped).automatic) {
        if (!group) {
          group = [previous.leaf_id];
          groups.push(group);
        }
        group.push(leaf.leaf_id);
      } else group = undefined;
      previous = leaf;
      skipped = [];
    }
    const byId = new Map(all.map((l) => [l.leaf_id, l]));
    for (const ids of groups)
      operations.push({
        kind: "merge",
        leaf_ids: ids,
        joiners: ids
          .slice(1)
          .map((_, i) =>
            byId.get(ids[i]!)!.original_text.trimEnd().endsWith("-") ? "" : " ",
          ),
        source: "program",
        rule: PARAGRAPH_BREAK_RULE,
      });
    const value: DraftContent = {
      schema_version: 1,
      format: "draft-content-v1",
      differences_format: "draft-differences-v1",
      raw: {
        raw_parse_id: source.raw.raw_parse_id,
        result_sha256: source.raw.result_sha256,
        profile: source.raw.profile,
      },
      page_layer_sha256: pageLayerHash(pages),
      pages: pages.map((p) => ({ page_index: p.page, kind: p.kind })),
      method,
      draft_method_sha256: draftMethodHash(method),
      source_blocks: source.blocks,
      operations,
      leaves: await compareDraftLeaves(
        all.filter((l) => !dropped.has(l.leaf_id)),
        pages,
        signal,
      ),
    };
    const content_bytes = canonicalJsonBytes(value);
    if (content_bytes.length > MAX_DRAFT_CONTENT_BYTES)
      throw new DraftBuildError("draft-too-large");
    const content = parseDraftContent(value),
      rendered = await renderDraftContent(
        content,
        source.raw.resources,
        signal,
      );
    const representation = {
      schema_version: 3 as const,
      text_level: "draft" as const,
      source_material_ref: material,
      raw_parse_id: source.raw.raw_parse_id,
      raw_parse_result_sha256: source.raw.result_sha256,
      page_layer_sha256: content.page_layer_sha256,
      draft_method_sha256: content.draft_method_sha256,
      draft_content: draftArtifact(content_bytes, "application/json"),
      builder_version: DRAFT_BUILDER,
      locator_scheme: "utf8-segment-v1" as const,
      markdown: draftArtifact(rendered.markdown, "text/markdown"),
      structure: draftArtifact(rendered.structure_bytes, "application/json"),
      resources: rendered.resources.map((r, i) => ({
        resource_id: `r${i + 1}`,
        reference: r.reference,
        artifact: r.artifact,
        relation: "image" as const,
      })),
    };
    const documentId = draftDocumentId(
        material.literature_id,
        material.asset_id,
      ),
      representationHash = textHash(representation);
    const document = parseDraftDocumentRef({
      ...representation,
      document_id: documentId,
      document_version_id: draftVersionId(documentId, representationHash),
      representation_sha256: representationHash,
    });
    await checkpoint(0, signal);
    return { ...rendered, content, content_bytes, document };
  } catch (error) {
    if (signal?.aborted)
      throw new DraftBuildError("cancelled", { cause: error });
    if (error instanceof DraftBuildError) throw error;
    if (error instanceof ArchiveTextError)
      throw new DraftBuildError(
        error.code === "input-missing"
          ? "needs-parse"
          : error.code === "request-too-large"
            ? "draft-too-large"
            : "source-integrity",
        { cause: error },
      );
    if (
      error instanceof ContractValidationError ||
      error instanceof SyntaxError ||
      error instanceof TypeError
    )
      throw new DraftBuildError("source-integrity", { cause: error });
    throw error;
  }
}
export async function rebuildDraftDocument(
  value: DraftDocumentRef,
  bytes: Uint8Array,
  signal?: AbortSignal,
) {
  await checkpoint(0, signal);
  const document = parseDraftDocumentRef(value);
  if (
    bytes.length !== document.draft_content.byte_size ||
    byteHash(bytes) !== document.draft_content.sha256 ||
    draftRepresentationHash(document) !== document.representation_sha256 ||
    draftDocumentId(
      document.source_material_ref.literature_id,
      document.source_material_ref.asset_id,
    ) !== document.document_id ||
    draftVersionId(document.document_id, document.representation_sha256) !==
      document.document_version_id
  )
    throw new DraftBuildError("source-integrity");
  const content = parseDraftContent(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
  if (
    content.raw.raw_parse_id !== document.raw_parse_id ||
    content.raw.result_sha256 !== document.raw_parse_result_sha256 ||
    content.page_layer_sha256 !== document.page_layer_sha256 ||
    content.draft_method_sha256 !== document.draft_method_sha256 ||
    !Buffer.from(canonicalJsonBytes(content)).equals(Buffer.from(bytes))
  )
    throw new DraftBuildError("source-integrity");
  const rendered = await renderDraftContent(
    content,
    document.resources.map((r) => ({
      reference: r.reference,
      artifact: r.artifact,
    })),
    signal,
  );
  if (
    byteHash(rendered.markdown) !== document.markdown.sha256 ||
    rendered.markdown.length !== document.markdown.byte_size ||
    byteHash(rendered.structure_bytes) !== document.structure.sha256 ||
    rendered.structure_bytes.length !== document.structure.byte_size ||
    textHash(rendered.resources) !==
      textHash(
        document.resources.map((r) => ({
          reference: r.reference,
          artifact: r.artifact,
        })),
      )
  )
    throw new DraftBuildError("source-integrity");
  return { ...rendered, content };
}
