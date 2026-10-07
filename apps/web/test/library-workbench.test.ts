import {
  parseLiterature,
  parseReference,
  parseReferenceDetail,
} from "@sciretriever/contracts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import { createApplication } from "../../server/src/bootstrap/application.js";
import { TypeScriptConfigurationOwner } from "../../server/src/configuration/owner.js";
import type { LiteratureQueryService } from "../../server/src/literature/query.js";
import {
  startWorkbenchHttp,
  type WorkbenchStaticAsset,
} from "../../server/src/workbench/http.js";
import { WorkbenchSession } from "../../server/src/workbench/session.js";
import {
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../../server/src/workbench/synthetic-fixture.js";

const uuid = (group: number, ordinal: number) =>
  `00000000-0000-0000-${String(group).padStart(4, "0")}-${String(ordinal).padStart(12, "0")}`;

async function assets(): Promise<Map<string, WorkbenchStaticAsset>> {
  const values = new Map<string, WorkbenchStaticAsset>();
  for (const [route, file, contentType] of [
    ["/", "live.html", "text/html"],
    ["/styles.css", "styles.css", "text/css"],
    ["/live.css", "live.css", "text/css"],
  ] as const)
    values.set(route, {
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
  values.set("/live.js", {
    contentType: "text/javascript",
    body: bundled.outputFiles[0]!.contents,
  });
  return values;
}

describe("literature library workbench", () => {
  it("restores search/detail history and paginates more than 25 references", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-library-ui-"));
    const application = await createApplication(home, {
      executionSchema: "upgrade-synthetic",
    });
    await application.database.putLiterature(FIXTURE_LITERATURE);
    await application.maintenance!.ingestPdf({
      literature_id: FIXTURE_LITERATURE.literature_id,
      bytes: workbenchPdf("", "", false),
    });
    const references: ReturnType<typeof parseReference>[] = [];
    for (let ordinal = 1; ordinal <= 27; ordinal += 1) {
      const target = parseLiterature({
        ...FIXTURE_LITERATURE,
        literature_id: uuid(10, ordinal),
        meta_literature_id: uuid(11, ordinal),
        metadata: {
          ...FIXTURE_LITERATURE.metadata,
          title: `Reference target ${String(ordinal).padStart(2, "0")}`,
          identifiers: [],
        },
      });
      await application.database.putLiterature(target);
      const reference = parseReference({
        reference_id: uuid(12, ordinal),
        source_literature_id: FIXTURE_LITERATURE.literature_id,
        target_literature_id: target.literature_id,
      });
      references.push(reference);
      await application.references.publish(reference);
    }
    const sourceItem = (
      await application.library.search({
        query: { text: "Synthetic literature workbench" },
        limit: 10,
        sort: "title-asc",
      })
    ).items.find(
      (item) =>
        item.literature.literature_id === FIXTURE_LITERATURE.literature_id,
    )!;
    const relatedItems = (
      await application.library.search({
        query: { text: "Reference target" },
        limit: 100,
        sort: "title-asc",
      })
    ).items;
    expect(sourceItem).toBeDefined();
    expect(relatedItems).toHaveLength(27);
    const queries = {
      search: (value: unknown) => application.library.search(value),
      detail: (value: unknown) => application.library.detail(value),
      references: async (value: unknown) => {
        const request = value as { cursor?: string | null; limit?: number };
        const offset = request.cursor === "25" ? 25 : 0;
        const limit = request.limit ?? 25;
        const items = references
          .slice(offset, offset + limit)
          .map((reference) => ({
            reference,
            related_literature: relatedItems.find(
              (item) =>
                item.literature.literature_id ===
                reference.target_literature_id,
            )!,
            support_count: 1,
          }));
        return {
          items,
          total_count: references.length,
          next_cursor: offset + items.length < references.length ? "25" : null,
        };
      },
      referenceDetail: async (value: unknown) => {
        const reference = references.find(
          (item) => item.reference_id === value,
        )!;
        return {
          reference,
          source: sourceItem,
          target: relatedItems.find(
            (item) =>
              item.literature.literature_id === reference.target_literature_id,
          )!,
          supports: [
            {
              reference_id: reference.reference_id,
              source: {
                kind: "provider_relation" as const,
                observation_id: `synthetic-relation-${reference.reference_id}`,
              },
            },
          ],
        };
      },
    } as unknown as LiteratureQueryService;
    expect(
      parseReferenceDetail(
        await queries.referenceDetail(references[0]!.reference_id),
      ),
    ).toMatchObject({ reference: references[0] });
    const session = new WorkbenchSession(
      FIXTURE_LITERATURE.literature_id,
      {
        id: "library-ui-page",
        title: async () => "Library fixture",
        url: () => "http://127.0.0.1/library-fixture",
        close: async () => undefined,
        snapshot: async () => ({
          document_generation: 1,
          url: "http://127.0.0.1/library-fixture",
          title: "Library fixture",
          viewport: { width: 800, height: 600, device_scale_factor: 1 },
          screenshot: null,
        }),
        apply: async () => undefined,
      },
      {
        max_actions: 2,
        max_model_calls: 1,
        max_retries: 1,
        max_bytes: 1024,
        deadline_ms: 10_000,
      },
    );
    await session.refresh();
    const configuration = new TypeScriptConfigurationOwner(home);
    const server = await startWorkbenchHttp({
      session,
      configuration,
      library: {
        queries,
        artifacts: application.literatureArtifacts,
      },
      assets: await assets(),
    });
    const browser = await chromium.launch({
      executablePath:
        process.env.SCIRETRIEVER_BROWSER_EXECUTABLE ??
        "/home/duanjw/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome",
      headless: true,
    });
    try {
      const page = await browser.newPage({
        viewport: { width: 1280, height: 900 },
      });
      const failures: string[] = [];
      page.on("pageerror", (error) => failures.push(error.message));
      await page.goto(`${server.origin}/?workspace=library`);
      await expect
        .poll(() => page.locator("#library-workspace").isVisible())
        .toBe(true);
      await page
        .locator("#library-query")
        .fill("Synthetic literature workbench");
      await page
        .locator("#library-form")
        .getByRole("button", { name: "搜索" })
        .click();
      const source = page
        .locator(".library-result")
        .filter({ hasText: "Synthetic literature workbench" })
        .first();
      await expect.poll(() => source.count()).toBe(1);
      await source.click();
      await expect
        .poll(() => page.locator("#library-detail h2").textContent())
        .toBe("Synthetic literature workbench");
      await expect
        .poll(() => page.locator("#library-detail").textContent())
        .toContain("文章身份未验证");
      expect(new URL(page.url()).searchParams.get("literature")).toBe(
        FIXTURE_LITERATURE.literature_id,
      );

      await page
        .locator("#library-detail")
        .getByRole("button", { name: "查看参考文献", exact: true })
        .click();
      await expect
        .poll(() =>
          page.locator('[data-more-relations="references"]').isVisible(),
        )
        .toBe(true);
      expect(
        await page
          .locator("#library-detail")
          .getByRole("button", { name: /Reference target/u })
          .count(),
      ).toBe(25);
      await page
        .locator("#library-detail")
        .getByRole("button", { name: /Reference target/u })
        .first()
        .click();
      await page.waitForTimeout(100);
      expect(await page.locator("#library-status").textContent()).not.toContain(
        "引用证据暂时无法读取",
      );
      await expect
        .poll(() => page.locator(".library-evidence").count())
        .toBe(1);
      await page.locator('[data-more-relations="references"]').click();
      await expect
        .poll(() =>
          page
            .locator("#library-detail")
            .getByRole("button", { name: /Reference target/u })
            .count(),
        )
        .toBe(27);
      expect(
        await page.locator('[data-more-relations="references"]').count(),
      ).toBe(0);

      await page.goBack();
      await expect
        .poll(() => new URL(page.url()).searchParams.has("literature"))
        .toBe(false);
      await expect
        .poll(() => page.locator("#library-detail").textContent())
        .toContain("选择一篇文献");
      await page.goForward();
      await expect
        .poll(() => page.locator("#library-detail h2").textContent())
        .toBe("Synthetic literature workbench");
      await page.setViewportSize({ width: 390, height: 844 });
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        )
        .toBe(true);
      expect(failures).toEqual([]);

      const missing = await browser.newPage();
      await missing.goto(
        `${server.origin}/?workspace=library&literature=${uuid(99, 99)}`,
      );
      await expect
        .poll(() => missing.locator("#library-detail").textContent())
        .toContain("无法读取文献");
      await expect
        .poll(() => new URL(missing.url()).searchParams.has("literature"))
        .toBe(false);
      await missing.close();
    } finally {
      await browser.close();
      await server.close();
      await session.close();
      await application.close();
      await rm(home, { recursive: true, force: true });
    }
  }, 60_000);
});
