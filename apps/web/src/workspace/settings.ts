import { detail } from "./library.js";
import { mountConfiguration } from "../config.js";
import { mountMaintenanceWorkbench } from "../maintenance.js";
import { mountExtractionPreparation } from "../query.js";
import { node, click, button } from "./dom.js";
import type { AppContext } from "./types.js";
export function renderSettings(ctx: AppContext): void {
  const requested = new URL(location.href).searchParams.get("setting");
  if (ctx.root.dataset.mounted === "true") {
    if (requested)
      ctx.root
        .querySelector<HTMLButtonElement>(
          `[data-setting="${CSS.escape(requested)}"]`,
        )
        ?.click();
    return;
  }
  ctx.root.innerHTML =
    '<div class="pg"><div class="pgin settings-page"><h1 class="ptitle">设置</h1><div class="vtabs" id="setting-tabs"></div><div id="settings-content"></div></div></div>';
  const template = node<HTMLTemplateElement>("#configuration-template");
  node("#settings-content", ctx.root).append(template.content.cloneNode(true));
  const section = node("#config-workspace", ctx.root);
  section.querySelector(".live-heading")?.remove();
  const tabs: [string, string, string[]][] = [
    ["paths", "文献库位置", ["paths-config-form"]],
    ["sources", "文献来源", ["source-config-form"]],
    ["models", "模型", ["provider-model-form", "config-form"]],
    ["parser", "解析与 Browser", ["config-form"]],
    ["cred", "凭据", ["config-credential-form"]],
    ["status", "运行状态", []],
  ];
  const forms = [...section.querySelectorAll<HTMLElement>(":scope > form")];
  const status = section.querySelector<HTMLElement>(":scope > section");
  const choose = (id: string) => {
    const tab = tabs.find((t) => t[0] === id)!;
    for (const form of forms) form.hidden = !tab[2].includes(form.id);
    if (status) status.hidden = id !== "status";
    for (const b of ctx.root.querySelectorAll("[data-setting]"))
      b.classList.toggle("on", (b as HTMLElement).dataset.setting === id);
  };
  node("#setting-tabs", ctx.root).innerHTML =
    tabs
      .map(
        ([id, label]) =>
          `<button class="vt" data-setting="${id}">${label}</button>`,
      )
      .join("") + '<button class="vt" id="open-advanced">高级</button>';
  click("[data-setting]", (el) => choose(el.dataset.setting!), ctx.root);
  click(
    "#open-advanced",
    () => ctx.navigate("ext", { advanced: "all" }),
    ctx.root,
  );
  node("#current-database-binding", ctx.root).textContent =
    `当前进程：Catalog ${ctx.api.workspace.catalog ?? "未提供"}；资产目录 ${ctx.api.workspace.artifacts ?? "未提供"}。`;
  mountConfiguration({
    read: (path) => ctx.api.read(path),
    request: (path, body) => ctx.api.request(path, body),
  });
  const appearance = document.createElement("div");
  appearance.className = "field appearance";
  appearance.innerHTML =
    '<label>外观<select id="appearance"><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option><option value="green">墨绿</option><option value="warm">暖白</option></select></label>';
  node("#paths-config-form", ctx.root).append(appearance);
  const theme = node<HTMLSelectElement>("#appearance", ctx.root);
  theme.value = document.documentElement.dataset.theme ?? "system";
  theme.onchange = () => {
    if (theme.value === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme.value;
    try {
      localStorage.setItem("sciretriever:theme:v1", theme.value);
    } catch {
      /* The selected appearance still applies for this tab. */
    }
  };
  choose(tabs.some(([id]) => id === requested) ? requested! : "paths");
  ctx.root.dataset.mounted = "true";
}
export function renderAdvanced(ctx: AppContext): void {
  const advanced =
    new URL(location.href).searchParams.get("advanced") === "all";
  if (ctx.root.dataset.mounted !== "true") {
    ctx.root.innerHTML =
      '<div class="pg"><div class="pgin"><h1 class="ptitle" id="tools-title">提取</h1><p class="pdesc" id="tools-description"></p><div class="vtabs"><button class="vt on" data-tools="extraction">规范与交付</button><button class="vt" data-tools="all">高级加工工具</button></div><div class="callout" id="extraction-explanation">准备已有材料、固定提取规范，并提交带证据的候选结果。当前接口支持调用方交付；此页面尚未提供内置 Agent 自动提取执行器。</div><div id="advanced-content"></div></div></div>';
    node("#advanced-content", ctx.root).append(
      node<HTMLTemplateElement>("#advanced-template").content.cloneNode(true),
    );
    mountMaintenanceWorkbench({ fetch: ctx.api.fetch, durableTasks: true });
    document.documentElement.dataset.queryReadiness = "ready";
    mountExtractionPreparation();
    const prepare = node("#extraction-prepare-form", ctx.root);
    const helper = document.createElement("div");
    helper.className = "acts";
    helper.append(
      button("使用库中选定范围", async () => {
        const ids = ctx.library.selected.size
          ? [...ctx.library.selected]
          : await ctx.scopeIds();
        for (const id of ids) await detail(ctx, id);
        const field = node<HTMLTextAreaElement>("#extraction-inputs", ctx.root);
        field.value = JSON.stringify(
          ids.map((id, i) => ({
            input_id: `source-${i + 1}`,
            literature_id: id,
            asset_id: ctx.details.get(id)?.primary_pdf?.asset.asset_id ?? null,
            asset_sha256:
              ctx.details.get(id)?.primary_pdf?.asset.sha256 ?? null,
            document_version_id: null,
          })),
          null,
          2,
        );
        field.dispatchEvent(new Event("input"));
      }),
    );
    prepare.prepend(helper);
    const raw = document.createElement("details");
    raw.className = "tg";
    raw.innerHTML =
      '<summary>提交加工请求 JSON</summary><p class="f2">高级入口，遵循同一 ProcessingTaskRequest 合同。</p><textarea id="raw-processing" rows="8" aria-label="加工请求 JSON"></textarea><label><input id="raw-start" type="checkbox">保存后立即执行</label><button class="btn" id="raw-submit">提交任务</button><p id="raw-status" role="status"></p>';
    node("#maintenance-workspace", ctx.root).append(raw);
    click(
      "#raw-submit",
      async () => {
        const { parseProcessingTaskRequest, parseStrictJsonValue } =
          await import("@sciretriever/contracts");
        const { createTask } = await import("./actions.js");
        const request = await parseProcessingTaskRequest(
          parseStrictJsonValue(
            node<HTMLTextAreaElement>("#raw-processing", ctx.root).value,
          ),
        );
        const id = await createTask(
          ctx,
          { kind: "processing", request },
          node<HTMLInputElement>("#raw-start", ctx.root).checked,
        );
        node("#raw-status", ctx.root).textContent = `任务已提交：${id}`;
        node("#raw-status", ctx.root).append(
          button("查看任务", () => ctx.navigate("task", { task: id })),
        );
      },
      ctx.root,
    );
    ctx.root.dataset.mounted = "true";
  }
  const choose = (all: boolean) => {
    const root = node("#maintenance-workspace", ctx.root);
    for (const child of [...root.children]) {
      if (!(child instanceof HTMLElement)) continue;
      child.hidden =
        !all &&
        !(
          child.id === "extraction-prepare-form" ||
          child.querySelector("#extraction-create")
        );
    }
    node("#tools-title", ctx.root).textContent = all ? "高级工具" : "提取";
    node("#tools-description", ctx.root).textContent = all
      ? "复用正式维护与任务接口。以下操作均需明确提交。"
      : "按调用方定义的规范准备材料和交付候选；领域接纳由下游负责。";
    for (const tab of ctx.root.querySelectorAll<HTMLElement>("[data-tools]"))
      tab.classList.toggle(
        "on",
        tab.dataset.tools === (all ? "all" : "extraction"),
      );
  };
  for (const tab of ctx.root.querySelectorAll<HTMLElement>("[data-tools]"))
    tab.onclick = () => choose(tab.dataset.tools === "all");
  choose(advanced);
}
