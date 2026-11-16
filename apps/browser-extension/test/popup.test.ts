import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Page, type Route } from "playwright";
import { buildBrowserExtension } from "../../../scripts/build-browser-extension.mjs";
import type { WebPageData } from "../src/page.js";

/**
 * The popup in Chromium with a stand-in for the extension API. The popup,
 * the library it talks to and the publisher's PDF share one test origin, so
 * the browser's own rules (cookies, credentials) still apply to each request.
 */
// Localhost counts as a secure context, as an extension page does: the
// popup hashes the PDF and makes request IDs with Web Crypto.
const ORIGIN = "http://localhost:4199";
const PDF = `${ORIGIN}/article/abc/pdf`;
let browser: Browser, directory: string;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  directory = await buildBrowserExtension(
    await mkdtemp(join(tmpdir(), "sciretriever-popup-")),
  );
});
afterAll(async () => {
  await browser?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

const page: WebPageData = {
  url: "https://journal.test/article/abc",
  title: "Argyrodite electrolyte one | Journal",
  meta: [{ attribute: "name", key: "citation_doi", content: "10.5555/abc" }],
  json_ld: [],
  is_pdf: false,
};
const metadata = {
  title: "Argyrodite electrolyte one",
  authors: ["Smith", "Lee", "Wang", "Zhao"].map((display_name) => ({
    display_name,
  })),
  publication_year: 2021,
  identifiers: [{ namespace: "doi", value: "10.5555/abc" }],
};
const lookup = (patch: Record<string, unknown> = {}) => ({
  found: false,
  literature_id: null,
  library_title: null,
  metadata,
  has_pdf: false,
  pdf_url: PDF,
  possible_duplicates: [],
  ...patch,
});
const folders = [
  {
    folder_id: "00000000-0000-4000-8000-0000000000f1",
    parent_id: null,
    name: "电解质",
  },
  {
    folder_id: "00000000-0000-4000-8000-0000000000f2",
    parent_id: "00000000-0000-4000-8000-0000000000f1",
    name: "硫化物",
  },
];
const ok = (result: unknown) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({ protocol_version: 1, result }),
});

interface Seen {
  path: string;
  body: unknown;
  cookie: string | null;
  authorization: string | null;
}
/**
 * Opens the popup with `stored` as the extension's saved connection; the
 * library answers through `library`, the PDF through `pdf`.
 */
