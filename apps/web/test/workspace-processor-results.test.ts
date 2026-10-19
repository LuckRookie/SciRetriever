import { assertMachineReadsWebResult } from "../../server/test/processor-machine-read-fixture.js";
import { captureReading } from "./reading-capture-fixture.js";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import {
  parseProcessorBatchRequest,
  type ProcessorResultRef,
  type ProcessorRecord,
} from "@sciretriever/contracts";
import { workspace } from "./processor-workspace-fixture.js";

type Workspace = Awaited<ReturnType<typeof workspace>>;
async function published(w: Workspace, id: string) {
  await expect
    .poll(
      async () =>
        (await w.env.app.processingTasks!.read(id)).collections.length,
      { timeout: 15000 },
    )
    .toBe(1);
  const summary = (await w.env.app.processorRead!.collections(id))[0]!;
  return (await w.env.app.processorRead!.collection(
    String(summary.collection_id),
  ))!;
}
async function enter(w: Workspace, params: Record<string, string>) {
  const url = new URL(w.page.url());
  url.search = new URLSearchParams({ view: "ext", ...params }).toString();
  await w.page.goto(url.href);
  await expect
    .poll(() => w.page.locator("#result-status").textContent(), {
      timeout: 10000,
    })
    .toContain("显示");
}
async function records(w: Workspace) {
  w.env.setModel((input) => ({
    records: Array.from({ length: 32 }, (_, i) => ({
      values: {
        energy: { value: 4.2, raw: "4.2", unit: "eV" },
        note: `Observation ${i} with a comma, quote " and newline\n尾部`,
      },
      evidence: {
        energy: [
          input.segments!.find((s) => s.text.includes("4.2"))!.segment_id,
        ],
        note: [input.segments![0]!.segment_id],
      },
      missing: { energy: null, note: null },
    })),
  }));
  await w.page
    .locator(`[data-ck="${w.env.parseRequest.literature_id}"]`)
    .check();
  await w.page.locator("#capSel").click();
  await w.page.locator('[data-cap="ext"]').click();
  await expect
    .poll(() => w.page.locator("#processor-submit").isEnabled())
    .toBe(true);
  await w.page
    .locator("#processor-meaning")
    .fill("One independent observation within a paper");
  await w.page.locator('[data-field="name"][data-index="0"]').fill("energy");
  await w.page
    .locator('[data-field="description"][data-index="0"]')
    .fill("Reported energy");
  await w.page
    .locator('[data-field="type"][data-index="0"]')
    .selectOption("number");
  await w.page.locator("#processor-add-field").click();
  await w.page.locator('[data-field="name"][data-index="1"]').fill("note");
  await w.page
    .locator('[data-field="description"][data-index="1"]')
    .fill("Original observation label");
  await w.page.locator("#processor-submit").click();
  await expect
    .poll(() => w.page.locator("#processor-feedback").textContent(), {
      timeout: 10000,
    })
    .toContain("任务已保存");
  const jobs = await w.env.app.jobs!.listJobs(20);
  const collection = await published(w, jobs[0]!.job_id);
  const ref = collection.members[0]!.result!;
  const saved = (await w.env.app.processorRead!.byId(ref.result_id))!;
  if (saved.result.content.kind !== "records")
    throw new Error("expected records");
  return { collection, ref, saved, records: saved.result.content.records };
}
async function exported(w: Workspace, format: string) {
  await w.page.locator("[data-result-export]").first().click();
  await w.page.locator("#result-export-format").selectOption(format);
  const [file] = await Promise.all([
    w.page.waitForEvent("download"),
    w.page.getByRole("button", { name: "下载完整结果", exact: true }).click(),
  ]);
  const path = await file.path();
  if (!path) throw new Error("download absent");
  return { bytes: await readFile(path), name: file.suggestedFilename() };
}

