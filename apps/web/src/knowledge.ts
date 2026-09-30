import {
  createInputManifest,
  parseDocumentReadRequest,
  parseDocumentReadResult,
  parseKnowledgeAnalysisReceipt,
  parseKnowledgeAnalysisRequest,
  parseKnowledgeLongAnalysisRequest,
  parseKnowledgeReadSelection,
  parseKnowledgeReadResult,
  parseKnowledgeListSelection,
  parseKnowledgeListResult,
  parseLiteratureDetail,
  parseLiteratureId,
  parseStrictJsonValue,
  type EvidenceRef,
  type KnowledgeArtifact,
} from "@sciretriever/contracts";
import { record } from "./wire.js";

function node<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing knowledge element: ${id}`);
  return found as T;
}
function exact(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  const result = record(value, "knowledge response");
  if (Object.keys(result).sort().join() !== [...keys].sort().join())
    throw new Error("知识响应无效");
  return result;
}
async function responseObject(
  response: Response,
  limit: number,
): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("知识响应无效");
  const parts: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error("知识响应过大");
    }
    parts.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return record(parseStrictJsonValue(bytes), "knowledge response");
}
export async function post(
  path: string,
  request: unknown,
  signal: AbortSignal,
  maintenance = false,
): Promise<unknown> {
  let csrf: string | null = null;
  if (maintenance) {
    const session = await fetch("/api/v1/maintenance/session", { signal });
    if (!session.ok) throw new Error("维护会话不可用");
    const grant = exact(await responseObject(session, 4096), [
      "protocol_version",
      "csrf",
    ]);
    if (grant.protocol_version !== 1 || typeof grant.csrf !== "string")
      throw new Error("维护会话无效");
    csrf = grant.csrf;
  }
  const response = await fetch(
    `/api/v1/${maintenance ? "maintenance" : "query"}/${path}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(csrf === null
          ? {}
          : {
              "X-Sciretriever-Protocol-Version": "1",
              "X-Sciretriever-Csrf": csrf,
            }),
      },
      body: JSON.stringify({ protocol_version: 1, request }),
      signal,
    },
  );
  const resultKey = path === "read" ? "detail" : "result";
  const envelope = response.ok
    ? exact(
        await responseObject(
          response,
          maintenance ? 1300 * 1024 : 25 * 1024 * 1024,
        ),
        ["protocol_version", resultKey],
      )
    : await responseObject(response, 8192);
  if (envelope.protocol_version !== 1) throw new Error("知识响应无效");
  if (!response.ok) {
    if (typeof envelope.code !== "string") throw new Error("知识响应无效");
    const keys = Object.keys(envelope).sort().join(",");
    if (
      keys !== "code,protocol_version" &&
      keys !== "code,protocol_version,reason,retryable"
    )
      throw new Error("知识响应无效");
    if (
      keys.includes("reason") &&
      (typeof envelope.reason !== "string" ||
        typeof envelope.retryable !== "boolean")
    )
      throw new Error("知识响应无效");
    throw new Error(
      envelope.reason ? `${envelope.code} (${envelope.reason})` : envelope.code,
    );
  }
  return envelope[resultKey];
}
async function readDocument<K extends "material" | "default" | "describe">(
  kind: K,
  value: Parameters<typeof parseDocumentReadRequest<K>>[1],
  signal: AbortSignal,
) {
  const request = parseDocumentReadRequest(kind, value);
  const result = await post(
    kind === "material" ? "material-evidence" : `document-${kind}`,
    request,
    signal,
  );
  return parseDocumentReadResult(kind, result, request);
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}

