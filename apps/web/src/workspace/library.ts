import {
  parseLibrarySearchRequest,
  parseLiteratureSearchItem,
  parseLiteratureDetail,
  parseReferenceDetail,
  parseKnowledgeListSelection,
  parseKnowledgeListResult,
  parseKnowledgeReadSelection,
  parseKnowledgeReadResult,
  type LiteratureSearchItem,
  type LiteratureDetail,
  type LibraryQuery,
  type LibrarySort,
} from "@sciretriever/contracts";
import { record } from "../wire.js";
import { queryRequest, queryDownload } from "../query.js";
import {
  mountDocumentReading,
  mountMaterialReading,
} from "../document-reading.js";
import {
  verifiedEvidenceEntry,
  renderKnowledgeArtifact,
} from "../knowledge.js";
import {
  all,
  node,
  escape as e,
  icon,
  click,
  toast,
  message,
  button,
  failure,
} from "./dom.js";
import type { AppContext, ReaderMode, SavedView } from "./types.js";
import {
  readFixedSource,
  sourceParameterKeys,
  renderFixedKnowledge,
} from "./source-navigation.js";

export const emptyQuery = (): LibraryQuery =>
  parseLibrarySearchRequest({
    query: {},
    sort: "publication-year-desc",
    limit: 50,
    cursor: null,
  }).query;
