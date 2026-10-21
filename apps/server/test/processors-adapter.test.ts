import { expect, it } from "vitest";
import { processorFixture } from "./processor-fixture.js";
import { createProcessorRegistry } from "../src/analysis/processor-registry.js";
it("exposes only archive processors and forbids retired single-paper result chains", async () => {
  const registry = createProcessorRegistry();
  expect(registry.list().map((p) => [p.id, p.accepts])).toEqual([
    ["summary", ["archive-document"]],
    ["knowledge-synthesis", ["snapshot"]],
    ["labels", ["archive-document"]],
    ["records", ["archive-document"]],
  ]);
  const e = await processorFixture();
  try {
    await e.build(e.parseRequest);
    await expect(
      e.app.processors!.submit({
        schema_version: 1,
        idempotency_key: "old-chain",
        name: "old-chain",
        processor: { id: "labels", version: "2" },
        spec: { question: "x", answer_type: "boolean" },
        inputs: [
          { kind: "result", result_id: e.asset.asset_id, record_ids: null },
        ],
      }),
    ).rejects.toThrow();
    expect(e.modelCalls).toBe(0);
  } finally {
    await e.close();
  }
});
it("persists a failed map as an incomplete member and does not reduce it into a full-text negative", async () => {
  const e = await processorFixture();
  try {
    await e.build(e.parseRequest);
    const snapshot = await e.app.snapshots.create({
      kind: "literatures",
      literature_ids: [e.parseRequest.literature_id],
    });
    e.setModel(() => {
      throw new Error("Synthetic unavailable model");
    });
    const state = await e.app.processors!.runBatch({
      schema_version: 1,
      idempotency_key: "map-failed",
      name: "map-failed",
      processor: { id: "knowledge-synthesis", version: "2" },
      spec: { question: "What is reported?", policy: "require-all" },
      inputs: [{ kind: "snapshot", snapshot_id: snapshot.snapshot_id }],
    });
    expect(state.failures).toEqual([]);
    const saved = await e.app.processorRead!.byId(
      (state.results[0] as { result: { result_id: string } }).result.result_id,
    );
    expect(saved!.result.content).toMatchObject({ kind: "report", claims: [] });
    expect(saved!.result.coverage[0]).toMatchObject({
      status: "none",
      parts: [{ outcome: "incomplete", gaps: ["map-failed"] }],
    });
  } finally {
    await e.close();
  }
}, 0);
