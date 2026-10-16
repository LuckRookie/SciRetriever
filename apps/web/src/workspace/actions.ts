import {
  createInputManifest,
  parseDocumentReadRequest,
  parseDocumentReadResult,
  parseKnowledgeAnalysisRequest,
  parseKnowledgeLongAnalysisRequest,
  parseProcessingTaskRequest,
  parseDocumentRequest,
  parseArticleIdentityRequest,
  type ProcessingOperation,
} from "@sciretriever/contracts";
import { record } from "../wire.js";
import { detail, title } from "./library.js";
import { node, escape as e, click, message, toast, download } from "./dom.js";
import type { AppContext } from "./types.js";

export async function analysisOperation(
  ctx: AppContext,
  id: string,
  purpose = "overview",
  question: string | null = null,
  long = false,
): Promise<ProcessingOperation> {
  const d = await detail(ctx, id),
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
  ctx: AppContext,
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
    toast("任务已保存，启动状态未确认，请到任务页核对。");
  }
  ctx.onTasksChanged();
  return job.job_id;
}

async function identityOperation(
  ctx: AppContext,
  id: string,
): Promise<ProcessingOperation> {
  const d = await detail(ctx, id),
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
  ctx: AppContext,
  operations: readonly ProcessingOperation[],
  key = crypto.randomUUID(),
): Promise<string> {
  const request = await parseProcessingTaskRequest({
    schema_version: 1,
    idempotency_key: key,
    operations,
  });
  return createTask(ctx, { kind: "processing", request });
}
export async function uploadPdf(
  ctx: AppContext,
  id: string,
  file: File,
): Promise<void> {
  if (file.size < 1 || file.size > 16 * 1024 * 1024)
    throw new Error("请选择不超过 16 MiB 的非空 PDF");
  const overlay = node("#overlay");
  overlay.innerHTML = `<div class="scrim"></div><section class="modal" role="dialog" aria-label="上传 PDF"><div class="dh"><h3>补充 PDF</h3></div><div class="db"><p>将 ${e(file.name)} 接纳到指定文献。现有主 PDF 不会被覆盖。</p><p class="code-id">${e(id)}</p><p id="upload-status" role="status"></p><div class="acts"><button class="btn blue" id="upload-confirm">确认上传</button><button class="btn" id="upload-cancel">取消</button></div></div></section>`;
  return new Promise<void>((resolve) => {
    overlay.addEventListener("dismiss", () => resolve(), { once: true });
    click(
      "#upload-cancel",
      () => {
        overlay.replaceChildren();
        resolve();
      },
      overlay,
    );
    click(
      "#upload-confirm",
      async (el) => {
        overlay.dataset.busy = "true";
        (el as HTMLButtonElement).disabled = true;
        node<HTMLButtonElement>("#upload-cancel").disabled = true;
        node("#upload-status").textContent = "正在检查并接纳文件…";
        try {
          const response = await ctx.api.fetch(
            "/api/v1/maintenance/ingest-pdf",
            {
              method: "POST",
              headers: {
                "Content-Type": "application/pdf",
                "X-Sciretriever-Protocol-Version": "1",
                "X-Sciretriever-Csrf": ctx.api.csrf,
                "X-Literature-Id": id,
              },
              body: file,
            },
          );
          await ctx.api.json(response);
          ctx.details.delete(id);
          overlay.replaceChildren();
          toast("PDF 已接纳");
          resolve();
        } catch (error) {
          node("#upload-status").textContent = `PDF 未接纳：${message(error)}`;
          (el as HTMLButtonElement).disabled = false;
          node<HTMLButtonElement>("#upload-cancel").disabled = false;
        } finally {
          delete overlay.dataset.busy;
        }
      },
      overlay,
    );
  });
}
export async function operate(
  ctx: AppContext,
  operation: string,
  ids: readonly string[],
): Promise<void> {
  const unique = [...new Set(ids)];
  if (!unique.length) throw new Error("请先选择文献");
  const labels: Record<string, string> = {
    acquire: "获取 PDF",
    parse: "解析",
    analyze: "分析",
    identity: "核验文章身份",
    export: "导出书目",
  };
  const name = labels[operation];
  if (!name) throw new Error("不支持的操作");
  const overlay = node("#overlay");
  overlay.innerHTML = `<div class="scrim"></div><section class="modal" role="dialog" aria-label="${name}"><div class="dh"><h3>${name}</h3><button class="btn q sm" data-close aria-label="关闭">✕</button></div><div class="db"><p>范围已固定：${unique.length} 篇文献。</p><p class="f2">${operation === "export" ? "导出已有书目信息，不改动文献库。" : operation === "acquire" ? "获取已有文献的 PDF；不会等待人工帮助。已经接纳的材料会保留。" : "只处理所选文献已有材料。缺少输入会逐项说明，不自动下载或生成前序材料。"}</p>${operation === "acquire" ? '<details class="tg"><summary>获取策略与执行选项</summary><label>受阻时<select id="acquire-policy"><option value="never">自动处理</option><option value="notify">通知并继续</option><option value="pause">暂停等待人工</option></select></label><label>尝试上限<input id="acquire-attempts" type="number" min="1" max="1000000" value="1000"></label><label>重试上限<input id="acquire-retries" type="number" min="0" max="100" value="1"></label><label><input id="acquire-start" type="checkbox" checked>保存后立即执行</label><p class="f2">重启不会重置已用预算。</p></details>' : ""}${operation === "analyze" ? '<div class="filter-grid"><label>用途<select id="analysis-purpose"><option value="overview">概览</option><option value="detailed">详细分析</option><option value="question">围绕问题</option></select></label><label>处理方式<select id="analysis-mode"><option value="single">单篇分析</option><option value="long">长文分段分析</option></select></label><label>研究问题<textarea id="analysis-question"></textarea></label></div>' : ""}${operation === "export" ? '<label>格式<select id="export-format"><option value="bibtex">BibTeX</option><option value="ris">RIS</option></select></label>' : ""}<p id="op-status" role="status"></p><div id="op-results"></div></div><div class="dfoot"><button class="btn" data-close>取消</button><button class="btn blue" id="op-confirm">${operation === "export" ? "导出" : "确认启动"}</button></div></section>`;
  let active = false;
  const key = crypto.randomUUID();
  click(
    "[data-close]",
    () => {
      if (!active) overlay.replaceChildren();
    },
    overlay,
  );
  click(
    "#op-confirm",
    async (element) => {
      if (active) return;
      active = true;
      overlay.dataset.busy = "true";
      (element as HTMLButtonElement).disabled = true;
      const status = node("#op-status", overlay),
        results = node("#op-results", overlay);
      status.textContent = "正在核对输入…";
      try {
        if (operation === "export") {
          const format = node<HTMLSelectElement>(
            "#export-format",
            overlay,
          ).value;
          const parts: string[] = [];
          for (const id of unique) {
            const response = await ctx.api.fetch("/api/library/bibliography", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ literature_id: id, format }),
            });
            if (!response.ok)
              throw new Error(`导出未完成（${response.status}）`);
            parts.push(await response.text());
          }
          download(
            new Blob([parts.join("\n")], { type: "text/plain;charset=utf-8" }),
            `sciretriever.${format === "ris" ? "ris" : "bib"}`,
          );
          status.textContent = `已导出 ${unique.length} 篇文献`;
        } else if (operation === "acquire") {
          const id = await createTask(
            ctx,
            {
              kind: "acquire-pdf",
              idempotency_key: key,
              selector: { kind: "literatures", literature_ids: unique },
              policy: {
                mode: node<HTMLSelectElement>("#acquire-policy", overlay).value,
                max_attempts: Number(
                  node<HTMLInputElement>("#acquire-attempts", overlay).value,
                ),
                max_retries: Number(
                  node<HTMLInputElement>("#acquire-retries", overlay).value,
                ),
              },
            },
            node<HTMLInputElement>("#acquire-start", overlay).checked,
          );
          status.textContent = "任务已保存";
          results.innerHTML = `<button class="btn" data-task="${e(id)}">查看任务</button>`;
        } else {
          const operations: ProcessingOperation[] = [];
          const skipped: string[] = [];
          for (const id of unique) {
            try {
              if (operation === "analyze") {
                const purpose = node<HTMLSelectElement>(
                  "#analysis-purpose",
                  overlay,
                ).value;
                operations.push(
                  await analysisOperation(
                    ctx,
                    id,
                    purpose,
                    purpose === "question"
                      ? node<HTMLTextAreaElement>("#analysis-question", overlay)
                          .value
                      : null,
                    node<HTMLSelectElement>("#analysis-mode", overlay).value ===
                      "long",
                  ),
                );
              } else {
                const d = await detail(ctx, id),
                  asset = d.primary_pdf?.asset;
                if (!asset) throw new Error("缺少 PDF");
                operations.push(
                  operation === "parse"
                    ? {
                        operation: "parse-documents",
                        request: parseDocumentRequest({
                          literature_id: id,
                          asset_id: asset.asset_id,
                          asset_sha256: asset.sha256,
                          mode: "reparse",
                          expected_default_revision: null,
                        }),
                      }
                    : await identityOperation(ctx, id),
                );
              }
            } catch (error) {
              skipped.push(
                `${ctx.details.get(id) ? title(ctx.details.get(id)!) : id}：${message(error)}`,
              );
            }
          }
          results.innerHTML = skipped.length
            ? `<details open><summary>${skipped.length} 篇未提交</summary><ul>${skipped.map((s) => `<li>${e(s)}</li>`).join("")}</ul></details>`
            : "";
          for (let offset = 0; offset < operations.length; offset += 100) {
            const id = await processingTask(
              ctx,
              operations.slice(offset, offset + 100),
              `${key}-${offset}`,
            );
            results.insertAdjacentHTML(
              "beforeend",
              `<button class="btn" data-task="${e(id)}">查看任务</button>`,
            );
          }
          status.textContent = `已提交 ${operations.length} 项，${skipped.length} 篇未提交。`;
        }
        click(
          "[data-task]",
          (el) => {
            overlay.replaceChildren();
            ctx.navigate("task", { task: el.dataset.task! });
          },
          results,
        );
        element.remove();
        for (const el of Array.from(
          overlay.querySelectorAll<HTMLElement>("[data-close]"),
        ))
          el.textContent = "关闭";
      } catch (error) {
        status.textContent = `操作未完成：${message(error)}`;
        (element as HTMLButtonElement).disabled = false;
      } finally {
        active = false;
        delete overlay.dataset.busy;
      }
    },
    overlay,
  );
}
