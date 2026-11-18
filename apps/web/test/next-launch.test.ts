import {
  openProcessingEntry,
  showAllLibraryStatuses,
} from "./next-workspace-fixture.js";
import { SCHEMA_VERSION } from "../../server/src/storage/sqlite/schema.js";
import { loginWorkbenchPage } from "../../server/test/workbench-auth-fixture.js";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../../server/src/cli/main.js";
import * as shippedAssets from "../../server/src/workbench/assets.js";
import {
  initializeCatalogSchema,
  inspectCatalogSchema,
} from "../../server/src/storage/sqlite/catalog-schema.js";
import { TypeScriptConfigurationOwner } from "../../server/src/configuration/owner.js";
import { motionOptions, nextAssets } from "./next-workspace-fixture.js";
import { importExport } from "./import-flow-fixture.js";

async function assets() {
  const result = new Map(await nextAssets());
  result.set("/", result.get("/")!);
  return result;
}

describe("formal Web launch and database binding", () => {
  it("rejects unsupported identities and invalid ports before starting a service", async () => {
    for (const args of [
      ["web", "--home", "/untrusted"],
      ["web", "--config", "other.toml"],
      ["web", "--port", "-1"],
      ["web", "--port", "65536"],
      ["web", "--port"],
    ]) {
      expect((await runCli(args)).code).toBe(2);
    }
  });

  it.each(["default", "configured"])(
    "launches Web with %s storage, imports literature and keeps the running binding fixed after path publication",
    async (mode) => {
      const home = await mkdtemp(join(tmpdir(), "sciretriever-web-launch-"));
      const catalog =
        mode === "default"
          ? join(home, ".sciretriever", "catalog.sqlite")
          : join(home, "library.sqlite");
      const artifacts =
        mode === "default"
          ? join(home, ".sciretriever", "artifacts")
          : join(home, "materials");
      if (mode === "configured") {
        await mkdir(join(home, ".sciretriever"), { mode: 0o700 });
        await writeFile(
          join(home, ".sciretriever", "config.toml"),
          `[paths]\ncatalog_path=${JSON.stringify(catalog)}\nartifact_root=${JSON.stringify(artifacts)}\n[sources.metadata]\nmode="custom"\nproviders=[]\n[sources.acquisition]\nmode="custom"\nproviders=[]\n`,
          { mode: 0o600 },
        );
        await initializeCatalogSchema(catalog);
      }
      const owner = new TypeScriptConfigurationOwner(home);
      const assetLoader = vi
        .spyOn(shippedAssets, "loadWorkbenchAssets")
        .mockResolvedValue(await assets());
      const stop = new AbortController();
      vi.stubEnv("SCIRETRIEVER_WEB_PASSWORD", undefined);
      let address = "";
      let apiKey = "";
      const errors: string[] = [];
      const running = runCli(["web", "--host", "127.0.0.1", "--port", "0"], {
        home,
        signal: stop.signal,
        stdout: (value) => {
          const startup = JSON.parse(value) as { url: string; api_key: string };
          address = startup.url;
          apiKey = startup.api_key;
        },
        stderr: (value) => errors.push(value),
      });
      const browser = await chromium.launch({
        ...(process.env.SCIRETRIEVER_BROWSER_EXECUTABLE
          ? { executablePath: process.env.SCIRETRIEVER_BROWSER_EXECUTABLE }
          : {}),
        headless: true,
      });
      try {
        // The CLI builds and opens the catalog first; under Full load that
        // takes longer than the default one-second poll window.
        await expect.poll(() => address, { timeout: 20000 }).not.toBe("");
        expect(await inspectCatalogSchema(catalog)).toMatchObject({
          status: "ready",
          schema_version: SCHEMA_VERSION,
        });
        expect((await owner.read()).configuration.paths).toEqual({
          catalog_path: catalog,
          artifact_root: artifacts,
        });
        const page = await browser.newPage({
          ...motionOptions(),
          viewport: { width: 1280, height: 900 },
        });
        page.setDefaultTimeout(20_000);
        const failures: string[] = [];
        page.on("pageerror", (error) => failures.push(error.message));
        await page.route("**/*", async (route) => {
          if (new URL(route.request().url()).origin === new URL(address).origin)
            await route.continue();
          else {
            failures.push("unexpected external browser request");
            await route.abort();
          }
        });
        await loginWorkbenchPage(page, new URL(address).origin, apiKey);
        await page.goto(address);
        await page
          .getByLabel("主导航")
          .getByRole("button", { name: /^文献库/ })
          .click();
        await expect
          .poll(() =>
            page.getByLabel("文献列表", { exact: true }).textContent(),
          )
          .toContain("没有符合条件的文献");
        // 入库 is in the sidebar; the library header has no button for it.
        await page
          .getByRole("complementary", { name: "主导航" })
          .getByRole("button", { name: "入库", exact: true })
          .click();
        const imported = await importExport(page, {
          name: "fixture.bib",
          content:
            "@article{web-fixture, title={A synthetic Web workbench article}, author={Reader, Alice}, year={2026}, doi={10.5555/web.fixture}}",
        });
        await imported.getByText("新增 1").waitFor();
        await page
          .getByLabel("主导航")
          .getByRole("button", { name: /^文献库/ })
          .click();
        await showAllLibraryStatuses(page);
        await expect
          .poll(() =>
            page.getByLabel("文献列表", { exact: true }).textContent(),
          )
          .toContain("A synthetic Web workbench article");
        await page
          .getByLabel("主导航")
          .getByRole("button", { name: "设置", exact: true })
          .click();
        await expect
          .poll(() =>
            page
              .getByRole("textbox", { name: "文献库文件", exact: true })
              .inputValue(),
          )
          .toBe(catalog);
        const nextCatalog = join(home, "other.sqlite");
        const nextArtifacts = join(home, "other-materials");
        await page
          .getByRole("textbox", { name: "文献库文件", exact: true })
          .fill(nextCatalog);
        await page
          .getByRole("textbox", { name: "文件存放位置", exact: true })
          .fill(nextArtifacts);
        await page
          .getByRole("button", { name: "保存文献库位置", exact: true })
          .click();
        await expect
          .poll(() => page.locator("main").textContent())
          .toContain("当前进程继续使用启动时的数据库");
        expect((await owner.read()).configuration.paths).toMatchObject({
          catalog_path: nextCatalog,
          artifact_root: nextArtifacts,
        });
        expect(await page.locator("main").textContent()).toContain(catalog);
        await expect(stat(nextCatalog)).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(stat(nextArtifacts)).rejects.toMatchObject({
          code: "ENOENT",
        });
        await page.reload();
        await expect
          .poll(() =>
            page
              .getByRole("textbox", { name: "文献库文件", exact: true })
              .inputValue(),
          )
          .toBe(nextCatalog);
        expect(await page.locator("main").textContent()).toContain(catalog);
        await page
          .getByLabel("主导航")
          .getByRole("button", { name: /^文献库/ })
          .click();
        await showAllLibraryStatuses(page);
        await expect
          .poll(() =>
            page.getByLabel("文献列表", { exact: true }).textContent(),
          )
          .toContain("A synthetic Web workbench article");
        for (const width of [1280, 850, 390]) {
          await page.setViewportSize({ width, height: 900 });
          const overflow = await page.evaluate(() =>
            [...document.querySelectorAll("body *")]
              .filter((el) => el.getBoundingClientRect().right > innerWidth + 1)
              .map((el) => ({
                tag: el.tagName,
                class: el.className,
                width: el.getBoundingClientRect().width,
                right: el.getBoundingClientRect().right,
              }))
              .slice(0, 15),
          );
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
            JSON.stringify({ width, overflow }),
          ).toBe(true);
        }
        await page
          .getByRole("button", { name: "打开导航", exact: true })
          .click();
        await openProcessingEntry(
          page.getByRole("dialog", { name: "导航", exact: true }),
          "快照",
        );
        await expect
          .poll(() =>
            page.getByRole("dialog", { name: "导航", exact: true }).count(),
          )
          .toBe(0);
        await expect
          .poll(() =>
            page
              .getByRole("heading", { name: "快照", exact: true })
              .isVisible(),
          )
          .toBe(true);
        expect(failures).toEqual([]);
      } finally {
        await browser.close();
        stop.abort();
        const result = await running;
        assetLoader.mockRestore();
        vi.unstubAllEnvs();
        await rm(home, { recursive: true, force: true });
        expect(result.code, errors.join("\n")).toBe(0);
      }
      await expect(fetch(address)).rejects.toThrow();
    },
    30_000,
  );
});
