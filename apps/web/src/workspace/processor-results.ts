import {
  parseAssetId,
  parseLiteratureDetail,
  parseProcessorBatchRequest,
  parseProcessorCollection,
  parseProcessorCitation,
  processorJson,
  type ProcessorCitation,
  type ProcessorCollection,
  type ProcessorJson,
  type ProcessorRecord,
  type ProcessorResultRef,
  type ProcessorBatchRequest,
} from "@sciretriever/contracts";
import { record, listField, stringField, jobRecord } from "../wire.js";
import { node, escape as e, button, download, message } from "./dom.js";
import {
  readProcessorResult,
  resultReference,
  describeResult,
  resolveProcessorEvidence,
  processorExportFile,
  type ResultDescription,
} from "./processor-data.js";
import { renderProcessorEvidence } from "./processor-evidence.js";
import type { AppContext } from "./types.js";

type Filter = {
  field: string;
  operator: string;
  value: string | number | boolean | null;
};
type ResultRow = ProcessorRecord & { result_id: string };
interface SelectedRecord {
  ref: ProcessorResultRef;
  recordId: string;
  literatureIds: string[];
}
interface ResultViewState {
  offset: number;
  pageSize: number;
  field: string;
  operator: string;
  value: string;
  direction: string;
  applied: {
    filters: Filter[];
    sort: { field: string; direction: string } | null;
  };
  selected: Map<string, SelectedRecord>;
  descriptions: Map<string, ResultDescription>;
  question: string;
  policy: string;
  submission: null | {
    fingerprint: string;
    request: ProcessorBatchRequest;
    job: string | null;
    started: boolean;
    note: string;
  };
  evidence: ProcessorCitation | null;
  focusKey: string | null;
  scroll: number;
}
export interface ProcessorResultsState {
  query: string;
  searchScope: "collections" | "results";
  appliedQuery: string;
  appliedScope: "collections" | "results";
  listOffset: number;
  listCursors: string[];
  views: Map<string, ResultViewState>;
}
export function createProcessorResultsState(): ProcessorResultsState {
  return {
    query: "",
    searchScope: "collections",
    appliedQuery: "",
    appliedScope: "collections",
    listOffset: 0,
    listCursors: [""],
    views: new Map(),
  };
}
function createView(): ResultViewState {
  return {
    offset: 0,
    pageSize: 25,
    field: "",
    operator: "all",
    value: "",
    direction: "none",
    applied: { filters: [], sort: null },
    selected: new Map(),
    descriptions: new Map(),
    question: "",
    policy: "require-all",
    submission: null,
    evidence: null,
    focusKey: null,
    scroll: 0,
  };
}
function display(value: ProcessorJson): string {
  if (value === null) return "无法判断 / 未报告";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value !== "object") {
    const text = String(value);
    return text.length > 800 ? `${text.slice(0, 800)}…` : text;
  }
  if (!Array.isArray(value) && typeof value.raw === "string")
    return `${value.raw}${typeof value.unit === "string" ? ` ${value.unit}` : ""}`;
  return JSON.stringify(value);
}
function resultError(error: unknown): string {
  const code = message(error);
  if (code === "processor-index-stale")
    return "结果索引需要维护。已有结果仍保留；请通过 CLI/MCP 显式重建结果索引后重试。此页面不会自动重建。";
  if (code === "catalog-v10-required")
    return "此文献库需要显式升级后才能查询处理器结果；已有文献仍可阅读。";
  return `读取未完成：${code}。可重试，已有选择与草稿已保留。`;
}
const rowKey = (row: ResultRow) =>
  JSON.stringify([row.result_id, row.record_id]);
const pointerFor = (field: string) =>
  field.startsWith("/")
    ? field
    : `/${field.replace(/~/g, "~0").replace(/\//g, "~1")}`;
function parseRow(value: unknown): ResultRow {
  const row = record(value, "result row");
  const missing = record(row.missing, "missing fields");
  if (Object.values(missing).some((v) => typeof v !== "string"))
    throw new Error("缺失字段说明无效");
  return {
    result_id: String(parseAssetId(row.result_id)),
    record_id: stringField(row, "record_id"),
    payload: processorJson(row.payload, 8 * 1024 * 1024),
    missing: missing as Record<string, string>,
    evidence: listField(row, "evidence").map((value) => {
      const source = record(value, "field evidence");
      return {
        pointer: stringField(source, "pointer"),
        sources: listField(source, "sources").map(parseProcessorCitation),
      };
    }),
  };
}
function schemaFor(
  schema: Record<string, unknown>,
  field: string,
): Record<string, unknown> {
  const keys = field.startsWith("/")
    ? field
        .slice(1)
        .split("/")
        .map((k) => k.replace(/~1/g, "/").replace(/~0/g, "~"))
    : [field];
  let current = schema;
  for (const key of keys) {
    const variants = [
      current,
      ...(Array.isArray(current.anyOf) ? current.anyOf : []),
    ];
    let next: Record<string, unknown> | null = null;
    for (const variant of variants) {
      if (!variant || typeof variant !== "object" || Array.isArray(variant))
        continue;
      const properties = (variant as Record<string, unknown>).properties;
      if (
        !properties ||
        typeof properties !== "object" ||
        Array.isArray(properties)
      )
        continue;
      const value = (properties as Record<string, unknown>)[key];
      if (value && typeof value === "object" && !Array.isArray(value))
        next = value as Record<string, unknown>;
    }
    if (!next) return {};
    current = next;
  }
  return current;
}
function fieldType(schema: Record<string, unknown>): string {
  const values = [schema, ...(Array.isArray(schema.anyOf) ? schema.anyOf : [])];
  for (const raw of values) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const type = (raw as Record<string, unknown>).type;
    const types = Array.isArray(type) ? type : [type];
    for (const t of [
      "number",
      "integer",
      "boolean",
      "string",
      "object",
      "array",
    ])
      if (types.includes(t)) return t;
  }
  return "string";
}

