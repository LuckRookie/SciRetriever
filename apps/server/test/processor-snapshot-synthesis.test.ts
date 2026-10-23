import { processingJobId } from "../src/application/jobs/processing.js";
import { createQueryApplication } from "../src/bootstrap/application.js";
import { executeQuery } from "../src/entry/query-operations.js";
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
  const query = await createQueryApplication(e.home);
  try {
    const job_id = await processingJobId("two-papers");
    const overall = (await executeQuery(query, "task-run", { job_id })) as {
      items: {
        target_id: string;
        literature_count: number;
        mapped_members: unknown[];
      }[];
    };
    expect(overall.items[0]!.literature_count).toBe(2);
    expect(overall.items[0]!.mapped_members).toEqual([]);
    const target_id = overall.items[0]!.target_id;
    const first = (await executeQuery(query, "task-run", {
      job_id,
      target_id,
      member_offset: 0,
      member_limit: 1,
    })) as {
      items: {
        mapped_members: {
          literature_id: string;
          status: string;
          result: { result_id: string };
        }[];
        next_member_offset: number | null;
      }[];
    };
    expect(first.items[0]!.mapped_members).toHaveLength(1);
    expect(first.items[0]!.next_member_offset).toBe(1);
    const second = (await executeQuery(query, "task-run", {
      job_id,
      target_id,
      member_offset: 1,
      member_limit: 1,
    })) as typeof first;
    expect(second.items[0]!.mapped_members).toHaveLength(1);
    expect(second.items[0]!.next_member_offset).toBeNull();
    const papers = [
      ...first.items[0]!.mapped_members,
      ...second.items[0]!.mapped_members,
    ];
    expect(papers.map((p) => p.literature_id).sort()).toEqual(
      [id, secondId].sort(),
    );
    expect(papers.map((p) => p.status).sort()).toEqual(["computed", "reused"]);
    expect(papers.every((p) => p.result.result_id)).toBe(true);
    await expect(
      executeQuery(query, "task-run", { job_id, target_id, member_limit: 0 }),
    ).rejects.toThrow();
    expect(
      await executeQuery(query, "task-run", {
        job_id,
        target_id: "not-this-job",
        member_limit: 1,
      }),
    ).toMatchObject({ items: [] });
  } finally {
    await query.close();
  }
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