export function mountKnowledgeMaintenance(): void {
  const start = node<HTMLButtonElement>("knowledge-start");
  const cancel = node<HTMLButtonElement>("knowledge-cancel");
  const status = node("knowledge-status");
  const result = node("knowledge-result");
  const fields = [
    "knowledge-literature-id",
    "knowledge-purpose",
    "knowledge-mode",
    "knowledge-question",
    "knowledge-default-mode",
    "knowledge-default-revision",
    "knowledge-input-bytes",
    "knowledge-output-tokens",
    "knowledge-call-bytes",
    "knowledge-total-call-bytes",
    "knowledge-max-calls",
    "knowledge-total-output-tokens",
  ].map((id) =>
    node<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(id),
  );
  let active: AbortController | null = null;
  const mode = node<HTMLSelectElement>("knowledge-mode");
  mode.addEventListener("change", () => {
    const long = mode.value === "long";
    node("knowledge-long-budget").hidden = !long;
    const sourceLimit = node<HTMLInputElement>("knowledge-input-bytes");
    sourceLimit.max = long ? "8388608" : "262144";
    sourceLimit.value = long ? "8388608" : "262144";
  });
  let generation = 0;
  window.addEventListener("pagehide", () => active?.abort());
  cancel.addEventListener("click", () => {
    if (!active) return;
    generation++;
    active.abort();
    active = null;
    status.textContent =
      "请求已取消；若发布已提交，历史产物仍保留，可在只读文献库核对。";
    start.disabled = false;
    cancel.disabled = true;
    for (const field of fields) field.disabled = false;
  });
  start.addEventListener("click", () => {
    if (active) return;
    const controller = new AbortController();
    active = controller;
    const current = ++generation;
    start.disabled = true;
    cancel.disabled = false;
    for (const field of fields) field.disabled = true;
    status.textContent = "正在核对已接纳材料与可读文档…";
    result.textContent = "";
    void (async () => {
      const literatureId = String(
        parseLiteratureId(
          node<HTMLInputElement>("knowledge-literature-id").value.trim(),
        ),
      );
      const purpose = node<HTMLSelectElement>("knowledge-purpose").value;
      const question =
        purpose === "question"
          ? node<HTMLTextAreaElement>("knowledge-question").value
          : null;
      const revisionText = node<HTMLInputElement>(
        "knowledge-default-revision",
      ).value.trim();
      const defaultUpdate =
        node<HTMLSelectElement>("knowledge-default-mode").value ===
        "publish-only"
          ? null
          : {
              expected_revision:
                revisionText === "" ? null : Number(revisionText),
            };
      const detail = await parseLiteratureDetail(
        await post("read", { literature_id: literatureId }, controller.signal),
      );
      if (detail.literature.literature_id !== literatureId)
        throw new Error("文献响应错绑");
      const pdf = detail.primary_pdf?.asset;
      if (!pdf) throw new Error("该文献没有已接纳的主 PDF");
      const material = await readDocument(
        "material",
        { literature_id: literatureId, asset_id: pdf.asset_id },
        controller.signal,
      );
      if (
        material.evidence.target_kind !== "material" ||
        material.evidence.material.asset_sha256 !== pdf.sha256
      )
        throw new Error("材料证据错绑");
      const currentDocument = await readDocument(
        "default",
        {
          literature_id: literatureId,
          asset_id: pdf.asset_id,
          asset_sha256: pdf.sha256,
        },
        controller.signal,
      );
      if (!currentDocument.default) throw new Error("该 PDF 尚无可读文档版本");
      const described = await readDocument(
        "describe",
        {
          document_version_id: currentDocument.default.document_version_id,
        },
        controller.signal,
      );
      if (
        described.document.source_material_ref.asset_id !== pdf.asset_id ||
        described.document.source_material_ref.asset_sha256 !== pdf.sha256 ||
        described.document.source_material_ref.literature_id !== literatureId ||
        !described.capabilities.text
      )
        throw new Error("文档表示与材料不匹配或不支持文本");
      const manifest = await createInputManifest([
        {
          input_id: "source-1",
          literature_id: literatureId,
          material: material.evidence.material,
          document: described.document,
          capabilities: [
            "material-file-v1",
            "document-segment-v1",
            "document-text-v1",
            ...(described.capabilities.outline
              ? ["document-outline-v1" as const]
              : []),
            ...(described.capabilities.resources
              ? ["document-resources-v1" as const]
              : []),
          ],
          gaps: [],
        },
      ]);
      const long = mode.value === "long";
      const shared = {
        input: manifest,
        purpose,
        question,
        default_update: defaultUpdate,
      };
      const sourceBytes = Number(
        node<HTMLInputElement>("knowledge-input-bytes").value,
      );
      const outputTokens = Number(
        node<HTMLInputElement>("knowledge-output-tokens").value,
      );
      const request = long
        ? await parseKnowledgeLongAnalysisRequest({
            schema_version: 2,
            ...shared,
            budget: {
              max_source_bytes: sourceBytes,
              max_call_bytes: Number(
                node<HTMLInputElement>("knowledge-call-bytes").value,
              ),
              max_total_call_bytes: Number(
                node<HTMLInputElement>("knowledge-total-call-bytes").value,
              ),
              max_calls: Number(
                node<HTMLInputElement>("knowledge-max-calls").value,
              ),
              max_output_tokens_per_call: outputTokens,
              max_total_output_tokens: Number(
                node<HTMLInputElement>("knowledge-total-output-tokens").value,
              ),
            },
          })
        : await parseKnowledgeAnalysisRequest({
            schema_version: 1,
            ...shared,
            budget: {
              max_input_bytes: sourceBytes,
              max_output_tokens: outputTokens,
            },
          });
      if (current !== generation) return;
      status.textContent = `输入已固定：文档 ${described.document.document_version_id}。正在生成知识…`;
      const receipt = await parseKnowledgeAnalysisReceipt(
        await post(
          long ? "analyze-knowledge-long" : "analyze-knowledge",
          request,
          controller.signal,
          true,
        ),
        request,
      );
      if (
        receipt.artifact.input.manifest_sha256 !== manifest.manifest_sha256 ||
        receipt.artifact.purpose !== request.purpose ||
        receipt.artifact.question !== request.question ||
        receipt.artifact.input.items[0]?.literature_id !== literatureId
      )
        throw new Error("知识回执与请求不匹配");
      if (current !== generation) return;
      const defaultStatus =
        receipt.default_update_outcome === "updated"
          ? `默认视图 revision ${receipt.default_revision}`
          : receipt.default_update_outcome === "conflict"
            ? `默认视图 CAS 冲突（当前 revision ${receipt.default_revision ?? "无"}）`
            : receipt.default_update_outcome === "cancelled"
              ? "默认视图更新已取消"
              : receipt.default_update_outcome === "failed"
                ? `默认视图更新失败（${receipt.default_update_failure}）`
                : "未请求默认视图更新";
      status.textContent = `知识 ${receipt.artifact.artifact_id} ${receipt.published ? "已发布" : "已存在"}；${defaultStatus}。`;
      result.textContent = JSON.stringify(receipt.artifact.content, null, 2);
    })()
      .catch((error: unknown) => {
        if (current === generation)
          status.textContent = `分析失败：${message(error)}`;
      })
      .finally(() => {
        if (current !== generation) return;
        active = null;
        start.disabled = false;
        cancel.disabled = true;
        for (const field of fields) field.disabled = false;
      });
  });
}

