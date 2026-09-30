import {
  canonicalJsonBytes,
  sha256,
  type DocumentStructureV1,
} from "@sciretriever/contracts";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";

export const DOCUMENT_BUILDER_VERSION = "markdown-utf8-v1";
export const MAX_DOCUMENT_MARKDOWN_BYTES = 8 * 1024 * 1024;
export const MAX_DOCUMENT_STRUCTURE_BYTES = 16 * 1024 * 1024;
export const MAX_DOCUMENT_SEGMENTS = 100_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** Every emitted range is an exact half-open UTF-8 range in the source bytes. */
export async function buildDocumentStructure(
  markdown: Uint8Array,
  signal?: AbortSignal,
): Promise<{
  readonly structure: DocumentStructureV1;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}> {
  if (markdown.byteLength > MAX_DOCUMENT_MARKDOWN_BYTES || signal?.aborted)
    throw new Error("document markdown limit or cancellation");
  const source = decoder.decode(markdown);
  if (
    !source.trim() ||
    encoder.encode(source).byteLength !== markdown.byteLength
  )
    throw new Error("document markdown invalid");
  const sections: {
    section_id: string;
    title: string;
    level: number;
    start_utf8: number;
    end_utf8: number;
  }[] = [];
  const segments: {
    segment_id: string;
    kind: "heading" | "text";
    section_id: string | null;
    start_utf8: number;
    end_utf8: number;
  }[] = [];
  const open: number[] = [];
  let position = 0;
  let offset = 0;
  let fence: { marker: string; width: number } | null = null;
  while (position < source.length) {
    if (signal?.aborted) throw new Error("document build cancelled");
    if (segments.length > 0 && segments.length % 256 === 0) {
      await yieldToEventLoop();
      if (signal?.aborted) throw new Error("document build cancelled");
    }
    if (segments.length >= MAX_DOCUMENT_SEGMENTS)
      throw new Error("document segment limit exceeded");
    const next = source.indexOf("\n", position);
    const end = next < 0 ? source.length : next + 1;
    const line = source.slice(position, end);
    const lineBytes = encoder.encode(line).byteLength;
    const body = line.replace(/\r?\n$/u, "");
    const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(body);
    let heading: RegExpExecArray | null = null;
    if (fence) {
      if (
        opening &&
        opening[1]![0] === fence.marker &&
        opening[1]!.length >= fence.width &&
        !opening[2]!.trim()
      )
        fence = null;
    } else if (opening) {
      fence = { marker: opening[1]![0]!, width: opening[1]!.length };
    } else if (!/^ {4}|^\t/u.test(body)) {
      heading = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/u.exec(body);
    }
    if (heading) {
      const level = heading[1]!.length;
      while (open.length && sections[open.at(-1)!]!.level >= level)
        sections[open.pop()!]!.end_utf8 = offset;
      const sectionId = `s${sections.length + 1}`;
      const title = (heading[2] ?? "").replace(/[ \t]+#+[ \t]*$/u, "").trim();
      sections.push({
        section_id: sectionId,
        title,
        level,
        start_utf8: offset,
        end_utf8: markdown.byteLength,
      });
      open.push(sections.length - 1);
    }
    segments.push({
      segment_id: `p${segments.length + 1}`,
      kind: heading ? "heading" : "text",
      section_id: open.length ? sections[open.at(-1)!]!.section_id : null,
      start_utf8: offset,
      end_utf8: offset + lineBytes,
    });
    offset += lineBytes;
    position = end;
  }
  if (
    offset !== markdown.byteLength ||
    segments.some((s) => s.start_utf8 >= s.end_utf8)
  )
    throw new Error("document structure invalid");
  const structure: DocumentStructureV1 = {
    schema_version: 1,
    text_encoding: "utf8",
    sections,
    segments,
  };
  const bytes = canonicalJsonBytes(structure);
  if (bytes.byteLength > MAX_DOCUMENT_STRUCTURE_BYTES)
    throw new Error("document structure limit exceeded");
  return { structure, bytes, sha256: await sha256(bytes) };
}