it("queries, selects across pages, follows fixed evidence and synthesizes only the confirmed rows, while exporting the complete result", async () => {
  const w = await workspace();
  try {
    const data = await records(w);
    await assertMachineReadsWebResult(w.env.home, data.saved);
    await enter(w, { collection: data.collection.collection_id });
    await captureReading(w.page, "results");
    expect(await w.page.locator("[data-select-record]").count()).toBe(25);
    const queries: Record<string, unknown>[] = [];
    w.page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/v1/query/processors") {
        const payload = request.postDataJSON() as {
          operation: string;
          request: Record<string, unknown>;
        };
        if (payload.operation === "query") queries.push(payload.request);
      }
    });
    await w.page.getByLabel("每页记录数").selectOption("10");
    await expect
      .poll(() => w.page.locator("[data-select-record]").count())
      .toBe(10);
    const chosen: string[] = [];
    const first = w.page.locator("[data-select-record]").first();
    chosen.push(
      (
        JSON.parse(
          (await first.getAttribute("data-select-record"))!,
        ) as string[]
      )[1]!,
    );
    await first.check();
    await expect
      .poll(() => w.page.locator("#result-selection-count").textContent())
      .toContain("已选 1 条");
    await w.page.getByRole("button", { name: "下一页", exact: true }).click();
    await expect
      .poll(() => w.page.locator("#result-paging").textContent())
      .toContain("第 2 页");
    const second = w.page.locator("[data-select-record]").first();
    chosen.push(
      (
        JSON.parse(
          (await second.getAttribute("data-select-record"))!,
        ) as string[]
      )[1]!,
    );
    await second.check();
    await expect
      .poll(() => w.page.locator("#result-selection-count").textContent())
      .toContain("已选 2 条记录 · 来自 1 篇文献");
    await w.page.locator('[data-result-field="energy"]').first().click();
    await expect
      .poll(() => w.page.locator("#result-evidence").textContent())
      .toContain("The measured energy was 4.2 eV.");
    await w.page
      .getByRole("button", { name: "打开这段原文", exact: true })
      .click();
    await expect
      .poll(() => w.page.locator(".library-reading-text").textContent())
      .toContain("4.2 eV");
    expect(new URL(w.page.url()).searchParams.get("document")).toBe(
      w.parsed.document.document_version_id,
    );
    await w.page.getByRole("button", { name: "返回结果", exact: true }).click();
    await expect
      .poll(() => w.page.locator("#result-paging").textContent())
      .toContain("第 2 页");
    expect(
      await w.page.locator("#result-selection-count").textContent(),
    ).toContain("已选 2 条记录");
    await w.page.locator("#result-field").selectOption("/energy/value");
    await w.page.locator("#result-operator").selectOption("ge");
    await w.page.locator("#result-filter-value").fill("4");
    await w.page.locator("#result-sort").selectOption("desc");
    await w.page.locator("#result-apply").click();
    await expect
      .poll(() => queries.at(-1)?.filters)
      .toEqual([{ field: "/energy/value", operator: "ge", value: 4 }]);
    await expect
      .poll(() => w.page.locator("#result-status").textContent())
      .toContain("显示已应用");
    expect(queries.at(-1)?.sort).toEqual({
      field: "/energy/value",
      direction: "desc",
    });
    const before = queries.length;
    await w.page.locator("#result-filter-value").fill("100");
    expect(queries.length).toBe(before);
    const csv = await exported(w, "csv");
    expect(csv.name).toContain("csv.zip");
    const zip = unzipSync(csv.bytes);
    const content = strFromU8(zip["result.csv"]!);
    expect(content).toContain('""');
    expect(content).toContain("Observation 31");
    expect(content).toContain("尾部");
    const metadata = JSON.parse(strFromU8(zip["metadata.json"]!)) as Record<
      string,
      unknown
    >;
    expect(metadata.content_sha256).toBe(data.ref.content_sha256);
    expect(metadata.coverage).toEqual(data.saved.result.coverage);
    const json = await exported(w, "json");
    expect(JSON.parse(json.bytes.toString())).toEqual(data.saved);
    expect(w.env.modelCalls).toBe(1);
    let candidateCount = 0;
    w.env.setModel((input) => {
      const candidates = input.candidates as {
        id: string;
        independent_literature_ids: string[];
      }[];
      candidateCount = candidates.length;
      expect(
        candidates.every((c) => c.independent_literature_ids.length === 1),
      ).toBe(true);
      return {
        statements: [
          {
            text: "Two selected observations from one paper.",
            source_ids: candidates.map((c) => c.id),
          },
        ],
      };
    });
    await w.page.locator("#result-synthesize").click();
    await w.page
      .locator("#result-synthesis-question")
      .fill("Compare the chosen measurements");
    // A confirmation panel freezes its displayed scope even if the table selection changes.
    await w.page.locator("#result-clear").click();
    await w.page
      .getByRole("button", { name: "确认并创建综合任务", exact: true })
      .click();
    await expect
      .poll(() => w.page.locator("#result-synthesis-status").textContent(), {
        timeout: 10000,
      })
      .toContain("任务已保存");
    const submission = w.submissions.at(-1)!;
    expect(submission.inputs).toEqual([
      {
        kind: "result",
        result_id: data.ref.result_id,
        record_ids: chosen.sort(),
      },
    ]);
    await expect.poll(() => candidateCount, { timeout: 10000 }).toBe(2);
    await w.page
      .getByRole("button", { name: "查看综合任务", exact: true })
      .click();
    await expect
      .poll(() => w.page.locator("#task-results").textContent(), {
        timeout: 15000,
      })
      .toContain("新生成 1 项");
    await w.page
      .getByRole("button", { name: "打开处理结果摘要", exact: true })
      .click();
    await expect
      .poll(() => w.page.locator("#processor-record-preview").textContent(), {
        timeout: 10000,
      })
      .toContain("Two selected observations");
    await w.page.locator('[data-result-field="text"]').first().click();
    await expect
      .poll(() => w.page.locator("#result-evidence").textContent())
      .toContain("核对上游记录");
    expect(await w.env.app.processorRead!.byId(data.ref.result_id)).toEqual(
      data.saved,
    );
    expect(w.env.modelCalls).toBe(2);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 120000);

