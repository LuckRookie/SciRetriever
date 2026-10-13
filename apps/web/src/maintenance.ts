import {
  parseRetrievalGenerationReceipt,
  parseDocumentReceipt,
  parseDocumentRequest,
  parseLiteratureDetail,
  parseStrictJsonValue,
  parseExtractionOperationResult,
  parseExtractionReceiptResult,
  parseExtractionAcceptedResult,
  parseExtractionSubmission,
  parseExtractionCandidateIssue,
  extractionSubmissionHash,
  EXTRACTION_ACCEPTED_MAX_BYTES,
  EXTRACTION_RECEIPT_MAX_BYTES,
  type ExtractionOperationResult,
  parseInputManifest,
  type InputManifest,
} from "@sciretriever/contracts";
import { record } from "./wire.js";
import {
  mountKnowledgeMaintenance,
  configureDataTransport,
  dataFetch,
  usesDurableTasks,
  submitProcessingTask,
  type DataFetch,
} from "./knowledge.js";
import { mountSynthesisMaintenance } from "./synthesis.js";

export function mountMaintenanceWorkbench(
  options: {
    fetch?: DataFetch;
    durableTasks?: boolean;
  } = {},
): void {
  configureDataTransport(options);
  mountKnowledgeMaintenance();
  mountSynthesisMaintenance();

  function node<T extends HTMLElement = HTMLElement>(id: string): T {
    const value = document.getElementById(id);
    if (!value) throw new Error("maintenance page is incomplete");
    return value as T;
  }

  const form = node<HTMLFormElement>("manual-pdf-form");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const submit = node<HTMLButtonElement>("manual-pdf-submit");
    if (submit.disabled) return;
    const status = node("manual-pdf-status");
    const id = node<HTMLInputElement>("manual-pdf-literature-id").value.trim();
    const file = node<HTMLInputElement>("manual-pdf-file").files?.[0];
    if (!id || !file) return;
    if (file.size < 1 || file.size > 16 * 1024 * 1024) {
      status.textContent = "文件必须为不超过 16 MiB 的非空 PDF。";
      return;
    }
    status.textContent = "正在检查并接纳 PDF…";
    submit.disabled = true;
    void (async () => {
      const session = await dataFetch("/api/v1/maintenance/session");
      if (!session.ok) throw new Error("维护会话不可用");
      const grant: unknown = await session.json();
      if (
        !grant ||
        typeof grant !== "object" ||
        !("csrf" in grant) ||
        typeof grant.csrf !== "string"
      )
        throw new Error("维护会话无效");
      const response = await dataFetch("/api/v1/maintenance/ingest-pdf", {
        method: "POST",
        headers: {
          "Content-Type": "application/pdf",
          "X-Sciretriever-Protocol-Version": "1",
          "X-Sciretriever-Csrf": grant.csrf,
          "X-Literature-Id": id,
        },
        body: file,
      });
      const result: unknown = await response.json();
      if (!response.ok) {
        const code =
          result && typeof result === "object" && "code" in result
            ? String(result.code)
            : "接纳失败";
        throw new Error(code);
      }
      status.textContent = "PDF 已接纳。可前往只读文献库查看。";
    })()
      .catch((error: unknown) => {
        status.textContent = `PDF 未接纳：${error instanceof Error ? error.message : "未知错误"}`;
      })
      .finally(() => {
        submit.disabled = false;
      });
  });

  let selectedMaterial: {
    readonly literature_id: string;
    readonly asset_id: string;
    readonly asset_sha256: string;
  } | null = null;
  node<HTMLButtonElement>("document-load-material").addEventListener(
    "click",
    () => {
      const button = node<HTMLButtonElement>("document-load-material");
      const status = node("document-material-status");
      const literatureId = node<HTMLInputElement>(
        "document-literature-id",
      ).value.trim();
      selectedMaterial = null;
      node<HTMLInputElement>("document-asset-id").value = "";
      node<HTMLInputElement>("document-asset-sha256").value = "";
      button.disabled = true;
      status.textContent = "正在读取文献库当前材料…";
      void (async () => {
        const response = await dataFetch("/api/v1/query/read", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            protocol_version: 1,
            request: { literature_id: literatureId },
          }),
        });
        const payload: unknown = await response.json();
        if (
          !payload ||
          typeof payload !== "object" ||
          !("protocol_version" in payload) ||
          payload.protocol_version !== 1
        )
          throw new Error("文献库回执无效");
        if (!response.ok) {
          const code =
            "code" in payload ? String(payload.code) : "文献库读取失败";
          throw new Error(code);
        }
        if (!("detail" in payload)) throw new Error("文献库回执无效");
        const detail = await parseLiteratureDetail(payload.detail);
        const asset = detail.primary_pdf?.asset;
        if (!asset) throw new Error("该文献没有已接纳的主 PDF");
        if (detail.literature.literature_id !== literatureId)
          throw new Error("文献库返回了其他文献");
        selectedMaterial = {
          literature_id: literatureId,
          asset_id: asset.asset_id,
          asset_sha256: asset.sha256,
        };
        node<HTMLInputElement>("document-asset-id").value = asset.asset_id;
        node<HTMLInputElement>("document-asset-sha256").value = asset.sha256;
        status.textContent = `已选择当前 PDF：${asset.asset_id} · ${asset.sha256}。正在读取默认版本…`;
        try {
          const session = await dataFetch("/api/v1/maintenance/session");
          if (!session.ok) throw new Error("维护会话不可用");
          const grant: unknown = await session.json();
          if (
            !grant ||
            typeof grant !== "object" ||
            !("csrf" in grant) ||
            typeof grant.csrf !== "string"
          )
            throw new Error("维护会话无效");
          const current = await dataFetch(
            "/api/v1/maintenance/document-default",
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Sciretriever-Protocol-Version": "1",
                "X-Sciretriever-Csrf": grant.csrf,
              },
              body: JSON.stringify(
                parseDocumentRequest({
                  ...selectedMaterial,
                  mode: "reuse-current",
                  expected_default_revision: null,
                }),
              ),
            },
          );
          const payload: unknown = await current.json();
          if (
            !payload ||
            typeof payload !== "object" ||
            !("protocol_version" in payload) ||
            payload.protocol_version !== 1
          )
            throw new Error("默认版本回执无效");
          if (!current.ok)
            throw new Error(
              "code" in payload ? String(payload.code) : "默认版本读取失败",
            );
          if (!("default" in payload)) throw new Error("默认版本回执无效");
          const value = payload.default;
          if (
            value !== null &&
            (!value ||
              typeof value !== "object" ||
              Array.isArray(value) ||
              Object.keys(value).sort().join() !==
                "document_version_id,revision" ||
              !("revision" in value) ||
              !Number.isSafeInteger(value.revision) ||
              (value.revision as number) < 1 ||
              !("document_version_id" in value) ||
              typeof value.document_version_id !== "string")
          )
            throw new Error("默认版本回执无效");
          const revision =
            value === null
              ? null
              : (value as { readonly revision: number }).revision;
          node<HTMLInputElement>("document-default-revision").value =
            revision === null ? "" : String(revision);
          status.textContent = `已选择当前 PDF：${asset.asset_id} · ${asset.sha256}。${revision === null ? "尚无默认版本" : `默认版本 revision ${revision}`}；请选择复用或重解析。`;
        } catch (error) {
          node<HTMLInputElement>("document-default-revision").value = "";
          status.textContent = `已选择当前 PDF：${asset.asset_id} · ${asset.sha256}。默认版本读取失败：${error instanceof Error ? error.message : "未知错误"}。`;
        }
      })()
        .catch((error: unknown) => {
          status.textContent = `材料选择失败：${error instanceof Error ? error.message : "未知错误"}`;
        })
        .finally(() => {
          button.disabled = false;
        });
    },
  );

  node<HTMLFormElement>("document-parse-form").addEventListener(
    "submit",
    (event) => {
      event.preventDefault();
      const submit = node<HTMLButtonElement>("document-parse-submit");
      if (submit.disabled) return;
      const status = node("document-parse-status");
      const revisionText = node<HTMLInputElement>(
        "document-default-revision",
      ).value.trim();
      const revision = revisionText === "" ? null : Number(revisionText);
      if (
        revision !== null &&
        (!Number.isSafeInteger(revision) || revision < 1)
      ) {
        status.textContent = "默认版本 revision 必须为正整数。";
        return;
      }
      if (
        !selectedMaterial ||
        selectedMaterial.literature_id !==
          node<HTMLInputElement>("document-literature-id").value.trim()
      ) {
        status.textContent = "请先从文献库读取并选择当前 PDF。";
        return;
      }
      const request = parseDocumentRequest({
        ...selectedMaterial,
        mode: node<HTMLSelectElement>("document-parse-mode").value,
        expected_default_revision: revision,
      });
      status.textContent = "正在验证材料并发布表示…";
      submit.disabled = true;
      void (async () => {
        if (usesDurableTasks()) {
          await submitProcessingTask(
            { operation: "parse-documents", request },
            status,
          );
          return;
        }
        const session = await dataFetch("/api/v1/maintenance/session");
        if (!session.ok) throw new Error("维护会话不可用");
        const grant: unknown = await session.json();
        if (
          !grant ||
          typeof grant !== "object" ||
          !("csrf" in grant) ||
          typeof grant.csrf !== "string"
        )
          throw new Error("维护会话无效");
        const response = await dataFetch("/api/v1/maintenance/parse-document", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Sciretriever-Protocol-Version": "1",
            "X-Sciretriever-Csrf": grant.csrf,
          },
          body: JSON.stringify(request),
        });
        const payload: unknown = await response.json();
        if (!response.ok) {
          const code =
            payload && typeof payload === "object" && "code" in payload
              ? String(payload.code)
              : "发布失败";
          throw new Error(code);
        }
        if (
          !payload ||
          typeof payload !== "object" ||
          !("protocol_version" in payload) ||
          payload.protocol_version !== 1 ||
          !("receipt" in payload)
        )
          throw new Error("发布回执无效");
        let receipt;
        try {
          receipt = parseDocumentReceipt(payload.receipt);
        } catch {
          throw new Error("发布回执无效");
        }
        status.textContent = `表示 ${receipt.document.document_version_id} ${receipt.published ? "已发布" : "已存在"}；${receipt.default_updated ? "默认版本已更新" : "默认版本未更新，请核对 revision"}。`;
      })()
        .catch((error: unknown) => {
          status.textContent = `表示发布失败：${error instanceof Error ? error.message : "未知错误"}`;
        })
        .finally(() => {
          submit.disabled = false;
        });
    },
  );

  function mountIndexRebuild(
    buttonId: string,
    statusId: string,
    path: string,
    label: string,
  ): void {
    const button = node<HTMLButtonElement>(buttonId);
    const status = node(statusId);
    button.addEventListener("click", () => {
      if (button.disabled) return;
      button.disabled = true;
      status.textContent = `正在验证${label}并重建索引…`;
      void (async () => {
        const session = await dataFetch("/api/v1/maintenance/session");
        if (!session.ok) throw new Error("维护会话不可用");
        const grant: unknown = await session.json();
        if (
          !grant ||
          typeof grant !== "object" ||
          !("csrf" in grant) ||
          typeof grant.csrf !== "string"
        )
          throw new Error("维护会话无效");
        const response = await dataFetch(path, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Sciretriever-Protocol-Version": "1",
            "X-Sciretriever-Csrf": grant.csrf,
          },
          body: JSON.stringify({
            protocol_version: 1,
            request: { kind: "rebuild" },
          }),
        });
        const payload: unknown = await response.json();
        if (
          !payload ||
          typeof payload !== "object" ||
          !("protocol_version" in payload) ||
          payload.protocol_version !== 1
        )
          throw new Error("重建回执无效");
        if (!response.ok)
          throw new Error(
            "code" in payload ? String(payload.code) : "重建失败",
          );
        if (!("result" in payload)) throw new Error("重建回执无效");
        const result = parseRetrievalGenerationReceipt(payload.result);
        status.textContent = `索引已发布：${result.generation_id} · ${result.entry_count} 条检索记录。`;
      })()
        .catch((error: unknown) => {
          status.textContent = `索引重建失败：${error instanceof Error ? error.message : "未知错误"}`;
        })
        .finally(() => {
          button.disabled = false;
        });
    });
  }
  mountIndexRebuild(
    "retrieval-rebuild",
    "retrieval-rebuild-status",
    "/api/v1/maintenance/rebuild-index",
    "材料",
  );
  mountIndexRebuild(
    "knowledge-retrieval-rebuild",
    "knowledge-retrieval-rebuild-status",
    "/api/v1/maintenance/rebuild-knowledge-index",
    "知识产物",
  );

  const extractionButtons = [
    "extraction-create",
    "extraction-submit",
    "extraction-close",
    "extraction-cancel",
    "extraction-receipt",
    "extraction-cleanup",
  ].map((id) => node<HTMLButtonElement>(id));
  const extractionFields = [
    "extraction-caller",
    "extraction-prepared",
    "extraction-operation-id",
    "extraction-batch",
    "extraction-receipt-id",
  ].map((id) => node<HTMLInputElement | HTMLTextAreaElement>(id));
  let selectedExtractionOperation: ExtractionOperationResult | null = null;
  for (const field of extractionFields)
    field.addEventListener("input", () => {
      if (field.id === "extraction-operation-id")
        selectedExtractionOperation = null;
      node("extraction-result").textContent = "";
      node("extraction-status").textContent =
        "输入已修改；请重新提交或读取所选历史回执。";
    });
  async function extractionResponseBytes(
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
      const prepared = record(
        parseStrictJsonValue(
          node<HTMLTextAreaElement>("extraction-prepared").value,
        ),
        "preparation",
      );
      expectedManifest = await parseInputManifest(prepared.manifest);
      if (
        expectedManifest.manifest_sha256 !==
        (selected as ExtractionOperationResult).manifest_sha256
      )
        throw new Error("manifest 与 operation 不匹配");
    }
    const session = await dataFetch("/api/v1/maintenance/session");
    if (!session.ok) throw new Error("维护会话不可用");
    const grant = record(
      parseStrictJsonValue(await extractionResponseBytes(session, 4096)),
      "maintenance session",
    );
    if (
      Object.keys(grant).sort().join() !==
        ["protocol_version", "csrf"].sort().join() ||
      grant.protocol_version !== 1 ||
      typeof grant.csrf !== "string"
    )
      throw new Error("维护会话无效");
    const response = await dataFetch(`/api/v1/maintenance/extraction-${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Sciretriever-Protocol-Version": "1",
        "X-Sciretriever-Csrf": grant.csrf,
      },
      body: JSON.stringify({ protocol_version: 1, request }),
    });
    const responseBytes = await extractionResponseBytes(
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
  function extractionAction(id: string, action: () => Promise<unknown>): void {
    node<HTMLButtonElement>(id).addEventListener("click", () => {
      if (extractionButtons.some((button) => button.disabled)) return;
      const status = node("extraction-status");
      const output = node("extraction-result");
      for (const control of [...extractionButtons, ...extractionFields])
        control.disabled = true;
      status.textContent = "正在检查并处理请求…";
      output.textContent = "";
      void action()
        .then((result) => {
          if (result === null) {
            status.textContent = "未知或已过期；无法恢复历史候选载荷。";
            return;
          }
          const value = record(result, "extraction result");
          if (typeof value.operation_id === "string")
            node<HTMLInputElement>("extraction-operation-id").value =
              value.operation_id;
          const receiptId =
            typeof value.receipt_id === "string"
              ? value.receipt_id
              : value.receipt &&
                  typeof value.receipt === "object" &&
                  "receipt_id" in value.receipt
                ? value.receipt.receipt_id
                : null;
          if (typeof receiptId === "string")
            node<HTMLInputElement>("extraction-receipt-id").value = receiptId;
          status.textContent = "请求已完成；请保存当前回执。";
          output.textContent = JSON.stringify(result, null, 2);
        })
        .catch((error: unknown) => {
          status.textContent = `请求失败：${error instanceof Error ? error.message : "未知错误"}`;
        })
        .finally(() => {
          for (const control of [...extractionButtons, ...extractionFields])
            control.disabled = false;
        });
    });
  }
  extractionAction("extraction-create", async () => {
    const prepared = record(
      parseStrictJsonValue(
        node<HTMLTextAreaElement>("extraction-prepared").value,
      ),
      "preparation",
    );
    return extractionPost("operation", {
      caller_id: node<HTMLInputElement>("extraction-caller").value.trim(),
      spec: prepared.spec,
      manifest: prepared.manifest,
    });
  });
  extractionAction("extraction-submit", async () => {
    const input = record(
      parseStrictJsonValue(node<HTMLTextAreaElement>("extraction-batch").value),
      "submission",
    );
    const operationId = node<HTMLInputElement>(
      "extraction-operation-id",
    ).value.trim();
    if (input.operation_id !== operationId)
      throw new Error("批次 operation_id 与当前选择不一致");
    return extractionPost("submit", input);
  });
  for (const action of ["close", "cancel"] as const)
    extractionAction(`extraction-${action}`, () =>
      extractionPost(action, {
        operation_id: node<HTMLInputElement>(
          "extraction-operation-id",
        ).value.trim(),
      }),
    );
  extractionAction("extraction-receipt", () =>
    extractionPost("receipt", {
      receipt_id: node<HTMLInputElement>("extraction-receipt-id").value.trim(),
    }),
  );
  extractionAction("extraction-cleanup", () =>
    extractionPost("cleanup", { limit: 100 }),
  );

  window.addEventListener("sciretriever:literature-selected", (event) => {
    const id = (event as CustomEvent<string>).detail;
    for (const name of [
      "manual-pdf-literature-id",
      "document-literature-id",
      "knowledge-literature-id",
    ]) {
      const field = node<HTMLInputElement>(name);
      field.value = id;
      field.dispatchEvent(new Event("input"));
    }
    selectedMaterial = null;
    node<HTMLInputElement>("document-asset-id").value = "";
    node<HTMLInputElement>("document-asset-sha256").value = "";
    node<HTMLInputElement>("document-default-revision").value = "";
  });
  window.addEventListener("sciretriever:process-literature", () => {
    node<HTMLButtonElement>("document-load-material").click();
    node("document-parse-form").scrollIntoView({ block: "start" });
  });
}

if (document.querySelector('script[src="/maintenance.js"]'))
  mountMaintenanceWorkbench();
