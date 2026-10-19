import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  parseEvidenceRef,
  parseProcessorInvocation,
  parseProcessorResult,
  processorComparison,
  processorResultBytes,
  sha256,
  type ProcessorInput,
  type ProcessorResult,
  type ProcessorCitation,
} from "@sciretriever/contracts";
import { coreProcessingFixture } from "./core-processing-fixture.js";
import {
  ProcessorRegistry,
  ProcessorService,
  type ProcessorStore,
  type StoredProcessorResult,
} from "../src/analysis/processor.js";
import { registerKnowledgeProcessors } from "../src/analysis/processor-knowledge.js";
import { synthesisProcessor } from "../src/analysis/processor-synthesis.js";

describe("processor adapters", () => {
  it("keeps legacy analysis references and composes records without inventing knowledge artifacts", async () => {
    const env = await coreProcessingFixture();
    let service: ProcessorService | undefined;
    try {
      const parsed = await env.app.documentProcessing.parseDocuments(
        env.parseRequest,
      );
      const described = await env.app.documentRead.describe({
        document_version_id: parsed.document.document_version_id,
      });
      const sourceInput: ProcessorInput = {
        kind: "document",
        input_id: "document",
        document: described.document,
      };
      const segments = await env.app.documentRead.segments({
        document_version_id: described.document.document_version_id,
        section_id: null,
        cursor: null,
        limit: 20,
      });
      const segment = segments.segments[0]!;
      const evidence = await env.app.documentRead.withVerifiedVersion(
        described.document.document_version_id,
        async (version, bytes) =>
          parseEvidenceRef({
            schema_version: 1,
            target_kind: "document",
            locator_scheme: "utf8-segment-v1",
            document_version_id: version.document_version_id,
            representation_sha256: version.representation_sha256,
            locator: { kind: "segment", segment_id: segment.segment_id },
            content_sha256: await sha256(
              bytes.subarray(segment.start_utf8, segment.end_utf8),
            ),
          }),
      );
      const pool = new Map<string, StoredProcessorResult>();
      const save = async (result: ProcessorResult) => {
        const checked = await parseProcessorResult(result);
        const stored = {
          result: checked,
          ref: {
            result_id: checked.result_id,
            content_sha256: await sha256(processorResultBytes(checked)),
          },
        };
        pool.set(checked.result_id, stored);
        return stored;
      };
      const store: ProcessorStore = {
        byId: async (id) => pool.get(id) ?? null,
        byComparison: async (hash) =>
          [...pool.values()].find(
            (s) =>
              s.result.comparison_sha256 === hash &&
              s.result.producer === "internal" &&
              s.result.coverage.every((c) => c.status === "complete"),
          ) ?? null,
        publish: save,
        records: async (input) => {
          if (input.kind !== "result") throw new Error("unexpected input");
          const stored = pool.get(input.result_id)!;
          if (
            stored.ref.content_sha256 !== input.content_sha256 ||
            stored.result.content.kind !== "records"
          )
            throw new Error("invalid result input");
          return stored.result.content.records.map((record) => ({
            record_id: record.record_id,
            payload: record.payload,
            literature_ids: stored.result.literature_ids,
            citation: {
              kind: "result" as const,
              ...stored.ref,
              record_id: record.record_id,
              pointer: "",
            },
          }));
        },
        verifyCitations: async (citations) => {
          const sources = [];
          for (const citation of citations) {
            if (citation.kind === "document")
              await env.app.documentRead.resolveEvidence(citation.evidence);
            sources.push({ literature_ids: [env.parseRequest.literature_id] });
          }
          return sources;
        },
        publishCollection: async () => randomUUID(),
      };
      const registry = new ProcessorRegistry();
      registerKnowledgeProcessors(registry, env.app.knowledgeAnalysis);
      registry.register(synthesisProcessor(env.app.knowledgeAnalysis));
      service = new ProcessorService(
        registry,
        env.app.documentRead,
        env.app.agents,
        env.app.library,
        store,
        env.app.synthesisRead!,
      );
      const request = {
        schema_version: 1,
        idempotency_key: "fixture",
        name: "fixture",
        processor: { id: "knowledge-overview", version: "1" },
        spec: {},
        inputs: [
          {
            kind: "document",
            document_version_id: described.document.document_version_id,
          },
        ],
      };
      const prepared = await service.prepare(request);
      const legacy = await service.execute(prepared.invocations[0]);
      expect(pool.get(legacy.result_id)?.result.content.kind).toBe("knowledge");
      const calls = env.modelCalls;
      expect((await service.execute(prepared.invocations[0])).reused).toBe(
        true,
      );
      expect(env.modelCalls).toBe(calls);
      await expect(
        service.execute({
          ...prepared.invocations[0],
          execution: {
            ...prepared.invocations[0]!.execution,
            model: { model: "different" },
          },
        }),
      ).rejects.toMatchObject({ code: "processor-binding-changed" });
      const invocation = parseProcessorInvocation({
        schema_version: 1,
        processor: { id: "external", version: "1" },
        spec: {},
        inputs: [sourceInput],
        execution: { method_sha256: "a".repeat(64), model: null },
      });
      const source = await save(
        await parseProcessorResult({
          schema_version: 1,
          result_id: randomUUID(),
          invocation,
          comparison_sha256: await processorComparison(invocation),
          status: "ok",
          producer: "external",
          provenance: {},
          literature_ids: [env.parseRequest.literature_id],
          created_at: new Date().toISOString(),
          content: {
            kind: "records",
            schema: { type: "object" },
            records: [
              {
                record_id: "r1",
                payload: { temperature: 25 },
                evidence: [
                  { pointer: "", sources: [{ kind: "document", evidence }] },
                ],
                missing: {},
              },
            ],
          },
          coverage: [
            {
              input_id: "document",
              status: "partial",
              read_segments: [],
              gaps: ["table-unreadable"],
            },
          ],
        }),
      );
      env.setModel((input) => ({
        statements: [
          {
            text: "The record reports 25 degrees.",
            source_ids: [(input.candidates as { id: string }[])[0]!.id],
          },
        ],
      }));
      const next = await service.prepare({
        ...request,
        processor: { id: "knowledge-synthesis", version: "1" },
        spec: { question: "conditions", policy: "allow-partial" },
        inputs: [
          { kind: "result", result_id: source.ref.result_id, record_ids: null },
        ],
      });
      const combined = await service.execute(next.invocations[0]);
      const result = pool.get(combined.result_id)!.result;
      expect(result.coverage[0]?.status).toBe("partial");
      expect(result.literature_ids).toEqual([env.parseRequest.literature_id]);
      expect(result.content.kind).toBe("records");
      if (result.content.kind === "records") {
        const citation = result.content.records[0]!.evidence[0]!
          .sources[0] as Extract<ProcessorCitation, { kind: "result" }>;
        expect(citation.result_id).toBe(source.ref.result_id);
        expect(citation.record_id).toBe("r1");
      }
      const strict = await service.prepare({
        ...request,
        processor: { id: "knowledge-synthesis", version: "1" },
        spec: { question: "conditions", policy: "require-all" },
        inputs: [
          { kind: "result", result_id: source.ref.result_id, record_ids: null },
        ],
      });
      await expect(
        service.execute(strict.invocations[0]),
      ).rejects.toMatchObject({ code: "processor-incomplete-input" });
    } finally {
      await service?.close();
      await env.close();
    }
  });
});
