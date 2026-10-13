import { mountLibrary } from "./library.js";
import { record } from "./wire.js";
import { onWorkspace } from "./navigation.js";
import {
  mountKnowledgeReading,
  configureDataTransport,
  dataFetch,
  type DataFetch,
  post as knowledgePost,
  renderKnowledgeArtifact,
  verifiedEvidenceEntry,
} from "./knowledge.js";
import { mountSynthesisReading, renderSynthesisSource } from "./synthesis.js";
import {
  parseDocumentReadRequest,
  parseDocumentReadResult,
  parseMaterialContextBundle,
  parseMaterialContextRequest,
  parseKnowledgeContextBundle,
  parseKnowledgeContextRequest,
  parseSynthesisReadSelection,
  parseSynthesisSourceResult,
  knowledgeStatementSha256,
  synthesisStatementSha256,
  extractionSpecHash,
  parseExtractionPreparationRequest,
  parseExtractionPreparationResult,
  parseStrictJsonValue,
  type ExtractionSpec,
  type MaterialContextRequest,
  type KnowledgeContextRequest,
} from "@sciretriever/contracts";

type QueryReadiness = "ready" | "not-initialized" | "unavailable";

function node<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`missing query page element: ${id}`);
  return value as T;
}
async function strictPreparationEnvelope(
  response: Response,
): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("invalid-response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > 512 * 1024) {
      await reader.cancel();
      throw new Error("invalid-response");
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return record(parseStrictJsonValue(bytes), "extraction preparation");
}

function showReadiness(status: QueryReadiness): void {
  const messages: Record<QueryReadiness, string> = {
    ready: "文献库已就绪 · 只读查询",
    "not-initialized":
      "文献库尚未初始化；只读查询不会创建 catalog，请先通过显式维护初始化。",
    unavailable: "文献库暂不可用，可能需要显式维护；只读查询不会重建或修复它。",
  };
  node("library-status").textContent = messages[status];
  document.documentElement.dataset.queryReadiness = status;
  if (status !== "ready") {
    node("library-results").replaceChildren(
      Object.assign(document.createElement("p"), {
        className: "library-empty",
        textContent: messages[status],
      }),
    );
    node<HTMLFormElement>("library-form")
      .querySelectorAll("input, button, select")
      .forEach((control) => {
        (
          control as HTMLInputElement | HTMLButtonElement | HTMLSelectElement
        ).disabled = true;
      });
    node<HTMLFormElement>("context-form")
      .querySelectorAll("input, button")
      .forEach((control) => {
        (control as HTMLInputElement | HTMLButtonElement).disabled = true;
      });
    node<HTMLFormElement>("knowledge-context-form")
      .querySelectorAll("input, button, select")
      .forEach((control) => {
        (
          control as HTMLInputElement | HTMLButtonElement | HTMLSelectElement
        ).disabled = true;
      });
    node<HTMLFormElement>("extraction-prepare-form")
      .querySelectorAll("textarea, button")
      .forEach((control) => {
        (control as HTMLTextAreaElement | HTMLButtonElement).disabled = true;
      });
  }
}

