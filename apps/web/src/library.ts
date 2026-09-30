import {
  parseLiteratureDetail,
  parseLiteratureSearchItem,
  parseReferenceDetail,
  type LibrarySearchPage,
  type LiteratureDetail,
} from "@sciretriever/contracts";
import { record, referencePage } from "./wire.js";
import { mountDocumentReading } from "./document-reading.js";
import { navigateWorkspace, onWorkspace } from "./navigation.js";
const node = <T extends HTMLElement = HTMLElement>(id: string) => {
  const element = document.getElementById(id);
  if (!element) throw new Error("missing library element");
  return element as T;
};
const status: Record<string, string> = {
  UNREVIEWED: "待获取全文",
  ASSET_READY: "已保存 PDF",
  CONTENT_READY: "内容已就绪",
};
function element(tag: string, text: string, className?: string): HTMLElement {
  const e = document.createElement(tag);
  e.textContent = text;
  if (className) e.className = className;
  return e;
}
export function mountLibrary(options: {
  /** Mount the reading view without Browser, Jobs or Configuration navigation bindings. */
  queryOnly?: boolean;
  request(path: string, body: unknown): Promise<Record<string, unknown>>;
  download(id: string, kind: "primary-pdf" | "content-markdown"): Promise<void>;
  currentArticle(): string | undefined;
  selectArticle?(id: string): Promise<void>;
  bibliography?(id: string, format: "bibtex" | "ris"): Promise<void>;
}): { openArticle(id: string): Promise<void> } {
  const queryOnly = options.queryOnly === true;
  let cursor: string | null = null,
    searchRevision = 0,
    detailRevision = 0,
    selected: string | undefined,
    searching = false;
  const relationCursors = new Map<"references" | "cited-by", string | null>();
  let searchInput: { text: string | null; sort: string } = {
    text: null,
    sort: "publication-year-desc",
  };
  const open = (library: boolean, push = true) => {
    node("jobs-workspace").hidden = true;
    node("config-workspace").hidden = true;
    node("library-workspace").hidden = !library;
    node("live-workspace").hidden = library;
    node("open-details").hidden = library;
    node("workspace-name").textContent = library ? "文献库" : "Browser 工作台";
    const skip = document.querySelector<HTMLAnchorElement>(".skip-link");
    if (skip) {
      skip.href = library ? "#library-workspace" : "#live-workspace";
      skip.textContent = library ? "跳到文献库" : "跳到工作台";
    }
    node("library-toggle").textContent = library ? "Browser 工作台" : "文献库";
    node("live-details").dataset.open = "false";
    node("details-backdrop").hidden = true;
    if (library) {
      if (push) navigateWorkspace("library");
      node("library-workspace").focus();
      void search(false, false);
      if (selected) void detail(selected, false);
    } else {
      if (push) navigateWorkspace("browser");
      node("live-workspace").focus();
    }
    node(library ? "library-tab" : "browser-tab").setAttribute(
      "aria-current",
      "page",
    );
    node(library ? "browser-tab" : "library-tab").removeAttribute(
      "aria-current",
    );
    node("jobs-tab").removeAttribute("aria-current");
    node("config-tab").removeAttribute("aria-current");
    node("jobs-toggle").textContent = "任务";
  };
  if (!queryOnly) {
    node("library-toggle").addEventListener("click", () =>
      open(node("library-workspace").hidden),
    );
    node("library-tab").addEventListener("click", (e) => {
      e.preventDefault();
      open(true);
    });
    node("browser-tab").addEventListener("click", (e) => {
      e.preventDefault();
      open(false);
    });
  }
  const message = (text: string) => {
    node("library-status").textContent = text;
  };
  const renderDetail = (d: LiteratureDetail) => {
    const root = node("library-detail");
    root.replaceChildren();
    root.append(
      element(
        "p",
        status[d.literature.status] ?? d.literature.status,
        "live-eyebrow",
      ),
      element("h2", d.literature.metadata.title ?? "未命名文献"),
    );
    const m = d.literature.metadata;
    root.append(
      element(
        "p",
        m.authors
          .map(
            (a) =>
              a.display_name ??
              [a.given_name, a.family_name].filter(Boolean).join(" "),
          )
          .join(" · ") || "作者未提供",
        "library-meta",
      ),
    );
    root.append(
      element(
        "p",
        [m.publication_year, m.venue, d.literature.version_role]
          .filter(Boolean)
          .join(" · "),
        "library-meta",
      ),
    );
    for (const identifier of m.identifiers)
      root.append(
        element(
          "p",
          `${identifier.namespace.toUpperCase()} ${identifier.value}`,
          "library-identifier",
        ),
      );
    if (m.abstract)
      root.append(
        element("h3", "摘要"),
        element("p", m.abstract, "library-abstract"),
      );
    if (m.keywords.length)
      root.append(element("p", m.keywords.join(" · "), "library-keywords"));
    const actions = element("div", "", "library-actions");
    const download = (
      label: string,
      kind: "primary-pdf" | "content-markdown",
    ) => {
      const button = document.createElement("button");
      button.textContent = label;
      button.addEventListener("click", () => {
        button.disabled = true;
        void options
          .download(d.literature.literature_id, kind)
          .catch((error: unknown) => {
            const code = error instanceof Error ? error.message : "";
            message(
              code === "missing-primary-pdf"
                ? "这篇文献没有已接纳的 PDF；只读查询不会启动获取。"
                : code === "missing-literature-content"
                  ? "这篇文献没有已保存的内容；只读查询不会启动解析或生成。"
                  : "文件暂时无法下载，请刷新详情后重试。",
            );
          })
          .finally(() => {
            button.disabled = false;
          });
      });
      actions.append(button);
    };
    if (d.primary_pdf) download("下载 PDF", "primary-pdf");
    if (d.content) download("下载 Markdown", "content-markdown");
    if (queryOnly) {
      const reader = mountDocumentReading(root, d, options.request, message);
      if (reader) actions.append(reader);
    }
    if (options.bibliography) {
      for (const [label, format] of [
        ["导出 BibTeX", "bibtex"],
        ["导出 RIS", "ris"],
      ] as const) {
        const button = document.createElement("button");
        button.textContent = label;
        button.addEventListener("click", () => {
          button.disabled = true;
          void options.bibliography!(d.literature.literature_id, format)
            .catch(() => message("书目信息暂时无法导出。"))
            .finally(() => {
              button.disabled = false;
            });
        });
        actions.append(button);
      }
    }
    if (d.literature.literature_id === options.currentArticle()) {
      const back = document.createElement("button");
      back.textContent = "查看当前 Browser 会话";
      back.addEventListener("click", () => open(false));
      actions.append(back);
    } else if (options.selectArticle) {
      const target = document.createElement("button");
      target.textContent = "在 Browser 中打开";
      target.addEventListener("click", () => {
        target.disabled = true;
        void options.selectArticle!(d.literature.literature_id)
          .then(() => message("Browser 已切换到这篇文献。"))
          .catch(() => message("Browser 暂时无法切换目标，请先结束当前操作。"))
          .finally(() => {
            target.disabled = false;
          });
      });
      actions.append(target);
    }
    const relations = element("div", "", "library-actions");
    const showRelations = async (
      mode: "references" | "cited-by",
      append = false,
    ) => {
      const result = await options.request("/api/library/references", {
        literature_id: d.literature.literature_id,
        direction: mode,
        limit: 25,
        cursor: append ? (relationCursors.get(mode) ?? null) : null,
      });
      const page = referencePage(result);
      relationCursors.set(mode, page.next_cursor);
      if (!append)
        relations.replaceChildren(
          element("h3", mode === "references" ? "参考文献" : "被引文献"),
        );
      if (!page.items.length)
        relations.append(element("p", "暂无记录。", "library-empty"));
      for (const item of page.items) {
        const related = record(item.related_literature, "related literature");
        const literature = record(related.literature, "related literature");
        const metadata = record(literature.metadata, "related metadata");
        if (typeof metadata.title !== "string" && metadata.title !== null)
          throw new Error("invalid related title");
        const b = document.createElement("button");
        b.textContent = `${metadata.title ?? "未命名文献"} · 支持证据 ${String(item.support_count)}`;
        b.addEventListener("click", () => {
          void (async () => {
            const referenceValue = record(item.reference, "reference");
            if (typeof referenceValue.reference_id !== "string")
              throw new Error("invalid reference id");
            const referenceResponse = await options.request(
              "/api/library/reference",
              {
                reference_id: referenceValue.reference_id,
              },
            );
            const evidence = parseReferenceDetail(referenceResponse.detail);
            const support = element("div", "", "library-evidence");
            support.append(element("strong", "来源证据"));
            for (const value of evidence.supports) {
              const source = value.source;
              const label =
                source.kind === "provider_relation"
                  ? `Provider 关系 · observation ${source.observation_id}`
                  : source.kind === "metadata_reference_text"
                    ? `元数据参考文献文本 · 第 ${source.reference_index + 1} 项`
                    : `正文参考文献文本 · 第 ${source.reference_index + 1} 项`;
              support.append(element("p", label, "library-meta"));
            }
            relations.append(support);
          })().catch(() => message("引用证据暂时无法读取。"));
        });
        relations.append(b);
      }
      const existing = relations.querySelector<HTMLButtonElement>(
        "[data-more-relations]",
      );
      existing?.remove();
      if (page.next_cursor) {
        const more = document.createElement("button");
        more.type = "button";
        more.dataset.moreRelations = mode;
        more.textContent = "加载更多引用";
        more.addEventListener("click", () => {
          more.disabled = true;
          void showRelations(mode, true).catch(() =>
            message("引用关系暂时无法读取。"),
          );
        });
        relations.append(more);
      }
    };
    const relationButton = (label: string, mode: "references" | "cited-by") => {
      const b = document.createElement("button");
      b.textContent = label;
      b.addEventListener(
        "click",
        () =>
          void showRelations(mode).catch(() =>
            message("引用关系暂时无法读取。"),
          ),
      );
      actions.append(b);
    };
    relationButton("查看参考文献", "references");
    relationButton("查看被引文献", "cited-by");
    const versions = document.createElement("button");
    versions.textContent = `其他版本 (${d.other_versions.length})`;
    versions.addEventListener("click", () => {
      relations.replaceChildren(element("h3", "其他版本"));
      for (const v of d.other_versions) {
        const b = document.createElement("button");
        b.textContent =
          v.literature.metadata.title ?? v.literature.literature_id;
        b.addEventListener(
          "click",
          () => void detail(v.literature.literature_id),
        );
        relations.append(b);
      }
    });
    actions.append(versions);
    root.append(actions);
    root.append(relations);
    root.append(
      element(
        "p",
        `参考文献 ${d.reference_count} · 被引 ${d.cited_by_count} · 其他版本 ${d.other_versions.length}`,
        "library-meta",
      ),
    );
    if (d.content)
      for (const section of d.content.sections) {
        root.append(
          element(
            "h3",
            section.title ??
              {
                "background-and-objectives": "研究背景与目标",
                methods: "研究方法",
                data: "数据",
                "conclusions-and-limitations": "结论与局限性",
                additional: "补充信息",
              }[section.role] ??
              section.role,
          ),
          element("p", section.markdown, "library-abstract"),
        );
        for (const subsection of section.subsections)
          root.append(
            element("h4", subsection.title),
            element("p", subsection.markdown, "library-abstract"),
          );
      }
    if (!d.primary_pdf)
      root.append(
        element(
          "p",
          "尚无已接纳的 PDF；只读查询不会启动获取。",
          "library-empty",
        ),
      );
    if (!d.content)
      root.append(
        element(
          "p",
          d.primary_pdf
            ? "PDF 已保存，但文献内容尚未保存。只读查询不会启动解析或生成。"
            : "尚无已保存的文献内容。",
          "library-empty",
        ),
      );
  };
  const detail = async (id: string, push = true) => {
    const revision = ++detailRevision;
    selected = id;
    if (push) {
      const url = new URL(window.location.href);
      url.searchParams.set("literature", id);
      window.history.pushState({ literature: id }, "", url);
    }
    node("library-detail").replaceChildren(
      element("p", "正在读取文献…", "library-empty"),
    );
    for (const button of node(
      "library-results",
    ).querySelectorAll<HTMLButtonElement>("button"))
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.literatureId === id),
      );
    try {
      const result = await options.request("/api/library/detail", {
        literature_id: id,
      });
      const parsed = await parseLiteratureDetail(result.detail);
      if (revision === detailRevision) renderDetail(parsed);
    } catch (error: unknown) {
      if (revision === detailRevision) {
        const code = error instanceof Error ? error.message : "";
        node("library-detail").replaceChildren(
          element(
            "p",
            code === "query-not-initialized"
              ? "文献库尚未初始化；只读查询不会创建 catalog。"
              : code === "query-unavailable"
                ? "文献库暂不可用，可能需要显式维护。"
                : "无法读取文献，请重新选择。",
            "library-empty",
          ),
        );
        selected = undefined;
        const url = new URL(window.location.href);
        if (url.searchParams.get("literature") === id) {
          url.searchParams.delete("literature");
          window.history.replaceState({}, "", url);
        }
      }
    }
  };
  const search = async (more = false, push = true) => {
    if (more && searching) return;
    const revision = ++searchRevision;
    searching = true;
    if (!more) {
      cursor = null;
      searchInput = {
        text: node<HTMLInputElement>("library-query").value.trim() || null,
        sort: node<HTMLSelectElement>("library-sort").value,
      };
      if (push) {
        const url = new URL(window.location.href);
        if (searchInput.text) url.searchParams.set("q", searchInput.text);
        else url.searchParams.delete("q");
        url.searchParams.set("sort", searchInput.sort);
        window.history.pushState(
          { q: searchInput.text, sort: searchInput.sort },
          "",
          url,
        );
      }
      node("library-more").hidden = true;
      node("library-results").replaceChildren();
    }
    node<HTMLButtonElement>("library-more").disabled = true;
    message("正在搜索文献库…");
    try {
      const result = await options.request("/api/library/search", {
        query: { text: searchInput.text },
        sort: searchInput.sort,
        limit: 25,
        cursor: more ? cursor : null,
      });
      const page = result.page as LibrarySearchPage;
      if (
        !page ||
        !Array.isArray(page.items) ||
        !Number.isSafeInteger(page.total_count) ||
        page.total_count < 0 ||
        (page.next_cursor !== null && typeof page.next_cursor !== "string")
      )
        throw new Error("invalid library page");
      const items = page.items.map(parseLiteratureSearchItem);
      if (revision !== searchRevision) return;
      cursor = page.next_cursor;
      for (const item of items) {
        const l = item.literature,
          button = document.createElement("button");
        button.className = "library-result";
        button.dataset.literatureId = l.literature_id;
        button.setAttribute(
          "aria-pressed",
          String(l.literature_id === selected),
        );
        button.append(
          element(
            "span",
            status[l.status] ?? l.status,
            "library-result-status",
          ),
          element("strong", l.metadata.title ?? "未命名文献"),
          element(
            "span",
            [l.metadata.publication_year, l.metadata.venue]
              .filter(Boolean)
              .join(" · ") || "出版信息未提供",
            "library-meta",
          ),
        );
        button.addEventListener("click", () => {
          void detail(l.literature_id);
        });
        node("library-results").append(button);
      }
      message(
        !searchInput.text && page.total_count === 0
          ? "文献库为空，尚无已入库文献。"
          : `找到 ${page.total_count} 篇文献`,
      );
      if (!more && !items.length)
        node("library-results").append(
          element(
            "p",
            searchInput.text
              ? "没有找到匹配文献。试试其他标题、作者或关键词。"
              : "文献库为空，尚无可读取的文献。",
            "library-empty",
          ),
        );
      node("library-more").hidden = !cursor;
    } catch (error: unknown) {
      if (revision === searchRevision) {
        const code = error instanceof Error ? error.message : "";
        message(
          code === "query-not-initialized"
            ? "文献库尚未初始化；只读查询不会创建 catalog。"
            : code === "query-unavailable"
              ? "文献库暂不可用，可能需要显式维护。"
              : "搜索失败，请检查条件后重试。",
        );
      }
    } finally {
      if (revision === searchRevision) {
        searching = false;
        node<HTMLButtonElement>("library-more").disabled = !cursor;
      }
    }
  };
  node("library-form").addEventListener("submit", (e) => {
    e.preventDefault();
    void search();
  });
  node("library-sort").addEventListener("change", () => {
    void search();
  });
  node("library-more").addEventListener("click", () => {
    void search(true);
  });
  window.addEventListener("popstate", () => {
    const url = new URL(window.location.href);
    const query = url.searchParams.get("q") ?? "";
    const sort = url.searchParams.get("sort") ?? "publication-year-desc";
    node<HTMLInputElement>("library-query").value = query;
    node<HTMLSelectElement>("library-sort").value = sort;
    void search(false, false);
    const id = url.searchParams.get("literature");
    if (id) void detail(id, false);
    else {
      selected = undefined;
      node("library-detail").replaceChildren(
        element(
          "p",
          "选择一篇文献，查看摘要、当前全文和处理结果。",
          "library-empty",
        ),
      );
    }
  });
  if (!queryOnly)
    onWorkspace((workspace) => {
      if (workspace === "library") open(true, false);
      else if (workspace === "browser" && !node("library-workspace").hidden)
        open(false, false);
    });
  const initial = new URL(window.location.href);
  node<HTMLInputElement>("library-query").value =
    initial.searchParams.get("q") ?? "";
  node<HTMLSelectElement>("library-sort").value =
    initial.searchParams.get("sort") ?? "publication-year-desc";
  void search(false, false);
  const initialId = initial.searchParams.get("literature");
  if (initialId) void detail(initialId, false);
  return {
    openArticle: async (id: string) => {
      open(true);
      await detail(id);
    },
  };
}
