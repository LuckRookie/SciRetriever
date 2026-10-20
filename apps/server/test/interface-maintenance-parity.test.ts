import { processorFixture } from "./processor-fixture.js";
import {
  EXTRACTION_SCHEMA_URI,
  extractionSpecHash,
} from "@sciretriever/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/main.js";
import { createMcpServer } from "../src/mcp/server.js";
import { createQueryApplication } from "../src/bootstrap/application.js";
import { TypeScriptConfigurationOwner } from "../src/configuration/owner.js";
import { startQueryOnlyHttp } from "../src/workbench/http.js";
import { coreProcessingFixture } from "./core-processing-fixture.js";

async function* stdin(value: unknown) {
  yield Buffer.from(JSON.stringify(value));
}
async function connect(host: ReturnType<typeof createMcpServer>) {
  const [server, transport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "interface-parity", version: "1" });
  await host.connect(server);
  await client.connect(transport);
  return client;
}
describe("machine interfaces over shared maintenance owners", () => {
  it("imports from MCP, reads through CLI/Web, and exposes saved task scope and policy without implicit execution", async () => {
    const env = await coreProcessingFixture();
    const host = createMcpServer({
      home: env.home,
      maintenance: true,
      applicationFactory: async () => env.app,
      queryFactory: () => createQueryApplication(env.home),
    });
    const client = await connect(host);
    const query = await createQueryApplication(env.home);
    const web = await startQueryOnlyHttp({ application: query });
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await client.callTool({ name, arguments: args });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      return (response.structuredContent as { result: Record<string, unknown> })
        .result;
    };
    try {
      await call("import_bibliography", {
        format: "bibtex",
        content:
          "@article{fixture,title={A newly imported parity article},author={Tester, Agent},year={2026},doi={10.5555/parity-import}}",
      });
      const request = {
        query: {
          identifiers: [{ namespace: "doi", value: "10.5555/parity-import" }],
        },
        limit: 10,
        cursor: null,
        sort: "title-asc",
      };
      const cli = await runCli(
        ["literature", "search", "--request", "-", "--json"],
        { home: env.home, stdin: stdin(request) },
      );
      expect(cli.code).toBe(0);
      expect(cli.value).toMatchObject({ result: { total_count: 1 } });
      const response = await fetch(web.origin + "/api/v1/query/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ protocol_version: 1, request }),
      });
      expect(response.status).toBe(200);
      expect(((await response.json()) as { page: unknown }).page).toEqual(
        (cli.value as { result: unknown }).result,
      );
      const task = await call("create_task", {
        request: {
          kind: "processing",
          request: {
            schema_version: 1,
            idempotency_key: "parity-saved-task",
            operations: [
              { operation: "parse-documents", request: env.rawParseRequest },
            ],
          },
        },
      });
      expect(env.parseCalls).toBe(0);
      const listed = await call("list_tasks", {
        status_group: "active",
        limit: 1,
      });
      expect(listed.tasks).toMatchObject([
        { job_id: task.job_id, status: "queued" },
      ]);
      const detail = await call("inspect_task", { job_id: task.job_id });
      const inspected = await runCli(["jobs", "inspect", "--request", "-"], {
        home: env.home,
        stdin: stdin({ job_id: task.job_id }),
      });
      expect(inspected.code).toBe(0);
      expect(inspected.value).toEqual({ protocol_version: 1, result: detail });
      expect(detail).toHaveProperty("policy");
      expect(detail).toHaveProperty("events");
      expect(env.parseCalls).toBe(0);
      expect(env.modelCalls).toBe(0);
      const cancelled = await call("control_task", {
        job_id: task.job_id,
        action: "cancel",
      });
      expect(cancelled.job).toMatchObject({ status: "cancelled" });
      expect(
        (
          await client.callTool({
            name: "resolve_intervention",
            arguments: {
              job_id: task.job_id,
              intervention_id: "unrelated",
              resolution: "continue",
            },
          })
        ).isError,
      ).toBe(true);
    } finally {
      await client.close();
      await host.close();
      await web.close();
      await query.close();
      await env.close();
    }
  }, 30000);
  it("publishes noninteractive configuration through the same CAS owner, refuses stale edits and never returns credential values", async () => {
    const env = await coreProcessingFixture();
    const owner = new TypeScriptConfigurationOwner(env.home);
    const host = createMcpServer({
      home: env.home,
      maintenance: true,
      configurationOwner: owner,
    });
    const client = await connect(host);
    try {
      const snapshot = await owner.read();
      const configuration = {
        ...snapshot.configuration,
        providers: {
          ...snapshot.configuration.providers,
          "credential-fixture": {
            api: "openai-chat-completions",
            base_url: "https://synthetic.example.invalid/v1",
          },
        },
        sources: {
          ...snapshot.configuration.sources,
          metadata: { ...snapshot.configuration.sources.metadata, limit: 123 },
        },
      };
      const preview = await client.callTool({
        name: "configuration_preview",
        arguments: { baseline: snapshot.revision, configuration },
      });
      expect(preview.isError, JSON.stringify(preview)).not.toBe(true);
      expect((await owner.read()).revision).toBe(snapshot.revision);
      const published = await runCli(
        ["config", "publish", "--request", "-", "--json"],
        {
          home: env.home,
          stdin: stdin({
            baseline: snapshot.revision,
            configuration,
            sections: ["sources", "providers"],
          }),
        },
      );
      expect(published.code, JSON.stringify(published)).toBe(0);
      expect((await owner.read()).configuration.sources.metadata.limit).toBe(
        123,
      );
      const stale = await client.callTool({
        name: "configuration_publish",
        arguments: {
          baseline: snapshot.revision,
          configuration,
          sections: ["sources", "providers"],
        },
      });
      expect(stale.isError).toBe(true);
      expect(stale.structuredContent).toMatchObject({
        result: { failure: { code: "configuration-conflict" } },
      });
      const baseline = (await owner.read()).revision;
      const secret = "synthetic-interface-key-not-for-output";
      const edit = {
        namespace: "model",
        target: "credential-fixture",
        kind: "set",
        value: secret,
      };
      const credential = await client.callTool({
        name: "configuration_credential",
        arguments: { baseline, edit },
      });
      expect(credential.isError, JSON.stringify(credential)).not.toBe(true);
      expect(JSON.stringify(credential)).not.toContain(secret);
      const read = await client.callTool({
        name: "configuration_read",
        arguments: {},
      });
      expect(read.isError).not.toBe(true);
      expect(JSON.stringify(read)).not.toContain(secret);
      const removed = await runCli(["config", "credential", "--request", "-"], {
        home: env.home,
        stdin: stdin({
          baseline,
          edit: {
            namespace: "model",
            target: "credential-fixture",
            kind: "remove",
          },
        }),
      });
      expect(removed.code).toBe(0);
      expect(JSON.stringify(removed)).not.toContain(secret);
    } finally {
      await client.close();
      await host.close();
      await env.close();
    }
  }, 30000);
  it("delivers the same evidence-linked extraction candidates through MCP and CLI with persistent receipts", async () => {
    const env = await processorFixture();
    await env.build(env.parseRequest);
    const setupParseCalls = env.parseCalls;
    const host = createMcpServer({
      home: env.home,
      maintenance: true,
      applicationFactory: async () => env.app,
      queryFactory: () => createQueryApplication(env.home),
    });
    const client = await connect(host);
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await client.callTool({ name, arguments: args });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      return (response.structuredContent as { result: Record<string, unknown> })
        .result;
    };
    try {
      const content = {
        schema_version: 1 as const,
        spec_id: "parity.spec",
        spec_version: "1",
        record_meaning: "Synthetic observation",
        output_schema: {
          $schema: EXTRACTION_SCHEMA_URI,
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
        field_instructions: [],
        inclusion_rules: [],
        missing_value_rules: [],
        evidence_policy: {
          field_granularity: "file" as const,
          required_pointers: "record-root" as const,
          cross_input_relation: "optional" as const,
        },
        required_capabilities: ["material-file-v1" as const],
      };
      const spec = {
        ...content,
        spec_sha256: await extractionSpecHash(content),
      };
      const prepared = await call("prepare_extraction", {
        request: {
          spec,
          inputs: [
            {
              input_id: "source-1",
              literature_id: env.parseRequest.literature_id,
              asset_id: env.asset.asset_id,
              asset_sha256: env.asset.sha256,
              document_version_id: null,
            },
          ],
        },
      });
      const created = await runCli(["extraction", "create", "--request", "-"], {
        home: env.home,
        stdin: stdin({
          caller_id: "parity.caller",
          spec: prepared.spec,
          manifest: prepared.manifest,
        }),
      });
      expect(created.code).toBe(0);
      const operation = (created.value as { result: { operation_id: string } })
        .result;
      expect(
        await call("read_extraction", { operation_id: operation.operation_id }),
      ).toEqual(operation);
      const material = await env.app.documentRead.materialEvidence({
        literature_id: env.parseRequest.literature_id,
        asset_id: env.asset.asset_id,
      });
      const batch = {
        schema_version: 1,
        operation_id: operation.operation_id,
        submission_key: "parity-key",
        batch_id: "parity-batch",
        records: [
          {
            record_id: "record-1",
            payload: { value: "fixture" },
            field_evidence: [
              {
                pointer: "",
                sources: [
                  { input_id: "source-1", evidence: material.evidence },
                ],
              },
            ],
          },
        ],
        relations: [],
        coverage: [
          {
            input_id: "source-1",
            status: "processed-with-records",
            reason: null,
          },
        ],
        producer: { method_id: "parity", method_version: "1", usage: {} },
      };
      const accepted = await call("submit_extraction", { request: batch });
      const repeated = await runCli(
        ["extraction", "submit", "--request", "-"],
        { home: env.home, stdin: stdin(batch) },
      );
      expect(repeated.code).toBe(0);
      expect(repeated.value).toEqual({ protocol_version: 1, result: accepted });
      const receipt = accepted.receipt as { receipt_id: string };
      expect(
        await call("read_extraction_receipt", {
          receipt_id: receipt.receipt_id,
        }),
      ).toEqual(accepted.receipt);
      const closed = await call("close_extraction", {
        operation_id: operation.operation_id,
      });
      expect(closed.status).toBe("closed");
      const rejected = await runCli(
        ["extraction", "submit", "--request", "-"],
        {
          home: env.home,
          stdin: stdin({
            ...batch,
            submission_key: "after-close",
            batch_id: "after-close",
          }),
        },
      );
      expect(rejected.code).toBe(3);
      expect(env.parseCalls).toBe(setupParseCalls);
      expect(env.modelCalls).toBe(0);
    } finally {
      await client.close();
      await host.close();
      await env.close();
    }
  }, 30000);
  it("keeps configuration writes and maintenance tools unavailable in read-only MCP mode", async () => {
    const env = await coreProcessingFixture();
    const host = createMcpServer({ home: env.home });
    const client = await connect(host);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain("configuration_read");
      for (const name of [
        "configuration_publish",
        "configuration_credential",
        "configuration_probe",
        "create_task",
        "import_bibliography",
        "submit_extraction",
      ]) {
        expect(names).not.toContain(name);
        expect((await client.callTool({ name, arguments: {} })).isError).toBe(
          true,
        );
      }
    } finally {
      await client.close();
      await host.close();
      await env.close();
    }
  });
});
