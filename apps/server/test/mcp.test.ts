import { ParsingFailure } from "../src/parsing/ports.js";
import { processorFixture } from "./processor-fixture.js";
import { FIXTURE_DOI } from "../src/workbench/synthetic-fixture.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { createMcpServer } from "../src/mcp/server.js";
import { coreProcessingFixture } from "./core-processing-fixture.js";
import { createQueryApplication } from "../src/bootstrap/application.js";

async function connected(host: ReturnType<typeof createMcpServer>) {
  const [server, transport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "synthetic-client", version: "1" });
  await host.connect(server);
  await client.connect(transport);
  return client;
}
describe("formal MCP product adapter", () => {
  it("exposes a failed raw parsing attempt and completes the same task after repair and explicit retry", async () => {
    const env = await coreProcessingFixture({ analysisModel: false });
    env.setParseHook(async () => {
      throw new ParsingFailure("parser-unavailable");
    });
    const host = createMcpServer({
      maintenance: true,
      applicationFactory: async () => env.app,
      queryFactory: () => createQueryApplication(env.home),
    });
    const client = await connected(host);
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await client.callTool({ name, arguments: args });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      return (response.structuredContent as { result: Record<string, unknown> })
        .result;
    };
    try {
      const job = await env.app.jobService!.create({
        target_kind: "selector",
        selector: {
          kind: "literatures",
          literature_ids: [env.parseRequest.literature_id],
        },
        goal: "parser",
        policy_version: "fixture",
        policy: { mode: "never", max_retries: 0 },
        idempotency_key: "raw-parser-failure",
      });
      await env.app.taskService!.runJob(job.job_id);
      const failure = {
        failure: {
          code: "completion-parsing-failed",
          reason: expect.any(String),
          action: expect.any(String),
        },
      };
      expect(await call("read_task", { job_id: job.job_id })).toMatchObject({
        job: { status: "completed" },
        targets: [{ stage: "skipped" }],
        skipped: [failure],
        failures: [failure],
      });
      expect(env.parseCalls).toBe(2);
      const detail = await env.app.library.detail(
        env.parseRequest.literature_id,
      );
      env.setText(
        `# ${detail.literature.metadata.title}\n\nThe fixture studies spectroscopy.\n\n# References\n\n1. Fixture reference.\n`,
      );
      env.setParseHook(async () => {});
      await env.reopen();
      await call("control_task", { job_id: job.job_id, action: "retry" });
      await vi.waitFor(async () => {
        const state = await env.app.processingTasks!.read(job.job_id);
        expect(state.targets[0]?.stage, JSON.stringify(state)).toBe(
          "completed",
        );
        expect(state.job.status).toBe("completed");
      });
      const target = (await env.app.jobs!.listTargets(job.job_id))[0]!;
      expect(await env.app.jobs!.listAttempts(target.target_id)).toHaveLength(
        2,
      );
      expect(
        await env.app.library.detail(env.parseRequest.literature_id),
      ).not.toHaveProperty("content");
      expect(await call("read_task", { job_id: job.job_id })).toMatchObject({
        job: { status: "completed" },
        targets: [{ stage: "completed" }],
        failures: [failure],
      });
      expect(env.parseCalls).toBe(4);
      expect(env.modelCalls).toBe(0);
      expect(
        (
          await client.callTool({
            name: "control_task",
            arguments: { job_id: job.job_id, action: "retry" },
          })
        ).isError,
      ).toBe(true);
    } finally {
      await client.close();
      await host.close();
      await env.close();
    }
  });
  it("uses the real protocol client and production graph for parse, identity, summary and snapshot synthesis", async () => {
    const env = await processorFixture();
    env.setText(`# Article\nDOI: ${FIXTURE_DOI}\nA synthetic finding.`);
    const host = createMcpServer({
      maintenance: true,
      applicationFactory: async () => env.app,
      queryFactory: () => createQueryApplication(env.home),
    });
    const client = await connected(host);
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await client.callTool({ name, arguments: args });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      return (response.structuredContent as { result: Record<string, unknown> })
        .result;
    };
    const wait = async (job: string) => {
      await vi.waitFor(
        async () =>
          expect((await env.app.processingTasks!.read(job)).job.status).toBe(
            "completed",
          ),
        { timeout: 10000 },
      );
      return call("read_task", { job_id: job });
    };
    try {
      const parsed = await call("submit_processing", {
        schema_version: 1,
        idempotency_key: "mcp-parse",
        operations: [
          { operation: "parse-documents", request: env.rawParseRequest },
        ],
      });
      expect((await wait(String(parsed.job_id))).results).toHaveLength(1);
      expect(
        (
          await env.app.documentRead.default({
            literature_id: env.parseRequest.literature_id,
            asset_id: env.asset.asset_id,
            asset_sha256: env.asset.sha256,
          })
        ).default,
      ).toBeNull();
      await env.build(env.parseRequest);
      const parseCalls = env.parseCalls;
      env.setModel((input) => {
        if (input.purpose)
          return {
            outcome: "completed",
            title: "Synthetic finding",
            statements: [
              {
                statement_id: "s1",
                category: "finding",
                epistemic: "reported",
                text: "A synthetic finding.",
                conditions: [],
                quantity: null,
                evidence_segment_ids: [input.segments![0]!.segment_id],
              },
            ],
          };
        if (Array.isArray(input.candidates))
          return {
            claims: [
              {
                text: "A synthetic synthesis.",
                source_ids: (input.candidates as { id: string }[]).map(
                  (c) => c.id,
                ),
              },
            ],
          };
        const segment = input.segments!.find((s) => s.text.includes("DOI:"))!;
        return {
          document_kind: "article",
          fields: [
            {
              field: "doi",
              value: FIXTURE_DOI,
              quote: `DOI: ${FIXTURE_DOI}`,
              segment_id: segment.segment_id,
            },
          ],
        };
      });
      const identity = await call("submit_processing", {
        schema_version: 1,
        idempotency_key: "mcp-identity",
        operations: [
          {
            operation: "assess-article-identity",
            request: await env.identityRequest(),
          },
        ],
      });
      await wait(String(identity.job_id));
      expect(
        await call("read_literature", {
          literature_id: env.parseRequest.literature_id,
        }),
      ).toMatchObject({
        primary_pdf: { article_identity_status: "match-supported" },
      });
      const run = async (
        key: string,
        processor: string,
        spec: object,
        inputs: object[],
      ) => {
        const submitted = await call("submit_processor", {
          request: {
            schema_version: 1,
            idempotency_key: key,
            name: key,
            processor: { id: processor, version: "2" },
            spec,
            inputs,
          },
        });
        const job = String(submitted.job_id);
        await wait(job);
        await expect
          .poll(
            async () => (await env.app.processorRead!.collections(job)).length,
          )
          .toBe(1);
        const collections = await env.app.processorRead!.collections(job);
        expect(collections).toHaveLength(1);
        const collection = (await env.app.processorRead!.collection(
          String(collections[0]!.collection_id),
        ))!;
        const ref = collection.members[0]!.result!;
        const saved = await call("processor_query", {
          action: "read",
          request: { result_id: ref.result_id },
        });
        expect(saved).toMatchObject({
          ref,
          result: {
            content: {
              kind: "report",
              claims: [{ sources: expect.any(Array) }],
            },
          },
        });
        return ref;
      };
      for (const purpose of ["overview", "detailed"])
        await run(`mcp-${purpose}`, "summary", { purpose, question: null }, [
          { kind: "literature", literature_id: env.parseRequest.literature_id },
        ]);
      const snapshot = await call("snapshot_create", {
        kind: "literatures",
        literature_ids: [env.parseRequest.literature_id],
      });
      const synthesis = await run(
        "mcp-synthesis",
        "knowledge-synthesis",
        { question: "What was found?", policy: "require-all" },
        [{ kind: "snapshot", snapshot_id: snapshot.snapshot_id }],
      );
      const before = env.modelCalls;
      const evidence = await call("processor_query", {
        action: "evidence",
        request: {
          kind: "result",
          ...synthesis,
          record_id: "claim0",
          pointer: "/text",
        },
      });
      expect(evidence.evidence).not.toHaveLength(0);
      expect(env.modelCalls).toBe(before);
      expect(env.parseCalls).toBe(parseCalls);
    } finally {
      await client.close();
      await host.close();
      await env.close();
    }
  }, 60000);

  it("keeps query mode read-only and reports invalid calls without opening maintenance or leaking exception details", async () => {
    const env = await coreProcessingFixture();
    const maintenance = vi.fn(async () => env.app);
    const host = createMcpServer({
      applicationFactory: maintenance,
      queryFactory: () => createQueryApplication(env.home),
    });
    const client = await connected(host);
    try {
      expect(
        (await client.listTools()).tools.some(
          (t) => t.name === "submit_processing",
        ),
      ).toBe(false);
      const miss = await client.callTool({
        name: "search_library",
        arguments: { text: "No matching material", limit: 10, cursor: null },
      });
      expect(miss.isError).not.toBe(true);
      expect(maintenance).not.toHaveBeenCalled();
      expect(env.parseCalls).toBe(0);
      expect(env.modelCalls).toBe(0);
      expect(
        (await client.callTool({ name: "submit_processing", arguments: {} }))
          .isError,
      ).toBe(true);
      expect(
        (
          await client.callTool({
            name: "read_literature",
            arguments: { literature_id: "invalid", secret: "never echo" },
          })
        ).isError,
      ).toBe(true);
      expect(maintenance).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await host.close();
      await env.close();
    }
  });
});
