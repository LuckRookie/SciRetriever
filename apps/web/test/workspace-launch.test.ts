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
import { initializeCatalogSchema } from "../../server/src/storage/sqlite/catalog-schema.js";
import { TypeScriptConfigurationOwner } from "../../server/src/configuration/owner.js";
import type { WorkbenchStaticAsset } from "../../server/src/workbench/http.js";

async function assets(): Promise<Map<string, WorkbenchStaticAsset>> {
  const result = new Map<string, WorkbenchStaticAsset>();
  for (const [route, file, contentType] of [
    ["/", "live.html", "text/html"],
    ["/styles.css", "styles.css", "text/css"],
    ["/live.css", "live.css", "text/css"],
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
  it("does not create a default database when the operator has not bound both paths", async () => {
    const home = await mkdtemp(
      join(tmpdir(), "sciretriever-web-unconfigured-"),
    );
    const failures: string[] = [];
    try {
      const result = await runCli(["web", "--port", "0"], {
        home,
        stderr: (value) => failures.push(value),
      });
      expect(result.code).toBe(4);
      expect(JSON.parse(failures[0]!)).toMatchObject({
        code: "paths-not-ready",
      });
      await expect(stat(join(home, "catalog.sqlite"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(stat(join(home, "artifacts"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
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

  it("launches the real CLI, imports into the configured library and keeps its binding fixed after path publication", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-web-launch-"));
    const catalog = join(home, "library.sqlite");
    const artifacts = join(home, "materials");
    await mkdir(join(home, ".sciretriever"), { mode: 0o700 });
    await writeFile(
      join(home, ".sciretriever", "config.toml"),
      `[paths]\ncatalog_path=${JSON.stringify(catalog)}\nartifact_root=${JSON.stringify(artifacts)}\n[sources.metadata]\nmode="custom"\nproviders=[]\n[sources.acquisition]\nmode="custom"\nproviders=[]\n`,
      { mode: 0o600 },
    );
    await initializeCatalogSchema(catalog);
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
      const page = await browser.newPage({
        viewport: { width: 1280, height: 900 },
      });
      const failures: string[] = [];
      page.on("pageerror", (error) => failures.push(error.message));
      await page.goto(address);
      await expect
        .poll(() => page.locator("#overview-active").textContent())
        .toContain("当前没有运行中的任务");
      expect(await page.locator("#workspace-binding").textContent()).toContain(
        catalog,
      );
      await page.locator("#library-tab").click();
      await page.locator("#library-intake > summary").click();
      await page.locator("#bibliography-file").setInputFiles({
        name: "fixture.bib",
        mimeType: "text/plain",
        buffer: Buffer.from(
          "@article{web-fixture, title={A synthetic Web workbench article}, author={Reader, Alice}, year={2026}, doi={10.5555/web.fixture}}",
        ),
      });
      await page
        .locator('#bibliography-import-form button[type="submit"]')
        .click();
      await expect
        .poll(() => page.locator("#bibliography-import-status").textContent())
        .toContain("1 条逐项回执");
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
      await expect(stat(nextCatalog)).rejects.toMatchObject({ code: "ENOENT" });
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
      await page.locator("#mobile-navigation").click();
      await page.locator("#overview-tab").click();
      expect(
        await page
          .locator("#workspace-navigation")
          .evaluate(
            (element) => element instanceof HTMLElement && element.inert,
          ),
      ).toBe(true);
      expect(await page.locator("#overview-workspace").isVisible()).toBe(true);
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
  }, 30_000);
});
