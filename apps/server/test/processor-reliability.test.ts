import { ProcessorArchiveSource } from "../src/analysis/processor-archive.js";
import { SqliteAnnotationStorage } from "../src/storage/structure-annotations.js";
import { describe, it, expect, vi } from "vitest";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { writeFile } from "node:fs/promises";
import { processorFixture as coreProcessingFixture } from "./processor-fixture.js";
import { ProcessorService } from "../src/analysis/processor.js";
import { createProcessorRegistry } from "../src/analysis/processor-registry.js";
import { labelsProcessor } from "../src/analysis/processor-labels.js";
import { SqliteProcessorStorage } from "../src/storage/processor-results.js";
import type { ProcessorStorageAction } from "../src/storage/sqlite/processor-engine.js";
describe("processor publication and recovery", () => {
  it("shares verified upstream records within one operation and verifies them again on the next read", async () => {
    const env = await coreProcessingFixture();
    let store: SqliteProcessorStorage | undefined;
    try {
      env.setText("The sample was measured.");
      await env.build(env.parseRequest);
      env.setModel((input) => ({
        records: Array.from({ length: 12 }, () => ({
          values: { note: "The sample was measured." },
          evidence: { note: [input.segments![0]!.segment_id] },
          missing: { note: null },
        })),
      }));
      const state = await env.app.processors!.runBatch({
        schema_version: 1,
        idempotency_key: "shared-verification",
        name: "shared evidence",
        processor: { id: "records", version: "2" },
        spec: {
          record_meaning: "synthetic observations sharing a source",
          fields: [{ name: "note", description: "observation" }],
        },
        inputs: [
          {
            kind: "literature",
            literature_id: env.parseRequest.literature_id,
          },
        ],
      });
      expect(state.failures).toEqual([]);
      const summary = state.collections.at(-1) as { collection_id: string };
      const collection = await env.app.processorRead!.collection(
        summary.collection_id,
      );
      const ref = collection!.members[0]!.result!;
      const citations = Array.from({ length: 12 }, (_, i) => ({
        kind: "result" as const,
        ...ref,
        record_id: `r${i}`,
        pointer: "/note",
      }));
      store = new SqliteProcessorStorage(
        env.app.database,
        env.app.files,
        env.app.documentRead,
      );
      const resolve = vi.spyOn(env.app.documentRead, "resolveEvidence");
      expect(await store.verifyCitations(citations)).toHaveLength(12);
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(await store.verifyCitations(citations)).toHaveLength(12);
      expect(resolve).toHaveBeenCalledTimes(2);
      await expect(
        store.verifyCitations([
          citations[0]!,
          { ...citations[0]!, content_sha256: "0".repeat(64) },
        ]),
      ).rejects.toMatchObject({ code: "processor-input-changed" });
      resolve.mockClear();
      expect((await store.search("sample")).items).toHaveLength(12);
      expect(resolve).toHaveBeenCalledTimes(1);
      expect((await store.search("sample")).items).toHaveLength(12);
      expect(resolve).toHaveBeenCalledTimes(2);
      const row = await env.app.database.processor<{
        content_reference: string;
      }>("get", ref.result_id);
      await writeFile(
        join(env.home, "artifacts", row.content_reference),
        "synthetic corruption after a successful search",
      );
      await expect(store.search("sample")).rejects.toThrow();
    } finally {
      await store?.close();
      await env.close();
    }
  }, 30000);
  it("keeps committed content after indexing failure, repairs on retry, and refuses corrupted reuse", async () => {
    const env = await coreProcessingFixture();
    try {
      await env.build(env.parseRequest);
      env.setModel((input) => ({
        answer: true,
        source_ids: [input.segments![0]!.segment_id],
        reason: null,
      }));
      const request = {
        schema_version: 1,
        idempotency_key: "index-failure",
        name: "index repair",
        processor: { id: "labels", version: "2" },
        spec: { question: "finding", answer_type: "boolean" },
        inputs: [
          {
            kind: "literature",
            literature_id: env.parseRequest.literature_id,
          },
        ],
      };
      const original = env.app.database.processor.bind(env.app.database);
      let fail = true;
      const spy = vi
        .spyOn(env.app.database, "processor")
        .mockImplementation(
          async <T>(
            action: ProcessorStorageAction,
            args: unknown,
            signal?: AbortSignal,
          ): Promise<T> => {
            if (action === "project" && fail) {
              fail = false;
              throw Object.assign(new Error("synthetic projection failure"), {
                code: "processor-index-unavailable",
              });
            }
            return original<T>(action, args, signal);
          },
        );
      const failed = await env.app.processors!.runBatch(request);
      expect(failed.targets[0]!.stage).toBe("failed");
      const calls = env.modelCalls;
      const rows = await env.app.processorRead!.list();
      expect(rows.items).toHaveLength(1);
      const id = String(rows.items[0]!.result_id);
      expect(await env.app.processorRead!.byId(id)).not.toBeNull();
      spy.mockRestore();
      await env.app.processingTasks!.control(failed.job.job_id, "retry");
      const repaired = await env.app.processingTasks!.run(failed.job.job_id);
      expect(repaired.collections.at(-1)).toMatchObject({
        reused: 1,
        computed: 0,
        failed: 0,
      });
      expect(env.modelCalls).toBe(calls);
      const db = new DatabaseSync(join(env.home, "catalog.sqlite"), {
        readOnly: true,
      });
      let reference: string;
      try {
        reference = String(
          (
            db
              .prepare(
                "SELECT content_reference FROM processor_results WHERE result_id=?",
              )
              .get(id) as { content_reference: string }
          ).content_reference,
        );
      } finally {
        db.close();
      }
      await writeFile(
        join(env.home, "artifacts", reference),
        "synthetic corruption",
      );
      const rejected = await env.app.processors!.runBatch({
        ...request,
        idempotency_key: "corrupt-reuse",
      });
      expect(rejected.targets[0]!.stage).toBe("failed");
      expect(env.modelCalls).toBe(calls);
    } finally {
      await env.close();
    }
  }, 60000);
  it("converges simultaneous complete publications and keys reuse by processor version and specification", async () => {
    const env = await coreProcessingFixture();
    let service: ProcessorService | undefined;
    let store: SqliteProcessorStorage | undefined;
    try {
      await env.build(env.parseRequest);
      env.setModel((input) => ({
        answer: true,
        source_ids: [input.segments![0]!.segment_id],
        reason: null,
      }));
      store = new SqliteProcessorStorage(
        env.app.database,
        env.app.files,
        env.app.documentRead,
      );
      const registry = createProcessorRegistry();
      registry.register({ ...labelsProcessor, version: "3" });
      service = new ProcessorService(
        registry,
        env.app.documentRead,
        env.app.agents,
        env.app.library,
        store,
        new ProcessorArchiveSource(
          env.app.archive,
          env.app.snapshots,
          new SqliteAnnotationStorage(env.app.database, env.app.files),
          env.app.documentRead,
        ),
      );
      const request = {
        schema_version: 1,
        idempotency_key: "concurrent",
        name: "concurrent",
        processor: { id: "labels", version: "2" },
        spec: { question: "finding", answer_type: "boolean" },
        inputs: [
          {
            kind: "literature",
            literature_id: env.parseRequest.literature_id,
          },
        ],
      };
      const prepared = await service.prepare(request);
      const results = await Promise.all([
        service.execute(prepared.invocations[0]),
        service.execute(prepared.invocations[0]),
      ]);
      expect(results[0]!.result_id).toBe(results[1]!.result_id);
      expect(results.filter((r) => r.reused)).toHaveLength(1);
      const changed = await service.prepare({
        ...request,
        processor: { id: "labels", version: "3" },
      });
      const newer = await service.execute(changed.invocations[0]);
      expect(newer.result_id).not.toBe(results[0]!.result_id);
      const changedSpec = await service.prepare({
        ...request,
        spec: { ...request.spec, question: "a different finding" },
      });
      expect(
        (await service.execute(changedSpec.invocations[0])).result_id,
      ).not.toBe(results[0]!.result_id);
      expect((await store.list()).items).toHaveLength(3);
    } finally {
      await service?.close();
      await store?.close();
      await env.close();
    }
  }, 60000);
});
