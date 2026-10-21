import type { ModelInput } from "./core-processing-fixture.js";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, it, expect, vi } from "vitest";
import { ProofreadDocumentService } from "../src/document/proofread-publication.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  parseLiteratureId,
  parseMetaLiteratureId,
  type ProcessorBatchRequest,
  type ProcessorResultRef,
  extractionSpecHash,
  EXTRACTION_SCHEMA_URI,
} from "@sciretriever/contracts";
import {
  processorFixture as coreProcessingFixture,
  processorSelection,
} from "./processor-fixture.js";
import {
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";
import { createQueryApplication } from "../src/bootstrap/application.js";
import { createMcpServer } from "../src/mcp/server.js";
import { runCli } from "../src/cli/main.js";
type Env = Awaited<ReturnType<typeof coreProcessingFixture>>;
const label = (
  key: string,
  inputs: ProcessorBatchRequest["inputs"],
): ProcessorBatchRequest => ({
  schema_version: 1,
  idempotency_key: key,
  name: "synthetic labels",
  processor: { id: "labels", version: "2" },
  spec: { question: "Was an exposure test reported?", answer_type: "boolean" },
  inputs,
});
async function output(env: Env, request: unknown) {
  const state = await env.app.processors!.runBatch(request);
  expect(state.failures, JSON.stringify(state.failures)).toEqual([]);
  const summary = state.collections.at(-1) as {
    collection_id: string;
    reused: number;
    computed: number;
    failed: number;
    partial: number;
  };
  const collection = await env.app.processorRead!.collection(
    summary.collection_id,
  );
  return {
    state,
    summary,
    collection: collection!,
    refs: collection!.members.flatMap((m) => (m.result ? [m.result] : [])),
  };
}
const yes = (input: ModelInput) => ({
  answer: true,
  source_ids: [input.segments![0]!.segment_id],
  reason: null,
});
const parsedInput = processorSelection;
async function addDocument(env: Env, index: number) {
  // Arrange one real immutable archive under one reentrant catalog lease.
  // The batch under test below still acquires its own production write leases.
  return env.app.writes.run(async () => {
    const literature_id = parseLiteratureId(randomUUID()),
      doi = `10.1234/processor.${index}`;
    await env.app.database.putLiterature({
      ...FIXTURE_LITERATURE,
      literature_id,
      meta_literature_id: parseMetaLiteratureId(randomUUID()),
      metadata: {
        ...FIXTURE_LITERATURE.metadata,
        title: `Synthetic paper ${index}`,
        identifiers: [{ namespace: "doi", value: doi }],
      },
    });
    await env.app.maintenance!.ingestPdf({
      literature_id,
      bytes: workbenchPdf(doi),
    });
    const asset = (await env.app.library.detail(literature_id)).primary_pdf!
      .asset;
    env.setText(`Synthetic observation ${index}: exposure measured at 25 C.`);
    const request = {
      literature_id,
      asset_id: asset.asset_id,
      asset_sha256: asset.sha256,
      mode: "reparse" as const,
      expected_default_revision: null,
    };
    const parsed = await env.build(request);
    return {
      literature_id,
      request,
      input: parsedInput(parsed.document.document_version_id),
    };
  });
}
describe("processor application acceptance", () => {
  it("preserves numeric typography, rejects invalid magnitudes and marks unsupported raw values uncertain", async () => {
    const env = await coreProcessingFixture();
    try {
      env.setText("The measured conductivity is 7.25 \\times 10^{-3} S/cm.");
      const parsed = await env.build(env.parseRequest);
      for (const [key, number, code] of [
        [
          "reported",
          { value: 0.00725, raw: "7.25 \\times 10^{-3}", unit: "S/cm" },
          null,
        ],
        [
          "wrong-magnitude",
          { value: 7.25, raw: "7.25 \\times 10^{-3}", unit: "S/cm" },
          "processor-number-invalid",
        ],
        [
          "invented-raw",
          { value: 0.00725, raw: "0.00725", unit: "S/cm" },
          null,
        ],
      ] as const) {
        env.setModel((input) => ({
          records: [
            {
              values: { conductivity: number },
              evidence: { conductivity: [input.segments![0]!.segment_id] },
              missing: { conductivity: null },
            },
          ],
        }));
        const state = await env.app.processors!.runBatch({
          ...label(key, [parsedInput(parsed.document.document_version_id)]),
          processor: { id: "records", version: "2" },
          spec: {
            record_meaning: "one measurement",
            fields: [
              {
                name: "conductivity",
                description: `conductivity ${key}`,
                type: "number",
              },
            ],
          },
        });
        if (code) {
          expect(state.failures).toEqual([
            expect.objectContaining({
              failure: expect.objectContaining({ code }),
            }),
          ]);
        } else {
          expect(state.failures).toEqual([]);
          const summary = state.collections.at(-1) as { collection_id: string };
          const collection = await env.app.processorRead!.collection(
            summary.collection_id,
          );
          const stored = await env.app.processorRead!.byId(
            collection!.members[0]!.result!.result_id,
          );
          expect(stored!.result.content).toMatchObject({
            records: [{ payload: { conductivity: number } }],
          });
          expect(stored!.result.value_checks).toEqual([
            expect.objectContaining({
              pointer: "/conductivity",
              status: key === "invented-raw" ? "uncertain" : "text-layer",
            }),
          ]);
        }
      }
    } finally {
      await env.close();
    }
  }, 60000);
  it("composes labels and joint records into an evidence-linked synthesis; CLI and MCP read the same persisted content without models", async () => {
    const schemas: unknown[] = [];
    const env = await coreProcessingFixture({
      inspectResponseSchema: (schema) => schemas.push(schema),
    });
    let host: ReturnType<typeof createMcpServer> | undefined;
    let client: Client | undefined;
    try {
      env.setText(
        "The sample was exposed to air at 25 C. Conductivity was measured.",
      );
      const parsed = await env.build(env.parseRequest),
        inputs = [parsedInput(parsed.document.document_version_id)];
      env.setModel(yes);
      const tagged = await output(env, label("tag", inputs));
      const rows = await env.app.processorRead!.query({
        collection_id: tagged.summary.collection_id,
        result_ids: [],
        filters: [{ field: "answer", operator: "eq", value: true }],
        sort: null,
        limit: 1,
        offset: 0,
      });
      expect(rows.items).toHaveLength(1);
      await expect(
        env.app.processorRead!.query({
          collection_id: tagged.summary.collection_id,
          result_ids: [],
          filters: [{ field: "answer", operator: "eq", value: "true" }],
          sort: null,
          limit: 20,
          offset: 0,
        }),
      ).rejects.toMatchObject({ code: "processor-field-type" });
      env.setModel((input) => ({
        records: [
          {
            values: {
              material: "bodyonlytoken",
              temperature: { value: 25, raw: "25", unit: "C" },
              humidity: null,
            },
            evidence: {
              material: [input.segments![0]!.segment_id],
              temperature: [input.segments![0]!.segment_id],
              humidity: [],
            },
            missing: {
              material: null,
              temperature: null,
              humidity: "not-reported-in-processed-text",
            },
          },
        ],
      }));
      const extracted = await output(env, {
        ...label("records", inputs),
        processor: { id: "records", version: "2" },
        spec: {
          record_meaning: "One reported observation",
          fields: [
            { name: "material", description: "material name" },
            {
              name: "temperature",
              description: "test temperature",
              type: "number",
            },
            { name: "humidity", description: "humidity" },
          ],
        },
      });
      const record = (await env.app.processorRead!.byId(
        extracted.refs[0]!.result_id,
      ))!.result;
      // Strict structured-output providers require every property of a closed
      // object to be required; missing values are represented by null/empty.
      expect(schemas.at(-1)).toMatchObject({
        properties: {
          records: {
            items: {
              properties: {
                evidence: {
                  required: ["material", "temperature", "humidity"],
                },
                missing: {
                  required: ["material", "temperature", "humidity"],
                  properties: {
                    material: {
                      anyOf: [{ type: "string" }, { type: "null" }],
                    },
                  },
                },
              },
            },
          },
        },
      });
      expect(record.content.kind).toBe("records");
      const recordRows = await env.app.processorRead!.query({
        collection_id: extracted.summary.collection_id,
        result_ids: [],
        filters: [{ field: "/temperature/value", operator: "ge", value: 20 }],
        sort: { field: "/temperature/value", direction: "desc" },
        limit: 1,
        offset: 0,
      });
      expect(recordRows.items).toHaveLength(1);
      const snapshot = await env.app.snapshots.create({
        kind: "literatures",
        literature_ids: [env.parseRequest.literature_id],
      });
      let literatureIds: string[] = [];
      env.setModel((input) => {
        if (input.purpose)
          return {
            outcome: "completed",
            title: "Synthetic summary",
            statements: [
              {
                statement_id: "s1",
                category: "finding",
                epistemic: "reported",
                text: "Measured exposure.",
                conditions: [],
                quantity: null,
                evidence_segment_ids: [input.segments![0]!.segment_id],
              },
            ],
          };
        const candidates = input.candidates as {
          id: string;
          independent_literature_ids: string[];
        }[];
        literatureIds = [
          ...new Set(candidates.flatMap((c) => c.independent_literature_ids)),
        ];
        return {
          claims: [
            {
              text: "summarybodytoken",
              source_ids: candidates.map((c) => c.id),
            },
          ],
        };
      });
      const synthesis = await output(env, {
        ...label("synthesis", []),
        processor: { id: "knowledge-synthesis", version: "2" },
        spec: { question: "Compare the measurements", policy: "require-all" },
        inputs: [{ kind: "snapshot", snapshot_id: snapshot.snapshot_id }],
      });
      expect(literatureIds).toEqual([env.parseRequest.literature_id]);
      const report = (await env.app.processorRead!.byId(
        synthesis.refs[0]!.result_id,
      ))!.result;
      expect(report.literature_ids).toEqual([env.parseRequest.literature_id]);
      const evidence = await env.app.processorRead!.verifyCitation({
        kind: "result",
        ...synthesis.refs[0]!,
        record_id: "claim0",
        pointer: "/text",
      });
      expect(evidence.evidence.length).toBeGreaterThan(0);
      const reused = await output(env, {
        ...label("synthesis-again", []),
        processor: { id: "knowledge-synthesis", version: "2" },
        spec: { question: "Compare the measurements", policy: "require-all" },
        inputs: [{ kind: "snapshot", snapshot_id: snapshot.snapshot_id }],
      });
      expect(reused.refs).toEqual(synthesis.refs);
      await env.reopen();
      const before = env.modelCalls;
      const query = { query: "bodyonlytoken", limit: 20, offset: 0 };
      const requestPath = join(env.home, "query.json");
      await writeFile(requestPath, JSON.stringify(query));
      const cliErrors: string[] = [];
      const cli = await runCli(
        ["processors", "search", "--request", requestPath],
        {
          home: env.home,
          json: true,
          stderr: (message) => cliErrors.push(message),
        },
      );
      expect(cli.code, JSON.stringify({ cli, cliErrors })).toBe(0);
      host = createMcpServer({
        queryFactory: () => createQueryApplication(env.home),
      });
      const [server, transport] = InMemoryTransport.createLinkedPair();
      client = new Client({ name: "processor-fixture", version: "1" });
      await host.connect(server);
      await client.connect(transport);
      const response = await client.callTool({
        name: "processor_query",
        arguments: { action: "search", request: query },
      });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      expect(
        (response.structuredContent as { result: unknown }).result,
      ).toEqual(cli.value);
      for (const operator of ["eq", "ne"]) {
        const presence = {
          collection_id: null,
          result_ids: [extracted.refs[0]!.result_id],
          filters: [{ field: "/temperature/value", operator, value: null }],
          sort: null,
          limit: 20,
          offset: 0,
        };
        await writeFile(requestPath, JSON.stringify(presence));
        const filtered = await runCli(
          ["processors", "query", "--request", requestPath],
          { home: env.home, json: true },
        );
        expect(filtered.code).toBe(0);
        expect(filtered.value).toMatchObject({
          items:
            operator === "eq"
              ? []
              : [expect.objectContaining({ record_id: expect.any(String) })],
        });
        const machine = await client.callTool({
          name: "processor_query",
          arguments: { action: "query", request: presence },
        });
        expect(machine.isError).not.toBe(true);
        expect(
          (machine.structuredContent as { result: unknown }).result,
        ).toEqual(filtered.value);
      }
      const bad = await client.callTool({
        name: "processor_query",
        arguments: {
          action: "query",
          request: {
            collection_id: null,
            result_ids: [extracted.refs[0]!.result_id],
            filters: [{ field: "unknown", operator: "eq", value: 3 }],
            sort: null,
            limit: 10,
            offset: 0,
          },
        },
      });
      expect(bad.structuredContent).toMatchObject({
        result: {
          failure: {
            code: "processor-field-unknown",
            fields: expect.arrayContaining(["temperature"]),
          },
        },
      });
      expect(env.modelCalls).toBe(before);
      await client.close();
      client = undefined;
      await host.close();
      host = undefined;
      // Corrupt only rebuildable projections; published files and evidence remain authoritative.
      await env.app.close();
      const db = new DatabaseSync(join(env.home, "catalog.sqlite"));
      db.exec(
        "DELETE FROM processor_result_fts; DELETE FROM processor_record_projection; DELETE FROM processor_collection_fts;",
      );
      db.close();
      await env.reopen();
      await expect(
        env.app.processorRead!.search("bodyonlytoken"),
      ).rejects.toMatchObject({ code: "processor-index-stale" });
      await env.app.processors!.rebuild();
      expect(
        (await env.app.processorRead!.search("bodyonlytoken")).items,
      ).toHaveLength(1);
      expect(
        (await env.app.processorRead!.searchCollections("synthetic")).length,
      ).toBeGreaterThan(0);
      expect(env.modelCalls).toBe(before);
    } finally {
      await client?.close();
      await host?.close();
      await env.close();
    }
  }, 60000);

  it("preserves partial attempts, permits later complete publication, and never treats search absence as a full-text negative", async () => {
    const env = await coreProcessingFixture();
    try {
      env.setText(
        `First exposure observation ${"alpha ".repeat(30)}.\n\nSecond exposure observation ${"beta ".repeat(30)}.`,
      );
      const parsed = await env.build(env.parseRequest),
        inputs = [parsedInput(parsed.document.document_version_id)];
      let failSecond = true;
      env.setModel((input) => {
        if (
          input.segments?.some((s) => s.text.includes("Second")) &&
          failSecond
        )
          throw new Error("synthetic model failure");
        return {
          records: [
            {
              values: { note: "observation" },
              evidence: { note: [input.segments![0]!.segment_id] },
              missing: { note: null },
            },
          ],
        };
      });
      const request = {
        ...label("partial", inputs),
        processor: { id: "records", version: "2" },
        spec: {
          record_meaning: "observations",
          fields: [{ name: "note", description: "observation" }],
          reading: { max_chunk_bytes: 256 },
        },
      };
      const partial = await output(env, request);
      expect(partial.summary.partial).toBe(1);
      failSecond = false;
      const complete = await output(env, {
        ...request,
        idempotency_key: "complete",
      });
      expect(complete.summary.computed).toBe(1);
      expect(complete.summary.partial).toBe(0);
      expect(complete.refs).not.toEqual(partial.refs);
      const reused = await output(env, {
        ...request,
        idempotency_key: "reuse-complete",
      });
      expect(reused.refs).toEqual(complete.refs);
      expect(
        (await env.app.processorRead!.byId(partial.refs[0]!.result_id))!.result
          .coverage[0]!.status,
      ).toBe("partial");
      const absent = await output(env, {
        ...label("search-absence", inputs),
        spec: {
          question: "exposure",
          answer_type: "boolean",
          reading: { scope: "search", query: "nonexistentneedle" },
        },
      });
      const result = (await env.app.processorRead!.byId(
        absent.refs[0]!.result_id,
      ))!.result;
      expect(result.status).toBe("ok");
      expect(result.content).toMatchObject({ kind: "records", records: [] });
      expect(result.coverage[0]!).toMatchObject({
        status: "none",
        read_segments: [],
        parts: [{ outcome: "incomplete", gaps: ["unread-segments"] }],
      });
    } finally {
      await env.close();
    }
  }, 60000);

  it("freezes default inputs across restart, isolates bad evidence, retries failures, and refuses changed model bindings", async () => {
    const env = await coreProcessingFixture();
    try {
      env.setText("Original exposure observation.");
      const old = await env.build(env.parseRequest);
      const job = await env.app.processors!.submit(
        label("frozen", [
          { kind: "literature", literature_id: env.parseRequest.literature_id },
        ]),
      );
      env.setText("Changed document now reports another result.");
      const updated = await env.build({
        ...env.parseRequest,
      });
      expect(updated.default_updated).toBe(true);
      expect(
        (
          await env.app.documentRead.default({
            literature_id: env.parseRequest.literature_id,
            asset_id: env.asset.asset_id,
            asset_sha256: env.asset.sha256,
          })
        ).default!.document_version_id,
      ).toBe(updated.document.document_version_id);
      expect(updated.document.document_version_id).not.toBe(
        old.document.document_version_id,
      );
      await env.reopen();
      let seen = "";
      env.setModel((input) => {
        seen = input.segments!.map((s) => s.text).join(" ");
        return yes(input);
      });
      const state = await env.app.processingTasks!.run(job.job_id);
      expect(state.failures).toEqual([]);
      expect(seen).toContain("Original");
      const original = (state.results[0] as { result: ProcessorResultRef })
        .result;
      expect(
        (await env.app.processorRead!.byId(original.result_id))!.result
          .invocation.inputs[0],
      ).toMatchObject({
        parts: [
          expect.objectContaining({
            document_version_id: old.document.document_version_id,
          }),
        ],
      });
      await expect(
        env.app.processors!.submit({
          ...label("frozen", [parsedInput(old.document.document_version_id)]),
          name: "changed",
        }),
      ).rejects.toMatchObject({ code: "processor-idempotency-conflict" });
      env.setModel(() => ({
        answer: true,
        source_ids: ["invented"],
        reason: null,
      }));
      const invalid = await env.app.processors!.runBatch({
        ...label("invalid", [parsedInput(old.document.document_version_id)]),
        spec: { question: "different question", answer_type: "boolean" },
      });
      expect(invalid.targets[0]!.stage).toBe("failed");
      expect(invalid.collections[0]).toMatchObject({ failed: 1 });
      env.setModel(yes);
      await env.app.processingTasks!.control(invalid.job.job_id, "retry");
      const retried = await env.app.processingTasks!.run(invalid.job.job_id);
      expect(retried.targets[0]!.stage).toBe("completed");
      expect(retried.collections).toHaveLength(2);
      const pending = await env.app.processors!.submit({
        ...label("config-frozen", [
          parsedInput(old.document.document_version_id),
        ]),
        spec: { question: "config question", answer_type: "boolean" },
      });
      const configPath = join(env.home, ".sciretriever/config.toml");
      const config = await readFile(configPath, "utf8");
      await writeFile(
        configPath,
        config.replace('reasoning="medium"', 'reasoning="high"'),
      );
      await env.reopen();
      expect(
        (
          await env.app.processors!.submit({
            ...label("config-frozen", [
              parsedInput(old.document.document_version_id),
            ]),
            spec: { question: "config question", answer_type: "boolean" },
          })
        ).job_id,
      ).toBe(pending.job_id);
      const refused = await env.app.processingTasks!.run(pending.job_id);
      expect(refused.failures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            failure: expect.objectContaining({
              code: "processor-binding-changed",
            }),
          }),
        ]),
      );
      const newConfig = await output(env, {
        ...label("new-config", [parsedInput(old.document.document_version_id)]),
        spec: { question: "config question", answer_type: "boolean" },
      });
      expect(newConfig.summary.computed).toBe(1);
      const cancel = await env.app.processors!.submit(
        label("cancel", [parsedInput(old.document.document_version_id)]),
      );
      await env.app.processingTasks!.control(cancel.job_id, "cancel");
      expect(
        (await env.app.processingTasks!.read(cancel.job_id)).job.status,
      ).toBe("cancelled");
    } finally {
      await env.close();
    }
  }, 60000);

  it("retains externally supplied candidates and material evidence after handoff receipts expire", async () => {
    const env = await coreProcessingFixture();
    try {
      const base = {
        schema_version: 1 as const,
        spec_id: "external.fixture",
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
        required_capabilities: ["material-file-v1" as const],
      };
      await env.build(env.parseRequest);
      const prepared = await env.app.extractionPreparation.prepare({
        spec: { ...base, spec_sha256: await extractionSpecHash(base) },
        inputs: [
          {
            input_id: "a",
            literature_id: env.parseRequest.literature_id,
            asset_id: env.asset.asset_id,
            asset_sha256: env.asset.sha256,
            document_version_id: null,
          },
        ],
      });
      const operation = await env.app.extractionDelivery.create({
        caller_id: "fixture",
        spec: prepared.spec,
        manifest: prepared.manifest,
      });
      const evidence = (
        await env.app.documentRead.materialEvidence({
          literature_id: env.parseRequest.literature_id,
          asset_id: env.asset.asset_id,
        })
      ).evidence;
      const candidate = {
        schema_version: 1,
        operation_id: operation.operation_id,
        submission_key: "one",
        batch_id: "one",
        records: [
          {
            record_id: "r",
            payload: { value: "external-body-token" },
            field_evidence: [
              { pointer: "", sources: [{ input_id: "a", evidence }] },
            ],
          },
        ],
        relations: [],
        coverage: [
          { input_id: "a", status: "processed-with-records", reason: null },
        ],
        producer: { method_id: "fixture", method_version: "1", usage: {} },
      };
      const retained = await env.app.processorRetention!.retain(candidate);
      expect(await env.app.processorRetention!.retain(candidate)).toEqual(
        retained,
      );
      await expect(
        env.app.processorRetention!.retain({
          ...candidate,
          producer: { ...candidate.producer, method_version: "2" },
        }),
      ).rejects.toMatchObject({ code: "processor-submission-conflict" });
      await env.app.close();
      const db = new DatabaseSync(join(env.home, "catalog.sqlite"));
      db.exec(
        "UPDATE extraction_receipts SET receipt_expires_at='2000-01-01T00:00:00Z',protection_expires_at='2000-01-01T00:00:00Z'; UPDATE extraction_operations SET accept_until='2000-01-01T00:00:00Z';",
      );
      db.close();
      await env.reopen();
      await env.app.extractionDelivery.cleanupExpired(100);
      expect(await env.app.processorRetention!.retain(candidate)).toEqual(
        retained,
      );
      const resolved = await env.app.processorRead!.verifyCitation({
        kind: "result",
        ...retained,
        record_id: "r",
        pointer: "/record/value",
      });
      expect(resolved.literature_ids).toEqual([env.parseRequest.literature_id]);
      expect(resolved.evidence[0]!.target_kind).toBe("material");
      const check = new DatabaseSync(join(env.home, "catalog.sqlite"));
      try {
        check.exec("PRAGMA foreign_keys=ON");
        expect(() =>
          check
            .prepare("DELETE FROM assets WHERE asset_id=?")
            .run(env.asset.asset_id),
        ).toThrow();
        expect(
          check
            .prepare("SELECT count(*) AS n FROM processor_result_documents")
            .get(),
        ).toMatchObject({ n: 1 });
      } finally {
        check.close();
      }
    } finally {
      await env.close();
    }
  }, 60000);

  describe("large-library processor reuse", () => {
    let env: Env | undefined;
    let documents: ProofreadDocumentService | undefined;
    let restorePublication: (() => void) | undefined;
    const docs: Awaited<ReturnType<typeof addDocument>>[] = [];

    // Owner acceptance is workflow correctness, not a wall-clock deadline.
    // Vitest timeout=0 disables the aggregate limit; operation-level error and
    // cancellation handling remains unchanged. Timings are diagnostic only.
    beforeAll(async () => {
      const started = performance.now();
      env = await coreProcessingFixture({}, ["vlm-engine"]);
      const publicationService = new ProofreadDocumentService(
        env.app.database,
        env.app.files,
        async () => undefined,
      );
      documents = publicationService;
      // This scenario covers reuse; material indexing has separate coverage.
      const publication = vi
        .spyOn(env.app.proofreadDocuments, "publish")
        .mockImplementation((value, signal) =>
          publicationService.publish(value, signal),
        );
      restorePublication = () => publication.mockRestore();
      for (let i = 0; i < 200; i++) {
        docs.push(await addDocument(env, i));
        if ((i + 1) % 50 === 0 && i + 1 < 200)
          console.info(`Large reuse fixture: ${i + 1}/200 archives prepared`);
      }
      console.info(
        `Large reuse fixture: 200 archives in ${Math.round(performance.now() - started)} ms`,
      );
    }, 0);

    afterAll(async () => {
      restorePublication?.();
      await documents?.close();
      await env?.close();
    }, 0);

    it("reuses exactly overlapping unchanged documents for 100→120, 80-overlap and five revised inputs", async () => {
      const fixture = env;
      if (!fixture) throw new Error("Large reuse fixture was not prepared");
      const run = async (phase: string, request: unknown) => {
        const started = performance.now();
        try {
          return await output(fixture, request);
        } finally {
          console.info(
            `Large reuse batch ${phase}: ${Math.round(performance.now() - started)} ms`,
          );
        }
      };
      fixture.setModel(yes);
      const first = await run(
        "100",
        label(
          "hundred",
          docs.slice(0, 100).map((d) => d.input),
        ),
      );
      expect(first.summary).toMatchObject({
        reused: 0,
        computed: 100,
        failed: 0,
      });
      const before = fixture.modelCalls;
      const superset = await run(
        "120",
        label(
          "superset",
          docs.slice(0, 120).map((d) => d.input),
        ),
      );
      expect(superset.summary).toMatchObject({ reused: 100, computed: 20 });
      expect(fixture.modelCalls - before).toBe(20);
      const overlapDocs = [...docs.slice(20, 100), ...docs.slice(120, 160)];
      const overlap = await run(
        "80-overlap",
        label(
          "overlap",
          overlapDocs.map((d) => d.input),
        ),
      );
      expect(overlap.summary).toMatchObject({ reused: 80, computed: 40 });
      expect(
        overlap.collection.members.flatMap((m) =>
          m.inputs.flatMap((i) =>
            i.kind === "archive-document" ? [i.literature_id] : [],
          ),
        ),
      ).toEqual(overlapDocs.map((d) => d.literature_id));
      for (let i = 20; i < 25; i++) {
        fixture.setText(`Revised exposure observation ${i}.`);
        const revised = await fixture.build(docs[i]!.request);
        docs[i]!.input = parsedInput(revised.document.document_version_id);
      }
      const changed = await run(
        "five-revised",
        label(
          "changed-five",
          [...docs.slice(20, 100), ...docs.slice(160, 200)].map((d) => d.input),
        ),
      );
      expect(changed.summary).toMatchObject({ reused: 75, computed: 45 });
      expect(
        (await fixture.app.processorRead!.collection(
          first.summary.collection_id,
        ))!.members,
      ).toEqual(first.collection.members);
      const savedInputs = (await fixture.app.processorRead!.byId(
        changed.refs[0]!.result_id,
      ))!.result.invocation.inputs;
      expect(savedInputs[0]).toMatchObject({
        literature_id: docs[20]!.literature_id,
      });
    }, 0);
  });
});
