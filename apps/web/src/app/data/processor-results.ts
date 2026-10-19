import {
  parseAssetId,
  parseProcessorCitation,
  parseProcessorResult,
  parseProcessorTransferChunk,
  parseEvidenceRef,
  parseLiteratureId,
  processorResultBytes,
  sha256,
  type ProcessorCitation,
  type ProcessorResult,
  type ProcessorResultRef,
  type ProcessorTransferFormat,
  type EvidenceRef,
} from "@sciretriever/contracts";
import { strToU8, zipSync } from "fflate";
import { record, listField, stringField } from "./wire.js";
import type { ApiClient } from "./api.js";

type Reader = Pick<ApiClient, "processors">;
export interface WebProcessorResult {
  ref: ProcessorResultRef;
  result: ProcessorResult;
}
export interface ResultDescription {
  ref: ProcessorResultRef;
  processor: string;
  literatureIds: readonly string[];
  coverage: ProcessorResult["coverage"];
  kind: ProcessorResult["content"]["kind"];
  schema: Record<string, unknown>;
  records: number | null;
}
export function resultReference(value: unknown): ProcessorResultRef {
  const r = record(value, "result reference");
  const hash = stringField(r, "content_sha256");
  if (!/^[a-f0-9]{64}$/u.test(hash)) throw new Error("结果 hash 无效");
  return { result_id: String(parseAssetId(r.result_id)), content_sha256: hash };
}

/** Read complete bytes with an identity-bound cursor; never treat a partial reply as a result. */
export async function transferProcessor(
  api: Reader,
  ref: ProcessorResultRef,
  format: ProcessorTransferFormat,
  signal: AbortSignal,
): Promise<unknown> {
  let continuation: string | null = null,
    start = 0,
    total = 0,
    hash = "";
  const parts: string[] = [];
  do {
    signal.throwIfAborted();
    const chunk = parseProcessorTransferChunk(
      (
        await api.processors(
          "transfer",
          {
            result_id: ref.result_id,
            content_sha256: ref.content_sha256,
            format,
            max_bytes: 262144,
            continuation,
          },
          signal,
        )
      ).result,
    );
    if (
      chunk.result_id !== ref.result_id ||
      chunk.content_sha256 !== ref.content_sha256 ||
      chunk.format !== format ||
      chunk.start !== start ||
      chunk.total_bytes > 64 * 1024 * 1024 ||
      (hash &&
        (chunk.transfer_sha256 !== hash || chunk.total_bytes !== total)) ||
      (continuation !== null && chunk.next === continuation)
    )
      throw new Error("结果分块与固定引用不匹配");
    hash = chunk.transfer_sha256;
    total = chunk.total_bytes;
    start = chunk.end;
    continuation = chunk.next;
    parts.push(chunk.text);
  } while (continuation !== null);
  const bytes = new TextEncoder().encode(parts.join(""));
  signal.throwIfAborted();
  if (bytes.length !== total || (await sha256(bytes)) !== hash)
    throw new Error("完整结果传输校验失败");
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

export async function readProcessorResult(
  api: Reader,
  ref: ProcessorResultRef,
  signal: AbortSignal,
): Promise<WebProcessorResult> {
  const value = record(
    await transferProcessor(api, ref, "result", signal),
    "processor result",
  );
  const actual = resultReference(value.ref),
    result = await parseProcessorResult(value.result);
  if (
    actual.result_id !== ref.result_id ||
    actual.content_sha256 !== ref.content_sha256 ||
    result.result_id !== ref.result_id ||
    (await sha256(processorResultBytes(result))) !== ref.content_sha256
  )
    throw new Error("固定处理结果无法验证");
  return { ref: actual, result };
}

export function describeResult(stored: WebProcessorResult): ResultDescription {
  const { result, ref } = stored;
  return {
    ref,
    processor: result.invocation.processor.id,
    literatureIds: [
      ...new Set([
        ...result.literature_ids,
        ...result.invocation.inputs.flatMap((input) =>
          input.kind === "document"
            ? [input.document.source_material_ref.literature_id]
            : input.kind === "material"
              ? [input.material.literature_id]
              : input.kind === "missing"
                ? [input.literature_id]
                : [],
        ),
      ]),
    ],
    coverage: result.coverage,
    kind: result.content.kind,
    schema: result.content.kind === "records" ? result.content.schema : {},
    records:
      result.content.kind === "records" ? result.content.records.length : null,
  };
}

export async function resolveProcessorEvidence(
  api: Reader,
  citation: ProcessorCitation,
  signal: AbortSignal,
): Promise<{
  value: unknown;
  evidence: EvidenceRef[];
  literatureIds: string[];
}> {
  const r = record(
    (await api.processors("evidence", parseProcessorCitation(citation), signal))
      .result,
    "processor evidence",
  );
  return {
    value: r.value,
    evidence: listField(r, "evidence").map(parseEvidenceRef),
    literatureIds: listField(r, "literature_ids").map((v) =>
      String(parseLiteratureId(v)),
    ),
  };
}

/** A single download contains both human-readable content and its returned provenance. */
export async function processorExportFile(
  api: Reader,
  ref: ProcessorResultRef,
  format: "json" | "csv" | "markdown",
  signal: AbortSignal,
): Promise<{ blob: Blob; name: string }> {
  const envelope = record(
    await transferProcessor(api, ref, format, signal),
    "processor export",
  );
  const content = stringField(envelope, "content");
  if (format === "json")
    return {
      blob: new Blob([content], { type: "application/json;charset=utf-8" }),
      name: `result-${ref.result_id}.json`,
    };
  const metadata = record(envelope.metadata, "export metadata");
  if (
    metadata.result_id !== ref.result_id ||
    metadata.content_sha256 !== ref.content_sha256 ||
    !Array.isArray(metadata.coverage) ||
    !metadata.provenance
  )
    throw new Error("导出缺少匹配的来源说明");
  const bytes = zipSync(
    {
      [`result.${format === "csv" ? "csv" : "md"}`]: strToU8(content),
      "metadata.json": strToU8(JSON.stringify(metadata, null, 2)),
    },
    { level: 0 },
  );
  return {
    blob: new Blob([new Uint8Array(bytes)], { type: "application/zip" }),
    name: `result-${ref.result_id}-${format}.zip`,
  };
}
