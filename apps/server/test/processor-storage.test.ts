import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server.js";
import { runCli } from "../src/cli/main.js";
import { describe, it, expect, vi } from "vitest";
import { coreProcessingFixture } from "./core-processing-fixture.js";
import { createQueryApplication } from "../src/bootstrap/application.js";
import { queryProcessors } from "../src/entry/processor-operations.js";
describe("durable processor batches", () => {
  it("publishes legacy references, immutable member collections and searchable content through the production graph", async () => {
    const env = await coreProcessingFixture();
    try {
      const parsed = await env.app.documentProcessing.parseDocuments(
        env.parseRequest,
      );
      const request = {
        schema_version: 1,
        idempotency_key: "processor-first",
        name: "fixture collection",
        processor: { id: "knowledge-overview", version: "1" },
        spec: {},
        inputs: [
          {
            kind: "document",
            document_version_id: parsed.document.document_version_id,
          },
        ],
      };
      const state = await env.app.processors!.runBatch(request);
      expect(state.failures).toEqual([]);
      expect(state.collections).toHaveLength(1);
      const sameRun = await env.app.processors!.runBatch(request);
      expect(sameRun.job.job_id).toBe(state.job.job_id);
      expect(sameRun.collections).toHaveLength(1);
      const summary = state.collections[0] as {
        collection_id: string;
        computed: number;
        reused: number;
      };
      expect(summary.computed).toBe(1);
      const collection = await env.app.processorRead!.collection(
        summary.collection_id,
      );
      expect(collection!.members).toHaveLength(1);
      const member = collection!.members[0]!.result!;
      const result = await env.app.processorRead!.byId(member.result_id);
      expect(result!.result.content.kind).toBe("knowledge");
      const calls = env.modelCalls;
      const reused = await env.app.processors!.runBatch({
        ...request,
        idempotency_key: "processor-second",
      });
      expect(reused.collections[0]).toMatchObject({ computed: 0, reused: 1 });
      expect(env.modelCalls).toBe(calls);
      const query = await createQueryApplication(env.app.home);
      try {
        expect(query.readiness.status).toBe("ready");
        expect(
          (await query.processorRead!.search("finding")).items.length,
        ).toBeGreaterThan(0);
        expect(
          await queryProcessors(query, "export", {
            result_id: member.result_id,
            format: "json",
          }),
        ).toHaveProperty("content");
        const rows = await query.processorRead!.query({
          collection_id: summary.collection_id,
          result_ids: [],
          filters: [],
          sort: null,
          limit: 20,
          offset: 0,
        });
        expect(rows.items).toHaveLength(1);
        expect(env.modelCalls).toBe(calls);
      } finally {
        await query.close();
      }
    } finally {
      await env.close();
    }
  }, 30000);
  it("submits through the real CLI and MCP boundaries and runs both with the same configured fake model", async () => {
    const env = await coreProcessingFixture();
    let host: ReturnType<typeof createMcpServer> | undefined;
    let client: Client | undefined;
    try {
      const parsed = await env.app.documentProcessing.parseDocuments(
        env.parseRequest,
      );
      env.setModel((input) => ({
        answer: true,
        source_ids: [input.segments![0]!.segment_id],
        reason: null,
      }));
      const request = {
        schema_version: 1,
        idempotency_key: "cli-processor",
        name: "interface batch",
        processor: { id: "labels", version: "1" },
        spec: { question: "a finding", answer_type: "boolean" },
        inputs: [
          {
            kind: "document",
            document_version_id: parsed.document.document_version_id,
          },
        ],
      };
      const path = join(env.home, "processor-request.json");
      await writeFile(path, JSON.stringify(request));
      const submitted = await runCli(
        ["processors", "submit", "--request", path],
        { home: env.home },
      );
      expect(submitted.code).toBe(0);
      expect(env.modelCalls).toBe(0);
      const job = submitted.value as { job_id: string };
      const cliRun = await env.app.processingTasks!.run(job.job_id);
      expect(cliRun.collections[0]).toMatchObject({ computed: 1, reused: 0 });
      host = createMcpServer({
        maintenance: true,
        applicationFactory: async () => env.app,
        queryFactory: () => createQueryApplication(env.home),
      });
      const [server, transport] = InMemoryTransport.createLinkedPair();
      client = new Client({ name: "processor-submit-fixture", version: "1" });
      await host.connect(server);
      await client.connect(transport);
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(
        expect.arrayContaining([
          "submit_processor",
          "processor_query",
          "retain_extraction",
          "rebuild_processor_index",
        ]),
      );
      const response = await client.callTool({
        name: "submit_processor",
        arguments: {
          request: { ...request, idempotency_key: "mcp-processor" },
        },
      });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      const mcpJob = (
        response.structuredContent as { result: { job_id: string } }
      ).result;
      await vi.waitFor(
        async () => {
          const state = await env.app.processingTasks!.read(mcpJob.job_id);
          expect(state.collections[0]).toMatchObject({
            computed: 0,
            reused: 1,
            failed: 0,
          });
        },
        { timeout: 15000, interval: 100 },
      );
      expect(env.modelCalls).toBe(1);
    } finally {
      await client?.close();
      await host?.close();
      await env.close();
    }
  }, 30000);
  it.each([
    ["knowledge-overview", {}, "overview"],
    ["knowledge-detailed", {}, "detailed"],
    ["knowledge-question", { question: "What was measured?" }, "question"],
    ["knowledge-long", { purpose: "overview" }, "overview"],
  ] as const)(
    "keeps the legacy owner and readable evidence for %s",
    async (id, spec, purpose) => {
      const env = await coreProcessingFixture();
      try {
        const doc = await env.app.documentProcessing.parseDocuments(
          env.parseRequest,
        );
        if (id === "knowledge-long")
          env.setModel((input) => {
            if (Array.isArray(input.core))
              return {
                outcome: "completed",
                title: "Long fixture",
                statements: [
                  {
                    statement_id: "s1",
                    category: "finding",
                    epistemic: "reported",
                    text: "A synthetic finding.",
                    conditions: [],
                    quantity: null,
                    evidence_segment_ids: [
                      (input.core as { segment_id: string }[])[0]!.segment_id,
                    ],
                  },
                ],
              };
            const candidates = input.candidates as {
              id: string;
              category: string;
              epistemic: string;
              text: string;
              conditions: string[];
              quantity: unknown;
            }[];
            return {
              outcome: "completed",
              title: "Merged fixture",
              statements: candidates.map((c, i) => ({
                statement_id: `s${i}`,
                category: c.category,
                epistemic: c.epistemic,
                text: c.text,
                conditions: c.conditions,
                quantity: c.quantity,
                source_ids: [c.id],
              })),
            };
          });
        const state = await env.app.processors!.runBatch({
          schema_version: 1,
          idempotency_key: id,
          name: id,
          processor: { id, version: "1" },
          spec,
          inputs: [
            {
              kind: "document",
              document_version_id: doc.document.document_version_id,
            },
          ],
        });
        expect(state.failures, JSON.stringify(state.failures)).toEqual([]);
        const ref = (
          state.results[0] as {
            result: { result_id: string; content_sha256: string };
          }
        ).result;
        const saved = await env.app.processorRead!.byId(ref.result_id);
        expect(saved!.result.content.kind).toBe("knowledge");
        if (saved!.result.content.kind !== "knowledge")
          throw new Error("expected legacy reference");
        const source = await env.app.synthesisRead!.sourceById(
          saved!.result.content.artifact_id,
        );
        expect(source!.artifact.purpose).toBe(purpose);
        expect(source!.artifact.content_ref.sha256).toBe(
          saved!.result.content.content_sha256,
        );
        const records = await env.app.processorRead!.records({
          kind: "result",
          input_id: "r",
          ...ref,
          record_ids: null,
        });
        expect(records.length).toBeGreaterThan(0);
        const resolved = await env.app.processorRead!.verifyCitation(
          records[0]!.citation,
        );
        expect(resolved.literature_ids).toEqual([
          env.parseRequest.literature_id,
        ]);
        expect(resolved.evidence.length).toBeGreaterThan(0);
      } finally {
        await env.close();
      }
    },
    30000,
  );
});
