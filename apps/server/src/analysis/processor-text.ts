import {
  chunkTokenLimit,
  splitProcessorText,
  selectProcessorText,
} from "./processor-chunking.js";
export { chunkHeading, PROCESSOR_CHUNKING } from "./processor-chunking.js";
import {
  processorExact,
  processorJson,
  parseProcessorReading,
  PROCESSOR_READING_SCHEMA,
  ContractValidationError,
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
  try {
    return processorJson(parseProcessorReading(value));
  } catch (error) {
    if (error instanceof ContractValidationError)
      processorError("processor-spec");
    throw error;
  }
}
export const READING_SCHEMA = PROCESSOR_READING_SCHEMA;
export async function textChunks(
  input: Extract<ProcessorInput, { kind: "archive-document" }>,
  reading: ProcessorObject,
  ctx: ProcessorContext,
  model: ProcessorObject | null = null,
  promptBytes = 0,
) {
  const all = await ctx.readDocument(input);
  const selected =
    reading.scope === "search"
      ? selectProcessorText(all, String(reading.query))
      : all;
  const { chunks, gaps } = splitProcessorText(
    selected,
    chunkTokenLimit(model, promptBytes),
  );
  if (reading.scope === "search")
    gaps.unshift("search-only; unselected segments were not processed");
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
): Omit<ProcessorCoverage, "parts"> {
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
