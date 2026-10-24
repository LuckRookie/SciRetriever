import { expect, it } from "vitest";
import {
  EXTRACTION_SCHEMA_URI,
  extractionSpecHash,
  parseProcessorBatchRequest,
  parseProcessorInvocation,
} from "@sciretriever/contracts";
import { archiveFixture } from "./archive-fixture.js";
import { runCli } from "../src/cli/main.js";
import { createMcpServer } from "../src/mcp/server.js";
import { createQueryApplication } from "../src/bootstrap/application.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
it("prepares only READY corrected documents and preserves external submissions and retained evidence", async () => {
  const e = await archiveFixture();
  try {
    const base = {
      schema_version: 1 as const,
      spec_id: "fixture.external",
      spec_version: "1",
      record_meaning: "observation",
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
      required_capabilities: ["document-text-v1" as const],
    };
    const request = {
      spec: { ...base, spec_sha256: await extractionSpecHash(base) },
      inputs: [
        {
          input_id: "paper",
          literature_id: e.id,
          asset_id: e.asset.asset_id,
          asset_sha256: e.asset.sha256,
          document_version_id: null,
        },
      ],
    };
    await expect(
      e.app.extractionPreparation.prepare(request),
    ).rejects.toMatchObject({ code: "input-not-ready" });
    expect(e.modelCalls).toBe(0);
    await e.app.documentProcessing.parseDocuments(e.rawParseRequest);
    await e.submit("ready");
    const calls = e.modelCalls;
    const prepared = await e.app.extractionPreparation.prepare(request);
    expect(prepared.manifest.items[0]!.document).not.toBeNull();
    expect(prepared.missing_required_capabilities).toEqual([]);
    expect(e.modelCalls).toBe(calls);
    const operation = await e.app.extractionDelivery.create({
      caller_id: "fixture",
      spec: prepared.spec,
      manifest: prepared.manifest,
    });
    const evidence = (
      await e.app.documentRead.materialEvidence({
        literature_id: e.id,
        asset_id: e.asset.asset_id,
      })
    ).evidence;
    const submission = {
      schema_version: 1,
      operation_id: operation.operation_id,
      submission_key: "one",
      batch_id: "one",
      records: [
        {
          record_id: "r",
          payload: { value: "synthetic" },
          field_evidence: [
            { pointer: "", sources: [{ input_id: "paper", evidence }] },
          ],
        },
      ],
      relations: [],
      coverage: [
        { input_id: "paper", status: "processed-with-records", reason: null },
      ],
      producer: { method_id: "fixture", method_version: "1", usage: {} },
    };
    const retained = await e.app.processorRetention!.retain(submission);
    expect(await e.app.processorRetention!.retain(submission)).toEqual(
      retained,
    );
    const saved = await e.app.processorRead!.byId(retained.result_id);
    expect(saved!.result.invocation.processor).toEqual({
      id: "external-extraction",
      version: "2",
    });
    expect(saved!.result.invocation.inputs[0]!.kind).toBe("external");
    const resolved = await e.app.processorRead!.verifyCitation({
      kind: "result",
      ...retained,
      record_id: "r",
      pointer: "/record/value",
    });
    expect(resolved.value).toBe("synthetic");
    expect(resolved.literature_ids).toEqual([e.id]);
  } finally {
    await e.close();
  }
}, 0);
// Reached 2.9 s under Full (36/12) load, too close to the 5 s default.
it("exposes direct CLI/MCP archive execution and refuses retired input kinds", async () => {
  const e = await archiveFixture();
  let client: Client | undefined,
    server: ReturnType<typeof createMcpServer> | undefined;
  try {
    const request = {
      schema_version: 1,
      idempotency_key: "legacy",
      name: "legacy",
      processor: { id: "labels", version: "2" },
      spec: {},
      inputs: [],
    };
    for (const input of [
      { kind: "document", document_version_id: e.id },
      { kind: "knowledge", artifact_id: e.id },
      { kind: "result", result_id: e.id, record_ids: null },
    ])
      expect(() =>
        parseProcessorBatchRequest({ ...request, inputs: [input] }),
      ).toThrow();
    expect(() =>
      parseProcessorInvocation({
        schema_version: 1,
        processor: { id: "labels", version: "2" },
        spec: {},
        inputs: [{ kind: "material", input_id: "old", material: {} }],
        execution: { method_sha256: "a".repeat(64), model: null },
      }),
    ).toThrow();
    const submit = await runCli(
      [
        "processor",
        "submit",
        "summary@2",
        "--literature",
        e.id,
        "--idempotency-key",
        "cli-summary",
      ],
      { home: e.home },
    );
    expect(submit.code).toBe(0);
    const job = submit.value as { job_id: string };
    await e.app.processingTasks!.run(job.job_id);
    const state = await e.app.processingTasks!.read(job.job_id);
    expect(state.failures).toEqual([]);
    const result_id = (state.results[0] as { result: { result_id: string } })
      .result.result_id;
    const read = await runCli(["processor", "result", result_id], {
      home: e.home,
    });
    expect(read.code).toBe(0);
    expect(read.value).toMatchObject({
      outcomes: { incomplete: 1 },
      freshness: { state: "current" },
    });
    const filtered = await runCli(["processor", "results", "--stale"], {
      home: e.home,
    });
    expect(filtered.code).toBe(0);
    expect(filtered.value).toMatchObject({ items: [] });
    server = createMcpServer({
      queryFactory: () => createQueryApplication(e.home),
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "archive-processor-fixture", version: "1" });
    await server.connect(a);
    await client.connect(b);
    const response = await client.callTool({
      name: "processor_query",
      arguments: { action: "read", request: { result_id } },
    });
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({
      result: { outcomes: { incomplete: 1 } },
    });
    expect(e.modelCalls).toBe(0);
  } finally {
    await client?.close();
    await server?.close();
    await e.close();
  }
}, 30_000);
