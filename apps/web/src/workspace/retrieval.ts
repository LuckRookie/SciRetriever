import {
  parseKnowledgeContextRequest,
  parseKnowledgeContextBundle,
  parseSynthesisReadSelection,
  parseSynthesisSourceResult,
  knowledgeStatementSha256,
  synthesisStatementSha256,
  parseDocumentReadRequest,
  parseDocumentReadResult,
  type KnowledgeContextItem,
  type KnowledgeContextRequest,
} from "@sciretriever/contracts";
import {
  node,
  escape as e,
  icon,
  click,
  button,
  message,
  toast,
  download,
} from "./dom.js";
import { renderKnowledgeArtifact } from "../knowledge.js";
import { renderSynthesisSource } from "../synthesis.js";
import type { AppContext } from "./types.js";
const textOf = (item: KnowledgeContextItem): string =>
  item.kind === "generated-knowledge"
    ? (item.statement?.text ?? "该知识片段超过本次预算")
    : item.text;
export async function renderRetrieval(ctx: AppContext): Promise<void> {
  let items: KnowledgeContextItem[] = [],
    next: string | null = null,
    current: KnowledgeContextRequest | null = null;
  const basket = new Map<string, KnowledgeContextItem>();
  let busy = false;
  ctx.root.innerHTML = `<div class="split"><div class="pg"><div class="pgin"><h1 class="ptitle">检索</h1><p class="pdesc">在库内的正文和知识里找答案。只读，不会下载或加工新材料。</p><form id="ask-form"><div class="ask"><div class="box">${icon("ask")}<input id="askIn" aria-label="问题" placeholder="输入要查找的问题或关键词" required></div><button class="btn blue" id="askGo">检索</button></div><div class="opts"><span class="chipsel">范围<select id="askScope" aria-label="范围"><option value="library">全部文献</option><option value="selection" ${ctx.library.selected.size ? "" : "disabled"}>已选 ${ctx.library.selected.size} 篇</option><option value="query">当前筛选结果</option></select></span><span class="chipsel"><select id="askKinds" aria-label="内容"><option value="all">原文与知识</option><option value="source">仅原文</option><option value="knowledge">仅知识</option></select></span><label class="chipsel">数量<select id="askCount"><option>10</option><option>5</option><option>20</option></select></label><label class="chipsel">字节预算<input id="askBytes" type="number" min="1024" max="262144" value="32768" required></label></div></form><h3 class="h">结果</h3><p id="ask-status" role="status">输入问题后检索已有材料。</p><div id="ask-results"></div><button class="btn" id="ask-more" hidden>继续查找</button></div></div><aside class="panel"><div class="pin"><h4 class="h" style="margin-top:0">上下文</h4><p id="basket-count" class="f2">尚未选择片段</p><ul class="basket" id="basket"></ul><div class="acts"><button class="btn blue" id="cpMd">复制为 Markdown</button><button class="btn" id="cpJson">导出 JSON</button></div><p class="f2 caption">保留文献、固定版本和证据引用，可交给 Agent。</p></div></aside></div>`;
  if (
    new URL(location.href).searchParams.get("scope") === "selection" &&
    ctx.library.selected.size
  )
    node<HTMLSelectElement>("#askScope", ctx.root).value = "selection";
  const key = (item: KnowledgeContextItem) => JSON.stringify(item.reference);
  const renderBasket = () => {
    node("#basket", ctx.root).innerHTML = [...basket]
      .map(
        ([k, it]) =>
          `<li><span class="f2">${e(textOf(it).slice(0, 120))}</span><button class="btn q sm" data-remove="${e(k)}" aria-label="移除">✕</button></li>`,
      )
      .join("");
    node("#basket-count", ctx.root).textContent =
      `${basket.size} 条 · ${new TextEncoder().encode(JSON.stringify([...basket.values()])).length} 字节（含引用）`;
    click(
      "[data-remove]",
      (el) => {
        basket.delete(el.dataset.remove!);
        renderBasket();
        renderResults();
      },
      ctx.root,
    );
  };
  const renderResults = () => {
    const root = node("#ask-results", ctx.root);
    root.innerHTML = items
      .map(
        (it, index) =>
          `<div class="blk ${it.kind === "generated-knowledge" ? "k" : ""}"><span class="bar"></span><div style="min-width:0"><div class="tx">${e(textOf(it) || "片段超出本次预算，可展开固定来源。")}</div><div class="src"><span class="tag ${it.kind === "generated-knowledge" ? "purple" : "gray"}">${it.kind === "generated-knowledge" ? "知识" : it.kind === "metadata" ? "元数据" : "原文"}</span><button class="lk" data-source="${index}">${e(it.kind === "generated-knowledge" ? it.source_literature_ids.join(", ") : it.literature_id)}</button><button class="ev" data-fixed="${index}">固定来源</button></div><div id="fixed-${index}"></div></div><div><button class="btn sm ${basket.has(key(it)) ? "" : "q"}" data-basket="${index}">${basket.has(key(it)) ? "已加入" : "+ 上下文"}</button></div></div>`,
      )
      .join("");
    click(
      "[data-basket]",
      (el) => {
        const it = items[Number(el.dataset.basket)]!;
        const k = key(it);
        if (basket.has(k)) basket.delete(k);
        else basket.set(k, it);
        renderBasket();
        renderResults();
      },
      root,
    );
    click(
      "[data-source]",
      (el) => {
        const it = items[Number(el.dataset.source)]!;
        const id =
          it.kind === "generated-knowledge"
            ? it.source_literature_ids[0]
            : it.literature_id;
        if (id)
          ctx.openPaper(id, it.kind === "generated-knowledge" ? "know" : "doc");
      },
      root,
    );
    click(
      "[data-fixed]",
      async (el) => {
        const index = Number(el.dataset.fixed),
          it = items[index]!,
          target = node(`#fixed-${index}`, root);
        target.replaceChildren();
        const ref = document.createElement("pre");
        ref.textContent = JSON.stringify(it.reference, null, 2);
        const provenance = document.createElement("details");
        provenance.innerHTML = "<summary>来源与版本</summary>";
        provenance.append(ref);
        target.append(provenance);
        if (
          it.kind !== "generated-knowledge" &&
          it.reference.kind === "document"
        ) {
          const fixed = it.reference;
          const output = document.createElement("pre");
          let continuation: string | null = null,
            nextStart = fixed.start_utf8;
          const load = async () => {
            const req = parseDocumentReadRequest("slice", {
              document_version_id: fixed.document_version_id,
              selector: {
                kind: "range",
                start_utf8: fixed.start_utf8,
                end_utf8: fixed.end_utf8,
              },
              max_bytes: 65536,
              continuation,
            });
            const result = parseDocumentReadResult(
              "slice",
              (await ctx.api.query("document-slice", req, ctx.signal)).result,
              req,
            );
            if (
              result.document.document_version_id !==
                fixed.document_version_id ||
              result.document.representation_sha256 !==
                fixed.representation_sha256 ||
              result.document.source_material_ref.literature_id !==
                fixed.literature_id ||
              result.document.source_material_ref.asset_id !== fixed.asset_id ||
              result.document.source_material_ref.asset_sha256 !==
                fixed.asset_sha256 ||
              !result.actual_range ||
              result.actual_range.start_utf8 !== nextStart ||
              result.actual_range.end_utf8 > fixed.end_utf8 ||
              result.truncated !== result.actual_range.end_utf8 < fixed.end_utf8
            )
              throw new Error("固定来源版本或连续范围不匹配");
            if (ctx.signal.aborted || !target.isConnected) return;
            output.textContent += result.text;
            nextStart = result.actual_range.end_utf8;
            continuation = result.continuation;
            more.hidden = continuation === null;
          };
          const more = button("继续读取固定范围", load);
          target.append(output, more);
          await load();
        } else if (it.kind === "generated-knowledge") {
          const selection = parseSynthesisReadSelection({
            artifact_id: it.reference.artifact_id,
          });
          const source = await parseSynthesisSourceResult(
            (await ctx.api.query("synthesis-source", selection, ctx.signal))
              .result,
            selection,
          );
          const artifact = source.artifact;
          const statement = artifact.content.statements.find(
            (candidate) => candidate.statement_id === it.reference.statement_id,
          );
          if (
            artifact.content_ref.sha256 !== it.reference.content_sha256 ||
            artifact.input.manifest_sha256 !== it.reference.manifest_sha256 ||
            artifact.purpose !== it.purpose ||
            artifact.question !== it.question ||
            !statement ||
            (await (artifact.schema_version === 1
              ? knowledgeStatementSha256(statement)
              : synthesisStatementSha256(statement))) !==
              it.reference.statement_sha256
          )
            throw new Error("固定产物或断言与检索引用不匹配");
          if (ctx.signal.aborted || !target.isConnected) return;
          if (artifact.schema_version === 1)
            renderKnowledgeArtifact(
              artifact,
              target,
              ctx.signal,
              statement.statement_id,
            );
          else
            renderSynthesisSource(
              artifact,
              statement.statement_id,
              target,
              ctx.signal,
            );
        }
      },
      root,
    );
  };
  const run = async (req: KnowledgeContextRequest, append = false) => {
    if (busy) return;
    busy = true;
    node<HTMLButtonElement>("#askGo", ctx.root).disabled = true;
    node<HTMLButtonElement>("#ask-more", ctx.root).disabled = true;
    const status = node("#ask-status", ctx.root);
    status.textContent = "正在检索已有材料与知识…";
    try {
      const bundle = await parseKnowledgeContextBundle(
        (await ctx.api.query("knowledge-context", req, ctx.signal)).result,
        req,
      );
      if (ctx.signal.aborted) return;
      current = req;
      next = bundle.continuation;
      items = append ? [...items, ...bundle.items] : [...bundle.items];
      status.textContent = `${items.length} 条结果 · 本页 ${bundle.usage.bytes} 字节 · 覆盖：${bundle.coverage}${bundle.truncated ? " · 已截断" : ""}${
        bundle.gaps.length
          ? " · " +
            bundle.gaps
              .map((g) => g.code)
              .filter((v, i, a) => a.indexOf(v) === i)
              .join("、")
          : ""
      }`;
      renderResults();
      node("#ask-more", ctx.root).hidden = !next;
    } catch (error) {
      if (!ctx.signal.aborted)
        status.textContent = `检索未完成：${message(error)}`;
    } finally {
      busy = false;
      node<HTMLButtonElement>("#askGo", ctx.root).disabled = false;
      node<HTMLButtonElement>("#ask-more", ctx.root).disabled = false;
    }
  };
  node<HTMLFormElement>("#ask-form", ctx.root).onsubmit = (event) => {
    event.preventDefault();
    void (async () => {
      const scope = node<HTMLSelectElement>("#askScope", ctx.root).value,
        kind = node<HTMLSelectElement>("#askKinds", ctx.root).value;
      const ids =
        scope === "selection"
          ? [...ctx.library.selected]
          : scope === "query"
            ? await ctx.scopeIds()
            : [];
      const req = parseKnowledgeContextRequest({
        schema_version: 2,
        query: node<HTMLInputElement>("#askIn", ctx.root).value,
        scope:
          scope === "library"
            ? { kind: "library" }
            : { kind: "literatures", literature_ids: ids },
        kinds:
          kind === "source"
            ? ["metadata", "document"]
            : kind === "knowledge"
              ? ["knowledge"]
              : ["metadata", "document", "knowledge"],
        versions: { kind: "default" },
        knowledge:
          kind === "source"
            ? null
            : {
                purposes: [],
                question: null,
                selection: "all",
                artifact_ids: [],
              },
        budget: {
          max_items: Number(
            node<HTMLSelectElement>("#askCount", ctx.root).value,
          ),
          max_bytes: Number(
            node<HTMLInputElement>("#askBytes", ctx.root).value,
          ),
          token_limit: null,
        },
        continuation: null,
      });
      await run(req);
    })().catch((error) => toast(message(error)));
  };
  click(
    "#ask-more",
    async () => {
      if (current && next)
        await run(
          parseKnowledgeContextRequest({ ...current, continuation: next }),
          true,
        );
    },
    ctx.root,
  );
  click(
    "#cpMd",
    async () => {
      if (!basket.size) throw new Error("请先加入上下文");
      await navigator.clipboard.writeText(
        [...basket.values()]
          .map(
            (it) =>
              `${textOf(it)}\n\n来源：\`${JSON.stringify(it.reference)}\``,
          )
          .join("\n\n---\n\n"),
      );
      toast("上下文已复制");
    },
    ctx.root,
  );
  click(
    "#cpJson",
    () => {
      if (!basket.size) throw new Error("请先加入上下文");
      download(
        new Blob(
          [
            JSON.stringify(
              { query: current, items: [...basket.values()] },
              null,
              2,
            ),
          ],
          { type: "application/json" },
        ),
        "sciretriever-context.json",
      );
    },
    ctx.root,
  );
}