function mountExtractionPreparation(): void {
  const form = node<HTMLFormElement>("extraction-prepare-form");
  const status = node<HTMLElement>("extraction-prepare-status");
  const output = node<HTMLElement>("extraction-prepare-result");
  const button = node<HTMLButtonElement>("extraction-prepare-submit");
  const specField = node<HTMLTextAreaElement>("extraction-spec");
  const inputsField = node<HTMLTextAreaElement>("extraction-inputs");
  const controls = [specField, inputsField, button];
  let busy = false;
  let revision = 0;
  for (const field of [specField, inputsField])
    field.addEventListener("input", () => {
      revision++;
      status.textContent = "输入已修改，请重新检查。";
      output.textContent = "";
    });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    const started = revision;
    for (const control of controls) control.disabled = true;
    status.textContent = "正在校验规范并读取已接纳的材料…";
    output.textContent = "";
    void (async () => {
      const rawSpec = record(
        parseStrictJsonValue(specField.value),
        "extraction spec",
      );
      const inputs: unknown = parseStrictJsonValue(inputsField.value);
      const spec = Object.hasOwn(rawSpec, "spec_sha256")
        ? rawSpec
        : {
            ...rawSpec,
            spec_sha256: await extractionSpecHash(
              rawSpec as unknown as Omit<ExtractionSpec, "spec_sha256">,
            ),
          };
      const prepared = await parseExtractionPreparationRequest({
        spec,
        inputs,
      });
      const response = await dataFetch("/api/v1/query/extraction-prepare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          protocol_version: 1,
          request: prepared,
        }),
      });
      const envelope = await strictPreparationEnvelope(response);
      if (!response.ok) throw new Error(String(envelope.code ?? "准备失败"));
      if (envelope.protocol_version !== 1) throw new Error("invalid-response");
      const result = await parseExtractionPreparationResult(
        envelope.result,
        prepared,
      );
      if (revision !== started) return;
      status.textContent = `已固定 ${result.manifest.items.length} 项输入 · ${result.missing_required_capabilities.length} 项存在规范能力缺口；候选提交需要 Catalog v5。`;
      output.textContent = JSON.stringify(result, null, 2);
      const delivery = document.getElementById(
        "extraction-prepared",
      ) as HTMLTextAreaElement | null;
      if (delivery) {
        delivery.value = JSON.stringify(result, null, 2);
        delivery.dispatchEvent(new Event("input"));
        status.textContent += " 输入已填入任务页的提取交付表单。";
      }
    })()
      .catch((error: unknown) => {
        if (revision === started)
          status.textContent = `准备失败：${error instanceof Error ? error.message : "未知错误"}`;
      })
      .finally(() => {
        busy = false;
        if (document.documentElement.dataset.queryReadiness === "ready")
          for (const control of controls) control.disabled = false;
      });
  });
}

async function status(): Promise<QueryReadiness> {
  const response = await dataFetch("/api/v1/query/status");
  const value = record(await response.json(), "query status");
  const readiness = record(value.readiness, "query readiness");
  if (!response.ok || value.protocol_version !== 1) return "unavailable";
  const result = readiness.status;
  return result === "ready" || result === "not-initialized"
    ? result
    : "unavailable";
}

const endpoints: Record<string, string> = {
  "/api/library/search": "/api/v1/query/search",
  "/api/library/detail": "/api/v1/query/read",
  "/api/library/references": "/api/v1/query/references",
  "/api/library/reference": "/api/v1/query/reference",
  "/api/document/default": "/api/v1/query/document-default",
  "/api/document/describe": "/api/v1/query/document-describe",
  "/api/document/outline": "/api/v1/query/document-outline",
  "/api/document/segments": "/api/v1/query/document-segments",
  "/api/document/slice": "/api/v1/query/document-slice",
  "/api/document/resources": "/api/v1/query/document-resources",
  "/api/document/resource": "/api/v1/query/document-resource",
  "/api/document/material-evidence": "/api/v1/query/material-evidence",
  "/api/document/evidence-resolve": "/api/v1/query/evidence-resolve",
  "/api/context/search": "/api/v1/query/context",
};

export async function queryRequest(
  path: string,
  request: unknown,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const endpoint = endpoints[path];
  if (!endpoint) throw new Error("query-endpoint-unavailable");
  const response = await dataFetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ protocol_version: 1, request }),
    ...(signal ? { signal } : {}),
  });
  let value: Record<string, unknown>;
  try {
    value = record(await response.json(), "query response");
  } catch {
    throw new Error("query-unavailable");
  }
  if (value.protocol_version !== 1) throw new Error("query-unavailable");
  if (!response.ok)
    throw new Error(
      typeof value.code === "string" ? value.code : "query-unavailable",
    );
  return value;
}

