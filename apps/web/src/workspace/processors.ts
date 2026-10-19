import {
  parseProcessorBatchRequest,
  parseDocumentReadResult,
  type ProcessorObject,
} from "@sciretriever/contracts";
import { node, escape as e, icon, click, button, message } from "./dom.js";
import { jobRecord, record } from "../wire.js";
import { detail, title } from "./library.js";
import { renderAdvanced } from "./settings.js";
import { renderProcessorSummary } from "./processor-results.js";
import type { AppContext, ProcessorFormState } from "./types.js";

export const createProcessorFormState = (): ProcessorFormState => ({
  kind: "records",
  scope: "query",
  meaning: "",
  inclusion: "",
  question: "",
  answerType: "boolean",
  choices: "",
  reading: "full",
  readingQuery: "",
  fields: [{ name: "", description: "", type: "string", unit: "" }],
  submission: null,
});
const failureText: Readonly<Record<string, string>> = {
  "catalog-v10-required":
    "此文献库需要显式升级后才能使用处理器；已有文献仍可阅读。",
  "agent-role-unconfigured": "尚未配置分析模型，请在设置中配置后重启服务。",
  "agent-unconfigured": "尚未配置分析模型，请在设置中配置后重启服务。",
  "agent-configuration": "分析模型配置不可用，请在设置中核对后重启服务。",
  "processor-unknown": "当前服务不支持所选处理器版本，请刷新后核对。",
  "processor-spec": "处理规范不受支持，请核对问题、字段类型与读取范围。",
  "processor-idempotency-conflict":
    "本次提交标识已用于不同请求，请先核对已有任务。",
  "processor-binding-changed": "处理模型配置已变化，请核对设置后另起任务。",
};
const fits = (value: string, bytes: number) =>
  new TextEncoder().encode(value).length <= bytes;
export const processorMessage = (error: unknown) => {
  const code = message(error);
  return (
    failureText[code] ??
    `操作未完成：${code}。草稿已保留，可重试或到任务页核对。`
  );
};

/** G1-approved human forms; legacy delivery remains a separate, supported tool. */
export async function renderProcessors(context: AppContext): Promise<void> {
  // The legacy container is retained, but each new render gets an immutable lifecycle signal.
  const ctx = { ...context };
  if (!ctx.root.querySelector("#processor-workspace")) {
    ctx.root.replaceChildren();
    delete ctx.root.dataset.mounted;
    ctx.root.innerHTML =
      '<div id="processor-workspace" class="workspace-page"></div><div id="processor-legacy" class="workspace-page" hidden></div>';
  }
  const main = node("#processor-workspace", ctx.root),
    legacy = node("#processor-legacy", ctx.root);
  const params = new URL(location.href).searchParams;
  const advanced =
    params.get("advanced") === "all" || params.get("tools") === "delivery";
  main.hidden = advanced;
  legacy.hidden = !advanced;
  if (advanced) {
    renderAdvanced({ ...ctx, root: legacy });
    if (!legacy.querySelector("#back-to-processors")) {
      const back = button("返回新建处理", () => ctx.navigate("ext"));
      back.id = "back-to-processors";
      node(".vtabs", legacy).prepend(back);
    }
    return;
  }
  const view = { ...ctx, root: main };
  if (
    params.has("result") ||
    params.has("collection") ||
    params.has("results")
  ) {
    await renderProcessorSummary(view, params);
    return;
  }
  await renderForm(view);
  if (!ctx.signal.aborted) {
    const results = button("已有结果", () =>
      ctx.navigate("ext", { results: "all" }),
    );
    results.id = "processor-existing-results";
    node(".vtabs", main).insertBefore(
      results,
      node("#processor-delivery", main),
    );
  }
}