/** G2 result workspace, with transient selection and fixed references shared with the reader. */
export async function renderProcessorSummary(
  ctx: AppContext,
  params: URLSearchParams,
): Promise<void> {
  ctx.root.innerHTML =
    '<div class="result-demo"><div class="result-content"><h1 class="ptitle">提取</h1><div class="vtabs" id="result-navigation"></div><div id="processor-result-summary"></div></div></div>';
  const nav = node("#result-navigation", ctx.root);
  const create = button("新建处理", () => ctx.navigate("ext"));
  create.className = "vt";
  const existing = button("已有结果", () =>
    ctx.navigate("ext", { results: "all" }),
  );
  existing.className = "vt on";
  existing.setAttribute("aria-current", "page");
  nav.setAttribute("aria-label", "提取分区");
  nav.append(create, existing);
  if (!params.has("collection") && !params.has("result")) {
    await renderList(ctx);
    return;
  }
  await renderDetail(ctx, params);
}

async function renderList(ctx: AppContext): Promise<void> {
  const state = ctx.processorResults,
    host = node("#processor-result-summary", ctx.root);
  host.innerHTML = `<p class="result-summary">按运行查看已保存的结果，或检索已有结果正文。打开结果不会启动加工。</p><form class="result-toolbar" id="result-search-form"><select id="result-search-scope" aria-label="结果检索范围"><option value="collections">集合名称与说明</option><option value="results">结果正文</option></select><input id="result-search-query" aria-label="检索已有结果" placeholder="查找集合或已有结果" maxlength="1024"><button class="btn" type="submit">检索</button></form><p id="result-search-hint" class="f2"></p><p id="result-status" role="status"></p><div id="result-collections"></div><div class="result-page" id="result-list-paging"></div>`;
  const input = node<HTMLInputElement>("#result-search-query", host),
    scope = node<HTMLSelectElement>("#result-search-scope", host);
  input.value = state.query;
  scope.value = state.searchScope;
  input.oninput = () => {
    state.query = input.value;
  };
  scope.onchange = () => {
    state.searchScope = scope.value as typeof state.searchScope;
  };
  let active = new AbortController();
  ctx.signal.addEventListener("abort", () => active.abort(), { once: true });
  const load = async () => {
    active.abort();
    active = new AbortController();
    const signal = AbortSignal.any([ctx.signal, active.signal]);
    const status = node("#result-status", host),
      list = node("#result-collections", host);
    status.textContent = "正在读取已有结果…";
    node("#result-search-hint", host).textContent = /\p{Script=Han}/u.test(
      state.appliedQuery,
    )
      ? "当前按关键词做词法匹配，不会自动跨语言匹配；检索英文正文可尝试原文关键词。"
      : "关键词匹配；不会自动翻译或重建索引。";
    try {
      const query = state.appliedQuery,
        isResults = state.appliedScope === "results";
      const response = await ctx.api.processors(
        query
          ? isResults
            ? "search"
            : "search-collections"
          : isResults
            ? "results"
            : "collections",
        query
          ? { query, limit: 20, offset: state.listOffset }
          : isResults
            ? {
                limit: 20,
                ...(state.listCursors[state.listOffset / 20]
                  ? { after: state.listCursors[state.listOffset / 20] }
                  : {}),
              }
            : { limit: 20, offset: state.listOffset },
        signal,
      );
      if (signal.aborted) return;
      const rows = isResults
        ? listField(record(response.result, "results"), "items")
        : response.result;
      if (!Array.isArray(rows)) throw new Error("结果列表回执无效");
      list.replaceChildren();
      for (const raw of rows) {
        const row = record(raw, "result entry"),
          item = document.createElement("section");
        item.className = "result-card";
        if (isResults) {
          const ref = resultReference(row);
          item.innerHTML = `<h2>${e(typeof row.processor_id === "string" ? row.processor_id : "正文命中")}</h2><p>${e(typeof row.excerpt === "string" ? row.excerpt : ref.result_id)}</p><p class="f2">${row.record_id ? `记录 ${e(row.record_id)}` : "完整结果"}</p>`;
          item.append(
            button("打开结果", () =>
              ctx.navigate("ext", {
                result: ref.result_id,
                resultHash: ref.content_sha256,
              }),
            ),
          );
        } else {
          const id = String(parseAssetId(row.collection_id));
          item.innerHTML = `<h2>${e(stringField(row, "name"))}</h2><p>${e(stringField(row, "processor_id"))}${typeof row.created_at === "string" ? ` · ${e(row.created_at)}` : ""}</p>`;
          item.append(
            button("打开集合", () => ctx.navigate("ext", { collection: id })),
          );
        }
        list.append(item);
      }
      status.textContent = rows.length
        ? `本页 ${rows.length} 项 · 第 ${state.listOffset / 20 + 1} 页`
        : "没有匹配的已保存结果。";
      const nextAfter =
        !query && isResults
          ? record(response.result, "results").next_after
          : null;
      if (typeof nextAfter === "string")
        state.listCursors[state.listOffset / 20 + 1] = nextAfter;
      const paging = node("#result-list-paging", host);
      paging.replaceChildren();
      const prev = button("上一页", async () => {
        state.listOffset = Math.max(0, state.listOffset - 20);
        await load();
      });
      prev.disabled = state.listOffset === 0;
      const next = button("下一页", async () => {
        state.listOffset += 20;
        await load();
      });
      next.disabled =
        !query && isResults ? nextAfter === null : rows.length < 20;
      paging.append(prev, next);
    } catch (error) {
      if (!signal.aborted) {
        list.replaceChildren();
        status.textContent = resultError(error);
      }
    }
  };
  node<HTMLFormElement>("#result-search-form", host).onsubmit = (event) => {
    event.preventDefault();
    state.appliedQuery = state.query.trim();
    state.appliedScope = state.searchScope;
    state.listOffset = 0;
    state.listCursors = [""];
    void load();
  };
  await load();
}

