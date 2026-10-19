import {
  parseDocumentReadResult,
  parseSynthesisReadSelection,
  parseSynthesisSourceResult,
  type ProcessorCitation,
  type ProcessorRecord,
} from "@sciretriever/contracts";
import { node, escape as e, button, message } from "./dom.js";
import {
  readProcessorResult,
  resolveProcessorEvidence,
} from "./processor-data.js";
import { sourceParameters } from "./source-navigation.js";
import type { AppContext } from "./types.js";

const activeEvidence = new WeakMap<HTMLElement, symbol>();

/** Show one verified step and let the reader follow its immediate upstream references. */
export async function renderProcessorEvidence(
  ctx: AppContext,
  host: HTMLElement,
  citation: ProcessorCitation,
  returnParameters: Record<string, string>,
  close: () => void,
): Promise<void> {
  const token = Symbol();
  activeEvidence.set(host, token);
  const current = () =>
    !ctx.signal.aborted &&
    host.isConnected &&
    activeEvidence.get(host) === token;
  host.hidden = false;
  host.innerHTML =
    '<div class="result-evidence-heading"><h2>字段证据</h2></div><div class="result-evidence-body" role="status">正在核验固定来源…</div>';
  node(".result-evidence-heading", host).append(button("收起", close));
  const body = node(".result-evidence-body", host);
  try {
    const resolved = await resolveProcessorEvidence(
      ctx.api,
      citation,
      ctx.signal,
    );
    if (!current()) return;
    body.innerHTML = `<p class="result-chain">${citation.kind === "result" ? `结果字段 ${e(citation.pointer || "整条记录")}` : citation.kind === "knowledge" ? "已有知识断言" : "固定文档证据"}</p><div class="result-evidence-value"></div><div class="result-upstream"></div><div class="result-passages"></div><details><summary>固定引用</summary><pre>${e(JSON.stringify(citation, null, 2))}</pre></details>`;
    node(".result-evidence-value", body).textContent =
      resolved.value === null
        ? "无法判断 / 未报告。空值不表示“否”或零。"
        : typeof resolved.value === "string"
          ? resolved.value
          : JSON.stringify(resolved.value);
    if (citation.kind === "result") {
      const stored = await readProcessorResult(ctx.api, citation, ctx.signal);
      if (!current()) return;
      const content = stored.result.content;
      let sources: readonly ProcessorCitation[] = [];
      if (content.kind === "records") {
        const row = content.records.find(
          (r) => r.record_id === citation.record_id,
        );
        if (!row) throw new Error("原记录不存在");
        sources = matchingSources(row, citation.pointer);
        const reason =
          row.missing[citation.pointer] ??
          row.missing[citation.pointer.slice(1)];
        if (reason) node(".result-evidence-value", body).append(` · ${reason}`);
      } else if (content.kind === "text") sources = content.evidence;
      else
        sources = [
          {
            kind: "knowledge",
            artifact_id: content.artifact_id,
            content_sha256: content.content_sha256,
            statement_id: citation.record_id,
          },
        ];
      const upstream = node(".result-upstream", body);
      for (const source of sources.filter((s) => s.kind !== "document")) {
        upstream.append(
          button(
            source.kind === "result"
              ? `核对上游记录 ${source.record_id}`
              : `核对知识断言 ${source.statement_id}`,
            () =>
              renderProcessorEvidence(
                ctx,
                host,
                source,
                returnParameters,
                close,
              ),
          ),
        );
      }
    }
    if (citation.kind === "knowledge") {
      const selection = parseSynthesisReadSelection({
        artifact_id: citation.artifact_id,
      });
      const saved = await parseSynthesisSourceResult(
        (await ctx.api.query("synthesis-source", selection, ctx.signal)).result,
        selection,
      );
      if (!current()) return;
      if (saved.artifact.content_ref.sha256 !== citation.content_sha256)
        throw new Error("上游知识版本不匹配");
      const statement = saved.artifact.content.statements.find(
        (item) => item.statement_id === citation.statement_id,
      );
      if (!statement) throw new Error("上游知识断言不存在");
      for (const source of statement.evidence) {
        if ("schema_version" in source || source.target_kind === "document")
          continue;
        node(".result-upstream", body).append(
          button(`核对上游知识 ${source.statement_id}`, () =>
            renderProcessorEvidence(
              ctx,
              host,
              {
                kind: "knowledge",
                artifact_id: source.source_artifact_id,
                content_sha256: source.source_content_sha256,
                statement_id: source.statement_id,
              },
              returnParameters,
              close,
            ),
          ),
        );
      }
    }
    const passages = node(".result-passages", body);
    if (!resolved.evidence.length)
      passages.textContent =
        "该字段没有可定位的原文依据。不能从缺少证据推断否定结论。";
    for (const evidence of resolved.evidence) {
      if (!current()) return;
      const section = document.createElement("section");
      section.className = "result-passage";
      const text = document.createElement("blockquote");
      section.append(text);
      passages.append(section);
      let continuation: string | null = null;
      const load = async () => {
        const request = { evidence, max_bytes: 8192, continuation };
        const value = parseDocumentReadResult(
          "evidence",
          (await ctx.api.query("evidence-resolve", request, ctx.signal)).result,
          request,
        );
        if (!current()) return;
        section.querySelector("[data-evidence-more]")?.remove();
        if (value.granularity === "file") {
          text.textContent = "证据仅指向原始文件，没有可定位的正文片段。";
          if (value.material) {
            const m = value.material;
            section.append(
              button("打开固定原始 PDF", () =>
                ctx.openPaper(m.literature_id, "pdf", {
                  from: "ext",
                  ...returnParameters,
                  asset: m.asset_id,
                  assetHash: m.asset_sha256,
                }),
              ),
            );
          }
          return;
        }
        text.append(value.text ?? "");
        continuation = value.continuation ?? null;
        if (continuation) {
          const more = button("继续读取证据", load);
          more.dataset.evidenceMore = "true";
          section.append(more);
        }
        if (
          !section.querySelector("[data-open-evidence]") &&
          value.document &&
          value.target_range
        ) {
          const { document, target_range: range } = value;
          const m = document.source_material_ref;
          const open = button("打开这段原文", () =>
            ctx.openPaper(m.literature_id, "doc", {
              ...sourceParameters({
                kind: "document",
                literature_id: m.literature_id,
                document_version_id: document.document_version_id,
                representation_sha256: document.representation_sha256,
                asset_id: m.asset_id,
                asset_sha256: m.asset_sha256,
                ...range,
              }),
              from: "ext",
              ...returnParameters,
            }),
          );
          open.dataset.openEvidence = "true";
          section.append(open);
          section.append(
            Object.assign(documentFor(host).createElement("p"), {
              className: "f2",
              textContent: "定位到解析正文；当前证据未提供 PDF 区域坐标。",
            }),
          );
        }
      };
      await load();
    }
  } catch (error) {
    if (!ctx.signal.aborted)
      body.textContent = `证据读取未完成：${message(error)}。固定来源未被替换，可重新打开此字段。`;
  }
}
function documentFor(host: HTMLElement): Document {
  return host.ownerDocument;
}
export function matchingSources(
  row: ProcessorRecord,
  pointer: string,
): ProcessorCitation[] {
  return row.evidence
    .filter(
      (source) =>
        !pointer ||
        !source.pointer ||
        pointer === source.pointer ||
        pointer.startsWith(`${source.pointer}/`),
    )
    .flatMap((source) => [...source.sources]);
}
