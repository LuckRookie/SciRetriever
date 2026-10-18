import {
  processorExact,
  processorJson,
  processorObject,
  processorText,
  type ProcessorObject,
  type ProcessorCoverage,
  type ProcessorInput,
  type ProcessorCitation,
} from "@sciretriever/contracts";
import {
  processorError,
  type ProcessorContext,
  type ProcessorSegment,
} from "./processor.js";
export const TEXT_LIMITATIONS = [
  "text-only; images and exact table coordinates are not evaluated",
  "only explicitly selected materials; supplementary files are not fetched",
];
export function readingSpec(value: unknown) {
  const r = value === undefined ? {} : processorObject(value);
  if (
    Object.keys(r).some(
      (k) => !["scope", "query", "max_chunk_bytes"].includes(k),
    )
  )
    processorError("processor-spec");
  const scope = r.scope ?? "full",
    query = r.query ?? null,
    max_chunk_bytes = r.max_chunk_bytes ?? 12000;
  if (
    !["full", "search"].includes(String(scope)) ||
    typeof max_chunk_bytes !== "number" ||
    !Number.isSafeInteger(max_chunk_bytes) ||
    max_chunk_bytes < 256 ||
    max_chunk_bytes > 32000
  )
    processorError("processor-spec");
  if (scope === "search") processorText(query, 1024);
  else if (query !== null) processorError("processor-spec");
  return processorJson({ scope, query, max_chunk_bytes });
}
export const READING_SCHEMA = {
  type: "object",
  properties: {
    scope: { enum: ["full", "search"] },
    query: { type: ["string", "null"] },
    max_chunk_bytes: { type: "integer", minimum: 256, maximum: 32000 },
  },
  additionalProperties: false,
};
export async function textChunks(
  input: Extract<ProcessorInput, { kind: "document" }>,
  reading: ProcessorObject,
  ctx: ProcessorContext,
) {
  const all = await ctx.readDocument(input);
  const selected =
    reading.scope === "search"
      ? all.filter((s) =>
          String(reading.query)
            .toLowerCase()
            .split(/\s+/u)
            .some((t) => s.text.toLowerCase().includes(t)),
        )
      : all;
  const chunks: ProcessorSegment[][] = [];
  let chunk: ProcessorSegment[] = [];
  let size = 0;
  const gaps: string[] =
    reading.scope === "search"
      ? ["search-only; unselected segments were not processed"]
      : [];
  for (const segment of selected) {
    const bytes = Buffer.byteLength(segment.text);
    if (bytes > Number(reading.max_chunk_bytes)) {
      gaps.push(`segment-too-large:${segment.segment_id}`);
      continue;
    }
    if (size + bytes > Number(reading.max_chunk_bytes)) {
      chunks.push(chunk);
      chunk = [];
      size = 0;
    }
    chunk.push(segment);
    size += bytes;
  }
  if (chunk.length) chunks.push(chunk);
  if (!chunks.length) gaps.push("no-readable-selected-segments");
  return { chunks, gaps };
}
export function segmentSources(
  ids: unknown,
  segments: readonly ProcessorSegment[],
): ProcessorCitation[] {
  if (!Array.isArray(ids) || !ids.length)
    processorError("processor-field-evidence");
  return [...new Set(ids)].map((id) => {
    const segment = segments.find((s) => s.segment_id === id);
    if (!segment) processorError("processor-invalid-evidence");
    return segment.citation;
  });
}
export function textCoverage(
  input: ProcessorInput,
  read: readonly string[],
  gaps: readonly string[],
): ProcessorCoverage {
  return {
    input_id: input.input_id,
    status: gaps.length ? (read.length ? "partial" : "none") : "complete",
    read_segments: read,
    gaps,
  };
}
export function exactFields(value: unknown, names: readonly string[]) {
  return processorExact(value, names);
}
