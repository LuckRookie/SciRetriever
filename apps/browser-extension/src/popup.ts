import { readPage, type WebPageData } from "./page.js";
import {
  CaptureError,
  folderTree,
  LibraryClient,
  manualIdentifier,
  normalizeAddress,
  originPattern,
  parseConnectionCode,
  pdfName,
  sha256,
  withIdentifier,
  type CaptureResult,
  type DuplicateDecision,
  type FileStatus,
  type Folder,
  type Lookup,
} from "./capture.js";

const app = document.getElementById("app")!;
const more = document.getElementById("more")!;
const footer = document.getElementById("footer")!;

interface Connection {
  address: string;
  token: string;
}
async function stored(): Promise<Connection | null> {
  const value = await chrome.storage.local.get(["address", "token"]);
  return typeof value.address === "string" && typeof value.token === "string"
    ? { address: value.address, token: value.token }
    : null;
}

/** A small element builder: tag, attributes, children. */
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Record<string, string | boolean> = {},
  ...children: (Node | string | null)[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes))
    if (value === true) element.setAttribute(name, "");
    else if (value !== false) element.setAttribute(name, value);
  for (const child of children) if (child !== null) element.append(child);
  return element;
}
function show(...children: (Node | string | null)[]) {
  app.replaceChildren(...children.filter((child) => child !== null));
}
const message = (text: string) => (error: unknown) =>
  error instanceof CaptureError ? error.message : text;

/**
 * The popup's two items (page specs “浏览器扩展弹窗”): collecting this page
 * is the body; importing from Zotero is the row below it, shown once
 * connected. Until the import is built (plan 25, 16.4) the row is there but
 * cannot be used, and says so.
 */
function zoteroRow(connection: Connection | null) {
  if (!connection) return more.replaceChildren();
  const row = h(
    "button",
    {
      type: "button",
      class: "more-row",
      disabled: true,
      "aria-describedby": "zotero-note",
    },
    h("span", {}, "从 Zotero 导入"),
    h("span", { class: "note", id: "zotero-note" }, "尚未开放"),
    h("span", { class: "chevron", "aria-hidden": "true" }, "›"),
  );
  more.replaceChildren(row);
}
function setFooter(connection: Connection | null) {
  zoteroRow(connection);
  footer.replaceChildren(
    ...(connection
      ? [
          h("span", {}, `已连接 ${connection.address}`),
          button("设置", () => settings(connection), "text"),
        ]
      : []),
  );
}
function button(
  label: string,
  onClick: () => void | Promise<void>,
  variant: "primary" | "secondary" | "text" = "secondary",
) {
  const element = h(
    "button",
    { type: "button", "data-variant": variant },
    label,
  );
  element.addEventListener("click", () => void onClick());
  return element;
}

/** Not connected: paste the code from the settings page. */
function connect(note: string | null = null) {
  setFooter(null);
  const input = h("input", {
    id: "code",
    type: "text",
    placeholder: "sr-connect1:…",
    autocomplete: "off",
    spellcheck: "false",
  });
  const status = h("p", { class: "note", role: "status" }, note ?? "");
  const submit = button(
    "连接",
    async () => {
      let parsed: ReturnType<typeof parseConnectionCode>;
      try {
        parsed = parseConnectionCode(input.value);
      } catch (error) {
        status.textContent = message("连接码格式不对。")(error);
        return;
      }
      // Asked inside the click: the browser only grants it on a user gesture.
      if (
        !(await chrome.permissions.request({
          origins: [originPattern(parsed.address)],
        }))
      ) {
        status.textContent = `没有访问 ${parsed.address} 的权限，扩展无法连接。`;
        return;
      }
      submit.disabled = true;
      status.textContent = "正在连接…";
      try {
        const token = await new LibraryClient(parsed.address, null).exchange(
          parsed.pairing_code,
        );
        await chrome.storage.local.set({ address: parsed.address, token });
        await start();
      } catch (error) {
        submit.disabled = false;
        status.textContent =
          error instanceof CaptureError && error.code === "unreachable"
            ? `${error.message}。文献库在服务器上时，请检查端口映射是否开着。`
            : message("连接失败。")(error);
      }
    },
    "primary",
  );
  show(
    h("h1", {}, "连接文献库"),
    h("label", { for: "code" }, "粘贴文献库设置页“设备连接”里生成的连接码"),
    input,
    h("div", { class: "actions" }, submit),
    status,
  );
  input.focus();
}

