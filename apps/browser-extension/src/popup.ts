import { readPage, type PageReading } from "./page.js";
import {
  CaptureError,
  folderTree,
  identifiersOf,
  LibraryClient,
  manualIdentifier,
  metadataOf,
  normalizeAddress,
  originPattern,
  parseConnectionCode,
  pdfName,
  sha256,
  type CaptureResult,
  type FileStatus,
  type Identifier,
  type Lookup,
} from "./capture.js";

const app = document.getElementById("app")!;
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

function setFooter(connection: Connection | null) {
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

async function readCurrentPage(): Promise<PageReading | null> {
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
  const reading = await readCurrentPage();
  if (!reading) {
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
  const identifiers = identifiersOf(reading);
  if (!identifiers.length) return askIdentifier(connection, reading);
  await lookup(connection, reading, identifiers);
}

function askIdentifier(connection: Connection, reading: PageReading) {
  const input = h("input", {
    id: "identifier",
    type: "text",
    placeholder: "10.xxxx/… 或 2401.01234",
  });
  const status = h("p", { class: "note", role: "status" });
  show(
    h("h1", {}, reading.title ?? "这页没有读到标识"),
    h(
      "p",
      { class: "note" },
      "页面上没有读到 DOI 或 arXiv 号。填上才能收藏，不保存没有标识的文献。",
    ),
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
          await lookup(connection, reading, [identifier]);
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
const authorsLine = (reading: PageReading) => {
  const names = reading.authors.slice(0, 3).join(", ");
  const more = reading.authors.length > 3 ? " 等" : "";
  const year = /^\d{4}/u.exec(reading.date ?? "")?.[0];
  return [names + more, year].filter(Boolean).join(" · ");
};

async function lookup(
  connection: Connection,
  reading: PageReading,
  identifiers: Identifier[],
) {
  const client = new LibraryClient(connection.address, connection.token);
  show(h("p", { class: "note", role: "status" }, "正在查询文献库…"));
  let found: Lookup;
  try {
    found = await client.lookup(identifiers);
  } catch (error) {
    return unreachable(connection, error);
  }
  const ids = identifiers.map((id) =>
    h("li", {}, `${id.namespace === "doi" ? "DOI" : "arXiv"} ${id.value}`),
  );
  if (found.found) {
    show(
      badge(
        found.has_pdf ? "已在库 · 已有 PDF" : "已在库 · 还没有 PDF",
        "done",
      ),
      h("h1", {}, found.title ?? reading.title ?? "（无标题）"),
      h("ul", { class: "identifiers" }, ...ids),
      !found.has_pdf && reading.pdf_url
        ? h(
            "div",
            { class: "actions" },
            button(
              "补上 PDF",
              () => save(client, reading, identifiers, [], true),
              "primary",
            ),
          )
        : null,
    );
    return;
  }
  const select = h(
    "select",
    { id: "folder" },
    h("option", { value: "" }, "不放进文件夹"),
  );
  void client
    .folders()
    .then((folders) => {
      for (const { folder, depth } of folderTree(folders))
        select.append(
          h(
            "option",
            { value: folder.folder_id },
            `${"　".repeat(depth)}${folder.name}`,
          ),
        );
    })
    .catch(() => select.setAttribute("title", "文件夹列表没能读取"));
  const withPdf = h("input", {
    id: "with-pdf",
    type: "checkbox",
    checked: true,
  });
  show(
    h("h1", {}, reading.title ?? "（页面上没有标题）"),
    reading.authors.length || reading.date
      ? h("p", { class: "byline" }, authorsLine(reading))
      : null,
    h("ul", { class: "identifiers" }, ...ids),
    h("label", { for: "folder" }, "文件夹"),
    select,
    reading.pdf_url
      ? h("label", { class: "check" }, withPdf, "连同 PDF")
      : h("p", { class: "note" }, "页面上没有找到 PDF，只收藏书目。"),
    h(
      "div",
      { class: "actions" },
      button(
        "收藏",
        () =>
          save(
            client,
            reading,
            identifiers,
            select.value ? [select.value] : [],
            !!reading.pdf_url && withPdf.checked,
          ),
        "primary",
      ),
    ),
  );
}

/** Downloads with the browser's own network and sign-in; nothing of it goes to the library. */
async function downloadPdf(
  url: string,
): Promise<{ bytes: ArrayBuffer } | { failure: string }> {
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
      ? { bytes }
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
  reading: PageReading,
  identifiers: Identifier[],
  folder_ids: string[],
  withPdf: boolean,
) {
  const status = h("p", { class: "note", role: "status" }, "正在收藏…");
  show(h("h1", {}, reading.title ?? "收藏"), status);
  let pdf: { bytes: ArrayBuffer; sha256: string } | null = null,
    pdfFailure: string | null = null;
  if (withPdf && reading.pdf_url) {
    status.textContent = "正在下载 PDF…";
    const downloaded = await downloadPdf(reading.pdf_url);
    if ("bytes" in downloaded)
      pdf = { bytes: downloaded.bytes, sha256: await sha256(downloaded.bytes) };
    else pdfFailure = downloaded.failure;
  }
  let result: CaptureResult;
  try {
    status.textContent = "正在收藏…";
    result = await client.save({
      request_id: crypto.randomUUID(),
      metadata: metadataOf(reading, identifiers),
      folder_ids,
      file: pdf
        ? {
            file_name: pdfName(reading.pdf_url!, identifiers),
            size_bytes: pdf.bytes.byteLength,
            sha256: pdf.sha256,
          }
        : null,
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
          ? await client.hash(result.capture_id, pdf.sha256)
          : await client.bytes(
              result.capture_id,
              new Blob([pdf.bytes], { type: "application/pdf" }),
            );
    } catch (error) {
      pdfFailure = message("PDF 上传失败。")(error);
    }
  }
  // The library forms one batch per device and UTC day.
  const day = new Date().toISOString().slice(0, 10);
  show(
    badge(
      result.disposition === "created" ? "已收藏" : "已在库，已补充",
      "done",
    ),
    h("h1", {}, reading.title ?? "已收藏"),
    h("p", {}, `已收进“网页收藏 ${day}”。`),
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
    result.metadata.status === "completed"
      ? null
      : h("p", { class: "note" }, "元数据来源暂时没能补全，书目已保存。"),
  );
}

void start();
