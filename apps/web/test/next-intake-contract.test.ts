import { expect, it } from "vitest";
import { chromium } from "playwright";
import { parseMetadataObservation } from "@sciretriever/contracts";
import { coreProcessingFixture } from "../../server/test/core-processing-fixture.js";
import { createQueryApplication } from "../../server/src/bootstrap/application.js";
import { createMetadataOperations } from "../../server/src/entry/metadata-operations.js";
import { decodeBibliography } from "../../server/src/literature/bibliography-import.js";
import { startWorkbenchHttp } from "../../server/src/workbench/http.js";
import { ProductionWorkbenchSession } from "../../server/src/workbench/production-session.js";
import {
  loginWorkbenchPage,
  workbenchTestAccess,
} from "../../server/test/workbench-auth-fixture.js";
import { nextAssets } from "./next-workspace-fixture.js";

it(
  "renders actual import and discovery receipts through HTTP without mocking business endpoints",
  { timeout: 0 },
  async () => {
    let mode: "success" | "partial" | "failed" = "success";
    const env = await coreProcessingFixture({
      metadata: {
        topic_search_ports: ["crossref", "arxiv"].map((provider_name) => ({
          provider_name,
          open_topic_search() {
            if (
              mode === "failed" ||
              (mode === "partial" && provider_name === "arxiv")
            )
              throw new Error("synthetic provider failure");
            const imported = decodeBibliography(
              Buffer.from(
                "@article{discovery,title={Synthetic discovered paper},doi={10.1000/intake-discovery},year={2026}}",
              ),
              "bibtex",
            ).items[0]!.observation!;
            const observation = parseMetadataObservation({
              ...imported,
              provenance: {
                ...imported.provenance,
                source_kind: "metadata-provider" as const,
                source_name: provider_name,
                source_record_id: "10.1000/intake-discovery",
                input_sha256: "1".repeat(64),
              },
            });
            let delivered = provider_name === "arxiv";
            return {
              pull_raw_item() {
                if (delivered) return null;
                delivered = true;
                return { raw_item: observation, source_exhausted_after: true };
              },
              convert_raw_item() {
                return { observations: [observation], relations: [] };
              },
            };
          },
        })),
      },
    });
    const close: (() => Promise<unknown>)[] = [() => env.close()];
    try {
      const query = await createQueryApplication(env.home);
      close.push(() => query.close());
      const session = new ProductionWorkbenchSession(null, async () => {
        throw new Error("Unexpected browser action");
      });
      close.push(() => session.close());
      const server = await startWorkbenchHttp({
        access: workbenchTestAccess,
        session,
        assets: await nextAssets(),
        ...createMetadataOperations(env.app),
        query: { application: query },
        library: {
          queries: env.app.library,
          artifacts: env.app.literatureArtifacts,
        },
      });
      close.push(() => server.close());
      const browser = await chromium.launch({ headless: true });
      close.push(() => browser.close());
      const page = await browser.newPage();
      await loginWorkbenchPage(page, server.origin);
      await page.goto(server.origin + "/?view=disc");
      const latest = page.locator(".intake-report").first();
      await page.getByRole("tab", { name: "导入书目", exact: true }).click();
      await page.getByLabel("书目文件", { exact: true }).setInputFiles({
        name: "fixture.bib",
        mimeType: "text/plain",
        buffer: Buffer.from(
          "@article{import,title={Synthetic imported paper},doi={10.1000/intake-contract},year={2026}}",
        ),
      });
      const importOnce = async () => {
        await page.getByRole("button", { name: "导入", exact: true }).click();
        const response = page.waitForResponse(
          (r) =>
            new URL(r.url()).pathname === "/api/import" &&
            r.request().method() === "POST",
        );
        await page
          .getByRole("dialog", { name: "导入书目", exact: true })
          .getByRole("button", { name: "确认执行", exact: true })
          .click();
        const result = await response;
        const receipt = await result.json();
        expect(result.status(), JSON.stringify(receipt)).toBe(200);
        return receipt;
      };
      const receipt = await importOnce();
      expect(receipt.report.items[0].disposition).toBe("created");
      expect(
        JSON.stringify(
          await env.app.library.detail(receipt.report.items[0].literature_id),
        ),
      ).toContain("Synthetic imported paper");
      await expect.poll(() => latest.textContent()).toContain("新增 1 篇");
      await expect.poll(() => latest.textContent()).toContain("导入完成");
      await importOnce();
      await expect.poll(() => latest.textContent()).toContain("已存在 1 篇");
      await page.getByRole("tab", { name: "主题发现", exact: true }).click();
      await page
        .getByRole("textbox", { name: "主题或检索式", exact: true })
        .fill("synthetic");
      const discover = async () => {
        await page
          .getByRole("button", { name: "开始发现", exact: true })
          .click();
        const response = page.waitForResponse(
          (r) =>
            new URL(r.url()).pathname === "/api/discovery" &&
            r.request().method() === "POST",
        );
        await page
          .getByRole("dialog", { name: "确认发现文献", exact: true })
          .getByRole("button", { name: "确认执行", exact: true })
          .click();
        const result = await response;
        const receipt = await result.json();
        expect(result.status(), JSON.stringify(receipt)).toBe(200);
        return receipt;
      };
      expect((await discover()).report.status).toBe("COMPLETED");
      await expect
        .poll(() => latest.textContent())
        .toContain("已接纳 1 条元数据");
      mode = "partial";
      expect((await discover()).report.status).toBe("PARTIAL");
      await expect.poll(() => latest.textContent()).toContain("部分完成");
      await expect
        .poll(() => latest.textContent())
        .toContain("arxiv 未完整返回结果");
      mode = "failed";
      expect((await discover()).report.status).toBe("FAILED");
      await expect.poll(() => latest.textContent()).toContain("发现失败");
      expect(await latest.innerText()).not.toContain(
        "synthetic provider failure",
      );
      expect(env.modelCalls).toBe(0);
      expect(env.parseCalls).toBe(0);
    } finally {
      for (const action of close.reverse()) await action();
    }
  },
);
