import { SqliteProcessorStorage } from "../src/storage/processor-results.js";
import { readFile, writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import {
  parseKnowledgeContextRequest,
  parseKnowledgeContextBundle,
} from "@sciretriever/contracts";
import { KnowledgeContextService } from "../src/retrieval/knowledge-query.js";
import { archiveFixture } from "./archive-fixture.js";
import { createQueryApplication } from "../src/bootstrap/application.js";
import { join } from "node:path";
it("retrieves current processor evidence with scoped, bounded, query-bound pages across new publications", async () => {
  const e = await archiveFixture();
  const store = new SqliteProcessorStorage(
    e.app.database,
    e.app.files,
    e.app.documentRead,
  );
  let query: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
  try {
    await e.app.documentProcessing.parseDocuments(e.rawParseRequest);
    await e.submit("ready");
    e.setModel((input) => ({
      answer: "spectroscopy",
      source_ids: [input.segments![0]!.segment_id],
      reason: null,
    }));
    const create = async (key: string) => {
      const job = await e.app.processors!.submit({
        schema_version: 1,
        idempotency_key: key,
        name: key,
        processor: { id: "labels", version: "2" },
        spec: { question: `What ${key}?`, answer_type: "string" },
        inputs: [{ kind: "literature", literature_id: e.id }],
      });
      await e.app.processingTasks!.run(job.job_id);
      expect((await e.app.processingTasks!.read(job.job_id)).failures).toEqual(
        [],
      );
    };
    await create("first");
    await create("second");
    const service = new KnowledgeContextService(null, store),
      request = parseKnowledgeContextRequest({
        schema_version: 3,
        query: "spectroscopy",
        scope: { kind: "literatures", literature_ids: [e.id] },
        kinds: ["knowledge"],
        versions: { kind: "default" },
        budget: { max_items: 1, max_bytes: 8192, token_limit: null },
        continuation: null,
      });
    const initial = await service.search(request);
    expect(initial.items).toHaveLength(1);
    const item = initial.items[0]!;
    expect(item.kind).toBe("generated-result");
    expect(item.evidence.length).toBeGreaterThan(0);
    expect(item.text).toContain("spectroscopy");
    expect(initial.usage.bytes).toBe(
      Buffer.byteLength(JSON.stringify(initial)),
    );
    expect(parseKnowledgeContextBundle(initial, request)).toEqual(initial);
    await create("third");
    const second = await service.search({
      ...request,
      continuation: initial.continuation,
    });
    expect(second.items).toHaveLength(1);
    expect(second.items[0]!.reference).not.toEqual(item.reference);
    const end = await service.search({
      ...request,
      continuation: second.continuation,
    });
    expect(end.items).toEqual([]);
    expect(end.continuation).toBeNull();
    await expect(
      service.search({
        ...request,
        query: "changed",
        continuation: initial.continuation,
      }),
    ).rejects.toMatchObject({ code: "context-cursor-invalid" });
    const outside = await service.search({
      ...request,
      scope: {
        kind: "literatures",
        literature_ids: ["00000000-0000-0000-0000-000000000999"],
      },
    });
    expect(outside.items).toEqual([]);
    const calls = e.modelCalls;
    await e.app.maintenance!.rebuildIndex();
    query = await createQueryApplication(e.home, {
      catalog_path: join(e.home, "catalog.sqlite"),
      artifact_root: join(e.home, "artifacts"),
    });
    const mixed = await query.knowledgeContext!.search({
      ...request,
      kinds: ["metadata", "document", "knowledge"],
      budget: { ...request.budget, max_items: 20 },
    });
    expect(mixed.items.some((i) => i.kind === "source-text")).toBe(true);
    expect(mixed.items.some((i) => i.kind === "generated-result")).toBe(true);
    expect(e.modelCalls).toBe(calls);
    if (item.kind !== "generated-result") throw new Error("Expected result");
    const stored = await e.app.database.processor<{
        content_reference: string;
      }>("get", item.reference.result_id),
      path = join(e.app.files.root, stored.content_reference),
      bytes = await readFile(path);
    await writeFile(path, "damaged fixture");
    try {
      const healthy = await service.search({
        ...request,
        budget: { ...request.budget, max_items: 20 },
      });
      expect(healthy.items).toHaveLength(2);
      expect(healthy.gaps).toContainEqual({
        code: "result-source-unavailable",
        literature_id: null,
      });
      expect(healthy.coverage).toBe("partial");
    } finally {
      await writeFile(path, bytes);
    }
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
        enter = resolve;
      }),
      hold = new Promise<void>((resolve) => {
        release = resolve;
      }),
      original = store.contextPage.bind(store);
    store.contextPage = async (...args) => {
      enter();
      await hold;
      return original(...args);
    };
    const reading = service.search(request);
    await entered;
    let settled = false;
    const closing = service.close().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    expect((await reading).items).toHaveLength(1);
    await closing;
    expect(() => service.search(request)).toThrow();
    store.contextPage = original;
    await service.close();
  } finally {
    await query?.close();
    await store.close();
    await e.close();
  }
}, 20000);
