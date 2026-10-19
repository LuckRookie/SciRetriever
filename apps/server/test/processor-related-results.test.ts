import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  parseProcessorInvocation,
  parseProcessorResult,
  processorComparison,
  type ProcessorInput,
  type ProcessorCitation,
} from "@sciretriever/contracts";
import { coreProcessingFixture } from "./core-processing-fixture.js";
import { SqliteProcessorStorage } from "../src/storage/processor-results.js";
it("finds related results through immutable document, knowledge and result inputs, including unknown records without fabricated evidence", async () => {
  const env = await coreProcessingFixture();
  try {
    const parsed = await env.app.documentProcessing.parseDocuments(
      env.parseRequest,
    );
    const batch = await env.app.processors!.runBatch({
      schema_version: 1,
      idempotency_key: "related-knowledge",
      name: "Related knowledge",
      processor: { id: "knowledge-overview", version: "1" },
      spec: {},
      inputs: [
        {
          kind: "document",
          document_version_id: parsed.document.document_version_id,
        },
      ],
    });
    expect(batch.failures).toEqual([]);
    const collection = await env.app.processorRead!.collection(
      String((batch.collections[0] as { collection_id: string }).collection_id),
    );
    const originalRef = collection!.members[0]!.result!;
    const original = (await env.app.processorRead!.byId(originalRef.result_id))!
      .result;
    if (original.content.kind !== "knowledge")
      throw new Error("expected knowledge reference");
    const knowledge = original.content;
    const artifact = await env.app.synthesisRead!.sourceById(
      knowledge.artifact_id,
    );
    const store = new SqliteProcessorStorage(
      env.app.database,
      env.app.files,
      env.app.documentRead,
      env.app.synthesisRead!,
    );
    const publish = async (
      input: ProcessorInput,
      sources: ProcessorCitation[],
    ) => {
      const invocation = parseProcessorInvocation({
        schema_version: 1,
        processor: { id: "related-fixture", version: "1" },
        spec: {},
        inputs: [input],
        execution: { method_sha256: "a".repeat(64), model: null },
      });
      return store.publish(
        await parseProcessorResult({
          schema_version: 1,
          result_id: randomUUID(),
          invocation,
          comparison_sha256: await processorComparison(invocation),
          status: "ok",
          producer: "external",
          literature_ids: sources.length
            ? [env.parseRequest.literature_id]
            : [],
          created_at: "2026-10-19T00:00:00.000Z",
          provenance: { fixture: true },
          content: {
            kind: "records",
            schema: {
              type: "object",
              properties: { finding: { type: ["string", "null"] } },
            },
            records: [
              {
                record_id: "r1",
                payload: {
                  finding: sources.length ? "A synthetic finding." : null,
                },
                evidence: sources.length
                  ? [{ pointer: "/finding", sources }]
                  : [],
                missing: sources.length ? {} : { "/finding": "unknown" },
              },
            ],
          },
          coverage: [
            {
              input_id: "input",
              status: "partial",
              read_segments: [],
              gaps: ["fixture"],
            },
          ],
        }),
      );
    };
    const first = await publish(
      {
        kind: "knowledge",
        input_id: "input",
        artifact_id: knowledge.artifact_id,
        content_sha256: knowledge.content_sha256,
      },
      [
        {
          kind: "knowledge",
          artifact_id: knowledge.artifact_id,
          content_sha256: knowledge.content_sha256,
          statement_id: artifact!.artifact.content.statements[0]!.statement_id,
        },
      ],
    );
    const second = await publish(
      { kind: "result", input_id: "input", ...first.ref, record_ids: ["r1"] },
      [{ kind: "result", ...first.ref, record_id: "r1", pointer: "/finding" }],
    );
    const unknown = await publish(
      {
        kind: "document",
        input_id: "input",
        document: (
          await env.app.documentRead.describe({
            document_version_id: parsed.document.document_version_id,
          })
        ).document,
      },
      [],
    );
    const calls = env.modelCalls;
    const ids: string[] = [];
    let after = "";
    do {
      const page = await store.list(
        1,
        after,
        undefined,
        env.parseRequest.literature_id,
      );
      ids.push(...page.items.map((item) => String(item.result_id)));
      after = page.next_after ?? "";
    } while (after);
    expect(ids).toEqual(
      [
        originalRef.result_id,
        first.ref.result_id,
        second.ref.result_id,
        unknown.ref.result_id,
      ].sort(),
    );
    expect(await store.list(20, "", undefined, randomUUID())).toEqual({
      items: [],
      next_after: null,
    });
    expect(env.modelCalls).toBe(calls);
    await expect(store.list(20, "", undefined, "invalid")).rejects.toThrow();
  } finally {
    await env.close();
  }
}, 45000);
