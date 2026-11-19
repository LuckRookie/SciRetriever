import {
  workbenchTestAccess,
  loginWorkbenchPage,
} from "../../server/test/workbench-auth-fixture.js";
import { parseLiterature, sha256 } from "@sciretriever/contracts";
import {
  FIXTURE_LITERATURE,
  FIXTURE_TITLE,
} from "../../server/src/workbench/synthetic-fixture.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextAssets, motionOptions } from "./next-workspace-fixture.js";
import { readerToLibrary } from "./reader-controls.js";
import { readingAssets } from "./reading-assets-fixture.js";
import { chromium, type Page } from "playwright";
import { describe, expect, it } from "vitest";
import { startSyntheticWorkbench } from "../../server/src/bootstrap/workbench.js";
import { verifyInstalledCloakRuntime } from "../../server/src/configuration/cloak-runtime.js";
import { TypeScriptConfigurationOwner } from "../../server/src/configuration/owner.js";
const bundle = process.env.SCIRETRIEVER_CLOAK_BUNDLE;

describe("live workbench on the installed Cloak runtime", () => {
  it.skipIf(!bundle)(
    "streams real frames to two viewers, captures a durable PDF, rejects the old controller, and remains operable at 390px",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "sciretriever-live-ui-"));
      const assets = new Map([
        ...(await readingAssets()),
        ...(await nextAssets()),
      ]);
      const runtime = await verifyInstalledCloakRuntime(bundle!);
      const start = () =>
        startSyntheticWorkbench({
          access: workbenchTestAccess,
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
        const context = await browser.newContext(motionOptions());
        const desktop = await context.newPage();
        desktop.setDefaultTimeout(20_000);
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
                  return Number(
                    await page
                      .locator(".browser-watch-header")
                      .getAttribute("data-observation-revision"),
                  );
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
          await page
            .locator("[data-session]")
            .first()
            .getByRole("button", { name: "观看 Agent", exact: true })
            .click();
          await page
            .getByRole("button", { name: "更多操作", exact: true })
            .click();
          await page.getByRole("button", { name: /下载与接纳 ·/ }).click();
        };
        await desktop.setViewportSize({ width: 1440, height: 1000 });
        const errors: string[] = [];
        desktop.on("pageerror", (error) => errors.push(error.message));
        await loginWorkbenchPage(desktop, workbench.origin);
        await desktop.goto(`${workbench.origin}/?view=web`);
        await openWatch(desktop);
        // Viewing never observes (ADR 0042); the Agent's observation is what lists the
        // page's links and buttons, so take one here as the Agent would.
        await workbench.session.refresh();
        await desktop.waitForFunction(
          () =>
            // The live picture, and the Agent's first observation of the same page.
            document.querySelector(".browser-frame-wrap[data-painted]") &&
            document.querySelector(".browser-document-title")?.textContent !==
              "等待当前页面",
        );
        await desktop
          .getByRole("button", { name: "暂停 Agent", exact: true })
          .click();
        await expect
          .poll(() => desktop.locator(".browser-control-note").innerText(), {
            timeout: 20_000,
          })
          .toContain("你在操作 · Agent 已暂停");
        await clickAcceptedAction(desktop, "Download PDF");
        await expect
          .poll(
            () =>
              desktop.getByRole("button", { name: /下载与接纳 ·/ }).innerText(),
            {
              timeout: 20_000,
            },
          )
          .toContain("· 1");
        expect(await desktop.locator(".browser-log").innerText()).toContain(
          "文件检查已通过，文章身份未验证",
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
          .poll(() => desktop.locator(".browser-log").innerText())
          .toContain("已发布到当前文献");
        await expect
          .poll(() => desktop.locator(".browser-log").innerText())
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
          .poll(
            () =>
              desktop.getByRole("button", { name: /下载与接纳 ·/ }).innerText(),
            {
              timeout: 20_000,
            },
          )
          .toContain("· 2");
        // The desktop keeps working on the page while the second window opens: its
        // moves hold the idle hand-back, so the takeover is taken from an active controller.
        const desktopCanvas = desktop.locator("canvas.browser-frame");
        let step = 0;
        const working = setInterval(() => {
          step = (step + 1) % 2;
          // hover scrolls the picture into view; the dialog may have scrolled it off.
          void desktopCanvas
            .hover({ position: { x: 20 + step * 4, y: 20 }, timeout: 900 })
            .catch(() => undefined);
        }, 1000);
        const mobile = await context.newPage();
        mobile.setDefaultTimeout(20_000);
        await mobile.setViewportSize({ width: 390, height: 844 });
        mobile.on("pageerror", (error) => errors.push(error.message));
        // Both pages share one authenticated browser session; re-login revokes its existing grants.
        await mobile.goto(`${workbench.origin}/?view=web`);
        await openWatch(mobile);
        await mobile.waitForFunction(() =>
          document.querySelector(".browser-frame-wrap[data-painted]"),
        );
        clearInterval(working);
        await mobile
          .getByRole("button", { name: "暂停 Agent", exact: true })
          .click();
        await expect
          .poll(() => desktop.locator(".browser-control-note").innerText(), {
            timeout: 20_000,
          })
          .toBe("另一个窗口正在操作");
        // A fresh observation lists the page's buttons again in both windows.
        await workbench.session.refresh();
        await desktop
          .getByRole("button", { name: "Download PDF", exact: true })
          .waitFor();
        expect(
          await desktop
            .getByRole("button", { name: "Download PDF", exact: true })
            .isDisabled(),
        ).toBe(true);
        await expect
          .poll(() => mobile.locator(".browser-log").innerText())
          .toContain("已捕获候选 PDF");
        await clickAcceptedAction(mobile, "Unverified PDF");
        await expect
          .poll(
            () =>
              mobile.getByRole("button", { name: /下载与接纳 ·/ }).innerText(),
            {
              timeout: 20_000,
            },
          )
          .toContain("· 3");
        const unverified = workbench.session.view().candidates.at(-1)!;
        expect(unverified.disposition).toBe("accepted");
        await mobile
          .getByRole("button", { name: "放弃候选", exact: true })
          .last()
          .click();
        await expect
          .poll(() =>
            mobile.getByRole("button", { name: /下载与接纳 ·/ }).innerText(),
          )
          .toContain("· 2");
        expect(
          await workbench.application.execution!.transfers.recover(
            unverified.transfer_id,
          ),
        ).toBeNull();
        expect(await mobile.getByRole("dialog").isVisible()).toBe(true);
        await mobile
          .locator(".browser-log .ui-card")
          .first()
          .getByRole("button", { name: "技术详情", exact: true })
          .click();
        expect(await mobile.locator(".browser-log").innerText()).toContain(
          candidate.sha256,
        );

        await mobile.keyboard.press("Escape");
        await expect
          .poll(() => mobile.locator(".browser-watch").count())
          .toBe(0);
        await openWatch(mobile);
        await mobile
          .getByRole("button", { name: "暂停 Agent", exact: true })
          .click();
        expect(
          await mobile.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await mobile
          .getByRole("button", { name: "暂停会话", exact: true })
          .click();
        await expect
          .poll(() => mobile.locator(".browser-log").innerText())
          .toContain("已暂停");
        await mobile
          .getByRole("button", { name: "继续会话", exact: true })
          .click();
        await mobile
          .getByRole("button", { name: "取消会话", exact: true })
          .click();
        await mobile
          .getByRole("dialog", { name: "取消当前浏览器会话？", exact: true })
          .getByRole("button", { name: "取消会话", exact: true })
          .click();
        await expect
          .poll(() => mobile.locator(".browser-log").innerText())
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
        await loginWorkbenchPage(desktop, workbench.origin);
        await desktop.goto(`${workbench.origin}/?view=web`);
        await openWatch(desktop);
        await expect
          .poll(() =>
            desktop.getByRole("button", { name: /下载与接纳 ·/ }).innerText(),
          )
          .toContain("· 2");
        await desktop
          .getByRole("button", { name: "暂停 Agent", exact: true })
          .click();
        await desktop
          .locator(".browser-log .ui-card")
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
        await desktop
          .getByRole("button", { name: "返回会话列表", exact: true })
          .click();
        await expect
          .poll(() => desktop.locator(".browser-watch").count())
          .toBe(0);
        await desktop
          .getByLabel("主导航", { exact: true })
          .getByRole("button", { name: /文献库/ })
          .click();
        await desktop
          .getByRole("searchbox", { name: "搜索文献", exact: true })
          .fill("QueryBank");
        // The count is said once, beside the title (page specs “文献库”).
        await expect
          .poll(() => desktop.locator(".ui-page-count").innerText(), {
            timeout: 20_000,
          })
          .toMatch(/^符合 53 篇 \/ 共 [\d,]+ 篇$/u);
        const loaded = () =>
          desktop.locator(".library-scroll").getAttribute("data-loaded");
        await expect.poll(loaded, { timeout: 20_000 }).toBe("50");
        // The library scrolls with the page; the main container owns scrollTop.
        await desktop.locator(".workspace-content").evaluate(async (el) => {
          // Data and the virtualizer's measured scroll range settle separately.
          // Wait for layout before scrolling to the new result set's bottom.
          await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
          el.scrollTop = el.scrollHeight;
        });
        await expect.poll(loaded, { timeout: 20_000 }).toBe("53");
        expect(await desktop.locator(".paper-row").count()).toBeLessThan(53);
        await desktop.locator(".workspace-content").evaluate((el) => {
          el.scrollTop = 0;
        });
        await desktop
          .getByRole("searchbox", { name: "搜索文献", exact: true })
          .fill("QueryBank <img");
        await desktop
          .getByRole("article", {
            name: "QueryBank <img src=x onerror=alert(1)>",
            exact: true,
          })
          .locator(".paper-open")
          .click();
        await expect
          .poll(() => desktop.locator(".paper-tab[data-selected]").innerText())
          .toContain("<img src=x onerror=alert(1)>");
        expect(
          await desktop
            .locator(
              ".paper-tab[data-selected] img, .reading-article img, .reader-information img",
            )
            .count(),
        ).toBe(0);
        // The reader page has no site sidebar: the library is in its navigation drawer.
        await readerToLibrary(desktop);
        await desktop
          .getByRole("searchbox", { name: "搜索文献", exact: true })
          .fill("Synthetic literature");
        // The previous search also had one row; wait for the new result itself.
        await desktop
          .getByRole("article", { name: FIXTURE_TITLE, exact: true })
          .locator(".paper-open")
          .click();
        // A paper with text opens its full text (spec 6.4); this check reads the PDF.
        await desktop.getByRole("tab", { name: "PDF", exact: true }).click();
        await desktop
          .locator('.reading-pdf-page[data-rendered="true"]')
          .first()
          .waitFor();
        await desktop
          .getByRole("button", { name: "更多", exact: true })
          .click();
        const downloading = desktop.waitForEvent("download");
        await desktop
          .getByRole("menuitem", { name: "下载 PDF", exact: true })
          .click();
        const download = await downloading;
        expect(await sha256(await readFile((await download.path())!))).toBe(
          candidate.sha256,
        );
        // Both pages share one authenticated browser session; re-login revokes its existing grants.
        await mobile.goto(`${workbench.origin}/?view=web`);
        await openWatch(mobile);
        await mobile
          .getByRole("button", { name: "返回会话列表", exact: true })
          .click();
        await mobile
          .getByRole("button", { name: "打开导航", exact: true })
          .click();
        await mobile
          .getByRole("dialog", { name: "导航", exact: true })
          .getByRole("button", { name: /文献库/ })
          .click();
        expect(new URL(mobile.url()).searchParams.get("view")).toBe("lib");
        await mobile
          .getByRole("dialog", { name: "导航", exact: true })
          .waitFor({ state: "hidden" });
        await mobile
          .getByRole("searchbox", { name: "搜索文献", exact: true })
          .fill("Synthetic literature");
        await expect.poll(() => mobile.locator(".paper-row").count()).toBe(1);
        await mobile.locator(".paper-open").click();
        await mobile.getByRole("tab", { name: "PDF", exact: true }).click();
        await mobile
          .locator('.reading-pdf-page[data-rendered="true"]')
          .first()
          .waitFor();
        expect(new URL(mobile.url()).searchParams.get("literature")).toBe(
          FIXTURE_LITERATURE.literature_id,
        );
        expect(
          await mobile.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        expect(errors).toEqual([]);
      } finally {
        await browser.close();
        await workbench.close();
        await rm(home, { recursive: true, force: true });
      }
    },
    120000,
  );
});