export async function queryDownload(
  id: string,
  kind: "primary-pdf" | "content-markdown",
): Promise<void> {
  const response = await dataFetch("/api/v1/query/artifact", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      protocol_version: 1,
      request: { literature_id: id, kind },
    }),
  });
  if (response.headers.get("Content-Type")?.startsWith("application/json")) {
    const value = record(await response.json(), "query artifact response");
    if (value.protocol_version !== 1) throw new Error("artifact-unavailable");
    const gap = value.gap;
    if (gap && typeof gap === "object" && !Array.isArray(gap)) {
      const code = (gap as Record<string, unknown>).code;
      if (
        code === "missing-primary-pdf" ||
        code === "missing-literature-content"
      )
        throw new Error(code);
    }
    if (!response.ok)
      throw new Error(
        typeof value.code === "string" ? value.code : "artifact-unavailable",
      );
    throw new Error("artifact-unavailable");
  }
  if (!response.ok) throw new Error("artifact-unavailable");
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = `${id}.${kind === "primary-pdf" ? "pdf" : "md"}`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function mountContext(): void {
  const form = node<HTMLFormElement>("context-form");
  const status = node("context-status");
  const results = node("context-results");
  const more = node<HTMLButtonElement>("context-more");
  let current: MaterialContextRequest | null = null;
  let busy = false;
  const search = async (request: MaterialContextRequest, append: boolean) => {
    if (busy) return;
    busy = true;
    more.hidden = true;
    node<HTMLButtonElement>("context-submit").disabled = true;
    status.textContent = "正在查找已保存材料…";
    try {
      const payload = await queryRequest("/api/context/search", request);
      const bundle = parseMaterialContextBundle(payload.result, request);
      if (!append) results.replaceChildren();
      for (const item of bundle.items) {
        const card = document.createElement("article");
        card.className = "config-card";
        const heading = document.createElement("h3");
        heading.textContent = `${item.rank}. ${item.kind === "metadata" ? "元数据" : (item.section_title ?? "原文片段")}`;
        const source = document.createElement("p");
        source.textContent = `Literature ${item.literature_id} · ${item.reference.kind === "document" ? `版本 ${item.reference.document_version_id}` : `元数据 revision ${item.reference.metadata_revision}`}`;
        const body = document.createElement("pre");
        body.textContent =
          item.text ||
          (item.gap === "context-too-large"
            ? "该片段超过预算，可按固定版本继续读取。"
            : "此片段的证据超过单次上限。");
        card.append(heading, source, body);
        if (item.reference.kind === "document") {
          const reference = item.reference;
          const read = document.createElement("button");
          read.type = "button";
          read.textContent = "按固定版本继续读取";
          let continuation: string | null = null;
          let started = false;
          let expectedStart = reference.start_utf8;
          const full = document.createElement("pre");
          read.addEventListener("click", () => {
            read.disabled = true;
            void (async () => {
              const selected = parseDocumentReadRequest("slice", {
                document_version_id: reference.document_version_id,
                selector: {
                  kind: "range",
                  start_utf8: reference.start_utf8,
                  end_utf8: reference.end_utf8,
                },
                max_bytes: 65536,
                continuation,
              });
              const reply = await queryRequest("/api/document/slice", selected);
              const slice = parseDocumentReadResult(
                "slice",
                reply.result,
                selected,
              );
              if (
                slice.document.representation_sha256 !==
                  reference.representation_sha256 ||
                slice.document.source_material_ref.literature_id !==
                  reference.literature_id ||
                slice.document.source_material_ref.asset_id !==
                  reference.asset_id ||
                slice.document.source_material_ref.asset_sha256 !==
                  reference.asset_sha256 ||
                slice.actual_range === null ||
                slice.actual_range.start_utf8 !== expectedStart ||
                slice.actual_range.end_utf8 > reference.end_utf8 ||
                slice.truncated !==
                  slice.actual_range.end_utf8 < reference.end_utf8
              )
                throw new Error("固定版本续读结果不连续");
              if (!started) {
                full.textContent = "";
                card.append(full);
                started = true;
              }
              full.textContent += slice.text;
              expectedStart = slice.actual_range.end_utf8;
              continuation = slice.continuation;
              if (continuation === null) read.remove();
              else read.disabled = false;
            })().catch((error: unknown) => {
              full.textContent = `读取失败：${error instanceof Error ? error.message : "未知错误"}`;
              if (!started) card.append(full);
              read.disabled = false;
            });
          });
          card.append(read);
          for (const [index, evidence] of item.evidence.entries()) {
            const resolve = document.createElement("button");
            resolve.type = "button";
            resolve.textContent = `解析证据 ${index + 1}`;
            const detail = document.createElement("pre");
            let evidenceCursor: string | null = null;
            let target: { start_utf8: number; end_utf8: number } | null = null;
            let evidenceEnd: number | null = null;
            resolve.addEventListener("click", () => {
              resolve.disabled = true;
              void (async () => {
                const selected = parseDocumentReadRequest("evidence", {
                  evidence,
                  max_bytes: 65536,
                  continuation: evidenceCursor,
                });
                const reply = await queryRequest(
                  "/api/document/evidence-resolve",
                  selected,
                );
                const resolved = parseDocumentReadResult(
                  "evidence",
                  reply.result,
                  selected,
                );
                if (
                  resolved.granularity !== "segment" ||
                  !resolved.document ||
                  !resolved.target_range ||
                  !resolved.actual_range ||
                  typeof resolved.text !== "string" ||
                  typeof resolved.truncated !== "boolean" ||
                  resolved.continuation === undefined
                )
                  throw new Error("证据回执无效");
                if (
                  resolved.document.document_version_id !==
                    reference.document_version_id ||
                  resolved.document.representation_sha256 !==
                    reference.representation_sha256 ||
                  resolved.document.source_material_ref.literature_id !==
                    reference.literature_id ||
                  resolved.document.source_material_ref.asset_id !==
                    reference.asset_id ||
                  resolved.document.source_material_ref.asset_sha256 !==
                    reference.asset_sha256 ||
                  (target !== null &&
                    (target.start_utf8 !== resolved.target_range.start_utf8 ||
                      target.end_utf8 !== resolved.target_range.end_utf8)) ||
                  (evidenceEnd !== null &&
                    resolved.actual_range.start_utf8 !== evidenceEnd) ||
                  resolved.truncated !==
                    resolved.actual_range.end_utf8 <
                      resolved.target_range.end_utf8
                )
                  throw new Error("证据续读结果不连续");
                target = resolved.target_range;
                evidenceEnd = resolved.actual_range.end_utf8;
                detail.textContent += resolved.text;
                if (!detail.isConnected) card.append(detail);
                evidenceCursor = resolved.continuation;
                if (evidenceCursor === null) resolve.remove();
                else resolve.disabled = false;
              })().catch((error: unknown) => {
                detail.textContent = `证据解析失败：${error instanceof Error ? error.message : "未知错误"}`;
                if (!detail.isConnected) card.append(detail);
                resolve.disabled = false;
              });
            });
            card.append(resolve);
          }
        }
        results.append(card);
      }
      status.textContent = `覆盖：${bundle.coverage} · ${bundle.usage.items} 项 · ${bundle.usage.bytes} 字节${bundle.gaps.length ? ` · 缺口：${bundle.gaps.map((gap) => gap.code).join("、")}` : ""}`;
      current = request;
      more.hidden = bundle.continuation === null;
      more.dataset.continuation = bundle.continuation ?? "";
    } catch (error) {
      status.textContent = `材料查找失败：${error instanceof Error ? error.message : "未知错误"}`;
    } finally {
      busy = false;
      node<HTMLButtonElement>("context-submit").disabled = false;
    }
  };
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const literatureId = node<HTMLInputElement>(
      "context-literature-id",
    ).value.trim();
    try {
      const request = parseMaterialContextRequest({
        query: node<HTMLInputElement>("context-query").value,
        scope: literatureId
          ? { kind: "literatures", literature_ids: [literatureId] }
          : { kind: "library" },
        kinds: ["metadata", "document"],
        versions: { kind: "default" },
        budget: {
          max_items: 10,
          max_bytes: Number(node<HTMLInputElement>("context-max-bytes").value),
          token_limit: null,
        },
        continuation: null,
      });
      void search(request, false);
    } catch {
      status.textContent = "请检查问题、Literature ID 和字节上限。";
    }
  });
  more.addEventListener("click", () => {
    if (!current || !more.dataset.continuation) return;
    void search(
      parseMaterialContextRequest({
        ...current,
        continuation: more.dataset.continuation,
      }),
      true,
    );
  });
}

