import { parseLiterature, sha256 } from "@sciretriever/contracts";
import { FIXTURE_LITERATURE } from "../../server/src/workbench/synthetic-fixture.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { chromium, type Page } from "playwright";
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
        ["/workspace.css", "workspace.css", "text/css"],
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
        ...(process.env.SCIRETRIEVER_BROWSER_EXECUTABLE
          ? { executablePath: process.env.SCIRETRIEVER_BROWSER_EXECUTABLE }
          : {}),
        headless: true,
      });
      try {
        const context = await browser.newContext();
        const desktop = await context.newPage();
        const clickAcceptedAction = async (
          page: typeof desktop,
          name: string,
        ): Promise<void> => {
          for (let attempt = 0; attempt < 2; attempt++) {
            const before = workbench.session.view();
            const responsePromise = page.waitForResponse(
              (response) => new URL(response.url()).pathname === "/api/action",
            );
            await page.getByRole("button", { name, exact: true }).click();
            const response = await responsePromise;
            const command = response.request().postDataJSON() as {
              observation_revision: number;
              page_id: string;
              document_generation: number;
              control_epoch: number;
            };
            const result = (await response.json()) as {
              code?: string;
              result?: string;
            };
            const after = workbench.session.view();
            if (
              attempt === 0 &&
              response.status() === 409 &&
              result.code === "stale-command"
            ) {
              // Only a pre-dispatch stale rejection may be retried from a new observation.
              expect(after.observation?.remaining.actions).toBe(
                before.observation?.remaining.actions,
              );
              expect(after.candidates.length).toBe(before.candidates.length);
              expect(after.control.epoch).toBe(command.control_epoch);
              expect(after.observation?.page_id).toBe(command.page_id);
              expect(after.observation?.document_generation).toBe(
                command.document_generation,
              );
              expect(after.observation?.observation_revision).toBeGreaterThan(
                command.observation_revision,
              );
              const revision = after.observation!.observation_revision;
              await expect
                .poll(async () => {
                  const text = await page
                    .locator("#watch-observation")
                    .innerText();
                  const match = /^观察 (\d+) ·/u.exec(text);
                  return match ? Number(match[1]) : -1;
                })
                .toBeGreaterThanOrEqual(revision);
              continue;
            }
            expect({
              status: response.status(),
              result: result.result,
              code: result.code,
              requested_revision: command.observation_revision,
              current_revision: after.observation?.observation_revision,
              candidates: after.candidates.length,
            }).toMatchObject({ status: 200, result: "applied" });
            return;
          }
        };
        const openWatch = async (page: Page) => {
          await page.locator("[data-session]").first().click();
          await page.getByText("页面文字与可选指导", { exact: true }).click();
          await page
            .locator(".watch summary")
            .filter({ hasText: "下载与接纳" })
            .click();
        };
        await desktop.setViewportSize({ width: 1440, height: 1000 });
        const errors: string[] = [];
        desktop.on("pageerror", (error) => errors.push(error.message));
        await desktop.goto(`${workbench.origin}/?workspace=browser`);
        await openWatch(desktop);
        await desktop.waitForFunction(
          () =>
            document.querySelector<HTMLImageElement>("#browser-frame")
              ?.naturalWidth,
        );
        await desktop
          .getByRole("button", { name: "人工接管", exact: true })
          .click();
        await expect
          .poll(() => desktop.locator("#watch-control").innerText())
          .toBe("你正在操作 · Agent 已暂停");
        await clickAcceptedAction(desktop, "Download PDF");
        await expect
          .poll(() => desktop.locator("#watch-candidate-count").innerText(), {
            timeout: 15000,
          })
          .toBe("1");
        expect(
          await desktop.locator("#watch-candidates").innerText(),
        ).toContain("文件检查已通过，文章身份未验证");
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
          .poll(() => desktop.locator("#watch-candidates").innerText())
          .toContain("已发布到当前文献");
        await expect
          .poll(() => desktop.locator("#watch-observation").innerText())
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
        await clickAcceptedAction(desktop, "Capture response PDF");
        await expect
          .poll(() => desktop.locator("#watch-candidate-count").innerText(), {
            timeout: 15000,
          })
          .toBe("2");
        const mobile = await context.newPage();
        await mobile.setViewportSize({ width: 390, height: 844 });
        mobile.on("pageerror", (error) => errors.push(error.message));
        await mobile.goto(`${workbench.origin}/?workspace=browser`);
        await openWatch(mobile);
        await mobile.waitForFunction(
          () =>
            document.querySelector<HTMLImageElement>("#browser-frame")
              ?.naturalWidth,
        );
        await mobile
          .getByRole("button", { name: "人工接管", exact: true })
          .click();
        await expect
          .poll(() => desktop.locator("#watch-control").innerText())
          .toBe("另一个操作者正在控制");
        expect(
          await desktop
            .getByRole("button", { name: "Download PDF", exact: true })
            .isDisabled(),
        ).toBe(true);
        await expect
          .poll(() => mobile.locator("#watch-observation").innerText())
          .toContain("已捕获候选 PDF");
        await clickAcceptedAction(mobile, "Unverified PDF");
        await expect
          .poll(() => mobile.locator("#watch-candidate-count").innerText(), {
            timeout: 15000,
          })
          .toBe("3");
        const unverified = workbench.session.view().candidates.at(-1)!;
        expect(unverified.disposition).toBe("accepted");
        await mobile
          .getByRole("button", { name: "放弃候选", exact: true })
          .last()
          .click();
        await expect
          .poll(() => mobile.locator("#watch-candidate-count").innerText())
          .toBe("2");
        expect(
          await workbench.application.execution!.transfers.recover(
            unverified.transfer_id,
          ),
        ).toBeNull();
        expect(await mobile.getByRole("dialog").isVisible()).toBe(true);
        expect(await mobile.locator("#watch-candidates").innerText()).toContain(
          candidate.sha256.slice(0, 16),
        );
        await mobile.keyboard.press("Escape");
        await expect.poll(() => mobile.locator(".watch").count()).toBe(0);
        await openWatch(mobile);
        await mobile
          .getByRole("button", { name: "人工接管", exact: true })
          .click();
        expect(
          await mobile.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await mobile.getByRole("button", { name: "暂停", exact: true }).click();
        await expect
          .poll(() => mobile.locator("#watch-state").innerText())
          .toBe("已暂停");
        await mobile
          .getByRole("button", { name: "继续会话", exact: true })
          .click();
        await mobile
          .getByRole("button", { name: "取消会话", exact: true })
          .click();
        await expect
          .poll(() => mobile.locator("#watch-state").innerText())
          .toContain("已取消");
        expect(workbench.session.view().candidates).toHaveLength(2);
        await workbench.close();
        workbench = await start();
        expect(workbench.session.view().candidates).toHaveLength(2);
        expect(
          workbench.session
            .view()
            .candidates.filter((item) => item.publication),
        ).toHaveLength(1);
        await desktop.goto(`${workbench.origin}/?workspace=browser`);
        await openWatch(desktop);
        await expect
          .poll(() => desktop.locator("#watch-candidate-count").innerText())
          .toBe("2");
        await desktop
          .getByRole("button", { name: "人工接管", exact: true })
          .click();
        await desktop
          .locator("#watch-candidates .browser-candidate")
          .filter({ hasText: "文件检查已通过，文章身份未验证" })
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
        for (let n = 0; n < 53; n++)
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
        await desktop.keyboard.press("Escape");
        await expect.poll(() => desktop.locator(".watch").count()).toBe(0);
        await desktop.locator("#library-tab").click();
        await desktop.locator("#q").fill("QueryBank");

        await expect
          .poll(() => desktop.locator("#library-status").innerText())
          .toContain("53 篇");
        expect(await desktop.locator(".prow").count()).toBe(50);
        await desktop.locator("#library-more").click();
        await expect.poll(() => desktop.locator(".prow").count()).toBe(53);
        await desktop
          .locator('[data-id="10000000-0000-0000-0000-000000000000"]')
          .click();
        await expect
          .poll(() => desktop.locator("#reader-info h2").innerText())
          .toContain("<img src=x onerror=alert(1)>");
        expect(await desktop.locator("#reader-info img").count()).toBe(0);
        await desktop.locator("#library-tab").click();
        await desktop.locator("#q").fill("Synthetic literature");

        await expect.poll(() => desktop.locator(".prow").count()).toBe(1);
        await desktop.locator(".prow").click();
        const downloading = desktop.waitForEvent("download");
        await desktop
          .getByRole("link", { name: "下载已核验的原始 PDF", exact: true })
          .click();
        const download = await downloading;
        expect(await sha256(await readFile((await download.path())!))).toBe(
          candidate.sha256,
        );
        await desktop.screenshot({
          path: "/tmp/sciretriever-library-desktop.png",
        });
        await mobile.goto(`${workbench.origin}/?workspace=browser`);
        await openWatch(mobile);
        await mobile.locator("#watch-close").click();
        await mobile.locator("#menuBtn").click();
        await mobile.locator("#library-tab").click();
        expect(new URL(mobile.url()).searchParams.get("view")).toBe("lib");
        expect(
          await mobile
            .locator("#side")
            .evaluate((element) => element.classList.contains("open")),
        ).toBe(false);
        await mobile.locator("#q").fill("Synthetic literature");

        await expect.poll(() => mobile.locator(".prow").count()).toBe(1);
        await mobile.locator(".prow").click();
        await expect
          .poll(() => mobile.locator("#reader-info h2").innerText())
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
