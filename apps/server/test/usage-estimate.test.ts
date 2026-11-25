import { expect, it } from "vitest";
import { processorFixture } from "./processor-fixture.js";
import { createQueryApplication } from "../src/bootstrap/application.js";
import { executeQuery } from "../src/entry/query-operations.js";

it(
  "estimates without models or writes and shares exact input/spec/model reuse with execution",
  { timeout: 0 },
  async () => {
    const e = await processorFixture();
    try {
      await e.build(e.parseRequest);
      const id = e.parseRequest.literature_id,
        request = {
          schema_version: 1,
          idempotency_key: "estimate-summary",
          name: "Estimate",
          processor: { id: "summary", version: "2" },
          spec: {},
          inputs: [{ kind: "literature", literature_id: id }],
        };
      const q = await createQueryApplication(e.home);
      try {
        const beforeCalls = e.modelCalls,
          beforeJobs = await e.app.jobs!.listJobs();
        expect(
          await executeQuery(q, "usage-estimate", {
            kind: "processor",
            request,
          }),
        ).toMatchObject({
          count: 1,
          reused_count: 0,
          available: false,
          components: [
            { sample_count: 0, input_tokens: null, output_tokens: null },
          ],
        });
        expect(e.modelCalls).toBe(beforeCalls);
        expect(await e.app.jobs!.listJobs()).toEqual(beforeJobs);
        const run = await e.app.processors!.runBatch(request);
        expect(run.failures).toEqual([]);
        const calls = e.modelCalls;
        const task = (await e.app.jobs!.listJobs())[0]!;
        const processingRequest = (task.selector as { request: unknown })
          .request;
        expect(
          await executeQuery(q, "usage-estimate", {
            kind: "processing",
            request: processingRequest,
          }),
        ).toMatchObject({
          operation_count: 1,
          available: true,
          components: [{ input_tokens: [0, 0], output_tokens: [0, 0] }],
        });
        expect(
          await executeQuery(q, "usage-estimate", {
            kind: "processor",
            request,
          }),
        ).toMatchObject({
          count: 1,
          reused_count: 1,
          available: true,
          components: [{ input_tokens: [0, 0], output_tokens: [0, 0] }],
        });
        expect(
          await executeQuery(q, "usage-estimate", {
            kind: "processor",
            request: {
              ...request,
              spec: { purpose: "detailed", question: null },
            },
          }),
        ).toMatchObject({
          count: 1,
          reused_count: 0,
          available: true,
          components: [
            {
              sample_count: 1,
              input_tokens: [100, 100],
              output_tokens: [50, 50],
            },
          ],
        });
        const snapshot = await e.app.snapshots.create({
          kind: "literatures",
          literature_ids: [id],
        });
        expect(
          await executeQuery(q, "usage-estimate", {
            kind: "processor",
            request: {
              ...request,
              processor: { id: "knowledge-synthesis", version: "2" },
              spec: { question: "What is reported?", policy: "require-all" },
              inputs: [{ kind: "snapshot", snapshot_id: snapshot.snapshot_id }],
            },
          }),
        ).toMatchObject({
          count: 1,
          reused_count: 1,
          available: false,
          components: [
            { kind: "mapped-documents", input_tokens: [0, 0] },
            { kind: "synthesis", input_tokens: null },
          ],
        });
        expect(e.modelCalls).toBe(calls);
      } finally {
        await q.close();
      }
    } finally {
      await e.close();
    }
  },
);

