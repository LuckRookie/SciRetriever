import { randomId } from "../../browser-platform.js";
import {
  createInputManifest,
  parseDocumentReadRequest,
  parseDocumentReadResult,
  parseKnowledgeAnalysisRequest,
  parseKnowledgeLongAnalysisRequest,
  parseProcessingTaskRequest,
  parseArticleIdentityRequest,
  type ProcessingOperation,
} from "@sciretriever/contracts";
import { record } from "./wire.js";
import type { ApiClient } from "./api.js";
import { readLiterature } from "./library.js";
export interface OperationContext {
  api: ApiClient;
  signal: AbortSignal;
  onTasksChanged(): void;
  notify(message: string): void;
}
export async function analysisOperation(
  ctx: OperationContext,
  id: string,
  purpose = "overview",
  question: string | null = null,
  long = false,
): Promise<ProcessingOperation> {
  const d = await readLiterature(ctx.api, id, ctx.signal),
    pdf = d.primary_pdf?.asset;
  if (!pdf) throw new Error("没有已接纳的 PDF");
  const mreq = parseDocumentReadRequest("material", {
    literature_id: id,
    asset_id: pdf.asset_id,
  });
  const material = parseDocumentReadResult(
    "material",
    (await ctx.api.query("material-evidence", mreq, ctx.signal)).result,
    mreq,
  );
  if (
    material.evidence.target_kind !== "material" ||
    material.evidence.material.asset_sha256 !== pdf.sha256
  )
    throw new Error("材料证据与当前 PDF 不一致");
  const req = parseDocumentReadRequest("default", {
    literature_id: id,
    asset_id: pdf.asset_id,
    asset_sha256: pdf.sha256,
  });
  const current = parseDocumentReadResult(
    "default",
    (await ctx.api.query("document-default", req, ctx.signal)).result,
    req,
  );
  if (!current.default) throw new Error("该材料尚无解析文档");
  const dreq = parseDocumentReadRequest("describe", {
    document_version_id: current.default.document_version_id,
  });
  const doc = parseDocumentReadResult(
    "describe",
    (await ctx.api.query("document-describe", dreq, ctx.signal)).result,
    dreq,
  );
  if (
    doc.document.source_material_ref.literature_id !== id ||
    doc.document.source_material_ref.asset_sha256 !== pdf.sha256 ||
    !doc.capabilities.text
  )
    throw new Error("文档与当前材料不匹配或没有可读正文");
  const input = await createInputManifest([
    {
      input_id: "source-1",
      literature_id: id,
      material: material.evidence.material,
      document: doc.document,
      capabilities: [
        "material-file-v1",
        "document-segment-v1",
        "document-text-v1",
        ...(doc.capabilities.outline ? ["document-outline-v1" as const] : []),
        ...(doc.capabilities.resources
          ? ["document-resources-v1" as const]
          : []),
      ],
      gaps: [],
    },
  ]);
  const common = { input, purpose, question, default_update: null };
  return long
    ? {
        operation: "analyze-long",
        request: await parseKnowledgeLongAnalysisRequest({
          schema_version: 2,
          ...common,
        }),
      }
    : {
        operation: "analyze",
        request: await parseKnowledgeAnalysisRequest({
          schema_version: 1,
          ...common,
        }),
      };
}
export async function createTask(
  ctx: OperationContext,
  value: unknown,
  start = true,
): Promise<string> {
  const job = record((await ctx.api.request("/api/tasks", value)).task, "task");
  if (typeof job.job_id !== "string") throw new Error("任务回执无效");
  ctx.onTasksChanged();
  try {
    if (start)
      await ctx.api.request(
        `/api/tasks/${encodeURIComponent(job.job_id)}/start`,
        {},
      );
  } catch {
    ctx.notify("任务已保存，启动状态未确认，请到任务页核对。");
  }
  ctx.onTasksChanged();
  return job.job_id;
}

export async function identityOperation(
  ctx: OperationContext,
  id: string,
): Promise<ProcessingOperation> {
  const d = await readLiterature(ctx.api, id, ctx.signal),
    asset = d.primary_pdf?.asset;
  if (!asset) throw new Error("缺少 PDF");
  const selected = parseDocumentReadRequest("default", {
    literature_id: id,
    asset_id: asset.asset_id,
    asset_sha256: asset.sha256,
  });
  const current = parseDocumentReadResult(
    "default",
    (await ctx.api.query("document-default", selected, ctx.signal)).result,
    selected,
  );
  if (!current.default) throw new Error("请先显式解析已有 PDF");
  const described = parseDocumentReadRequest("describe", {
    document_version_id: current.default.document_version_id,
  });
  const document = parseDocumentReadResult(
    "describe",
    (await ctx.api.query("document-describe", described, ctx.signal)).result,
    described,
  ).document;
  if (
    document.source_material_ref.literature_id !== id ||
    document.source_material_ref.asset_sha256 !== asset.sha256
  )
    throw new Error("文档与当前材料不匹配");
  return {
    operation: "assess-article-identity",
    request: parseArticleIdentityRequest({
      schema_version: 1,
      literature_id: id,
      document_version_id: document.document_version_id,
      representation_sha256: document.representation_sha256,
      metadata_revision: d.metadata_revision,
      metadata_sha256: d.metadata_sha256,
      budget: { max_input_bytes: 65536, max_output_tokens: 2048 },
    }),
  };
}
export async function processingTask(
  ctx: OperationContext,
  operations: readonly ProcessingOperation[],
  key = randomId(),
): Promise<string> {
  const request = await parseProcessingTaskRequest({
    schema_version: 1,
    idempotency_key: key,
    operations,
  });
  return createTask(ctx, { kind: "processing", request });
}
