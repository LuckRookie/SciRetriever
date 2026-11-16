import { readerPanel } from "./reader-controls.js";
import { expect, it } from "vitest";
import { parseLiterature, parseReference } from "@sciretriever/contracts";
import { nextWorkspace } from "./next-workspace-fixture.js";
import { FIXTURE_LITERATURE } from "../../server/src/workbench/synthetic-fixture.js";
const uuid = (group: number, index: number) =>
  `00000000-0000-0000-${String(group).padStart(4, "0")}-${String(index).padStart(12, "0")}`;
it("restores search and detail history and reads more than 25 references with their separate evidence", async () => {
  const w = await nextWorkspace({
    setup: async (env) => {
      for (let n = 1; n <= 27; n++) {
        const target = parseLiterature({
          ...FIXTURE_LITERATURE,
          literature_id: uuid(10, n),
          meta_literature_id: uuid(11, n),
          metadata: {
            ...FIXTURE_LITERATURE.metadata,
            title: `Reference target ${String(n).padStart(2, "0")}`,
            identifiers: [],
          },
        });
        await env.app.database.putLiterature(target);
        await env.app.references.publish(
          parseReference({
            reference_id: uuid(12, n),
            source_literature_id: env.parseRequest.literature_id,
            target_literature_id: target.literature_id,
          }),
        );
      }
    },
  });
  try {
    const page = w.page,
      id = w.env.parseRequest.literature_id;
    const title = (await w.env.app.library.detail(id)).literature.metadata
      .title!;
    const related = (
      await w.env.app.library.search({
        query: { text: "Reference target" },
        limit: 100,
        sort: "title-asc",
      })
    ).items;
    const references: unknown[] = [];
    await page.route("**/api/v1/query/references?*", async (route) => {
      const request = route.request().postDataJSON() as {
        request: { cursor: string | null };
      };
      references.push(request);
      const offset = request.request.cursor === "25" ? 25 : 0;
      const items = await Promise.all(
        Array.from({ length: Math.min(25, 27 - offset) }, async (_, i) => {
          const n = offset + i + 1;
          return {
            reference: parseReference({
              reference_id: uuid(12, n),
              source_literature_id: id,
              target_literature_id: uuid(10, n),
            }),
            related_literature: related.find(
              (item) => item.literature.literature_id === uuid(10, n),
            )!,
            support_count: 1,
          };
        }),
      );
      await route.fulfill({
        status: 200,
        json: {
          protocol_version: 1,
          page: {
            items,
            total_count: 27,
            next_cursor: offset === 0 ? "25" : null,
          },
        },
      });
    });
    await page.route("**/api/v1/query/reference?*", async (route) => {
      const request = route.request().postDataJSON() as {
        request: { reference_id: string };
      };
      const n = Number(request.request.reference_id.slice(-12));
      const source = (
        await w.env.app.library.search({ query: { text: title }, limit: 100 })
      ).items.find((item) => item.literature.literature_id === id)!;
      await route.fulfill({
        status: 200,
        json: {
          protocol_version: 1,
          detail: {
            reference: parseReference({
              reference_id: uuid(12, n),
              source_literature_id: id,
              target_literature_id: uuid(10, n),
            }),
            source,
            target: related.find(
              (item) => item.literature.literature_id === uuid(10, n),
            )!,
            supports: [
              {
                reference_id: uuid(12, n),
                source: {
                  kind: "provider_relation",
                  observation_id: `synthetic-relation-${uuid(12, n)}`,
                },
              },
            ],
          },
        },
      });
    });
    await page
      .getByRole("searchbox", { name: "搜索文献", exact: true })
      .fill(title);
    await expect.poll(() => page.locator(".paper-row").count()).toBe(1);
    await page
      .getByRole("article", { name: title, exact: true })
      .locator(".paper-open")
      .click();
    // The side panel starts closed (spec 1.4).
    await readerPanel(page);
    expect(new URL(page.url()).searchParams.get("literature")).toBe(id);
    await expect
      .poll(() => page.locator(".reader-information").textContent())
      .toContain("尚未核对这份 PDF 是否就是这篇文章");
    // The references are in the side panel's “关联” tab (spec 1.4, 3.7).
    await readerPanel(page, "关联");
    await page.getByRole("button", { name: "引用", exact: true }).click();
    await page
      .getByRole("button", { name: "加载更多引用", exact: true })
      .waitFor()
      .catch(async (error: unknown) => {
        throw new Error(
          `${String(error)}\n${await page.locator(".reader-information").textContent()}\n${JSON.stringify(references)}`,
        );
      });
    const items = page
      .locator(".reader-relations")
      .getByRole("button", { name: /^Reference target/ });
    expect(await items.count()).toBe(25);
    await page
      .getByRole("button", { name: /^来源证据/ })
      .first()
      .click();
    await expect
      .poll(() => page.locator(".reader-relations").textContent())
      .toContain("由元数据供应商提供的关系");
    await page
      .getByRole("button", { name: "加载更多引用", exact: true })
      .click();
    await expect.poll(() => items.count()).toBe(27);
    expect(
      await page
        .getByRole("button", { name: "加载更多引用", exact: true })
        .count(),
    ).toBe(0);
    expect(references).toHaveLength(2);
    expect(references[0]).toMatchObject({
      request: {
        literature_id: id,
        direction: "references",
        limit: 25,
        cursor: null,
      },
    });
    expect(references[1]).toMatchObject({
      request: {
        literature_id: id,
        direction: "references",
        limit: 25,
        cursor: expect.any(String),
      },
    });
    await page.goBack();
    await expect
      .poll(() => new URL(page.url()).searchParams.has("literature"))
      .toBe(false);
    expect(
      await page
        .getByRole("searchbox", { name: "搜索文献", exact: true })
        .inputValue(),
    ).toBe(title);
    await page.goForward();
    await readerPanel(page);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.goto(`${w.origin}/?literature=${uuid(99, 99)}`);
    await expect
      .poll(() => page.getByRole("alert").allTextContents())
      .toContainEqual(expect.stringContaining("读取"));
    expect(new URL(page.url()).searchParams.get("literature")).toBe(
      uuid(99, 99),
    );
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 60000);
