import {
  parseKnowledgeListSelection,
  parseKnowledgeListResult,
  parseKnowledgeReadSelection,
  parseKnowledgeReadResult,
  type LiteratureDetail,
  type KnowledgeArtifact,
  type EvidenceRef,
} from "@sciretriever/contracts";
import type { AppContext, ReaderMode } from "../workspace/types.js";
import {
  sourceParameters,
  renderFixedKnowledge,
  type FixedSource,
} from "../workspace/source-navigation.js";
import { button, node } from "../workspace/dom.js";
import { record } from "../wire.js";
import {
  renderKnowledgeArtifact,
  configureDataTransport,
} from "../knowledge.js";
import { readingPosition } from "./state.js";
import {
  readingFrame,
  readerProblem,
  verifiedDownload,
  type ReaderFrame,
} from "./frame.js";
import {
  readDocument,
  resolveReadingSources,
  readPdfBytes,
} from "./transport.js";
import { renderPdf } from "./pdf.js";
import { renderDocument } from "./document.js";
import { markdown } from "./markdown.js";

async function existingResults(ctx: AppContext, id: string): Promise<void> {
  const host = document.createElement("details");
  host.className = "reading-related";
  host.innerHTML = "<summary>已有处理结果</summary><div>正在查询…</div>";
  node("#reader-info", ctx.root).append(host);
  const body = node("div", host);
  let after = "";
  const more = button("更多结果", () => load());
  const load = async () => {
    more.disabled = true;
    try {
      const response = await ctx.api.processors(
        "results",
        { literature_id: id, limit: 10, ...(after ? { after } : {}) },
        ctx.signal,
      );
      if (ctx.signal.aborted) return;
      // Processor queries use the shared operation endpoint, not a parallel Web projection.
      const list = record(response.result, "related result list");
      const value = list.items;
      if (!Array.isArray(value)) throw new Error("结果列表回执无效");
      if (!after) body.replaceChildren();
      more.remove();
      for (const raw of value) {
        const row = record(raw, "related result"),
          ref = row;
        if (
          typeof ref.result_id !== "string" ||
          typeof ref.content_sha256 !== "string"
        )
          throw new Error("结果引用无效");
        const result = ref.result_id,
          resultHash = ref.content_sha256;
        body.append(
          button(
            `${String(row.processor_id)} · ${row.complete ? "完整" : "部分覆盖"}`,
            () => ctx.navigate("ext", { result, resultHash }),
          ),
        );
        after = result;
      }
      if (typeof list.next_after === "string") {
        after = list.next_after;
        body.append(more);
      }
      if (!body.childNodes.length)
        body.textContent = "暂无已保存结果；阅读不会生成结果。";
    } catch (error) {
      if (!ctx.signal.aborted)
        body.textContent = `已有结果暂不可读：${error instanceof Error ? error.message : "请重试"}`;
    } finally {
      more.disabled = false;
    }
  };
  await load();
}

