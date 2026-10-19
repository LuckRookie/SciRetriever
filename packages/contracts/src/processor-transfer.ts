import { parseAssetId } from "./index.js";
import {
  processorExact,
  processorFail,
  processorHash,
  processorText,
} from "./processors.js";

export const PROCESSOR_TRANSFER_MAX_BYTES = 256 * 1024;
export type ProcessorTransferFormat = "result" | "json" | "csv" | "markdown";
export interface ProcessorTransferRequest {
  readonly result_id: string;
  readonly content_sha256: string;
  readonly format: ProcessorTransferFormat;
  readonly max_bytes: number;
  readonly continuation: string | null;
}
export interface ProcessorTransferChunk {
  readonly schema_version: 1;
  readonly result_id: string;
  readonly content_sha256: string;
  readonly format: ProcessorTransferFormat;
  readonly transfer_sha256: string;
  readonly total_bytes: number;
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly next: string | null;
}
function format(value: unknown): ProcessorTransferFormat {
  if (!["result", "json", "csv", "markdown"].includes(String(value)))
    processorFail();
  return value as ProcessorTransferFormat;
}
function integer(
  value: unknown,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    processorFail();
  return value;
}
const cursor = (value: unknown) =>
  value === null ? null : processorText(value, 4096);
export function parseProcessorTransferRequest(
  value: unknown,
): ProcessorTransferRequest {
  const r = processorExact(value, [
    "result_id",
    "content_sha256",
    "format",
    "max_bytes",
    "continuation",
  ]);
  return {
    result_id: String(parseAssetId(r.result_id)),
    content_sha256: processorHash(r.content_sha256),
    format: format(r.format),
    max_bytes: integer(r.max_bytes, 4, PROCESSOR_TRANSFER_MAX_BYTES),
    continuation: cursor(r.continuation),
  };
}
export function parseProcessorTransferChunk(
  value: unknown,
): ProcessorTransferChunk {
  const r = processorExact(value, [
    "schema_version",
    "result_id",
    "content_sha256",
    "format",
    "transfer_sha256",
    "total_bytes",
    "start",
    "end",
    "text",
    "next",
  ]);
  if (r.schema_version !== 1) processorFail();
  const total_bytes = integer(r.total_bytes, 1),
    start = integer(r.start, 0, total_bytes - 1),
    end = integer(r.end, start + 1, total_bytes);
  const text = processorText(r.text, PROCESSOR_TRANSFER_MAX_BYTES, true),
    next = cursor(r.next);
  if (
    new TextEncoder().encode(text).length !== end - start ||
    (next === null) !== (end === total_bytes)
  )
    processorFail();
  return {
    schema_version: 1,
    result_id: String(parseAssetId(r.result_id)),
    content_sha256: processorHash(r.content_sha256),
    format: format(r.format),
    transfer_sha256: processorHash(r.transfer_sha256),
    total_bytes,
    start,
    end,
    text,
    next,
  };
}
