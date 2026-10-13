import { record, type JsonRecord } from "./wire.js";
import { navigateWorkspace } from "./navigation.js";

interface Capabilities {
  readonly query: boolean;
  readonly maintenance: boolean;
  readonly discovery: boolean;
  readonly import: boolean;
}

function node<T extends HTMLElement = HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`missing workspace element: ${id}`);
  return value as T;
}

/** Workspace identity is a server snapshot, not a second configuration owner. */
export async function mountWorkspaceTools(options: {
  read(path: string): Promise<JsonRecord>;
  request(path: string, body: unknown): Promise<JsonRecord>;
}): Promise<Capabilities> {
  let capabilities: Capabilities = {
    query: false,
    maintenance: false,
    discovery: false,
    import: false,
  };
  try {
    const value = record(
      (await options.read("/api/workspace")).workspace,
      "workspace",
    );
    const available = record(value.capabilities, "workspace capabilities");
    capabilities = {
      query: available.query === true,
      maintenance: available.maintenance === true,
      discovery: available.discovery === true,
      import: available.import === true,
    };
    const catalog =
      typeof value.catalog_path === "string" ? value.catalog_path : "未提供";
    const artifacts =
      typeof value.artifact_root === "string" ? value.artifact_root : "未提供";
    node("workspace-binding").textContent = `当前文献库 · ${catalog}`;
    node("current-database-binding").textContent =
      `当前进程：Catalog ${catalog}；资产目录 ${artifacts}。`;
    node("rail-library-status").textContent =
      available.query === true ? "已连接文献数据库" : "当前服务未提供完整查询";
  } catch {
    node("workspace-binding").textContent =
      "当前服务未提供数据库绑定信息。请检查服务版本与启动配置。";
    node("current-database-binding").textContent =
      "当前进程的数据库绑定暂不可用。下方为已保存配置。";
    node("rail-library-status").textContent = "数据库状态暂不可用";
  }
  for (const [id, enabled] of [
    ["processing-tools", capabilities.maintenance],
    ["query-tools", capabilities.query],
    ["manual-pdf-form", capabilities.maintenance],
    ["discovery-form", capabilities.discovery],
    ["bibliography-import-form", capabilities.import],
  ] as const) {
    const root = node(id);
    if (enabled) continue;
    const message = document.createElement("p");
    message.className = "capability-unavailable";
    message.textContent =
      "当前服务未启用此功能。请使用正式 Web 入口并检查设置。";
    root.append(message);
    root
      .querySelectorAll<
        | HTMLInputElement
        | HTMLButtonElement
        | HTMLSelectElement
        | HTMLTextAreaElement
      >("input,button,select,textarea")
      .forEach((control) => {
        control.disabled = true;
      });
  }
  const busyForms = new Set<string>();
  const operation = (
    id: string,
    statusId: string,
    run: () => Promise<string>,
  ) => {
    node<HTMLFormElement>(id).addEventListener("submit", (event) => {
      event.preventDefault();
      if (busyForms.has(id)) return;
      busyForms.add(id);
      const button = node(id).querySelector<HTMLButtonElement>(
        'button[type="submit"]',
      )!;
      button.disabled = true;
      node(statusId).textContent = "正在处理，请保留此页面以查看结果…";
      void run()
        .then((message) => {
          node(statusId).textContent = message;
        })
        .catch((error: unknown) => {
          node(statusId).textContent =
            `操作未完成：${error instanceof Error ? error.message : "连接失败"}。请检查设置或稍后重试。`;
        })
        .finally(() => {
          busyForms.delete(id);
          button.disabled = false;
        });
    });
  };
  if (capabilities.discovery)
    operation("discovery-form", "discovery-status", async () => {
      const result = await options.request("/api/discovery", {
        query: node<HTMLInputElement>("discovery-query").value.trim(),
        scan_limit: Number(node<HTMLInputElement>("discovery-limit").value),
      });
      const report = record(result.report, "discovery report");
      const root = node("discovery-result");
      root.replaceChildren();
      if (Array.isArray(report.source_results))
        for (const value of report.source_results) {
          const source = record(value, "discovery source");
          const row = document.createElement("p");
          const failure = source.failure
            ? record(source.failure, "discovery failure")
            : null;
          row.textContent = `${String(source.provider_name)} · ${String(source.outcome)}${failure ? ` · ${String(failure.reason)}` : ""}`;
          root.append(row);
        }
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "刷新文献库";
      button.addEventListener("click", () => {
        navigateWorkspace("library");
        node<HTMLFormElement>("library-form").requestSubmit();
      });
      root.append(button);
      return `发现${report.status === "COMPLETED" ? "完成" : `结束（${String(report.status)}）`}：接纳 ${String(report.accepted_count)} 条，匹配 ${String(report.matched_count)} 条。未启动 PDF 获取。`;
    });
  if (capabilities.import)
    operation(
      "bibliography-import-form",
      "bibliography-import-status",
      async () => {
        const file = node<HTMLInputElement>("bibliography-file").files?.[0];
        if (!file || file.size < 1 || file.size > 768 * 1024)
          throw new Error("请选择不超过 768 KiB 的非空书目文件");
        const result = await options.request("/api/import", {
          format: node<HTMLSelectElement>("bibliography-format").value,
          content: await file.text(),
        });
        const report = record(result.report, "import report");
        const items = Array.isArray(report.items) ? report.items : [];
        const output = document.createElement("pre");
        output.className = "import-receipt";
        output.textContent = JSON.stringify(report, null, 2);
        node("bibliography-import-form")
          .querySelector(".import-receipt")
          ?.remove();
        node("bibliography-import-form").append(output);
        node<HTMLFormElement>("library-form").requestSubmit();
        return `导入已结束，共 ${items.length} 条逐项回执。可在文献库查看已接纳的记录；未启动 PDF 获取。`;
      },
    );
  return capabilities;
}
