import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import {
  parseProcessorInvocation,
  parseProcessorResult,
  processorComparison,
  processorResultBytes,
} from "@sciretriever/contracts";
import { SqliteProcessorStorage } from "../../server/src/storage/processor-results.js";
import { nextWorkspace } from "./next-workspace-fixture.js";
it("downloads a complete large result in the browser and rejects altered transfer chunks", async () => {
  const w = await nextWorkspace({
    ready: '[aria-label="文献列表"] .paper-row:first-child',
  });
  try {
    const store = new SqliteProcessorStorage(
      w.env.app.database,
      w.env.app.files,
      w.env.app.documentRead,
    );
    const material = await w.env.app.documentRead.materialEvidence({
      literature_id: w.env.parseRequest.literature_id,
      asset_id: w.env.asset.asset_id,
    });
    if (material.evidence.target_kind !== "material")
      throw new Error("expected material");
    const invocation = parseProcessorInvocation({
      schema_version: 1,
      processor: { id: "external-extraction", version: "2" },
      spec: {},
      inputs: [
        {
          kind: "external",
          input_id: "source",
          literature_id: material.evidence.material.literature_id,
          material: material.evidence.material,
          document: null,
        },
      ],
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
        literature_ids: [w.env.parseRequest.literature_id],
        created_at: "2026-10-19T00:00:00.000Z",
        provenance: { fixture: true },
        content: {
          kind: "records",
          schema: { type: "object", properties: { text: { type: "string" } } },
          records: Array.from({ length: 8 }, (_, i) => ({
            record_id: `r${i}`,
            payload: { text: '文献 α🙂 "quoted"\n'.repeat(24000) },
            evidence: [
              {
                pointer: "/text",
                sources: [{ kind: "document", evidence: material.evidence }],
              },
            ],
            missing: {},
          })),
        },
        value_checks: Array.from({ length: 8 }, (_, i) => ({
          record_id: `r${i}`,
          pointer: "/text",
          status: "uncertain",
          reason: "Synthetic material-only fixture is unverified.",
          sources: [
            {
              citation: { kind: "document", evidence: material.evidence },
              status: "uncertain",
              reason: "Synthetic material-only fixture is unverified.",
            },
          ],
        })),
        coverage: [
          {
            input_id: "source",
            status: "partial",
            parts: [],
            read_segments: [],
            gaps: ["synthetic-material-only"],
          },
        ],
      }),
    );
    expect(processorResultBytes(saved.result).length).toBeGreaterThan(
      4 * 1024 * 1024,
    );
    const url = new URL(w.page.url());
    url.search = new URLSearchParams({
      view: "ext",
      result: saved.ref.result_id,
      resultHash: saved.ref.content_sha256,
    }).toString();
    await w.page.goto(url.href);
    await expect
      .poll(() => w.page.getByRole("main").textContent(), { timeout: 20000 })
      .toContain("导出这份完整结果");
    await w.page
      .getByRole("button", { name: "导出这份完整结果", exact: true })
      .click();
    await w.page.getByRole("button", { name: /导出格式/ }).click();
    await w.page.getByRole("option", { name: "JSON", exact: true }).click();
    const [file] = await Promise.all([
      w.page.waitForEvent("download", { timeout: 60000 }),
      w.page.getByRole("button", { name: "下载完整结果", exact: true }).click(),
    ]);
    const downloaded = JSON.parse(
      await readFile((await file.path())!, "utf8"),
    ) as typeof saved;
    expect(downloaded).toEqual(saved);
    await w.page.route("**/api/v1/query/processors*", async (route) => {
      const request = route.request().postDataJSON() as { operation: string };
      if (request.operation !== "transfer") {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      const body = (await response.json()) as {
        result: { transfer_sha256: string };
      };
      body.result.transfer_sha256 = "f".repeat(64);
      await route.fulfill({ response, json: body });
    });
    await w.page.goto(url.href);
    await expect
      .poll(() => w.page.getByRole("main").textContent(), { timeout: 15000 })
      .toContain("校验失败");
    expect(
      await w.page
        .getByRole("button", { name: "导出这份完整结果", exact: true })
        .count(),
    ).toBe(0);
    expect(w.env.modelCalls).toBe(0);
    expect(w.env.parseCalls).toBe(w.setupCalls.parser);
    expect(w.errors).toEqual([]);
  } finally {
    await w.page.unrouteAll({ behavior: "wait" });
    await w.close();
  }
}, 120000);
