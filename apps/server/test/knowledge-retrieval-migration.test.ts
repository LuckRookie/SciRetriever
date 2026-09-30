import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { build } from "esbuild";
import { chromium } from "playwright";
import { SqliteWorker } from "../src/storage/sqlite/worker.js";
import { migrateDocumentCatalog } from "../src/storage/sqlite/document-migration.js";
import { migrateRetrievalCatalog } from "../src/storage/sqlite/retrieval-migration.js";
import { migrateExtractionCatalog } from "../src/storage/sqlite/extraction-migration.js";
import { migrateKnowledgeCatalog } from "../src/storage/sqlite/knowledge-migration.js";
import {
  migrateSynthesisCatalog,
  inspectSynthesisCatalog,
} from "../src/storage/sqlite/synthesis-migration.js";
import {
  inspectKnowledgeRetrievalCatalog,
  migrateKnowledgeRetrievalCatalog,
} from "../src/storage/sqlite/knowledge-retrieval-migration.js";
import {
  SCHEMA_V8_FINGERPRINT,
  SCHEMA_V8_MANIFEST,
} from "../src/storage/sqlite/schema-v8.js";
import { SCHEMA_V7_MANIFEST } from "../src/storage/sqlite/schema-v7.js";
import { RetrievalStorageEngine } from "../src/storage/sqlite/retrieval-engine.js";
import { RetrievalStorageClient } from "../src/storage/sqlite/retrieval-client.js";
import { KnowledgeRetrievalIndexService } from "../src/retrieval/knowledge-index.js";
import { KnowledgeContextService } from "../src/retrieval/knowledge-query.js";
import { startQueryOnlyHttp } from "../src/workbench/http.js";
import { runCli } from "../src/cli/main.js";
import { MaterialContextService } from "../src/retrieval/query.js";
import { RetrievalIndexService } from "../src/retrieval/index.js";
import {
  createApplication,
  createQueryApplication,
} from "../src/bootstrap/application.js";
import {
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";
import { TypeScriptParserArtifactRules } from "../src/parsing/artifact-rules.js";
import { SqliteKnowledgeStorage } from "../src/storage/knowledge.js";
import { SqliteSynthesisStorage } from "../src/storage/synthesis.js";
import { KnowledgeAnalysisService } from "../src/analysis/knowledge.js";
import { AgentRuntime } from "../src/agents/runtime.js";
import type { AgentAdapter, AgentResult } from "../src/agents/protocol.js";
import { SynthesisPreparationService } from "../src/analysis/synthesis-prepare.js";
import type { ExtractionPreparation } from "../src/extraction/prepare.js";
import {
  createInputManifest,
  parseAsset,
  parseLiterature,
  parseProvenance,
  sha256,
  synthesisComparisonSha256,
  synthesisContentBytes,
  extractionCanonicalJsonBytes,
  extractionSpecHash,
  EXTRACTION_SCHEMA_URI,
} from "@sciretriever/contracts";
import {
  EXECUTION_SCHEMA_FINGERPRINT,
  EXECUTION_SCHEMA_VERSION,
  EXECUTION_RUNTIME_SCHEMA_FINGERPRINT,
  EXECUTION_RUNTIME_SCHEMA_VERSION,
} from "../src/storage/sqlite/execution-schema.js";

async function catalogV7(root: string): Promise<string> {
  const catalog = join(root, "catalog.sqlite");
  const worker = new SqliteWorker(catalog);
  try {
    await worker.schema();
  } finally {
    await worker.close();
  }
  await migrateDocumentCatalog({
    catalog_path: catalog,
    backup_path: join(root, "before-v3.sqlite"),
  });
  await migrateRetrievalCatalog({
    catalog_path: catalog,
    backup_path: join(root, "before-v4.sqlite"),
  });
  await migrateExtractionCatalog({
    catalog_path: catalog,
    backup_path: join(root, "before-v5.sqlite"),
  });
  await migrateKnowledgeCatalog({
    catalog_path: catalog,
    backup_path: join(root, "before-v6.sqlite"),
  });
  await migrateSynthesisCatalog({
    catalog_path: catalog,
    backup_path: join(root, "before-v7.sqlite"),
  });
  return catalog;
}

async function queryWebAssets() {
  const assets = new Map<
    string,
    { contentType: string; body: string | Uint8Array }
  >();
  for (const [route, name] of [
    ["/", "maintenance.html"],
    ["/query", "query.html"],
  ] as const)
    assets.set(route, {
      contentType: "text/html",
      body: await readFile(
        new URL(`../../web/public/${name}`, import.meta.url),
      ),
    });
  for (const [route, name] of [
    ["/maintenance.js", "maintenance.ts"],
    ["/query.js", "query.ts"],
  ] as const) {
    const bundle = await build({
      entryPoints: [new URL(`../../web/src/${name}`, import.meta.url).pathname],
      bundle: true,
      format: "esm",
      platform: "browser",
      write: false,
    });
    assets.set(route, {
      contentType: "text/javascript",
      body: bundle.outputFiles[0]!.contents,
    });
  }
  return assets;
}
const config = {
  schema_version: 8 as const,
  schema_fingerprint: SCHEMA_V8_FINGERPRINT,
  schema_manifest: SCHEMA_V8_MANIFEST,
  execution_schema_version: EXECUTION_SCHEMA_VERSION,
  execution_schema_fingerprint: EXECUTION_SCHEMA_FINGERPRINT,
  execution_runtime_schema_version: EXECUTION_RUNTIME_SCHEMA_VERSION,
  execution_runtime_schema_fingerprint: EXECUTION_RUNTIME_SCHEMA_FINGERPRINT,
};

async function populatedCatalogV7(
  root: string,
  twoStatements = false,
  longContext = false,
) {
  const lit = FIXTURE_LITERATURE.literature_id;
  let app = await createApplication(root);
  const pdf = workbenchPdf();
  const asset = parseAsset({
    asset_id: "00000000-0000-0000-0000-000000000800",
    sha256: await sha256(pdf),
    size_bytes: pdf.length,
    media_type: "application/pdf",
    path: "objects/knowledge-source.pdf",
  });
  try {
    await app.database.putLiterature(FIXTURE_LITERATURE);
    const stage = await app.files.stage();
    try {
      await stage.write(pdf);
      await app.files.publish(stage, "objects/knowledge-source.pdf");
    } finally {
      await stage.discard();
    }
    await app.database.putLiteratureAsset({
      literature_asset_id: "00000000-0000-0000-0000-000000000801",
      literature_id: lit,
      asset,
      role: "primary-pdf",
      source_url: null,
      provenance: parseProvenance({
        provenance_id: "00000000-0000-0000-0000-000000000802",
        source_kind: "asset-provider",
        source_name: "synthetic",
        source_record_id: null,
        observed_at: "2026-09-29T00:00:00Z",
        input_sha256: asset.sha256,
        parameters_sha256: null,
      }),
    });
  } finally {
    await app.close();
  }
  const catalog = join(root, "catalog.sqlite");
  await migrateDocumentCatalog({
    catalog_path: catalog,
    backup_path: join(root, "before-v3.sqlite"),
  });
  await migrateRetrievalCatalog({
    catalog_path: catalog,
    backup_path: join(root, "before-v4.sqlite"),
  });
  await migrateExtractionCatalog({
    catalog_path: catalog,
    backup_path: join(root, "before-v5.sqlite"),
  });
  await migrateKnowledgeCatalog({
    catalog_path: catalog,
    backup_path: join(root, "before-v6.sqlite"),
  });
  const detail = longContext ? " Verified measurement context.".repeat(90) : "";
  const markdown = Buffer.from(
    `# Synthetic result\nThe measurement was 4.2 eV under dry conditions.${detail}\n`,
  );
  app = await createApplication(root, {
    executionSchema: "require-v2",
    parsing: {
      rules: new TypeScriptParserArtifactRules(),
      parser: {
        parse: async (request) => ({
          source_asset_id: request.source_asset_id,
          source_sha256: request.source_sha256,
          page_count: 1,
          markdown: {
            artifact: {
              sha256: await sha256(markdown),
              byte_size: markdown.length,
              media_type: "text/markdown",
            },
            bytes: markdown,
          },
          resources: [],
          provenance: {
            provenance: parseProvenance({
              provenance_id: "00000000-0000-0000-0000-000000000810",
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
      },
    },
  });
  let knowledgeId = "";
  let documentId = "";
  try {
    const parsed = await app.documentProcessing.parseDocuments({
      literature_id: lit,
      asset_id: asset.asset_id,
      asset_sha256: asset.sha256,
      mode: "reparse",
      expected_default_revision: null,
    });
    documentId = parsed.document.document_version_id;
    const material = await app.documentRead.materialEvidence({
      literature_id: lit,
      asset_id: asset.asset_id,
    });
    if (material.evidence.target_kind !== "material")
      throw new Error("synthetic material invalid");
    const described = await app.documentRead.describe({
      document_version_id: documentId,
    });
    const manifest = await createInputManifest([
      {
        input_id: "paper-1",
        literature_id: lit,
        material: material.evidence.material,
        document: described.document,
        capabilities: [
          "material-file-v1",
          "document-segment-v1",
          "document-text-v1",
          "document-outline-v1",
          "document-resources-v1",
        ],
        gaps: [],
      },
    ]);
    const adapter: AgentAdapter = {
      provider: "fixture",
      model: "synthetic",
      execute: async (call): Promise<AgentResult> => {
        const part = call.messages[1]?.parts[0];
        if (!part || part.media_type !== "application/json")
          throw new Error("missing prompt");
        const input = JSON.parse(part.text) as {
          segments: { segment_id: string }[];
        };
        return {
          kind: "structured",
          value: {
            outcome: "completed",
            title: "Synthetic finding",
            statements: [
              {
                statement_id: "finding-1",
                category: "result",
                epistemic: "reported",
                text: `4.2 eV under dry conditions${detail}`,
                conditions: [
                  `dry conditions${longContext ? " Verified measurement context.".repeat(25) : ""}`,
                  "β-phase protocol",
                ],
                quantity: {
                  value: "4.2",
                  unit: "eV",
                  comparison_basis: "ambient baseline",
                },
                evidence_segment_ids: [
                  input.segments[1]?.segment_id ??
                    input.segments[0]!.segment_id,
                ],
              },
              ...(twoStatements
                ? [
                    {
                      statement_id: "finding-2",
                      category: "result",
                      epistemic: "reported",
                      text: "4.2 eV under the β-phase protocol",
                      conditions: ["β-phase protocol"],
                      quantity: {
                        value: "4.2",
                        unit: "eV",
                        comparison_basis: "ambient baseline",
                      },
                      evidence_segment_ids: [
                        input.segments[1]?.segment_id ??
                          input.segments[0]!.segment_id,
                      ],
                    },
                  ]
                : []),
            ],
          },
          provenance: {
            provider: "fixture",
            model: "synthetic",
            usage: { input_tokens: 100, output_tokens: 50 },
          },
        };
      },
    };
    const agent = new AgentRuntime([
      {
        role: "analysis",
        provider: "fixture",
        model: "synthetic",
        capabilities: ["structured_text"],
        reasoning: "default",
        stream: false,
        context_window_tokens: 1000000,
        max_output_tokens: 10000,
        adapter,
      },
    ]);
    const storage = new SqliteKnowledgeStorage(
      app.database,
      app.files,
      app.documentRead,
    );
    const service = new KnowledgeAnalysisService(
      app.documentRead,
      agent,
      storage,
    );
    try {
      const receipt = await service.analyze({
        schema_version: 1,
        input: manifest,
        purpose: "overview",
        question: null,
        default_update: { expected_revision: null },
        budget: { max_input_bytes: 65536, max_output_tokens: 2048 },
      });
      knowledgeId = receipt.artifact.artifact_id;
    } finally {
      await service.close();
      agent.close();
    }
  } finally {
    await app.close();
  }
  await migrateSynthesisCatalog({
    catalog_path: catalog,
    backup_path: join(root, "before-v7.sqlite"),
  });
  app = await createApplication(root, { executionSchema: "require-v2" });
  let synthesisId = "";
  try {
    const synth = new SqliteSynthesisStorage(
      app.database,
      app.files,
      app.documentRead,
    );
    const prepare = new SynthesisPreparationService(
      app.documentRead,
      app.library,
      synth,
    );
    const prepared = await prepare.prepare({
      policy: "allow-partial",
      inputs: [
        {
          kind: "knowledge",
          input_id: "source-1",
          source_artifact_id: knowledgeId,
        },
        {
          kind: "knowledge",
          input_id: "missing-2",
          source_artifact_id: "00000000-0000-0000-0000-000000000999",
        },
      ],
    });
    if (!prepared.ready) throw new Error("synthetic synthesis unready");
    const source = await new SqliteKnowledgeStorage(
      app.database,
      app.files,
      app.documentRead,
    ).byId(knowledgeId);
    if (!source) throw new Error("synthetic knowledge missing");
    const statement = source.content.statements[0]!;
    const content = {
      schema_version: 2 as const,
      title: "Synthetic comparison",
      statements: [
        {
          ...statement,
          relation: "single-source" as const,
          conflict_group_id: null,
          evidence: [
            {
              input_id: "source-1",
              target_kind: "knowledge" as const,
              source_artifact_id: knowledgeId,
              source_content_sha256: source.content_ref.sha256,
              statement_id: statement.statement_id,
              statement_sha256: await sha256(
                extractionCanonicalJsonBytes(statement, 64 * 1024),
              ),
            },
          ],
        },
      ],
    };
    const bytes = synthesisContentBytes(content);
    const method = {
      id: "synthetic-synthesis",
      version: "1",
      parameters_sha256: "a".repeat(64),
      model_binding_sha256: "b".repeat(64),
    };
    const question = "Which conditions?";
    const comparison = await synthesisComparisonSha256({
      manifest_sha256: prepared.manifest.manifest_sha256,
      question,
      policy: "allow-partial",
      method,
    });
    const artifact = {
      schema_version: 2 as const,
      artifact_id: `${comparison.slice(0, 8)}-${comparison.slice(8, 12)}-${comparison.slice(12, 16)}-${comparison.slice(16, 20)}-${comparison.slice(20, 32)}`,
      comparison_sha256: comparison,
      purpose: "synthesis" as const,
      question,
      input: prepared.manifest,
      method,
      content_ref: {
        sha256: await sha256(bytes),
        byte_size: bytes.length,
        media_type: "application/vnd.sciretriever.knowledge+json" as const,
      },
      content,
      coverage: {
        schema_version: 2 as const,
        status: "partial" as const,
        policy: "allow-partial" as const,
        items: [
          { input_id: "source-1", status: "included" as const, reason: null },
          {
            input_id: "missing-2",
            status: "excluded" as const,
            reason: "knowledge-missing" as const,
          },
        ],
        unique_literature_count: 1,
      },
      provenance: {
        provider: "fake",
        model: "fake",
        generated_at: "2026-09-29T00:00:00.000Z",
        input_tokens: 1,
        output_tokens: 1,
      },
      compression_depth: 2,
    };
    synthesisId = (await synth.publish(artifact)).artifact.artifact_id;
  } finally {
    await app.close();
  }
  return { catalog, lit, documentId, knowledgeId, synthesisId };
}

async function publishTwoPaperSynthesis(
  root: string,
  first: Awaited<ReturnType<typeof populatedCatalogV7>>,
) {
  const secondLiterature = "00000000-0000-0000-0000-000000000901";
  const secondAsset = "00000000-0000-0000-0000-000000000902";
  const app = await createApplication(root, {
    executionSchema: "require-v2",
    parsing: {
      rules: new TypeScriptParserArtifactRules(),
      parser: {
        parse: async (request) => {
          const markdown = Buffer.from(
            "# Wet result\nThe measurement was 5.7 eV under wet conditions.\n",
          );
          return {
            source_asset_id: request.source_asset_id,
            source_sha256: request.source_sha256,
            page_count: 1,
            markdown: {
              artifact: {
                sha256: await sha256(markdown),
                byte_size: markdown.length,
                media_type: "text/markdown",
              },
              bytes: markdown,
            },
            resources: [],
            provenance: {
              provenance: parseProvenance({
                provenance_id: "00000000-0000-0000-0000-000000000903",
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
          };
        },
      },
    },
  });
  try {
    const doi = "10.5555/sciretriever.fixture.second";
    await app.database.putLiterature(
      parseLiterature({
        ...FIXTURE_LITERATURE,
        literature_id: secondLiterature,
        meta_literature_id: "00000000-0000-0000-0000-000000000904",
        metadata: {
          ...FIXTURE_LITERATURE.metadata,
          title: "Synthetic wet result",
          identifiers: [{ namespace: "doi", value: doi }],
        },
      }),
    );
    const pdf = workbenchPdf(doi);
    const path = "objects/knowledge-source-second.pdf";
    const stage = await app.files.stage();
    try {
      await stage.write(pdf);
      await app.files.publish(stage, path);
    } finally {
      await stage.discard();
    }
    const asset = parseAsset({
      asset_id: secondAsset,
      sha256: await sha256(pdf),
      size_bytes: pdf.length,
      media_type: "application/pdf",
      path,
    });
    await app.database.putLiteratureAsset({
      literature_asset_id: "00000000-0000-0000-0000-000000000905",
      literature_id: secondLiterature,
      asset,
      role: "primary-pdf",
      source_url: null,
      provenance: parseProvenance({
        provenance_id: "00000000-0000-0000-0000-000000000906",
        source_kind: "asset-provider",
        source_name: "synthetic",
        source_record_id: null,
        observed_at: "2026-09-29T00:00:00Z",
        input_sha256: asset.sha256,
        parameters_sha256: null,
      }),
    });
    const parsed = await app.documentProcessing.parseDocuments({
      literature_id: secondLiterature,
      asset_id: secondAsset,
      asset_sha256: asset.sha256,
      mode: "reparse",
      expected_default_revision: null,
    });
    const firstMaterial = await app.documentRead.materialEvidence({
      literature_id: first.lit,
      asset_id: "00000000-0000-0000-0000-000000000800",
    });
    if (firstMaterial.evidence.target_kind !== "material")
      throw new Error("first material missing");
    const prepared = await app.synthesisPreparation!.prepare({
      policy: "require-all",
      inputs: [
        {
          kind: "document",
          input_id: "dry-paper",
          literature_id: first.lit,
          asset_id: firstMaterial.evidence.material.asset_id,
          asset_sha256: firstMaterial.evidence.material.asset_sha256,
          document_version_id: first.documentId,
        },
        {
          kind: "document",
          input_id: "wet-paper",
          literature_id: secondLiterature,
          asset_id: secondAsset,
          asset_sha256: asset.sha256,
          document_version_id: parsed.document.document_version_id,
        },
      ],
    });
    if (!prepared.ready) throw new Error("two-paper synthesis unready");
    const evidence = async (document_version_id: string) => {
      const segments = await app.documentRead.segments({
        document_version_id,
        section_id: null,
        limit: 200,
        cursor: null,
      });
      const text = segments.segments.find((segment) => segment.kind === "text");
      if (!text) throw new Error("text segment missing");
      const slice = await app.documentRead.slice({
        document_version_id,
        selector: { kind: "segment", segment_id: text.segment_id },
        max_bytes: 65536,
        continuation: null,
      });
      const found = slice.evidence.find(
        (item) =>
          item.target_kind === "document" &&
          item.locator.segment_id === text.segment_id,
      );
      if (!found || found.target_kind !== "document")
        throw new Error("document evidence missing");
      return found;
    };
    const dry = await evidence(first.documentId);
    const wet = await evidence(parsed.document.document_version_id);
    const statement = (
      statement_id: string,
      text: string,
      input_id: string,
      proof: typeof dry,
    ) => ({
      statement_id,
      category: "result" as const,
      epistemic: "reported" as const,
      relation: "single-source" as const,
      conflict_group_id: null,
      text,
      conditions: [
        input_id === "dry-paper" ? "dry conditions" : "wet conditions",
      ],
      quantity: {
        value: input_id === "dry-paper" ? "4.2" : "5.7",
        unit: "eV",
        comparison_basis: "ambient baseline",
      },
      evidence: [
        { input_id, target_kind: "document" as const, evidence: proof },
      ],
    });
    const content = {
      schema_version: 2 as const,
      title: "Two-paper comparison",
      statements: [
        statement(
          "dry-finding",
          "4.2 eV under dry conditions",
          "dry-paper",
          dry,
        ),
        statement(
          "wet-finding",
          "5.7 eV under wet conditions",
          "wet-paper",
          wet,
        ),
      ],
    };
    const bytes = synthesisContentBytes(content);
    const method = {
      id: "synthetic-two-paper",
      version: "1",
      parameters_sha256: "a".repeat(64),
      model_binding_sha256: "b".repeat(64),
    };
    const question = "Compare wet and dry conditions?";
    const comparison = await synthesisComparisonSha256({
      manifest_sha256: prepared.manifest.manifest_sha256,
      question,
      policy: "require-all",
      method,
    });
    const artifact = {
      schema_version: 2 as const,
      artifact_id: `${comparison.slice(0, 8)}-${comparison.slice(8, 12)}-${comparison.slice(12, 16)}-${comparison.slice(16, 20)}-${comparison.slice(20, 32)}`,
      comparison_sha256: comparison,
      purpose: "synthesis" as const,
      question,
      input: prepared.manifest,
      method,
      content_ref: {
        sha256: await sha256(bytes),
        byte_size: bytes.length,
        media_type: "application/vnd.sciretriever.knowledge+json" as const,
      },
      content,
      coverage: {
        schema_version: 2 as const,
        status: "complete" as const,
        policy: "require-all" as const,
        items: [
          { input_id: "dry-paper", status: "included" as const, reason: null },
          { input_id: "wet-paper", status: "included" as const, reason: null },
        ],
        unique_literature_count: 2,
      },
      provenance: {
        provider: "fake",
        model: "fake",
        generated_at: "2026-09-29T00:00:00.000Z",
        input_tokens: 1,
        output_tokens: 1,
      },
      compression_depth: 1,
    };
    const synth = new SqliteSynthesisStorage(
      app.database,
      app.files,
      app.documentRead,
    );
    const published = await synth.publish(artifact);
    return {
      artifact_id: published.artifact.artifact_id,
      secondLiterature,
      documentId: parsed.document.document_version_id,
    };
  } finally {
    await app.close();
  }
}

describe("knowledge retrieval catalog v8", () => {
  it("counts independent sources per statement across two published Literature records", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "sciretriever-knowledge-retrieval-origins-"),
    );
    try {
      const first = await populatedCatalogV7(root);
      const second = await publishTwoPaperSynthesis(root, first);
      await migrateKnowledgeRetrievalCatalog({
        catalog_path: first.catalog,
        backup_path: join(root, "before-v8.sqlite"),
      });
      const app = await createApplication(root, {
        executionSchema: "require-v2",
      });
      try {
        await app.maintenance!.rebuildKnowledgeIndex!();
      } finally {
        await app.close();
      }
      const query = await createQueryApplication(root);
      try {
        const request = {
          schema_version: 2,
          query: "4.2",
          scope: { kind: "library" },
          kinds: ["knowledge"],
          versions: { kind: "default" },
          knowledge: {
            purposes: ["overview", "synthesis"],
            question: null,
            selection: "all",
            artifact_ids: [],
          },
          budget: { max_items: 20, max_bytes: 262144, token_limit: null },
          continuation: null,
        };
        const dry = await query.knowledgeContext!.search(request);
        const dryHit = dry.items.find(
          (item) =>
            item.kind === "generated-knowledge" &&
            item.reference.artifact_id === second.artifact_id,
        );
        expect(dryHit).toMatchObject({
          kind: "generated-knowledge",
          reference: { statement_id: "dry-finding" },
          source_literature_ids: [first.lit, second.secondLiterature],
          independent_literature_ids: [first.lit],
        });
        expect(
          dry.items.some(
            (item) =>
              item.kind === "generated-knowledge" &&
              item.reference.artifact_id === first.knowledgeId,
          ),
        ).toBe(true);
        const wet = await query.knowledgeContext!.search({
          ...request,
          query: "5.7",
        });
        const wetHits = wet.items.filter(
          (item) => item.kind === "generated-knowledge",
        );
        expect(wetHits).toHaveLength(1);
        expect(wetHits[0]).toMatchObject({
          reference: {
            artifact_id: second.artifact_id,
            statement_id: "wet-finding",
          },
          independent_literature_ids: [second.secondLiterature],
        });
        expect(
          wetHits[0]?.kind === "generated-knowledge" &&
            wetHits[0].source_layers.map((layer) => layer.state),
        ).toEqual(["verified", "verified"]);
        const unrelated = await query.knowledgeContext!.search({
          ...request,
          query: "unrelated-token",
        });
        expect(unrelated.items).toHaveLength(0);
        expect(unrelated.gaps.map((item) => item.code)).not.toContain(
          "knowledge-missing",
        );
        const scopedOverview = await query.knowledgeContext!.search({
          ...request,
          scope: {
            kind: "literatures",
            literature_ids: [first.lit, second.secondLiterature],
          },
          knowledge: {
            ...request.knowledge,
            purposes: ["overview"],
          },
        });
        expect(
          scopedOverview.items.some(
            (item) =>
              item.kind === "generated-knowledge" &&
              item.reference.artifact_id === first.knowledgeId,
          ),
        ).toBe(true);
        expect(scopedOverview.gaps).toContainEqual({
          code: "knowledge-missing",
          literature_id: second.secondLiterature,
          artifact_id: null,
        });
        const absentArtifact = "00000000-0000-0000-0000-000000000999";
        const explicit = await query.knowledgeContext!.search({
          ...request,
          scope: {
            kind: "artifacts",
            artifact_ids: [first.knowledgeId, absentArtifact],
          },
          knowledge: {
            ...request.knowledge,
            selection: "explicit",
            artifact_ids: [first.knowledgeId, absentArtifact],
          },
        });
        expect(
          explicit.items.some(
            (item) =>
              item.kind === "generated-knowledge" &&
              item.reference.artifact_id === first.knowledgeId,
          ),
        ).toBe(true);
        expect(explicit.gaps).toContainEqual({
          code: "knowledge-missing",
          literature_id: null,
          artifact_id: absentArtifact,
        });
        const reads = vi.spyOn(SqliteWorker.prototype, "knowledge");
        try {
          const shared = await query.knowledgeContext!.search({
            ...request,
            query: "eV",
          });
          expect(
            shared.items.filter(
              (item) =>
                item.kind === "generated-knowledge" &&
                item.reference.artifact_id === second.artifact_id,
            ),
          ).toHaveLength(2);
          expect(
            reads.mock.calls.filter(
              ([action, id]) => action === "id" && id === second.artifact_id,
            ),
          ).toHaveLength(1);
        } finally {
          reads.mockRestore();
        }
      } finally {
        await query.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
  it("keeps healthy knowledge hits when one indexed source loses its published bytes", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "sciretriever-knowledge-retrieval-source-gap-"),
    );
    try {
      const fixture = await populatedCatalogV7(root);
      await migrateKnowledgeRetrievalCatalog({
        catalog_path: fixture.catalog,
        backup_path: join(root, "before-v8.sqlite"),
      });
      const app = await createApplication(root, {
        executionSchema: "require-v2",
      });
      try {
        await app.maintenance!.rebuildKnowledgeIndex!();
      } finally {
        await app.close();
      }
      const catalog = new DatabaseSync(fixture.catalog, { readOnly: true });
      let contentPath: string;
      try {
        const row = catalog
          .prepare(
            "SELECT content_reference FROM knowledge_artifacts WHERE artifact_id=?",
          )
          .get(fixture.synthesisId) as
          | { content_reference: string }
          | undefined;
        if (!row) throw new Error("published synthesis missing");
        contentPath = row.content_reference;
      } finally {
        catalog.close();
      }
      await rm(join(root, "artifacts", contentPath));
      const query = await createQueryApplication(root);
      try {
        const result = await query.knowledgeContext!.search({
          schema_version: 2,
          query: "4.2",
          scope: { kind: "library" },
          kinds: ["knowledge"],
          versions: { kind: "default" },
          knowledge: {
            purposes: ["overview", "synthesis"],
            question: null,
            selection: "all",
            artifact_ids: [],
          },
          budget: { max_items: 20, max_bytes: 262144, token_limit: null },
          continuation: null,
        });
        expect(
          result.items.map(
            (item) =>
              item.kind === "generated-knowledge" && item.reference.artifact_id,
          ),
        ).toEqual([fixture.knowledgeId]);
        expect(result.coverage).toBe("partial");
        expect(result.gaps).toContainEqual({
          code: "source-corrupt",
          literature_id: null,
          artifact_id: fixture.synthesisId,
        });
      } finally {
        await query.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("pages past more than 32 unavailable indexed sources without losing a healthy hit", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "sciretriever-knowledge-many-gaps-"),
    );
    try {
      const fixture = await populatedCatalogV7(root);
      await migrateKnowledgeRetrievalCatalog({
        catalog_path: fixture.catalog,
        backup_path: join(root, "before-v8.sqlite"),
      });
      const app = await createApplication(root, {
        executionSchema: "require-v2",
      });
      try {
        await app.maintenance!.rebuildKnowledgeIndex!();
      } finally {
        await app.close();
      }
      const badIds = Array.from(
        { length: 35 },
        (_, index) =>
          `00000000-0000-0000-0000-${String(5000 + index).padStart(12, "0")}`,
      );
      const engine = new RetrievalStorageEngine(fixture.catalog, false, config);
      try {
        const active = engine.knowledgeActive();
        if (!active) throw new Error("knowledge generation missing");
        const source = engine
          .knowledgeSearch(
            '"4.2"',
            ["4.2"],
            active.generation_id,
            [],
            null,
            ["overview"],
            null,
            "all",
            10,
          )
          .hits.find((hit) => hit.artifact_id === fixture.knowledgeId);
        if (!source) throw new Error("healthy retrieval entry missing");
        const entry = {
          artifact_id: source.artifact_id,
          content_sha256: source.content_sha256,
          manifest_sha256: source.manifest_sha256,
          scope_kind: source.scope_kind,
          scope_key: source.scope_key,
          purpose: source.purpose,
          question_sha256: source.question_sha256,
          statement_id: source.statement_id,
          statement_ordinal: source.statement_ordinal,
          statement_sha256: source.statement_sha256,
          source_literature_ids: source.source_literature_ids,
          scope_complete: source.scope_complete,
          is_default: source.is_default,
        };
        const revision = engine.knowledgeRevision();
        const generation = engine.knowledgeBegin(revision);
        for (const artifact_id of badIds)
          engine.knowledgeInsert(
            generation,
            [
              {
                ...entry,
                artifact_id,
                statement_id: "unavailable",
                statement_ordinal: 0,
                title: "4.2 4.2 4.2 4.2 4.2",
                body: "4.2",
              },
            ],
            1,
          );
        engine.knowledgeInsert(
          generation,
          [{ ...entry, title: "4.2", body: "4.2" }],
          1,
        );
        engine.knowledgePublish(generation, revision);
      } finally {
        engine.close();
      }
      const query = await createQueryApplication(root);
      try {
        const request = {
          schema_version: 2,
          query: "4.2",
          scope: { kind: "library" },
          kinds: ["knowledge"],
          versions: { kind: "default" },
          knowledge: {
            purposes: ["overview"],
            question: null,
            selection: "all",
            artifact_ids: [],
          },
          budget: { max_items: 20, max_bytes: 2200, token_limit: null },
          continuation: null as string | null,
        };
        const seen = new Set<string>();
        let healthy = 0;
        let continuation: string | null = null;
        for (let page = 0; page < 20; page++) {
          const result = await query.knowledgeContext!.search({
            ...request,
            continuation,
          });
          expect(result.usage.bytes).toBeLessThanOrEqual(
            request.budget.max_bytes,
          );
          for (const missing of result.gaps.filter(
            (gap) => gap.code === "source-missing",
          )) {
            expect(missing.artifact_id).not.toBeNull();
            expect(seen.has(missing.artifact_id!)).toBe(false);
            seen.add(missing.artifact_id!);
          }
          healthy += result.items.filter(
            (item) =>
              item.kind === "generated-knowledge" &&
              item.reference.artifact_id === fixture.knowledgeId,
          ).length;
          continuation = result.continuation;
          if (continuation === null) break;
        }
        expect(continuation).toBeNull();
        expect(seen).toEqual(new Set(badIds));
        expect(healthy).toBe(1);
      } finally {
        await query.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("reports a missing document source while paging to a healthy document", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "sciretriever-mixed-document-gap-"),
    );
    try {
      const first = await populatedCatalogV7(root);
      const second = await publishTwoPaperSynthesis(root, first);
      await migrateKnowledgeRetrievalCatalog({
        catalog_path: first.catalog,
        backup_path: join(root, "before-v8.sqlite"),
      });
      const app = await createApplication(root, {
        executionSchema: "require-v2",
      });
      try {
        await app.maintenance!.rebuildIndex();
        await app.maintenance!.rebuildKnowledgeIndex!();
      } finally {
        await app.close();
      }
      const db = new DatabaseSync(first.catalog, { readOnly: true });
      let markdownPath: string;
      try {
        const row = db
          .prepare(
            "SELECT markdown_artifact_path FROM document_versions WHERE document_version_id=?",
          )
          .get(first.documentId) as
          | { markdown_artifact_path: string }
          | undefined;
        if (!row) throw new Error("synthetic document missing");
        markdownPath = row.markdown_artifact_path;
      } finally {
        db.close();
      }
      await rm(join(root, "artifacts", markdownPath));
      const query = await createQueryApplication(root);
      try {
        const request = {
          schema_version: 2,
          query: "eV",
          scope: { kind: "library" },
          kinds: ["document", "knowledge"],
          versions: { kind: "default" },
          knowledge: {
            purposes: ["overview", "synthesis"],
            question: null,
            selection: "all",
            artifact_ids: [],
          },
          budget: { max_items: 1, max_bytes: 8192, token_limit: null },
          continuation: null as string | null,
        };
        const items: string[] = [];
        const gaps: { code: string; literature_id: string | null }[] = [];
        let continuation: string | null = null;
        for (let page = 0; page < 12; page++) {
          const result = await query.knowledgeContext!.search({
            ...request,
            continuation,
          });
          items.push(
            ...result.items.map((item) =>
              item.kind === "generated-knowledge"
                ? `knowledge:${item.reference.artifact_id}:${item.reference.statement_id}`
                : `${item.kind}:${item.literature_id}`,
            ),
          );
          gaps.push(...result.gaps);
          continuation = result.continuation;
          if (continuation === null) break;
        }
        expect(continuation).toBeNull();
        expect(gaps).toContainEqual(
          expect.objectContaining({
            code: "source-corrupt",
            literature_id: first.lit,
          }),
        );
        expect(items).toContain(`source-text:${second.secondLiterature}`);
        expect(gaps.some((gap) => gap.code === "source-corrupt")).toBe(true);
        expect(new Set(items).size).toBe(items.length);
      } finally {
        await query.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
  it("reserves a mixed knowledge and document read budget before opening another file", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "sciretriever-mixed-read-budget-"),
    );
    try {
      const fixture = await populatedCatalogV7(root);
      const app = await createApplication(root, {
        executionSchema: "require-v2",
      });
      const reader = new SqliteSynthesisStorage(
        app.database,
        app.files,
        app.documentRead,
      );
      try {
        const snapshot = await app.database.documentVersion(fixture.documentId);
        if (!snapshot) throw new Error("synthetic document missing");
        const version = snapshot.version;
        const closureBytes =
          version.source_material_ref.byte_size +
          version.markdown.byte_size +
          version.structure.byte_size +
          version.resources.reduce(
            (sum, resource) => sum + resource.artifact.byte_size,
            0,
          );
        let lower = 0;
        let upper = 64 * 1024;
        while (lower + 1 < upper) {
          const middle = Math.floor((lower + upper) / 2);
          try {
            await reader.withReadSession(async (session) => {
              expect(
                await session.sourceById(fixture.knowledgeId),
              ).not.toBeNull();
            }, middle);
            upper = middle;
          } catch (error) {
            if (
              !(error instanceof Error) ||
              !("code" in error) ||
              error.code !== "synthesis-limit"
            )
              throw error;
            lower = middle;
          }
        }
        const verified = vi.spyOn(app.files, "withVerified");
        try {
          await reader.withReadSession(
            async (session) => {
              expect(
                await session.sourceById(fixture.knowledgeId),
              ).not.toBeNull();
              const opened = verified.mock.calls.length;
              await expect(
                app.documentRead.withVerifiedVersion(
                  fixture.documentId,
                  async () => undefined,
                  undefined,
                  (bytes) => session.reserveExternalVerifiedBytes(bytes),
                ),
              ).rejects.toMatchObject({
                code: "document-integrity",
                cause: { code: "synthesis-limit" },
              });
              expect(verified.mock.calls.length).toBe(opened);
            },
            upper + closureBytes - 1,
          );
        } finally {
          verified.mockRestore();
        }
      } finally {
        await reader.close();
        await app.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("rejects a generation changed during source verification and waits for an active read on close", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "sciretriever-knowledge-retrieval-race-"),
    );
    try {
      const fixture = await populatedCatalogV7(root);
      await migrateKnowledgeRetrievalCatalog({
        catalog_path: fixture.catalog,
        backup_path: join(root, "before-v8.sqlite"),
      });
      const writer = await createApplication(root, {
        executionSchema: "require-v2",
      });
      const query = await createQueryApplication(root);
      const original = SqliteWorker.prototype.knowledge;
      let gate: { entered: () => void; release: Promise<void> } | null = null;
      const delayed = vi
        .spyOn(SqliteWorker.prototype, "knowledge")
        .mockImplementation(async function <T>(
          this: SqliteWorker,
          action: Parameters<SqliteWorker["knowledge"]>[0],
          args: unknown,
          signal?: AbortSignal,
        ): Promise<T> {
          if (action === "id" && args === fixture.knowledgeId && gate) {
            const pending = gate;
            gate = null;
            pending.entered();
            await pending.release;
          }
          return original.call(this, action, args, signal) as Promise<T>;
        });
      const blocked = () => {
        let entered!: () => void;
        let release!: () => void;
        const arrival = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const waiting = new Promise<void>((resolve) => {
          release = resolve;
        });
        gate = { entered, release: waiting };
        releases.push(release);
        return { arrival, release };
      };
      const releases: (() => void)[] = [];
      const request = {
        schema_version: 2,
        query: "4.2",
        scope: { kind: "library" },
        kinds: ["knowledge"],
        versions: { kind: "default" },
        knowledge: {
          purposes: ["overview"],
          question: null,
          selection: "all",
          artifact_ids: [],
        },
        budget: { max_items: 20, max_bytes: 262144, token_limit: null },
        continuation: null,
      };
      try {
        await writer.maintenance!.rebuildKnowledgeIndex!();
        const firstGate = blocked();
        const stale = query.knowledgeContext!.search(request);
        await firstGate.arrival;
        await writer.maintenance!.rebuildKnowledgeIndex!();
        firstGate.release();
        await expect(stale).rejects.toMatchObject({
          code: "context-cursor-invalid",
        });

        const secondGate = blocked();
        const active = query.knowledgeContext!.search(request);
        await secondGate.arrival;
        let closed = false;
        const closing = query.close().then(() => {
          closed = true;
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(closed).toBe(false);
        secondGate.release();
        await active;
        await closing;
        expect(closed).toBe(true);
      } finally {
        for (const release of releases) release();
        gate = null;
        delayed.mockRestore();
        await query.close();
        await writer.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("serves explicit knowledge maintenance and mixed Context through the production graph and HTTP", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "sciretriever-knowledge-retrieval-migration-"),
    );
    try {
      const fixture = await populatedCatalogV7(root);
      await migrateKnowledgeRetrievalCatalog({
        catalog_path: fixture.catalog,
        backup_path: join(root, "before-v8.sqlite"),
      });
      const app = await createApplication(root, {
        executionSchema: "require-v2",
      });
      const query = await createQueryApplication(root);
      const http = await startQueryOnlyHttp({
        application: query,
        maintenance: app.maintenance!,
        assets: await queryWebAssets(),
      });
      let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
      try {
        expect(query.knowledgeContext).not.toBeNull();
        const request = {
          schema_version: 2,
          query: "4.2",
          scope: { kind: "library" },
          kinds: ["metadata", "document", "knowledge"],
          versions: { kind: "default" },
          knowledge: {
            purposes: ["overview", "synthesis"],
            question: null,
            selection: "all",
            artifact_ids: [],
          },
          budget: { max_items: 20, max_bytes: 262144, token_limit: null },
          continuation: null,
        };
        expect((await query.knowledgeContext!.search(request)).coverage).toBe(
          "index-unavailable",
        );
        const unauthorized = await fetch(
          `${http.origin}/api/v1/maintenance/rebuild-knowledge-index`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Sciretriever-Protocol-Version": "1",
            },
            body: JSON.stringify({
              protocol_version: 1,
              request: { kind: "rebuild" },
            }),
          },
        );
        expect(unauthorized.status).toBe(403);
        const home = await fetch(http.origin);
        const cookie = home.headers.get("set-cookie")!.split(";")[0]!;
        const session = await fetch(
          `${http.origin}/api/v1/maintenance/session`,
          { headers: { Cookie: cookie } },
        );
        const { csrf } = (await session.json()) as { csrf: string };
        const rebuild = await fetch(
          `${http.origin}/api/v1/maintenance/rebuild-knowledge-index`,
          {
            method: "POST",
            headers: {
              Cookie: cookie,
              Origin: http.origin,
              "Content-Type": "application/json",
              "X-Sciretriever-Protocol-Version": "1",
              "X-Sciretriever-Csrf": csrf,
            },
            body: JSON.stringify({
              protocol_version: 1,
              request: { kind: "rebuild" },
            }),
          },
        );
        expect(rebuild.status).toBe(200);
        expect(
          ((await rebuild.json()) as { result: { source_count: number } })
            .result.source_count,
        ).toBe(2);
        await app.maintenance!.rebuildIndex();
        const response = await fetch(
          `${http.origin}/api/v1/query/knowledge-context`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ protocol_version: 1, request }),
          },
        );
        expect(response.status).toBe(200);
        const { result } = (await response.json()) as {
          result: Awaited<ReturnType<KnowledgeContextService["search"]>>;
        };
        expect(result.items.some((item) => item.kind === "source-text")).toBe(
          true,
        );
        expect(
          result.items
            .filter((item) => item.kind === "generated-knowledge")
            .map(
              (item) =>
                item.kind === "generated-knowledge" &&
                item.reference.artifact_id,
            )
            .sort(),
        ).toEqual([fixture.knowledgeId, fixture.synthesisId].sort());
        const labels = [
          {
            query: "4.2",
            relevant: [fixture.knowledgeId, fixture.synthesisId],
          },
          {
            query: "dry",
            relevant: [fixture.knowledgeId, fixture.synthesisId],
          },
          {
            query: "Β-PHASE",
            relevant: [fixture.knowledgeId, fixture.synthesisId],
          },
          {
            query: "baseline",
            relevant: [fixture.knowledgeId, fixture.synthesisId],
          },
          { query: "unrelated", relevant: [] },
        ];
        for (const label of labels) {
          const page = await query.knowledgeContext!.search({
            ...request,
            query: label.query,
          });
          const ranked = page.items
            .filter((item) => item.kind === "generated-knowledge")
            .map((item) =>
              item.kind === "generated-knowledge"
                ? item.reference.artifact_id
                : "",
            );
          const recallAt20 = label.relevant.length
            ? label.relevant.filter((id) => ranked.includes(id)).length /
              label.relevant.length
            : 1;
          expect(recallAt20).toBe(1);
          if (!label.relevant.length) expect(ranked).toHaveLength(0);
          else {
            expect(ranked.indexOf(fixture.knowledgeId)).toBeGreaterThanOrEqual(
              0,
            );
            expect(label.relevant).toContain(ranked[0]);
            const repeated = await query.knowledgeContext!.search({
              ...request,
              query: label.query,
            });
            expect(
              repeated.items.map((item) =>
                item.kind === "generated-knowledge"
                  ? item.reference.artifact_id
                  : `${item.kind}:${item.literature_id}`,
              ),
            ).toEqual(
              page.items.map((item) =>
                item.kind === "generated-knowledge"
                  ? item.reference.artifact_id
                  : `${item.kind}:${item.literature_id}`,
              ),
            );
          }
        }
        const finding = result.items.find(
          (item) =>
            item.kind === "generated-knowledge" &&
            item.reference.artifact_id === fixture.knowledgeId,
        );
        expect(
          finding?.kind === "generated-knowledge" && finding.statement,
        ).toMatchObject({
          text: "4.2 eV under dry conditions",
          conditions: ["dry conditions", "β-phase protocol"],
          quantity: {
            value: "4.2",
            unit: "eV",
            comparison_basis: "ambient baseline",
          },
        });
        const synthQuestion = await query.knowledgeContext!.search({
          ...request,
          kinds: ["knowledge"],
          knowledge: {
            purposes: ["synthesis"],
            question: "Which conditions?",
            selection: "all",
            artifact_ids: [],
          },
        });
        expect(
          synthQuestion.items.map(
            (item) =>
              item.kind === "generated-knowledge" && item.reference.artifact_id,
          ),
        ).toEqual([fixture.synthesisId]);
        const wrongQuestion = await query.knowledgeContext!.search({
          ...request,
          kinds: ["knowledge"],
          knowledge: {
            purposes: ["synthesis"],
            question: "Another question?",
            selection: "all",
            artifact_ids: [],
          },
        });
        expect(wrongQuestion.items).toHaveLength(0);
        expect(wrongQuestion.gaps.map((item) => item.code)).toContain(
          "knowledge-missing",
        );
        const noTermMatch = await query.knowledgeContext!.search({
          ...request,
          query: "irrelevant-nonsense",
          kinds: ["knowledge"],
        });
        expect(noTermMatch.items).toHaveLength(0);
        expect(noTermMatch.gaps.map((item) => item.code)).not.toContain(
          "knowledge-missing",
        );
        browser = await chromium.launch({
          executablePath:
            process.env.SCIRETRIEVER_BROWSER_EXECUTABLE ??
            "/home/duanjw/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome",
          headless: true,
        });
        const page = await browser.newPage();
        await page.goto(http.origin);
        await page.locator("#knowledge-retrieval-rebuild").click();
        await expect
          .poll(() =>
            page.locator("#knowledge-retrieval-rebuild-status").textContent(),
          )
          .toContain("索引已发布");
        await page.goto(`${http.origin}/query`);
        await page.locator("#knowledge-context-query").fill("4.2");
        await page.locator("#knowledge-context-submit").click();
        await expect
          .poll(() =>
            page.locator("#knowledge-context-results article").count(),
          )
          .toBeGreaterThanOrEqual(3);
        const generated = page
          .locator("#knowledge-context-results article")
          .filter({ hasText: `产物 ${fixture.knowledgeId} · overview` });
        await expect
          .poll(() => generated.textContent())
          .toContain("4.2 eV under dry conditions");
        await generated
          .getByRole("button", { name: "按固定产物阅读并展开证据" })
          .click();
        await expect
          .poll(() => generated.textContent())
          .toContain("4.2 eV under dry conditions");
        await expect
          .poll(() =>
            generated.getByRole("button", { name: "展开证据" }).count(),
          )
          .toBeGreaterThan(0);
        await generated
          .getByRole("button", { name: "展开证据" })
          .first()
          .click();
        await expect
          .poll(() => generated.textContent())
          .toContain("The measurement was 4.2 eV under dry conditions.");
        const synthesisCard = page
          .locator("#knowledge-context-results article")
          .filter({ hasText: `产物 ${fixture.synthesisId} · synthesis` });
        await synthesisCard
          .getByRole("button", { name: "按固定产物阅读并展开证据" })
          .click();
        await expect
          .poll(() =>
            synthesisCard.getByRole("button", { name: /核对来源/ }).count(),
          )
          .toBeGreaterThan(0);
        await synthesisCard
          .getByRole("button", { name: /核对来源/ })
          .first()
          .click();
        await expect
          .poll(() => synthesisCard.textContent())
          .toContain("Synthetic finding");
        const sourceCard = page
          .locator("#knowledge-context-results article")
          .filter({ hasText: `文档版本 ${fixture.documentId}` })
          .first();
        await sourceCard
          .getByRole("button", { name: "按固定范围继续读取" })
          .click();
        await expect
          .poll(() => sourceCard.locator("pre").allTextContents())
          .toContain("The measurement was 4.2 eV under dry conditions.\n");
        await page.locator("#knowledge-context-submit").click();
        const renewedSource = page
          .locator("#knowledge-context-results article")
          .filter({ hasText: `文档版本 ${fixture.documentId}` })
          .first();
        await expect
          .poll(() =>
            renewedSource
              .getByRole("button", { name: "按固定范围继续读取" })
              .count(),
          )
          .toBe(1);
        let releaseSlice!: () => void;
        const heldSlice = new Promise<void>((resolve) => {
          releaseSlice = resolve;
        });
        let sliceArrived!: () => void;
        const arrived = new Promise<void>((resolve) => {
          sliceArrived = resolve;
        });
        await page.route("**/api/v1/query/document-slice", async (route) => {
          sliceArrived();
          await heldSlice;
          try {
            await route.continue();
          } catch {
            /* cancelled browser request */
          }
        });
        try {
          const aborted = page.waitForEvent("requestfailed", {
            predicate: (request) =>
              request.url().endsWith("/api/v1/query/document-slice"),
          });
          await renewedSource
            .getByRole("button", { name: "按固定范围继续读取" })
            .click();
          await arrived;
          await page.locator("#knowledge-context-query").fill("dry");
          await page.locator("#knowledge-context-submit").click();
          releaseSlice();
          expect((await aborted).failure()?.errorText).toMatch(
            /ABORTED|FAILED/,
          );
          await expect
            .poll(() => page.locator("#knowledge-context-status").textContent())
            .toContain("覆盖：");
          expect(
            await page.locator("#knowledge-context-results").textContent(),
          ).not.toContain("固定范围读取失败");
        } finally {
          releaseSlice();
          await page.unroute("**/api/v1/query/document-slice");
        }
        const exact = {
          ...request,
          scope: { kind: "artifacts", artifact_ids: [fixture.knowledgeId] },
          kinds: ["knowledge"],
          knowledge: {
            purposes: ["overview"],
            question: null,
            selection: "explicit",
            artifact_ids: [fixture.knowledgeId],
          },
        };
        const full = await query.knowledgeContext!.search(exact);
        expect(full.items).toHaveLength(1);
        expect(full.continuation).toBeNull();
        const exactBudget = await query.knowledgeContext!.search({
          ...exact,
          budget: { ...exact.budget, max_bytes: full.usage.bytes },
        });
        expect(exactBudget.items[0]).toEqual(full.items[0]);
        expect(exactBudget.continuation).toBeNull();
      } finally {
        await browser?.close();
        await http.close();
        await query.close();
        await app.close();
      }
      const cli = await runCli(["maintenance", "rebuild-knowledge-index"], {
        home: root,
      });
      expect(cli.code).toBe(0);
      expect(cli.value).toMatchObject({ source_count: 2 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);
  it("pages compact mixed references without losing fixed hits and rejects an unfit first reference", async () => {
    const root = await mkdtemp(join(tmpdir(), "sciretriever-mixed-compact-"));
    try {
      const first = await populatedCatalogV7(root, false, true);
      await publishTwoPaperSynthesis(root, first);
      await migrateKnowledgeRetrievalCatalog({
        catalog_path: first.catalog,
        backup_path: join(root, "before-v8.sqlite"),
      });
      const app = await createApplication(root, {
        executionSchema: "require-v2",
      });
      try {
        await app.maintenance!.rebuildIndex();
        await app.maintenance!.rebuildKnowledgeIndex!();
      } finally {
        await app.close();
      }
      const query = await createQueryApplication(root);
      try {
        const request = {
          schema_version: 2,
          query: "4.2",
          scope: { kind: "library" },
          kinds: ["document", "knowledge"],
          versions: { kind: "default" },
          knowledge: {
            purposes: ["overview", "synthesis"],
            question: null,
            selection: "all",
            artifact_ids: [],
          },
          budget: { max_items: 20, max_bytes: 262144, token_limit: null },
          continuation: null as string | null,
        };
        const full = await query.knowledgeContext!.search(request);
        const ref = (item: (typeof full.items)[number]) =>
          JSON.stringify([item.kind, item.reference]);
        const expected = full.items.map(ref);
        expect(expected.length).toBeGreaterThanOrEqual(3);
        expect(full.items.some((item) => item.kind === "source-text")).toBe(
          true,
        );
        expect(
          full.items.some((item) => item.kind === "generated-knowledge"),
        ).toBe(true);
        const budget = { max_items: 1, max_bytes: 2400, token_limit: null };
        const received: string[] = [];
        let sourceCompact = 0;
        let knowledgeCompact = 0;
        let continuation: string | null = null;
        let pages = 0;
        for (; pages < 20; pages++) {
          const result = await query.knowledgeContext!.search({
            ...request,
            budget,
            continuation,
          });
          expect(result.items).toHaveLength(1);
          expect(result.usage.bytes).toBe(
            Buffer.byteLength(JSON.stringify(result)),
          );
          expect(result.usage.bytes).toBeLessThanOrEqual(budget.max_bytes);
          const item = result.items[0]!;
          received.push(ref(item));
          if (item.kind === "source-text" && item.gap === "context-too-large") {
            expect(item.text).toBe("");
            expect(item.evidence).toEqual([]);
            expect(result.gaps).toContainEqual({
              code: "context-too-large",
              literature_id: item.literature_id,
              artifact_id: null,
            });
            sourceCompact++;
          }
          if (
            item.kind === "generated-knowledge" &&
            item.gap === "context-too-large"
          ) {
            expect(item.statement).toBeNull();
            expect(result.gaps).toContainEqual({
              code: "context-too-large",
              literature_id: null,
              artifact_id: item.reference.artifact_id,
            });
            knowledgeCompact++;
          }
          continuation = result.continuation;
          if (continuation === null) break;
        }
        expect(continuation).toBeNull();
        expect(pages).toBeGreaterThanOrEqual(2);
        expect(sourceCompact).toBeGreaterThan(0);
        expect(knowledgeCompact).toBeGreaterThan(0);
        expect(received).toEqual(expected);
        expect(new Set(received).size).toBe(received.length);
        await expect(
          query.knowledgeContext!.search({
            ...request,
            scope: { kind: "artifacts", artifact_ids: [first.synthesisId] },
            kinds: ["knowledge"],
            knowledge: {
              ...request.knowledge,
              selection: "explicit",
              artifact_ids: [first.synthesisId],
            },
            budget: { max_items: 1, max_bytes: 1024, token_limit: null },
          }),
        ).rejects.toMatchObject({ code: "context-budget-invalid" });
      } finally {
        await query.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);
  it("merges material and generated knowledge with one cursor and preserves the healthy branch", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "sciretriever-knowledge-retrieval-migration-"),
    );
    try {
      const fixture = await populatedCatalogV7(root);
      await migrateKnowledgeRetrievalCatalog({
        catalog_path: fixture.catalog,
        backup_path: join(root, "before-v8.sqlite"),
      });
      const app = await createApplication(root, {
        executionSchema: "require-v2",
      });
      try {
        const store = new RetrievalStorageClient(app.database);
        const synth = new SqliteSynthesisStorage(
          app.database,
          app.files,
          app.documentRead,
        );
        const materialBuilder = new RetrievalIndexService(
          store,
          app.documentRead,
          app.library,
          app.writes,
        );
        const knowledgeBuilder = new KnowledgeRetrievalIndexService(
          store,
          synth,
          app.writes,
        );
        try {
          await materialBuilder.build();
          await knowledgeBuilder.build();
        } finally {
          await materialBuilder.close();
          await knowledgeBuilder.close();
        }
        const service = new KnowledgeContextService(
          new MaterialContextService(store, app.documentRead, app.library),
          store,
          synth,
        );
        try {
          const request = {
            schema_version: 2,
            query: "4.2",
            scope: { kind: "library" },
            kinds: ["metadata", "document", "knowledge"],
            versions: { kind: "default" },
            knowledge: {
              purposes: ["overview", "synthesis"],
              question: null,
              selection: "all",
              artifact_ids: [],
            },
            budget: { max_items: 1, max_bytes: 262144, token_limit: null },
            continuation: null,
          };
          const first = await service.search(request);
          expect(first.items).toHaveLength(1);
          expect(first.continuation).not.toBeNull();
          const second = await service.search({
            ...request,
            continuation: first.continuation,
          });
          expect(second.items).toHaveLength(1);
          expect([first.items[0]!.kind, second.items[0]!.kind]).toContain(
            "generated-knowledge",
          );
          await expect(
            service.search({
              ...request,
              query: "different",
              continuation: first.continuation,
            }),
          ).rejects.toMatchObject({ code: "context-cursor-invalid" });
          const scoped = await service.search({
            ...request,
            scope: { kind: "literatures", literature_ids: [fixture.lit] },
            budget: { ...request.budget, max_items: 20 },
          });
          expect(
            scoped.items
              .filter((item) => item.kind === "generated-knowledge")
              .every(
                (item) =>
                  item.kind !== "generated-knowledge" ||
                  item.reference.artifact_id === fixture.knowledgeId,
              ),
          ).toBe(true);
          const db = new DatabaseSync(fixture.catalog);
          try {
            db.prepare(
              "UPDATE knowledge_retrieval_fts SET body='tampered' WHERE rowid=(SELECT min(rowid) FROM knowledge_retrieval_fts)",
            ).run();
          } finally {
            db.close();
          }
          const degraded = await service.search({
            ...request,
            budget: { ...request.budget, max_items: 20 },
          });
          expect(
            degraded.items.some((item) => item.kind === "source-text"),
          ).toBe(true);
          expect(
            degraded.items.some((item) => item.kind === "generated-knowledge"),
          ).toBe(false);
          expect(degraded.gaps).toContainEqual({
            code: "knowledge-index-corrupt",
            literature_id: null,
            artifact_id: null,
          });
        } finally {
          await service.close();
        }
      } finally {
        await app.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("explicitly indexes verified artifact statements while preserving the prior generation", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "sciretriever-knowledge-retrieval-migration-"),
    );
    try {
      const fixture = await populatedCatalogV7(root);
      await migrateKnowledgeRetrievalCatalog({
        catalog_path: fixture.catalog,
        backup_path: join(root, "before-v8.sqlite"),
      });
      const app = await createApplication(root, {
        executionSchema: "require-v2",
      });
      try {
        const store = new RetrievalStorageClient(app.database);
        const synth = new SqliteSynthesisStorage(
          app.database,
          app.files,
          app.documentRead,
        );
        const index = new KnowledgeRetrievalIndexService(
          store,
          synth,
          app.writes,
        );
        try {
          expect(await store.knowledgeActive()).toBeNull();
          const first = await index.build();
          expect(first.source_count).toBe(2);
          expect(first.entry_count).toBe(2);
          const all = await store.knowledgeSearch(
            '"4.2"',
            ["4.2"],
            first.generation_id,
            [],
            null,
            ["overview", "synthesis"],
            null,
            "all",
            20,
          );
          expect(all.hits.map((hit) => hit.artifact_id).sort()).toEqual(
            [fixture.knowledgeId, fixture.synthesisId].sort(),
          );
          expect(
            all.hits.find((hit) => hit.artifact_id === fixture.synthesisId)
              ?.scope_complete,
          ).toBe(0);
          expect(
            (
              await store.knowledgeSearch(
                '"4.2"',
                ["4.2"],
                first.generation_id,
                [fixture.lit],
                null,
                ["overview", "synthesis"],
                null,
                "all",
                20,
              )
            ).hits.map((hit) => hit.artifact_id),
          ).toEqual([fixture.knowledgeId]);
          const second = await index.build();
          expect(second.generation_id).not.toBe(first.generation_id);
          expect((await store.knowledgeActive())?.generation_id).toBe(
            second.generation_id,
          );
          const db = new DatabaseSync(fixture.catalog, { readOnly: true });
          try {
            expect(
              db
                .prepare(
                  "SELECT count(*) AS n FROM knowledge_retrieval_generations WHERE status='ready'",
                )
                .get(),
            ).toEqual({ n: 2 });
          } finally {
            db.close();
          }
        } finally {
          await index.close();
        }
      } finally {
        await app.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("migrates populated material, Document, Knowledge and Synthesis facts without staling material retrieval", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "sciretriever-knowledge-retrieval-migration-"),
    );
    try {
      const fixture = await populatedCatalogV7(root);
      const tables = [
        "literatures",
        "assets",
        "literature_assets",
        "document_versions",
        "document_defaults",
        "knowledge_artifacts",
        "knowledge_input_materials",
        "knowledge_input_documents",
        "knowledge_input_artifacts",
        "knowledge_defaults",
        "artifact_objects",
      ];
      const snapshot = (path: string) => {
        const db = new DatabaseSync(path, { readOnly: true });
        try {
          return Object.fromEntries(
            tables.map((table) => [
              table,
              db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
            ]),
          );
        } finally {
          db.close();
        }
      };
      const before = snapshot(fixture.catalog);
      expect((before.knowledge_artifacts as unknown[]).length).toBe(2);
      const backup = join(root, "before-v8.sqlite");
      await migrateKnowledgeRetrievalCatalog({
        catalog_path: fixture.catalog,
        backup_path: backup,
      });
      expect(snapshot(fixture.catalog)).toEqual(before);
      expect(snapshot(backup)).toEqual(before);
      let preparedExtraction: ExtractionPreparation | null = null;
      const query = await createQueryApplication(root);
      try {
        expect(query.readiness.status).toBe("ready");
        expect(
          (await query.query!.detail(fixture.lit)).literature?.literature_id,
        ).toBe(fixture.lit);
        expect(
          (
            await query.documentRead!.describe({
              document_version_id: fixture.documentId,
            })
          ).document.document_version_id,
        ).toBe(fixture.documentId);
        expect(
          (await query.knowledgeRead!.byId(fixture.knowledgeId))?.artifact_id,
        ).toBe(fixture.knowledgeId);
        expect(
          (await query.synthesisRead!.byId(fixture.synthesisId))?.artifact
            .artifact_id,
        ).toBe(fixture.synthesisId);
        const specContent = {
          schema_version: 1 as const,
          spec_id: "synthetic.v8",
          spec_version: "1",
          record_meaning: "One synthetic measurement",
          output_schema: {
            $schema: EXTRACTION_SCHEMA_URI,
            type: "object",
            additionalProperties: false,
            properties: { value: { type: "string" } },
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
        const prepared = await query.extractionPreparation!.prepare({
          spec: {
            ...specContent,
            spec_sha256: await extractionSpecHash(specContent),
          },
          inputs: [
            {
              input_id: "source-1",
              literature_id: fixture.lit,
              asset_id: "00000000-0000-0000-0000-000000000800",
              asset_sha256: (
                await query.documentRead!.describe({
                  document_version_id: fixture.documentId,
                })
              ).document.source_material_ref.asset_sha256,
              document_version_id: null,
            },
          ],
        });
        expect(prepared.manifest.items[0]?.material?.literature_id).toBe(
          fixture.lit,
        );
        preparedExtraction = prepared;
      } finally {
        await query.close();
      }
      let materialRevision = -1;
      let materialGeneration = "";
      let knowledgeRevision = -1;
      const engine = new RetrievalStorageEngine(fixture.catalog, false, config);
      try {
        materialRevision = engine.revision();
        materialGeneration = engine.beginGeneration(materialRevision);
        engine.publish(materialGeneration, materialRevision);
        knowledgeRevision = engine.knowledgeRevision();
        const knowledgeGeneration = engine.knowledgeBegin(knowledgeRevision);
        engine.knowledgePublish(knowledgeGeneration, knowledgeRevision);
        expect(engine.revision()).toBe(materialRevision);
        expect(engine.active()?.generation_id).toBe(materialGeneration);
        expect(engine.knowledgeActive()?.generation_id).toBe(
          knowledgeGeneration,
        );
      } finally {
        engine.close();
      }
      const app = await createApplication(root, {
        executionSchema: "require-v2",
      });
      try {
        expect(
          (
            await app.documentProcessing.parseDocuments({
              literature_id: fixture.lit,
              asset_id: "00000000-0000-0000-0000-000000000800",
              asset_sha256: (
                await app.documentRead.describe({
                  document_version_id: fixture.documentId,
                })
              ).document.source_material_ref.asset_sha256,
              mode: "reuse-current",
              expected_default_revision: 1,
            })
          ).document.document_version_id,
        ).toBe(fixture.documentId);
        if (!preparedExtraction)
          throw new Error("synthetic extraction missing");
        expect(
          (
            await app.extractionDelivery.create({
              caller_id: "local.synthetic",
              spec: preparedExtraction.spec,
              manifest: preparedExtraction.manifest,
            })
          ).status,
        ).toBe("open");
        const storage = new SqliteKnowledgeStorage(
          app.database,
          app.files,
          app.documentRead,
        );
        expect(
          await storage.updateDefault({
            literature_id: fixture.lit,
            purpose: "overview",
            question_sha256: await sha256(new TextEncoder().encode("")),
            artifact_id: fixture.knowledgeId,
            expected_revision: 1,
          }),
        ).toMatchObject({ updated: true, revision: 2 });
      } finally {
        await app.close();
      }
      const check = new RetrievalStorageEngine(fixture.catalog, true, config);
      try {
        expect(check.revision()).toBe(materialRevision);
        expect(check.active()?.generation_id).toBe(materialGeneration);
        expect(check.knowledgeRevision()).toBeGreaterThan(knowledgeRevision);
      } finally {
        check.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("retains ready generations, rejects malformed entry batches and leaves active unchanged on failed CAS", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "sciretriever-knowledge-retrieval-migration-"),
    );
    try {
      const catalog = await catalogV7(root);
      await migrateKnowledgeRetrievalCatalog({
        catalog_path: catalog,
        backup_path: join(root, "before-v8.sqlite"),
      });
      const engine = new RetrievalStorageEngine(catalog, false, config);
      try {
        const revision = engine.knowledgeRevision();
        const first = engine.knowledgeBegin(revision);
        const entry = {
          artifact_id: "00000000-0000-0000-0000-000000000001",
          content_sha256: "a".repeat(64),
          manifest_sha256: "b".repeat(64),
          scope_kind: "literature" as const,
          scope_key: "00000000-0000-0000-0000-000000000002",
          purpose: "overview" as const,
          question_sha256: "c".repeat(64),
          statement_id: "s1",
          statement_ordinal: 0,
          statement_sha256: "d".repeat(64),
          source_literature_ids: ["00000000-0000-0000-0000-000000000002"],
          scope_complete: 1 as const,
          is_default: 0 as const,
          title: "catalyst",
          body: "stable",
        };
        expect(() =>
          engine.knowledgeInsert(
            first,
            [{ ...entry, source_literature_ids: ["invalid"] }],
            1,
          ),
        ).toThrow("index-corrupt");
        expect(() =>
          engine.knowledgeInsert(
            first,
            [{ ...entry, statement_sha256: "invalid" }],
            1,
          ),
        ).toThrow("index-corrupt");
        expect(() =>
          engine.knowledgeInsert(
            first,
            [{ ...entry, body: "x".repeat(65537) }],
            1,
          ),
        ).toThrow("index-corrupt");
        expect(() =>
          engine.knowledgeInsert(
            first,
            [{ ...entry, title: "x".repeat(8193) }],
            1,
          ),
        ).toThrow("index-corrupt");
        expect(() =>
          engine.knowledgeInsert(
            first,
            [entry, { ...entry, statement_id: "s2" }],
            1,
          ),
        ).toThrow("index-corrupt");
        const closure = Array.from(
          { length: 1024 },
          (_, index) =>
            `00000000-0000-0000-0000-${(index + 1).toString(16).padStart(12, "0")}`,
        );
        expect(() =>
          engine.knowledgeInsert(
            first,
            Array.from({ length: 30 }, (_, index) => ({
              ...entry,
              artifact_id: `00000000-0000-0000-0000-${(index + 1).toString(16).padStart(12, "0")}`,
              scope_kind: "manifest" as const,
              scope_key: "e".repeat(64),
              purpose: "synthesis" as const,
              source_literature_ids: closure,
              body: "x".repeat(3000),
            })),
            0,
          ),
        ).toThrow("index-corrupt");
        engine.knowledgeInsert(first, [entry], 1);
        expect(() => engine.knowledgeInsert(first, [entry], 0)).toThrow(
          "index-corrupt",
        );
        engine.knowledgePublish(first, revision);
        const reader = new RetrievalStorageEngine(catalog, true, config);
        try {
          expect(reader.knowledgeActive()?.generation_id).toBe(first);
          const second = engine.knowledgeBegin(revision);
          expect(reader.knowledgeActive()?.generation_id).toBe(first);
          expect(() => engine.knowledgePublish(second, revision + 1)).toThrow(
            "index-stale",
          );
          expect(engine.knowledgeActive()?.generation_id).toBe(first);
          expect(reader.knowledgeActive()?.generation_id).toBe(first);
          engine.knowledgePublish(second, revision);
          expect(engine.knowledgeActive()?.generation_id).toBe(second);
          expect(reader.knowledgeActive()?.generation_id).toBe(second);
        } finally {
          reader.close();
        }
        const db = new DatabaseSync(catalog, { readOnly: true });
        try {
          expect(
            db
              .prepare(
                "SELECT count(*) AS n FROM knowledge_retrieval_generations WHERE status='ready'",
              )
              .get(),
          ).toEqual({ n: 2 });
          expect(
            db
              .prepare("SELECT count(*) AS n FROM knowledge_retrieval_fts")
              .get(),
          ).toEqual({ n: 1 });
        } finally {
          db.close();
        }
      } finally {
        engine.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("appends a frozen manifest, preserves a restorable v7 backup, and admits old source readers", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "sciretriever-knowledge-retrieval-migration-"),
    );
    try {
      const catalog = await catalogV7(root),
        backup = join(root, "before-v8.sqlite");
      expect(SCHEMA_V8_MANIFEST.slice(1, SCHEMA_V7_MANIFEST.length)).toEqual(
        SCHEMA_V7_MANIFEST.slice(1),
      );
      expect(
        await migrateKnowledgeRetrievalCatalog({
          catalog_path: catalog,
          dry_run: true,
        }),
      ).toMatchObject({ action: "dry-run", from_version: 7, to_version: 8 });
      expect(
        await migrateKnowledgeRetrievalCatalog({
          catalog_path: catalog,
          backup_path: backup,
        }),
      ).toMatchObject({
        action: "migrated",
        from_version: 7,
        to_version: 8,
        manifest_fingerprint: SCHEMA_V8_FINGERPRINT,
      });
      expect((await inspectSynthesisCatalog(backup)).schema_version).toBe(7);
      expect(
        (await inspectKnowledgeRetrievalCatalog(catalog)).schema_version,
      ).toBe(8);
      const reader = new SqliteWorker(catalog, undefined, { readOnly: true });
      try {
        expect(await reader.queryPreflight()).toMatchObject({
          status: "ready",
          schema: { schema_version: 8 },
        });
        expect(await reader.retrieval("knowledgeRevision")).toBe(0);
        expect(await reader.retrieval("knowledgeActive")).toBeNull();
        expect(await reader.retrieval("active")).toBeNull();
      } finally {
        await reader.close();
      }
      const engine = new RetrievalStorageEngine(catalog, false, config);
      try {
        const id = engine.knowledgeBegin(engine.knowledgeRevision());
        expect(engine.knowledgePublish(id, 0)).toMatchObject({
          generation_id: id,
          source_count: 0,
          entry_count: 0,
        });
        expect(engine.knowledgeActive()?.generation_id).toBe(id);
        expect(engine.active()).toBeNull();
      } finally {
        engine.close();
      }
      expect(
        (await inspectKnowledgeRetrievalCatalog(catalog)).schema_version,
      ).toBe(8);
      expect(
        await migrateKnowledgeRetrievalCatalog({ catalog_path: catalog }),
      ).toMatchObject({ action: "already-v8" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("rolls back a failed v7-to-v8 commit and refuses altered projection DDL", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "sciretriever-knowledge-retrieval-migration-"),
    );
    try {
      const catalog = await catalogV7(root),
        backup = join(root, "before-v8.sqlite");
      await expect(
        migrateKnowledgeRetrievalCatalog({
          catalog_path: catalog,
          backup_path: backup,
          checkpoint: (stage) => {
            if (stage === "before-commit") throw new Error("injected");
          },
        }),
      ).rejects.toThrow("injected");
      expect((await inspectSynthesisCatalog(catalog)).schema_version).toBe(7);
      expect((await inspectSynthesisCatalog(backup)).schema_version).toBe(7);
      await expect(
        migrateKnowledgeRetrievalCatalog({
          catalog_path: catalog,
          backup_path: backup,
        }),
      ).rejects.toThrow();
      expect((await inspectSynthesisCatalog(catalog)).schema_version).toBe(7);
      await migrateKnowledgeRetrievalCatalog({
        catalog_path: catalog,
        backup_path: join(root, "retry.sqlite"),
      });
      const db = new DatabaseSync(catalog);
      try {
        db.exec("DROP INDEX knowledge_retrieval_entries_scope");
      } finally {
        db.close();
      }
      await expect(inspectKnowledgeRetrievalCatalog(catalog)).rejects.toThrow();
      const reader = new SqliteWorker(catalog, undefined, { readOnly: true });
      try {
        expect(await reader.queryPreflight()).toMatchObject({
          status: "ready",
          schema: { schema_version: 8 },
        });
        await expect(reader.retrieval("knowledgeActive")).rejects.toMatchObject(
          { code: "index-corrupt" },
        );
        expect(await reader.retrieval("active")).toBeNull();
      } finally {
        await reader.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("repairs corrupt derived knowledge FTS without changing source facts or material Context", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "sciretriever-knowledge-retrieval-migration-"),
    );
    try {
      const catalog = await catalogV7(root);
      await migrateKnowledgeRetrievalCatalog({
        catalog_path: catalog,
        backup_path: join(root, "before-v8.sqlite"),
      });
      const engine = new RetrievalStorageEngine(catalog, false, config);
      try {
        const revision = engine.knowledgeRevision(),
          generation = engine.knowledgeBegin(revision);
        engine.knowledgeInsert(
          generation,
          [
            {
              artifact_id: "00000000-0000-0000-0000-000000000001",
              content_sha256: "a".repeat(64),
              manifest_sha256: "b".repeat(64),
              scope_kind: "literature",
              scope_key: "00000000-0000-0000-0000-000000000002",
              purpose: "overview",
              question_sha256: "c".repeat(64),
              statement_id: "s1",
              statement_ordinal: 0,
              statement_sha256: "d".repeat(64),
              source_literature_ids: ["00000000-0000-0000-0000-000000000002"],
              scope_complete: 1,
              is_default: 0,
              title: "catalyst",
              body: "stable",
            },
          ],
          1,
        );
        engine.knowledgePublish(generation, revision);
        expect(engine.knowledgeActive()?.entry_count).toBe(1);
        expect(
          engine.knowledgeSearch(
            '"catalyst"',
            ["catalyst"],
            generation,
            ["00000000-0000-0000-0000-000000000002"],
            null,
            ["overview"],
            null,
            "all",
            2,
          ).hits,
        ).toMatchObject([
          { artifact_id: "00000000-0000-0000-0000-000000000001", score: -4 },
        ]);
        expect(
          engine.knowledgeSearch(
            '"catalyst"',
            ["catalyst"],
            generation,
            ["00000000-0000-0000-0000-000000000009"],
            null,
            ["overview"],
            null,
            "all",
            2,
          ).hits,
        ).toEqual([]);
        const db = new DatabaseSync(catalog);
        try {
          db.exec(
            "UPDATE knowledge_retrieval_fts SET body='tampered' WHERE rowid=1",
          );
        } finally {
          db.close();
        }
        expect(() => engine.knowledgeActive()).toThrow("index-corrupt");
        expect(engine.active()).toBeNull();
        const replacement = engine.knowledgeBegin(revision);
        engine.knowledgePublish(replacement, revision);
        expect(engine.knowledgeActive()?.entry_count).toBe(0);
      } finally {
        engine.close();
      }
      expect(
        (await inspectKnowledgeRetrievalCatalog(catalog)).schema_version,
      ).toBe(8);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