function mountKnowledgeContext(): void {
  const form = node<HTMLFormElement>("knowledge-context-form");
  const status = node("knowledge-context-status");
  const results = node("knowledge-context-results");
  const more = node<HTMLButtonElement>("knowledge-context-more");
  const submit = node<HTMLButtonElement>("knowledge-context-submit");
  let current: KnowledgeContextRequest | null = null;
  let active: AbortController | null = null;
  let reading = new AbortController();
  let revision = 0;
  const search = (request: KnowledgeContextRequest, append: boolean): void => {
    active?.abort();
    if (!append) {
      reading.abort();
      reading = new AbortController();
    }
    const evidenceSignal = reading.signal;
    const controller = new AbortController();
    active = controller;
    const selected = ++revision;
    submit.disabled = true;
    more.hidden = true;
    status.textContent = "正在查找已索引的材料与知识…";
    void (async () => {
      const bundle = await parseKnowledgeContextBundle(
        await knowledgePost("knowledge-context", request, controller.signal),
        request,
      );
      if (selected !== revision || controller.signal.aborted) return;
      if (!append) results.replaceChildren();
      for (const item of bundle.items) {
        const card = document.createElement("article");
        card.className = "config-card";
        const heading = document.createElement("h3");
        heading.textContent = `${item.rank}. ${item.kind === "generated-knowledge" ? "生成知识" : item.kind === "source-text" ? "原文片段" : "元数据"} · 分数 ${item.score}`;
        const reference = document.createElement("p");
        const content = document.createElement("pre");
        if (item.kind === "generated-knowledge") {
          reference.textContent = `产物 ${item.reference.artifact_id} · ${item.purpose} · ${item.question ?? "无原始问题"} · 发布覆盖 ${item.coverage_status} · 当前来源 ${item.source_state} · 压缩深度 ${item.compression_depth} · 独立文献 ${item.independent_literature_ids.length}`;
          content.textContent =
            item.statement?.text ?? "正文超过预算；可按固定产物继续读取。";
          if (item.statement?.conditions.length) {
            const conditions = document.createElement("p");
            conditions.textContent = `条件：${item.statement.conditions.join("；")}`;
            card.append(conditions);
          }
          if (item.statement?.quantity) {
            const quantity = document.createElement("p");
            quantity.textContent = `数量：${item.statement.quantity.value} ${item.statement.quantity.unit}${item.statement.quantity.comparison_basis ? ` · ${item.statement.quantity.comparison_basis}` : ""}`;
            card.append(quantity);
          }
          const layers = document.createElement("p");
          layers.textContent = `来源层级：${item.source_layers.map((layer) => `${layer.input_id} ${layer.kind}/${layer.state}${layer.source_artifact_id ? ` (${layer.source_artifact_id})` : ""}`).join("；")}`;
          card.append(heading, reference, content, layers);
          const read = document.createElement("button");
          read.type = "button";
          read.textContent = "按固定产物阅读并展开证据";
          read.addEventListener("click", () => {
            read.disabled = true;
            const detail = document.createElement("section");
            detail.className = "config-card";
            detail.textContent = "正在核对固定产物…";
            card.append(detail);
            void (async () => {
              const selection = parseSynthesisReadSelection({
                artifact_id: item.reference.artifact_id,
              });
              const source = await parseSynthesisSourceResult(
                await knowledgePost(
                  "synthesis-source",
                  selection,
                  evidenceSignal,
                ),
                selection,
              );
              const artifact = source.artifact;
              const statement = artifact.content.statements.find(
                (candidate) =>
                  candidate.statement_id === item.reference.statement_id,
              );
              if (
                artifact.content_ref.sha256 !== item.reference.content_sha256 ||
                artifact.input.manifest_sha256 !==
                  item.reference.manifest_sha256 ||
                artifact.purpose !== item.purpose ||
                artifact.question !== item.question ||
                !statement ||
                (await (artifact.schema_version === 1
                  ? knowledgeStatementSha256(statement)
                  : synthesisStatementSha256(statement))) !==
                  item.reference.statement_sha256
              )
                throw new Error("固定产物或断言与检索引用不匹配");
              if (!card.isConnected || evidenceSignal.aborted) return;
              if (artifact.schema_version === 1)
                renderKnowledgeArtifact(
                  artifact,
                  detail,
                  evidenceSignal,
                  statement.statement_id,
                );
              else
                renderSynthesisSource(
                  artifact,
                  statement.statement_id,
                  detail,
                  evidenceSignal,
                );
              const state = document.createElement("p");
              state.textContent =
                source.state === "source-only"
                  ? "当前仅可核对已存知识；原 PDF 不可复核。"
                  : "当前来源已复核。";
              detail.prepend(state);
              read.remove();
            })().catch((error: unknown) => {
              if (!card.isConnected || evidenceSignal.aborted) return;
              detail.textContent = `固定产物读取失败：${error instanceof Error ? error.message : "未知错误"}`;
              read.disabled = false;
            });
          });
          card.append(read);
        } else {
          reference.textContent = `Literature ${item.literature_id} · ${item.reference.kind === "document" ? `文档版本 ${item.reference.document_version_id}` : `元数据 revision ${item.reference.metadata_revision}`}`;
          content.textContent =
            item.text || "内容超过预算；请按固定来源继续读取。";
          card.append(heading, reference, content);
          if (
            item.kind === "source-text" &&
            item.reference.kind === "document"
          ) {
            const fixed = item.reference;
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = "按固定范围继续读取";
            const output = document.createElement("pre");
            let continuation: string | null = null;
            let nextStart = fixed.start_utf8;
            button.addEventListener("click", () => {
              button.disabled = true;
              void (async () => {
                const selected = parseDocumentReadRequest("slice", {
                  document_version_id: fixed.document_version_id,
                  selector: {
                    kind: "range",
                    start_utf8: fixed.start_utf8,
                    end_utf8: fixed.end_utf8,
                  },
                  max_bytes: 65536,
                  continuation,
                });
                const reply = await queryRequest(
                  "/api/document/slice",
                  selected,
                  evidenceSignal,
                );
                const slice = parseDocumentReadResult(
                  "slice",
                  reply.result,
                  selected,
                );
                if (
                  slice.document.document_version_id !==
                    fixed.document_version_id ||
                  slice.document.representation_sha256 !==
                    fixed.representation_sha256 ||
                  slice.document.source_material_ref.literature_id !==
                    fixed.literature_id ||
                  slice.document.source_material_ref.asset_id !==
                    fixed.asset_id ||
                  slice.document.source_material_ref.asset_sha256 !==
                    fixed.asset_sha256 ||
                  !slice.actual_range ||
                  slice.actual_range.start_utf8 !== nextStart ||
                  slice.actual_range.end_utf8 > fixed.end_utf8 ||
                  slice.truncated !==
                    slice.actual_range.end_utf8 < fixed.end_utf8
                )
                  throw new Error("固定范围续读结果不连续");
                if (!card.isConnected || evidenceSignal.aborted) return;
                output.textContent += slice.text;
                if (!output.isConnected) card.append(output);
                nextStart = slice.actual_range.end_utf8;
                continuation = slice.continuation;
                if (continuation === null) button.remove();
                else button.disabled = false;
              })().catch((error: unknown) => {
                if (!card.isConnected || evidenceSignal.aborted) return;
                output.textContent = `固定范围读取失败：${error instanceof Error ? error.message : "未知错误"}`;
                if (!output.isConnected) card.append(output);
                button.disabled = false;
              });
            });
            card.append(button);
            const evidence = document.createElement("ul");
            for (const proof of item.evidence)
              evidence.append(
                verifiedEvidenceEntry(
                  proof,
                  {
                    literature_id: fixed.literature_id,
                    asset_id: fixed.asset_id,
                    asset_sha256: fixed.asset_sha256,
                  },
                  evidenceSignal,
                ),
              );
            card.append(evidence);
          }
        }
        results.append(card);
      }
      status.textContent = `覆盖：${bundle.coverage} · 本页 ${bundle.usage.items} 项 · ${bundle.usage.bytes} 字节${bundle.gaps.length ? ` · 缺口：${bundle.gaps.map((item) => item.code).join("、")}` : ""}`;
      current = request;
      more.dataset.continuation = bundle.continuation ?? "";
      more.hidden = bundle.continuation === null;
    })()
      .catch((error: unknown) => {
        if (selected === revision && !controller.signal.aborted)
          status.textContent = `知识查找失败：${error instanceof Error ? error.message : "未知错误"}`;
      })
      .finally(() => {
        if (selected === revision) {
          active = null;
          submit.disabled =
            document.documentElement.dataset.queryReadiness !== "ready";
        }
      });
  };
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      const literatureId = node<HTMLInputElement>(
        "knowledge-context-literature-id",
      ).value.trim();
      const purpose = node<HTMLSelectElement>(
        "knowledge-context-purpose",
      ).value;
      const question = node<HTMLInputElement>(
        "knowledge-context-question",
      ).value.trim();
      const purposes =
        purpose === "all"
          ? question
            ? ["question", "synthesis"]
            : ["overview", "detailed", "question", "synthesis"]
          : [purpose];
      const request = parseKnowledgeContextRequest({
        schema_version: 2,
        query: node<HTMLInputElement>("knowledge-context-query").value,
        scope: literatureId
          ? { kind: "literatures", literature_ids: [literatureId] }
          : { kind: "library" },
        kinds: ["metadata", "document", "knowledge"],
        versions: { kind: "default" },
        knowledge: {
          purposes,
          question: question || null,
          selection: "all",
          artifact_ids: [],
        },
        budget: {
          max_items: 10,
          max_bytes: Number(
            node<HTMLInputElement>("knowledge-context-max-bytes").value,
          ),
          token_limit: null,
        },
        continuation: null,
      });
      search(request, false);
    } catch {
      status.textContent = "请检查问题、用途、Literature ID 和字节上限。";
    }
  });
  more.addEventListener("click", () => {
    if (!current || !more.dataset.continuation) return;
    search(
      parseKnowledgeContextRequest({
        ...current,
        continuation: more.dataset.continuation,
      }),
      true,
    );
  });
  window.addEventListener("pagehide", () => {
    active?.abort();
    reading.abort();
  });
}

