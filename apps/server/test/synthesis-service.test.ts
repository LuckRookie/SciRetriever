import { dshAnalysisAdapter, dshChatReply } from "./dsh-analysis-fixture.js";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { build } from "esbuild";
import { chromium } from "playwright";
import {
  createSynthesisInputManifest,
  createInputManifest,
  extractionCanonicalJsonBytes,
  parseAsset,
  parseLiterature,
  parseProvenance,
  sha256,
  synthesisContentBytes,
  synthesisComparisonSha256,
  parseSynthesisPreparationRequest,
  parseSynthesisPreparationResult,
  type ArtifactRef,
} from "@sciretriever/contracts";
import {
  createApplication,
  createQueryApplication,
  type Application,
} from "../src/bootstrap/application.js";
import { KnowledgeSynthesisService } from "../src/analysis/synthesis.js";
import { synthesisMethodParameters } from "../src/analysis/synthesis.js";
import { documentAnalysisParameters } from "../src/analysis/knowledge-session.js";
import { KnowledgeAnalysisService } from "../src/analysis/knowledge.js";
import { SqliteKnowledgeStorage } from "../src/storage/knowledge.js";
import { DshAgentRuntime } from "../src/agents/dsh/runtime.js";
import type {
  AgentAdapter,
  AgentCall,
  AgentResult,
} from "../src/agents/protocol.js";
import { TypeScriptParserArtifactRules } from "../src/parsing/artifact-rules.js";
import { migrateDocumentCatalog } from "../src/storage/sqlite/document-migration.js";
import { migrateRetrievalCatalog } from "../src/storage/sqlite/retrieval-migration.js";
import { migrateExtractionCatalog } from "../src/storage/sqlite/extraction-migration.js";
import { migrateKnowledgeCatalog } from "../src/storage/sqlite/knowledge-migration.js";
import { migrateSynthesisCatalog } from "../src/storage/sqlite/synthesis-migration.js";
import {
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";
import {
  startQueryOnlyHttp,
  type WorkbenchStaticAsset,
} from "../src/workbench/http.js";

const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const literatureId = FIXTURE_LITERATURE.literature_id;
const sourceText =
  "# Result\nThe measurement was 4.2 eV under dry conditions.\n";

async function environment() {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-synthesis-service-"));
  let app: Application | undefined;
  try {
    app = await createApplication(home);
    await app.database.putLiterature(FIXTURE_LITERATURE);
    const pdf = workbenchPdf();
    const stage = await app.files.stage();
    try {
      await stage.write(pdf);
      await app.files.publish(stage, "objects/synthesis-source.pdf");
    } finally {
      await stage.discard();
    }
    const asset = parseAsset({
      asset_id: id(800),
      sha256: await sha256(pdf),
      size_bytes: pdf.length,
      media_type: "application/pdf",
      path: "objects/synthesis-source.pdf",
    });
    await app.database.putLiteratureAsset({
      literature_asset_id: id(801),
      literature_id: literatureId,
      asset,
      role: "primary-pdf",
      source_url: null,
      provenance: parseProvenance({
        provenance_id: id(802),
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
    const catalog = join(home, "catalog.sqlite");
    await migrateDocumentCatalog({
      catalog_path: catalog,
      backup_path: join(home, "v2.sqlite"),
    });
    await migrateRetrievalCatalog({
      catalog_path: catalog,
      backup_path: join(home, "v3.sqlite"),
    });
    await migrateExtractionCatalog({
      catalog_path: catalog,
      backup_path: join(home, "v4.sqlite"),
    });
    await migrateKnowledgeCatalog({
      catalog_path: catalog,
      backup_path: join(home, "v5.sqlite"),
    });
    await migrateSynthesisCatalog({
      catalog_path: catalog,
      backup_path: join(home, "v6.sqlite"),
    });
    let parseCount = 0;
    app = await createApplication(home, {
      executionSchema: "require-v2",
      parsing: {
        rules: new TypeScriptParserArtifactRules(),
        parser: {
          parse: async (request) => {
            const bytes = Buffer.from(
              request.source_asset_id === id(30001)
                ? "# Result\nThe measurement was 5.1 eV under wet conditions.\n"
                : request.source_asset_id === id(30002) ||
                    request.source_asset_id === id(30003)
                  ? "# Unrelated\nNo measurement relevant to this question.\n"
                  : request.source_asset_id === id(800) && parseCount > 0
                    ? "# Result\nThe revised measurement was 4.3 eV under dry conditions.\n"
                    : sourceText,
            );
            return {
              source_asset_id: request.source_asset_id,
              source_sha256: request.source_sha256,
              page_count: 1,
              markdown: {
                artifact: {
                  sha256: await sha256(bytes),
                  byte_size: bytes.length,
                  media_type: "text/markdown",
                } as ArtifactRef,
                bytes,
              },
              resources: [],
              provenance: {
                provenance: parseProvenance({
                  provenance_id: id(810 + ++parseCount),
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
    await app.documentProcessing.parseDocuments({
      literature_id: literatureId,
      asset_id: asset.asset_id,
      asset_sha256: asset.sha256,
      mode: "reparse",
      expected_default_revision: null,
    });
    return {
      home,
      app,
      asset,
      async close() {
        await app?.close();
        await rm(home, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await app?.close();
    await rm(home, { recursive: true, force: true });
    throw error;
  }
}

function runtime(
  options: {
    badMerge?: boolean;
    cancel?: AbortController;
    groupAll?: boolean;
    disagreement?: boolean;
    badLocal?: boolean;
    badCategory?: boolean;
    localDisagreement?: boolean;
    eraseDisagreement?: boolean;
  } = {},
) {
  const calls: AgentCall[] = [];
  const adapter: AgentAdapter = {
    provider: "fixture",
    model: "synthetic",
    execute: async (call): Promise<AgentResult> => {
      calls.push(call);
      const part = call.messages[1]?.parts[0];
      if (!part || part.media_type !== "application/json")
        throw new Error("missing input");
      const input = JSON.parse(part.text) as {
        core?: { segment_id: string; text: string }[];
        candidates?: {
          id: string;
          category: string;
          epistemic: string;
          text: string;
          conditions: string[];
          quantity: unknown;
          independent_literature_ids: string[];
          source_layers: {
            input_id: string;
            kind: string;
            state: string;
            compression_depth: number;
          }[];
        }[];
      };
      let value: Record<string, unknown>;
      if (input.core) {
        const segment = input.core.find(
          (item) =>
            item.text.includes("measurement was 4.2 eV") ||
            item.text.includes("measurement was 4.3 eV") ||
            item.text.includes("measurement was 5.1 eV"),
        );
        const wet = segment?.text.includes("5.1 eV") ?? false;
        const revised = segment?.text.includes("4.3 eV") ?? false;
        const valueNumber = wet ? "5.1" : revised ? "4.3" : "4.2";
        value = segment
          ? {
              outcome: "completed",
              title: "Local result",
              statements: [
                {
                  statement_id: "local-1",
                  category:
                    options.localDisagreement && wet
                      ? "disagreement"
                      : "result",
                  epistemic: "reported",
                  text: `${valueNumber} eV under ${wet ? "wet" : "dry"} conditions`,
                  conditions: [wet ? "wet conditions" : "dry conditions"],
                  quantity: {
                    value: valueNumber,
                    unit: "eV",
                    comparison_basis: null,
                  },
                  evidence_segment_ids: options.badLocal
                    ? ["absent-segment"]
                    : [segment.segment_id],
                },
              ],
            }
          : { outcome: "not_applicable", title: "No claim", statements: [] };
      } else if (input.candidates) {
        options.cancel?.abort();
        value = {
          title: "Collection result",
          statements: (options.groupAll
            ? [input.candidates[0]!]
            : input.candidates
          ).map((candidate, index) => ({
            statement_id: `merged-${index + 1}`,
            category:
              options.badCategory ||
              (options.eraseDisagreement &&
                candidate.category === "disagreement")
                ? "finding"
                : candidate.category,
            epistemic: candidate.epistemic,
            relation: options.disagreement
              ? "disagreement"
              : options.groupAll
                ? "consensus"
                : "single-source",
            conflict_group_id: options.disagreement ? "g1" : null,
            text: options.badMerge ? "unsupported rewrite" : candidate.text,
            conditions: candidate.conditions,
            quantity: candidate.quantity,
            source_ids: options.groupAll
              ? input.candidates!.map((item) => item.id)
              : [candidate.id],
          })),
        };
      } else throw new Error("unknown stage");
      return {
        kind: "structured",
        value,
        provenance: {
          provider: "fixture",
          model: "synthetic",
          usage: { input_tokens: 10, output_tokens: 10 },
        },
      };
    },
  };
  return {
    calls,
    agents: new DshAgentRuntime([
      {
        role: "analysis",
        provider: "fixture",
        model: "synthetic",
        capabilities: ["structured_text", "tool_decision"],
        reasoning: "default",
        stream: false,
        context_window_tokens: 1000000,
        max_output_tokens: 10000,
        adapter: dshAnalysisAdapter(adapter),
      },
    ]),
  };
}
function callInput(call: AgentCall): unknown {
  const part = call.messages[1]?.parts[0];
  if (!part || part.media_type !== "application/json")
    throw new Error("missing model input");
  return JSON.parse(part.text) as unknown;
}
function singleRuntime(): DshAgentRuntime {
  const adapter: AgentAdapter = {
    provider: "fixture",
    model: "synthetic",
    execute: async (call): Promise<AgentResult> => {
      const part = call.messages[1]?.parts[0];
      if (!part || part.media_type !== "application/json")
        throw new Error("missing input");
      const input = JSON.parse(part.text) as {
        segments: { segment_id: string; text: string }[];
      };
      const segment = input.segments.find((item) =>
        item.text.includes("measurement was 4.2 eV"),
      );
      if (!segment) throw new Error("missing result segment");
      return {
        kind: "structured",
        value: {
          outcome: "completed",
          title: "Single source",
          statements: [
            {
              statement_id: "finding-1",
              category: "result",
              epistemic: "reported",
              text: "4.2 eV under dry conditions",
              conditions: ["dry conditions"],
              quantity: { value: "4.2", unit: "eV", comparison_basis: null },
              evidence_segment_ids: [segment.segment_id],
            },
          ],
        },
        provenance: {
          provider: "fixture",
          model: "synthetic",
          usage: { input_tokens: 10, output_tokens: 10 },
        },
      };
    },
  };
  return new DshAgentRuntime([
    {
      role: "analysis",
      provider: "fixture",
      model: "synthetic",
      capabilities: ["structured_text", "tool_decision"],
      reasoning: "default",
      stream: false,
      context_window_tokens: 1000000,
      max_output_tokens: 10000,
      adapter: dshAnalysisAdapter(adapter),
    },
  ]);
}

async function selection(
  env: Awaited<ReturnType<typeof environment>>,
  inputId: string,
) {
  const material = await env.app.documentRead.materialEvidence({
    literature_id: literatureId,
    asset_id: env.asset.asset_id,
  });
  if (material.evidence.target_kind !== "material")
    throw new Error("material missing");
  const current = await env.app.documentRead.default({
    literature_id: literatureId,
    asset_id: env.asset.asset_id,
    asset_sha256: env.asset.sha256,
  });
  if (!current.default) throw new Error("document missing");
  return {
    kind: "document" as const,
    input_id: inputId,
    literature_id: literatureId,
    asset_id: env.asset.asset_id,
    asset_sha256: env.asset.sha256,
    document_version_id: current.default.document_version_id,
  };
}
async function addDocument(
  env: Awaited<ReturnType<typeof environment>>,
  index: number,
) {
  const paperId = id(10000 + index);
  const assetId = id(30000 + index);
  const doi = `10.5555/sciretriever.synthesis.${index}`;
  await env.app.database.putLiterature(
    parseLiterature({
      ...FIXTURE_LITERATURE,
      literature_id: paperId,
      meta_literature_id: id(20000 + index),
      metadata: {
        ...FIXTURE_LITERATURE.metadata,
        identifiers: [{ namespace: "doi", value: doi }],
      },
    }),
  );
  const bytes = workbenchPdf(doi);
  const path = `objects/synthesis-${index}.pdf`;
  const stage = await env.app.files.stage();
  try {
    await stage.write(bytes);
    await env.app.files.publish(stage, path);
  } finally {
    await stage.discard();
  }
  const asset = parseAsset({
    asset_id: assetId,
    sha256: await sha256(bytes),
    size_bytes: bytes.length,
    media_type: "application/pdf",
    path,
  });
  await env.app.database.putLiteratureAsset({
    literature_asset_id: id(50000 + index),
    literature_id: paperId,
    asset,
    role: "primary-pdf",
    source_url: null,
    provenance: parseProvenance({
      provenance_id: id(40000 + index),
      source_kind: "asset-provider",
      source_name: "synthetic",
      source_record_id: null,
      observed_at: "2026-09-29T00:00:00Z",
      input_sha256: asset.sha256,
      parameters_sha256: null,
    }),
  });
  const parsed = await env.app.documentProcessing.parseDocuments({
    literature_id: paperId,
    asset_id: assetId,
    asset_sha256: asset.sha256,
    mode: "reparse",
    expected_default_revision: null,
  });
  return {
    kind: "document" as const,
    input_id: `paper-${index}`,
    literature_id: paperId,
    asset_id: assetId,
    asset_sha256: asset.sha256,
    document_version_id: parsed.document.document_version_id,
  };
}

const budget = {
  max_source_bytes: 8 * 1024 * 1024,
  max_verification_bytes: 64 * 1024 * 1024,
  max_call_bytes: 256 * 1024,
  max_total_call_bytes: 32 * 1024 * 1024,
  max_calls: 256,
  max_output_tokens_per_call: 2048,
  max_total_output_tokens: 524288,
};
async function fixedRequest(
  env: Awaited<ReturnType<typeof environment>>,
  policy: "require-all" | "allow-partial",
  missing = 0,
  included = 1,
) {
  const base = await selection(env, "paper-1");
  const inputs = [
    ...Array.from({ length: included }, (_, index) => ({
      ...base,
      input_id: `paper-${index + 1}`,
    })),
    ...Array.from({ length: missing }, (_, index) => ({
      kind: "knowledge" as const,
      input_id: `absent-${index + 1}`,
      source_artifact_id: id(900 + index),
    })),
  ];
  const prepared = await env.app.synthesisPreparation!.prepare({
    policy,
    inputs,
  });
  return {
    schema_version: 3 as const,
    input: await createSynthesisInputManifest(prepared.manifest.items),
    purpose: "synthesis" as const,
    question: "What was measured?",
    policy,
    budget,
  };
}

describe("collection synthesis execution", () => {
  it("parses a complete 128-document preparation result above the old wrapper node cap", async () => {
    const env = await environment();
    try {
      const base = await selection(env, "paper-1");
      const inputs = Array.from({ length: 128 }, (_, index) => ({
        ...base,
        input_id: `paper-${index + 1}`,
      }));
      const request = parseSynthesisPreparationRequest({
        policy: "require-all",
        inputs,
      });
      const prepared = await env.app.synthesisPreparation!.prepare(request);
      expect(() =>
        extractionCanonicalJsonBytes(prepared, 300 * 1024, {
          maxDepth: 33,
          maxNodes: 4096,
        }),
      ).toThrow();
      const parsed = await parseSynthesisPreparationResult(prepared, request);
      expect(parsed.manifest.items).toHaveLength(128);
      expect(parsed.ready).toBe(true);
    } finally {
      await env.close();
    }
  });

  it("records actual usage without enforcing historical output reservations", async () => {
    const env = await environment();
    try {
      const dry = await selection(env, "paper-1");
      const wet = { ...(await addDocument(env, 1)), input_id: "paper-wet" };
      const prepared = await env.app.synthesisPreparation!.prepare({
        policy: "require-all",
        inputs: [dry, wet],
      });
      const fake = runtime({ disagreement: true });
      const service = new KnowledgeSynthesisService(
        env.app.documentRead,
        fake.agents,
        env.app.synthesisPreparation!,
        env.app.synthesisRead!,
      );
      const request = {
        schema_version: 3,
        input: prepared.manifest,
        purpose: "synthesis",
        question: "Do the two conditions agree?",
        policy: "require-all",
        budget: {
          ...budget,
          max_output_tokens_per_call: 100,
          max_total_output_tokens: 120,
        },
      };
      const receipt = await service.synthesize(request);
      expect(receipt.artifact?.provenance.output_tokens).toBe(30);
      const content = receipt.artifact!.content_ref;
      expect(await env.app.database.locateArtifact(content)).toMatchObject({
        reference: `knowledge/syntheses/${content.sha256.slice(0, 2)}/${content.sha256}.json`,
      });
      expect(fake.calls).toHaveLength(3);
      const payload = callInput(fake.calls[2]!) as {
        candidates: {
          independent_literature_ids: string[];
          source_layers: { kind: string; state: string }[];
        }[];
      };
      expect(
        payload.candidates.map((item) => item.independent_literature_ids),
      ).toEqual([[literatureId], [wet.literature_id]]);
      expect(
        payload.candidates.map((item) => item.source_layers[0]?.kind),
      ).toEqual(["document", "document"]);
      await expect(
        service.synthesize({
          ...request,
          question: "A different budgeted question?",
          budget: { ...request.budget, max_total_output_tokens: 119 },
        }),
      ).resolves.toMatchObject({ outcome: "published" });
      await service.close();
    } finally {
      await env.close();
    }
  });

  it("continues past a processed irrelevant document and distinguishes all irrelevant from bad output", async () => {
    const env = await environment();
    try {
      const useful = await selection(env, "paper-1");
      const irrelevant = await addDocument(env, 2);
      const another = await addDocument(env, 3);
      const policy = "require-all" as const;
      const prepared = await env.app.synthesisPreparation!.prepare({
        policy,
        inputs: [useful, irrelevant],
      });
      const fake = runtime();
      const service = new KnowledgeSynthesisService(
        env.app.documentRead,
        fake.agents,
        env.app.synthesisPreparation!,
        env.app.synthesisRead!,
      );
      const result = await service.synthesize({
        schema_version: 3,
        input: prepared.manifest,
        purpose: "synthesis",
        question: "Which measurement is relevant?",
        policy,
        budget,
      });
      expect(
        result.artifact?.coverage.items.map((item) => item.status),
      ).toEqual(["included", "included"]);
      expect(result.artifact?.coverage.unique_literature_count).toBe(1);
      expect(result.artifact?.provenance.output_tokens).toBe(30);
      expect(
        result.artifact?.content.statements[0]?.evidence.map(
          (item) => item.input_id,
        ),
      ).toEqual(["paper-1"]);
      const none = await env.app.synthesisPreparation!.prepare({
        policy,
        inputs: [irrelevant, another],
      });
      await expect(
        service.synthesize({
          schema_version: 3,
          input: none.manifest,
          purpose: "synthesis",
          question: "No relevant measurement?",
          policy,
          budget,
        }),
      ).rejects.toMatchObject({ code: "synthesis-not-applicable" });
      const bad = runtime({ badLocal: true });
      const badService = new KnowledgeSynthesisService(
        env.app.documentRead,
        bad.agents,
        env.app.synthesisPreparation!,
        env.app.synthesisRead!,
      );
      await expect(
        badService.synthesize({
          schema_version: 3,
          input: prepared.manifest,
          purpose: "synthesis",
          question: "Reject fabricated evidence?",
          policy,
          budget,
        }),
      ).rejects.toMatchObject({ code: "synthesis-response" });
      const changedCategory = runtime({ badCategory: true });
      const categoryService = new KnowledgeSynthesisService(
        env.app.documentRead,
        changedCategory.agents,
        env.app.synthesisPreparation!,
        env.app.synthesisRead!,
      );
      await expect(
        categoryService.synthesize({
          schema_version: 3,
          input: prepared.manifest,
          purpose: "synthesis",
          question: "Reject category rewrite?",
          policy,
          budget,
        }),
      ).resolves.toMatchObject({ outcome: "published" });
      await categoryService.close();
      await badService.close();
      await service.close();
    } finally {
      await env.close();
    }
  }, 15000);
  it("counts two versions and their summary as one Literature independently of model relationship labels", async () => {
    const env = await environment();
    try {
      const first = {
        ...(await selection(env, "paper-v1")),
        input_id: "paper-v1",
      };
      const material = await env.app.documentRead.materialEvidence({
        literature_id: literatureId,
        asset_id: env.asset.asset_id,
      });
      if (material.evidence.target_kind !== "material")
        throw new Error("material missing");
      const described = await env.app.documentRead.describe({
        document_version_id: first.document_version_id,
      });
      const singleManifest = await createInputManifest([
        {
          input_id: "paper-v1",
          literature_id: literatureId,
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
      const single = new KnowledgeAnalysisService(
        env.app.documentRead,
        singleRuntime(),
        new SqliteKnowledgeStorage(
          env.app.database,
          env.app.files,
          env.app.documentRead,
        ),
      );
      const prior = await single.analyze({
        schema_version: 1,
        input: singleManifest,
        purpose: "overview",
        question: null,
        default_update: null,
        budget: { max_input_bytes: 65536, max_output_tokens: 2048 },
      });
      await single.close();
      if (!prior.artifact) throw new Error("summary missing");
      await env.app.documentProcessing.parseDocuments({
        literature_id: literatureId,
        asset_id: env.asset.asset_id,
        asset_sha256: env.asset.sha256,
        mode: "reparse",
        expected_default_revision: 1,
      });
      const second = {
        ...(await selection(env, "paper-v2")),
        input_id: "paper-v2",
      };
      expect(second.document_version_id).not.toBe(first.document_version_id);
      const policy = "require-all" as const;
      const prepared = await env.app.synthesisPreparation!.prepare({
        policy,
        inputs: [
          first,
          second,
          {
            kind: "knowledge",
            input_id: "summary",
            source_artifact_id: prior.artifact.artifact_id,
          },
        ],
      });
      const fake = runtime();
      const service = new KnowledgeSynthesisService(
        env.app.documentRead,
        fake.agents,
        env.app.synthesisPreparation!,
        env.app.synthesisRead!,
      );
      const request = {
        schema_version: 3,
        input: prepared.manifest,
        purpose: "synthesis",
        question: "What did this one paper report?",
        policy,
        budget,
      };
      const receipt = await service.synthesize(request);
      expect(receipt.artifact?.coverage.unique_literature_count).toBe(1);
      expect(receipt.artifact?.content.statements).toHaveLength(3);
      const finalInput = callInput(fake.calls.at(-1)!) as {
        candidates: {
          independent_literature_ids: string[];
          source_layers: { kind: string; compression_depth: number }[];
        }[];
      };
      expect(
        finalInput.candidates.map((item) => item.independent_literature_ids),
      ).toEqual([[literatureId], [literatureId], [literatureId]]);
      expect(
        finalInput.candidates.map((item) => item.source_layers[0]?.kind),
      ).toEqual(["document", "document", "knowledge"]);
      expect(
        finalInput.candidates[2]?.source_layers[0]?.compression_depth,
      ).toBe(1);
      const falseConsensus = runtime({ groupAll: true });
      const rejecting = new KnowledgeSynthesisService(
        env.app.documentRead,
        falseConsensus.agents,
        env.app.synthesisPreparation!,
        env.app.synthesisRead!,
      );
      await expect(
        rejecting.synthesize({
          ...request,
          question: "Should these be counted as three papers?",
        }),
      ).resolves.toMatchObject({
        outcome: "published",
        artifact: { coverage: { unique_literature_count: 1 } },
      });
      await rejecting.close();
      await service.close();
    } finally {
      await env.close();
    }
  }, 15000);
  it("blocks require-all, publishes an honest 80/100 partial coverage, and reuses the winner", async () => {
    const env = await environment();
    try {
      const fake = runtime();
      const service = new KnowledgeSynthesisService(
        env.app.documentRead,
        fake.agents,
        env.app.synthesisPreparation!,
        env.app.synthesisRead!,
      );
      const blocked = await service.synthesize(
        await fixedRequest(env, "require-all", 20, 80),
      );
      expect(blocked.outcome).toBe("blocked");
      expect(blocked.gaps).toHaveLength(20);
      expect(fake.calls).toHaveLength(0);
      const request = await fixedRequest(env, "allow-partial", 20, 80);
      const result = await service.synthesize(request);
      expect(result.outcome).toBe("published");
      expect(result.published).toBe(true);
      expect(
        result.artifact?.coverage.items.filter(
          (item) => item.status === "included",
        ),
      ).toHaveLength(80);
      expect(
        result.artifact?.coverage.items.filter(
          (item) => item.status === "excluded",
        ),
      ).toHaveLength(20);
      expect(result.artifact?.coverage.unique_literature_count).toBe(1);
      expect(result.artifact?.content.statements[0]?.evidence).toHaveLength(80);
      expect(fake.calls.length).toBeGreaterThan(1);
      const count = fake.calls.length;
      const replay = await service.synthesize(request);
      expect(replay.published).toBe(false);
      expect(replay.artifact?.artifact_id).toBe(result.artifact?.artifact_id);
      expect(fake.calls).toHaveLength(count);
      const read = await env.app.synthesisRead!.byId(
        result.artifact!.artifact_id,
      );
      expect(read?.independent_literature_ids).toEqual([literatureId]);
      await service.close();
    } finally {
      await env.close();
    }
  });

  it("publishes model paraphrases and reuses them when only deprecated budgets change", async () => {
    const env = await environment();
    try {
      const request = await fixedRequest(env, "allow-partial");
      const malformed = runtime({ badMerge: true });
      const invalidService = new KnowledgeSynthesisService(
        env.app.documentRead,
        malformed.agents,
        env.app.synthesisPreparation!,
        env.app.synthesisRead!,
      );
      const rewritten = await invalidService.synthesize(request);
      expect(rewritten.artifact?.content.statements[0]?.text).toBe(
        "unsupported rewrite",
      );
      expect(
        await env.app.synthesisRead!.byId(rewritten.artifact!.artifact_id),
      ).toMatchObject({ artifact: rewritten.artifact });
      const tiny = runtime();
      const tinyService = new KnowledgeSynthesisService(
        env.app.documentRead,
        tiny.agents,
        env.app.synthesisPreparation!,
        env.app.synthesisRead!,
      );
      await expect(
        tinyService.synthesize({
          ...request,
          budget: {
            ...budget,
            max_call_bytes: 900,
          },
        }),
      ).resolves.toMatchObject({ outcome: "published" });
      await expect(
        tinyService.synthesize({
          ...request,
          budget: {
            ...budget,
            max_calls: 1,
          },
        }),
      ).resolves.toMatchObject({ outcome: "published" });
      const listed = await env.app.synthesisRead!.list(null, 20);
      expect(listed).toHaveLength(1);
      expect(tiny.calls).toHaveLength(0);
      await invalidService.close();
      await tinyService.close();
    } finally {
      await env.close();
    }
  });
  it("cancels before publication and rejects work after close", async () => {
    const env = await environment();
    try {
      const stop = new AbortController();
      const fake = runtime({ cancel: stop });
      const service = new KnowledgeSynthesisService(
        env.app.documentRead,
        fake.agents,
        env.app.synthesisPreparation!,
        env.app.synthesisRead!,
      );
      const request = await fixedRequest(env, "require-all");
      await expect(
        service.synthesize(request, stop.signal),
      ).rejects.toMatchObject({
        code: "synthesis-cancelled",
      });
      expect(await env.app.synthesisRead!.list(null, 20)).toEqual([]);
      await service.close();
      await expect(service.synthesize(request)).rejects.toMatchObject({
        code: "synthesis-closed",
      });
    } finally {
      await env.close();
    }
  });

  it("uses a source-only knowledge artifact while reporting the degraded input", async () => {
    const env = await environment();
    try {
      const material = await env.app.documentRead.materialEvidence({
        literature_id: literatureId,
        asset_id: env.asset.asset_id,
      });
      if (material.evidence.target_kind !== "material")
        throw new Error("material missing");
      const selected = await selection(env, "paper-1");
      const described = await env.app.documentRead.describe({
        document_version_id: selected.document_version_id,
      });
      const manifest = await createInputManifest([
        {
          input_id: "paper-1",
          literature_id: literatureId,
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
      const single = new KnowledgeAnalysisService(
        env.app.documentRead,
        singleRuntime(),
        new SqliteKnowledgeStorage(
          env.app.database,
          env.app.files,
          env.app.documentRead,
        ),
      );
      const source = await single.analyze({
        schema_version: 1,
        input: manifest,
        purpose: "overview",
        question: null,
        default_update: null,
        budget: { max_input_bytes: 65536, max_output_tokens: 2048 },
      });
      await single.close();
      if (!source.artifact) throw new Error("source missing");
      await unlink(join(env.home, "artifacts/objects/synthesis-source.pdf"));
      const policy = "allow-partial" as const;
      const prepared = await env.app.synthesisPreparation!.prepare({
        policy,
        inputs: [
          {
            kind: "knowledge",
            input_id: "prior-1",
            source_artifact_id: source.artifact.artifact_id,
          },
        ],
      });
      expect(prepared.ready).toBe(true);
      expect(prepared.gaps).toEqual([
        { input_id: "prior-1", code: "original-unavailable" },
      ]);
      const fake = runtime();
      const service = new KnowledgeSynthesisService(
        env.app.documentRead,
        fake.agents,
        env.app.synthesisPreparation!,
        env.app.synthesisRead!,
      );
      const receipt = await service.synthesize({
        schema_version: 3,
        input: prepared.manifest,
        purpose: "synthesis",
        question: "What was measured?",
        policy,
        budget,
      });
      expect(receipt.artifact?.coverage.items[0]).toEqual({
        input_id: "prior-1",
        status: "degraded",
        reason: "original-unavailable",
      });
      expect(
        receipt.artifact?.content.statements[0]?.evidence[0]?.target_kind,
      ).toBe("knowledge");
      expect(fake.calls).toHaveLength(1);
      const read = await env.app.synthesisRead!.byId(
        receipt.artifact!.artifact_id,
      );
      expect(read?.current_source_states).toEqual([
        { input_id: "prior-1", state: "source-only" },
      ]);
      await service.close();
    } finally {
      await env.close();
    }
  });

  it("synthesizes 80 distinct literatures and counts only actual independent support", async () => {
    const env = await environment();
    try {
      const inputs = [];
      for (let index = 10; index < 90; index++)
        inputs.push(await addDocument(env, index));
      const policy = "require-all" as const;
      const prepared = await env.app.synthesisPreparation!.prepare({
        policy,
        inputs,
      });
      expect(prepared.ready).toBe(true);
      const fake = runtime({ groupAll: true });
      const service = new KnowledgeSynthesisService(
        env.app.documentRead,
        fake.agents,
        env.app.synthesisPreparation!,
        env.app.synthesisRead!,
      );
      const receipt = await service.synthesize({
        schema_version: 3,
        input: prepared.manifest,
        purpose: "synthesis",
        question: "What was measured across 80 papers?",
        policy,
        budget,
      });
      expect(receipt.outcome).toBe("published");
      expect(receipt.artifact?.coverage.unique_literature_count).toBe(80);
      expect(receipt.artifact?.content.statements[0]?.relation).toBe(
        "consensus",
      );
      expect(receipt.artifact?.content.statements[0]?.evidence).toHaveLength(
        80,
      );
      expect(fake.calls.length).toBeGreaterThanOrEqual(81);
      const read = await env.app.synthesisRead!.byId(
        receipt.artifact!.artifact_id,
      );
      expect(read?.independent_literature_ids).toHaveLength(80);
      await service.close();
    } finally {
      await env.close();
    }
  }, 120000);

  it("keeps model-produced dry and wet results with actual source counts and ignores obsolete call limits", async () => {
    const env = await environment();
    try {
      const wet = { ...(await addDocument(env, 1)), input_id: "paper-wet" };
      const dry = await selection(env, "paper-1");
      const policy = "require-all" as const;
      const prepared = await env.app.synthesisPreparation!.prepare({
        policy,
        inputs: [dry, wet],
      });
      const fake = runtime({ disagreement: true });
      const service = new KnowledgeSynthesisService(
        env.app.documentRead,
        fake.agents,
        env.app.synthesisPreparation!,
        env.app.synthesisRead!,
      );
      const request = {
        schema_version: 3,
        input: prepared.manifest,
        purpose: "synthesis",
        question: "Do dry and wet conditions agree?",
        policy,
        budget,
      };
      await expect(
        service.synthesize({
          ...request,
          budget: {
            ...budget,
            max_calls: 2,
          },
        }),
      ).resolves.toMatchObject({ outcome: "published" });
      const receipt = await service.synthesize(request);
      expect(
        receipt.artifact?.content.statements.map(
          (item) => item.quantity?.value,
        ),
      ).toEqual(["4.2", "5.1"]);
      expect(
        receipt.artifact?.content.statements.map((item) => item.conditions[0]),
      ).toEqual(["dry conditions", "wet conditions"]);
      expect(
        receipt.artifact?.content.statements.map(
          (item) => item.conflict_group_id,
        ),
      ).toEqual(["g1", "g1"]);
      expect(receipt.artifact?.coverage.unique_literature_count).toBe(2);
      const erasing = runtime({
        disagreement: true,
        localDisagreement: true,
        eraseDisagreement: true,
      });
      const erasingService = new KnowledgeSynthesisService(
        env.app.documentRead,
        erasing.agents,
        env.app.synthesisPreparation!,
        env.app.synthesisRead!,
      );
      await expect(
        erasingService.synthesize({
          ...request,
          question: "Can a reported disagreement become a finding?",
        }),
      ).resolves.toMatchObject({ outcome: "published" });
      await erasingService.close();
      await service.close();
    } finally {
      await env.close();
    }
  }, 15000);
  it("connects fixed selection, CSRF maintenance, and read-only Web", async () => {
    const env = await environment();
    const fake = runtime();
    const service = new KnowledgeSynthesisService(
      env.app.documentRead,
      fake.agents,
      env.app.synthesisPreparation!,
      env.app.synthesisRead!,
    );
    const query = await createQueryApplication(env.home);
    const assets = new Map<string, WorkbenchStaticAsset>();
    for (const [route, file, contentType] of [
      ["/", "maintenance.html", "text/html"],
      ["/query", "query.html", "text/html"],
      ["/styles.css", "styles.css", "text/css"],
      ["/live.css", "live.css", "text/css"],
    ] as const)
      assets.set(route, {
        contentType,
        body: await readFile(
          new URL(`../../web/public/${file}`, import.meta.url),
        ),
      });
    for (const [route, file] of [
      ["/maintenance.js", "maintenance.ts"],
      ["/query.js", "query.ts"],
    ] as const) {
      const bundle = await build({
        entryPoints: [
          new URL(`../../web/src/${file}`, import.meta.url).pathname,
        ],
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
    const http = await startQueryOnlyHttp({
      application: query,
      assets,
      maintenance: {
        ...env.app.maintenance!,
        synthesize: service.synthesize.bind(service),
      },
    });
    const browser = await chromium.launch({
      executablePath:
        process.env.SCIRETRIEVER_BROWSER_EXECUTABLE ??
        chromium.executablePath(),
      headless: true,
    });
    try {
      const selected = await selection(env, "paper-1");
      const page = await browser.newPage();
      await page.goto(http.origin);
      await page.locator("#synthesis-inputs").fill(JSON.stringify([selected]));
      await page.locator("#synthesis-prepare").click();
      await expect
        .poll(() => page.locator("#synthesis-status").textContent())
        .toContain("已固定 1 项");
      await page.locator("#synthesis-question").fill("What was measured?");
      const noCsrf = await fetch(
        `${http.origin}/api/v1/maintenance/synthesize`,
        {
          method: "POST",
          headers: { origin: http.origin, "content-type": "application/json" },
          body: JSON.stringify({ protocol_version: 1, request: {} }),
        },
      );
      expect(noCsrf.ok).toBe(false);
      await page.locator("#synthesis-start").click();
      await expect
        .poll(() => page.locator("#synthesis-status").textContent())
        .toContain("已发布");
      const receipt = JSON.parse(
        (await page.locator("#synthesis-result").textContent())!,
      ) as {
        artifact: { artifact_id: string };
      };
      await page.goto(`${http.origin}/query`);
      await page
        .locator("#synthesis-read-id")
        .fill(receipt.artifact.artifact_id);
      await page.locator("#synthesis-read-submit").click();
      await expect
        .poll(() => page.locator("#synthesis-read-status").textContent())
        .toContain("已核对");
      expect(
        await page.locator("#synthesis-read-results").textContent(),
      ).toContain("4.2 eV under dry conditions");
      let evidencePage = 0;
      let completeEvidence: Record<string, unknown> | null = null;
      await page.route("**/api/v1/query/evidence-resolve", async (route) => {
        if (evidencePage++ === 0) {
          const response = await route.fetch();
          const envelope = (await response.json()) as {
            protocol_version: number;
            result: Record<string, unknown> & {
              actual_range: { start_utf8: number; end_utf8: number };
              text: string;
            };
          };
          completeEvidence = envelope.result;
          const split = 20;
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              protocol_version: 1,
              result: {
                ...envelope.result,
                actual_range: {
                  ...envelope.result.actual_range,
                  end_utf8: envelope.result.actual_range.start_utf8 + split,
                },
                text: envelope.result.text.slice(0, split),
                truncated: true,
                continuation: "fixture_cursor",
              },
            }),
          });
        } else {
          if (!completeEvidence) throw new Error("evidence page missing");
          const full = completeEvidence as Record<string, unknown> & {
            actual_range: { start_utf8: number; end_utf8: number };
            text: string;
          };
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              protocol_version: 1,
              result: {
                ...full,
                actual_range: {
                  ...full.actual_range,
                  start_utf8: full.actual_range.start_utf8 + 20,
                },
                text: full.text.slice(20),
              },
            }),
          });
        }
      });
      await page
        .locator("#synthesis-read-results button", { hasText: "展开证据" })
        .first()
        .click();
      await expect
        .poll(() => page.locator("#synthesis-read-results").textContent())
        .toContain("部分");
      await page
        .locator("#synthesis-read-results button", { hasText: "继续读取证据" })
        .first()
        .click();
      await expect
        .poll(() => page.locator("#synthesis-read-results").textContent())
        .toContain("已读取完整证据");
      expect(evidencePage).toBe(2);
      await page.unroute("**/api/v1/query/evidence-resolve");
      await page.route("**/api/v1/query/synthesis-read", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            protocol_version: 1,
            result: {
              artifact: receipt.artifact,
              current_source_states: [
                { input_id: "paper-1", state: "verified" },
              ],
              independent_literature_ids: [literatureId],
            },
          }),
        }),
      );
      await page.locator("#synthesis-read-id").fill(id(999));
      await page.locator("#synthesis-read-submit").click();
      await expect
        .poll(() => page.locator("#synthesis-read-status").textContent())
        .toContain("读取失败");
      expect(await page.locator("#synthesis-read-results").textContent()).toBe(
        "",
      );
      await page.unroute("**/api/v1/query/synthesis-read");
      await page.locator("#synthesis-list-submit").click();
      await expect
        .poll(() => page.locator("#synthesis-read-status").textContent())
        .toContain("找到 1 项");
      await unlink(join(env.home, "artifacts/objects/synthesis-source.pdf"));
      await page.goto(http.origin);
      await page.locator("#synthesis-inputs").fill(
        JSON.stringify([
          {
            kind: "knowledge",
            input_id: "prior-1",
            source_artifact_id: receipt.artifact.artifact_id,
          },
        ]),
      );
      await page.locator("#synthesis-policy").selectOption("allow-partial");
      await page.locator("#synthesis-prepare").click();
      await expect
        .poll(() => page.locator("#synthesis-status").textContent())
        .toContain("1 项缺口");
      await page
        .locator("#synthesis-question")
        .fill("What does the prior synthesis report?");
      await page.locator("#synthesis-start").click();
      await expect
        .poll(() => page.locator("#synthesis-status").textContent())
        .toContain("已发布");
      const nested = JSON.parse(
        (await page.locator("#synthesis-result").textContent())!,
      ) as {
        artifact: { artifact_id: string };
      };
      await page.goto(`${http.origin}/query`);
      await page
        .locator("#synthesis-read-id")
        .fill(nested.artifact.artifact_id);
      await page.locator("#synthesis-read-submit").click();
      await expect
        .poll(() => page.locator("#synthesis-read-status").textContent())
        .toContain("已核对");
      expect(
        await page.locator("#synthesis-read-results").textContent(),
      ).toContain("source-only");
      await page.locator("#synthesis-read-results button").first().click();
      await expect
        .poll(() =>
          page
            .locator("#synthesis-read-results section section")
            .first()
            .textContent(),
        )
        .toContain(`来源 ${receipt.artifact.artifact_id} · 当前 source-only`);
      expect(
        await page.locator("#synthesis-read-results").textContent(),
      ).toContain("原 PDF 当前无法复核");
      await page.locator("#synthesis-read-submit").click();
      await expect
        .poll(() => page.locator("#synthesis-read-status").textContent())
        .toContain("已核对");
      await page.route("**/api/v1/query/synthesis-source", async (route) => {
        const response = await route.fetch();
        const envelope = JSON.parse(await response.text()) as {
          protocol_version: number;
          result: {
            artifact: {
              content: Parameters<typeof synthesisContentBytes>[0];
              content_ref: { sha256: string; byte_size: number };
            };
          };
        };
        (envelope.result.artifact.content as { title: string }).title =
          "Different source content";
        const bytes = synthesisContentBytes(envelope.result.artifact.content);
        envelope.result.artifact.content_ref.sha256 = await sha256(bytes);
        envelope.result.artifact.content_ref.byte_size = bytes.length;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(envelope),
        });
      });
      await page.locator("#synthesis-read-results button").first().click();
      await expect
        .poll(() => page.locator("#synthesis-read-results").textContent())
        .toContain("来源内容或固定清单不匹配");
      await page.unroute("**/api/v1/query/synthesis-source");
      await page.route("**/api/v1/query/synthesis-read", async (route) => {
        const response = await route.fetch();
        const envelope = JSON.parse(await response.text()) as {
          protocol_version: number;
          result: {
            artifact: {
              content: Parameters<typeof synthesisContentBytes>[0];
              content_ref: { sha256: string; byte_size: number };
            };
          };
        };
        const evidence =
          envelope.result.artifact.content.statements[0]!.evidence[0]!;
        if (evidence.target_kind !== "knowledge")
          throw new Error("knowledge source missing");
        (evidence as { statement_sha256: string }).statement_sha256 =
          "f".repeat(64);
        const bytes = synthesisContentBytes(envelope.result.artifact.content);
        envelope.result.artifact.content_ref.sha256 = await sha256(bytes);
        envelope.result.artifact.content_ref.byte_size = bytes.length;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(envelope),
        });
      });
      await page.locator("#synthesis-read-submit").click();
      await expect
        .poll(() => page.locator("#synthesis-read-status").textContent())
        .toContain("已核对");
      await page.locator("#synthesis-read-results button").first().click();
      await expect
        .poll(() => page.locator("#synthesis-read-results").textContent())
        .toContain("来源断言内容不匹配");
      await page.unroute("**/api/v1/query/synthesis-read");
      await page.locator("#synthesis-read-submit").click();
      await expect
        .poll(() => page.locator("#synthesis-read-status").textContent())
        .toContain("已核对");
      let releaseSource: (() => void) | null = null;
      await page.route("**/api/v1/query/synthesis-source", async (route) => {
        const response = await route.fetch();
        await new Promise<void>((resolve) => {
          releaseSource = resolve;
        });
        await route.fulfill({ response }).catch(() => undefined);
      });
      await page.locator("#synthesis-read-results button").first().click();
      await expect.poll(() => releaseSource !== null).toBe(true);
      await page.locator("#synthesis-read-id").fill(id(999));
      (releaseSource as (() => void) | null)?.();
      await expect
        .poll(() => page.locator("#synthesis-read-results").textContent())
        .toBe("");
      await page.unroute("**/api/v1/query/synthesis-source");
    } finally {
      await browser.close();
      await http.close();
      await query.close();
      await service.close();
      await env.close();
    }
  }, 45000);
  it("uses the production Application synthesis binding and closes cleanly", async () => {
    const env = await environment();
    let app: Application | undefined;
    try {
      const selected = await selection(env, "paper-1");
      await env.app.close();
      const directory = join(env.home, ".sciretriever");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(
        join(directory, "config.toml"),
        [
          "[providers.fixture]",
          'api = "openai-chat-completions"',
          'base_url = "http://127.0.0.1:9/v1"',
          "",
          '[models."fixture/model"]',
          'reasoning = "medium"',
          "stream = false",
          "",
          "[analyze]",
          'model = "fixture/model"',
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
      let calls = 0;
      app = await createApplication(env.home, {
        executionSchema: "require-v2",
        agentTransportFactory:
          () =>
          async (request: {
            readonly body: Uint8Array;
            readonly onDispatched?: () => void;
          }) => {
            calls++;
            request.onDispatched?.();
            const wire = JSON.parse(
              new TextDecoder().decode(request.body),
            ) as Parameters<typeof dshChatReply>[0];
            const reply = await dshChatReply(wire, (raw) => {
              const input = raw as {
                core?: { segment_id: string; text: string }[];
                candidates?: {
                  id: string;
                  category: string;
                  epistemic: string;
                  text: string;
                  conditions: string[];
                  quantity: unknown;
                }[];
              };
              const core = input.core?.find((item) =>
                item.text.includes("measurement was 4.2 eV"),
              );
              const value = input.candidates
                ? {
                    title: "Production synthesis",
                    statements: input.candidates.map((candidate, index) => ({
                      statement_id: `m${index + 1}`,
                      category: candidate.category,
                      epistemic: candidate.epistemic,
                      relation: "single-source",
                      conflict_group_id: null,
                      text: candidate.text,
                      conditions: candidate.conditions,
                      quantity: candidate.quantity,
                      source_ids: [candidate.id],
                    })),
                  }
                : core
                  ? {
                      outcome: "completed",
                      title: "Production local",
                      statements: [
                        {
                          statement_id: "s1",
                          category: "result",
                          epistemic: "reported",
                          text: "4.2 eV under dry conditions",
                          conditions: ["dry conditions"],
                          quantity: {
                            value: "4.2",
                            unit: "eV",
                            comparison_basis: null,
                          },
                          evidence_segment_ids: [core.segment_id],
                        },
                      ],
                    }
                  : {
                      outcome: "not_applicable",
                      title: "No claim",
                      statements: [],
                    };
              return value;
            });
            return {
              status: 200,
              headers: [],
              body: Buffer.from(JSON.stringify(reply)),
            };
          },
      });
      expect(app.maintenance?.synthesize).toBeTypeOf("function");
      const policy = "require-all" as const;
      const prepared = await app.synthesisPreparation!.prepare({
        policy,
        inputs: [selected],
      });
      const request = {
        schema_version: 3,
        input: prepared.manifest,
        purpose: "synthesis",
        question: "What was measured?",
        policy,
        budget,
      };
      const receipt = await app.maintenance!.synthesize!(request);
      expect(receipt.published).toBe(true);
      expect(receipt.artifact?.provenance).toMatchObject({
        provider: "fixture",
        model: "model",
      });
      const method = receipt.artifact!.method;
      const parameters = await synthesisMethodParameters(
        budget,
        method.model_binding_sha256,
      );
      const longBudget = {
        max_source_bytes: budget.max_source_bytes,
        max_call_bytes: budget.max_call_bytes,
        max_total_call_bytes: budget.max_total_call_bytes,
        max_calls: budget.max_calls,
        max_output_tokens_per_call: budget.max_output_tokens_per_call,
        max_total_output_tokens: budget.max_total_output_tokens,
      };
      expect(parameters).toMatchObject({
        local_method_parameters_sha256: await sha256(
          extractionCanonicalJsonBytes(
            documentAnalysisParameters(longBudget, method.model_binding_sha256),
            32768,
          ),
        ),
      });
      expect(method.parameters_sha256).toBe(
        await sha256(extractionCanonicalJsonBytes(parameters, 32768)),
      );
      expect(receipt.artifact!.comparison_sha256).toBe(
        await synthesisComparisonSha256({
          manifest_sha256: prepared.manifest.manifest_sha256,
          question: request.question,
          policy,
          method,
        }),
      );
      expect(calls).toBeGreaterThan(1);
      await app.close();
      app = undefined;
      const query = await createQueryApplication(env.home);
      try {
        expect(
          await query.synthesisRead!.byId(receipt.artifact!.artifact_id),
        ).toMatchObject({
          artifact: { artifact_id: receipt.artifact!.artifact_id },
        });
      } finally {
        await query.close();
      }
    } finally {
      await app?.close();
      await env.close();
    }
  });
});
