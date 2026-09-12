import { parseLiterature, sha256 } from "@sciretriever/contracts";
import { FIXTURE_LITERATURE } from "../../server/src/workbench/synthetic-fixture.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import { startSyntheticWorkbench } from "../../server/src/bootstrap/workbench.js";
import { verifyInstalledCloakRuntime } from "../../server/src/configuration/cloak-runtime.js";
import { TypeScriptConfigurationOwner } from "../../server/src/configuration/owner.js";
import type { WorkbenchStaticAsset } from "../../server/src/workbench/http.js";
const bundle = process.env.SCIRETRIEVER_CLOAK_BUNDLE;

describe("live workbench on the installed Cloak runtime", () => {
  it.skipIf(!bundle)(
    "streams real frames to two viewers, captures a durable PDF, rejects the old controller, and remains operable at 390px",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "sciretriever-live-ui-"));
      const assets = new Map<string, WorkbenchStaticAsset>();
      for (const [route, file, contentType] of [
        ["/", "live.html", "text/html"],
        ["/styles.css", "styles.css", "text/css"],
        ["/live.css", "live.css", "text/css"],
      ] as const)
        assets.set(route, {
          contentType,
          body: await readFile(new URL(`../public/${file}`, import.meta.url)),
        });
      const bundled = await build({
        entryPoints: [new URL("../src/live.ts", import.meta.url).pathname],
        bundle: true,
        format: "esm",
        platform: "browser",
        write: false,
      });
      assets.set("/live.js", {
        contentType: "text/javascript",
        body: bundled.outputFiles[0]!.contents,
      });
      const runtime = await verifyInstalledCloakRuntime(bundle!);
      const start = () =>
        startSyntheticWorkbench({
          home,
          runtime,
          assets,
          configurationOwner: new TypeScriptConfigurationOwner(home),
        });
      let workbench = await start();
      const browser = await chromium.launch({
        executablePath:
          process.env.SCIRETRIEVER_BROWSER_EXECUTABLE ??
          "/home/duanjw/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome",
        headless: true,
      });
      try {
        const context = await browser.newContext();
        const desktop = await context.newPage();
        await desktop.setViewportSize({ width: 1440, height: 1000 });
        const errors: string[] = [];
        desktop.on("pageerror", (error) => errors.push(error.message));
        await desktop.goto(workbench.origin);
        await desktop.waitForFunction(
          () =>
            document.querySelector<HTMLImageElement>("#browser-frame")
              ?.naturalWidth,
        );
        await desktop
          .getByRole("button", { name: "人工接管", exact: true })
          .click();
        await expect
          .poll(() => desktop.locator("#owner").innerText())
          .toBe("你正在控制页面");
        await desktop
          .getByRole("button", { name: "Download PDF", exact: true })
          .click();
        await expect
          .poll(() => desktop.locator("#candidate-count").innerText(), {
            timeout: 15000,
          })
          .toBe("1");
        expect(await desktop.locator("#candidates").innerText()).toContain(
          "身份与版本已核验",
        );
        const candidate = workbench.session.view().candidates[0]!;
        expect(
          await workbench.application.execution!.transfers.recover(
            candidate.transfer_id,
          ),
        ).toMatchObject({ state: "durable-ready", sha256: candidate.sha256 });
        await desktop
          .getByRole("button", { name: "发布到当前文献", exact: true })
          .click();
        await expect
          .poll(() => desktop.locator("#candidates").innerText())
          .toContain("已发布到当前文献");
        await expect
          .poll(() => desktop.locator("#observation-info").innerText())
          .toContain("已捕获候选 PDF");
        const published = workbench.session.view().candidates[0]!.publication!;
        expect(published.sha256).toBe(candidate.sha256);
        expect(
          (
            await workbench.application.database.currentFacts(
              workbench.session.articleId,
            )
          )?.literature.status,
        ).toBe("ASSET_READY");
        expect(
          (
            await workbench.application.files.read(
              published.reference,
              candidate.size_bytes,
            )
          ).length,
        ).toBe(candidate.size_bytes);
        await desktop
          .getByRole("button", { name: "Capture response PDF", exact: true })
          .click();
        await expect
          .poll(() => desktop.locator("#candidate-count").innerText(), {
            timeout: 15000,
          })
          .toBe("2");
        const mobile = await context.newPage();
        await mobile.setViewportSize({ width: 390, height: 844 });
        mobile.on("pageerror", (error) => errors.push(error.message));
        await mobile.goto(workbench.origin);
        await mobile.waitForFunction(
          () =>
            document.querySelector<HTMLImageElement>("#browser-frame")
              ?.naturalWidth,
        );
        await mobile
          .getByRole("button", { name: "人工接管", exact: true })
          .click();
        await expect
          .poll(() => desktop.locator("#owner").innerText())
          .toBe("另一个操作者正在控制");
        expect(
          await desktop
            .getByRole("button", { name: "Download PDF", exact: true })
            .isDisabled(),
        ).toBe(true);
        await expect
          .poll(() => mobile.locator("#observation-info").innerText())
          .toContain("已捕获候选 PDF");
        await mobile
          .getByRole("button", { name: "会话详情", exact: false })
          .click();
        await mobile
          .getByRole("button", { name: "Uncertain PDF", exact: true })
          .click();
        await expect
          .poll(() => mobile.locator("#candidate-count").innerText(), {
            timeout: 15000,
          })
          .toBe("3");
        const uncertain = workbench.session
          .view()
          .candidates.find((item) => item.disposition === "uncertain")!;
        expect(uncertain).toBeDefined();
        await mobile
          .getByRole("button", { name: "放弃候选", exact: true })
          .last()
          .click();
        await expect
          .poll(() => mobile.locator("#candidate-count").innerText())
          .toBe("2");
        expect(
          await workbench.application.execution!.transfers.recover(
            uncertain.transfer_id,
          ),
        ).toBeNull();
        expect(await mobile.getByRole("dialog").isVisible()).toBe(true);
        expect(await mobile.locator("#candidates").innerText()).toContain(
          candidate.sha256.slice(0, 16),
        );
        await mobile.keyboard.press("Escape");
        expect(
          await mobile
            .locator("#open-details")
            .evaluate((element) => element === document.activeElement),
        ).toBe(true);
        expect(
          await mobile.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await mobile.getByRole("button", { name: "暂停", exact: true }).click();
        await expect
          .poll(() => mobile.locator("#session-status").innerText())
          .toBe("会话已暂停");
        await mobile
          .getByRole("button", { name: "继续会话", exact: true })
          .click();
        await mobile
          .getByRole("button", { name: "取消会话", exact: true })
          .click();
        await expect
          .poll(() => mobile.locator("#session-status").innerText())
          .toContain("会话已取消");
        expect(workbench.session.view().candidates).toHaveLength(2);
        await workbench.close();
        workbench = await start();
        expect(workbench.session.view().candidates).toHaveLength(2);
        expect(
          workbench.session
            .view()
            .candidates.filter((item) => item.publication),
        ).toHaveLength(1);
        await desktop.goto(workbench.origin);
        await expect
          .poll(() => desktop.locator("#candidate-count").innerText())
          .toBe("2");
        await desktop
          .getByRole("button", { name: "人工接管", exact: true })
          .click();
        await desktop
          .getByRole("button", { name: "发布到当前文献", exact: true })
          .click();
        await expect
          .poll(
            () =>
              workbench.session
                .view()
                .candidates.filter((item) => item.publication).length,
          )
          .toBe(2);
        expect(
          (await workbench.application.database.snapshotCounts()).tables,
        ).toMatchObject({ assets: 1, literature_assets: 1 });
        for (let n = 0; n < 28; n++)
          await workbench.application.database.putLiterature(
            parseLiterature({
              ...FIXTURE_LITERATURE,
              literature_id: `10000000-0000-0000-0000-${String(n).padStart(12, "0")}`,
              meta_literature_id: `20000000-0000-0000-0000-${String(n).padStart(12, "0")}`,
              metadata: {
                ...FIXTURE_LITERATURE.metadata,
                title:
                  n === 0
                    ? "QueryBank <img src=x onerror=alert(1)>"
                    : `QueryBank paper ${n}`,
                abstract: "Local library query fixture.",
              },
            }),
          );
        await desktop.locator("#library-tab").click();
        await desktop.locator("#library-query").fill("QueryBank");
        await desktop
          .locator("#library-form")
          .getByRole("button", { name: "搜索", exact: true })
          .click();
        await expect
          .poll(() => desktop.locator("#library-status").innerText())
          .toBe("找到 28 篇文献");
        expect(await desktop.locator(".library-result").count()).toBe(25);
        await desktop.locator("#library-more").click();
        await expect
          .poll(() => desktop.locator(".library-result").count())
          .toBe(28);
        await desktop
          .locator(
            '[data-literature-id="10000000-0000-0000-0000-000000000000"]',
          )
          .click();
        await expect
          .poll(() => desktop.locator("#library-detail h2").innerText())
          .toContain("<img src=x onerror=alert(1)>");
        expect(await desktop.locator("#library-detail img").count()).toBe(0);
        await desktop.locator("#library-query").fill("Synthetic literature");
        await desktop
          .locator("#library-form")
          .getByRole("button", { name: "搜索", exact: true })
          .click();
        await expect
          .poll(() => desktop.locator(".library-result").count())
          .toBe(1);
        await desktop.locator(".library-result").click();
        const downloading = desktop.waitForEvent("download");
        await desktop
          .getByRole("button", { name: "下载 PDF", exact: true })
          .click();
        const download = await downloading;
        expect(await sha256(await readFile((await download.path())!))).toBe(
          candidate.sha256,
        );
        await desktop.screenshot({
          path: "/tmp/sciretriever-library-desktop.png",
        });
        await mobile.goto(workbench.origin);
        await mobile.locator("#library-toggle").click();
        await mobile.locator("#library-query").fill("Synthetic literature");
        await mobile
          .locator("#library-form")
          .getByRole("button", { name: "搜索", exact: true })
          .click();
        await expect
          .poll(() => mobile.locator(".library-result").count())
          .toBe(1);
        await mobile.locator(".library-result").click();
        await expect
          .poll(() => mobile.locator("#library-detail h2").innerText())
          .toBe(FIXTURE_LITERATURE.metadata.title);
        expect(
          await mobile.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await mobile.screenshot({
          path: "/tmp/sciretriever-library-mobile.png",
          fullPage: true,
        });
        expect(errors).toEqual([]);
      } finally {
        await browser.close();
        await workbench.close();
        await rm(home, { recursive: true, force: true });
      }
    },
    90000,
  );
});
