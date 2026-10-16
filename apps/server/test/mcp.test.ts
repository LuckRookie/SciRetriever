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
  it("exposes a legacy skipped failure and completes the same task after configuration repair and explicit retry", async () => {
    const env = await coreProcessingFixture({ analysisModel: false });
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
        goal: "content",
        policy_version: "fixture",
        policy: { mode: "never", max_retries: 0 },
        idempotency_key: "missing-content-config",
      });
      await env.app.taskService!.runJob(job.job_id);
      const failure = {
        failure: {
          code: "content-completion-unavailable",
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
      expect(env.parseCalls).toBe(0);
      const detail = await env.app.library.detail(
        env.parseRequest.literature_id,
      );
      env.setText(
        `# ${detail.literature.metadata.title}\n\nThe fixture studies spectroscopy.\n\n# References\n\n1. Fixture reference.\n`,
      );
      await env.enableLegacyAnalysis();
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
        (await env.app.library.detail(env.parseRequest.literature_id)).content,
      ).not.toBeNull();
      expect(await call("read_task", { job_id: job.job_id })).toMatchObject({
        job: { status: "completed" },
        targets: [{ stage: "completed" }],
        failures: [failure],
      });
      expect(env.parseCalls).toBe(1);
      expect(env.modelCalls).toBe(2);
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
  it("uses the real protocol client and production graph for parse, identity, analysis and durable result retrieval", async () => {
    const env = await coreProcessingFixture();
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
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toContain("submit_processing");
      const submitted = await call("submit_processing", {
        schema_version: 1,
        idempotency_key: "mcp-parse",
        operations: [
          { operation: "parse-documents", request: env.parseRequest },
        ],
      });
      const jobId = submitted.job_id as string;
      await vi.waitFor(async () =>
        expect((await env.app.processingTasks!.read(jobId)).job.status).toBe(
          "completed",
        ),
      );
      const result = await call("read_task", { job_id: jobId });
      expect(result.results).toHaveLength(1);
      const prepared = await call("prepare_analysis_inputs", {
        literature_ids: [env.parseRequest.literature_id],
      });
      const knowledge = await call("submit_processing", {
        schema_version: 1,
        idempotency_key: "mcp-analysis",
        operations: [
          {
            operation: "analyze",
            request: {
              schema_version: 1,
              input: prepared.input,
              purpose: "overview",
              question: null,
              default_update: null,
              budget: { max_input_bytes: 65536, max_output_tokens: 2048 },
            },
          },
          {
            operation: "assess-article-identity",
            request: await env.identityRequest(),
          },
        ],
      });
      await vi.waitFor(async () =>
        expect(
          (await env.app.processingTasks!.read(knowledge.job_id as string)).job
            .status,
        ).toBe("completed"),
      );
      const saved = await env.app.processingTasks!.read(
        knowledge.job_id as string,
      );
      expect(saved.results).toHaveLength(2);
      const artifact = (saved.results[0] as { result: { artifact_id: string } })
        .result.artifact_id;
      expect(
        await call("read_knowledge", { kind: "single", artifact_id: artifact }),
      ).toMatchObject({ artifact_id: artifact });
      expect(
        await call("read_literature", {
          literature_id: env.parseRequest.literature_id,
        }),
      ).toMatchObject({
        primary_pdf: { article_identity_status: "match-supported" },
      });
      expect(env.parseCalls).toBe(1);
      expect(env.modelCalls).toBe(2);
      env.setModel((input) => {
        if (Array.isArray(input.core)) {
          const core = input.core as { segment_id: string; text: string }[];
          return {
            outcome: "completed",
            title: "Long analysis",
            statements: [
              {
                statement_id: "s1",
                category: "finding",
                epistemic: "reported",
                text: "A synthetic finding.",
                conditions: [],
                quantity: null,
                evidence_segment_ids: [core[0]!.segment_id],
              },
            ],
          };
        }
        const candidates = input.candidates as {
          id: string;
          category: string;
          epistemic: string;
          text: string;
          conditions: string[];
          quantity: unknown;
          source_layers?: unknown;
        }[];
        const synthesis = candidates[0]?.source_layers !== undefined;
        return {
          ...(synthesis ? {} : { outcome: "completed" }),
          title: "Integrated result",
          statements: candidates.map((c, i) => ({
            statement_id: `s${i + 1}`,
            category: c.category,
            epistemic: c.epistemic,
            text: c.text,
            conditions: c.conditions,
            quantity: c.quantity,
            source_ids: [c.id],
            ...(synthesis
              ? { relation: "single-source", conflict_group_id: null }
              : {}),
          })),
        };
      });
      const longBudget = {
        max_source_bytes: 65536,
        max_call_bytes: 65536,
        max_total_call_bytes: 262144,
        max_calls: 8,
        max_output_tokens_per_call: 2048,
        max_total_output_tokens: 16384,
      };
      const long = await call("submit_processing", {
        schema_version: 1,
        idempotency_key: "mcp-long",
        operations: [
          {
            operation: "analyze-long",
            request: {
              schema_version: 2,
              input: prepared.input,
              purpose: "detailed",
              question: null,
              default_update: null,
              budget: longBudget,
            },
          },
        ],
      });
      await vi.waitFor(async () =>
        expect(
          (await env.app.processingTasks!.read(long.job_id as string)).job
            .status,
        ).toBe("completed"),
      );
      const longResult = await env.app.processingTasks!.read(
        long.job_id as string,
      );
      const longId = (
        longResult.results[0] as { result: { artifact_id: string } }
      ).result.artifact_id;
      const synthesisInput = await call("prepare_synthesis", {
        request: {
          policy: "require-all",
          inputs: [
            {
              kind: "knowledge",
              input_id: "knowledge-1",
              source_artifact_id: longId,
            },
          ],
        },
      });
      const synthesis = await call("submit_processing", {
        schema_version: 1,
        idempotency_key: "mcp-synthesis",
        operations: [
          {
            operation: "synthesize",
            request: {
              schema_version: 3,
              input: synthesisInput.manifest,
              purpose: "synthesis",
              question: "What was found?",
              policy: "require-all",
              budget: { ...longBudget, max_verification_bytes: 1048576 },
            },
          },
        ],
      });
      await vi.waitFor(async () =>
        expect(
          (await env.app.processingTasks!.read(synthesis.job_id as string)).job
            .status,
        ).toBe("completed"),
      );
      const synthesisResult = await env.app.processingTasks!.read(
        synthesis.job_id as string,
      );
      const synthesisId = (
        synthesisResult.results[0] as { result: { artifact_id: string } }
      ).result.artifact_id;
      expect(
        await call("read_knowledge", {
          kind: "synthesis",
          artifact_id: synthesisId,
        }),
      ).toMatchObject({ artifact: { artifact_id: synthesisId } });
    } finally {
      await client.close();
      await host.close();
      await env.close();
    }
  });
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