function line(tag: string, value: string): HTMLElement {
  const element = document.createElement(tag);
  element.textContent = value;
  return element;
}
/** Shared bounded evidence reader for single-document and collection views. */
export function verifiedEvidenceEntry(
  item: EvidenceRef,
  bound: {
    readonly literature_id: string;
    readonly asset_id: string;
    readonly asset_sha256: string;
  },
  signal: AbortSignal,
): HTMLElement {
  const entry = document.createElement("li");
  entry.append(
    line(
      "span",
      item.target_kind === "document"
        ? `文档 ${item.document_version_id} · ${item.locator.kind === "segment" ? `片段 ${item.locator.segment_id}` : JSON.stringify(item.locator)} · SHA-256 ${item.content_sha256}`
        : `材料 ${item.material.asset_id} · SHA-256 ${item.content_sha256}`,
    ),
  );
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "展开证据";
  const detail = document.createElement("pre");
  const progress = document.createElement("p");
  let cursor: string | null = null;
  let target: { start_utf8: number; end_utf8: number } | null = null;
  let lastEnd: number | null = null;
  const chunks: string[] = [];
  button.addEventListener("click", () => {
    button.disabled = true;
    progress.textContent = "正在核对原文…";
    void (async () => {
      const request = parseDocumentReadRequest("evidence", {
        evidence: item,
        max_bytes: 65536,
        continuation: cursor,
      });
      const resolved = parseDocumentReadResult(
        "evidence",
        await post("evidence-resolve", request, signal),
        request,
      );
      if (item.target_kind === "material") {
        if (
          resolved.granularity !== "file" ||
          !resolved.material ||
          resolved.material.literature_id !== bound.literature_id ||
          resolved.material.asset_id !== bound.asset_id ||
          resolved.material.asset_sha256 !== bound.asset_sha256
        )
          throw new Error("文件证据与固定材料不一致");
        if (!entry.isConnected || signal.aborted) return;
        progress.textContent = "已核对文件级证据；原 PDF 正文需另行打开。";
        button.remove();
        return;
      }
      if (
        resolved.granularity !== "segment" ||
        item.target_kind !== "document" ||
        !resolved.document ||
        !resolved.target_range ||
        !resolved.actual_range ||
        typeof resolved.text !== "string" ||
        typeof resolved.truncated !== "boolean" ||
        resolved.continuation === undefined ||
        resolved.document.document_version_id !== item.document_version_id ||
        resolved.document.representation_sha256 !==
          item.representation_sha256 ||
        resolved.document.source_material_ref.literature_id !==
          bound.literature_id ||
        resolved.document.source_material_ref.asset_id !== bound.asset_id ||
        resolved.document.source_material_ref.asset_sha256 !==
          bound.asset_sha256 ||
        (target !== null &&
          (target.start_utf8 !== resolved.target_range.start_utf8 ||
            target.end_utf8 !== resolved.target_range.end_utf8)) ||
        (lastEnd !== null && resolved.actual_range.start_utf8 !== lastEnd) ||
        resolved.truncated !==
          resolved.actual_range.end_utf8 < resolved.target_range.end_utf8
      )
        throw new Error("证据续读结果不连续");
      if (!entry.isConnected || signal.aborted) return;
      chunks.push(resolved.text);
      const range = resolved.target_range;
      const end = resolved.actual_range.end_utf8;
      target = range;
      lastEnd = end;
      cursor = resolved.continuation;
      detail.textContent = chunks.join("");
      progress.textContent = resolved.truncated
        ? `已读取 ${end - range.start_utf8}/${range.end_utf8 - range.start_utf8} 字节（部分），可继续读取。`
        : `已读取完整证据（${range.end_utf8 - range.start_utf8} 字节）。`;
      if (cursor === null) button.remove();
      else button.textContent = "继续读取证据";
    })()
      .catch((error: unknown) => {
        if (entry.isConnected && !signal.aborted)
          progress.textContent = `证据读取失败：${message(error)}`;
      })
      .finally(() => {
        button.disabled = false;
      });
  });
  entry.append(button, progress, detail);
  return entry;
}
export function renderKnowledgeArtifact(
  artifact: KnowledgeArtifact,
  root: HTMLElement,
  signal: AbortSignal,
  statementId?: string,
): void {
  root.replaceChildren();
  root.append(line("h3", artifact.content.title));
  root.append(
    line(
      "p",
      `${artifact.purpose}${artifact.question ? ` · ${artifact.question}` : ""} · ${artifact.artifact_id}`,
    ),
  );
  root.append(
    line(
      "p",
      `输入 ${artifact.input.items[0]?.document?.document_version_id} · 方法 ${artifact.method.id} ${artifact.method.version} · ${artifact.provenance.provider}/${artifact.provenance.model}`,
    ),
  );
  for (const statement of artifact.content.statements) {
    if (statementId && statement.statement_id !== statementId) continue;
    const section = document.createElement("section");
    section.className = "config-card";
    section.append(
      line(
        "h4",
        `${statement.category} · ${statement.epistemic} · ${statement.statement_id}`,
      ),
    );
    section.append(line("p", statement.text));
    if (statement.conditions.length)
      section.append(line("p", `条件：${statement.conditions.join("；")}`));
    if (statement.quantity)
      section.append(
        line(
          "p",
          `数量：${statement.quantity.value} ${statement.quantity.unit}${statement.quantity.comparison_basis ? ` · ${statement.quantity.comparison_basis}` : ""}`,
        ),
      );
    const evidence = document.createElement("ul");
    for (const item of statement.evidence) {
      evidence.append(
        verifiedEvidenceEntry(
          item,
          {
            literature_id: artifact.input.items[0]!.literature_id,
            asset_id: artifact.input.items[0]!.material!.asset_id,
            asset_sha256: artifact.input.items[0]!.material!.asset_sha256,
          },
          signal,
        ),
      );
    }
    section.append(evidence);
    root.append(section);
  }
  root.append(
    line(
      "p",
      `覆盖 ${artifact.coverage.covered_segments}/${artifact.coverage.total_segments} 片段，${artifact.coverage.covered_utf8_bytes}/${artifact.coverage.total_utf8_bytes} 字节；能力缺口：${artifact.coverage.capability_gaps.join("、") || "无"}。`,
    ),
  );
}