async function renderDetail(
  ctx: AppContext,
  params: URLSearchParams,
): Promise<void> {
  const host = node("#processor-result-summary", ctx.root);
  const collectionId = params.get("collection"),
    resultId = params.get("result");
  const key = collectionId
    ? `collection:${collectionId}`
    : `result:${resultId}:${params.get("resultHash") ?? ""}`;
  const state = ctx.processorResults.views.get(key) ?? createView();
  ctx.processorResults.views.set(key, state);
  const returnParameters = collectionId
    ? { collection: collectionId }
    : {
        result: resultId!,
        ...(params.get("resultHash")
          ? { resultHash: params.get("resultHash")! }
          : {}),
      };
  const refs = new Map<string, ProcessorResultRef>();
  let collection: ProcessorCollection | null = null;
  let standalone: Awaited<ReturnType<typeof readProcessorResult>> | null = null;
  host.textContent = "正在核验固定结果…";
  if (collectionId) {
    collection = parseProcessorCollection(
      (
        await ctx.api.processors(
          "collection",
          { collection_id: parseAssetId(collectionId) },
          ctx.signal,
        )
      ).result,
    );
    if (collection.collection_id !== collectionId)
      throw new Error("结果集合引用不匹配");
    for (const member of collection.members)
      if (member.result) refs.set(member.result.result_id, member.result);
  } else {
    const id = String(parseAssetId(resultId));
    let ref: ProcessorResultRef;
    if (params.get("resultHash"))
      ref = resultReference({
        result_id: id,
        content_sha256: params.get("resultHash"),
      });
    else
      ref = resultReference(
        record(
          (await ctx.api.processors("read", { result_id: id }, ctx.signal))
            .result,
          "processor result",
        ).ref,
      );
    try {
      standalone = await readProcessorResult(ctx.api, ref, ctx.signal);
    } catch (error) {
      if (message(error) === "processor-input-changed")
        throw new Error("固定处理结果无法验证");
      throw error;
    }
    refs.set(ref.result_id, ref);
    state.descriptions.set(ref.result_id, describeResult(standalone));
  }
  if (ctx.signal.aborted) return;
  const title =
    collection?.name ??
    (standalone!.result.invocation.processor.id === "labels"
      ? "文献标签"
      : standalone!.result.invocation.processor.id === "records"
        ? "记录提取"
        : "处理结果");
  const partial = standalone?.result.coverage.some(
    (c) => c.status !== "complete",
  );
  host.innerHTML = `<button class="btn q sm" id="result-back">全部结果</button><h2>${e(title)}</h2><p class="result-summary">${collection ? `${collection.members.length} 项输入 · ${collection.members.filter((m) => m.result).length} 项已有结果 · ${collection.members.filter((m) => !m.result).length} 项缺口` : `${describeResult(standalone!).literatureIds.length} 篇关联文献 · ${partial ? "部分覆盖" : "完整覆盖"}`}</p>${partial ? '<p class="result-notice">仅代表已处理的材料，未覆盖部分不能据此判断为没有信息。</p>' : ""}<details class="result-spec"><summary>查看本次规范与缺口</summary><pre>${e(JSON.stringify(collection?.spec ?? standalone!.result.invocation.spec, null, 2))}</pre><div id="result-members"></div></details><p id="result-status" role="status"></p><div class="result-toolbar" id="result-filters"><label>字段<select id="result-field" aria-label="筛选字段"></select></label><label>条件<select id="result-operator" aria-label="筛选操作"></select></label><span id="result-value-control"></span><label>排序<select id="result-sort" aria-label="结果排序"><option value="none">原顺序</option><option value="asc">升序</option><option value="desc">降序</option></select></label><button class="btn" id="result-apply">应用筛选</button></div><div class="selection-bar" id="result-selection" hidden><span id="result-selection-count"></span><button class="btn sm" id="result-synthesize">用所选记录综合</button><button class="btn sm" id="result-papers">选择来源文献</button><button class="btn q sm" id="result-clear">清空选择</button></div><div class="result-grid" id="result-grid"><section><div id="processor-record-preview"></div><div class="result-page" id="result-paging"></div></section><aside class="evidence-side" id="result-evidence" hidden></aside></div><section class="demo-panel" id="result-panel" hidden></section>`;
  node("#result-back", host).onclick = () =>
    ctx.navigate("ext", { results: "all" });
  const members = node("#result-members", host);
  if (collection)
    for (const member of collection.members) {
      const item = document.createElement("p");
      item.textContent = member.result
        ? "已保存结果 · "
        : `未形成结果：${member.gap ?? "尚未处理"}`;
      if (member.result) {
        const ref = member.result;
        item.append(
          button("打开结果摘要", () =>
            ctx.navigate("ext", {
              result: ref.result_id,
              resultHash: ref.content_sha256,
            }),
          ),
        );
      }
      members.append(item);
    }
  else
    members.textContent = JSON.stringify(
      {
        ...standalone!.ref,
        coverage: standalone!.result.coverage,
        provenance: standalone!.result.provenance,
      },
      null,
      2,
    );
  const scroll = node(".result-demo", ctx.root);
  scroll.onscroll = () => {
    if (!ctx.signal.aborted) state.scroll = scroll.scrollTop;
  };
  let queryAbort = new AbortController(),
    evidenceAbort = new AbortController();
  ctx.signal.addEventListener(
    "abort",
    () => {
      queryAbort.abort();
      evidenceAbort.abort();
    },
    { once: true },
  );
  let rows: ResultRow[] = [],
    fields: string[] = [],
    schema: Record<string, unknown> = {},
    nextOffset: number | null = null;
  let selectionBusy = false;
  const status = node("#result-status", host);
  const describe = async (id: string, signal: AbortSignal) => {
    let d = state.descriptions.get(id);
    if (!d) {
      const ref = refs.get(id);
      if (!ref) throw new Error("查询结果不属于固定集合");
      d = describeResult(await readProcessorResult(ctx.api, ref, signal));
      if (signal.aborted) signal.throwIfAborted();
      if (state.descriptions.size >= 100)
        state.descriptions.delete(state.descriptions.keys().next().value!);
      state.descriptions.set(id, d);
    }
    return d;
  };
  const showPanel = () => {
    const panel = node("#result-panel", host);
    panel.hidden = false;
    panel.scrollIntoView({ block: "nearest" });
    panel
      .querySelector<HTMLElement>("textarea,select,button")
      ?.focus({ preventScroll: true });
  };
  const exportPanel = (ref: ProcessorResultRef) => {
    const panel = node("#result-panel", host);
    panel.innerHTML = `<h3>导出这份完整结果</h3><p>固定结果 ${e(ref.result_id)}。导出整份已保存产物，不受当前筛选、页码或选中项影响。</p><p class="f2">CSV / Markdown 与 coverage、provenance 来源说明一起下载为 ZIP；JSON 保留完整不可变结果。</p><label>格式<select id="result-export-format"><option value="json">JSON</option><option value="csv">CSV + 来源说明（ZIP）</option><option value="markdown">Markdown + 来源说明（ZIP）</option></select></label><div class="acts" id="result-export-actions"></div><p id="result-export-status" role="status"></p>`;
    const actions = node("#result-export-actions", panel);
    actions.append(
      button(
        "下载完整结果",
        async () => {
          const format = node<HTMLSelectElement>("#result-export-format", panel)
            .value as "json" | "csv" | "markdown";
          const note = node("#result-export-status", panel);
          note.textContent = "正在读取并核验完整结果…";
          try {
            const file = await processorExportFile(
              ctx.api,
              ref,
              format,
              ctx.signal,
            );
            if (ctx.signal.aborted) return;
            download(file.blob, file.name);
            note.textContent = "完整结果已准备下载。";
          } catch (error) {
            if (!ctx.signal.aborted) note.textContent = resultError(error);
          }
        },
        true,
      ),
      button("关闭", () => {
        panel.hidden = true;
        node("#result-back", host).focus();
      }),
    );
    showPanel();
  };
  const showEvidence = async (
    citation: ProcessorCitation,
    focusKey: string | null = null,
  ) => {
    evidenceAbort.abort();
    evidenceAbort = new AbortController();
    const signal = AbortSignal.any([ctx.signal, evidenceAbort.signal]);
    state.evidence = citation;
    state.focusKey = focusKey;
    const side = node("#result-evidence", host);
    node("#result-grid", host).classList.add("evidence-open");
    const close = () => {
      evidenceAbort.abort();
      state.evidence = null;
      side.hidden = true;
      node("#result-grid", host).classList.remove("evidence-open");
      if (state.focusKey)
        host
          .querySelector<HTMLElement>(
            `[data-evidence-key="${CSS.escape(state.focusKey)}"]`,
          )
          ?.focus();
    };
    await renderProcessorEvidence(
      { ...ctx, signal },
      side,
      citation,
      returnParameters,
      close,
    );
    if (!signal.aborted && innerWidth < 1100)
      side.scrollIntoView({ block: "nearest" });
  };
  const paintSelection = () => {
    node("#result-selection", host).hidden = state.selected.size === 0;
    const sources = new Set(
      [...state.selected.values()].flatMap((s) => s.literatureIds),
    );
    node("#result-selection-count", host).textContent =
      `已选 ${state.selected.size} 条记录 · 来自 ${sources.size} 篇文献（跨页保留）`;
    for (const input of host.querySelectorAll<HTMLInputElement>(
      "[data-select-record]",
    )) {
      if (!selectionBusy)
        input.checked = state.selected.has(input.dataset.selectRecord!);
      input.disabled = selectionBusy;
    }
    const all = host.querySelector<HTMLInputElement>("#result-select-page");
    if (all) {
      const n = rows.filter((r) => state.selected.has(rowKey(r))).length;
      if (!selectionBusy) {
        all.checked = rows.length > 0 && n === rows.length;
        all.indeterminate = n > 0 && n < rows.length;
      }
      all.disabled = !rows.length || selectionBusy;
    }
  };
  const selectRows = async (chosen: ResultRow[], checked: boolean) => {
    selectionBusy = true;
    paintSelection();
    try {
      for (const row of chosen) {
        if (!checked) {
          state.selected.delete(rowKey(row));
          continue;
        }
        const ref = refs.get(row.result_id)!;
        const resolved = await resolveProcessorEvidence(
          ctx.api,
          { kind: "result", ...ref, record_id: row.record_id, pointer: "" },
          ctx.signal,
        );
        if (ctx.signal.aborted) return;
        state.selected.set(rowKey(row), {
          ref,
          recordId: row.record_id,
          literatureIds: resolved.literatureIds.length
            ? resolved.literatureIds
            : [...state.descriptions.get(row.result_id)!.literatureIds],
        });
      }
    } catch (error) {
      if (!ctx.signal.aborted) status.textContent = resultError(error);
    } finally {
      selectionBusy = false;
      if (!ctx.signal.aborted) paintSelection();
    }
  };
  node("#result-clear", host).onclick = () => {
    state.selected.clear();
    paintSelection();
  };
  node("#result-papers", host).onclick = () => {
    ctx.library.selected = new Set(
      [...state.selected.values()].flatMap((s) => s.literatureIds),
    );
    ctx.navigate("lib", { scope: "selection" });
  };
  const canSynthesize =
    !!ctx.api.workspace.capabilities.tasks &&
    !!ctx.api.workspace.capabilities.maintenance;
  node<HTMLButtonElement>("#result-synthesize", host).disabled = !canSynthesize;
  if (!canSynthesize)
    node("#result-synthesize", host).title = "当前工作台只读，无法提交综合任务";
  node("#result-synthesize", host).onclick = () => {
    if (!canSynthesize) return;
    const chosen = [...state.selected.values()];
    const panel = node("#result-panel", host);
    panel.innerHTML = `<h3>用所选记录继续综合</h3><p>${e(node("#result-selection-count", host).textContent)}。确认提交时固定这些记录，原结果保持不变。</p><label for="result-synthesis-question">研究问题</label><textarea id="result-synthesis-question" maxlength="4096"></textarea><label>输入策略<select id="result-synthesis-policy"><option value="require-all">全部输入有效才执行</option><option value="allow-partial">允许部分输入，保留缺口</option></select></label><div class="acts" id="result-synthesis-actions"></div><p id="result-synthesis-status" role="status"></p>`;
    const question = node<HTMLTextAreaElement>(
        "#result-synthesis-question",
        panel,
      ),
      policy = node<HTMLSelectElement>("#result-synthesis-policy", panel);
    question.value = state.question;
    policy.value = state.policy;
    question.oninput = () => {
      state.question = question.value;
    };
    policy.onchange = () => {
      state.policy = policy.value;
    };
    const note = node("#result-synthesis-status", panel);
    note.textContent = state.submission?.note ?? "只有确认提交才调用模型。";
    const actions = node("#result-synthesis-actions", panel);
    actions.append(
      button(
        "确认并创建综合任务",
        async () => {
          if (
            !state.question.trim() ||
            new TextEncoder().encode(state.question.trim()).length > 4096
          ) {
            note.textContent = "请填写简短的研究问题。";
            question.focus();
            return;
          }
          if (!chosen.length) {
            note.textContent = "请先选择记录。";
            return;
          }
          const groups = new Map<string, string[]>();
          for (const selected of chosen)
            groups.set(selected.ref.result_id, [
              ...(groups.get(selected.ref.result_id) ?? []),
              selected.recordId,
            ]);
          const payload = {
            schema_version: 1,
            name: `结果综合 · ${state.question.trim().slice(0, 80)}`,
            processor: { id: "knowledge-synthesis", version: "1" },
            spec: { question: state.question.trim(), policy: state.policy },
            inputs: [...groups]
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([id, ids]) => ({
                kind: "result",
                result_id: id,
                record_ids: ids.sort(),
              })),
          };
          const fingerprint = JSON.stringify(payload);
          if (state.submission?.fingerprint !== fingerprint)
            state.submission = {
              fingerprint,
              request: parseProcessorBatchRequest({
                ...payload,
                idempotency_key: crypto.randomUUID(),
              }),
              job: null,
              started: false,
              note: "",
            };
          const submission = state.submission;
          try {
            submission.note = "正在固定所选记录并保存任务…";
            note.textContent = submission.note;
            if (!submission.job)
              submission.job = String(
                jobRecord(
                  (
                    await ctx.api.submitProcessor(
                      submission.request,
                      false,
                      ctx.signal,
                    )
                  ).task,
                ).job_id,
              );
            if (!submission.started && !ctx.signal.aborted) {
              await ctx.api.request(
                `/api/tasks/${encodeURIComponent(submission.job)}/start`,
                {},
                ctx.signal,
              );
              submission.started = true;
            }
            submission.note = "任务已保存，可到任务页核对实际进度。";
            ctx.onTasksChanged();
          } catch (error) {
            submission.note = submission.job
              ? "任务已保存，启动状态未确认；请查看任务后显式继续。"
              : `${resultError(error)} 重试同一草稿将核对原提交标识。`;
          }
          if (!ctx.signal.aborted) {
            note.textContent = submission.note;
            actions.querySelector("[data-synthesis-task]")?.remove();
            if (submission.job) {
              const open = button("查看综合任务", () =>
                ctx.navigate("task", { task: submission.job! }),
              );
              open.dataset.synthesisTask = "true";
              actions.append(open);
            }
          }
        },
        true,
      ),
      button("关闭", () => {
        panel.hidden = true;
        node("#result-synthesize", host).focus();
      }),
    );
    showPanel();
  };
  const fieldControl = node<HTMLSelectElement>("#result-field", host),
    opControl = node<HTMLSelectElement>("#result-operator", host),
    sortControl = node<HTMLSelectElement>("#result-sort", host);
  const syncField = () => {
    const spec = schemaFor(schema, state.field),
      type = fieldType(spec);
    const scalar = type !== "object" && type !== "array";
    const operators = [
      ["all", "全部值"],
      ["null", "空值 / 无法判断"],
      ["not-null", "有值"],
      ...(scalar
        ? [
            ["eq", "等于"],
            ["ne", "不等于"],
          ]
        : []),
      ...(["number", "integer"].includes(type)
        ? [
            ["gt", "大于"],
            ["ge", "大于或等于"],
            ["lt", "小于"],
            ["le", "小于或等于"],
          ]
        : []),
    ];
    if (!operators.some(([key]) => key === state.operator))
      state.operator = "all";
    opControl.innerHTML = operators
      .map(([value, label]) => `<option value="${value}">${label}</option>`)
      .join("");
    opControl.value = state.operator;
    sortControl.value = state.direction;
    const target = node("#result-value-control", host);
    target.replaceChildren();
    target.hidden = ["all", "null", "not-null"].includes(state.operator);
    const choices =
      type === "boolean"
        ? [true, false]
        : Array.isArray(spec.enum)
          ? spec.enum.filter((v) => v !== null)
          : null;
    const input = document.createElement(choices ? "select" : "input");
    input.id = "result-filter-value";
    input.setAttribute("aria-label", "筛选值");
    if (input instanceof HTMLSelectElement)
      input.innerHTML = choices!
        .map(
          (v) =>
            `<option value="${e(String(v))}">${e(typeof v === "boolean" ? (v ? "是" : "否") : v)}</option>`,
        )
        .join("");
    else input.type = ["number", "integer"].includes(type) ? "number" : "text";
    if (choices && !choices.map(String).includes(state.value))
      state.value = String(choices[0]);
    input.value = state.value;
    input.oninput = () => {
      state.value = input.value;
    };
    target.append(input);
  };
  fieldControl.onchange = () => {
    state.field = fieldControl.value;
    state.operator = "all";
    state.direction = "none";
    state.value = "";
    syncField();
  };
  opControl.onchange = () => {
    state.operator = opControl.value;
    syncField();
  };
  sortControl.onchange = () => {
    state.direction = sortControl.value;
  };
  const sourceTitles = new Map<string, string>();
  const sourceTitle = async (id: string, signal: AbortSignal) => {
    const cached = sourceTitles.get(id);
    if (cached) return cached;
    try {
      const detail =
        ctx.details.get(id) ??
        (await parseLiteratureDetail(
          (await ctx.api.query("read", { literature_id: id }, signal)).detail,
        ));
      if (detail.literature.literature_id !== id)
        throw new Error("文献身份不匹配");
      const title = detail.literature.metadata.title || "未命名文献";
      if (!signal.aborted) {
        ctx.details.set(id, detail);
        sourceTitles.set(id, title);
      }
      return title;
    } catch (error) {
      if (signal.aborted) throw error;
      return `${id}（书目暂不可读）`;
    }
  };
  const paintRows = () => {
    const columns = [...new Set(rows.flatMap((r) => Object.keys(r.payload)))];
    const preview = node("#processor-record-preview", host);
    preview.innerHTML = `<div class="result-table-wrap"><table class="result-table"><thead><tr><th><input type="checkbox" id="result-select-page" aria-label="选择本页"></th><th>来源文献 / 记录</th>${columns.map((c) => `<th>${e(c)}</th>`).join("")}<th>覆盖</th></tr></thead><tbody>${
      rows
        .map((row, index) => {
          const d = state.descriptions.get(row.result_id)!;
          return `<tr><td><input type="checkbox" data-select-record="${e(rowKey(row))}" aria-label="选择记录 ${e(row.record_id)}"></td><td><span class="result-source-title">${e(d.literatureIds[0] ? (sourceTitles.get(d.literatureIds[0]) ?? d.literatureIds[0]) : "没有关联文献")}</span><span class="sub">${d.literatureIds.length} 篇来源文献 · ${e(row.record_id)}</span>${d.literatureIds.length > 1 ? `<details data-result-sources="${e(row.result_id)}"><summary>查看全部来源</summary><div></div></details>` : ""}<div class="row-tools"><button class="btn q sm" data-result-export="${e(row.result_id)}">完整结果</button></div></td>${columns.map((field) => `<td>${Object.hasOwn(row.payload, field) ? `<button class="value" data-result-evidence="${index}" data-result-field="${e(field)}" data-evidence-key="${e(JSON.stringify([row.result_id, row.record_id, field]))}">${e(display(row.payload[field]!))}</button>${row.missing[field] || row.missing[pointerFor(field)] ? `<span class="sub">${e(row.missing[field] ?? row.missing[pointerFor(field)])}</span>` : ""}` : '<span class="sub">无此字段</span>'}</td>`).join("")}<td><span class="tag ${d.coverage.some((c) => c.status !== "complete") ? "yellow" : "gray"}">${d.coverage.some((c) => c.status !== "complete") ? "部分覆盖" : "完整"}</span><details><summary>字段详情</summary><pre>${e(JSON.stringify({ payload: row.payload, missing: row.missing }, null, 2).slice(0, 8000))}</pre></details></td></tr>`;
        })
        .join("") ||
      `<tr><td colspan="${columns.length + 3}">当前范围没有匹配记录；空结果不代表全文没有相关信息。</td></tr>`
    }</tbody></table></div>`;
    for (const sources of preview.querySelectorAll<HTMLDetailsElement>(
      "[data-result-sources]",
    ))
      sources.ontoggle = () => {
        const list = sources.querySelector("div")!;
        if (!sources.open || list.childNodes.length) return;
        for (const id of state.descriptions.get(sources.dataset.resultSources!)!
          .literatureIds) {
          const link = button(sourceTitles.get(id) ?? id, () =>
            ctx.openPaper(id),
          );
          list.append(link);
          void sourceTitle(id, ctx.signal)
            .then((title) => {
              if (!ctx.signal.aborted && link.isConnected)
                link.textContent = title;
            })
            .catch((error) => {
              if (!ctx.signal.aborted) link.textContent = message(error);
            });
        }
      };
    for (const input of preview.querySelectorAll<HTMLInputElement>(
      "[data-select-record]",
    ))
      input.onchange = () => {
        void selectRows(
          [rows.find((row) => rowKey(row) === input.dataset.selectRecord)!],
          input.checked,
        );
      };
    node<HTMLInputElement>("#result-select-page", preview).onchange = (
      event,
    ) => {
      void selectRows([...rows], (event.target as HTMLInputElement).checked);
    };
    for (const el of preview.querySelectorAll<HTMLElement>(
      "[data-result-export]",
    ))
      el.onclick = () => exportPanel(refs.get(el.dataset.resultExport!)!);
    for (const el of preview.querySelectorAll<HTMLElement>(
      "[data-result-evidence]",
    ))
      el.onclick = () => {
        const row = rows[Number(el.dataset.resultEvidence)]!;
        void showEvidence(
          {
            kind: "result",
            ...refs.get(row.result_id)!,
            record_id: row.record_id,
            pointer: pointerFor(el.dataset.resultField!),
          },
          el.dataset.evidenceKey!,
        );
      };
    const paging = node("#result-paging", host);
    paging.replaceChildren();
    const info = document.createElement("span");
    info.textContent = `第 ${Math.floor(state.offset / state.pageSize) + 1} 页 · 本页 ${rows.length} 条 · ${refs.size} 份固定结果`;
    const size = document.createElement("select");
    size.setAttribute("aria-label", "每页记录数");
    size.innerHTML = [10, 25, 50]
      .map((n) => `<option value="${n}">${n} 条 / 页</option>`)
      .join("");
    size.value = String(state.pageSize);
    size.onchange = () => {
      state.pageSize = Number(size.value);
      state.offset = 0;
      void loadPage();
    };
    const prev = button("上一页", async () => {
      state.offset = Math.max(0, state.offset - state.pageSize);
      await loadPage();
    });
    prev.disabled = state.offset === 0;
    const next = button("下一页", async () => {
      if (nextOffset !== null) {
        state.offset = nextOffset;
        await loadPage();
      }
    });
    next.disabled = nextOffset === null;
    paging.append(info, size, prev, next);
    paintSelection();
  };
  const loadPage = async () => {
    queryAbort.abort();
    queryAbort = new AbortController();
    const signal = AbortSignal.any([ctx.signal, queryAbort.signal]);
    status.textContent = "正在读取记录…";
    try {
      const response = record(
        (
          await ctx.api.processors(
            "query",
            {
              collection_id: collectionId,
              result_ids: collectionId ? [] : [...refs.keys()],
              ...state.applied,
              limit: state.pageSize,
              offset: state.offset,
            },
            signal,
          )
        ).result,
        "records",
      );
      const page = listField(response, "items").map(parseRow);
      const descriptions = [...new Set(page.map((row) => row.result_id))];
      for (const id of descriptions) await describe(id, signal);
      if (!schema.properties && refs.size)
        schema = (await describe(refs.keys().next().value!, signal)).schema;
      const firstSources = [
        ...new Set(
          descriptions.flatMap(
            (id) => state.descriptions.get(id)?.literatureIds.slice(0, 1) ?? [],
          ),
        ),
      ];
      await Promise.all(
        firstSources.map(async (id) => {
          const title = await sourceTitle(id, signal);
          if (!signal.aborted) sourceTitles.set(id, title);
        }),
      );
      if (signal.aborted) return;
      rows = page;
      fields = listField(response, "fields").map((v) => {
        if (typeof v !== "string") throw new Error("字段回执无效");
        return v;
      });
      const next = response.next_offset;
      if (
        next !== null &&
        (typeof next !== "number" ||
          !Number.isSafeInteger(next) ||
          next !== state.offset + state.pageSize)
      )
        throw new Error("记录分页回执无效");
      nextOffset = next as number | null;
      if (!fields.includes(state.field)) state.field = fields[0] ?? "";
      fieldControl.innerHTML = fields
        .map((f) => `<option value="${e(f)}">${e(f)}</option>`)
        .join("");
      fieldControl.value = state.field;
      node<HTMLButtonElement>("#result-apply", host).disabled = !fields.length;
      syncField();
      paintRows();
      status.textContent = state.applied.filters.length
        ? "显示已应用筛选的结果；修改条件后点击“应用筛选”。"
        : "显示本次固定范围的已有记录。";
    } catch (error) {
      if (!signal.aborted) {
        status.textContent = resultError(error);
        node("#processor-record-preview", host).replaceChildren(
          button("重试读取", loadPage),
        );
      }
    }
  };
  node("#result-apply", host).onclick = () => {
    let value: string | number | boolean | null = state.value;
    const type = fieldType(schemaFor(schema, state.field));
    if (["null", "not-null"].includes(state.operator)) value = null;
    else if (state.operator !== "all" && ["number", "integer"].includes(type)) {
      if (!state.value.trim() || !Number.isFinite(Number(state.value))) {
        status.textContent = "请输入有效数值。";
        return;
      }
      value = Number(state.value);
    } else if (type === "boolean") value = state.value === "true";
    state.applied = {
      filters:
        state.operator === "all"
          ? []
          : [
              {
                field: state.field,
                operator:
                  state.operator === "null"
                    ? "eq"
                    : state.operator === "not-null"
                      ? "ne"
                      : state.operator,
                value,
              },
            ],
      sort:
        state.direction === "none"
          ? null
          : { field: state.field, direction: state.direction },
    };
    state.offset = 0;
    void loadPage();
  };
  // Complete stored content and exports remain readable even when the query index needs maintenance.
  host.insertAdjacentHTML(
    "beforeend",
    '<section id="result-content"></section>',
  );
  if (standalone?.result.content.kind === "text") {
    const text = standalone.result.content.text;
    const section = document.createElement("section");
    section.className = "result-text";
    const p = document.createElement("pre");
    p.textContent = text.slice(0, 32000);
    section.append(p);
    if (text.length > 32000)
      section.append(
        "正文较长，此处预览前 32000 字符；下载包含完整正文与来源。",
      );
    node("#result-content", host).prepend(section);
  }
  if (standalone?.result.content.kind === "knowledge") {
    const content = standalone.result.content;
    const open = button("打开原知识产物", () =>
      standalone!.result.invocation.processor.id === "knowledge-synthesis"
        ? ctx.navigate("syn", { artifact: content.artifact_id })
        : ctx.openPaper(standalone!.result.literature_ids[0]!, "know", {
            knowledge: content.artifact_id,
            from: "ext",
            ...returnParameters,
          }),
    );
    node("#result-content", host).prepend(open);
  }
  if (standalone) {
    const exportButton = button("导出这份完整结果", () =>
      exportPanel(standalone!.ref),
    );
    node("#result-content", host).append(exportButton);
  }
  await loadPage();
  scroll.scrollTop = state.scroll;
  if (state.evidence && !ctx.signal.aborted)
    await showEvidence(state.evidence, state.focusKey);
}
