import {
  parseSynthesisListSelection,
  parseSynthesisListResult,
  parseSynthesisReadSelection,
  parseSynthesisReadResult,
  parseSynthesisPreparationRequest,
  parseSynthesisPreparationResult,
  parseKnowledgeSynthesisRequest,
  type SynthesisPreparationResult,
} from "@sciretriever/contracts";
import { renderSynthesisResult } from "../synthesis.js";
import { detail } from "./library.js";
import { processingTask } from "./actions.js";
import {
  node,
  escape as e,
  icon,
  click,
  message,
  failure,
  download,
} from "./dom.js";
import type { AppContext } from "./types.js";
export async function renderSyntheses(ctx: AppContext): Promise<void> {
  ctx.root.innerHTML = `<div class="pg"><div class="pgin"><div class="crumb">使用 / 综合</div><h1 class="ptitle">综合</h1><p class="pdesc">围绕明确文献范围，比较共识、分歧、条件与局限。</p><div class="vtabs"><button class="btn blue" id="new-synthesis">${icon("plus", true)}新建综合</button><button class="btn q sm" id="refresh-syntheses">刷新</button></div><div id="synthesis-composer" hidden></div><div id="synthesis-gallery" class="gal"></div><div id="synthesis-content" class="doc"></div></div></div>`;
  const gallery = node("#synthesis-gallery", ctx.root),
    content = node("#synthesis-content", ctx.root);
  const open = async (id: string) => {
    const selection = parseSynthesisReadSelection({ artifact_id: id });
    const result = await parseSynthesisReadResult(
      (await ctx.api.query("synthesis-read", selection, ctx.signal)).result,
      selection,
    );
    if (ctx.signal.aborted) return;
    gallery.hidden = true;
    content.innerHTML = "";
    const toolbar = document.createElement("div");
    toolbar.className = "acts";
    const back = document.createElement("button");
    back.className = "btn q sm";
    back.textContent = "返回全部综合";
    back.onclick = () => {
      content.replaceChildren();
      gallery.hidden = false;
    };
    const exportButton = document.createElement("button");
    exportButton.className = "btn sm";
    exportButton.textContent = "导出综合";
    exportButton.onclick = () =>
      download(
        new Blob([JSON.stringify(result, null, 2)], {
          type: "application/json",
        }),
        `${id}.json`,
      );
    toolbar.append(back, exportButton);
    const body = document.createElement("div");
    content.append(toolbar, body);
    renderSynthesisResult(result, body, ctx.signal);
  };
  const load = async () => {
    const selection = parseSynthesisListSelection({
      manifest_sha256: null,
      limit: 20,
    });
    try {
      const list = await parseSynthesisListResult(
        (await ctx.api.query("synthesis-list", selection, ctx.signal)).result,
        selection,
      );
      if (ctx.signal.aborted) return;
      gallery.innerHTML =
        list
          .map(
            ({ artifact: a }) =>
              `<button class="card" data-synthesis="${e(a.artifact_id)}"><div class="cb"><span class="ct">${e(a.content.title)}</span><span class="f2">${e(a.question)}</span><span class="tag ${a.coverage.status === "complete" ? "green" : "yellow"}">${a.coverage.unique_literature_count} 篇 · ${e(a.coverage.status)}</span></div></button>`,
          )
          .join("") || '<p class="f3">尚无已发布的综合结果。</p>';
      click("[data-synthesis]", (el) => open(el.dataset.synthesis!), gallery);
    } catch (error) {
      if (!ctx.signal.aborted) failure(gallery, error, load);
    }
  };
  click("#refresh-syntheses", load, ctx.root);
  click(
    "#new-synthesis",
    async () => {
      const ids = ctx.library.selected.size
        ? [...ctx.library.selected]
        : await ctx.scopeIds();
      const root = node("#synthesis-composer", ctx.root);
      root.hidden = false;
      root.innerHTML = `<form id="workspace-synthesis-form" class="composer"><p>输入范围：${ids.length} 篇文献。准备阶段固定当前文档版本，不自动获取或解析。</p><label>研究问题<textarea id="workspace-synthesis-question" required placeholder="希望比较什么共识、分歧或条件？"></textarea></label><label>缺口策略<select id="workspace-synthesis-policy"><option value="require-all">全部输入就绪后执行</option><option value="allow-partial">允许部分覆盖，明确记录缺口</option></select></label><div class="acts"><button class="btn" id="workspace-synthesis-prepare">固定输入</button><button class="btn blue" id="workspace-synthesis-start" type="button" disabled>开始综合</button></div><p id="workspace-synthesis-status" role="status"></p></form>`;
      const submissionKey = crypto.randomUUID();
      let prepared: SynthesisPreparationResult | null = null;
      const status = node("#workspace-synthesis-status", root);
      node<HTMLSelectElement>("#workspace-synthesis-policy", root).onchange =
        () => {
          prepared = null;
          node<HTMLButtonElement>("#workspace-synthesis-start", root).disabled =
            true;
        };
      node<HTMLFormElement>("#workspace-synthesis-form", root).onsubmit = (
        event,
      ) => {
        event.preventDefault();
        const button = node<HTMLButtonElement>(
          "#workspace-synthesis-prepare",
          root,
        );
        button.disabled = true;
        status.textContent = "正在固定已有输入…";
        void (async () => {
          const inputs = [];
          for (const [index, id] of ids.entries()) {
            const paper = await detail(ctx, id),
              asset = paper.primary_pdf?.asset;
            inputs.push({
              kind: "document",
              input_id: `source-${index + 1}`,
              literature_id: id,
              asset_id: asset?.asset_id ?? null,
              asset_sha256: asset?.sha256 ?? null,
              document_version_id: null,
            });
          }
          const request = parseSynthesisPreparationRequest({
            policy: node<HTMLSelectElement>("#workspace-synthesis-policy", root)
              .value,
            inputs,
          });
          prepared = await parseSynthesisPreparationResult(
            (await ctx.api.query("synthesis-prepare", request, ctx.signal))
              .result,
            request,
          );
          if (ctx.signal.aborted) return;
          status.textContent = `已固定 ${prepared.manifest.items.length} 项 · ${prepared.ready ? "可以综合" : "输入不足"}${prepared.gaps.length ? " · " + prepared.gaps.map((g) => `${g.input_id}: ${g.code}`).join("；") : ""}`;
          node<HTMLButtonElement>("#workspace-synthesis-start", root).disabled =
            !prepared.ready;
        })()
          .catch((error) => {
            status.textContent = message(error);
          })
          .finally(() => {
            button.disabled = false;
          });
      };
      click(
        "#workspace-synthesis-start",
        async (el) => {
          if (!prepared?.ready) return;
          (el as HTMLButtonElement).disabled = true;
          try {
            const request = await parseKnowledgeSynthesisRequest({
              schema_version: 3,
              input: prepared.manifest,
              purpose: "synthesis",
              question: node<HTMLTextAreaElement>(
                "#workspace-synthesis-question",
                root,
              ).value,
              policy: prepared.policy,
            });
            const id = await processingTask(
              ctx,
              [{ operation: "synthesize", request }],
              submissionKey,
            );
            ctx.navigate("task", { task: id });
          } catch (error) {
            status.textContent = message(error);
            (el as HTMLButtonElement).disabled = false;
          }
        },
        root,
      );
    },
    ctx.root,
  );
  await load();
  const linked = new URL(location.href).searchParams.get("artifact");
  if (linked && !ctx.signal.aborted) await open(linked);
}