export function mountKnowledgeReading(): void {
  const listButton = node<HTMLButtonElement>("knowledge-list-submit");
  const readButton = node<HTMLButtonElement>("knowledge-read-submit");
  const literatureField = node<HTMLInputElement>(
    "knowledge-list-literature-id",
  );
  const idField = node<HTMLInputElement>("knowledge-read-id");
  const status = node("knowledge-read-status");
  const listRoot = node("knowledge-list-results");
  const detailRoot = node("knowledge-read-result");
  let generation = 0;
  let active: AbortController | null = null;
  const invalidate = () => {
    generation++;
    active?.abort();
    active = null;
    listButton.disabled = false;
    readButton.disabled = false;
    listRoot.replaceChildren();
    detailRoot.replaceChildren();
    status.textContent = "选择已更改，请重新读取。";
  };
  literatureField.addEventListener("input", invalidate);
  idField.addEventListener("input", () => {
    generation++;
    active?.abort();
    active = null;
    listButton.disabled = false;
    readButton.disabled = false;
    detailRoot.replaceChildren();
  });
  window.addEventListener("pagehide", () => active?.abort());
  const run = (
    task: (signal: AbortSignal) => Promise<void>,
    retainForEvidence = false,
  ) => {
    active?.abort();
    const controller = new AbortController();
    active = controller;
    const started = ++generation;
    listButton.disabled = true;
    readButton.disabled = true;
    void task(controller.signal)
      .catch((error: unknown) => {
        if (generation === started)
          status.textContent = `读取失败：${message(error)}`;
      })
      .finally(() => {
        if (generation !== started) return;
        if (!retainForEvidence || !detailRoot.hasChildNodes()) active = null;
        listButton.disabled = false;
        readButton.disabled = false;
      });
  };
  listButton.addEventListener("click", () =>
    run(async (signal) => {
      detailRoot.replaceChildren();
      const literatureId = String(
        parseLiteratureId(literatureField.value.trim()),
      );
      status.textContent = "正在读取历史知识…";
      const selection = parseKnowledgeListSelection({
        literature_id: literatureId,
        limit: 10,
      });
      const items = await parseKnowledgeListResult(
        await post("knowledge-list", selection, signal),
        selection,
      );
      if (signal.aborted) return;
      listRoot.replaceChildren();
      for (const item of items) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = `${item.purpose} · ${item.content.title} · ${item.artifact_id}`;
        button.addEventListener("click", () => {
          idField.value = item.artifact_id;
          readButton.click();
        });
        listRoot.append(button);
      }
      status.textContent = `找到 ${items.length} 项历史知识。`;
    }),
  );
  readButton.addEventListener("click", () =>
    run(async (signal) => {
      detailRoot.replaceChildren();
      const selection = parseKnowledgeReadSelection({
        artifact_id: idField.value.trim(),
      });
      const id = selection.artifact_id;
      const literatureId = literatureField.value.trim();
      const expectedLiterature = literatureId
        ? String(parseLiteratureId(literatureId))
        : null;
      status.textContent = "正在核对知识产物与证据引用…";
      const artifact = await parseKnowledgeReadResult(
        await post("knowledge-read", selection, signal),
        selection,
      );
      if (
        artifact.artifact_id !== id ||
        (expectedLiterature !== null &&
          artifact.input.items[0]?.literature_id !== expectedLiterature)
      )
        throw new Error("知识产物与选择不匹配");
      if (signal.aborted) return;
      renderKnowledgeArtifact(artifact, detailRoot, signal);
      status.textContent = `已读取 ${artifact.artifact_id}。`;
    }, true),
  );
}
