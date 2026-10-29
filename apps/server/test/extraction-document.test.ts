import { SCHEMA_VERSION } from "../src/storage/sqlite/schema.js";
import { externalManifestFixture } from "./external-manifest-fixture.js";
import { inspectFixtureRetrieval } from "./current-catalog-fixture.js";
import { correctedDocumentFixture } from "./corrected-document-fixture.js";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import {
  createInputManifest,
  extractionSpecHash,
  extractionCanonicalJsonBytes,
  EXTRACTION_RECEIPT_MAX_BYTES,
  parseAsset,
  parseProvenance,
  sha256,
  type ArtifactRef,
} from "@sciretriever/contracts";
import { createParserFixtureApplication as createApplication } from "./parser-application-fixture.js";
import { createQueryApplication } from "../src/bootstrap/application.js";
import { TypeScriptParserArtifactRules } from "../src/parsing/artifact-rules.js";
import type { ParserBackend } from "./parser-fixture-types.js";
import {
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";

const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
let markdown = Buffer.from("# Synthetic\nThe measured value is 42.\n");
const documentArtifact = (
  bytes: Uint8Array,
  media_type: string,
): ArtifactRef => ({
  sha256: createHash("sha256")
    .update(bytes)
    .digest("hex") as ArtifactRef["sha256"],
  byte_size: bytes.length,
  media_type,
});
const parser: ParserBackend = {
  parse: async (request) => ({
    source_asset_id: request.source_asset_id,
    source_sha256: request.source_sha256,
    page_count: 1,
    markdown: {
      artifact: documentArtifact(markdown, "text/markdown"),
      bytes: markdown,
    },
    resources: [],
    provenance: {
      provenance: parseProvenance({
        provenance_id: id(990),
        source_kind: "parser",
        source_name: "synthetic",
        source_record_id: null,
        observed_at: "2026-09-29T00:00:00Z",
        input_sha256: request.source_sha256,
        parameters_sha256: "a".repeat(64),
      }),
      parser_version: "synthetic",
      mode: null,
      model_identity: null,
    },
  }),
};

// Budget covers migration, two real document versions, pin checks and index rebuild.
it("keeps a real DocumentVersion and ready retrieval index through reopening and rebuild", async () => {
  const home = await mkdtemp(
    join(tmpdir(), "sciretriever-extraction-document-"),
  );
  let app: Awaited<ReturnType<typeof createApplication>> | undefined;
  let query: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
  try {
    const catalog = join(home, "catalog.sqlite");
    const options = {
      parsing: { parser, rules: new TypeScriptParserArtifactRules() },
    };
    app = await createApplication(home, options);
    await app.database.putLiterature(FIXTURE_LITERATURE);
    const pdf = workbenchPdf();
    const stage = await app.files.stage();
    await stage.write(pdf);
    await app.files.publish(stage, "objects/source.pdf");
    const asset = parseAsset({
      asset_id: id(991),
      sha256: await sha256(pdf),
      size_bytes: pdf.length,
      media_type: "application/pdf",
      path: "objects/source.pdf",
    });
    await app.database.putLiteratureAsset({
      literature_asset_id: id(992),
      literature_id: FIXTURE_LITERATURE.literature_id,
      asset,
      role: "primary-pdf",
      source_url: null,
      provenance: parseProvenance({
        provenance_id: id(993),
        source_kind: "asset-provider",
        source_name: "synthetic",
        source_record_id: null,
        observed_at: "2026-09-29T00:00:00Z",
        input_sha256: asset.sha256,
        parameters_sha256: null,
      }),
    });
    await app.close();
    app = undefined;
    app = await createApplication(home, options);
    const receipt = await correctedDocumentFixture(app).parseDocuments({
      literature_id: FIXTURE_LITERATURE.literature_id,
      asset_id: asset.asset_id,
      asset_sha256: asset.sha256,
      mode: "reparse",
      expected_default_revision: null,
    });
    await app.close();
    app = undefined;
    app = await createApplication(home, {
      ...options,
    });
    await app.maintenance!.rebuildIndex();
    await app.close();
    app = undefined;
    const before = await inspectFixtureRetrieval(catalog);
    expect(before).toMatchObject({
      schema_version: SCHEMA_VERSION,
      active_generation: expect.any(String),
    });
    query = await createQueryApplication(home);
    expect(query.readiness).toMatchObject({
      status: "ready",
      schema_version: SCHEMA_VERSION,
    });
    const described = await query.documentRead!.describe({
      document_version_id: receipt.document.document_version_id,
    });
    expect(described.document.representation_sha256).toBe(
      receipt.document.representation_sha256,
    );
    expect(described.segment_count).toBeGreaterThan(0);
    const content = {
      schema_version: 1 as const,
      spec_id: "synthetic.document",
      spec_version: "1",
      record_meaning: "一条记录代表合成文档中的一项观察。",
      output_schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
      },
      field_instructions: [],
      inclusion_rules: [],
      missing_value_rules: [],
      evidence_policy: {
        field_granularity: "segment" as const,
        required_pointers: "record-root" as const,
        cross_input_relation: "optional" as const,
      },
      required_capabilities: ["document-segment-v1" as const],
    };
    const prepared = await externalManifestFixture(query.documentRead!, {
      spec: { ...content, spec_sha256: await extractionSpecHash(content) },
      inputs: [
        {
          input_id: "source-1",
          literature_id: FIXTURE_LITERATURE.literature_id,
          asset_id: asset.asset_id,
          asset_sha256: asset.sha256,
          document_version_id: receipt.document.document_version_id,
        },
      ],
    });
    expect(prepared.manifest.items[0]?.document?.representation_sha256).toBe(
      receipt.document.representation_sha256,
    );
    expect(prepared.missing_required_capabilities).toEqual([]);
    await query.close();
    query = undefined;
    app = await createApplication(home, {
      ...options,
    });
    const forgedCapabilities = await createInputManifest(
      prepared.manifest.items.map((item) => ({
        ...item,
        capabilities: ["material-file-v1", "document-segment-v1"],
      })),
    );
    await expect(
      app.extractionDelivery.create({
        caller_id: "local.forged-capabilities",
        spec: prepared.spec,
        manifest: forgedCapabilities,
      }),
    ).rejects.toMatchObject({ code: "input-stale" });
    const operation = await app.extractionDelivery.create({
      caller_id: "local.document-pin",
      spec: prepared.spec,
      manifest: prepared.manifest,
    });
    const segments = await app.documentRead.segments({
      document_version_id: receipt.document.document_version_id,
      section_id: null,
      limit: 200,
      cursor: null,
    });
    const segment = segments.segments.find((item) => item.kind === "text");
    expect(segment).toBeTruthy();
    const slice = await app.documentRead.slice({
      document_version_id: receipt.document.document_version_id,
      selector: { kind: "segment", segment_id: segment!.segment_id },
      max_bytes: 65536,
      continuation: null,
    });
    const delivered = await app.extractionDelivery.submit({
      schema_version: 1,
      operation_id: operation.operation_id,
      submission_key: "document-candidate",
      batch_id: "document-batch",
      records: [
        {
          record_id: "observation-1",
          payload: { value: "42" },
          field_evidence: [
            {
              pointer: "",
              sources: [{ input_id: "source-1", evidence: slice.evidence[0] }],
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
      producer: {
        method_id: "synthetic.document",
        method_version: "1",
        usage: {},
      },
    });
    expect(delivered.receipt.protected_materials).toHaveLength(1);
    expect(delivered.receipt.protected_documents).toHaveLength(1);
    markdown = Buffer.from("# Synthetic v2\nThe measured value is 43.\n");
    const next = await correctedDocumentFixture(app).parseDocuments({
      literature_id: FIXTURE_LITERATURE.literature_id,
      asset_id: asset.asset_id,
      asset_sha256: asset.sha256,
      mode: "reparse",
      expected_default_revision: receipt.default_revision,
    });
    expect(next.document.document_version_id).not.toBe(
      receipt.document.document_version_id,
    );
    const oldStructure = await app.database.locateArtifact(
      receipt.document.structure,
    );
    expect(oldStructure).not.toBeNull();
    await expect(
      app.artifactReclaimer.reclaim([
        {
          reference: oldStructure!.reference,
          artifact: receipt.document.structure,
        },
      ]),
    ).resolves.toMatchObject({
      deleted: [],
      preserved: [oldStructure!.reference],
    });
    expect(
      await app.documentRead.resolveEvidence(slice.evidence[0]),
    ).toMatchObject({
      document: { document_version_id: receipt.document.document_version_id },
      text: expect.stringContaining("42"),
    });
    expect(
      await app.extractionDelivery.receipt(delivered.receipt.receipt_id),
    ).toEqual(delivered.receipt);
    const pinned = new DatabaseSync(catalog, { readOnly: true });
    try {
      expect(
        (
          pinned
            .prepare(
              "SELECT count(*) AS n FROM extraction_receipt_documents WHERE receipt_id=?",
            )
            .get(delivered.receipt.receipt_id) as { n: number }
        ).n,
      ).toBe(1);
    } finally {
      pinned.close();
    }
    const inputIds = Array.from(
      { length: 128 },
      (_, index) =>
        `source-${String(index).padStart(3, "0")}-${"x".repeat(117)}`,
    );
    const largePrepared = await externalManifestFixture(app.documentRead, {
      spec: prepared.spec,
      inputs: inputIds.map((input_id) => ({
        input_id,
        literature_id: FIXTURE_LITERATURE.literature_id,
        asset_id: asset.asset_id,
        asset_sha256: asset.sha256,
        document_version_id: receipt.document.document_version_id,
      })),
    });
    const largeOperation = await app.extractionDelivery.create({
      caller_id: "local.large-document-pin",
      spec: largePrepared.spec,
      manifest: largePrepared.manifest,
    });
    const largeBatch = {
      schema_version: 1,
      operation_id: largeOperation.operation_id,
      submission_key: "large-document-candidate",
      batch_id: "large-document-batch",
      records: [],
      relations: [],
      coverage: inputIds.map((input_id) => ({
        input_id,
        status: "processed-no-records",
        reason: null,
      })),
      producer: {
        method_id: "synthetic.document",
        method_version: "1",
        usage: {},
      },
    };
    const largeAccepted = await app.extractionDelivery.submit(largeBatch);
    expect(largeAccepted.receipt.protected_materials).toHaveLength(128);
    expect(largeAccepted.receipt.protected_documents).toHaveLength(128);
    expect(
      extractionCanonicalJsonBytes(
        largeAccepted.receipt,
        EXTRACTION_RECEIPT_MAX_BYTES,
      ).length,
    ).toBeGreaterThan(65536);
    expect(
      (await app.extractionDelivery.submit(largeBatch)).receipt.receipt_id,
    ).toBe(largeAccepted.receipt.receipt_id);
    expect(
      await app.extractionDelivery.receipt(largeAccepted.receipt.receipt_id),
    ).toEqual(largeAccepted.receipt);
    const rebuilt = await app.maintenance!.rebuildIndex();
    expect(rebuilt).toBeTruthy();
    expect(await inspectFixtureRetrieval(catalog)).toMatchObject({
      schema_version: SCHEMA_VERSION,
      active_generation: expect.any(String),
    });
    await app.close();
    app = undefined;
    const damaged = new DatabaseSync(catalog);
    try {
      damaged.exec("DROP INDEX retrieval_entries_version");
    } finally {
      damaged.close();
    }
    await expect(inspectFixtureRetrieval(catalog)).rejects.toThrow();
    query = await createQueryApplication(home);
    expect(query.readiness.status).toBe("ready");
    expect(
      (await query.query!.detail(FIXTURE_LITERATURE.literature_id)).literature
        .literature_id,
    ).toBe(FIXTURE_LITERATURE.literature_id);
    expect(
      (
        await query.documentRead!.describe({
          document_version_id: receipt.document.document_version_id,
        })
      ).document.document_version_id,
    ).toBe(receipt.document.document_version_id);
  } finally {
    await query?.close();
    await app?.close();
    await rm(home, { recursive: true, force: true });
  }
}, 60_000);