/** Address and disconnect; the token stays when only the address changes. */
function settings(connection: Connection) {
  const input = h("input", {
    id: "address",
    type: "url",
    value: connection.address,
  });
  const status = h("p", { class: "note", role: "status" });
  show(
    h("h1", {}, "设置"),
    h("label", { for: "address" }, "文献库地址"),
    input,
    h("p", { class: "note" }, "端口映射变了时改这里，不需要重新连接。"),
    h(
      "div",
      { class: "actions" },
      button("返回", start, "text"),
      button("断开连接", async () => {
        await chrome.storage.local.remove(["address", "token"]);
        connect("已删除本机保存的令牌。请到文献库设置页撤销这个设备。");
      }),
      button(
        "保存地址",
        async () => {
          let address: string;
          try {
            address = normalizeAddress(input.value);
          } catch (error) {
            status.textContent = message("地址格式不对。")(error);
            return;
          }
          if (
            !(await chrome.permissions.request({
              origins: [originPattern(address)],
            }))
          ) {
            status.textContent = `没有访问 ${address} 的权限。`;
            return;
          }
          await chrome.storage.local.set({ address });
          await start();
        },
        "primary",
      ),
    ),
    status,
  );
}

function unreachable(connection: Connection, error: unknown) {
  const reachable = !(
    error instanceof CaptureError && error.code === "unreachable"
  );
  const revoked =
    error instanceof CaptureError &&
    ["device-token-invalid", "device-revoked"].includes(error.code);
  if (revoked) {
    void chrome.storage.local.remove(["token"]);
    connect(message("")(error));
    return;
  }
  show(
    h("h1", {}, reachable ? "出错了" : `连不上 ${connection.address}`),
    h(
      "p",
      { class: "note" },
      reachable
        ? message("文献库没有给出可识别的回复。")(error)
        : "文献库在服务器上时，请检查端口映射是否开着。",
    ),
    h(
      "div",
      { class: "actions" },
      button("修改地址", () => settings(connection), "text"),
      button("重试", start, "primary"),
    ),
  );
}

async function readCurrentPage(): Promise<WebPageData | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) return null;
  try {
    const [frame] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: readPage,
    });
    return frame?.result ?? null;
  } catch {
    // Browser pages and the store cannot be read.
    return null;
  }
}

async function start() {
  const connection = await stored();
  if (!connection) return connect();
  setFooter(connection);
  show(h("p", { class: "note", role: "status" }, "正在读取页面…"));
  // The page is read once, as it is; the library reads its bibliography.
  const page = await readCurrentPage();
  if (!page) {
    show(
      h("h1", {}, "读不了这个页面"),
      h(
        "p",
        { class: "note" },
        "浏览器自带的页面和扩展商店不能读取，请在文献页面上使用。",
      ),
    );
    return;
  }
  await lookup(connection, page);
}

function askIdentifier(connection: Connection, page: WebPageData) {
  const input = h("input", {
    id: "identifier",
    type: "text",
    placeholder: "10.xxxx/… 或 2401.01234",
  });
  const status = h("p", { class: "note", role: "status" });
  show(
    h("h1", {}, "这一页没有读到书目，无法收藏"),
    h("p", { class: "note" }, "填上 DOI 或 arXiv 号后再查一次。"),
    h("label", { for: "identifier" }, "DOI 或 arXiv 号"),
    input,
    h(
      "div",
      { class: "actions" },
      button(
        "继续",
        async () => {
          const identifier = manualIdentifier(input.value);
          if (!identifier) {
            status.textContent = "没认出 DOI 或 arXiv 号，请检查。";
            return;
          }
          await lookup(connection, withIdentifier(page, identifier));
        },
        "primary",
      ),
    ),
    status,
  );
  input.focus();
}

const badge = (text: string, tone: "done" | "pending") =>
  h("span", { class: "badge", "data-tone": tone }, text);
const authorsLine = (metadata: Lookup["metadata"]) => {
  const names = metadata.authors
    .slice(0, 3)
    .map((author) => author.display_name)
    .join(", ");
  const more = metadata.authors.length > 3 ? " 等" : "";
  return [names + more, metadata.publication_year?.toString()]
    .filter(Boolean)
    .join(" · ");
};