it(
  "lists runs by operator, snapshot, literature and freshness without mixing source IDs",
  { timeout: 0 },
  async () => {
    const e = await processorFixture();
    try {
      await e.build(e.parseRequest);
      const id = e.parseRequest.literature_id;
      const snap = await e.app.snapshots.create({
        kind: "literatures",
        literature_ids: [id],
      });
      const req = {
        schema_version: 1,
        idempotency_key: "run-list",
        name: "Named run",
        processor: { id: "summary", version: "2" },
        spec: {},
        inputs: [{ kind: "snapshot", snapshot_id: snap.snapshot_id }],
      };
      const run = await e.app.processors!.runBatch(req);
      expect(run.failures).toEqual([]);
      const q = await createQueryApplication(e.home);
      try {
        const found = (await executeQuery(q, "processor-runs", {
          processor_id: "summary",
          snapshot_id: snap.snapshot_id,
          literature_id: id,
          stale: false,
        })) as {
          items: { collection_id: string; outcomes: unknown; stale: boolean }[];
        };
        expect(found.items).toHaveLength(1);
        expect(found.items[0]!.outcomes).toEqual({
          with_result: 1,
          empty: 0,
          incomplete: 0,
        });
        const paper = (await executeQuery(q, "literature-results", {
          literature_id: id,
        })) as { items: { result_id: string; freshness: string }[] };
        expect(paper.items).toHaveLength(1);
        const before = (await e.app.archive.status(id)).parts[0]!,
          text = await e.app.proofreading!.editor({
            asset_id: before.asset_id,
          });
        const { executeMaintenance } = await import(
          "../src/entry/maintenance-operations.js"
        );
        const { SqliteArchiveTextStorage } = await import(
          "../src/storage/archive-text.js"
        );
        const current = (await new SqliteArchiveTextStorage(
          e.app.database,
          e.app.files,
        ).load(before.proofread_id!))!;
        await executeMaintenance(e.app, "proofread-save", {
          schema_version: 2,
          literature_id: id,
          asset_id: before.asset_id,
          proofread_id: before.proofread_id,
          expected_arrangement_id: current.version.arrangement_id,
          expected_manual_revision: 0,
          markdown: text.text.replace(
            "A synthetic finding.",
            "A revised synthetic finding.",
          ),
          actor: "fixture",
        });
        expect(
          await executeQuery(q, "processor-runs", {
            snapshot_id: snap.snapshot_id,
            stale: true,
          }),
        ).toMatchObject({
          items: [
            { collection_id: found.items[0]!.collection_id, stale: true },
          ],
        });
        expect(
          await executeQuery(q, "literature-results", { literature_id: id }),
        ).toMatchObject({
          items: [{ result_id: paper.items[0]!.result_id, freshness: "stale" }],
        });
        expect(
          await executeQuery(q, "processor-runs", { processor_id: "records" }),
        ).toMatchObject({ items: [] });
      } finally {
        await q.close();
      }
    } finally {
      await e.close();
    }
  },
);

it(
  "counts a fully reusable archive with the same step and model identities used by execution",
  { timeout: 0 },
  async () => {
    const e = await processorFixture();
    try {
      await e.build(e.parseRequest);
      const { ArchiveReusePreview } = await import("../src/archive/reuse.js"),
        { SqliteArchiveTextStorage } = await import(
          "../src/storage/archive-text.js"
        ),
        { canonicalJsonBytes, sha256 } = await import(
          "@sciretriever/contracts"
        );
      const state = await e.app.archive.status(e.parseRequest.literature_id),
        proof = await new SqliteArchiveTextStorage(
          e.app.database,
          e.app.files,
        ).load(state.parts[0]!.proofread_id!);
      const preview = new ArchiveReusePreview(
        e.app.database,
        e.app.files,
        e.app.rawParseStorage!,
        e.app.tags,
        e.app.agents,
        await sha256(
          canonicalJsonBytes({
            method: "archive-arrange-v2",
            proofread: { model: e.app.configuration.proofread.model },
            models: e.app.configuration.models,
            analyze: e.app.configuration.analyze,
            tags: e.app.configuration.tags,
          }),
        ),
        e.app.configuration.parsing.archive_profile,
        proof!.version.method.page_classify,
        e.app.configuration.translation.target_language,
      );
      expect(await preview.reusable(state, new AbortController().signal)).toBe(
        true,
      );
      const before = e.modelCalls;
      const job = await e.app.archive.build({
        schema_version: 2,
        selector: {
          kind: "literatures",
          literature_ids: [e.parseRequest.literature_id],
        },
        mode: "full",
        from_step: null,
        idempotency_key: "reused-archive",
      });
      await e.app.processingTasks!.run(job.job!.job_id);
      expect(e.modelCalls).toBe(before);
      const progress = await e.app.database.review<{
        items: { steps: { step: string; status: string }[] }[];
      }>("task-run", { job_id: job.job!.job_id });
      expect(progress.items[0]!.steps.map((s) => s.step).sort()).toEqual([
        "arrange",
        "metadata",
        "proofread",
        "references",
        "render",
        "tags",
        "translate",
      ]);
      expect(progress.items[0]!.steps.every((s) => s.status === "done")).toBe(
        true,
      );
    } finally {
      await e.close();
    }
  },
);
