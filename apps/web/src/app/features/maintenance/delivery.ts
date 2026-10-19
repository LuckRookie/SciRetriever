import {
  parseStrictJsonValue,
  parseExtractionOperationResult,
  parseExtractionReceiptResult,
  parseExtractionAcceptedResult,
  parseExtractionSubmission,
  parseExtractionCandidateIssue,
  extractionSubmissionHash,
  EXTRACTION_ACCEPTED_MAX_BYTES,
  EXTRACTION_RECEIPT_MAX_BYTES,
  parseInputManifest,
  type ExtractionOperationResult,
  type InputManifest,
} from "@sciretriever/contracts";
import { record } from "../../data/wire.js";
import type { ApiClient } from "../../data/api.js";
export async function boundedResponseBytes(
  response: Response,
  limit: number,
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("交付响应无效");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error("交付响应过大");
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Evidence and response limits remain at the transport boundary, before display. */
export function extractionTransport(api: ApiClient) {
  let selectedExtractionOperation: ExtractionOperationResult | null = null;
  let preparation = "";
  async function extractionPost(
    path: string,
    request: unknown,
  ): Promise<unknown> {
    const submission =
      path === "submit" ? parseExtractionSubmission(request) : null;
    let expectedHash: string | undefined;
    let expectedManifest: InputManifest | undefined;
    if (submission) {
      const selected =
        selectedExtractionOperation?.operation_id === submission.operation_id
          ? selectedExtractionOperation
          : await extractionPost("operation-read", {
              operation_id: submission.operation_id,
            });
      if (!selected) throw new Error("operation 未知或已过期");
      expectedHash = await extractionSubmissionHash(
        selected as ExtractionOperationResult,
        submission,
      );
      const prepared = record(parseStrictJsonValue(preparation), "preparation");
      expectedManifest = await parseInputManifest(prepared.manifest);
      if (
        expectedManifest.manifest_sha256 !==
        (selected as ExtractionOperationResult).manifest_sha256
      )
        throw new Error("manifest 与 operation 不匹配");
    }
    const session = await api.fetch("/api/v1/maintenance/session");
    if (!session.ok) throw new Error("维护会话不可用");
    const grant = record(
      parseStrictJsonValue(await boundedResponseBytes(session, 4096)),
      "maintenance session",
    );
    if (
      Object.keys(grant).sort().join() !==
        ["protocol_version", "csrf"].sort().join() ||
      grant.protocol_version !== 1 ||
      typeof grant.csrf !== "string"
    )
      throw new Error("维护会话无效");
    const response = await api.fetch(`/api/v1/maintenance/extraction-${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Sciretriever-Protocol-Version": "1",
        "X-Sciretriever-Csrf": grant.csrf,
      },
      body: JSON.stringify({ protocol_version: 1, request }),
    });
    const responseBytes = await boundedResponseBytes(
      response,
      response.ok
        ? path === "submit"
          ? EXTRACTION_ACCEPTED_MAX_BYTES + 4096
          : path === "receipt"
            ? EXTRACTION_RECEIPT_MAX_BYTES + 4096
            : 8192
        : 8192,
    );
    const envelope = record(
      parseStrictJsonValue(responseBytes),
      "extraction response",
    );
    if (envelope.protocol_version !== 1) throw new Error("交付回执无效");
    if (!response.ok) {
      if (
        Object.keys(envelope).some(
          (key) => !["protocol_version", "code", "issue"].includes(key),
        ) ||
        typeof envelope.code !== "string"
      )
        throw new Error("交付错误响应无效");
      const issue =
        envelope.issue === undefined
          ? null
          : parseExtractionCandidateIssue(envelope.issue);
      throw new Error(
        `${envelope.code}${issue?.record_id ? `（记录 ${issue.record_id}）` : issue?.input_id ? `（输入 ${issue.input_id}）` : ""}`,
      );
    }
    if (
      Object.keys(envelope).sort().join() !==
      ["protocol_version", "result"].sort().join()
    )
      throw new Error("交付回执无效");
    if (
      path === "operation" ||
      path === "operation-read" ||
      path === "close" ||
      path === "cancel"
    ) {
      if (envelope.result === null && path === "operation-read") return null;
      const result = parseExtractionOperationResult(envelope.result);
      const selected = record(request, "operation request");
      if (
        path === "operation" &&
        (result.caller_id !== selected.caller_id ||
          result.spec_sha256 !== record(selected.spec, "spec").spec_sha256 ||
          result.manifest_sha256 !==
            record(selected.manifest, "manifest").manifest_sha256)
      )
        throw new Error("operation 与请求不匹配");
      if (path !== "operation" && result.operation_id !== selected.operation_id)
        throw new Error("operation 与当前选择不匹配");
      selectedExtractionOperation = result;
      return result;
    }
    if (path === "submit")
      return parseExtractionAcceptedResult(
        envelope.result,
        submission!,
        expectedHash,
        selectedExtractionOperation ?? undefined,
        expectedManifest,
      );
    if (path === "receipt") {
      if (envelope.result === null) return null;
      const result = parseExtractionReceiptResult(envelope.result);
      if (result.receipt_id !== record(request, "receipt request").receipt_id)
        throw new Error("回执与当前选择不匹配");
      return result;
    }
    const cleanup = record(envelope.result, "cleanup result");
    if (
      Object.keys(cleanup).sort().join() !==
        ["receipts_deleted", "operations_deleted"].sort().join() ||
      !Number.isSafeInteger(cleanup.receipts_deleted) ||
      !Number.isSafeInteger(cleanup.operations_deleted)
    )
      throw new Error("清理结果无效");
    return cleanup;
  }
  return {
    post: extractionPost,
    setPreparation(value: string) {
      preparation = value;
    },
  };
}