it("keeps false distinct from unknown labels, restores associated papers, and exposes content search and stale-index recovery without hidden work", async () => {
  const w = await workspace();
  try {
    const saved: { ref: ProcessorResultRef; row: ProcessorRecord }[] = [];
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
          processor: { id: "labels", version: "1" },
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
      saved.push({ ref, row: result.content.records[0]! });
      await enter(w, { collection: collection.collection_id });
      await w.page.locator("#result-field").selectOption("answer");
      await w.page
        .locator("#result-operator")
        .selectOption(answer === null ? "null" : "eq");
      if (answer !== null)
        await w.page.locator("#result-filter-value").selectOption("false");
      await w.page.locator("#result-apply").click();
      await expect
        .poll(() => w.page.locator("#result-status").textContent())
        .toContain("显示已应用");
      expect(
        await w.page.locator('[data-result-field="answer"]').textContent(),
      ).toBe(answer === null ? "无法判断 / 未报告" : "否");
      await w.page.locator("[data-select-record]").check();
      await expect
        .poll(() => w.page.locator("#result-selection-count").textContent())
        .toContain("来自 1 篇文献");
      await w.page.locator("#result-papers").click();
      await expect
        .poll(() =>
          w.page
            .locator(`[data-ck="${w.env.parseRequest.literature_id}"]`)
            .isChecked(),
        )
        .toBe(true);
    }
    const calls = w.env.modelCalls;
    const url = new URL(w.page.url());
    url.search = "view=ext&results=all";
    await w.page.goto(url.href);
    await w.page.locator("#result-search-query").fill("Label");
    await w.page
      .locator("#result-search-form")
      .getByRole("button", { name: "检索", exact: true })
      .click();
    await expect
      .poll(() => w.page.locator("#result-collections .result-card").count())
      .toBe(2);
    await w.page.locator("#result-search-scope").selectOption("results");
    await w.page.locator("#result-search-query").fill("false");
    await w.page
      .locator("#result-search-form")
      .getByRole("button", { name: "检索", exact: true })
      .click();
    await expect
      .poll(() => w.page.locator("#result-collections").textContent())
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
    await w.page.locator("#result-search-query").fill("中文");
    await w.page
      .locator("#result-search-form")
      .getByRole("button", { name: "检索", exact: true })
      .click();
    await expect
      .poll(() => w.page.locator("#result-status").textContent())
      .toContain("不会自动重建");
    expect(await w.page.locator("#result-search-hint").textContent()).toContain(
      "不会自动跨语言",
    );
    expect(w.env.modelCalls).toBe(calls);
    expect(w.env.parseCalls).toBe(1);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 90000);
