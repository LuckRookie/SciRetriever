import {
  parseProcessorTransferRequest,
  type ProcessorTransferChunk,
  sha256,
} from "@sciretriever/contracts";
import {
  processorError,
  type ProcessorStore,
  type StoredProcessorResult,
} from "./processor.js";

type Reader = Pick<ProcessorStore, "byId" | "records">;
export async function exportProcessorResult(
  store: Reader,
  stored: StoredProcessorResult,
  format: unknown,
  signal?: AbortSignal,
) {
  if (signal?.aborted) processorError("processor-cancelled");
  if (format === "json")
    return {
      media_type: "application/json",
      content: JSON.stringify(stored, null, 2),
    };
  if (format !== "csv" && format !== "markdown")
    processorError("processor-export-format");
  const records = await store.records(
    { kind: "result", input_id: "export", ...stored.ref, record_ids: null },
    signal,
  );
  const metadata = {
    ...stored.ref,
    invocation: stored.result.invocation,
    coverage: stored.result.coverage,
    provenance: stored.result.provenance,
  };
  const cell = (v: unknown) =>
    `"${(typeof v === "string" ? v : JSON.stringify(v)).replace(/"/g, '""')}"`;
  return {
    media_type: format === "csv" ? "text/csv" : "text/markdown",
    metadata,
    content:
      format === "csv"
        ? [
            "record_id,payload_json,evidence_json",
            ...records.map((r) =>
              [r.record_id, r.payload, r.citation].map(cell).join(","),
            ),
          ].join("\r\n")
        : records
            .map(
              (r) =>
                `- ${typeof r.payload.text === "string" ? r.payload.text : JSON.stringify(r.payload)}\n\n  Evidence: \`${JSON.stringify(r.citation)}\``,
            )
            .join("\n\n"),
  };
}

/** Additive, read-only transport of a verified result or its complete export envelope. */
export async function transferProcessorResult(
  store: Reader,
  value: unknown,
  signal?: AbortSignal,
): Promise<ProcessorTransferChunk> {
  const request = parseProcessorTransferRequest(value);
  if (signal?.aborted) processorError("processor-cancelled");
  const stored = await store.byId(request.result_id, signal);
  if (!stored) processorError("processor-result-missing");
  if (stored.ref.content_sha256 !== request.content_sha256)
    processorError("processor-input-changed");
  const envelope =
    request.format === "result"
      ? stored
      : await exportProcessorResult(store, stored, request.format, signal);
  const bytes = Buffer.from(JSON.stringify(envelope));
  const transfer_sha256 = await sha256(bytes);
  const identity = {
    version: 1,
    result_id: request.result_id,
    content_sha256: request.content_sha256,
    format: request.format,
    transfer_sha256,
  };
  const token = (offset: number) =>
    Buffer.from(JSON.stringify({ ...identity, offset })).toString("base64url");
  let start = 0;
  if (request.continuation !== null) {
    try {
      const parsed: unknown = JSON.parse(
        Buffer.from(request.continuation, "base64url").toString("utf8"),
      );
      if (
        !parsed ||
        typeof parsed !== "object" ||
        !("offset" in parsed) ||
        typeof parsed.offset !== "number" ||
        !Number.isSafeInteger(parsed.offset)
      )
        throw new Error("invalid cursor");
      start = parsed.offset;
      if (
        start <= 0 ||
        start >= bytes.length ||
        token(start) !== request.continuation ||
        (bytes[start]! & 0xc0) === 0x80
      )
        throw new Error("invalid cursor");
    } catch {
      processorError("processor-continuation-invalid");
    }
  }
  if (signal?.aborted) processorError("processor-cancelled");
  let end = Math.min(start + request.max_bytes, bytes.length);
  while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  return {
    schema_version: 1,
    result_id: request.result_id,
    content_sha256: request.content_sha256,
    format: request.format,
    transfer_sha256,
    total_bytes: bytes.length,
    start,
    end,
    text: bytes.subarray(start, end).toString("utf8"),
    next: end < bytes.length ? token(end) : null,
  };
}
