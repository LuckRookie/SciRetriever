import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../../server/src/cli/main.js";
import * as shippedAssets from "../../server/src/workbench/assets.js";
import {
  initializeCatalogSchema,
  inspectCatalogSchema,
} from "../../server/src/storage/sqlite/catalog-schema.js";
import { TypeScriptConfigurationOwner } from "../../server/src/configuration/owner.js";
import type { WorkbenchStaticAsset } from "../../server/src/workbench/http.js";

async function assets(): Promise<Map<string, WorkbenchStaticAsset>> {
  const result = new Map<string, WorkbenchStaticAsset>();
  for (const [route, file, contentType] of [
    ["/", "live.html", "text/html"],
    ["/styles.css", "styles.css", "text/css"],
    ["/live.css", "live.css", "text/css"],
    ["/workspace.css", "workspace.css", "text/css"],
  ] as const)
    result.set(route, {
      contentType,
      body: await readFile(new URL(`../public/${file}`, import.meta.url)),
    });
  const script = await build({
    entryPoints: [new URL("../src/live.ts", import.meta.url).pathname],
    bundle: true,
    platform: "browser",
    format: "esm",
    write: false,
  });
  result.set("/live.js", {
    contentType: "text/javascript",
    body: script.outputFiles[0]!.contents,
  });
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
      let address = "";
      const errors: string[] = [];
      const running = runCli(["web", "--port", "0"], {
        home,
        signal: stop.signal,
        stdout: (value) => {
          address = (JSON.parse(value) as { url: string }).url;
        },
        stderr: (value) => errors.push(value),
      });
      const browser = await chromium.launch({
        executablePath:
          process.env.SCIRETRIEVER_BROWSER_EXECUTABLE ??
          "/home/duanjw/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome",
        headless: true,
      });
      try {
        await expect.poll(() => address).not.toBe("");
        expect(await inspectCatalogSchema(catalog)).toMatchObject({
          status: "ready",
          schema_version: 10,
        });
        expect((await owner.read()).configuration.paths).toEqual({
          catalog_path: catalog,
          artifact_root: artifacts,
        });
        const page = await browser.newPage({
          viewport: { width: 1280, height: 900 },
        });
        page.setDefaultTimeout(5000);
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
        await page.goto(address);
        await page.locator("#library-tab").click();
        await expect
          .poll(() => page.locator("#library-results").textContent())
          .toContain("没有符合条件的文献");
        await page.locator('[data-go="disc"]').click();
        await page.locator('[data-dm="bib"]').click();
        await page.locator("#bibliography-file").setInputFiles({
          name: "fixture.bib",
          mimeType: "text/plain",
          buffer: Buffer.from(
            "@article{web-fixture, title={A synthetic Web workbench article}, author={Reader, Alice}, year={2026}, doi={10.5555/web.fixture}}",
          ),
        });
        await page.locator('#discovery-form button[type="submit"]').click();
        await expect
          .poll(() => page.locator("#intake-status").textContent())
          .toContain("操作已结束");
        await page.locator("#library-tab").click();
        await expect
          .poll(() => page.locator("#library-results").textContent())
          .toContain("A synthetic Web workbench article");
        await page.locator("#config-tab").click();
        await expect
          .poll(() => page.locator("#config-catalog-path").inputValue())
          .toBe(catalog);
        const nextCatalog = join(home, "other.sqlite");
        const nextArtifacts = join(home, "other-materials");
        await page.locator("#config-catalog-path").fill(nextCatalog);
        await page.locator("#config-artifact-root").fill(nextArtifacts);
        await page.locator("#paths-config-save").click();
        await expect
          .poll(() => page.locator("#config-page-status").textContent())
          .toContain("当前进程继续使用启动时的数据库");
        expect((await owner.read()).configuration.paths).toMatchObject({
          catalog_path: nextCatalog,
          artifact_root: nextArtifacts,
        });
        expect(
          await page.locator("#current-database-binding").textContent(),
        ).toContain(catalog);
        await expect(stat(nextCatalog)).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(stat(nextArtifacts)).rejects.toMatchObject({
          code: "ENOENT",
        });
        await page.reload();
        await expect
          .poll(() => page.locator("#config-catalog-path").inputValue())
          .toBe(nextCatalog);
        expect(
          await page.locator("#current-database-binding").textContent(),
        ).toContain(catalog);
        await page.locator("#library-tab").click();
        await expect
          .poll(() => page.locator("#library-results").textContent())
          .toContain("A synthetic Web workbench article");
        for (const width of [1280, 850, 390]) {
          await page.setViewportSize({ width, height: 900 });
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          ).toBe(true);
        }
        await page.locator("#menuBtn").click();
        await page.locator('[data-go="disc"]').click();
        expect(
          await page
            .locator("#side")
            .evaluate((element) => element.classList.contains("open")),
        ).toBe(false);
        expect(await page.locator('[data-page="disc"]').isVisible()).toBe(true);
        expect(failures).toEqual([]);
      } finally {
        await browser.close();
        stop.abort();
        const result = await running;
        assetLoader.mockRestore();
        await rm(home, { recursive: true, force: true });
        expect(result.code, errors.join("\n")).toBe(0);
      }
      await expect(fetch(address)).rejects.toThrow();
    },
    30_000,
  );
});
