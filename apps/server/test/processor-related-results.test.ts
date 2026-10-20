import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { processorFixture } from "./processor-fixture.js";
it("finds related corrected, absent-part and snapshot results without fabricated evidence", async () => {
  const e = await processorFixture();
  try {
    await e.build(e.parseRequest);
    const literature_id = e.parseRequest.literature_id;
    const run = async (processor: string, spec: object, inputs: unknown[]) => {
      const state = await e.app.processors!.runBatch({
        schema_version: 1,
        idempotency_key: randomUUID(),
        name: "related",
        processor: { id: processor, version: "2" },
        spec,
        inputs,
      });
      expect(state.failures).toEqual([]);
      return (
        state.results[0] as {
          result: { result_id: string; content_sha256: string };
        }
      ).result;
    };
    const summary = await run("summary", {}, [
      { kind: "literature", literature_id },
    ]);
    const absent = await run(
      "labels",
      {
        question: "Missing supplement?",
        answer_type: "boolean",
        reads: { parts: "supplementary", roles: "all" },
      },
      [{ kind: "literature", literature_id }],
    );
    const snapshot = await e.app.snapshots.create({
      kind: "literatures",
      literature_ids: [literature_id],
    });
    e.setModel((input) => ({
      claims: [
        {
          text: "A synthetic finding.",
          source_ids: (input.candidates as { id: string }[]).map((c) => c.id),
        },
      ],
    }));
    const synthesis = await run(
      "knowledge-synthesis",
      { question: "Compare", policy: "require-all" },
      [{ kind: "snapshot", snapshot_id: snapshot.snapshot_id }],
    );
    const calls = e.modelCalls,
      ids: string[] = [];
    let after = "";
    do {
      const page = await e.app.processorRead!.list(
        1,
        after,
        undefined,
        literature_id,
      );
      ids.push(...page.items.map((i) => String(i.result_id)));
      after = page.next_after ?? "";
    } while (after);
    expect(ids).toEqual(
      [summary.result_id, absent.result_id, synthesis.result_id].sort(),
    );
    const empty = await e.app.processorRead!.byId(absent.result_id);
    expect(empty!.result.coverage[0]!.parts[0]!.outcome).toBe("part-absent");
    expect(empty!.result.content).toMatchObject({
      kind: "records",
      records: [],
    });
    expect(
      await e.app.processorRead!.list(20, "", undefined, randomUUID()),
    ).toEqual({ items: [], next_after: null });
    await expect(
      e.app.processorRead!.list(20, "", undefined, "invalid"),
    ).rejects.toThrow();
    expect(e.modelCalls).toBe(calls);
  } finally {
    await e.close();
  }
});