/** “文件夹”: not filed by default, the tree indented by level. */
function folderSelect(folders: Folder[]) {
  return h(
    "select",
    { id: "folder" },
    h("option", { value: "" }, "不放进文件夹"),
    ...folderTree(folders).map(({ folder, depth }) =>
      h(
        "option",
        { value: folder.folder_id },
        `${"\u3000".repeat(depth)}${folder.name}`,
      ),
    ),
  );
}

async function lookup(connection: Connection, page: WebPageData) {
  const client = new LibraryClient(connection.address, connection.token);
  show(h("p", { class: "note", role: "status" }, "正在查询文献库…"));
  let found: Lookup;
  let folders: Folder[] = [];
  try {
    [found, folders] = await Promise.all([
      client.lookup(page),
      // The folder list is a convenience: without it the page goes unfiled.
      client.folders().catch(() => []),
    ]);
  } catch (error) {
    return unreachable(connection, error);
  }
  const identifiers = found.metadata.identifiers;
  // A title is enough to collect; only a page with neither asks for an identifier.
  if (!found.found && !identifiers.length && !found.metadata.title?.trim())
    return askIdentifier(connection, page);
  const ids = identifiers.length
    ? identifiers.map((id) =>
        h("li", {}, `${id.namespace === "doi" ? "DOI" : "arXiv"} ${id.value}`),
      )
    : [h("li", {}, "没有读到 DOI 或 arXiv 号")];
  if (found.found) {
    show(
      badge(
        found.has_pdf ? "已在库 · 已有 PDF" : "已在库 · 还没有 PDF",
        "done",
      ),
      h("h1", {}, found.library_title ?? found.metadata.title ?? "（无标题）"),
      h("ul", { class: "identifiers" }, ...ids),
      !found.has_pdf && found.pdf_url
        ? h(
            "div",
            { class: "actions" },
            button(
              "补上 PDF",
              () => save(client, page, found, [], true, undefined),
              "primary",
            ),
          )
        : null,
    );
    return;
  }
  const withPdf = h("input", {
    id: "with-pdf",
    type: "checkbox",
    checked: true,
  });
  const folder = folderSelect(folders);
  let decision: DuplicateDecision | undefined;
  const collect = button(
    "收藏",
    () =>
      save(
        client,
        page,
        found,
        folder.value ? [folder.value] : [],
        !!found.pdf_url && withPdf.checked,
        decision,
      ),
    "primary",
  );
  // Literature and materials 6.4.8: the paper may already be in the library;
  // nothing is collected until the user chooses.
  const candidates = found.possible_duplicates;
  const choices: HTMLButtonElement[] = [];
  const choose = (next: DuplicateDecision, chosen: HTMLButtonElement) => {
    decision = next;
    for (const choice of choices)
      choice.setAttribute("aria-pressed", String(choice === chosen));
    collect.disabled = false;
    collect.textContent =
      next.kind === "merge" ? "并入并收藏" : "作为新文献收藏";
  };
  let duplicates: HTMLElement | null = null;
  if (candidates.length) {
    collect.disabled = true;
    const rows = candidates.map((candidate) => {
      const merge: HTMLButtonElement = button(
        "并入这一篇",
        () =>
          choose(
            { kind: "merge", literature_id: candidate.literature_id },
            merge,
          ),
        "text",
      );
      choices.push(merge);
      return h(
        "li",
        {},
        h(
          "span",
          {},
          [
            candidate.title,
            candidate.first_author,
            candidate.publication_year?.toString(),
          ]
            .filter(Boolean)
            .join(" · "),
        ),
        merge,
      );
    });
    const asNew: HTMLButtonElement = button(
      "作为新文献收藏",
      () => choose({ kind: "new" }, asNew),
      "text",
    );
    choices.push(asNew);
    duplicates = h(
      "section",
      { class: "duplicates", "aria-label": "库里可能已有这篇" },
      h("h2", {}, "库里可能已有这篇"),
      h("ul", {}, ...rows),
      asNew,
    );
  }
  show(
    h("h1", {}, found.metadata.title ?? page.title ?? "（页面上没有标题）"),
    found.metadata.authors.length || found.metadata.publication_year
      ? h("p", { class: "byline" }, authorsLine(found.metadata))
      : null,
    h("ul", { class: "identifiers" }, ...ids),
    h("label", { for: "folder" }, "文件夹"),
    folder,
    found.pdf_url
      ? h("label", { class: "check" }, withPdf, "连同 PDF")
      : h("p", { class: "note" }, "页面上没有找到 PDF，只收藏书目。"),
    duplicates,
    h("div", { class: "actions" }, collect),
  );
}