async function renderForm(ctx: AppContext): Promise<void> {
  const state = ctx.processor;
  if (
    new URL(location.href).searchParams.get("scope") === "selection" &&
    ctx.library.selected.size
  )
    state.scope = "selection";
  if (!ctx.library.selected.size) state.scope = "query";
  let ids: string[] = [],
    scopeRevision = 0,
    ready = false,
    submitting = false;
  ctx.root.innerHTML = `<div class="pg"><div class="pgin processor-content"><div class="processor-title"><h1 class="ptitle">提取</h1><p class="f2">把已有文献中的信息整理成可核对的结果。</p></div><div class="vtabs"><span class="vt on">新建处理</span><button class="vt" id="processor-delivery">规范与外部交付</button></div><div class="processor-grid"><form class="processor-form" id="processor-form" novalidate><div class="seg" role="tablist" aria-label="处理方式"><button type="button" data-processor-kind="records" role="tab">记录提取</button><button type="button" data-processor-kind="labels" role="tab">文献标签</button></div><div id="processor-records"><label for="processor-meaning">每条记录代表什么</label><textarea id="processor-meaning" maxlength="4096" placeholder="例如：一组在明确条件下报告的测量"></textarea><small>说明记录的粒度，保留不同实验或条件的区别。</small><label for="processor-inclusion">纳入条件 <span class="f2">· 可选</span></label><input id="processor-inclusion" maxlength="4096" placeholder="例如：只保留本文实际报告的观测"><h2>需要哪些字段</h2><small>每个值保留对应证据；没有依据时说明缺失原因。</small><div id="processor-fields"></div><button class="btn q" id="processor-add-field" type="button">${icon("plus", true)}添加字段</button></div><div id="processor-labels" hidden><label for="processor-question">对每篇文献问一个问题</label><textarea id="processor-question" maxlength="4096" placeholder="希望根据正文逐篇判断什么？"></textarea><small>证据不足显示“无法判断”（空值），不会默认判为“否”。</small><label for="processor-answer-type">答案类型</label><select id="processor-answer-type"><option value="boolean">是 / 否</option><option value="string">简短文字</option><option value="enum">指定选项</option></select><div id="processor-choices-area" hidden><label for="processor-choices">可选答案</label><textarea id="processor-choices" placeholder="每行一个选项"></textarea></div></div><div class="processor-reading"><h2>读取范围</h2><label><input type="radio" name="processor-reading" value="full">全部可读正文 <span class="f2">· 默认</span></label><label><input type="radio" name="processor-reading" value="search">仅与关键词匹配的片段</label><div id="processor-search-reading" hidden><input id="processor-reading-query" maxlength="1024" aria-label="片段关键词" placeholder="使用与原文一致的关键词"><p class="processor-partial">仅处理匹配片段，结果会标为部分覆盖。未匹配内容不据此判定为没有信息。</p></div><small>使用已解析正文；不自动获取补充材料，也不把图片视作已分析。</small></div><p id="processor-validation" role="alert" class="processor-error"></p></form><aside class="processor-aside"><h2>处理哪些文献</h2><select id="processor-scope" aria-label="文献范围"><option value="selection" ${ctx.library.selected.size ? "" : "disabled"}>${ctx.library.selected.size === 1 ? "当前文献 · 1 篇" : `文献库中已选的 ${ctx.library.selected.size} 篇`}</option><option value="query">当前筛选的全部文献</option></select><p id="processor-scope-status" role="status">正在读取范围…</p><div id="processor-gaps"></div><button class="btn blue submit" id="processor-submit" form="processor-form" disabled>开始提取</button><p>提交时固定输入版本，会调用已配置的模型。已有且完整匹配的结果会复用，原文与已发布结果保持不变。</p><button class="btn q sm" id="processor-settings">模型设置</button><div class="processor-feedback" id="processor-feedback" role="status"></div></aside></div></div></div>`;
  const bind = <
    K extends "meaning" | "inclusion" | "question" | "choices" | "readingQuery",
  >(
    selector: string,
    key: K,
  ) => {
    const input = node<HTMLInputElement | HTMLTextAreaElement>(
      selector,
      ctx.root,
    );
    input.value = state[key];
    input.oninput = () => {
      state[key] = input.value;
      input.removeAttribute("aria-invalid");
    };
  };
  bind("#processor-meaning", "meaning");
  bind("#processor-inclusion", "inclusion");
  bind("#processor-question", "question");
  bind("#processor-choices", "choices");
  bind("#processor-reading-query", "readingQuery");
  const sync = () => {
    node("#processor-records", ctx.root).hidden = state.kind !== "records";
    node("#processor-labels", ctx.root).hidden = state.kind !== "labels";
    node("#processor-choices-area", ctx.root).hidden =
      state.answerType !== "enum";
    node("#processor-search-reading", ctx.root).hidden =
      state.reading !== "search";
    node("#processor-submit", ctx.root).textContent =
      state.kind === "records" ? "开始提取" : "生成文献标签";
    for (const tab of ctx.root.querySelectorAll<HTMLElement>(
      "[data-processor-kind]",
    )) {
      const selected = tab.dataset.processorKind === state.kind;
      tab.classList.toggle("on", selected);
      tab.setAttribute("aria-selected", String(selected));
    }
  };
  const renderFields = () => {
    const root = node("#processor-fields", ctx.root);
    root.innerHTML = state.fields
      .map(
        (field, index) =>
          `<div class="processor-field"><label>字段名<input data-field="name" data-index="${index}" maxlength="64" placeholder="field_name" aria-label="字段 ${index + 1} 名称" value="${e(field.name)}"></label><label class="description">希望提取什么<textarea data-field="description" data-index="${index}" maxlength="2048" aria-label="字段 ${index + 1} 说明" placeholder="含义与取值条件">${e(field.description)}</textarea></label><label>类型<select data-field="type" data-index="${index}" aria-label="字段 ${index + 1} 类型">${[
            ["string", "文字"],
            ["number", "数值"],
            ["boolean", "是 / 否"],
          ]
            .map(
              ([v, l]) =>
                `<option value="${v}" ${v === field.type ? "selected" : ""}>${l}</option>`,
            )
            .join(
              "",
            )}</select></label><button class="btn q sm remove" type="button" data-remove-field="${index}" aria-label="删除字段 ${index + 1}"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button><label class="unit" ${field.type === "number" ? "" : "hidden"}>单位说明<input data-field="unit" data-index="${index}" maxlength="128" value="${e(field.unit)}" placeholder="保留原文单位，不自动换算" aria-label="字段 ${index + 1} 单位说明"></label></div>`,
      )
      .join("");
    for (const input of root.querySelectorAll<
      HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
    >("[data-field]"))
      input.oninput = () => {
        const field = state.fields[Number(input.dataset.index)]!;
        const key = input.dataset.field!;
        if (key === "type") {
          field.type = input.value as typeof field.type;
          node(".unit", input.closest(".processor-field")!).hidden =
            field.type !== "number";
        } else if (key === "name" || key === "description" || key === "unit")
          field[key] = input.value;
        input.removeAttribute("aria-invalid");
      };
    click(
      "[data-remove-field]",
      (el) => {
        state.fields.splice(Number(el.dataset.removeField), 1);
        renderFields();
      },
      root,
    );
    node<HTMLButtonElement>("#processor-add-field", ctx.root).disabled =
      state.fields.length >= 64;
  };
  renderFields();
  sync();
  click(
    "#processor-add-field",
    () => {
      if (state.fields.length < 64) {
        state.fields.push({
          name: "",
          description: "",
          type: "string",
          unit: "",
        });
        renderFields();
        node(
          "#processor-fields .processor-field:last-child input",
          ctx.root,
        ).focus();
      }
    },
    ctx.root,
  );
  click(
    "[data-processor-kind]",
    (el) => {
      state.kind = el.dataset.processorKind as typeof state.kind;
      sync();
    },
    ctx.root,
  );
  const answer = node<HTMLSelectElement>("#processor-answer-type", ctx.root);
  answer.value = state.answerType;
  answer.onchange = () => {
    state.answerType = answer.value as typeof state.answerType;
    sync();
  };
  for (const radio of ctx.root.querySelectorAll<HTMLInputElement>(
    '[name="processor-reading"]',
  )) {
    radio.checked = radio.value === state.reading;
    radio.onchange = () => {
      state.reading = radio.value as typeof state.reading;
      sync();
    };
  }
  click("#processor-settings", () => ctx.navigate("set"), ctx.root);
  click(
    "#processor-delivery",
    () => ctx.navigate("ext", { tools: "delivery" }),
    ctx.root,
  );
  const feedback = () => {
    const root = node("#processor-feedback", ctx.root),
      saved = state.submission;
    root.replaceChildren();
    if (!saved) return;
    const note = document.createElement("p");
    note.textContent = saved.note;
    root.append(note);
    if (saved.jobId)
      root.append(
        button("查看任务", () => ctx.navigate("task", { task: saved.jobId! })),
      );
  };
  feedback();
  const scope = node<HTMLSelectElement>("#processor-scope", ctx.root);
  scope.value = state.scope;
  const refreshScope = async () => {
    const revision = ++scopeRevision;
    ready = false;
    ids = [];
    node<HTMLButtonElement>("#processor-submit", ctx.root).disabled = true;
    const status = node("#processor-scope-status", ctx.root);
    status.textContent = "正在读取范围与已有材料…";
    node("#processor-gaps", ctx.root).replaceChildren();
    try {
      const selected =
        state.scope === "selection"
          ? [...ctx.library.selected]
          : await ctx.scopeIds();
      if (!selected.length)
        throw new Error("当前范围没有文献，请先从文献库选择。");
      if (selected.length > 1000)
        throw new Error("当前范围超过 1000 篇，请缩小范围。");
      const registry = (await ctx.api.processors("list", {}, ctx.signal))
        .result;
      if (
        !Array.isArray(registry) ||
        !["labels", "records"].every((id) =>
          registry.some((raw) => {
            const p = record(raw, "processor");
            return p.id === id && p.version === "1";
          }),
        )
      )
        throw new Error("当前服务不支持此版本的标签或记录提取");
      const gaps: string[] = [];
      let offset = 0;
      await Promise.all(
        Array.from({ length: Math.min(4, selected.length) }, async () => {
          while (
            offset < selected.length &&
            !ctx.signal.aborted &&
            revision === scopeRevision
          ) {
            const id = selected[offset++]!,
              paper = await detail(ctx, id),
              asset = paper.primary_pdf?.asset;
            if (!asset) {
              gaps.push(`${title(paper)} · 无 PDF`);
              continue;
            }
            const request = {
              literature_id: id,
              asset_id: asset.asset_id,
              asset_sha256: asset.sha256,
            };
            const current = parseDocumentReadResult(
              "default",
              (await ctx.api.query("document-default", request, ctx.signal))
                .result,
              request,
            );
            if (!current.default) gaps.push(`${title(paper)} · 未解析`);
          }
        }),
      );
      if (ctx.signal.aborted || revision !== scopeRevision) return;
      ids = selected;
      ready =
        !!ctx.api.workspace.capabilities.tasks &&
        !!ctx.api.workspace.capabilities.maintenance;
      status.textContent = `${ids.length} 篇 · 提交时固定输入版本${ready ? "" : " · 当前部署不提供处理器写入"}`;
      if (gaps.length)
        node("#processor-gaps", ctx.root).innerHTML =
          `<p class="processor-partial">${gaps.length} 篇缺少解析正文，将保留为缺口。${gaps.length === ids.length ? "当前范围没有可处理正文，可先到文献库显式启动解析。" : "其余已有文档可继续处理。"}</p><details><summary>查看缺少材料的文献</summary><ul>${gaps.map((g) => `<li>${e(g)}</li>`).join("")}</ul></details>`;
    } catch (error) {
      if (!ctx.signal.aborted && revision === scopeRevision)
        status.textContent = processorMessage(error);
    } finally {
      if (!ctx.signal.aborted && revision === scopeRevision)
        node<HTMLButtonElement>("#processor-submit", ctx.root).disabled =
          !ready || submitting;
    }
  };
  scope.onchange = () => {
    state.scope = scope.value as typeof state.scope;
    void refreshScope();
  };
  node<HTMLFormElement>("#processor-form", ctx.root).onsubmit = (event) => {
    event.preventDefault();
    if (!ready || submitting || ctx.signal.aborted) return;
    const errorRoot = node("#processor-validation", ctx.root);
    errorRoot.textContent = "";
    let invalid: HTMLElement | null = null;
    const invalidField = (selector: string, text: string) => {
      const field = node(selector, ctx.root);
      field.setAttribute("aria-invalid", "true");
      invalid ??= field;
      if (!errorRoot.textContent) errorRoot.textContent = text;
    };
    const spec: ProcessorObject = {};
    if (state.kind === "records") {
      if (!state.meaning.trim() || !fits(state.meaning.trim(), 4096))
        invalidField("#processor-meaning", "请说明每条记录代表什么。");
      if (!fits(state.inclusion.trim(), 4096))
        invalidField("#processor-inclusion", "纳入条件过长，请缩短后重试。");
      if (!state.fields.length)
        invalidField("#processor-add-field", "至少添加一个字段。");
      const names = new Set<string>();
      state.fields.forEach((field, index) => {
        if (
          !/^[A-Za-z][A-Za-z0-9_]*$/u.test(field.name) ||
          names.has(field.name)
        )
          invalidField(
            `[data-field="name"][data-index="${index}"]`,
            "字段名以英文字母开头，可含数字和下划线；名称不能重复。",
          );
        if (!field.description.trim() || !fits(field.description.trim(), 2048))
          invalidField(
            `[data-field="description"][data-index="${index}"]`,
            "请填写简短的字段说明，过长时请缩短后重试。",
          );
        names.add(field.name);
        if (field.type === "number" && !fits(field.unit.trim(), 128))
          invalidField(
            `[data-field="unit"][data-index="${index}"]`,
            "单位说明过长，请缩短后重试。",
          );
      });
      spec.record_meaning = state.meaning.trim();
      if (state.inclusion.trim()) spec.inclusion = state.inclusion.trim();
      spec.fields = state.fields.map((field) => ({
        name: field.name,
        description: field.description.trim(),
        type: field.type,
        unit:
          field.type === "number" && field.unit.trim()
            ? field.unit.trim()
            : null,
      }));
    } else {
      if (!state.question.trim() || !fits(state.question.trim(), 4096))
        invalidField("#processor-question", "请填写希望逐篇回答的问题。");
      spec.question = state.question.trim();
      spec.answer_type = state.answerType;
      if (state.answerType === "enum") {
        const choices = state.choices
          .split(/\r?\n/u)
          .map((s) => s.trim())
          .filter(Boolean);
        if (
          choices.length < 1 ||
          choices.length > 64 ||
          choices.some((choice) => !fits(choice, 256)) ||
          new Set(choices).size !== choices.length
        )
          invalidField(
            "#processor-choices",
            "请填写 1–64 个简短且不重复的选项，每行一个；过长时请缩短选项。",
          );
        spec.choices = choices;
      }
    }
    if (
      state.reading === "search" &&
      (!state.readingQuery.trim() || !fits(state.readingQuery.trim(), 1024))
    )
      invalidField("#processor-reading-query", "请填写用于选择片段的关键词。");
    if (invalid) {
      (invalid as HTMLElement).focus();
      return;
    }
    spec.reading = {
      scope: state.reading,
      query: state.reading === "search" ? state.readingQuery.trim() : null,
    };
    const payload = {
      schema_version: 1,
      name:
        state.kind === "records"
          ? `记录提取 · ${state.meaning.trim().slice(0, 80)}`
          : `文献标签 · ${state.question.trim().slice(0, 80)}`,
      processor: { id: state.kind, version: "1" },
      spec,
      inputs: ids.map((id) => ({ kind: "literature", literature_id: id })),
    };
    const fingerprint = JSON.stringify(payload);
    try {
      if (state.submission?.fingerprint !== fingerprint)
        state.submission = {
          fingerprint,
          request: parseProcessorBatchRequest({
            ...payload,
            idempotency_key: crypto.randomUUID(),
          }),
          jobId: null,
          started: false,
          note: "",
        };
    } catch (error) {
      errorRoot.textContent = processorMessage(error);
      return;
    }
    const submitted = state.submission;
    submitting = true;
    node<HTMLButtonElement>("#processor-submit", ctx.root).disabled = true;
    submitted.note = "正在固定输入并保存任务…";
    feedback();
    void (async () => {
      if (!submitted.jobId) {
        const response = await ctx.api.submitProcessor(
          submitted.request,
          false,
          ctx.signal,
        );
        submitted.jobId = String(jobRecord(response.task).job_id);
        submitted.note = "任务已保存。";
        ctx.onTasksChanged();
      }
      if (ctx.signal.aborted) return;
      if (!submitted.started) {
        try {
          await ctx.api.request(
            `/api/tasks/${encodeURIComponent(submitted.jobId)}/start`,
            {},
            ctx.signal,
          );
          submitted.started = true;
          submitted.note = "任务已保存并请求启动，可在任务页核对实际进度。";
        } catch {
          submitted.note =
            "任务已保存，启动状态未确认。请查看任务后显式启动或继续。";
        }
      } else submitted.note = "该请求已经保存，复用原任务；请查看任务进度。";
      ctx.onTasksChanged();
    })()
      .catch((error) => {
        submitted.note = ctx.signal.aborted
          ? "回执未确认；再次提交同一草稿会使用原标识核对任务。"
          : processorMessage(error);
      })
      .finally(() => {
        submitting = false;
        if (!ctx.signal.aborted) {
          feedback();
          node<HTMLButtonElement>("#processor-submit", ctx.root).disabled =
            !ready;
        }
      });
  };
  await refreshScope();
}
