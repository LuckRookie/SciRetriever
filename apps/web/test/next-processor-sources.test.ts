import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import type { Page } from "playwright";
import {
  parseProcessorInvocation,
  parseProcessorResult,
  processorComparison,
  type EvidenceRef,
} from "@sciretriever/contracts";
import { SqliteProcessorStorage } from "../../server/src/storage/processor-results.js";
import { workbenchPdf } from "../../server/src/workbench/synthetic-fixture.js";
import { missingId } from "./processor-workspace-fixture.js";
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
it("shows verified record sources separately from whole-result inputs and filters nullable numeric children", async () => {
  const w = await nextWorkspace({
    ready: '[aria-label="文献列表"] .paper-row:first-child',
  });
  const store = new SqliteProcessorStorage(
    w.env.app.database,
    w.env.app.files,
    w.env.app.documentRead,
  );
  try {
    await w.env.app.maintenance!.ingestPdf({
      literature_id: missingId,
      bytes: workbenchPdf("10.1234/second-source"),
    });
    const evidence: Extract<EvidenceRef, { target_kind: "material" }>[] = [];
    for (const id of [w.env.parseRequest.literature_id, missingId]) {
      const asset = (await w.env.app.library.detail(id)).primary_pdf!.asset;
      const material = await w.env.app.documentRead.materialEvidence({
        literature_id: id,
        asset_id: asset.asset_id,
      });
      if (material.evidence.target_kind !== "material")
        throw new Error("expected material");
      evidence.push(material.evidence);
    }
    const invocation = parseProcessorInvocation({
      schema_version: 1,
      processor: { id: "external-extraction", version: "2" },
      spec: {},
      inputs: evidence.map((ev, i) => ({
        kind: "external",
        input_id: `source-${i}`,
        literature_id: ev.material.literature_id,
        material: ev.material,
        document: null,
      })),
      execution: {
        method_sha256: "a".repeat(64),
        model: null,
        reads: { parts: "main", roles: "all" },
        uses_description: false,
        map: null,
      },
    });
    const saved = await store.publish(
      await parseProcessorResult({
        schema_version: 1,
        result_id: randomUUID(),
        invocation,
        comparison_sha256: await processorComparison(invocation),
        status: "ok",
        producer: "external",
        literature_ids: [w.env.parseRequest.literature_id, missingId],
        created_at: "2026-10-19T00:00:00.000Z",
        provenance: { fixture: "source and null query regression" },
        content: {
          kind: "records",
          schema: {
            type: "object",
            properties: {
              quantity: {
                type: ["object", "null"],
                properties: { value: { type: "number" } },
              },
              flag: { type: "boolean" },
              text: { type: "string" },
            },
          },
          records: [
            {
              record_id: "r1",
              payload: { quantity: { value: 0 }, flag: false, text: "" },
              evidence: [
                {
                  pointer: "",
                  sources: [{ kind: "document", evidence: evidence[1] }],
                },
              ],
              missing: {},
            },
            {
              record_id: "r2",
              payload: { quantity: null },
              evidence: [
                {
                  pointer: "",
                  sources: [{ kind: "document", evidence: evidence[0] }],
                },
              ],
              missing: { "/quantity": "not-reported" },
            },
            {
              record_id: "r3",
              payload: {},
              evidence: [],
              missing: {},
            },
          ],
        },
        coverage: invocation.inputs.map((input) => ({
          input_id: input.input_id,
          status: "partial",
          parts: [],
          read_segments: [],
          gaps: ["synthetic-material-only"],
        })),
      }),
    );
    await store.rebuild([saved.ref.result_id]);
    await enter(w, {
      result: saved.ref.result_id,
      resultHash: saved.ref.content_sha256,
    });
    expect(await w.page.getByRole("main").textContent()).toContain(
      "2 篇关联文献",
    );
    const first = w.page
      .getByRole("table", { name: "提取结果" })
      .getByRole("row")
      .nth(1);
    expect(
      await first.getByText("Unparsed source", { exact: true }).textContent(),
    ).toBe("Unparsed source");
    expect(await first.textContent()).toContain("1 篇来源文献");
    expect(
      await first
        .getByRole("button", { name: "查看全部来源", exact: true })
        .count(),
    ).toBe(0);
    await first.getByRole("checkbox").focus();
    await w.page.keyboard.press("Space");
    await expect
      .poll(() => w.page.getByText(/已选 1 条记录/).textContent())
      .toContain("来自 1 篇文献");
    await choose(w.page, "筛选字段", "/quantity/value");
    await choose(w.page, "筛选操作", "有值");
    await w.page.getByRole("button", { name: "应用筛选", exact: true }).click();
    await expect
      .poll(() =>
        w.page
          .getByRole("table", { name: "提取结果" })
          .getByRole("checkbox", { name: /选择第/ })
          .count(),
      )
      .toBe(1);
    expect(
      await w.page
        .getByRole("table", { name: "提取结果" })
        .getByRole("row")
        .nth(1)
        .textContent(),
    ).toContain("0");
    await choose(w.page, "筛选操作", "空值 / 无法判断");
    await w.page.getByRole("button", { name: "应用筛选", exact: true }).click();
    await expect
      .poll(() =>
        w.page
          .getByRole("table", { name: "提取结果" })
          .getByRole("checkbox", { name: /选择第/ })
          .count(),
      )
      .toBe(2);
    const query = {
      collection_id: null,
      result_ids: [saved.ref.result_id],
      filters: [],
      sort: null,
      limit: 20,
      offset: 0,
    };
    for (const field of ["flag", "text"]) {
      const present = await w.env.app.processorRead!.query({
        ...query,
        filters: [{ field, operator: "ne", value: null }],
      });
      expect(present.items).toHaveLength(1);
    }
    await expect(
      w.env.app.processorRead!.query({
        ...query,
        filters: [{ field: "/quantity/value", operator: "eq", value: "0" }],
      }),
    ).rejects.toMatchObject({ code: "processor-field-type" });
    await expect(
      w.env.app.processorRead!.query({
        ...query,
        filters: [{ field: "/unknown", operator: "eq", value: null }],
      }),
    ).rejects.toMatchObject({ code: "processor-field-unknown" });
    // Fill the bounded UI source cache, then mix its oldest entry with a new
    // record on one filtered page. Eviction must not remove visible sources.
    const largeInvocation = parseProcessorInvocation({
      ...invocation,
      spec: { case: "source-cache" },
    });
    const many = Array.from({ length: 201 }, (_, index) => ({
      record_id: `r${index}`,
      payload: {
        quantity: { value: index },
        flag: index === 0 || index === 200,
        text: "cache fixture",
      },
      evidence: [
        {
          pointer: "",
          sources: [{ kind: "document" as const, evidence: evidence[1]! }],
        },
      ],
      missing: {},
    }));
    const large = await store.publish(
      await parseProcessorResult({
        ...saved.result,
        result_id: randomUUID(),
        invocation: largeInvocation,
        comparison_sha256: await processorComparison(largeInvocation),
        content: {
          kind: "records",
          schema:
            saved.result.content.kind === "records"
              ? saved.result.content.schema
              : {},
          records: many,
        },
      }),
    );
    await store.rebuild([large.ref.result_id]);
    // The server's evidence ownership is exercised above; this additional
    // client-cache regression uses fixed synthetic replies to bound its cost.
    await w.page.route("**/api/v1/query/processors?*", async (route) => {
      const body = route.request().postDataJSON() as {
        operation: string;
        request: { result_id?: string; record_id?: string };
      };
      if (
        body.operation === "evidence" &&
        body.request.result_id === large.ref.result_id
      ) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            protocol_version: 1,
            result: {
              value: many.find(
                (row) => row.record_id === body.request.record_id,
              )!.payload,
              evidence: [evidence[1]],
              literature_ids: [missingId],
            },
          }),
        });
      } else await route.continue();
    });
    await enter(w, {
      result: large.ref.result_id,
      resultHash: large.ref.content_sha256,
    });
    await choose(w.page, "每页记录数", "50 条 / 页");
    await expect
      .poll(() =>
        w.page
          .getByRole("table", { name: "提取结果" })
          .getByRole("checkbox", { name: /选择第/ })
          .count(),
      )
      .toBe(50);
    for (let page = 2; page <= 4; page++) {
      await w.page.getByRole("button", { name: "下一页", exact: true }).click();
      await expect
        .poll(() => w.page.getByRole("main").textContent())
        .toContain(`第 ${page} 页`);
    }
    await choose(w.page, "筛选字段", "flag");
    await choose(w.page, "筛选操作", "等于");
    await choose(w.page, "筛选值", "是");
    await w.page.getByRole("button", { name: "应用筛选", exact: true }).click();
    await expect
      .poll(() =>
        w.page
          .getByRole("table", { name: "提取结果" })
          .getByRole("checkbox", { name: /选择第/ })
          .count(),
      )
      .toBe(2);
    expect(
      await w.page
        .getByText("Unparsed source", { exact: true })
        .allTextContents(),
    ).toEqual(["Unparsed source", "Unparsed source"]);
    expect(w.env.modelCalls).toBe(0);
    expect(w.errors).toEqual([]);
  } finally {
    await store.close();
    await w.close();
  }
}, 60000);