async function popup(options: {
  stored?: { address: string; token: string } | null;
  permission?: boolean;
  library?: (path: string, body: unknown) => unknown;
  pdf?: (route: Route) => Promise<void>;
}): Promise<{ tab: Page; seen: Seen[] }> {
  const context = await browser.newContext();
  // A publisher's sign-in cookie: it goes with the PDF, never to the library.
  await context.addCookies([
    { name: "session", value: "publisher", url: ORIGIN },
  ]);
  const tab = await context.newPage();
  const seen: Seen[] = [];
  await tab.addInitScript(
    ({ stored, permission, current }) => {
      const memory: Record<string, unknown> = { ...(stored ?? {}) };
      const asked: string[][] = [];
      Object.assign(window, {
        __memory: memory,
        __asked: asked,
        chrome: {
          storage: {
            local: {
              get: async (keys: string[]) =>
                Object.fromEntries(
                  keys.filter((k) => k in memory).map((k) => [k, memory[k]]),
                ),
              set: async (items: Record<string, unknown>) => {
                Object.assign(memory, items);
              },
              remove: async (keys: string[]) => {
                for (const key of keys) delete memory[key];
              },
            },
          },
          permissions: {
            request: async ({ origins }: { origins: string[] }) => {
              asked.push(origins);
              return permission;
            },
            contains: async () => permission,
          },
          tabs: { query: async () => [{ id: 1, url: current.url }] },
          scripting: {
            executeScript: async () => [{ result: current }],
          },
        },
      });
    },
    {
      stored:
        options.stored === undefined
          ? { address: ORIGIN, token: "srt1_token" }
          : options.stored,
      permission: options.permission ?? true,
      current: page,
    },
  );
  await tab.route(`${ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/article/abc/pdf")
      return (
        options.pdf?.(route) ??
        route.fulfill({
          status: 200,
          contentType: "application/pdf",
          body: Buffer.from("%PDF-1.7\nsynthetic\n"),
        })
      );
    if (url.pathname.startsWith("/api/")) {
      const headers = route.request().headers();
      const type = headers["content-type"] ?? "";
      const body = type.includes("json")
        ? route.request().postDataJSON()
        : null;
      seen.push({
        path: url.pathname,
        body,
        cookie: headers.cookie ?? null,
        authorization: headers.authorization ?? null,
      });
      const reply = options.library?.(url.pathname, body);
      return route.fulfill(
        reply && typeof reply === "object" && "status" in reply
          ? (reply as Parameters<Route["fulfill"]>[0])
          : ok(reply ?? {}),
      );
    }
    const name = url.pathname.slice(1) || "popup.html";
    return route.fulfill({
      status: 200,
      contentType: name.endsWith(".js")
        ? "text/javascript"
        : name.endsWith(".css")
          ? "text/css"
          : "text/html",
      body: await readFile(join(directory, name)),
    });
  });
  await tab.goto(`${ORIGIN}/popup.html`);
  return { tab, seen };
}
/** The library of these tests: the preview given, folders, saving. */
const library =
  (preview: unknown, save: Record<string, unknown> = {}) =>
  (path: string) => {
    if (path === "/api/v1/intake/pages/preview") return preview;
    if (path === "/api/v1/intake/folders") return { items: folders };
    if (path === "/api/v1/intake/pages/save")
      return {
        item_id: "item-1",
        batch_id: "00000000-0000-4000-8000-0000000000b1",
        literature_id: "00000000-0000-4000-8000-0000000000a1",
        disposition: "created",
        metadata: { status: "completed", job_id: null, code: null },
        missing_folder_ids: [],
        file: {
          file_id: "00000000-0000-4000-8000-0000000000c1",
          action: "upload",
          status: "pending",
          reason: null,
        },
        ...save,
      };
    if (path.endsWith("/bytes"))
      return {
        file: {
          file_id: "00000000-0000-4000-8000-0000000000c1",
          action: "upload",
          status: "uploaded",
          reason: null,
        },
      };
    return {};
  };
const zotero = (tab: Page) =>
  tab.getByRole("navigation", { name: "其他入库方式" });
const today = () => new Date().toLocaleDateString("en-CA");

it("asks for the connection code when not connected, and shows no Zotero row", async () => {
  const { tab, seen } = await popup({ stored: null, permission: false });
  try {
    await tab.getByRole("heading", { name: "连接文献库" }).waitFor();
    expect(await zotero(tab).getByRole("button").count()).toBe(0);
    expect(await tab.locator("footer").textContent()).toBe("");
    // The browser asks for the library's address; refused, it cannot connect.
    await tab
      .getByLabel("粘贴文献库设置页“设备连接”里生成的连接码")
      .fill(
        `sr-connect1:${encodeURIComponent("http://localhost:4174")}:srp1_${"a".repeat(43)}`,
      );
    await tab.getByRole("button", { name: "连接", exact: true }).click();
    await tab
      .getByText("没有访问 http://localhost:4174 的权限，扩展无法连接。")
      .waitFor();
    expect(
      await tab.evaluate(
        () => (window as unknown as { __asked: string[][] }).__asked,
      ),
    ).toEqual([["http://localhost:4174/*"]]);
    expect(seen).toEqual([]);
  } finally {
    await tab.context().close();
  }
}, 60000);

it("says a paper is already in the library, with or without its PDF, and offers to add the PDF it lacks", async () => {
  const held = await popup({
    library: library(
      lookup({
        found: true,
        literature_id: "00000000-0000-4000-8000-0000000000a1",
        library_title: "Argyrodite electrolyte one (library)",
        has_pdf: true,
      }),
    ),
  });
  try {
    const tab = held.tab;
    await tab.getByText("已在库 · 已有 PDF").waitFor();
    await tab
      .getByRole("heading", { name: "Argyrodite electrolyte one (library)" })
      .waitFor();
    expect(await tab.getByRole("button", { name: "补上 PDF" }).count()).toBe(0);
    expect(await tab.locator("footer").textContent()).toContain(
      `已连接 ${ORIGIN}`,
    );
  } finally {
    await held.tab.context().close();
  }
  const missing = await popup({
    library: library(lookup({ found: true, library_title: "In library" })),
  });
  try {
    await missing.tab.getByText("已在库 · 还没有 PDF").waitFor();
    await missing.tab.getByRole("button", { name: "补上 PDF" }).waitFor();
  } finally {
    await missing.tab.context().close();
  }
}, 60000);

it("shows a paper not in the library: title, three authors and “等”, year, identifier, folders by level and “连同 PDF”", async () => {
  const { tab, seen } = await popup({ library: library(lookup()) });
  try {
    await tab
      .getByRole("heading", { name: "Argyrodite electrolyte one" })
      .waitFor();
    expect(await tab.locator(".byline").textContent()).toBe(
      "Smith, Lee, Wang 等 · 2021",
    );
    expect(await tab.locator(".identifiers").textContent()).toBe(
      "DOI 10.5555/abc",
    );
    expect(
      await tab.getByLabel("文件夹").locator("option").allTextContents(),
    ).toEqual(["不放进文件夹", "电解质", "　硫化物"]);
    expect(await tab.getByLabel("连同 PDF").isChecked()).toBe(true);
    await tab.getByRole("button", { name: "收藏", exact: true }).waitFor();
    // The page went to the library as it is, with the device token only.
    const preview = seen.find(
      (r) => r.path === "/api/v1/intake/pages/preview",
    )!;
    expect(preview.body).toEqual({ protocol_version: 1, request: { page } });
    expect(preview.authorization).toBe("Bearer srt1_token");
    expect(seen.every((r) => r.cookie === null)).toBe(true);
    expect(seen.some((r) => r.path === "/api/v1/intake/pages/save")).toBe(
      false,
    );
  } finally {
    await tab.context().close();
  }
}, 60000);

it("collects the page with its PDF into the day's batch and uploads the PDF, the page's cookies kept from the library", async () => {
  let pdfCookie: string | null = null;
  const { tab, seen } = await popup({
    library: library(lookup()),
    pdf: async (route) => {
      pdfCookie = route.request().headers().cookie ?? null;
      await route.fulfill({
        status: 200,
        contentType: "application/pdf",
        body: Buffer.from("%PDF-1.7\nsynthetic\n"),
      });
    },
  });
  try {
    await tab.getByLabel("文件夹").selectOption({ label: "　硫化物" });
    await tab.getByRole("button", { name: "收藏", exact: true }).click();
    await tab.getByText(`已收进“网页收藏 ${today()}”。`).waitFor();
    await tab.getByText("PDF 已上传。").waitFor();
    await tab.getByText("已收藏", { exact: true }).waitFor();
    const save = seen.find((r) => r.path === "/api/v1/intake/pages/save")!;
    expect(save.body).toMatchObject({
      protocol_version: 1,
      request: {
        page,
        folder_ids: ["00000000-0000-4000-8000-0000000000f2"],
        file: {
          file_name: expect.any(String),
          size_bytes: 19,
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
          source_url: PDF,
        },
      },
    });
    expect(seen.map((r) => r.path).at(-1)).toBe(
      "/api/v1/intake/batches/00000000-0000-4000-8000-0000000000b1/files/00000000-0000-4000-8000-0000000000c1/bytes",
    );
    // The publisher's cookie went with the PDF and nowhere else.
    expect(pdfCookie).toBe("session=publisher");
    expect(seen.every((r) => r.cookie === null)).toBe(true);
  } finally {
    await tab.context().close();
  }
}, 60000);

it("keeps the bibliography when the PDF cannot be had, and says why", async () => {
  const { tab, seen } = await popup({
    library: library(lookup(), { file: null }),
    pdf: (route) => route.fulfill({ status: 403, body: "Forbidden" }),
  });
  try {
    await tab.getByRole("button", { name: "收藏", exact: true }).click();
    await tab.getByText(`已收进“网页收藏 ${today()}”。`).waitFor();
    await tab.getByText("PDF 没有收进来：网站返回 403。").waitFor();
    const save = seen.find((r) => r.path === "/api/v1/intake/pages/save")!;
    expect((save.body as { request: { file: unknown } }).request.file).toBe(
      null,
    );
    expect(seen.some((r) => r.path.endsWith("/bytes"))).toBe(false);
  } finally {
    await tab.context().close();
  }
  // A download that is not a PDF (a sign-in page) is not sent either.
  const html = await popup({
    library: library(lookup(), { file: null }),
    pdf: (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<html>Sign in</html>",
      }),
  });
  try {
    await html.tab.getByRole("button", { name: "收藏", exact: true }).click();
    await html.tab
      .getByText(
        "PDF 没有收进来：下载到的不是 PDF，可能需要先登录或没有全文权限。",
      )
      .waitFor();
  } finally {
    await html.tab.context().close();
  }
}, 60000);

it("lists “从 Zotero 导入” below the page's item, not yet usable, and leads nowhere", async () => {
  const { tab, seen } = await popup({ library: library(lookup()) });
  try {
    await tab
      .getByRole("heading", { name: "Argyrodite electrolyte one" })
      .waitFor();
    const row = zotero(tab).getByRole("button", { name: /从 Zotero 导入/u });
    expect(await row.isDisabled()).toBe(true);
    expect(await row.getAttribute("aria-describedby")).toBe("zotero-note");
    expect(await tab.locator("#zotero-note").textContent()).toBe("尚未开放");
    // Below the body, above the connection line.
    const order = await tab.evaluate(() =>
      [...document.body.children].map((el) => el.id),
    );
    expect(order.slice(0, 3)).toEqual(["app", "more", "footer"]);
    const before = seen.length;
    await row.click({ force: true });
    expect(seen.length).toBe(before);
    expect(new URL(tab.url()).pathname).toBe("/popup.html");
  } finally {
    await tab.context().close();
  }
}, 60000);