export function title(item: LiteratureSearchItem): string {
  // Bibliographic sources may retain inline formatting. Only strip known
  // formatting tags for this plain-text label; never insert source HTML.
  return (
    item.literature.metadata.title?.replace(
      /<\/?(?:i|b|em|strong|sub|sup)\s*>/giu,
      "",
    ) || "未命名文献"
  );
}
export function authors(item: LiteratureSearchItem): string {
  return (
    item.literature.metadata.authors
      .map(
        (a) =>
          a.display_name ||
          [a.given_name, a.family_name].filter(Boolean).join(" "),
      )
      .join(", ") || "作者未提供"
  );
}
export function status(item: LiteratureSearchItem): string {
  const [color, label] = item.needs_manual_pdf
    ? ["red", "无法获取"]
    : item.literature.status === "CONTENT_READY"
      ? ["green", "内容已就绪"]
      : item.literature.status === "ASSET_READY"
        ? ["yellow", "有 PDF"]
        : ["gray", "仅元数据"];
  return `<span class="tag ${color}" title="${item.needs_manual_pdf ? "当前自动获取已耗尽，可主动补充 PDF" : "依据已保存的文献事实"}"><span class="dt"></span>${label}</span>`;
}
export function citation(item: LiteratureSearchItem): string {
  const m = item.literature.metadata;
  return `${e(authors(item))} <i class="jn">${e(m.venue)}</i> <span class="yr">${e(m.publication_year)}</span>`;
}
export async function search(ctx: AppContext, cursor: string | null = null) {
  const request = parseLibrarySearchRequest({
    query: ctx.library.query,
    sort: ctx.library.sort,
    limit: 50,
    cursor,
  });
  const value = ctx.api.workspace.capabilities.query
    ? await ctx.api.query("search", request, ctx.signal)
    : await ctx.api.request("/api/library/search", request, ctx.signal);
  const page = record(value.page, "library page");
  if (
    !Array.isArray(page.items) ||
    typeof page.total_count !== "number" ||
    (page.next_cursor !== null && typeof page.next_cursor !== "string")
  )
    throw new Error("文献列表回执无效");
  return {
    items: page.items.map(parseLiteratureSearchItem),
    total: page.total_count,
    cursor: page.next_cursor,
  };
}
export async function detail(
  ctx: AppContext,
  id: string,
): Promise<LiteratureDetail> {
  const value = ctx.api.workspace.capabilities.query
    ? await ctx.api.query("read", { literature_id: id }, ctx.signal)
    : await ctx.api.request(
        "/api/library/detail",
        { literature_id: id },
        ctx.signal,
      );
  const item = await parseLiteratureDetail(value.detail);
  if (item.literature.literature_id !== id)
    throw new Error("文献响应与选择不一致");
  if (!ctx.signal.aborted) ctx.details.set(id, item);
  return item;
}
function preferenceKey(ctx: AppContext): string {
  return `sciretriever:library-views:v1:${ctx.api.workspace.catalog ?? "unbound"}`;
}
export function loadViews(ctx: AppContext): SavedView[] {
  try {
    const raw: unknown = JSON.parse(
      localStorage.getItem(preferenceKey(ctx)) ?? "[]",
    );
    if (!Array.isArray(raw)) return [];
    return raw.slice(0, 50).map((value) => {
      const v = record(value, "view");
      if (
        typeof v.id !== "string" ||
        typeof v.name !== "string" ||
        v.name.length > 100
      )
        throw new Error("invalid view");
      const q = parseLibrarySearchRequest({
        query: v.query,
        sort: v.sort,
        limit: 50,
        cursor: null,
      });
      return { id: v.id, name: v.name, query: q.query, sort: q.sort };
    });
  } catch {
    return [];
  }
}
function saveViews(ctx: AppContext): void {
  try {
    localStorage.setItem(preferenceKey(ctx), JSON.stringify(ctx.library.views));
  } catch {
    throw new Error("浏览器无法保存视图，请检查本地存储设置");
  }
}
export async function renderLibrary(ctx: AppContext): Promise<void> {
  const s = ctx.library;
  ctx.root.innerHTML = `<div class="libwrap"><div class="pg"><div class="pgin">
    <h1 class="ptitle">文献库</h1><p class="pdesc">所有文献的元数据、PDF、解析结果和知识都在这里。其他模块都从这里取材料。</p>
    <div class="vtabs"><button class="vt ${s.viewId ? "" : "on"}" data-view="">全部</button>${s.views.map((v) => `<button class="vt ${s.viewId === v.id ? "on" : ""}" data-view="${e(v.id)}">${e(v.name)}</button>`).join("")}
    <button class="vt f3" id="addView">+ 保存当前筛选</button>${s.viewId ? '<button class="vt f3" id="removeView">删除视图</button>' : ""}<div class="vtools">
    <select class="tsel" id="stF" aria-label="状态"><option value="">状态</option><option value="UNREVIEWED">仅元数据</option><option value="ASSET_READY">有 PDF</option><option value="CONTENT_READY">内容已就绪</option><option value="failed">无法获取</option></select>
    <span class="tsearch">${icon("srch", true)}<input id="q" aria-label="筛选" placeholder="按标题、作者、期刊筛选" value="${e(s.query.text)}"></span>
    <button class="btn q sm" id="filters">${icon("set", true)}筛选</button><button class="btn q sm" id="capView">${icon("spark", true)}用这些文献做…</button><button class="btn blue sm" id="toDisc">${icon("plus", true)}入库</button></div></div>
    <div id="filterFields" hidden><form class="filter-grid"><label>年份起<input name="from" type="number" min="1" max="9999" value="${e(s.query.publication_year_from)}"></label><label>年份止<input name="to" type="number" min="1" max="9999" value="${e(s.query.publication_year_to)}"></label><label>作者<input name="author" value="${e(s.query.author)}"></label><label>期刊<input name="venue" value="${e(s.query.venue)}"></label><label>关键词<input name="keyword" value="${e(s.query.keywords[0])}"></label><label>DOI<input name="doi" value="${e(s.query.identifiers.find((i) => i.namespace === "doi")?.value)}"></label><button class="btn sm" type="submit">应用筛选</button><button class="btn q sm" type="button" id="clearFilters">清除筛选</button></form></div>
    <div class="lhead"><input type="checkbox" id="ckAll" disabled aria-label="选择当前页"><span id="library-status" role="status">正在读取文献…</span><span class="sort">排序 <select class="tsel" id="sort" aria-label="排序">${[
      ["publication-year-desc", "年份（新→旧）"],
      ["publication-year-asc", "年份（旧→新）"],
      ["title-asc", "标题（A→Z）"],
      ["title-desc", "标题（Z→A）"],
      ["relevance", "相关性"],
    ]
      .map(
        ([v, l]) =>
          `<option value="${v}" ${s.sort === v ? "selected" : ""}>${l}</option>`,
      )
      .join("")}</select></span></div>
    <div class="plist" id="library-results"></div><div class="cnt"><button class="btn q sm" id="library-more" hidden>加载更多</button></div></div></div><div id="peekHost"></div><div id="selectionHost"></div></div>`;
  const root = node("#library-results", ctx.root),
    count = node("#library-status", ctx.root),
    more = node<HTMLButtonElement>("#library-more", ctx.root);
  let generation = 0;
  const syncSelection = () => {
    root.classList.toggle("selecting", s.selected.size > 0);
    for (const box of all<HTMLInputElement>("[data-ck]", root)) {
      const selected = s.selected.has(box.dataset.ck!);
      box.checked = selected;
      box.parentElement?.classList.toggle("on", selected);
      box.closest(".prow")?.classList.toggle("on", selected);
    }
    const selected = s.items.filter((p) =>
      s.selected.has(p.literature.literature_id),
    ).length;
    const allBox = node<HTMLInputElement>("#ckAll", ctx.root);
    allBox.checked = s.items.length > 0 && selected === s.items.length;
    allBox.indeterminate = selected > 0 && selected < s.items.length;
    renderSelection(ctx);
  };
  const renderRows = () => {
    node<HTMLInputElement>("#ckAll", ctx.root).disabled = false;
    root.classList.toggle("selecting", s.selected.size > 0);
    root.innerHTML =
      s.items
        .map((p) => {
          const id = p.literature.literature_id;
          return `<div class="prow ${s.selected.has(id) ? "on" : ""}" data-id="${e(id)}" tabindex="0" role="button" aria-label="打开 ${e(title(p))}"><span class="ck ${s.selected.has(id) ? "on" : ""}"><input type="checkbox" data-ck="${e(id)}" ${s.selected.has(id) ? "checked" : ""} aria-label="选择 ${e(title(p))}"></span><div style="min-width:0"><div class="pt">${e(title(p))}</div><div class="pm">${citation(p)} ${p.literature.metadata.keywords
            .slice(0, 2)
            .map((t) => `<span class="mtag">${e(t)}</span>`)
            .join(
              "",
            )}</div></div><span class="st">${status(p)}</span><button class="pv" data-peek="${e(id)}" title="在右侧预览" aria-label="在右侧预览">${icon("open", true)}</button></div>`;
        })
        .join("") ||
      '<div class="empty"><b>没有符合条件的文献</b><p>调整筛选，或从“入库”添加文献。</p></div>';
    count.textContent = `${s.total ?? "—"} 篇 · 已显示 ${s.items.length} 篇`;
    more.hidden = !s.cursor;
    for (const row of all(".prow", root)) {
      row.onclick = (event) => {
        if ((event.target as HTMLElement).closest("[data-ck],[data-peek]"))
          return;
        ctx.openPaper(row.dataset.id!);
      };
      row.onkeydown = (event) => {
        if (
          event.target === row &&
          (event.key === "Enter" || event.key === " ")
        ) {
          event.preventDefault();
          ctx.openPaper(row.dataset.id!);
        }
      };
      row.ondragover = (event) => {
        event.preventDefault();
        row.classList.add("drop");
      };
      row.ondragleave = () => row.classList.remove("drop");
      row.ondrop = (event) => {
        event.preventDefault();
        row.classList.remove("drop");
        const file = event.dataTransfer?.files[0];
        if (file)
          void ctx
            .upload(row.dataset.id!, file)
            .then(() => reload(false))
            .catch((error) => toast(message(error)));
      };
    }
    for (const box of all<HTMLInputElement>("[data-ck]", root))
      box.onchange = () => {
        if (box.checked) s.selected.add(box.dataset.ck!);
        else s.selected.delete(box.dataset.ck!);
        syncSelection();
      };
    click("[data-peek]", (el) => openPeek(ctx, el.dataset.peek!), root);
    syncSelection();
  };
  const rememberQuery = () => {
    const url = new URL(location.href);
    url.searchParams.set("query", JSON.stringify(s.query));
    url.searchParams.set("sort", s.sort);
    history.replaceState(
      { ...history.state, selected: [...s.selected] },
      "",
      url,
    );
  };
  const reload = async (append: boolean) => {
    if (ctx.signal.aborted) return;
    rememberQuery();
    const revision = ++generation;
    more.disabled = true;
    count.textContent = "正在读取文献…";
    try {
      const page = await search(ctx, append ? s.cursor : null);
      if (ctx.signal.aborted || generation !== revision) return;
      s.items = append ? [...s.items, ...page.items] : page.items;
      s.total = page.total;
      s.cursor = page.cursor;
      renderRows();
      ctx.updateNavigation();
    } catch (error) {
      if (!ctx.signal.aborted && generation === revision) {
        count.textContent = "文献库暂不可用";
        failure(root, error, () => reload(false));
      }
    } finally {
      if (generation === revision) more.disabled = false;
    }
  };
  let debounce: ReturnType<typeof setTimeout> | undefined;
  ctx.signal.addEventListener("abort", () => clearTimeout(debounce), {
    once: true,
  });
  node<HTMLInputElement>("#q", ctx.root).oninput = (event) => {
    s.query = {
      ...s.query,
      text: (event.target as HTMLInputElement).value.trim() || null,
    };
    rememberQuery();
    clearTimeout(debounce);
    debounce = setTimeout(() => void reload(false), 250);
  };
  const st = node<HTMLSelectElement>("#stF", ctx.root);
  st.value = s.query.needs_manual_pdf ? "failed" : (s.query.statuses[0] ?? "");
  st.onchange = () => {
    s.query = parseLibrarySearchRequest({
      query: {
        ...s.query,
        statuses: st.value && st.value !== "failed" ? [st.value] : [],
        needs_manual_pdf: st.value === "failed" ? true : null,
      },
    }).query;
    void reload(false);
  };
  node<HTMLSelectElement>("#sort", ctx.root).onchange = (event) => {
    s.sort = (event.target as HTMLSelectElement).value as LibrarySort;
    void reload(false);
  };
  node<HTMLInputElement>("#ckAll", ctx.root).onchange = (event) => {
    for (const p of s.items) {
      if ((event.target as HTMLInputElement).checked)
        s.selected.add(p.literature.literature_id);
      else s.selected.delete(p.literature.literature_id);
    }
    syncSelection();
  };
  more.onclick = () => void reload(true);
  click("#toDisc", () => ctx.navigate("disc"), ctx.root);
  click(
    "#capView",
    async () => capabilityMenu(ctx, await ctx.scopeIds()),
    ctx.root,
  );
  click(
    "#filters",
    () => {
      const el = node("#filterFields", ctx.root);
      el.hidden = !el.hidden;
    },
    ctx.root,
  );
  node<HTMLFormElement>("#filterFields form", ctx.root).onsubmit = (event) => {
    event.preventDefault();
    const f = new FormData(event.currentTarget as HTMLFormElement);
    try {
      s.query = parseLibrarySearchRequest({
        query: {
          ...s.query,
          publication_year_from: f.get("from") ? Number(f.get("from")) : null,
          publication_year_to: f.get("to") ? Number(f.get("to")) : null,
          author: f.get("author") || null,
          venue: f.get("venue") || null,
          keywords: f.get("keyword") ? [f.get("keyword")] : [],
          identifiers: f.get("doi")
            ? [{ namespace: "doi", value: f.get("doi") }]
            : [],
        },
      }).query;
      void reload(false);
    } catch (error) {
      toast(message(error));
    }
  };
  click(
    "#clearFilters",
    () => {
      s.query = emptyQuery();
      s.viewId = "";
      ctx.refresh();
    },
    ctx.root,
  );
  click(
    "[data-view]",
    (el) => {
      const v = s.views.find((v) => v.id === el.dataset.view);
      s.viewId = v?.id ?? "";
      s.query = v?.query ?? emptyQuery();
      s.sort = v?.sort ?? "publication-year-desc";
      ctx.refresh();
    },
    ctx.root,
  );
  click(
    "#addView",
    () => {
      const name = window.prompt("保存视图名称");
      if (!name?.trim()) return;
      const v = {
        id: crypto.randomUUID(),
        name: name.trim().slice(0, 100),
        query: structuredClone(s.query),
        sort: s.sort,
      };
      s.views = [...s.views, v].slice(-50);
      saveViews(ctx);
      s.viewId = v.id;
      ctx.refresh();
    },
    ctx.root,
  );
  click(
    "#removeView",
    () => {
      s.views = s.views.filter((v) => v.id !== s.viewId);
      saveViews(ctx);
      s.viewId = "";
      ctx.refresh();
    },
    ctx.root,
  );
  await reload(false);
  if (s.peek && !ctx.signal.aborted) await openPeek(ctx, s.peek);
}
function renderSelection(ctx: AppContext): void {
  const host = node("#selectionHost", ctx.root);
  const count = ctx.library.selected.size;
  host.innerHTML = count
    ? `<div class="selbar"><b>已选 ${count} 篇</b><button class="btn q sm" data-op="acquire">获取 PDF</button><button class="btn q sm" data-op="parse">解析</button><button class="btn q sm" data-op="analyze">分析</button><span class="sep"></span><button class="btn q sm" id="capSel">${icon("spark", true)}用这些文献做… ▾</button><span class="sep"></span><button class="btn q sm" id="clr" aria-label="取消选择">✕</button></div>`
    : "";
  click(
    "[data-op]",
    (el) => ctx.operate(el.dataset.op!, [...ctx.library.selected]),
    host,
  );
  click("#capSel", () => capabilityMenu(ctx, [...ctx.library.selected]), host);
  click(
    "#clr",
    () => {
      ctx.library.selected.clear();
      ctx.refresh();
    },
    host,
  );
}
export function capabilityMenu(ctx: AppContext, ids: readonly string[]): void {
  if (!ids.length) {
    toast("请先选择文献或调整范围");
    return;
  }
  const overlay = node("#overlay");
  overlay.innerHTML = `<div class="scrim" data-close></div><section class="modal" role="dialog" aria-label="用这些文献做"><div class="dh"><h3>用这 ${ids.length} 篇文献做…</h3><button class="btn q sm" data-close aria-label="关闭">✕</button></div><div class="db cap-actions">${[
    ["syn", "综合"],
    ["ask", "检索上下文"],
    ["ext", "提取"],
    ["ins", "在洞察中查看"],
    ["export", "导出书目"],
  ]
    .map(
      ([k, l]) =>
        `<button class="btn" data-cap="${k}">${icon(k ?? "lib")} ${l}</button>`,
    )
    .join("")}</div></section>`;
  click("[data-close]", () => overlay.replaceChildren(), overlay);
  click(
    "[data-cap]",
    async (el) => {
      overlay.replaceChildren();
      const key = el.dataset.cap!;
      if (key === "export") await ctx.operate("export", ids);
      else {
        ctx.library.selected = new Set(ids);
        ctx.navigate(key as "syn" | "ask" | "ext" | "ins", {
          scope: "selection",
        });
      }
    },
    overlay,
  );
}
export function properties(d: LiteratureDetail): string {
  const m = d.literature.metadata;
  const values = [
    ["作者", authors(d)],
    ["年份", m.publication_year ?? "未提供"],
    ["期刊", m.venue ?? "未提供"],
    [
      "DOI",
      m.identifiers.find((i) => i.namespace === "doi")?.value ?? "未提供",
    ],
    [
      "元数据",
      d.metadata_observations
        .map((o) => o.provenance.source_name)
        .filter((x, i, a) => a.indexOf(x) === i)
        .join(", "),
    ],
    [
      "PDF",
      d.primary_pdf
        ? `${(d.primary_pdf.asset.size_bytes / 1048576).toFixed(1)} MB`
        : "暂无",
    ],
    [
      "文章身份",
      d.primary_pdf
        ? {
            unverified: "文章身份未验证",
            "match-supported": "文章身份有证据支持",
            conflict: "文章身份存在冲突",
            "insufficient-evidence": "文章身份证据不足",
          }[d.primary_pdf.article_identity_status ?? "unverified"]
        : "暂无 PDF",
    ],
    ["解析", d.parser_result ? "已保存解析结果" : "按材料版本读取"],
    [
      "引用关系",
      `引用 ${d.reference_count} 篇 · 库内被引 ${d.cited_by_count} 篇`,
    ],
  ];
  return `<div class="props">${values.map(([k, v]) => `<div class="k">${e(k)}</div><div class="v">${e(v)}</div>`).join("")}<div class="k">状态</div><div class="v">${status(d)}</div></div>`;
}
async function openPeek(ctx: AppContext, id: string): Promise<void> {
  ctx.library.peek = id;
  const host = node("#peekHost", ctx.root);
  node(".libwrap", ctx.root).classList.add("peek");
  host.className = "peekp";
  host.innerHTML =
    '<div class="peekbar"><button class="btn q sm" id="peekClose">关闭预览</button></div><div class="peekin">正在读取…</div>';
  click(
    "#peekClose",
    () => {
      ctx.library.peek = null;
      host.replaceChildren();
      host.className = "";
      node(".libwrap", ctx.root).classList.remove("peek");
    },
    host,
  );
  try {
    const d = await detail(ctx, id);
    if (ctx.signal.aborted || ctx.library.peek !== id) return;
    node(".peekin", host).innerHTML =
      `<h2>${e(title(d))}</h2>${properties(d)}<div class="hr"></div><div class="summ">${e(d.literature.metadata.abstract || "未提供摘要")}</div><div class="acts" id="peekActions"></div>`;
    const actions = node("#peekActions", host);
    actions.append(button("打开阅读", () => ctx.openPaper(id), true));
    if (!d.primary_pdf)
      actions.append(button("上传 PDF", () => pickPdf(ctx, id)));
  } catch (error) {
    if (!ctx.signal.aborted) failure(node(".peekin", host), error);
  }
}
export function pickPdf(ctx: AppContext, id: string): void {
  const input = node<HTMLInputElement>("#pdfInput");
  input.value = "";
  input.onchange = () => {
    const file = input.files?.[0];
    if (file)
      void ctx
        .upload(id, file)
        .then(() => ctx.refresh())
        .catch((error) => toast(message(error)));
  };
  input.click();
}
export async function renderReader(
  ctx: AppContext,
  id: string,
  mode: ReaderMode,
): Promise<void> {
  ctx.root.innerHTML =
    '<div class="reader"><section class="viewer"><div class="vbar" id="reader-status">正在读取文献…</div><div class="vscroll" id="reader-body"></div></section><aside class="rside"><div class="rsin" id="reader-info"></div></aside></div>';
  const d = await detail(ctx, id);
  if (ctx.signal.aborted) return;
  const parameters = new URL(location.href).searchParams;
  const source = readFixedSource(parameters);
  if (
    source?.kind === "metadata" &&
    (source.literature_id !== id ||
      source.metadata_revision !== d.metadata_revision ||
      source.metadata_sha256 !== d.metadata_sha256)
  )
    throw new Error(
      "元数据已变化，无法将当前内容当作原检索命中。请返回重新检索。",
    );
  const info = node("#reader-info", ctx.root),
    body = node("#reader-body", ctx.root),
    label = node("#reader-status", ctx.root);
  info.innerHTML = `<div class="seg" role="tablist">${[
    ["pdf", "PDF"],
    ["doc", "全文"],
    ["know", "总结"],
  ]
    .map(
      ([m, l]) =>
        `<button role="tab" aria-selected="${m === mode}" class="${m === mode ? "on" : ""}" data-rm="${m}">${l}</button>`,
    )
    .join(
      "",
    )}</div><h2>${e(title(d))}</h2><div class="f2 bibliography">${citation(d)}</div>${properties(d)}<div class="acts" id="reader-actions"></div><div class="more-info"><div class="hr"></div><details class="tg"><summary>摘要与溯源</summary><p>${e(d.literature.metadata.abstract || "未提供摘要")}</p><pre>${e(JSON.stringify(d.metadata_observations, null, 2))}</pre></details><div id="reader-relations"></div></div>`;
  click(
    "[data-rm]",
    (el) =>
      ctx.openPaper(
        id,
        el.dataset.rm as ReaderMode,
        Object.fromEntries(
          sourceParameterKeys.flatMap((key) =>
            parameters.has(key) ? [[key, parameters.get(key)!]] : [],
          ),
        ),
      ),
    info,
  );
  const actions = node("#reader-actions", info);
  if (parameters.get("from") === "ask")
    actions.append(button("返回检索", () => ctx.navigate("ask")));
  if (parameters.get("from") === "ext")
    actions.append(
      button("返回结果", () =>
        ctx.navigate(
          "ext",
          parameters.has("collection")
            ? { collection: parameters.get("collection")! }
            : parameters.has("result")
              ? {
                  result: parameters.get("result")!,
                  ...(parameters.has("resultHash")
                    ? { resultHash: parameters.get("resultHash")! }
                    : {}),
                }
              : { results: "all" },
        ),
      ),
    );
  actions.append(button("导出书目", () => ctx.operate("export", [id])));
  if (!d.primary_pdf) {
    actions.append(
      button("上传 PDF", () => pickPdf(ctx, id)),
      button("获取 PDF", () => ctx.operate("acquire", [id])),
    );
  } else
    actions.append(
      button("解析", () => ctx.operate("parse", [id])),
      button("分析", () => ctx.operate("analyze", [id])),
      button("核验身份", () => ctx.operate("identity", [id])),
    );
  for (const section of ["syn", "ext"] as const)
    actions.append(
      button(section === "syn" ? "加入集合综合" : "加入提取输入", () => {
        ctx.library.selected = new Set([id]);
        ctx.navigate(section, { scope: "selection" });
      }),
    );
  if (d.content)
    actions.append(
      button("下载 Markdown", () => queryDownload(id, "content-markdown")),
    );
  const assessment = d.primary_pdf?.article_identity_assessment;
  if (assessment) {
    const panel = document.createElement("details");
    panel.innerHTML = `<summary>已保存的身份判断与证据</summary><p>${e(assessment.reason)}</p>`;
    for (const item of assessment.evidence) {
      const list = document.createElement("ul");
      list.append(
        verifiedEvidenceEntry(
          item.evidence,
          {
            literature_id: assessment.literature_id,
            asset_id: assessment.asset_id,
            asset_sha256: assessment.asset_sha256,
          },
          ctx.signal,
        ),
      );
      panel.append(list);
    }
    info.append(panel);
  }
  const relations = node("#reader-relations", info);
  let relationRevision = 0;
  const readRelation = (name: string, request: unknown) =>
    ctx.api.workspace.capabilities.query
      ? ctx.api.query(name, request, ctx.signal)
      : ctx.api.request(`/api/library/${name}`, request, ctx.signal);
  for (const direction of ["references", "cited-by"] as const)
    relations.append(
      button(
        direction === "references" ? "查看参考文献" : "查看库内被引",
        async () => {
          const revision = ++relationRevision;
          relations.querySelector(".relations")?.remove();
          const panel = document.createElement("div");
          panel.className = "relations";
          relations.append(panel);
          const load = async (cursor: string | null = null) => {
            const response = await readRelation("references", {
              literature_id: id,
              direction,
              limit: 25,
              cursor,
            });
            if (ctx.signal.aborted || revision !== relationRevision) return;
            const page = record(response.page, "references");
            if (!Array.isArray(page.items)) throw new Error("引用关系回执无效");
            panel.querySelector("[data-more-relations]")?.remove();
            for (const raw of page.items) {
              const ref = record(raw, "reference"),
                reference = record(ref.reference, "reference id");
              const related = parseLiteratureSearchItem(ref.related_literature);
              const row = document.createElement("div");
              row.append(
                button(
                  `${title(related)} · 支持证据 ${String(ref.support_count)}`,
                  async () => {
                    const response = await readRelation("reference", {
                      reference_id: reference.reference_id,
                    });
                    const evidence = parseReferenceDetail(response.detail);
                    if (
                      evidence.reference.reference_id !== reference.reference_id
                    )
                      throw new Error("引用证据与所选关系不匹配");
                    if (ctx.signal.aborted || revision !== relationRevision)
                      return;
                    row.querySelector(".library-evidence")?.remove();
                    const support = document.createElement("div");
                    support.className = "library-evidence";
                    support.innerHTML = `<b>来源证据</b>${evidence.supports.map((value) => `<p>${e(JSON.stringify(value.source))}</p>`).join("")}`;
                    row.append(support);
                  },
                ),
                button("打开文献", () =>
                  ctx.openPaper(related.literature.literature_id),
                ),
              );
              panel.append(row);
            }
            if (!panel.childNodes.length)
              panel.textContent = "没有已保存的关系";
            if (typeof page.next_cursor === "string") {
              const cursor = page.next_cursor;
              const more = button("加载更多引用", () => load(cursor));
              more.dataset.moreRelations = direction;
              panel.append(more);
            }
          };
          await load();
        },
      ),
    );
  if (d.other_versions.length) {
    const versions = document.createElement("details");
    versions.innerHTML = `<summary>其他版本（${d.other_versions.length}）</summary>`;
    for (const version of d.other_versions)
      versions.append(
        button(title(version), () =>
          ctx.openPaper(version.literature.literature_id),
        ),
      );
    info.append(versions);
  }
  if (ctx.api.workspace.capabilities.query && source?.kind !== "metadata") {
    const moduleUrl = "/reader.js";
    const reader = (await import(
      moduleUrl
    )) as typeof import("../reading/entry.js");
    if (!ctx.signal.aborted) await reader.mountReader(ctx, d, mode, source);
    return;
  }
  if (mode === "pdf") {
    if (
      source?.kind === "document" &&
      (source.literature_id !== id ||
        source.asset_id !== d.primary_pdf?.asset.asset_id ||
        source.asset_sha256 !== d.primary_pdf.asset.sha256)
    )
      throw new Error(
        "固定来源的 PDF 与当前主 PDF 不匹配；无法用当前材料替代原检索来源。请返回原文核对。",
      );
    label.textContent = d.primary_pdf
      ? "原始 PDF · 按固定资产校验读取"
      : "暂无 PDF";
    if (d.primary_pdf) {
      const launch = mountMaterialReading(
        body,
        d,
        !ctx.api.workspace.capabilities.query,
      );
      if (launch) {
        body.append(launch);
        launch.click();
        launch.hidden = true;
      }
    } else {
      body.innerHTML =
        '<div class="empty"><b>还没有 PDF</b><p>可以主动上传文件，或发起一次获取。</p><div class="drop" id="dropZone">把 PDF 拖到这里</div></div>';
      const zone = node("#dropZone", body);
      zone.append(button("选择文件", () => pickPdf(ctx, id), true));
      zone.ondragover = (event) => event.preventDefault();
      zone.ondrop = (event) => {
        event.preventDefault();
        const file = event.dataTransfer?.files[0];
        if (file)
          void ctx
            .upload(id, file)
            .then(() => ctx.refresh())
            .catch((error) => toast(message(error)));
      };
    }
  } else if (mode === "doc") {
    if (source?.kind === "metadata") {
      label.textContent = "元数据 · 已核对检索命中的版本";
      body.innerHTML = `<div class="doc"><h2>${e(title(d))}</h2><p>${citation(d)}</p><p>${e(d.literature.metadata.abstract ?? "未提供摘要")}</p></div>`;
      return;
    }
    label.textContent = "解析文档 · 固定版本读取";
    const launch = mountDocumentReading(
      body,
      d,
      (path, request) => queryRequest(path, request, ctx.signal),
      (text) => {
        label.textContent = text;
      },
      new URL(location.href).searchParams.get("document") ?? undefined,
      source?.kind === "document" ? source : undefined,
    );
    if (launch) {
      body.append(launch);
      launch.click();
      launch.hidden = true;
    } else
      body.innerHTML =
        '<div class="empty">需要先取得 PDF，才能读取解析文档。</div>';
  } else {
    label.textContent = "总结 · 读取已发布的知识";
    if (source?.kind === "knowledge") {
      await renderFixedKnowledge(ctx, source, body, id);
      return;
    }
    const fixed = new URL(location.href).searchParams.get("knowledge");
    if (fixed) {
      const selection = parseKnowledgeReadSelection({ artifact_id: fixed });
      const result = await parseKnowledgeReadResult(
        (await ctx.api.query("knowledge-read", selection, ctx.signal)).result,
        selection,
      );
      if (!result.input.items.some((item) => item.literature_id === id))
        throw new Error("知识产物不属于当前文献");
      if (ctx.signal.aborted) return;
      renderKnowledgeArtifact(result, body, ctx.signal);
      return;
    }
    const selection = parseKnowledgeListSelection({
      literature_id: id,
      limit: 20,
    });
    const list = await parseKnowledgeListResult(
      (await ctx.api.query("knowledge-list", selection, ctx.signal)).result,
      selection,
    );
    if (ctx.signal.aborted) return;
    if (!list.length && d.content) {
      label.textContent = "已保存的文献内容";
      for (const section of d.content.sections) {
        const element = document.createElement("section");
        element.innerHTML = `<h3>${e(section.title ?? section.role)}</h3><pre>${e(JSON.stringify(section, null, 2))}</pre>`;
        body.append(element);
      }
      return;
    }
    if (!list.length) {
      label.textContent = "尚无已发布知识";
      body.innerHTML =
        '<div class="empty"><b>还没有总结</b><p>准备好解析文档后，可以从右侧发起分析。</p></div>';
      return;
    }
    const tabs = document.createElement("div");
    tabs.className = "vbar";
    const content = document.createElement("div");
    content.className = "doc";
    body.append(tabs, content);
    for (const artifact of list)
      tabs.append(
        button(`${artifact.purpose} · ${artifact.content.title}`, () =>
          renderKnowledgeArtifact(artifact, content, ctx.signal),
        ),
      );
    renderKnowledgeArtifact(list[0]!, content, ctx.signal);
    label.textContent = `${list.length} 份知识产物 · 证据按实际定位能力展开`;
  }
}