/** Downloads with the browser's own network and sign-in; nothing of it goes to the library. */
async function downloadPdf(
  url: string,
): Promise<{ bytes: ArrayBuffer; source_url: string } | { failure: string }> {
  const origin = originPattern(url);
  if (!(await chrome.permissions.request({ origins: [origin] })))
    return { failure: `没有访问 ${new URL(url).host} 的权限` };
  try {
    const response = await fetch(url, {
      credentials: "include",
      redirect: "follow",
    });
    if (!response.ok) return { failure: `网站返回 ${response.status}` };
    const bytes = await response.arrayBuffer();
    const head = new TextDecoder().decode(new Uint8Array(bytes.slice(0, 5)));
    return head === "%PDF-"
      ? { bytes, source_url: response.url || url }
      : { failure: "下载到的不是 PDF，可能需要先登录或没有全文权限" };
  } catch {
    return { failure: "网络请求失败" };
  }
}

const FILE_RESULTS: Record<FileStatus["status"], string> = {
  uploaded: "PDF 已上传。",
  existing: "库里已有相同的 PDF。",
  conflict: "库里已有另一份 PDF，没有替换。",
  pending: "PDF 还没交上去，可以再试一次。",
};

async function save(
  client: LibraryClient,
  page: WebPageData,
  preview: Lookup,
  folder_ids: string[],
  withPdf: boolean,
  decision: DuplicateDecision | undefined,
) {
  const title = preview.metadata.title ?? page.title;
  const status = h("p", { class: "note", role: "status" }, "正在收藏…");
  show(h("h1", {}, title ?? "收藏"), status);
  let pdf: { bytes: ArrayBuffer; sha256: string; source_url: string } | null =
      null,
    pdfFailure: string | null = null;
  if (withPdf && preview.pdf_url) {
    status.textContent = "正在下载 PDF…";
    const downloaded = await downloadPdf(preview.pdf_url);
    if ("bytes" in downloaded)
      pdf = {
        bytes: downloaded.bytes,
        sha256: await sha256(downloaded.bytes),
        source_url: downloaded.source_url,
      };
    else pdfFailure = downloaded.failure;
  }
  let result: CaptureResult;
  try {
    status.textContent = "正在收藏…";
    result = await client.save({
      request_id: crypto.randomUUID(),
      page,
      folder_ids,
      file: pdf
        ? {
            file_name: pdfName(pdf.source_url, preview.metadata.identifiers),
            size_bytes: pdf.bytes.byteLength,
            sha256: pdf.sha256,
            source_url: pdf.source_url,
          }
        : null,
      ...(decision ? { duplicate_decision: decision } : {}),
    });
  } catch (error) {
    status.textContent = message("收藏失败。")(error);
    return;
  }
  let file = result.file;
  if (pdf && file?.status === "pending") {
    try {
      status.textContent = "正在上传 PDF…";
      file =
        file.action === "hash"
          ? await client.hash(result, pdf.sha256)
          : await client.bytes(
              result,
              new Blob([pdf.bytes], { type: "application/pdf" }),
            );
    } catch (error) {
      pdfFailure = message("PDF 上传失败。")(error);
    }
  }
  const merged =
    decision?.kind === "merge"
      ? preview.possible_duplicates.find(
          (candidate) => candidate.literature_id === decision.literature_id,
        )
      : undefined;
  // The library forms one batch per device and day.
  const day = new Date().toLocaleDateString("en-CA");
  show(
    badge(
      result.disposition === "created" ? "已收藏" : "已在库，已补充",
      "done",
    ),
    h("h1", {}, title ?? "已收藏"),
    h("p", {}, `已收进“网页收藏 ${day}”。`),
    merged ? h("p", {}, `已并入库里的《${merged.title}》`) : null,
    h(
      "p",
      { class: "note" },
      pdfFailure
        ? `PDF 没有收进来：${pdfFailure}。`
        : file
          ? FILE_RESULTS[file.status]
          : withPdf
            ? ""
            : "只收藏了书目。",
    ),
    ["completed", "pending"].includes(result.metadata.status)
      ? null
      : h("p", { class: "note" }, "文献信息来源暂时没能补全，书目已保存。"),
  );
}

void start();
