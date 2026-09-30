import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractionSpecHash,
  extractionCanonicalJsonBytes,
  EXTRACTION_MAX_BATCH_BYTES,
  parseExtractionAcceptedResult,
  parseExtractionOperationResult,
  parseExtractionReceiptResult,
  parseStrictJsonValue,
  extractionSubmissionHash,
  EXTRACTION_SCHEMA_URI,
  parseAsset,
  parseLiteratureId,
  parseProvenance,
  sha256,
} from "@sciretriever/contracts";
import {
  createApplication,
  createQueryApplication,
} from "../src/bootstrap/application.js";
import { startQueryOnlyHttp } from "../src/workbench/http.js";
import { migrateDocumentCatalog } from "../src/storage/sqlite/document-migration.js";
import { migrateRetrievalCatalog } from "../src/storage/sqlite/retrieval-migration.js";
import { migrateExtractionCatalog } from "../src/storage/sqlite/extraction-migration.js";
import { runExtractionStorage } from "../src/storage/sqlite/extraction-engine.js";
import { SqliteWorker } from "../src/storage/sqlite/worker.js";
import {
  CatalogWriteAdmission,
  WriteAdmissionError,
} from "../src/storage/write-admission.js";
import {
  ExtractionDeliveryError,
  ExtractionDeliveryService,
} from "../src/extraction/delivery.js";
import {
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";

const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const literatureId = FIXTURE_LITERATURE.literature_id;
async function specification() {
  const content = {
    schema_version: 1 as const,
    spec_id: "synthetic.delivery",
    spec_version: "1",
    record_meaning: "A synthetic observation",
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
  return { ...content, spec_sha256: await extractionSpecHash(content) };
}
async function environment() {
  const home = await mkdtemp(
    join(tmpdir(), "sciretriever-extraction-delivery-"),
  );
  let app = await createApplication(home);
  try {
    await app.database.putLiterature(FIXTURE_LITERATURE);
    const assets = [];
    for (const n of [1, 2]) {
      const pdf = Buffer.concat([
        workbenchPdf(),
        Buffer.from(`\n% synthetic ${n}\n`),
      ]);
      const path = `objects/extraction-${n}.pdf`;
      const stage = await app.files.stage();
      await stage.write(pdf);
      await app.files.publish(stage, path);
      const asset = parseAsset({
        asset_id: id(900 + n),
        sha256: await sha256(pdf),
        size_bytes: pdf.length,
        media_type: "application/pdf",
        path,
      });
      await app.database.putLiteratureAsset({
        literature_asset_id: id(910 + n),
        literature_id: literatureId,
        asset,
        role: n === 1 ? "primary-pdf" : "supplementary-pdf",
        source_url: null,
        provenance: parseProvenance({
          provenance_id: id(920 + n),
          source_kind: "asset-provider",
          source_name: "synthetic",
          source_record_id: null,
          observed_at: "2026-09-29T00:00:00Z",
          input_sha256: asset.sha256,
          parameters_sha256: null,
        }),
      });
      assets.push(asset);
    }
    await app.close();
    const catalog = join(home, "catalog.sqlite");
    await migrateDocumentCatalog({
      catalog_path: catalog,
      backup_path: join(home, "before-v3.sqlite"),
    });
    await migrateRetrievalCatalog({
      catalog_path: catalog,
      backup_path: join(home, "before-v4.sqlite"),
    });
    await migrateExtractionCatalog({
      catalog_path: catalog,
      backup_path: join(home, "before-v5.sqlite"),
    });
    app = await createApplication(home);
    const spec = await specification();
    const inputs = assets.map((asset, index) => ({
      input_id: `source-${index + 1}`,
      literature_id: literatureId,
      asset_id: asset.asset_id,
      asset_sha256: asset.sha256,
      document_version_id: null,
    }));
    const prepared = await app.extractionPreparation.prepare({ spec, inputs });
    const evidence = await Promise.all(
      assets.map(
        async (asset) =>
          (
            await app.documentRead.materialEvidence({
              literature_id: literatureId,
              asset_id: asset.asset_id,
            })
          ).evidence,
      ),
    );
    const env = {
      home,
      catalog,
      app,
      assets,
      prepared,
      evidence,
      close: async () => {
        await env.app.close();
        await rm(home, { recursive: true, force: true });
      },
    };
    return env;
  } catch (error) {
    await app.close();
    await rm(home, { recursive: true, force: true });
    throw error;
  }
}
type Environment = Awaited<ReturnType<typeof environment>>;
async function operation(env: Environment) {
  return env.app.extractionDelivery.create({
    caller_id: "local.synthetic",
    spec: env.prepared.spec,
    manifest: env.prepared.manifest,
  });
}
function batch(env: Environment, operationId: string, value = "alpha") {
  return {
    schema_version: 1,
    operation_id: operationId,
    submission_key: "key-1",
    batch_id: "batch-1",
    records: [
      {
        record_id: "record-1",
        payload: { value },
        field_evidence: [
          {
            pointer: "",
            sources: [
              {
                input_id: "source-1",
                evidence: env.evidence[0]!,
              },
            ],
          },
        ],
      },
    ],
    relations: [],
    coverage: [
      { input_id: "source-1", status: "processed-with-records", reason: null },
      { input_id: "source-2", status: "processed-no-records", reason: null },
    ],
    producer: {
      method_id: "synthetic.method",
      method_version: "1",
      usage: { steps: 1 },
    },
  };
}

describe("extraction candidate delivery on v5", () => {
  it("rejects valid and invalid create calls after shutdown without orphaned parsing", async () => {
    const env = await environment();
    const delivery = new ExtractionDeliveryService(
      env.app.database as unknown as SqliteWorker,
      env.app.documentRead,
      env.app.extractionPreparation,
    );
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on("unhandledRejection", onUnhandled);
    try {
      await delivery.shutdown();
      for (const value of [
        null,
        {
          caller_id: "local.closed",
          spec: env.prepared.spec,
          manifest: env.prepared.manifest,
        },
      ])
        await expect(delivery.create(value)).rejects.toMatchObject({
          code: "delivery-closed",
        });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await env.close();
    }
  });
  it("preserves each write admission failure and only reports actual cancellation as cancelled", async () => {
    const env = await environment();
    try {
      const cases = [
        ["write-admission-conflict", "delivery-write-conflict"],
        ["write-admission-security", "delivery-write-security"],
        ["write-admission-closed", "delivery-write-closed"],
        ["write-admission-expired", "delivery-write-expired"],
        ["write-admission-cancelled", "delivery-cancelled"],
      ] as const;
      for (const [admissionCode, deliveryCode] of cases) {
        const cause = new WriteAdmissionError(admissionCode);
        const database = {
          extraction: async () => {
            throw cause;
          },
        } as unknown as SqliteWorker;
        const delivery = new ExtractionDeliveryService(
          database,
          env.app.documentRead,
          env.app.extractionPreparation,
        );
        await expect(
          delivery.create({
            caller_id: "local.admission",
            spec: env.prepared.spec,
            manifest: env.prepared.manifest,
          }),
        ).rejects.toMatchObject({ code: deliveryCode, cause });
        await delivery.shutdown();
      }
    } finally {
      await env.close();
    }
  });
  it("returns distinct HTTP statuses for each write admission outcome", async () => {
    const env = await environment();
    await env.app.close();
    env.app = await createApplication(env.home, {
      executionSchema: "upgrade-synthetic",
    });
    const query = await createQueryApplication(env.home);
    let code = "delivery-write-conflict";
    const extraction = {
      create: async () => {
        throw new ExtractionDeliveryError(code);
      },
    } as unknown as ExtractionDeliveryService;
    const http = await startQueryOnlyHttp({
      application: query,
      maintenance: { ...env.app.maintenance!, extraction },
      assets: new Map([
        ["/", { contentType: "text/html", body: "<html>maintenance</html>" }],
      ]),
    });
    try {
      const landing = await fetch(http.origin);
      const cookie = landing.headers.get("set-cookie")?.split(";")[0];
      const session = await fetch(`${http.origin}/api/v1/maintenance/session`, {
        headers: { cookie: cookie! },
      });
      const grant = (await session.json()) as { csrf: string };
      for (const [expectedCode, status] of [
        ["delivery-write-conflict", 409],
        ["delivery-write-security", 503],
        ["delivery-write-closed", 503],
        ["delivery-write-expired", 503],
        ["delivery-cancelled", 409],
      ] as const) {
        code = expectedCode;
        const response = await fetch(
          `${http.origin}/api/v1/maintenance/extraction-operation`,
          {
            method: "POST",
            headers: {
              origin: http.origin,
              cookie: cookie!,
              "content-type": "application/json",
              "x-sciretriever-csrf": grant.csrf,
              "x-sciretriever-protocol-version": "1",
            },
            body: JSON.stringify({ protocol_version: 1, request: {} }),
          },
        );
        expect(response.status).toBe(status);
        expect(await response.json()).toMatchObject({ code: expectedCode });
      }
    } finally {
      await http.close();
      await query.close();
      await env.close();
    }
  });
  it("does not post a queued cancelled write and settles a posted real commit before shutdown", async () => {
    const env = await environment();
    let worker: SqliteWorker | undefined;
    try {
      const op = await operation(env);
      let releaseBlock!: () => void;
      const blocked = new Promise<void>((resolve) => {
        releaseBlock = resolve;
      });
      const admission = new CatalogWriteAdmission(env.catalog);
      const holder = admission.run(() => blocked);
      worker = new SqliteWorker(env.catalog, admission);
      const cancelled = new AbortController();
      const queued = worker.extraction(
        "submit",
        {
          operation_id: op.operation_id,
          submission_key: "queued",
          batch_id: "queued",
          submission_sha256: "a".repeat(64),
          checks_json: "{}",
        },
        cancelled.signal,
      );
      cancelled.abort();
      releaseBlock();
      await holder;
      await expect(queued).rejects.toMatchObject({
        code: "write-admission-cancelled",
      });
      const db = new DatabaseSync(env.catalog, { readOnly: true });
      try {
        expect(
          (
            db
              .prepare(
                "SELECT count(*) AS n FROM extraction_receipts WHERE operation_id=?",
              )
              .get(op.operation_id) as { n: number }
          ).n,
        ).toBe(0);
      } finally {
        db.close();
      }
      await worker.close();
      await admission.close();
      worker = undefined;

      let posted!: () => void;
      let committed!: () => void;
      let releaseResult!: () => void;
      const post = new Promise<void>((resolve) => {
        posted = resolve;
      });
      const commit = new Promise<void>((resolve) => {
        committed = resolve;
      });
      const resultGate = new Promise<void>((resolve) => {
        releaseResult = resolve;
      });
      class TracedAdmission extends CatalogWriteAdmission {
        override run<T>(
          operation: () => Promise<T>,
          signal?: AbortSignal,
        ): Promise<T> {
          return super.run(async () => {
            const work = operation();
            posted();
            const value = await work;
            committed();
            await resultGate;
            return value;
          }, signal);
        }
      }
      const traced = new TracedAdmission(env.catalog);
      worker = new SqliteWorker(env.catalog, traced);
      const delivery = new ExtractionDeliveryService(
        worker,
        env.app.documentRead,
        env.app.extractionPreparation,
      );
      const intent = batch(env, op.operation_id);
      const client = new AbortController();
      const submitting = delivery.submit(intent, client.signal);
      await post;
      client.abort();
      await commit;
      let stopped = false;
      const shutdown = delivery.shutdown().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);
      releaseResult();
      const accepted = await submitting;
      await shutdown;
      expect(accepted.receipt.receipt_id).toBe(
        (await env.app.extractionDelivery.submit(intent)).receipt.receipt_id,
      );
      await worker.close();
      await traced.close();
      worker = undefined;
    } finally {
      await worker?.close();
      await env.close();
    }
  });
  it("keeps a posted SQLite commit discoverable after the HTTP client disconnects", async () => {
    const env = await environment();
    await env.app.close();
    env.app = await createApplication(env.home, {
      executionSchema: "upgrade-synthetic",
    });
    const op = await operation(env);
    const intent = batch(env, op.operation_id);
    let posted!: () => void;
    let committed!: () => void;
    let release!: () => void;
    const post = new Promise<void>((resolve) => {
      posted = resolve;
    });
    const commit = new Promise<void>((resolve) => {
      committed = resolve;
    });
    const responseGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    class TracedAdmission extends CatalogWriteAdmission {
      override run<T>(
        operation: () => Promise<T>,
        signal?: AbortSignal,
      ): Promise<T> {
        return super.run(async () => {
          const work = operation();
          posted();
          const value = await work;
          committed();
          await responseGate;
          return value;
        }, signal);
      }
    }
    const admission = new TracedAdmission(env.catalog);
    const worker = new SqliteWorker(env.catalog, admission);
    const delivery = new ExtractionDeliveryService(
      worker,
      env.app.documentRead,
      env.app.extractionPreparation,
    );
    const query = await createQueryApplication(env.home);
    const http = await startQueryOnlyHttp({
      application: query,
      maintenance: { ...env.app.maintenance!, extraction: delivery },
      assets: new Map([
        ["/", { contentType: "text/html", body: "<html>maintenance</html>" }],
      ]),
    });
    try {
      const landing = await fetch(http.origin);
      const cookie = landing.headers.get("set-cookie")?.split(";")[0];
      const session = await fetch(`${http.origin}/api/v1/maintenance/session`, {
        headers: { cookie: cookie! },
      });
      const grant = (await session.json()) as { csrf: string };
      const client = new AbortController();
      const request = fetch(
        `${http.origin}/api/v1/maintenance/extraction-submit`,
        {
          method: "POST",
          headers: {
            origin: http.origin,
            cookie: cookie!,
            "content-type": "application/json",
            "x-sciretriever-csrf": grant.csrf,
            "x-sciretriever-protocol-version": "1",
          },
          body: JSON.stringify({ protocol_version: 1, request: intent }),
          signal: client.signal,
        },
      );
      await post;
      client.abort();
      await expect(request).rejects.toThrow();
      await commit;
      release();
      const historical = await env.app.extractionDelivery.submit(intent);
      expect(historical.receipt.receipt_id).toEqual(expect.any(String));
    } finally {
      release();
      await http.close();
      await query.close();
      await delivery.shutdown();
      await worker.close();
      await admission.close();
      await env.close();
    }
  });
  it("requires relation endpoints themselves to carry different input evidence", async () => {
    const env = await environment();
    try {
      const { spec_sha256: ignored, ...base } = await specification();
      void ignored;
      const content = {
        ...base,
        spec_id: "synthetic.endpoint-evidence",
        output_schema: {
          $schema: EXTRACTION_SCHEMA_URI,
          type: "object",
          properties: { a: { type: "string" }, b: { type: "string" } },
          required: ["a", "b"],
          additionalProperties: false,
        },
        evidence_policy: {
          field_granularity: "file" as const,
          required_pointers: "all-scalar-leaves" as const,
          cross_input_relation: "required" as const,
        },
      };
      const spec = {
        ...content,
        spec_sha256: await extractionSpecHash(content),
      };
      const prepared = await env.app.extractionPreparation.prepare({
        spec,
        inputs: env.assets.map((asset, index) => ({
          input_id: `source-${index + 1}`,
          literature_id: literatureId,
          asset_id: asset.asset_id,
          asset_sha256: asset.sha256,
          document_version_id: null,
        })),
      });
      const op = await env.app.extractionDelivery.create({
        caller_id: "local.endpoints",
        spec: prepared.spec,
        manifest: prepared.manifest,
      });
      const source = (index: number) => [
        {
          input_id: `source-${index + 1}`,
          evidence: env.evidence[index]!,
        },
      ];
      const record = (record_id: string, aSource: number, bSource: number) => ({
        record_id,
        payload: { a: record_id, b: record_id },
        field_evidence: [
          { pointer: "/a", sources: source(aSource) },
          { pointer: "/b", sources: source(bSource) },
        ],
      });
      const intent = {
        schema_version: 1,
        operation_id: op.operation_id,
        submission_key: "wrong-endpoint",
        batch_id: "wrong-endpoint",
        records: [record("left", 0, 1), record("right", 0, 1)],
        relations: [
          {
            relation_type: "compares-with",
            from: { record_id: "left", pointer: "/a" },
            to: { record_id: "right", pointer: "/a" },
            evidence: [...source(0), ...source(1)],
          },
        ],
        coverage: [
          {
            input_id: "source-1",
            status: "processed-with-records",
            reason: null,
          },
          {
            input_id: "source-2",
            status: "processed-with-records",
            reason: null,
          },
        ],
        producer: {
          method_id: "synthetic.method",
          method_version: "1",
          usage: {},
        },
      };
      await expect(
        env.app.extractionDelivery.submit(intent),
      ).rejects.toMatchObject({
        code: "relation-required",
      });
      const accepted = await env.app.extractionDelivery.submit({
        ...intent,
        submission_key: "correct-endpoint",
        batch_id: "correct-endpoint",
        records: [record("left", 0, 1), record("right", 1, 0)],
      });
      expect(accepted.receipt.checks.relation_count).toBe(1);
    } finally {
      await env.close();
    }
  });
  it("accepts an explicit missing input without a pin and rejects processed coverage for it", async () => {
    const env = await environment();
    try {
      const missingLiteratureId = parseLiteratureId(id(777));
      await env.app.database.putLiterature({
        ...FIXTURE_LITERATURE,
        literature_id: missingLiteratureId,
      });
      const prepared = await env.app.extractionPreparation.prepare({
        spec: env.prepared.spec,
        inputs: [
          {
            input_id: "source-1",
            literature_id: literatureId,
            asset_id: env.assets[0]!.asset_id,
            asset_sha256: env.assets[0]!.sha256,
            document_version_id: null,
          },
          {
            input_id: "missing-source",
            literature_id: missingLiteratureId,
            asset_id: null,
            asset_sha256: null,
            document_version_id: null,
          },
        ],
      });
      const op = await env.app.extractionDelivery.create({
        caller_id: "local.missing",
        spec: prepared.spec,
        manifest: prepared.manifest,
      });
      const intent = {
        ...batch(env, op.operation_id),
        coverage: [
          {
            input_id: "source-1",
            status: "processed-with-records",
            reason: null,
          },
          {
            input_id: "missing-source",
            status: "not-processed",
            reason: "material absent",
          },
        ],
      };
      await expect(
        env.app.extractionDelivery.submit({
          ...intent,
          coverage: [
            intent.coverage[0],
            { ...intent.coverage[1]!, status: "processed-no-records" },
          ],
        }),
      ).rejects.toMatchObject({ code: "coverage-invalid" });
      const receipt = await env.app.extractionDelivery.submit(intent);
      expect(receipt.receipt.protected_materials).toHaveLength(1);
      expect(receipt.receipt.protected_materials[0]?.input_id).toBe("source-1");
      expect(receipt.receipt.protected_documents).toHaveLength(0);
    } finally {
      await env.close();
    }
  });
  it("returns a historical receipt before inspecting newly damaged evidence", async () => {
    const env = await environment();
    try {
      const op = await operation(env);
      const intent = batch(env, op.operation_id);
      const accepted = await env.app.extractionDelivery.submit(intent);
      await writeFile(
        join(env.home, "artifacts/objects/extraction-1.pdf"),
        "damaged",
      );
      expect(
        (await env.app.extractionDelivery.submit(intent)).receipt.receipt_id,
      ).toBe(accepted.receipt.receipt_id);
      await expect(
        env.app.extractionDelivery.submit({
          ...intent,
          submission_key: "new-after-damage",
          batch_id: "new-after-damage",
        }),
      ).rejects.toThrow();
    } finally {
      await env.close();
    }
  });
  it("keeps pins until both the receipt and protection periods end", async () => {
    const env = await environment();
    try {
      const op = await operation(env);
      const accepted = await env.app.extractionDelivery.submit(
        batch(env, op.operation_id),
      );
      await env.app.close();
      const db = new DatabaseSync(env.catalog);
      try {
        db.prepare(
          "UPDATE extraction_receipts SET receipt_expires_at='2000-01-01T00:00:00.000Z',protection_expires_at='2099-01-01T00:00:00.000Z' WHERE receipt_id=?",
        ).run(accepted.receipt.receipt_id);
      } finally {
        db.close();
      }
      env.app = await createApplication(env.home);
      expect(
        await env.app.extractionDelivery.receipt(accepted.receipt.receipt_id),
      ).toBeNull();
      expect(await env.app.extractionDelivery.cleanupExpired(1)).toEqual({
        receipts_deleted: 0,
        operations_deleted: 0,
      });
      const read = new DatabaseSync(env.catalog, { readOnly: true });
      try {
        expect(
          (
            read
              .prepare(
                "SELECT count(*) AS n FROM extraction_receipt_materials WHERE receipt_id=?",
              )
              .get(accepted.receipt.receipt_id) as { n: number }
          ).n,
        ).toBe(2);
      } finally {
        read.close();
      }
    } finally {
      await env.close();
    }
  });
  it("refuses full operation and receipt capacity without evicting valid history", async () => {
    const env = await environment();
    try {
      const first = await operation(env);
      await env.app.close();
      let db = new DatabaseSync(env.catalog);
      try {
        db.exec("PRAGMA foreign_keys=ON");
        const clone = db.prepare(
          "INSERT INTO extraction_operations(operation_id,caller_id,spec_id,spec_version,spec_sha256,manifest_sha256,manifest_json,status,created_at,accept_until,closed_at) SELECT ?,caller_id,spec_id,spec_version,spec_sha256,manifest_sha256,manifest_json,status,created_at,accept_until,closed_at FROM extraction_operations WHERE operation_id=?",
        );
        db.exec("BEGIN IMMEDIATE");
        for (let n = 0; n < 999; n++)
          clone.run(id(2000 + n), first.operation_id);
        db.exec("COMMIT");
      } finally {
        db.close();
      }
      env.app = await createApplication(env.home);
      await expect(operation(env)).rejects.toMatchObject({
        code: "operation-capacity",
      });
      await env.app.close();
      db = new DatabaseSync(env.catalog);
      try {
        db.exec("PRAGMA foreign_keys=ON");
        db.prepare(
          "UPDATE extraction_operations SET accept_until='2000-01-01T00:00:00.000Z' WHERE operation_id<>?",
        ).run(first.operation_id);
        const insert = db.prepare(
          "INSERT INTO extraction_receipts(receipt_id,operation_id,submission_key,batch_id,submission_sha256,accepted_at,receipt_expires_at,protection_expires_at,checks_json) VALUES(?,?,?,?,?,'2026-09-29T00:00:00.000Z','2099-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z','{}')",
        );
        db.exec("BEGIN IMMEDIATE");
        for (let n = 0; n < 10000; n++)
          insert.run(
            id(4000 + n),
            first.operation_id,
            `seed-${n}`,
            `batch-${n}`,
            "a".repeat(64),
          );
        db.exec("COMMIT");
      } finally {
        db.close();
      }
      env.app = await createApplication(env.home);
      const second = await operation(env);
      await expect(
        env.app.extractionDelivery.submit(batch(env, second.operation_id)),
      ).rejects.toMatchObject({ code: "receipt-capacity" });
      expect(
        (await env.app.extractionDelivery.cleanupExpired(100)).receipts_deleted,
      ).toBe(0);
      await env.app.close();
      db = new DatabaseSync(env.catalog);
      try {
        db.prepare(
          "UPDATE extraction_receipts SET receipt_expires_at='2000-01-01T00:00:00.000Z',protection_expires_at='2000-01-01T00:00:00.000Z' WHERE receipt_id=?",
        ).run(id(4000));
      } finally {
        db.close();
      }
      env.app = await createApplication(env.home);
      expect(
        (await env.app.extractionDelivery.cleanupExpired(1)).receipts_deleted,
      ).toBe(1);
      expect(
        (
          await env.app.extractionDelivery.submit(
            batch(env, second.operation_id),
          )
        ).receipt.receipt_id,
      ).toEqual(expect.any(String));
    } finally {
      await env.close();
    }
  });
  it("checks named cross-input relations and accepts explicit zero-record or failed coverage", async () => {
    const env = await environment();
    try {
      const { spec_sha256: previousHash, ...base } = await specification();
      void previousHash;
      const content = {
        ...base,
        spec_id: "synthetic.cross-input",
        evidence_policy: {
          ...base.evidence_policy,
          cross_input_relation: "required" as const,
        },
      };
      const spec = {
        ...content,
        spec_sha256: await extractionSpecHash(content),
      };
      const prepared = await env.app.extractionPreparation.prepare({
        spec,
        inputs: env.assets.map((asset, index) => ({
          input_id: `source-${index + 1}`,
          literature_id: literatureId,
          asset_id: asset.asset_id,
          asset_sha256: asset.sha256,
          document_version_id: null,
        })),
      });
      const op = await env.app.extractionDelivery.create({
        caller_id: "local.cross",
        spec: prepared.spec,
        manifest: prepared.manifest,
      });
      const first = batch(env, op.operation_id);
      const secondRecord = {
        record_id: "record-2",
        payload: { value: "beta" },
        field_evidence: [
          {
            pointer: "",
            sources: [
              {
                input_id: "source-2",
                evidence: env.evidence[1]!,
              },
            ],
          },
        ],
      };
      const cross = {
        ...first,
        records: [...first.records, secondRecord],
        relations: [
          {
            relation_type: "compares-with",
            from: { record_id: "record-1", pointer: "" },
            to: { record_id: "record-2", pointer: "" },
            evidence: [
              { input_id: "source-1", evidence: env.evidence[0]! },
              { input_id: "source-2", evidence: env.evidence[1]! },
            ],
          },
        ],
        coverage: first.coverage.map((item) => ({
          ...item,
          status: "processed-with-records",
        })),
      };
      await expect(
        env.app.extractionDelivery.submit({
          ...cross,
          relations: [
            {
              ...cross.relations[0]!,
              evidence: cross.relations[0]!.evidence.slice(0, 1),
            },
          ],
        }),
      ).rejects.toMatchObject({ code: "relation-required" });
      const accepted = await env.app.extractionDelivery.submit(cross);
      expect(accepted.receipt.checks).toMatchObject({
        record_count: 2,
        relation_count: 1,
      });
      const zero = await env.app.extractionDelivery.submit({
        ...first,
        submission_key: "zero-key",
        batch_id: "zero-batch",
        records: [],
        relations: [],
        coverage: [
          {
            input_id: "source-1",
            status: "processed-no-records",
            reason: null,
          },
          {
            input_id: "source-2",
            status: "failed",
            reason: "synthetic reader stopped",
          },
        ],
      });
      expect(zero.receipt.checks.record_count).toBe(0);
      expect(zero.accepted_batch.coverage[1]?.reason).toBe(
        "synthetic reader stopped",
      );
      expect(
        "accepted_batch" in
          (await env.app.extractionDelivery.receipt(zero.receipt.receipt_id))!,
      ).toBe(false);
    } finally {
      await env.close();
    }
  });
  it("exposes explicit CSRF-protected maintenance delivery and receipt reading over loopback", async () => {
    const env = await environment();
    await env.app.close();
    env.app = await createApplication(env.home, {
      executionSchema: "upgrade-synthetic",
    });
    expect(env.app.maintenance).not.toBeNull();
    const query = await createQueryApplication(env.home);
    const http = await startQueryOnlyHttp({
      application: query,
      maintenance: env.app.maintenance!,
      assets: new Map([
        ["/", { contentType: "text/html", body: "<html>maintenance</html>" }],
      ]),
    });
    try {
      const landing = await fetch(http.origin);
      const cookie = landing.headers.get("set-cookie")?.split(";")[0];
      expect(cookie).toBeTruthy();
      const session = await fetch(`${http.origin}/api/v1/maintenance/session`, {
        headers: { cookie: cookie! },
      });
      const grant = (await session.json()) as { csrf: string };
      const post = async (
        name: string,
        request: unknown,
        authorized = true,
      ) => {
        const response = await fetch(
          `${http.origin}/api/v1/maintenance/extraction-${name}`,
          {
            method: "POST",
            headers: {
              origin: http.origin,
              "content-type": "application/json",
              "x-sciretriever-protocol-version": "1",
              ...(authorized
                ? { cookie: cookie!, "x-sciretriever-csrf": grant.csrf }
                : {}),
            },
            body: JSON.stringify({ protocol_version: 1, request }),
          },
        );
        return {
          status: response.status,
          body: (await response.json()) as {
            result?: Record<string, unknown>;
            code?: string;
          },
        };
      };
      expect((await post("operation", {}, false)).status).toBe(403);
      const created = await post("operation", {
        caller_id: "local.http",
        spec: env.prepared.spec,
        manifest: env.prepared.manifest,
      });
      expect(created.status).toBe(200);
      const opId = created.body.result?.operation_id as string;
      const submitted = await post("submit", batch(env, opId));
      expect(submitted.status).toBe(200);
      const receiptId = (
        submitted.body.result?.receipt as Record<string, unknown>
      )?.receipt_id as string;
      const read = await post("receipt", { receipt_id: receiptId });
      expect(read.body.result?.receipt_id).toBe(receiptId);
      expect(read.body.result?.protected_materials).toHaveLength(2);
      const small = batch(env, opId);
      const near = {
        ...small,
        submission_key: "near-limit",
        batch_id: "near-limit",
        records: [{ ...small.records[0]!, payload: { value: "" } }],
      };
      const overhead = extractionCanonicalJsonBytes(near).length;
      const large = {
        ...near,
        records: [
          {
            ...near.records[0]!,
            payload: {
              value: "x".repeat(EXTRACTION_MAX_BATCH_BYTES - overhead),
            },
          },
        ],
      };
      expect(extractionCanonicalJsonBytes(large).length).toBe(
        EXTRACTION_MAX_BATCH_BYTES,
      );
      const largeResult = await post("submit", large);
      expect(largeResult.status).toBe(200);
      const again = await env.app.extractionDelivery.submit(large);
      expect(again.receipt.receipt_id).toBe(
        (largeResult.body.result?.receipt as { receipt_id: string }).receipt_id,
      );
      expect(() =>
        env.app.extractionDelivery.submit({
          ...large,
          submission_key: "over-limit",
          batch_id: "over-limit",
          records: [
            {
              ...large.records[0]!,
              payload: { value: large.records[0]!.payload.value + "x" },
            },
          ],
        }),
      ).toThrow();
      expect(
        await query.extractionPreparation?.prepare({
          spec: env.prepared.spec,
          inputs: env.assets.map((asset, index) => ({
            input_id: `source-${index + 1}`,
            literature_id: literatureId,
            asset_id: asset.asset_id,
            asset_sha256: asset.sha256,
            document_version_id: null,
          })),
        }),
      ).toMatchObject({ persistence: "requires-catalog-v5" });
    } finally {
      await http.close();
      await query.close();
      await env.close();
    }
  });
  it("rolls back receipt and the first material pin when a later pin fails", async () => {
    const env = await environment();
    try {
      const op = await operation(env);
      await env.app.close();
      const db = new DatabaseSync(env.catalog);
      try {
        db.exec("PRAGMA foreign_keys=ON");
        db.exec(
          "CREATE TRIGGER fail_second_extraction_pin BEFORE INSERT ON extraction_receipt_materials WHEN NEW.input_id='source-2' BEGIN SELECT RAISE(ABORT,'synthetic pin failure'); END",
        );
        expect(() =>
          runExtractionStorage(db, "submit", {
            operation_id: op.operation_id,
            submission_key: "fault-key",
            batch_id: "fault-batch",
            submission_sha256: "a".repeat(64),
            checks_json: "{}",
          }),
        ).toThrow("synthetic pin failure");
        for (const table of [
          "extraction_receipts",
          "extraction_receipt_materials",
          "extraction_receipt_documents",
        ])
          expect(
            (
              db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
                n: number;
              }
            ).n,
          ).toBe(0);
        db.exec("DROP TRIGGER fail_second_extraction_pin");
      } finally {
        db.close();
      }
      env.app = await createApplication(env.home);
      const accepted = await env.app.extractionDelivery.submit(
        batch(env, op.operation_id),
      );
      expect(accepted.receipt.protected_materials).toHaveLength(2);
    } finally {
      await env.close();
    }
  });
  it("commits a whole batch with exact manifest pins, returns historical receipt after close and restart", async () => {
    const env = await environment();
    try {
      const op = await operation(env);
      const intent = batch(env, op.operation_id);
      const [first, duplicate] = await Promise.all([
        env.app.extractionDelivery.submit(intent),
        env.app.extractionDelivery.submit(intent),
      ]);
      expect(first.accepted_batch.records[0]?.payload).toEqual({
        value: "alpha",
      });
      expect("checks_json" in first.receipt).toBe(false);
      const expectedHash = await extractionSubmissionHash(
        op,
        first.accepted_batch,
      );
      expect(expectedHash).toBe(first.receipt.submission_sha256);
      expect(() =>
        parseExtractionAcceptedResult(
          {
            ...first,
            receipt: { ...first.receipt, submission_sha256: "f".repeat(64) },
          },
          first.accepted_batch,
          expectedHash,
        ),
      ).toThrow();
      expect(() =>
        parseExtractionReceiptResult({ ...first.receipt, checks_json: "{}" }),
      ).toThrow();
      expect(duplicate.receipt.receipt_id).toBe(first.receipt.receipt_id);
      expect(first.receipt.protected_materials).toHaveLength(2);
      expect(first.receipt.protected_documents).toHaveLength(0);
      expect(first.receipt.checks).toMatchObject({
        record_count: 1,
        evidence_count: 1,
      });
      const db = new DatabaseSync(env.catalog, { readOnly: true });
      try {
        expect(
          (
            db
              .prepare(
                "SELECT count(*) AS n FROM extraction_receipt_materials WHERE receipt_id=?",
              )
              .get(first.receipt.receipt_id) as { n: number }
          ).n,
        ).toBe(2);
        expect(
          (
            db
              .prepare(
                "SELECT count(*) AS n FROM extraction_receipts WHERE operation_id=?",
              )
              .get(op.operation_id) as { n: number }
          ).n,
        ).toBe(1);
      } finally {
        db.close();
      }
      await env.app.extractionDelivery.closeOperation(op.operation_id);
      expect(
        (await env.app.extractionDelivery.submit(intent)).receipt.receipt_id,
      ).toBe(first.receipt.receipt_id);
      await expect(
        env.app.extractionDelivery.submit(
          batch(env, op.operation_id, "changed"),
        ),
      ).rejects.toMatchObject({ code: "submission-conflict" });
      await env.app.close();
      env.app = await createApplication(env.home);
      expect(
        (await env.app.extractionDelivery.submit(intent)).receipt.receipt_id,
      ).toBe(first.receipt.receipt_id);
      expect(
        (await env.app.extractionDelivery.receipt(first.receipt.receipt_id))
          ?.protected_materials,
      ).toHaveLength(2);
    } finally {
      await env.close();
    }
  });

  it("rejects malformed payload, pointer, wrong evidence, coverage and duplicate batch without partial receipt", async () => {
    const env = await environment();
    try {
      const op = await operation(env);
      const base = batch(env, op.operation_id);
      await expect(env.app.extractionDelivery.create(null)).rejects.toThrow();
      await expect(
        env.app.extractionDelivery.submit({
          ...base,
          submission_key: "issue-payload",
          batch_id: "issue-payload",
          records: [{ ...base.records[0]!, payload: { value: 1 } }],
        }),
      ).rejects.toMatchObject({
        code: "payload-invalid",
        issue: {
          record_id: "record-1",
          pointer: "/value",
          keyword: "type",
          truncated: true,
        },
      });
      await expect(
        env.app.extractionDelivery.submit({
          ...base,
          submission_key: "issue-pointer",
          batch_id: "issue-pointer",
          records: [
            {
              ...base.records[0]!,
              field_evidence: [
                {
                  pointer: "/missing",
                  sources: base.records[0]!.field_evidence[0]!.sources,
                },
              ],
            },
          ],
        }),
      ).rejects.toMatchObject({
        code: "pointer-invalid",
        issue: { record_id: "record-1", pointer: "/missing" },
      });
      const invalid = [
        { ...base, records: [{ ...base.records[0]!, payload: { value: 1 } }] },
        {
          ...base,
          records: [
            {
              ...base.records[0]!,
              field_evidence: [
                {
                  pointer: "/missing",
                  sources: base.records[0]!.field_evidence[0]!.sources,
                },
              ],
            },
          ],
        },
        {
          ...base,
          records: [
            {
              ...base.records[0]!,
              field_evidence: [
                {
                  pointer: "",
                  sources: [
                    { input_id: "source-2", evidence: env.evidence[0]! },
                  ],
                },
              ],
            },
          ],
        },
        { ...base, coverage: base.coverage.slice(0, 1) },
      ];
      for (const [index, candidate] of invalid.entries())
        await expect(
          env.app.extractionDelivery.submit({
            ...candidate,
            submission_key: `bad-${index}`,
            batch_id: `bad-batch-${index}`,
          }),
        ).rejects.toThrow();
      const db = new DatabaseSync(env.catalog, { readOnly: true });
      try {
        expect(
          (
            db
              .prepare("SELECT count(*) AS n FROM extraction_receipts")
              .get() as { n: number }
          ).n,
        ).toBe(0);
      } finally {
        db.close();
      }
      await env.app.extractionDelivery.submit(base);
      await expect(
        env.app.extractionDelivery.submit({
          ...base,
          submission_key: "other-key",
        }),
      ).rejects.toMatchObject({
        code: "batch-conflict",
      });
    } finally {
      await env.close();
    }
  });

  it("serializes cancellation before new submission, retains earlier receipts and cleans expired rows explicitly", async () => {
    const env = await environment();
    try {
      const op = await operation(env);
      const first = await env.app.extractionDelivery.submit(
        batch(env, op.operation_id),
      );
      await env.app.extractionDelivery.cancelOperation(op.operation_id);
      expect(
        (await env.app.extractionDelivery.submit(batch(env, op.operation_id)))
          .receipt.receipt_id,
      ).toBe(first.receipt.receipt_id);
      await expect(
        env.app.extractionDelivery.submit({
          ...batch(env, op.operation_id),
          submission_key: "new-key",
          batch_id: "new-batch",
        }),
      ).rejects.toMatchObject({ code: "operation-not-open" });
      await env.app.close();
      const db = new DatabaseSync(env.catalog);
      try {
        db.exec("PRAGMA foreign_keys=ON");
        db.prepare(
          "UPDATE extraction_receipts SET receipt_expires_at='2000-01-01T00:00:00.000Z',protection_expires_at='2000-01-01T00:00:00.000Z'",
        ).run();
        db.prepare(
          "UPDATE extraction_operations SET accept_until='2000-01-01T00:00:00.000Z'",
        ).run();
      } finally {
        db.close();
      }
      env.app = await createApplication(env.home);
      expect(
        await env.app.extractionDelivery.receipt(first.receipt.receipt_id),
      ).toBeNull();
      expect(await env.app.extractionDelivery.cleanupExpired(2)).toEqual({
        receipts_deleted: 1,
        operations_deleted: 1,
      });
      await expect(
        env.app.extractionDelivery.submit(batch(env, op.operation_id)),
      ).rejects.toMatchObject({ code: "unknown-or-expired" });
    } finally {
      await env.close();
    }
  });
  it("settles a concurrent submit and cancel at one durable admission point", async () => {
    const env = await environment();
    try {
      const op = await operation(env);
      const intent = batch(env, op.operation_id);
      const [submitted, cancelled] = await Promise.allSettled([
        env.app.extractionDelivery.submit(intent),
        env.app.extractionDelivery.cancelOperation(op.operation_id),
      ]);
      expect(cancelled.status).toBe("fulfilled");
      expect(
        (await env.app.extractionDelivery.operation(op.operation_id))?.status,
      ).toBe("cancelled");
      const db = new DatabaseSync(env.catalog, { readOnly: true });
      try {
        const count = (
          db
            .prepare(
              "SELECT count(*) AS n FROM extraction_receipts WHERE operation_id=?",
            )
            .get(op.operation_id) as { n: number }
        ).n;
        if (submitted.status === "fulfilled") {
          expect(count).toBe(1);
          expect(
            (await env.app.extractionDelivery.submit(intent)).receipt
              .receipt_id,
          ).toBe(submitted.value.receipt.receipt_id);
        } else {
          expect(submitted.reason).toMatchObject({
            code: "operation-not-open",
          });
          expect(count).toBe(0);
        }
      } finally {
        db.close();
      }
    } finally {
      await env.close();
    }
  });

  it("lets an ordinary external program read fixed PDFs and deliver distinct caller schemas without an internal parser or model", async () => {
    const env = await environment();
    let query: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
    let http: Awaited<ReturnType<typeof startQueryOnlyHttp>> | undefined;
    try {
      const otherLiterature = parseLiteratureId(id(777));
      await env.app.database.putLiterature({
        ...FIXTURE_LITERATURE,
        literature_id: otherLiterature,
      });
      const secondPdf = Buffer.concat([
        workbenchPdf(),
        Buffer.from("\n% synthetic reading 3\n"),
      ]);
      const stage = await env.app.files.stage();
      await stage.write(secondPdf);
      await env.app.files.publish(stage, "objects/external-second.pdf");
      const secondAsset = parseAsset({
        asset_id: id(977),
        sha256: await sha256(secondPdf),
        size_bytes: secondPdf.length,
        media_type: "application/pdf",
        path: "objects/external-second.pdf",
      });
      await env.app.database.putLiteratureAsset({
        literature_asset_id: id(978),
        literature_id: otherLiterature,
        asset: secondAsset,
        role: "primary-pdf",
        source_url: null,
        provenance: parseProvenance({
          provenance_id: id(979),
          source_kind: "asset-provider",
          source_name: "synthetic",
          source_record_id: null,
          observed_at: "2026-09-29T00:00:00Z",
          input_sha256: secondAsset.sha256,
          parameters_sha256: null,
        }),
      });
      await env.app.close();
      env.app = await createApplication(env.home, {
        executionSchema: "upgrade-synthetic",
      });
      query = await createQueryApplication(env.home);
      http = await startQueryOnlyHttp({
        application: query,
        maintenance: env.app.maintenance!,
        assets: new Map([
          [
            "/",
            {
              contentType: "text/html",
              body: "<html>external consumer</html>",
            },
          ],
        ]),
      });
      const landing = await fetch(http.origin);
      const cookie = landing.headers.get("set-cookie")?.split(";")[0];
      const session = await fetch(`${http.origin}/api/v1/maintenance/session`, {
        headers: { cookie: cookie! },
      });
      const grant = (await session.json()) as { csrf: string };
      const post = async (name: string, request: unknown) => {
        const response = await fetch(
          `${http!.origin}/api/v1/maintenance/extraction-${name}`,
          {
            method: "POST",
            headers: {
              origin: http!.origin,
              cookie: cookie!,
              "content-type": "application/json",
              "x-sciretriever-csrf": grant.csrf,
              "x-sciretriever-protocol-version": "1",
            },
            body: JSON.stringify({ protocol_version: 1, request }),
          },
        );
        return {
          status: response.status,
          body: parseStrictJsonValue(await response.text()) as Record<
            string,
            unknown
          >,
        };
      };
      const selected = [
        {
          input_id: "first-paper",
          literature_id: literatureId,
          asset_id: env.assets[0]!.asset_id,
          asset_sha256: env.assets[0]!.sha256,
          document_version_id: null,
        },
        {
          input_id: "second-paper",
          literature_id: otherLiterature,
          asset_id: secondAsset.asset_id,
          asset_sha256: secondAsset.sha256,
          document_version_id: null,
        },
      ];
      const downloaded = await Promise.all(
        selected.map(async (input) => {
          const response = await fetch(
            `${http!.origin}/api/v1/query/material-bytes`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                protocol_version: 1,
                request: {
                  literature_id: input.literature_id,
                  asset_id: input.asset_id,
                  asset_sha256: input.asset_sha256,
                },
              }),
            },
          );
          expect(response.status).toBe(200);
          expect(response.headers.get("x-sciretriever-asset-sha256")).toBe(
            input.asset_sha256,
          );
          const bytes = Buffer.from(await response.arrayBuffer());
          expect(await sha256(bytes)).toBe(input.asset_sha256);
          return bytes.toString("latin1");
        }),
      );
      expect(downloaded[0]).toContain("% synthetic 1");
      expect(downloaded[1]).toContain("% synthetic reading 3");
      const wrongAssociation = await fetch(
        `${http.origin}/api/v1/query/material-bytes`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            protocol_version: 1,
            request: {
              literature_id: literatureId,
              asset_id: secondAsset.asset_id,
              asset_sha256: secondAsset.sha256,
            },
          }),
        },
      );
      expect(wrongAssociation.status).toBe(404);
      expect(await wrongAssociation.json()).toMatchObject({
        code: "material-missing",
      });
      const readings = downloaded.map((pdf) => {
        const match = /% synthetic (?:reading )?(\d+)/.exec(pdf);
        if (!match) throw new Error("synthetic PDF reading missing");
        return Number(match[1]);
      });
      const base = await specification();
      const { spec_sha256: ignored, ...common } = base;
      void ignored;
      const objectContent = {
        ...common,
        spec_id: "external.nested-measurement",
        output_schema: {
          $schema: EXTRACTION_SCHEMA_URI,
          type: "object",
          properties: {
            sample: {
              type: "object",
              properties: {
                label: { type: "string" },
                reading: { type: "number" },
              },
              required: ["label", "reading"],
              additionalProperties: false,
            },
            tags: { type: "array", items: { type: "string" } },
          },
          required: ["sample", "tags"],
          additionalProperties: false,
        },
      };
      const spec = {
        ...objectContent,
        spec_sha256: await extractionSpecHash(objectContent),
      };
      const prepared = await query.extractionPreparation!.prepare({
        spec,
        inputs: selected,
      });
      expect(prepared.manifest.items.map((item) => item.document)).toEqual([
        null,
        null,
      ]);
      const source = await Promise.all(
        selected.map(async (input) => ({
          input_id: input.input_id,
          evidence: (
            await query!.documentRead!.materialEvidence({
              literature_id: input.literature_id,
              asset_id: input.asset_id,
            })
          ).evidence,
        })),
      );
      const created = await post("operation", {
        caller_id: "external.program",
        spec: prepared.spec,
        manifest: prepared.manifest,
      });
      expect(created.status).toBe(200);
      const operation = parseExtractionOperationResult(created.body.result);
      const record = (record_id: string, reading: number, input: number) => ({
        record_id,
        payload: {
          sample: { label: `synthetic-${reading}`, reading },
          tags: ["fixture"],
        },
        field_evidence: [{ pointer: "", sources: [source[input]!] }],
      });
      const batch = {
        schema_version: 1,
        operation_id: operation.operation_id,
        submission_key: "nested-cross-paper",
        batch_id: "batch-1",
        records: [
          record("one-a", readings[0]!, 0),
          record("one-b", readings[0]! + 1, 0),
          record("two-a", readings[1]!, 1),
        ],
        relations: [
          {
            relation_type: "compares-with",
            from: { record_id: "one-a", pointer: "" },
            to: { record_id: "two-a", pointer: "" },
            evidence: source,
          },
        ],
        coverage: selected.map((item) => ({
          input_id: item.input_id,
          status: "processed-with-records",
          reason: null,
        })),
        producer: {
          method_id: "external.synthetic",
          method_version: "1",
          usage: { pdf_reads: 2 },
        },
      };
      const posted = await post("submit", batch);
      expect(posted.status).toBe(200);
      const accepted = parseExtractionAcceptedResult(posted.body.result);
      expect(accepted.accepted_batch.records).toHaveLength(3);
      expect(accepted.accepted_batch.records[0]?.payload).toEqual(
        batch.records[0]?.payload,
      );
      expect(accepted.receipt.checks).toMatchObject({
        record_count: 3,
        relation_count: 1,
        coverage_count: 2,
      });
      expect(accepted.receipt.protected_materials).toHaveLength(2);
      expect((await post("submit", batch)).body.result).toEqual(accepted);
      expect(
        await env.app.extractionDelivery.receipt(accepted.receipt.receipt_id),
      ).toEqual(accepted.receipt);
      const changed = await post("submit", {
        ...batch,
        records: [record("one-a", 9, 0), ...batch.records.slice(1)],
      });
      expect(changed).toMatchObject({
        status: 409,
        body: { code: "submission-conflict" },
      });
      const outOfScope = await env.app.extractionDelivery.create({
        caller_id: "external.program",
        spec: prepared.spec,
        manifest: (
          await query.extractionPreparation!.prepare({
            spec,
            inputs: selected.slice(0, 1),
          })
        ).manifest,
      });
      await expect(
        env.app.extractionDelivery.submit({
          ...batch,
          operation_id: outOfScope.operation_id,
          submission_key: "out-of-scope",
          batch_id: "out-of-scope",
          records: [record("alien", 3, 1)],
          relations: [],
          coverage: [
            {
              input_id: "first-paper",
              status: "processed-with-records",
              reason: null,
            },
          ],
        }),
      ).rejects.toMatchObject({ code: "evidence-out-of-scope" });
      const zero = await env.app.extractionDelivery.create({
        caller_id: "external.program",
        spec: prepared.spec,
        manifest: prepared.manifest,
      });
      const empty = {
        ...batch,
        operation_id: zero.operation_id,
        submission_key: "zero",
        batch_id: "zero",
        records: [],
        relations: [],
        coverage: selected.map((item) => ({
          input_id: item.input_id,
          status: "processed-no-records",
          reason: null,
        })),
      };
      expect(
        (
          await env.app.extractionDelivery.submit(empty)
        ).accepted_batch.coverage.map((item) => item.status),
      ).toEqual(["processed-no-records", "processed-no-records"]);
      const wrongRead = await fetch(
        `${http.origin}/api/v1/query/material-bytes`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            protocol_version: 1,
            request: {
              literature_id: otherLiterature,
              asset_id: secondAsset.asset_id,
              asset_sha256: "f".repeat(64),
            },
          }),
        },
      );
      expect(wrongRead.status).toBe(409);
      const failed = await env.app.extractionDelivery.create({
        caller_id: "external.program",
        spec: prepared.spec,
        manifest: prepared.manifest,
      });
      const failureBatch = {
        ...empty,
        operation_id: failed.operation_id,
        submission_key: "failed",
        batch_id: "failed",
        coverage: [
          {
            input_id: "first-paper",
            status: "not-processed",
            reason: "operator deferred",
          },
          {
            input_id: "second-paper",
            status: "failed",
            reason: "synthetic hash mismatch",
          },
        ],
      };
      expect(
        (
          await env.app.extractionDelivery.submit(failureBatch)
        ).accepted_batch.coverage.map((item) => item.status),
      ).toEqual(["not-processed", "failed"]);
      const cancelled = await env.app.extractionDelivery.create({
        caller_id: "external.program",
        spec: prepared.spec,
        manifest: prepared.manifest,
      });
      await env.app.extractionDelivery.cancelOperation(cancelled.operation_id);
      await expect(
        env.app.extractionDelivery.submit({
          ...empty,
          operation_id: cancelled.operation_id,
          submission_key: "cancelled",
          batch_id: "cancelled",
        }),
      ).rejects.toMatchObject({ code: "operation-not-open" });
      const arrayContent = {
        ...common,
        spec_id: "external.labels",
        output_schema: {
          $schema: EXTRACTION_SCHEMA_URI,
          type: "array",
          items: { type: "string" },
        },
      };
      const arraySpec = {
        ...arrayContent,
        spec_sha256: await extractionSpecHash(arrayContent),
      };
      const arrayPrepared = await query.extractionPreparation!.prepare({
        spec: arraySpec,
        inputs: selected.slice(0, 1),
      });
      const arrayOperation = await env.app.extractionDelivery.create({
        caller_id: "external.program",
        spec: arraySpec,
        manifest: arrayPrepared.manifest,
      });
      const arrayAccepted = await env.app.extractionDelivery.submit({
        ...empty,
        operation_id: arrayOperation.operation_id,
        submission_key: "array-shape",
        batch_id: "array-shape",
        records: [
          {
            record_id: "labels",
            payload: ["one", "two"],
            field_evidence: [{ pointer: "", sources: [source[0]!] }],
          },
        ],
        coverage: [
          {
            input_id: "first-paper",
            status: "processed-with-records",
            reason: null,
          },
        ],
      });
      expect(arrayAccepted.accepted_batch.records[0]?.payload).toEqual([
        "one",
        "two",
      ]);
      const segmentContent = {
        ...objectContent,
        spec_id: "external.segment-required",
        evidence_policy: {
          ...objectContent.evidence_policy,
          field_granularity: "segment" as const,
        },
      };
      const segmentSpec = {
        ...segmentContent,
        spec_sha256: await extractionSpecHash(segmentContent),
      };
      const segmentPrepared = await query.extractionPreparation!.prepare({
        spec: segmentSpec,
        inputs: selected.slice(0, 1),
      });
      expect(segmentPrepared.missing_required_capabilities).toMatchObject([
        { input_id: "first-paper" },
      ]);
      const segmentOperation = await env.app.extractionDelivery.create({
        caller_id: "external.program",
        spec: segmentPrepared.spec,
        manifest: segmentPrepared.manifest,
      });
      await expect(
        env.app.extractionDelivery.submit({
          ...batch,
          operation_id: segmentOperation.operation_id,
          submission_key: "false-segment",
          batch_id: "false-segment",
          records: [record("false-segment", 1, 0)],
          relations: [],
          coverage: [
            {
              input_id: "first-paper",
              status: "processed-with-records",
              reason: null,
            },
          ],
        }),
      ).rejects.toMatchObject({ code: "evidence-granularity" });
    } finally {
      await http?.close();
      await query?.close();
      await env.close();
    }
  }, 30_000);
});
