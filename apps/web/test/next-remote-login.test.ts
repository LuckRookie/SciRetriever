import { readerNavigation } from "./reader-controls.js";
import {
  openSavedViews,
  showAllLibraryStatuses,
} from "./next-workspace-fixture.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request as httpRequest } from "node:http";
import { build } from "esbuild";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { loadAuthAssets } from "../../server/src/workbench/assets.js";
import { nextAssets, motionOptions } from "./next-workspace-fixture.js";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import { startProductionWorkbench } from "../../server/src/bootstrap/workbench.js";
import type { WorkbenchStaticAsset } from "../../server/src/workbench/http.js";
import {
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../../server/src/workbench/synthetic-fixture.js";
import { readingAssets } from "./reading-assets-fixture.js";
import { parseLiterature } from "@sciretriever/contracts";

const PASSWORD = "synthetic-browser-password";
const PUBLIC_ORIGIN = "http://192.0.2.10:4174";

async function assets(
  directory: string,
): Promise<Map<string, WorkbenchStaticAsset>> {
  const result = new Map<string, WorkbenchStaticAsset>([
    ...(await readingAssets()),
    ...(await nextAssets()),
  ]);
  await promisify(execFile)(process.execPath, [
    "--input-type=module",
    "-e",
    "import { buildAuthAssets } from './scripts/build-react-assets.mjs'; await buildAuthAssets(process.argv[1]);",
    directory,
  ]);
  for (const [route, asset] of await loadAuthAssets(
    pathToFileURL(`${directory}/`),
  ))
    result.set(route, asset);
  const platform = await build({
    entryPoints: [
      new URL("../src/browser-platform.ts", import.meta.url).pathname,
    ],
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "remotePlatform",
    write: false,
  });
  result.set("/test-platform.js", {
    contentType: "text/javascript",
    body: platform.outputFiles[0]!.contents,
  });
  return result;
}

describe("IP-address HTTP login and workspace", () => {
  it("logs in, preserves a link, operates without secure-context APIs, logs out and prevents a cached return", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-remote-browser-"));
    // The browser sees a non-trustworthy documentation IP. All sockets actually use loopback.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const address = probe.address();
    if (!address || typeof address === "string")
      throw new Error("fixture address unavailable");
    const port = address.port;
    await new Promise<void>((resolve, reject) =>
      probe.close((error) => (error ? reject(error) : resolve())),
    );
    const server = await startProductionWorkbench({
      home,
      port,
      assets: await assets(join(home, "web")),
      access: {
        host: "127.0.0.1",
        password: PASSWORD,
      },
      applicationOptions: { browserHost: () => null, metadata: {} },
    });
    const proxy = createServer((request, response) => {
      const url = new URL(request.url ?? "/", PUBLIC_ORIGIN);
      if (url.origin !== PUBLIC_ORIGIN) {
        response.writeHead(403);
        response.end();
        return;
      }
      const upstream = httpRequest(
        `http://127.0.0.1:${port}${url.pathname}${url.search}`,
        {
          method: request.method,
          headers: { ...request.headers, host: new URL(PUBLIC_ORIGIN).host },
        },
        (reply) => {
          response.writeHead(reply.statusCode!, reply.headers);
          reply.pipe(response);
        },
      );
      upstream.on("error", () => {
        response.destroy();
      });
      response.on("close", () => upstream.destroy());
      request.pipe(upstream);
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const proxyAddress = proxy.address();
    if (!proxyAddress || typeof proxyAddress === "string")
      throw new Error("fixture proxy unavailable");
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.SCIRETRIEVER_BROWSER_EXECUTABLE
        ? { executablePath: process.env.SCIRETRIEVER_BROWSER_EXECUTABLE }
        : {}),
      proxy: { server: `http://127.0.0.1:${proxyAddress.port}` },
    });
    try {
      await server.application.database.putLiterature(FIXTURE_LITERATURE);
      // A paper without a PDF, for the row menu's “获取 PDF”.
      await server.application.database.putLiterature(
        parseLiterature({
          ...FIXTURE_LITERATURE,
          literature_id: "00000000-0000-0000-0000-000000005101",
          meta_literature_id: "00000000-0000-0000-0000-000000005102",
          metadata: {
            ...FIXTURE_LITERATURE.metadata,
            title: "Unparsed source",
            identifiers: [],
          },
        }),
      );
      await server.application.maintenance!.ingestPdf({
        literature_id: FIXTURE_LITERATURE.literature_id,
        bytes: workbenchPdf(),
      });
      // Both papers are in hand: the library lists the collected papers
      // (ADR 0065 §2, page specs “文献库”).
      await server.application.database.collectLiteratures([
        FIXTURE_LITERATURE.literature_id,
        "00000000-0000-0000-0000-000000005101",
      ]);
      const context = await browser.newContext({
        ...motionOptions(),
        viewport: { width: 1280, height: 900 },
      });
      const page = await context.newPage();
      page.setDefaultTimeout(20_000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${PUBLIC_ORIGIN}/?view=lib`);
      expect(await page.locator("body").textContent()).toContain(
        "打开你的文献库",
      );
      await page.locator("#access-password").waitFor();
      expect(await page.evaluate(() => window.isSecureContext)).toBe(false);
      expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe(
        "undefined",
      );
      expect(await page.evaluate(() => typeof crypto.subtle)).toBe("undefined");
      await page.locator("#access-password").fill("incorrect");
      await page.locator("#login-submit").click();
      await expect
        .poll(() => page.locator("#login-error").textContent())
        .toContain("密码或 API key 不正确");
      await page.locator("#access-password").fill(PASSWORD);
      await page.getByRole("button", { name: "显示密码", exact: true }).click();
      expect(await page.locator("#access-password").getAttribute("type")).toBe(
        "text",
      );
      await page.locator("#login-submit").click();
      await showAllLibraryStatuses(page);
      await page.locator(".paper-row").first().waitFor();
      expect(new URL(page.url()).searchParams.get("view")).toBe("lib");
      expect(await page.evaluate(() => document.cookie)).not.toContain(
        "sr_auth",
      );
      await (await openSavedViews(page))
        .getByRole("menuitem", { name: "保存当前筛选…", exact: true })
        .click();
      const saved = page.getByRole("dialog", { name: "保存筛选", exact: true });
      await saved
        .getByRole("textbox", { name: "筛选名称", exact: true })
        .fill("HTTP saved view");
      await saved.getByRole("button", { name: "保存", exact: true }).click();
      await (await openSavedViews(page))
        .getByRole("menuitem", { name: "HTTP saved view", exact: true })
        .waitFor();
      await page.keyboard.press("Escape");
      // Fetch the PDF from the row menu of the paper that has none: a paper
      // with its PDF has no “获取 PDF” there (page specs “文献库”).
      const row = page.locator(".paper-row", { hasText: "Unparsed source" });
      await row.hover();
      await row.getByRole("button", { name: "文献操作", exact: true }).click();
      await page
        .getByRole("menuitem", { name: "获取 PDF", exact: true })
        .click();
      const acquire = page.getByRole("dialog", {
        name: "获取 PDF",
        exact: true,
      });
      await acquire
        .getByRole("button", { name: "高级选项", exact: true })
        .click();
      await acquire
        .getByRole("checkbox", { name: "保存后立即执行", exact: true })
        .focus();
      await page.keyboard.press("Space");
      await acquire.getByRole("button", { name: /^获取 \d+ 篇$/ }).click();
      await expect.poll(() => acquire.textContent()).toContain("任务已保存");
      await acquire.getByRole("button", { name: "关闭", exact: true }).click();
      await page.addScriptTag({ url: "/test-platform.js" });
      const copied = await page.evaluate(async () => {
        const platform = (
          window as unknown as {
            remotePlatform: {
              copyText(text: string): Promise<void>;
              randomId(): string;
            };
          }
        ).remotePlatform;
        let copied = false;
        const previous = document.execCommand.bind(document);
        document.execCommand = (command: string) => {
          copied =
            command === "copy" &&
            (document.activeElement as HTMLTextAreaElement).value ===
              "fixture context";
          return copied;
        };
        try {
          await platform.copyText("fixture context");
          return {
            copied,
            id: platform.randomId(),
            residual: document.querySelector(".clipboard-copy-source") !== null,
          };
        } finally {
          document.execCommand = previous;
        }
      });
      expect(copied.copied).toBe(true);
      expect(copied.residual).toBe(false);
      expect(copied.id).toMatch(/^[a-f0-9-]{36}$/u);
      await page
        .locator(".paper-row", { hasText: FIXTURE_LITERATURE.metadata.title! })
        .locator(".paper-open")
        .dblclick();
      // A paper with text opens its full text (spec 6.4); this check reads the PDF.
      await page.getByRole("tab", { name: "PDF", exact: true }).click();
      await page
        .locator('.reading-pdf-page[data-rendered="true"]')
        .first()
        .waitFor();
      expect(await page.locator(".textLayer").first().textContent()).toContain(
        "Synthetic",
      );
      // The reader page's navigation is in its drawer (reading-experience 1.3).
      await readerNavigation(page);
      await page.getByRole("button", { name: "设置", exact: true }).click();
      await page.getByRole("button", { name: "退出登录", exact: true }).click();
      await page.locator("#access-password").waitFor();
      expect(await server.application.jobs!.listJobs(10)).toHaveLength(1);
      await page.goto(`${PUBLIC_ORIGIN}/?view=task`);
      await page.locator("#access-password").waitFor();
      expect(await page.locator(".application-shell").count()).toBe(0);
      expect(errors).toEqual([]);
      await context.close();
    } finally {
      await browser.close();
      await server.close();
      proxy.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        proxy.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(home, { recursive: true, force: true });
    }
  }, 60000);
});
