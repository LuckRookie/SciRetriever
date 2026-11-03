import { correctReadingOrder } from "./reading-order.js";
import { measurePdfBlock } from "./pdf-geometry.js";
import { createHash } from "node:crypto";
import {
  canonicalJsonBytes,
  parseRawBlocksV1,
  parseRawParse,
  parseArrangementSourceBlock,
  type ArrangementSourceBlock,
  type RawParse,
} from "@sciretriever/contracts";
import type { ProofreadInputReader } from "../proofread/draft.js";
import { pdfPageText, type PdfPageInspection } from "../browser/pdf-region.js";
import { textTokens } from "../proofread/suspects.js";
export const textHash = (value: unknown) =>
  createHash("sha256").update(canonicalJsonBytes(value)).digest("hex");
export const byteHash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
export function textId(value: unknown) {
  const h = textHash(value);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
export function cpSlice(text: string, start: number, end?: number) {
  return [...text].slice(start, end).join("");
}
export interface ArchiveTextSource {
  readonly raw: RawParse;
  readonly blocks: readonly ArrangementSourceBlock[];
  readonly pages: readonly PdfPageInspection[];
  readonly input_sha256: string;
}
export class ArchiveTextError extends Error {
  constructor(
    readonly code: string,
    readonly issues: readonly {
      readonly code: string;
      readonly id: string | null;
    }[] = [],
    options?: ErrorOptions,
  ) {
    super("archive text validation failed", options);
    this.name = "ArchiveTextError";
  }
}
export async function prepareArrangementSource(
  rawValue: RawParse,
  reader: ProofreadInputReader,
  pages: readonly PdfPageInspection[],
  signal?: AbortSignal,
  options: { readonly correct_reading_order?: boolean } = {},
): Promise<ArchiveTextSource> {
  const raw = await parseRawParse(rawValue);
  signal?.throwIfAborted();
  if (raw.page_count !== pages.length || pages.some((p, i) => p.page !== i))
    throw new ArchiveTextError("source-integrity");
  const artifact = raw.blocks ?? raw.markdown;
  if (artifact.byte_size > 32 * 1024 * 1024)
    throw new ArchiveTextError("request-too-large");
  const bytes = await reader.readArtifact(
    raw.raw_parse_id,
    raw.blocks ? "blocks" : "markdown",
    "",
    signal,
  );
  if (
    bytes.length !== artifact.byte_size ||
    byteHash(bytes) !== artifact.sha256
  )
    throw new ArchiveTextError("source-integrity");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const sources: ArrangementSourceBlock[] = [];
  const add = (
    data: Omit<
      ArrangementSourceBlock,
      "root_block_id" | "raw_parse_id" | "result_sha256" | "source_sha256"
    >,
  ) => {
    sources.push(
      parseArrangementSourceBlock(
        {
          ...data,
          root_block_id: textId([
            "archive-source-v1",
            raw.result_sha256,
            data.locator,
          ]),
          raw_parse_id: raw.raw_parse_id,
          result_sha256: raw.result_sha256,
          source_sha256: byteHash(Buffer.from(data.text)),
        },
        raw.page_count,
      ),
    );
  };
  if (raw.blocks) {
    const parsed = parseRawBlocksV1(
      JSON.parse(text),
      raw.resources.map((r) => r.reference),
    );
    if (parsed.page_count !== raw.page_count)
      throw new ArchiveTextError("source-integrity");
    const columnBox = (block: (typeof parsed.blocks)[number]) => {
      const box = block.bbox,
        width = box[2] - box[0];
      if (width > 600 || !["text", "list", "reference"].includes(block.type))
        return box;
      const same = parsed.blocks.filter(
        (b) =>
          b.page === block.page &&
          b.type === "text" &&
          b.bbox[2] - b.bbox[0] >= 180 &&
          b.bbox[2] - b.bbox[0] <= 560 &&
          (box[0] + box[2]) / 2 >= b.bbox[0] &&
          (box[0] + box[2]) / 2 <= b.bbox[2] &&
          Math.abs(b.bbox[0] - box[0]) < 70,
      );
      return same.length
        ? ([
            Math.min(...same.map((b) => b.bbox[0])),
            0,
            Math.max(...same.map((b) => b.bbox[2])),
            1000,
          ] as const)
        : box;
    };
    for (const b of parsed.blocks) {
      const field = b.type === "table" && b.html !== null ? "html" : "text";
      add({
        locator: {
          kind: "raw-block",
          page_index: b.page,
          block_index: b.index,
          field,
        },
        type: b.type,
        text: field === "html" ? b.html! : b.text,
        page_hint: b.page,
        region_hint: b.bbox,
        image_ref: b.image_ref,
        title_level: b.title_level,
        ...(() => {
          const pdf_geometry = measurePdfBlock(
            b.bbox,
            pages[b.page],
            raw.page_sizes[b.page],
            columnBox(b),
          );
          return pdf_geometry ? { pdf_geometry } : {};
        })(),
      });
    }
  } else {
    // Keep exact original substrings; page matching only supplies a locating hint.
    let previous = 0;
    const pageTokens = pages.map((p) => new Set(textTokens(p.text)));
    for (const match of text.matchAll(/[^]*?(?:\n\s*\n|$)/gu)) {
      const piece = match[0];
      if (!piece.length) continue;
      const tokens = textTokens(piece);
      let page = previous;
      if (tokens.length) {
        const candidates = pages.filter(
          (p) =>
            p.page >= previous &&
            p.kind === "text-layer" &&
            tokens.every((t) => pageTokens[p.page]!.has(t)),
        );
        if (candidates.length !== 1)
          throw new ArchiveTextError("input-missing");
        page = candidates[0]!.page;
        previous = page;
      }
      const start = Buffer.byteLength(text.slice(0, match.index));
      add({
        locator: {
          kind: "raw-markdown",
          start_utf8: start,
          end_utf8: start + Buffer.byteLength(piece),
        },
        type: /^\s*#{1,6}\s/u.test(piece) ? "title" : "text",
        text: piece,
        page_hint: page,
        region_hint: null,
        image_ref: null,
        title_level: /^\s*(#{1,6})\s/u.exec(piece)?.[1]?.length ?? null,
      });
    }
  }
  if (new Set(sources.map((b) => b.root_block_id)).size !== sources.length)
    throw new ArchiveTextError("source-integrity");
  const ordered = correctReadingOrder(sources, options.correct_reading_order);
  return {
    raw,
    blocks: ordered,
    pages,
    input_sha256: textHash({
      method: "archive-source-v1",
      raw: raw.result_sha256,
      blocks: ordered,
      pages: pages.map(pdfPageText),
    }),
  };
}