function expandReader(field: HTMLElement): void {
  for (
    let parent: HTMLElement | null = field;
    parent;
    parent = parent.parentElement
  )
    if (parent instanceof HTMLDetailsElement) parent.open = true;
}

export async function mountQueryWorkbench(
  options: {
    fetch?: DataFetch;
    mountLibrary?: boolean;
  } = {},
): Promise<void> {
  configureDataTransport(options);
  try {
    const readiness = await status();
    showReadiness(readiness);
    if (readiness !== "ready") return;
    if (options.mountLibrary !== false)
      mountLibrary({
        queryOnly: true,
        request: queryRequest,
        download: queryDownload,
        currentArticle: () => undefined,
      });
    mountContext();
    mountKnowledgeContext();
    mountExtractionPreparation();
    mountKnowledgeReading();
    mountSynthesisReading();
    window.addEventListener("sciretriever:literature-selected", (event) => {
      const id = (event as CustomEvent<string>).detail;
      for (const name of [
        "context-literature-id",
        "knowledge-context-literature-id",
        "knowledge-list-literature-id",
      ]) {
        const field = document.getElementById(name) as HTMLInputElement | null;
        if (!field) continue;
        field.value = id;
        field.dispatchEvent(new Event("input"));
      }
      const artifact = new URL(window.location.href).searchParams.get(
        "knowledge",
      );
      if (artifact) {
        const field = node<HTMLInputElement>("knowledge-read-id");
        field.value = artifact;
        field.dispatchEvent(new Event("input"));
        expandReader(field);
        node<HTMLButtonElement>("knowledge-read-submit").click();
      } else node<HTMLButtonElement>("knowledge-list-submit").click();
    });
    const readLinkedSynthesis = () => {
      const parameters = new URL(window.location.href).searchParams;
      const knowledge = parameters.get("knowledge");
      if (knowledge && !parameters.has("literature")) {
        node<HTMLInputElement>("knowledge-list-literature-id").value = "";
        const field = node<HTMLInputElement>("knowledge-read-id");
        field.value = knowledge;
        field.dispatchEvent(new Event("input"));
        expandReader(field);
        node<HTMLButtonElement>("knowledge-read-submit").click();
      }
      const artifact = parameters.get("synthesis");
      if (!artifact) return;
      const field = node<HTMLInputElement>("synthesis-read-id");
      field.value = artifact;
      field.dispatchEvent(new Event("input"));
      expandReader(field);
      node<HTMLButtonElement>("synthesis-read-submit").click();
    };
    onWorkspace((workspace) => {
      if (workspace === "library") readLinkedSynthesis();
    });
    readLinkedSynthesis();
  } catch {
    showReadiness("unavailable");
  }
}

if (document.querySelector('script[src="/query.js"]'))
  void mountQueryWorkbench();