async function knowledge(
  ctx: AppContext,
  frame: ReaderFrame,
  detail: LiteratureDetail,
  source: FixedSource | null,
): Promise<void> {
  const id = detail.literature.literature_id,
    fixed = new URL(location.href).searchParams.get("knowledge");
  let artifacts: readonly KnowledgeArtifact[];
  if (fixed) {
    const request = parseKnowledgeReadSelection({ artifact_id: fixed });
    const artifact = await parseKnowledgeReadResult(
      (await ctx.api.query("knowledge-read", request, ctx.signal)).result,
      request,
    );
    if (!artifact.input.items.some((item) => item.literature_id === id))
      throw new Error("知识来源不属于当前文献");
    artifacts = [artifact];
  } else {
    const request = parseKnowledgeListSelection({
      literature_id: id,
      limit: 20,
    });
    artifacts = await parseKnowledgeListResult(
      (await ctx.api.query("knowledge-list", request, ctx.signal)).result,
      request,
    );
  }
  if (ctx.signal.aborted) return;
  if (!artifacts.length) {
    frame.status.textContent = "尚无已发布知识；可在文献操作中显式发起分析。";
    return;
  }
  const content = document.createElement("article");
  content.className = "reading-article";
  frame.body.append(content);
  const show = async (artifact: KnowledgeArtifact) => {
    const state = readingPosition(
      ctx.reading,
      [
        ctx.api.workspace.catalog,
        "knowledge",
        artifact.artifact_id,
        artifact.content_ref.sha256,
      ],
      id,
    );
    if (source?.kind === "knowledge")
      await renderFixedKnowledge(ctx, source, content, id);
    else renderKnowledgeArtifact(artifact, content, ctx.signal);
    if (ctx.signal.aborted) return;
    frame.outline.replaceChildren();
    const statements = artifact.content.statements.filter(
      (s) =>
        source?.kind !== "knowledge" || s.statement_id === source.statement_id,
    );
    [...content.querySelectorAll<HTMLElement>(".config-card")].forEach(
      (section, index) => {
        const statement = statements[index];
        if (!statement) return;
        const text = section.querySelector("p");
        if (text)
          text.innerHTML = markdown.parse(statement.text, { async: false });
        frame.outline.append(
          button(`${statement.category} · ${statement.statement_id}`, () => {
            frame.body.scrollTop +=
              section.getBoundingClientRect().top -
              frame.body.getBoundingClientRect().top -
              12;
          }),
        );
        for (const evidence of statement.evidence)
          section.append(
            button("在全文中核对", () =>
              openEvidence(ctx, evidence, artifact.artifact_id),
            ),
          );
      },
    );
    frame.body.scrollTop = state.scroll;
    frame.body.onscroll = () => {
      if (!ctx.signal.aborted) state.scroll = frame.body.scrollTop;
    };
    frame.status.textContent = "已发布知识 · 证据可回到固定原文核对";
    ctx.root.dataset.readingReady = "true";
  };
  if (artifacts.length > 1) {
    const choices = document.createElement("div");
    choices.className = "reading-knowledge-choices";
    for (const artifact of artifacts)
      choices.append(button(artifact.content.title, () => show(artifact)));
    frame.body.prepend(choices);
  }
  frame.onFind = (query) => {
    const matches = [
      ...content.querySelectorAll<HTMLElement>(".config-card"),
    ].filter((el) =>
      el.textContent?.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
    );
    frame.findStatus.textContent = `当前总结：${matches.length} 个匹配段落`;
    for (const el of content.querySelectorAll(".config-card"))
      el.classList.toggle("reading-match", matches.includes(el as HTMLElement));
    if (matches[0])
      frame.body.scrollTop +=
        matches[0].getBoundingClientRect().top -
        frame.body.getBoundingClientRect().top -
        12;
  };
  await show(artifacts[0]!);
}
function knowledgeReturnParameters(): Record<string, string> {
  const params = new URL(location.href).searchParams;
  return Object.fromEntries(
    [
      "knowledge",
      "contentHash",
      "manifest",
      "statement",
      "statementHash",
      "from",
      "result",
      "resultHash",
      "collection",
    ].flatMap((key) => (params.has(key) ? [[key, params.get(key)!]] : [])),
  );
}
async function openEvidence(
  ctx: AppContext,
  evidence: EvidenceRef,
  artifact: string,
): Promise<void> {
  const resolved = await readDocument(ctx, "evidence", {
    evidence,
    max_bytes: 8192,
    continuation: null,
  });
  ctx.signal.throwIfAborted();
  if (
    evidence.target_kind === "document" &&
    resolved.document &&
    resolved.actual_range
  ) {
    const ref = resolved.document;
    ctx.openPaper(ref.source_material_ref.literature_id, "doc", {
      ...knowledgeReturnParameters(),
      ...sourceParameters({
        kind: "document",
        literature_id: ref.source_material_ref.literature_id,
        asset_id: ref.source_material_ref.asset_id,
        asset_sha256: ref.source_material_ref.asset_sha256,
        document_version_id: ref.document_version_id,
        representation_sha256: ref.representation_sha256,
        start_utf8: resolved.actual_range.start_utf8,
        end_utf8: resolved.actual_range.end_utf8,
      }),
      artifact,
    });
  } else if (evidence.target_kind === "material")
    ctx.openPaper(evidence.material.literature_id, "pdf", {
      ...knowledgeReturnParameters(),
      asset: evidence.material.asset_id,
      assetHash: evidence.material.asset_sha256,
      artifact,
    });
}

export async function mountReader(
  ctx: AppContext,
  detail: LiteratureDetail,
  mode: ReaderMode,
  source: FixedSource | null,
): Promise<void> {
  ctx.signal.throwIfAborted();
  delete ctx.root.dataset.readingReady;
  configureDataTransport({ fetch: ctx.api.fetch, durableTasks: true });
  const id = detail.literature.literature_id;
  const sources =
    mode === "know"
      ? null
      : await resolveReadingSources(ctx, detail, source, mode);
  ctx.signal.throwIfAborted();
  const state = readingPosition(
    ctx.reading,
    [
      ctx.api.workspace.catalog,
      id,
      mode,
      mode === "know"
        ? new URL(location.href).searchParams.get("knowledge")
        : mode === "pdf"
          ? sources?.material
          : sources?.document,
    ],
    id,
  );
  const frame = readingFrame(ctx, state, mode);
  const artifact = new URL(location.href).searchParams.get("artifact");
  if (artifact && mode !== "know")
    frame.controls.append(
      button("返回总结", () => {
        const previous = knowledgeReturnParameters();
        ctx.openPaper(id, "know", {
          ...previous,
          knowledge: artifact,
          ...(previous.contentHash &&
          previous.manifest &&
          previous.statement &&
          previous.statementHash
            ? { source: "knowledge" }
            : {}),
        });
      }),
    );
  void existingResults(ctx, id);
  try {
    if (mode === "pdf") {
      if (!sources?.material) {
        readerProblem(frame, "尚无 PDF。可从文献信息区上传或显式获取。");
        return;
      }
      frame.status.textContent = "正在读取并核验固定 PDF…";
      const readStarted = performance.now();
      const bytes = await readPdfBytes(ctx, sources.material);
      performance.measure("sciretriever-pdf-read-verify", {
        start: readStarted,
        end: performance.now(),
      });
      ctx.signal.throwIfAborted();
      verifiedDownload(ctx, frame, bytes, `${id}.pdf`);
      await renderPdf(ctx, frame, state, bytes);
    } else if (mode === "doc") {
      if (!sources?.document) {
        readerProblem(frame, "尚无已发布的文档表示；阅读不会启动解析。");
        return;
      }
      await renderDocument(ctx, frame, state, sources.document, source);
    } else await knowledge(ctx, frame, detail, source);
    if (!ctx.signal.aborted)
      node<HTMLButtonElement>("#reader-find-toggle", ctx.root).disabled = false;
  } catch (error) {
    if (!ctx.signal.aborted)
      readerProblem(
        frame,
        error instanceof Error ? error.message : "读取失败",
        () => ctx.refresh(),
      );
  }
}
