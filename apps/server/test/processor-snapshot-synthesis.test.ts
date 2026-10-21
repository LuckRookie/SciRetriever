import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { parseLiterature } from "@sciretriever/contracts";
import { processorFixture } from "./processor-fixture.js";
let e: Awaited<ReturnType<typeof processorFixture>>;
let id: string;
let secondId: string;
// Setup, cleanup and map/reduce verify a lifecycle without aggregate deadlines.
// Individual operation cancellation and failure contracts remain enabled.
beforeAll(async () => {
  e = await processorFixture();
  id = e.rawParseRequest.literature_id;
  await e.app.writes.run(async () => {
    // Use the real archive fixture without unrelated durable setup jobs.
    // The summary/synthesis operations below still use production jobs.
    await e.build(e.rawParseRequest);
    const first = (await e.app.library.detail(id)).literature,
      second = parseLiterature({
        ...first,
        literature_id: randomUUID(),
        meta_literature_id: randomUUID(),
        metadata: { ...first.metadata, identifiers: [] },
      });
    await e.app.database.putLiterature(second);
    await e.app.database.putLiteratureAsset({
      literature_asset_id: randomUUID(),
      literature_id: second.literature_id,
      asset: e.asset,
      role: "primary-pdf",
      source_url: null,
      provenance: {
        provenance_id: randomUUID(),
        source_kind: "user",
        source_name: "fixture",
        source_record_id: null,
        observed_at: "2026-10-20T00:00:00Z",
        input_sha256: e.asset.sha256,
        parameters_sha256: null,
      },
    });
    await e.build({
      literature_id: second.literature_id,
      asset_id: e.asset.asset_id,
      asset_sha256: e.asset.sha256,
    });
    expect((await e.app.archive.status(second.literature_id)).status).toBe(
      "READY",
    );
    secondId = second.literature_id;
  });
}, 0);
afterAll(async () => {
  await e?.close();
}, 0);
it("runs persistent DSH summaries as reusable maps, then synthesizes only their records", async () => {
  let summaries = 0,
    reductions = 0;
  e.setModel((input) => {
    if (input.purpose) {
      summaries++;
      return {
        outcome: "completed",
        title: "Synthetic summary",
        statements: [
          {
            statement_id: "s1",
            category: "finding",
            epistemic: "reported",
            text: "本文报告了合成光谱研究。",
            conditions: [],
            quantity: null,
            evidence_segment_ids: [input.segments![0]!.segment_id],
          },
        ],
      };
    }
    reductions++;
    expect(input).not.toHaveProperty("segments");
    const candidates = input.candidates as {
      id: string;
      independent_literature_ids: string[];
    }[];
    expect(candidates.length).toBeGreaterThan(0);
    return {
      claims: [
        {
          text: "文献提供了光谱研究的证据。",
          source_ids: candidates.map((c) => c.id),
        },
      ],
    };
  });
  const run = async (snapshot: string, key: string) => {
    const job = await e.app.processors!.submit({
      schema_version: 1,
      idempotency_key: key,
      name: key,
      processor: { id: "knowledge-synthesis", version: "2" },
      spec: { question: "What is known?", policy: "allow-partial" },
      inputs: [{ kind: "snapshot", snapshot_id: snapshot }],
    });
    await e.app.processingTasks!.run(job.job_id);
    const result = await e.app.processingTasks!.read(job.job_id);
    expect(result.failures).toEqual([]);
    return e.app.processorRead!.byId(
      (result.results[0] as { result: { result_id: string } }).result.result_id,
    );
  };
  const one = await e.app.snapshots.create({
    kind: "literatures",
    literature_ids: [id],
  });
  const a = await run(one.snapshot_id, "one-paper");
  expect(a!.result.content.kind).toBe("report");
  expect(summaries).toBe(1);
  expect(reductions).toBe(1);
  const two = await e.app.snapshots.create({
    kind: "literatures",
    literature_ids: [id, secondId],
  });
  const b = await run(two.snapshot_id, "two-papers");
  expect(summaries).toBe(2);
  expect(reductions).toBe(2);
  const content = b!.result.content;
  if (content.kind !== "report") throw new Error("report required");
  expect(content.claims[0]!.sources.every((c) => c.kind === "result")).toBe(
    true,
  );
  const resolved = await e.app.processorRead!.verifyCitation(
    content.claims[0]!.sources[0]!,
  );
  expect(resolved.evidence[0]!.target_kind).toBe("document");
  expect(b!.result.literature_ids).toHaveLength(2);
  expect(b!.freshness?.state).toBe("current");
}, 0);
