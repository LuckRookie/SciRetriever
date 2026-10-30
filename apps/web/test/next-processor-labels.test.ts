import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import type { Page } from "playwright";
import { parseProcessorBatchRequest } from "@sciretriever/contracts";
import { nextWorkspace } from "./next-workspace-fixture.js";
async function choose(page: Page, label: string, option: string) {
  await page.getByRole("button", { name: new RegExp(label) }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}
async function enter(
  w: Awaited<ReturnType<typeof nextWorkspace>>,
  params: Record<string, string>,
) {
  const url = new URL(w.page.url());
  url.search = new URLSearchParams({ view: "ext", ...params }).toString();
  await w.page.goto(url.href);
  await w.page.getByRole("table", { name: "提取结果", exact: true }).waitFor();
}
async function published(
  w: Awaited<ReturnType<typeof nextWorkspace>>,
  id: string,
) {
  await expect
    .poll(
      async () =>
        (await w.env.app.processingTasks!.read(id)).collections.length,
      { timeout: 20_000 },
    )
    .toBe(1);
  const summary = (await w.env.app.processorRead!.collections(id))[0]!;
  return (await w.env.app.processorRead!.collection(
    String(summary.collection_id),
  ))!;
}
it("keeps false distinct from unknown labels, restores associated papers, and exposes content search and stale-index recovery without hidden work", async () => {
  const w = await nextWorkspace({
    ready: '[aria-label="文献列表"] .paper-row:first-child',
  });
  try {
    for (const answer of [false, null] as const) {
      w.env.setModel((input) => ({
        answer,
        source_ids: answer === null ? [] : [input.segments![0]!.segment_id],
        reason: answer === null ? "insufficient-evidence" : null,
      }));
      const job = await w.env.app.processors!.submit(
        parseProcessorBatchRequest({
          schema_version: 1,
          idempotency_key: randomUUID(),
          name: `Label ${answer}`,
          processor: { id: "labels", version: "2" },
          spec: {
            question: `Does the source support query ${answer}?`,
            answer_type: "boolean",
          },
          inputs: [
            {
              kind: "literature",
              literature_id: w.env.parseRequest.literature_id,
            },
          ],
        }),
      );
      await w.env.app.processingTasks!.run(job.job_id);
      const collection = await published(w, job.job_id);
      const ref = collection.members[0]!.result!;
      const result = (await w.env.app.processorRead!.byId(ref.result_id))!
        .result;
      if (result.content.kind !== "records") throw new Error("expected label");
      await enter(w, { collection: collection.collection_id });
      if (answer === null) {
        await enter(w, {
          result: ref.result_id,
          resultHash: ref.content_sha256,
        });
        expect(result.status).toBe("empty");
        expect(result.content.records).toEqual([]);
        expect(result.coverage[0]!.parts).toContainEqual(
          expect.objectContaining({ outcome: "complete" }),
        );
        await expect
          .poll(() =>
            w.page
              .getByRole("region", { name: "结果覆盖与版本" })
              .textContent(),
          )
          .toContain("结果为空 1 篇");
        expect(
          await w.page
            .getByRole("checkbox", { name: "选择第 1 条结果", exact: true })
            .count(),
        ).toBe(0);
        continue;
      }

      await choose(w.page, "筛选字段", "answer");
      await choose(w.page, "筛选操作", "等于");
      await choose(w.page, "筛选值", "否");
      await w.page
        .getByRole("button", { name: "应用筛选", exact: true })
        .click();
      await expect
        .poll(() => w.page.getByRole("main").textContent())
        .toContain("已应用筛选");
      expect(
        await w.page
          .getByRole("table", { name: "提取结果" })
          .getByRole("button", {
            name: "否",
            exact: true,
          })
          .textContent(),
      ).toBe("否");
      await w.page
        .getByRole("checkbox", { name: "选择第 1 条结果", exact: true })
        .focus();
      await w.page.keyboard.press("Space");
      await expect
        .poll(() => w.page.getByText(/已选 1 条记录/).textContent())
        .toContain("来自 1 篇文献");
      await w.page
        .getByRole("button", { name: "选择来源文献", exact: true })
        .click();
      await expect
        .poll(() =>
          w.page
            .getByRole("checkbox", {
              name: "选择 Synthetic literature workbench",
              exact: true,
            })
            .isChecked(),
        )
        .toBe(true);
    }
    const calls = w.env.modelCalls;
    const url = new URL(w.page.url());
    // Saved operator results are searched from 全文检索 → 算子结果.
    url.search = "view=ask&results=all";
    await w.page.goto(url.href);
    await w.page
      .getByRole("searchbox", { name: "检索已有结果", exact: true })
      .fill("Label");
    await w.page
      .getByRole("main")
      .getByRole("button", { name: "检索", exact: true })
      .click();
    await expect
      .poll(() => w.page.getByRole("main").getByRole("article").count())
      .toBe(2);
    await choose(w.page, "结果检索范围", "结果正文");
    await w.page
      .getByRole("searchbox", { name: "检索已有结果", exact: true })
      .fill("false");
    await w.page
      .getByRole("main")
      .getByRole("button", { name: "检索", exact: true })
      .click();
    await expect
      .poll(() => w.page.getByRole("main").textContent())
      .toContain("false");
    await w.page.route("**/api/v1/query/processors?*", async (route) => {
      const body = route.request().postDataJSON() as { operation: string };
      if (body.operation === "search")
        await route.fulfill({
          status: 422,
          json: { protocol_version: 1, code: "processor-index-stale" },
        });
      else await route.continue();
    });
    await w.page
      .getByRole("searchbox", { name: "检索已有结果", exact: true })
      .fill("中文");
    await w.page
      .getByRole("main")
      .getByRole("button", { name: "检索", exact: true })
      .click();
    await expect
      .poll(() => w.page.getByRole("main").textContent())
      .toContain("不会自动重建");
    expect(await w.page.getByRole("main").textContent()).toContain(
      "不会自动跨语言",
    );
    expect(w.env.modelCalls).toBe(calls);
    expect(w.env.parseCalls).toBe(w.setupCalls.parser);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 90000);
