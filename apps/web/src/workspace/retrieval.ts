import {
  parseKnowledgeContextRequest,
  parseKnowledgeContextBundle,
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
import {
  openContextSource,
  renderFixedKnowledge,
} from "./source-navigation.js";
import type { AppContext, RetrievalState } from "./types.js";
const textOf = (item: KnowledgeContextItem): string =>
  item.kind === "generated-knowledge"
    ? (item.statement?.text ?? "该知识片段超过本次预算")
    : item.text;
export const createRetrievalState = (): RetrievalState => ({
  draft: {
    query: "",
    scope: "library",
    kinds: "all",
    count: "10",
    bytes: "32768",
  },
  items: [],
  next: null,
  current: null,
  basket: new Map(),
  status: "输入关键词后检索已有材料。",
});
export async function renderRetrieval(ctx: AppContext): Promise<void> {
  const state = ctx.retrieval;
  let { items, next, current } = state;
  const basket = state.basket;
  let busy = false;
  ctx.root.innerHTML = `<div class="split"><div class="pg"><div class="pgin"><h1 class="ptitle">检索</h1><p class="pdesc">在库内的正文和知识里找答案。只读，不会下载或加工新材料。</p><form id="ask-form"><div class="ask"><div class="box">${icon("ask")}<input id="askIn" aria-label="问题" placeholder="输入要查找的问题或关键词" required></div><button class="btn blue" id="askGo">检索</button></div><div class="opts"><span class="chipsel">范围<select id="askScope" aria-label="范围"><option value="library">全部文献</option><option value="selection" ${ctx.library.selected.size ? "" : "disabled"}>已选 ${ctx.library.selected.size} 篇</option><option value="query">当前筛选结果</option></select></span><span class="chipsel"><select id="askKinds" aria-label="内容"><option value="all">原文与知识</option><option value="source">仅原文</option><option value="knowledge">仅知识</option></select></span><label class="chipsel">数量<select id="askCount"><option>10</option><option>5</option><option>20</option></select></label><label class="chipsel">字节预算<input id="askBytes" type="number" min="1024" max="262144" value="32768" required></label></div></form><h3 class="h">结果</h3><p id="ask-status" role="status">输入问题后检索已有材料。</p><div id="ask-results"></div><button class="btn" id="ask-more" hidden>继续查找</button></div></div><aside class="panel"><div class="pin"><h4 class="h" style="margin-top:0">上下文</h4><p id="basket-count" class="f2">尚未选择片段</p><ul class="basket" id="basket"></ul><div class="acts"><button class="btn blue" id="cpMd">复制为 Markdown</button><button class="btn" id="cpJson">导出 JSON</button></div><p class="f2 caption">保留文献、固定版本和证据引用，可交给 Agent。</p></div></aside></div>`;
  if (
    new URL(location.href).searchParams.get("scope") === "selection" &&
    ctx.library.selected.size
  )
    state.draft.scope = "selection";
  if (state.draft.scope === "selection" && !ctx.library.selected.size)
    state.draft.scope = "library";
  const fields = {
    query: node<HTMLInputElement>("#askIn", ctx.root),
    scope: node<HTMLSelectElement>("#askScope", ctx.root),
    kinds: node<HTMLSelectElement>("#askKinds", ctx.root),
    count: node<HTMLSelectElement>("#askCount", ctx.root),
    bytes: node<HTMLInputElement>("#askBytes", ctx.root),
  };
  const explanation = document.createElement("p");
  explanation.className = "f2 caption";
  explanation.textContent =
    "按词法关键词匹配，多关键词须同时命中；不自动翻译或扩展含义。";
  const languageHint = document.createElement("p");
  languageHint.id = "ask-language-hint";
  languageHint.className = "f2 caption";
  languageHint.setAttribute("role", "note");
  languageHint.textContent =
    "当前不会自动跨语言匹配；检索英文原文可尝试原文关键词。中文按连续词串匹配，子词不保证命中。";
  const hint = () => {
    languageHint.hidden = !/\p{Script=Han}/u.test(fields.query.value);
  };
  node("#ask-form", ctx.root).append(explanation, languageHint);
  fields.query.setAttribute("aria-describedby", languageHint.id);
  for (const [key, field] of Object.entries(fields)) {
    field.value = state.draft[key as keyof typeof fields];
    field.addEventListener("input", () => {
      state.draft[key as keyof typeof fields] = field.value;
      hint();
    });
  }
  hint();
  node("#ask-status", ctx.root).textContent = state.status;
  node("#ask-more", ctx.root).hidden = !next;
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
          `<div class="blk ${it.kind === "generated-knowledge" ? "k" : ""}"><span class="bar"></span><div style="min-width:0"><div class="tx">${e(textOf(it) || "片段超出本次预算，可展开固定来源。")}</div><div class="src"><span class="tag ${it.kind === "generated-knowledge" ? "purple" : "gray"}">${it.kind === "generated-knowledge" ? (it.purpose === "synthesis" ? "综合" : "知识") : it.kind === "metadata" ? "元数据" : "原文"}</span><button class="lk" data-source="${index}">${e(it.kind === "generated-knowledge" ? it.source_literature_ids.join(", ") : it.literature_id)}</button><button class="ev" data-fixed="${index}">固定来源</button></div><div id="fixed-${index}"></div></div><div><button class="btn sm ${basket.has(key(it)) ? "" : "q"}" data-basket="${index}">${basket.has(key(it)) ? "已加入" : "+ 上下文"}</button></div></div>`,
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
        openContextSource(ctx, it);
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
          await renderFixedKnowledge(ctx, it.reference, target);
        }
      },
      root,
    );
  };
  const run = async (req: KnowledgeContextRequest, append = false) => {
    if (busy || ctx.signal.aborted) return;
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
      state.current = current = req;
      state.next = next = bundle.continuation;
      state.items = items = append
        ? [...items, ...bundle.items]
        : [...bundle.items];
      const codes = [bundle.coverage, ...bundle.gaps.map((g) => g.code)];
      const indexIssue = [
        ["index-unavailable", "检索索引尚未建立"],
        ["index-stale", "检索索引已过期"],
        ["index-corrupt", "检索索引不可用"],
      ]
        .filter(([code]) => codes.some((value) => value.endsWith(code!)))
        .map(([, text]) => text)
        .join("；");
      const emptyNote = indexIssue
        ? ` · ${indexIssue}，请在设置 → 高级中显式重建对应的材料／知识索引；当前结果不代表完整检索`
        : items.length
          ? ""
          : " · 未匹配当前关键词，可尝试原文用词或调整范围";
      state.status =
        status.textContent = `${items.length} 条结果${emptyNote} · 本页 ${bundle.usage.bytes} 字节 · 覆盖：${bundle.coverage}${bundle.truncated ? " · 已截断" : ""}${
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
        state.status = status.textContent = `检索未完成：${message(error)}`;
    } finally {
      busy = false;
      if (!ctx.signal.aborted) {
        node<HTMLButtonElement>("#askGo", ctx.root).disabled = false;
        node<HTMLButtonElement>("#ask-more", ctx.root).disabled = false;
      }
    }
  };
  ctx.signal.addEventListener(
    "abort",
    () => {
      if (busy) state.status = "检索已中止；保留上次结果，可重新检索。";
    },
    { once: true },
  );
  let preparing = false;
  node<HTMLFormElement>("#ask-form", ctx.root).onsubmit = (event) => {
    event.preventDefault();
    if (busy || preparing || ctx.signal.aborted) return;
    preparing = true;
    const draft = { ...state.draft };
    void (async () => {
      const scope = draft.scope,
        kind = draft.kinds;
      const ids =
        scope === "selection"
          ? [...ctx.library.selected]
          : scope === "query"
            ? await ctx.scopeIds()
            : [];
      const req = parseKnowledgeContextRequest({
        schema_version: 2,
        query: draft.query,
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
                purposes: ["overview", "detailed", "question", "synthesis"],
                question: null,
                selection: "all",
                artifact_ids: [],
              },
        budget: {
          max_items: Number(draft.count),
          max_bytes: Number(draft.bytes),
          token_limit: null,
        },
        continuation: null,
      });
      await run(req);
    })()
      .catch((error) => {
        if (!ctx.signal.aborted)
          node("#ask-status", ctx.root).textContent =
            state.status = `检索未完成：${message(error)}`;
      })
      .finally(() => {
        preparing = false;
      });
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
  renderResults();
  renderBasket();
}
