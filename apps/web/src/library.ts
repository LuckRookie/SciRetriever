import {
  parseLiteratureDetail,
  parseLiteratureSearchItem,
  parseReferenceDetail,
  type LibrarySearchPage,
  type LiteratureDetail,
} from "@sciretriever/contracts";
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
  request(path: string, body: unknown): Promise<Record<string, unknown>>;
  download(id: string, kind: "primary-pdf" | "content-markdown"): Promise<void>;
  currentArticle(): string | undefined;
  selectArticle?(id: string): Promise<void>;
  bibliography?(id: string, format: "bibtex" | "ris"): Promise<void>;
}): void {
  let cursor: string | null = null,
    searchRevision = 0,
    detailRevision = 0,
    selected: string | undefined,
    searching = false;
  let searchInput: { text: string | null; sort: string } = {
    text: null,
    sort: "publication-year-desc",
  };
  const open = (library: boolean) => {
    node("jobs-workspace").hidden = true;
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
      void search();
      if (selected) void detail(selected);
    }
    node(library ? "library-tab" : "browser-tab").setAttribute(
      "aria-current",
      "page",
    );
    node(library ? "browser-tab" : "library-tab").removeAttribute(
      "aria-current",
    );
    node("jobs-tab").removeAttribute("aria-current");
    node("jobs-toggle").textContent = "任务";
  };
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
          .catch(() => message("文件暂时无法下载，请刷新详情后重试。"))
          .finally(() => {
            button.disabled = false;
          });
      });
      actions.append(button);
    };
    if (d.primary_pdf) download("下载 PDF", "primary-pdf");
    if (d.content) download("下载 Markdown", "content-markdown");
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
    const showRelations = async (mode: "references" | "cited-by") => {
      const result = await options.request("/api/library/references", {
        literature_id: d.literature.literature_id,
        direction: mode,
        limit: 25,
        cursor: null,
      });
      const page = result.page as {
        items: readonly {
          reference: { reference_id: string };
          related_literature: { literature: LiteratureDetail["literature"] };
          support_count: number;
        }[];
      };
      relations.replaceChildren(
        element("h3", mode === "references" ? "参考文献" : "被引文献"),
      );
      if (!page.items.length)
        relations.append(element("p", "暂无记录。", "library-empty"));
      for (const item of page.items) {
        const b = document.createElement("button");
        b.textContent = `${item.related_literature.literature.metadata.title ?? "未命名文献"} · 支持证据 ${item.support_count}`;
        b.addEventListener("click", () => {
          void (async () => {
            const reference = await options.request("/api/library/reference", {
              reference_id: item.reference.reference_id,
            });
            const evidence = parseReferenceDetail(reference.detail);
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
    if (!d.content)
      root.append(
        element(
          "p",
          d.primary_pdf ? "全文已保存，内容尚未生成。" : "尚未保存全文。",
          "library-empty",
        ),
      );
  };
  const detail = async (id: string) => {
    const revision = ++detailRevision;
    selected = id;
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
    } catch {
      if (revision === detailRevision)
        node("library-detail").replaceChildren(
          element("p", "无法读取文献，请重新选择。", "library-empty"),
        );
    }
  };
  const search = async (more = false) => {
    if (more && searching) return;
    const revision = ++searchRevision;
    searching = true;
    if (!more) {
      cursor = null;
      searchInput = {
        text: node<HTMLInputElement>("library-query").value.trim() || null,
        sort: node<HTMLSelectElement>("library-sort").value,
      };
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
      message(`找到 ${page.total_count} 篇文献`);
      if (!more && !items.length)
        node("library-results").append(
          element(
            "p",
            "没有找到匹配文献。试试其他标题、作者或关键词。",
            "library-empty",
          ),
        );
      node("library-more").hidden = !cursor;
    } catch {
      if (revision === searchRevision) message("搜索失败，请检查条件后重试。");
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
  void search();
}
