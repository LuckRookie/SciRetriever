import { dshAnalysisAdapter, dshChatReply } from "./dsh-analysis-fixture.js";
import { mkdtemp, rm, mkdir, writeFile, unlink } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { reactWorkbenchAssets } from "./react-workbench-fixture.js";
import { chromium } from "playwright";
import {
  createInputManifest,
  createSynthesisInputManifest,
  EXTRACTION_SCHEMA_URI,
  extractionSpecHash,
  parseAsset,
  parseLiterature,
  parseProvenance,
  sha256,
  extractionCanonicalJsonBytes,
  synthesisComparisonSha256,
  synthesisContentBytes,
  synthesisStatementSha256,
  knowledgeContentBytes,
  knowledgeComparisonSha256,
  parseKnowledgeContent,
  parseSynthesisArtifact,
  type ArtifactRef,
  type InputManifest,
} from "@sciretriever/contracts";
import {
  createApplication,
  createQueryApplication,
  type Application,
} from "../src/bootstrap/application.js";
import { KnowledgeAnalysisService } from "../src/analysis/knowledge.js";
import type { KnowledgeStoragePort } from "../src/analysis/knowledge-port.js";
import { DshAgentRuntime } from "../src/agents/dsh/runtime.js";
import { AgentFailure } from "../src/agents/protocol.js";
import type {
  AgentAdapter,
  AgentCall,
  AgentResult,
} from "../src/agents/protocol.js";
import { SqliteKnowledgeStorage } from "../src/storage/knowledge.js";
import { SqliteSynthesisStorage } from "../src/storage/synthesis.js";
import { SynthesisPreparationService } from "../src/analysis/synthesis-prepare.js";
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
import { startQueryOnlyHttp } from "../src/workbench/http.js";
import { RetrievalIndexService } from "../src/retrieval/index.js";
import { RetrievalStorageClient } from "../src/storage/sqlite/retrieval-client.js";

const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const literatureId = FIXTURE_LITERATURE.literature_id;
const markdown =
  "# Synthetic result\nThe measurement was 4.2 eV under dry conditions.\nLimitations remain.\n";
async function environment(sourceMarkdown = markdown) {
  const home = await mkdtemp(
    join(tmpdir(), "sciretriever-knowledge-analysis-"),
  );
  let app: Application | undefined;
  try {
    app = await createApplication(home);
    await app.database.putLiterature(FIXTURE_LITERATURE);
    const pdf = workbenchPdf();
    const stage = await app.files.stage();
    try {
      await stage.write(pdf);
      await app.files.publish(stage, "objects/knowledge-source.pdf");
    } finally {
      await stage.discard();
    }
    const asset = parseAsset({
      asset_id: id(800),
      sha256: await sha256(pdf),
      size_bytes: pdf.length,
      media_type: "application/pdf",
      path: "objects/knowledge-source.pdf",
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
    await migrateKnowledgeCatalog({
      catalog_path: catalog,
      backup_path: join(home, "before-v6.sqlite"),
    });
    let parseCount = 0;
    app = await createApplication(home, {
      executionSchema: "require-v2",
      parsing: {
        rules: new TypeScriptParserArtifactRules(),
        parser: {
          parse: async (request) => {
            parseCount++;
            const bytes = Buffer.from(
              parseCount === 1
                ? sourceMarkdown
                : `${sourceMarkdown}A later version.\n`,
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
                  provenance_id: id(810 + parseCount),
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
    const first = await app.documentProcessing.parseDocuments({
      literature_id: literatureId,
      asset_id: asset.asset_id,
      asset_sha256: asset.sha256,
      mode: "reparse",
      expected_default_revision: null,
    });
    const materialResult = await app.documentRead.materialEvidence({
      literature_id: literatureId,
      asset_id: asset.asset_id,
    });
    if (materialResult.evidence.target_kind !== "material")
      throw new Error("invalid synthetic material");
    const described = await app.documentRead.describe({
      document_version_id: first.document.document_version_id,
    });
    const manifest = await createInputManifest([
      {
        input_id: "paper-1",
        literature_id: literatureId,
        material: materialResult.evidence.material,
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
    return {
      home,
      asset,
      first,
      manifest,
      get app() {
        return app!;
      },
      async reparse() {
        return app!.documentProcessing.parseDocuments({
          literature_id: literatureId,
          asset_id: asset.asset_id,
          asset_sha256: asset.sha256,
          mode: "reparse",
          expected_default_revision: 1,
        });
      },
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
function request(
  input: InputManifest,
  overrides: Record<string, unknown> = {},
) {
  return {
    schema_version: 1,
    input,
    purpose: "overview",
    question: null,
    default_update: null,
    budget: { max_input_bytes: 65536, max_output_tokens: 2048 },
    ...overrides,
  };
}
function longRequest(
  input: InputManifest,
  overrides: Record<string, unknown> = {},
) {
  return {
    schema_version: 2,
    input,
    purpose: "detailed",
    question: null,
    default_update: null,
    budget: {
      max_source_bytes: 8 * 1024 * 1024,
      max_call_bytes: 256 * 1024,
      max_total_call_bytes: 32 * 1024 * 1024,
      max_calls: 256,
      max_output_tokens_per_call: 2048,
      max_total_output_tokens: 524288,
    },
    ...overrides,
  };
}
function longRuntime(
  options: {
    outputTokens?: number;
    invalidEvidence?: boolean;
    invalidQuantity?: boolean;
    notApplicable?: boolean;
    onModel?: (
      request: import("../src/agents/model-protocol.js").ModelRequest,
      index: number,
    ) => void;
  } = {},
) {
  const calls: AgentCall[] = [];
  const modelCalls: import("../src/agents/model-protocol.js").ModelRequest[] =
    [];
  const adapter = dshAnalysisAdapter({
    provider: "fixture",
    model: "synthetic",
    execute: async (call): Promise<AgentResult> => {
      calls.push(call);
      const part = call.messages[1]!.parts[0]!;
      if (!("text" in part)) throw new Error("Missing text");
      const input = JSON.parse(part.text) as {
        segments: { segment_id: string; text: string }[];
      };
      const markers = [
        ["DRY_RESULT_4.2_eV", "4.2 eV under dry conditions"],
        ["NEGATED_IMPROVEMENT", "The treatment did not improve yield"],
        [
          "WET_CONTRADICTION_5.1_eV",
          "5.1 eV under wet conditions contradicts dry result",
        ],
        ["CANNOT_REDUCE", "It cannot reduce energy"],
        ["CHINESE_NEGATION", "结果未显著改善"],
        ["AFFIRMATIVE_CONTROL", "The control improved yield"],
        ["measurement was 4.2 eV", "4.2 eV under dry conditions"],
        ["MEASURE_4.2_eV", "4.2 eV under dry-only conditions"],
      ];
      const statements = options.notApplicable
        ? []
        : markers.flatMap(([marker, text]) => {
            const segment = input.segments.find((s) =>
              s.text.includes(marker!),
            );
            if (!segment) return [];
            const condition = input.segments.find((s) =>
              s.text.includes("CONDITION_DRY_ONLY"),
            );
            return [
              {
                statement_id: `s${markers.findIndex((m) => m[0] === marker)}`,
                category: marker!.includes("WET") ? "disagreement" : "result",
                epistemic: "reported",
                text,
                conditions: condition ? ["dry only"] : [],
                quantity: options.invalidQuantity
                  ? { value: "4.2", unit: "eV" }
                  : null,
                evidence_segment_ids: options.invalidEvidence
                  ? ["forged"]
                  : [
                      ...new Set([
                        segment.segment_id,
                        ...(condition ? [condition.segment_id] : []),
                      ]),
                    ],
              },
            ];
          });
      return {
        kind: "structured",
        value: {
          outcome: statements.length ? "completed" : "not_applicable",
          title: "Synthetic analysis",
          statements,
        },
        provenance: {
          provider: "fixture",
          model: "synthetic",
          usage: {
            input_tokens: 100,
            output_tokens: options.outputTokens ?? 50,
          },
        },
      };
    },
  });
  return {
    calls,
    modelCalls,
    agent: new DshAgentRuntime([
      {
        role: "analysis",
        provider: "fixture",
        model: "synthetic",
        capabilities: ["structured_text", "tool_decision"],
        reasoning: "default",
        stream: false,
        context_window_tokens: 1000000,
        max_output_tokens: 10000,
        adapter: {
          ...adapter,
          executeModel: async (request, ...args) => {
            modelCalls.push(request);
            options.onModel?.(request, modelCalls.length);
            return adapter.executeModel!(request, ...args);
          },
        },
      },
    ]),
  };
}
function runtime(
  options: {
    text?: string;
    badEvidence?: boolean;
    reasoning?: "default" | "high";
    gate?: Promise<void>;
    failure?: AgentFailure | undefined;
    response?: Record<string, unknown>;
  } = {},
) {
  const calls: AgentCall[] = [];
  const adapter: AgentAdapter = {
    provider: "fixture",
    model: "synthetic",
    execute: async (call): Promise<AgentResult> => {
      calls.push(call);
      await options.gate;
      if (options.failure) throw options.failure;
      const user = call.messages[1]?.parts[0];
      if (!user || user.media_type !== "application/json")
        throw new Error("missing prompt");
      const input = JSON.parse(user.text) as {
        segments: { segment_id: string; text: string }[];
      };
      const id = options.badEvidence
        ? "forged-segment"
        : (input.segments[1]?.segment_id ?? input.segments[0]!.segment_id);
      return {
        kind: "structured",
        value: options.response ?? {
          outcome: "completed",
          title: "Synthetic finding",
          statements: [
            {
              statement_id: "finding-1",
              category: "result",
              epistemic: "reported",
              text: options.text ?? "4.2 eV under dry conditions",
              conditions: ["dry conditions"],
              quantity: { value: "4.2", unit: "eV", comparison_basis: null },
              evidence_segment_ids: [id],
            },
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
  return {
    calls,
    agent: new DshAgentRuntime([
      {
        role: "analysis",
        provider: "fixture",
        model: "synthetic",
        capabilities: ["structured_text", "tool_decision"],
        reasoning: options.reasoning ?? "default",
        stream: false,
        context_window_tokens: 1000000,
        max_output_tokens: 10000,
        adapter: dshAnalysisAdapter(adapter),
      },
    ]),
  };
}

describe("single-document knowledge analysis", () => {
  it("keeps the committed artifact when cancellation arrives after publication", async () => {
    const env = await environment();
    const fake = runtime();
    const storage = new SqliteKnowledgeStorage(
      env.app.database,
      env.app.files,
      env.app.documentRead,
    );
    const stop = new AbortController();
    const publishing: KnowledgeStoragePort = {
      byId: storage.byId.bind(storage),
      byComparison: storage.byComparison.bind(storage),
      publish: async (artifact, signal) => {
        const receipt = await storage.publish(artifact, signal);
        stop.abort();
        return receipt;
      },
      updateDefault: storage.updateDefault.bind(storage),
    };
    const service = new KnowledgeAnalysisService(
      env.app.documentRead,
      fake.agent,
      publishing,
    );
    try {
      const receipt = await service.analyze(
        request(env.manifest, { default_update: { expected_revision: null } }),
        stop.signal,
      );
      expect(receipt).toMatchObject({
        published: true,
        default_updated: false,
        default_revision: null,
        default_update_outcome: "cancelled",
      });
      expect(await storage.byId(receipt.artifact.artifact_id)).toEqual(
        receipt.artifact,
      );
      expect(await storage.list(literatureId)).toHaveLength(1);
    } finally {
      await service.close();
      fake.agent.close();
      await env.close();
    }
  });
  it("reports default-write failure without losing the committed artifact or leaking the cause", async () => {
    const env = await environment();
    const fake = runtime();
    const storage = new SqliteKnowledgeStorage(
      env.app.database,
      env.app.files,
      env.app.documentRead,
    );
    const service = new KnowledgeAnalysisService(
      env.app.documentRead,
      fake.agent,
      {
        byId: storage.byId.bind(storage),
        byComparison: storage.byComparison.bind(storage),
        publish: storage.publish.bind(storage),
        updateDefault: async () => {
          throw new Error("private storage detail");
        },
      },
    );
    try {
      const receipt = await service.analyze(
        request(env.manifest, { default_update: { expected_revision: null } }),
      );
      expect(receipt).toMatchObject({
        published: true,
        default_update_outcome: "failed",
        default_update_failure: "storage-failed",
        default_updated: false,
        default_revision: null,
      });
      expect(JSON.stringify(receipt)).not.toContain("private storage detail");
      expect(await storage.byId(receipt.artifact.artifact_id)).toEqual(
        receipt.artifact,
      );
    } finally {
      await service.close();
      fake.agent.close();
      await env.close();
    }
  });
  it("settles an already committed default write from its SQL result after cancellation", async () => {
    const env = await environment();
    const fake = runtime();
    const stop = new AbortController();
    const storage = new SqliteKnowledgeStorage(
      env.app.database,
      env.app.files,
      env.app.documentRead,
    );
    const service = new KnowledgeAnalysisService(
      env.app.documentRead,
      fake.agent,
      {
        byId: storage.byId.bind(storage),
        byComparison: storage.byComparison.bind(storage),
        publish: storage.publish.bind(storage),
        updateDefault: async (input, signal) => {
          const committed = await storage.updateDefault(input, signal);
          stop.abort();
          return committed;
        },
      },
    );
    try {
      const receipt = await service.analyze(
        request(env.manifest, { default_update: { expected_revision: null } }),
        stop.signal,
      );
      expect(receipt).toMatchObject({
        default_update_outcome: "updated",
        default_updated: true,
        default_revision: 1,
      });
      expect(
        (
          await storage.default(
            literatureId,
            "overview",
            await sha256(new TextEncoder().encode("")),
          )
        )?.artifact_id,
      ).toBe(receipt.artifact.artifact_id);
    } finally {
      await service.close();
      fake.agent.close();
      await env.close();
    }
  });
  it("classifies a default write cancelled before SQLite admission without starting it", async () => {
    const env = await environment();
    const fake = runtime();
    const stop = new AbortController();
    let entered!: () => void;
    const pending = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const storage = new SqliteKnowledgeStorage(
      env.app.database,
      env.app.files,
      env.app.documentRead,
    );
    const service = new KnowledgeAnalysisService(
      env.app.documentRead,
      fake.agent,
      {
        byId: storage.byId.bind(storage),
        byComparison: storage.byComparison.bind(storage),
        publish: storage.publish.bind(storage),
        updateDefault: async (input, signal) => {
          entered();
          await gate;
          return storage.updateDefault(input, signal);
        },
      },
    );
    try {
      const result = service.analyze(
        request(env.manifest, { default_update: { expected_revision: null } }),
        stop.signal,
      );
      await pending;
      stop.abort();
      release();
      const receipt = await result;
      expect(receipt).toMatchObject({
        default_update_outcome: "cancelled",
        default_updated: false,
        default_revision: null,
      });
      expect(
        await storage.default(
          literatureId,
          "overview",
          await sha256(new TextEncoder().encode("")),
        ),
      ).toBeNull();
    } finally {
      release();
      await service.close();
      fake.agent.close();
      await env.close();
    }
  });
  it("preserves safe AgentFailure reasons and rejects malformed not-applicable responses", async () => {
    const env = await environment();
    const storage = new SqliteKnowledgeStorage(
      env.app.database,
      env.app.files,
      env.app.documentRead,
    );
    try {
      for (const [reason, retryable] of [
        ["agent-auth", false],
        ["agent-quota", true],
        ["agent-refusal", false],
        ["agent-truncated", false],
        ["agent-cancelled", false],
      ] as const) {
        const fake = runtime({ failure: new AgentFailure(reason, retryable) });
        const service = new KnowledgeAnalysisService(
          env.app.documentRead,
          fake.agent,
          storage,
        );
        try {
          await expect(
            service.analyze(request(env.manifest)),
          ).rejects.toMatchObject({
            code: "knowledge-model-failed",
            reason,
            retryable,
            cause: expect.any(AgentFailure),
          });
        } finally {
          await service.close();
          fake.agent.close();
        }
      }
      const fake = runtime({
        response: {
          outcome: "not_applicable",
          title: "wrong",
          statements: [{ invalid: true }],
        },
      });
      const service = new KnowledgeAnalysisService(
        env.app.documentRead,
        fake.agent,
        storage,
      );
      try {
        await expect(
          service.analyze(request(env.manifest)),
        ).rejects.toMatchObject({ code: "knowledge-response" });
      } finally {
        await service.close();
        fake.agent.close();
      }
    } finally {
      await env.close();
    }
  });
  it("keeps Document, Extraction, Retrieval and legacy cleanup protection usable on v6", async () => {
    const env = await environment();
    const query = await createQueryApplication(env.home);
    try {
      const current = await query.documentRead!.default({
        literature_id: literatureId,
        asset_id: env.asset.asset_id,
        asset_sha256: env.asset.sha256,
      });
      expect(current.default?.document_version_id).toBe(
        env.first.document.document_version_id,
      );
      const specContent = {
        schema_version: 1 as const,
        spec_id: "synthetic.v6",
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
      const spec = {
        ...specContent,
        spec_sha256: await extractionSpecHash(specContent),
      };
      const prepared = await query.extractionPreparation!.prepare({
        spec,
        inputs: [
          {
            input_id: "source-1",
            literature_id: literatureId,
            asset_id: env.asset.asset_id,
            asset_sha256: env.asset.sha256,
            document_version_id: null,
          },
        ],
      });
      expect(prepared.manifest.items[0]?.material?.asset_id).toBe(
        env.asset.asset_id,
      );
      const operation = await env.app.extractionDelivery.create({
        caller_id: "local.synthetic",
        spec: prepared.spec,
        manifest: prepared.manifest,
      });
      expect(operation.status).toBe("open");
      expect(
        (await env.app.database.inspectExecutionRuntime()).catalog_version,
      ).toBe(6);
      const index = new RetrievalIndexService(
        new RetrievalStorageClient(env.app.database),
        env.app.documentRead,
        env.app.library,
        env.app.writes,
      );
      const generation = await index.build();
      await index.close();
      expect(generation.entry_count).toBeGreaterThan(0);
      const context = await query.context!.search({
        query: "measurement",
        scope: { kind: "literatures", literature_ids: [literatureId] },
        kinds: ["document"],
        versions: { kind: "default" },
        budget: { max_items: 10, max_bytes: 16384, token_limit: null },
        continuation: null,
      });
      expect(context.items.length).toBeGreaterThan(0);
      expect(
        await env.app.database.contentCleanupSnapshot(literatureId),
      ).toBeNull();
      const retired = {
        reference: env.asset.path,
        artifact: {
          sha256: env.asset.sha256,
          byte_size: env.asset.size_bytes,
          media_type: "application/pdf",
        },
      };
      expect(
        (await env.app.artifactReclaimer.reclaim([retired])).preserved,
      ).toContain(env.asset.path);
      expect(
        (
          await query.documentRead!.default({
            literature_id: literatureId,
            asset_id: env.asset.asset_id,
            asset_sha256: env.asset.sha256,
          })
        ).default,
      ).not.toBeNull();
      await env.reparse();
    } finally {
      await query.close();
      await env.close();
    }
  });
  it("publishes from the maintenance page and reads statements and evidence by ID in the query page", async () => {
    const env = await environment(
      `# Synthetic result\n${"A".repeat(64000)} measurement was 4.2 eV under dry conditions.\n${"B".repeat(64000)} Limitations remain.\n`,
    );
    const behavior: { failure: AgentFailure | undefined } = {
      failure: undefined,
    };
    const fake = runtime(behavior);
    const storage = new SqliteKnowledgeStorage(
      env.app.database,
      env.app.files,
      env.app.documentRead,
    );
    const service = new KnowledgeAnalysisService(
      env.app.documentRead,
      fake.agent,
      storage,
    );
    const longFake = longRuntime();
    const longService = new KnowledgeAnalysisService(
      env.app.documentRead,
      longFake.agent,
      storage,
    );
    const query = await createQueryApplication(env.home);
    expect(env.app.maintenance).not.toBeNull();
    const assets = await reactWorkbenchAssets("maintenance");
    const http = await startQueryOnlyHttp({
      application: query,
      assets,
      maintenance: {
        ...env.app.maintenance!,
        analyze: service.analyze.bind(service),
        analyzeLong: longService.analyzeLong.bind(longService),
      },
    });
    const browser = await chromium.launch({
      executablePath:
        process.env.SCIRETRIEVER_BROWSER_EXECUTABLE ??
        chromium.executablePath(),
      headless: true,
    });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(10000);
      await page.goto(`${http.origin}/?view=set`);
      await page
        .getByRole("textbox", { name: "文献编号", exact: true })
        .fill(literatureId);
      await page.getByText("更新默认总结视图", { exact: true }).click();
      const start = async () => {
        await page
          .getByRole("button", { name: "启动单篇分析", exact: true })
          .click();
        await page
          .getByRole("dialog", { name: "启动 DSH 分析？", exact: true })
          .getByRole("button", { name: "启动分析", exact: true })
          .click();
      };
      await start();
      await expect
        .poll(() => page.locator(".maintenance-output").innerText(), {
          timeout: 10000,
        })
        .toContain("默认视图 revision 1");
      await page
        .locator(".maintenance-output")
        .getByRole("button", { name: "技术详情", exact: true })
        .click();
      expect(
        await page.locator(".maintenance-output pre").innerText(),
      ).toContain("4.2 eV under dry conditions");
      const artifactId = (
        JSON.parse(
          await page.locator(".maintenance-output pre").innerText(),
        ) as { artifact: { artifact_id: string } }
      ).artifact.artifact_id;
      expect(fake.calls).toHaveLength(1);
      const cookie = (await page.context().cookies())
        .map((item) => `${item.name}=${item.value}`)
        .join("; ");
      const grantResponse = await fetch(
        `${http.origin}/api/v1/maintenance/session`,
        { headers: { cookie } },
      );
      const grant = (await grantResponse.json()) as { csrf: string };
      const analyze = (value: unknown) =>
        fetch(`${http.origin}/api/v1/maintenance/analyze-knowledge`, {
          method: "POST",
          headers: {
            origin: http.origin,
            cookie,
            "content-type": "application/json",
            "x-sciretriever-protocol-version": "1",
            "x-sciretriever-csrf": grant.csrf,
          },
          body: JSON.stringify({ protocol_version: 1, request: value }),
        });
      const sensitive = "PRIVATE_PROVIDER_BODY_9147";
      const auth = new AgentFailure("agent-auth");
      Object.defineProperty(auth, "cause", { value: new Error(sensitive) });
      behavior.failure = auth;
      const authResponse = await analyze(
        request(env.manifest, {
          purpose: "detailed",
          budget: { max_input_bytes: 256 * 1024, max_output_tokens: 2048 },
        }),
      );
      expect(authResponse.status).toBe(503);
      expect(await authResponse.json()).toEqual({
        protocol_version: 1,
        code: "knowledge-model-failed",
        reason: "agent-auth",
        retryable: false,
      });
      behavior.failure = new AgentFailure("agent-quota", true);
      const quotaResponse = await analyze(
        request(env.manifest, {
          purpose: "question",
          question: "What was measured?",
          budget: { max_input_bytes: 256 * 1024, max_output_tokens: 2048 },
        }),
      );
      expect(quotaResponse.status).toBe(503);
      const quotaBody = await quotaResponse.text();
      expect(JSON.parse(quotaBody)).toEqual({
        protocol_version: 1,
        code: "knowledge-model-failed",
        reason: "agent-quota",
        retryable: true,
      });
      expect(quotaBody).not.toContain(sensitive);
      await page.getByRole("button", { name: /总结用途/ }).click();
      await page.getByRole("option", { name: "详细分析", exact: true }).click();
      await start();
      await expect
        .poll(() =>
          page.getByRole("dialog", { name: "启动 DSH 分析？" }).innerText(),
        )
        .toContain("agent-quota");
      expect(await page.locator("main").innerText()).not.toContain(sensitive);
      behavior.failure = undefined;
      const summaryUrl = `${http.origin}/query?literature=${literatureId}&reader=know&knowledge=${artifactId}`;
      await page.goto(summaryUrl);
      await expect
        .poll(() => page.locator(".reader-summary").innerText())
        .toContain("4.2 eV under dry conditions");
      await page
        .getByRole("button", { name: "[1]", exact: true })
        .first()
        .click();
      await expect
        .poll(() =>
          page.locator(".reader-evidence-preview blockquote").innerText(),
        )
        .toContain("measurement");
      await page.route("**/api/v1/query/evidence-resolve", async (route) => {
        const envelope = route.request().postDataJSON() as { request: unknown };
        const actual = await query.documentRead!.resolveEvidence(
          envelope.request,
        );
        if (actual.evidence.target_kind !== "document")
          throw new Error("unexpected material evidence");
        await route.fulfill({
          status: 200,
          json: {
            protocol_version: 1,
            result: {
              ...actual,
              evidence: { ...actual.evidence, content_sha256: "f".repeat(64) },
            },
          },
        });
      });
      await page.reload();
      await page
        .getByRole("button", { name: "[1]", exact: true })
        .first()
        .click();
      await expect
        .poll(() => page.locator(".reader-evidence-preview").innerText())
        .toMatch(/invalid|失败|无法|validation failed/);
      expect(
        await page.locator(".reader-evidence-preview blockquote").count(),
      ).toBe(0);
      await page.unroute("**/api/v1/query/evidence-resolve");
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let listRequests = 0;
      await page.route("**/api/v1/query/knowledge-list", async (route) => {
        listRequests++;
        if (listRequests === 1) await held;
        await route.continue().catch(() => undefined);
      });
      const listUrl = `${http.origin}/query?literature=${literatureId}&reader=know`;
      await page.goto(listUrl);
      await expect.poll(() => listRequests).toBe(1);
      await page
        .getByRole("navigation", { name: "工作区与阅读标签" })
        .getByRole("button", { name: "文献库", exact: true })
        .click();
      await page.goto(listUrl);
      await expect
        .poll(() => page.locator(".reader-summary").innerText())
        .toContain("4.2 eV under dry conditions");
      release();
      await page.unroute("**/api/v1/query/knowledge-list");
      expect(artifactId).toMatch(/^[0-9a-f-]{36}$/);
      await page.route("**/api/v1/query/knowledge-read", async (route) => {
        const existing = await query.knowledgeRead!.byId(artifactId);
        await route.fulfill({
          status: 200,
          json: {
            protocol_version: 1,
            result: { ...existing, artifact_id: id(999) },
          },
        });
      });
      await page.goto(summaryUrl);
      await expect
        .poll(() => page.locator("main").innerText(), { timeout: 10000 })
        .toMatch(/invalid|失败|无法|validation failed/);
      expect(await page.locator(".reader-summary").count()).toBe(0);
      expect(await page.locator("main").innerText()).not.toContain(id(999));
      await page.unroute("**/api/v1/query/knowledge-read");
      await page.goto(`${http.origin}/?view=set`);
      await page
        .getByRole("textbox", { name: "文献编号", exact: true })
        .fill(literatureId);
      await page.getByText("使用长文请求合同", { exact: true }).click();
      expect(await page.getByLabel("单次输入预算").count()).toBe(0);
      await start();
      await expect
        .poll(() => page.locator(".maintenance-output").innerText())
        .toContain("已存在");
      await page
        .locator(".maintenance-output")
        .getByRole("button", { name: "技术详情", exact: true })
        .click();
      expect(
        await page.locator(".maintenance-output pre").innerText(),
      ).toContain("4.2 eV under dry conditions");
      expect(longFake.calls).toHaveLength(0);
      await page.goto(listUrl);
      await expect
        .poll(() => page.locator(".reader-summary").innerText())
        .toContain("4.2 eV under dry conditions");
      expect(await query.knowledgeRead!.list(literatureId)).toHaveLength(1);
    } finally {
      await browser.close();
      await http.close();
      await query.close();
      await service.close();
      await longService.close();
      fake.agent.close();
      longFake.agent.close();
      await env.close();
    }
  }, 45_000);
  it("continues a long evidence segment to its end and rejects a misbound continuation", async () => {
    const source = `# Long finding\n${"A".repeat(70000)}TAIL_MARKER\n`;
    const env = await environment(source);
    const fake = runtime();
    const storage = new SqliteKnowledgeStorage(
      env.app.database,
      env.app.files,
      env.app.documentRead,
    );
    const service = new KnowledgeAnalysisService(
      env.app.documentRead,
      fake.agent,
      storage,
    );
    const query = await createQueryApplication(env.home);
    const assets = await reactWorkbenchAssets("query");
    const http = await startQueryOnlyHttp({ application: query, assets });
    const browser = await chromium.launch({
      executablePath:
        process.env.SCIRETRIEVER_BROWSER_EXECUTABLE ??
        chromium.executablePath(),
      headless: true,
    });
    try {
      const receipt = await service.analyze(
        request(env.manifest, {
          budget: { max_input_bytes: 200000, max_output_tokens: 2048 },
        }),
      );
      const page = await browser.newPage();
      page.setDefaultTimeout(10000);
      await page.goto(
        `${http.origin}/?literature=${literatureId}&reader=know&knowledge=${receipt.artifact.artifact_id}`,
      );
      await page
        .getByRole("button", { name: "[1]", exact: true })
        .first()
        .click();
      const entry = page.locator(".reader-evidence-preview");
      await expect.poll(() => entry.innerText()).toContain("部分");
      const firstText = await entry.locator("blockquote").textContent();
      expect(firstText?.length).toBe(65536);
      expect(firstText).not.toContain("TAIL_MARKER");
      await page.route("**/api/v1/query/evidence-resolve", async (route) => {
        const envelope = route.request().postDataJSON() as { request: unknown };
        const actual = await query.documentRead!.resolveEvidence(
          envelope.request,
        );
        if (
          actual.evidence.target_kind !== "document" ||
          actual.granularity !== "segment" ||
          !("actual_range" in actual) ||
          !("text" in actual)
        )
          throw new Error("unexpected evidence");
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            protocol_version: 1,
            result: {
              ...actual,
              actual_range: {
                ...actual.actual_range,
                start_utf8: actual.actual_range.start_utf8 + 1,
              },
              text: actual.text.slice(1),
            },
          }),
        });
      });
      await entry
        .getByRole("button", { name: "继续读取证据", exact: true })
        .click();
      await expect
        .poll(() => entry.innerText())
        .toContain("证据续读范围不连续");
      expect(await entry.locator("blockquote").textContent()).toBe(firstText);
      await page.unroute("**/api/v1/query/evidence-resolve");
      await entry
        .getByRole("button", { name: "继续读取证据", exact: true })
        .click();
      await expect.poll(() => entry.innerText()).toContain("已读取完整证据");
      expect(await entry.locator("blockquote").textContent()).toContain(
        "TAIL_MARKER",
      );
      expect(
        await entry
          .getByRole("button", { name: "继续读取证据", exact: true })
          .count(),
      ).toBe(0);
      const fullEvidence = await entry.locator("blockquote").textContent();
      await entry
        .getByRole("button", { name: "在原文中核对", exact: true })
        .click();
      const location = new URL(page.url()).searchParams;
      expect(Number(location.get("end")) - Number(location.get("start"))).toBe(
        Buffer.byteLength(fullEvidence!),
      );
      await expect
        .poll(
          async () => ({
            containsTail: (
              await page.locator(".reading-evidence").allTextContents()
            ).some((text) => text.includes("TAIL_MARKER")),
            status: await page.locator(".reading-status").textContent(),
            url: page.url(),
          }),
          { timeout: 10000 },
        )
        .toMatchObject({ containsTail: true });
    } finally {
      await browser.close();
      await http.close();
      await query.close();
      await service.close();
      fake.agent.close();
      await env.close();
    }
  }, 30_000);
  it("uses the Application maintenance and query HTTP boundaries with strict request and response binding", async () => {
    const env = await environment();
    const fake = runtime();
    const storage = new SqliteKnowledgeStorage(
      env.app.database,
      env.app.files,
      env.app.documentRead,
    );
    const service = new KnowledgeAnalysisService(
      env.app.documentRead,
      fake.agent,
      storage,
    );
    const query = await createQueryApplication(env.home);
    const http = await startQueryOnlyHttp({
      application: query,
      maintenance: {
        ...env.app.maintenance!,
        analyze: service.analyze.bind(service),
      },
    });
    const send = (
      path: string,
      value: unknown,
      extra: Record<string, string> = {},
    ) =>
      fetch(`${http.origin}/api/v1/query/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...extra },
        body:
          typeof value === "string"
            ? value
            : JSON.stringify({ protocol_version: 1, request: value }),
      });
    try {
      const unauthorized = await fetch(
        `${http.origin}/api/v1/maintenance/analyze-knowledge`,
        {
          method: "POST",
          headers: { origin: http.origin, "content-type": "application/json" },
          body: JSON.stringify({
            protocol_version: 1,
            request: request(env.manifest),
          }),
        },
      );
      expect(unauthorized.status).toBe(403);
      const homeResponse = await fetch(http.origin);
      const cookie = homeResponse.headers.get("set-cookie")?.split(";")[0];
      expect(cookie).toBeTruthy();
      const grantResponse = await fetch(
        `${http.origin}/api/v1/maintenance/session`,
        { headers: { cookie: cookie! } },
      );
      expect(grantResponse.status).toBe(200);
      const grant = (await grantResponse.json()) as { csrf: string };
      const analyze = (value: unknown) =>
        fetch(`${http.origin}/api/v1/maintenance/analyze-knowledge`, {
          method: "POST",
          headers: {
            origin: http.origin,
            cookie: cookie!,
            "content-type": "application/json",
            "x-sciretriever-protocol-version": "1",
            "x-sciretriever-csrf": grant.csrf,
          },
          body: JSON.stringify({ protocol_version: 1, request: value }),
        });
      const response = await analyze(
        request(env.manifest, { default_update: { expected_revision: null } }),
      );
      expect(response.status).toBe(200);
      const result = (await response.json()) as {
        result: { artifact: { artifact_id: string }; default_revision: number };
      };
      expect(result.result.default_revision).toBe(1);
      const artifactId = result.result.artifact.artifact_id;
      const read = await send("knowledge-read", { artifact_id: artifactId });
      expect(read.status).toBe(200);
      expect(
        ((await read.json()) as { result: { artifact_id: string } }).result
          .artifact_id,
      ).toBe(artifactId);
      const list = await send("knowledge-list", {
        literature_id: literatureId,
        limit: 10,
      });
      expect(list.status).toBe(200);
      expect(
        (
          (await list.json()) as { result: { artifact_id: string }[] }
        ).result.map((item) => item.artifact_id),
      ).toEqual([artifactId]);
      const current = await send("knowledge-default", {
        literature_id: literatureId,
        purpose: "overview",
        question: null,
      });
      await query
        .knowledgeRead!.default(
          literatureId,
          "overview",
          await sha256(new TextEncoder().encode("")),
        )
        .catch((error: unknown) => {
          throw new Error("direct default: " + String(error), { cause: error });
        });
      expect(current.status, await current.clone().text()).toBe(200);
      expect(
        (
          (await current.json()) as {
            result: { revision: number; artifact: { artifact_id: string } };
          }
        ).result,
      ).toMatchObject({ revision: 1, artifact: { artifact_id: artifactId } });
      const duplicate = await send(
        "knowledge-read",
        '{"protocol_version":1,"request":{"artifact_id":"' +
          artifactId +
          '","artifact_id":"' +
          artifactId +
          '"}}',
      );
      expect(duplicate.status).toBe(400);
      const invalidQuestion = await send("knowledge-default", {
        literature_id: literatureId,
        purpose: "question",
        question: "\u0000",
      });
      expect(invalidQuestion.status).toBe(400);
      const noModel = await env.app.knowledgeAnalysis
        .analyze(request(env.manifest))
        .catch((error: unknown) => error);
      expect(noModel).toMatchObject({ code: "knowledge-unconfigured" });
      expect(fake.calls).toHaveLength(1);
    } finally {
      await http.close();
      await query.close();
      await service.close();
      fake.agent.close();
      await env.close();
    }
  });
  it("publishes an exact artifact, reads it through query-only, reuses by method and preserves historical input", async () => {
    const env = await environment();
    const fake = runtime();
    const storage = new SqliteKnowledgeStorage(
      env.app.database,
      env.app.files,
      env.app.documentRead,
    );
    const service = new KnowledgeAnalysisService(
      env.app.documentRead,
      fake.agent,
      storage,
    );
    try {
      const first = await service.analyze(request(env.manifest));
      expect(first).toMatchObject({
        published: true,
        default_updated: false,
        artifact: { purpose: "overview", coverage: { status: "complete" } },
      });
      const content = first.artifact.content_ref;
      expect(await env.app.database.locateArtifact(content)).toMatchObject({
        reference: `knowledge/summaries/${content.sha256.slice(0, 2)}/${content.sha256}.json`,
      });
      expect(first.artifact.content.statements[0]?.evidence[0]).toMatchObject({
        target_kind: "document",
        document_version_id: env.first.document.document_version_id,
      });
      const again = await service.analyze(request(env.manifest));
      expect(again).toMatchObject({
        published: false,
        artifact: { artifact_id: first.artifact.artifact_id },
      });
      expect(again.artifact.provenance).toEqual(first.artifact.provenance);
      expect(fake.calls).toHaveLength(1);
      const query = await createQueryApplication(env.home);
      try {
        expect(query.knowledgeRead).not.toBeNull();
        expect(
          await query.knowledgeRead!.byId(first.artifact.artifact_id),
        ).toEqual(first.artifact);
        expect(await query.knowledgeRead!.list(literatureId)).toHaveLength(1);
      } finally {
        await query.close();
      }
      await env.reparse();
      const historic = await service.analyze(
        request(env.manifest, {
          purpose: "question",
          question: "What was measured?",
        }),
      );
      expect(historic.artifact.input.manifest_sha256).toBe(
        env.manifest.manifest_sha256,
      );
      expect(historic.artifact.artifact_id).not.toBe(
        first.artifact.artifact_id,
      );
      expect(fake.calls).toHaveLength(2);
    } finally {
      await service.close();
      fake.agent.close();
      await env.close();
    }
  });

  it("preserves populated v6 knowledge on v7 and publishes a fixed partial synthesis without weakening the old reader", async () => {
    const env = await environment();
    const fake = runtime();
    const v6Storage = new SqliteKnowledgeStorage(
      env.app.database,
      env.app.files,
      env.app.documentRead,
    );
    const v6Service = new KnowledgeAnalysisService(
      env.app.documentRead,
      fake.agent,
      v6Storage,
    );
    let v7app: Application | undefined;
    let secondAgent: ReturnType<typeof runtime> | undefined;
    try {
      const previous = await v6Service.analyze(
        request(env.manifest, { default_update: { expected_revision: null } }),
      );
      const secondLiteratureId = id(901);
      await env.app.database.putLiterature(
        parseLiterature({
          ...FIXTURE_LITERATURE,
          literature_id: secondLiteratureId,
          meta_literature_id: id(902),
          metadata: {
            ...FIXTURE_LITERATURE.metadata,
            identifiers: [
              { namespace: "doi", value: "10.5555/sciretriever.second" },
            ],
          },
        }),
      );
      const secondPdf = workbenchPdf("10.5555/sciretriever.second");
      const secondStage = await env.app.files.stage();
      try {
        await secondStage.write(secondPdf);
        await env.app.files.publish(
          secondStage,
          "objects/knowledge-second.pdf",
        );
      } finally {
        await secondStage.discard();
      }
      const secondAsset = parseAsset({
        asset_id: id(903),
        sha256: await sha256(secondPdf),
        size_bytes: secondPdf.length,
        media_type: "application/pdf",
        path: "objects/knowledge-second.pdf",
      });
      await env.app.database.putLiteratureAsset({
        literature_asset_id: id(904),
        literature_id: secondLiteratureId,
        asset: secondAsset,
        role: "primary-pdf",
        source_url: null,
        provenance: parseProvenance({
          provenance_id: id(905),
          source_kind: "asset-provider",
          source_name: "synthetic",
          source_record_id: null,
          observed_at: "2026-09-29T00:00:00Z",
          input_sha256: secondAsset.sha256,
          parameters_sha256: null,
        }),
      });
      const secondVersion = await env.app.documentProcessing.parseDocuments({
        literature_id: secondLiteratureId,
        asset_id: secondAsset.asset_id,
        asset_sha256: secondAsset.sha256,
        mode: "reparse",
        expected_default_revision: null,
      });
      const secondMaterial = await env.app.documentRead.materialEvidence({
        literature_id: secondLiteratureId,
        asset_id: secondAsset.asset_id,
      });
      if (secondMaterial.evidence.target_kind !== "material")
        throw new Error("invalid second material");
      const secondDescription = await env.app.documentRead.describe({
        document_version_id: secondVersion.document.document_version_id,
      });
      const secondManifest = await createInputManifest([
        {
          input_id: "paper-2",
          literature_id: secondLiteratureId,
          material: secondMaterial.evidence.material,
          document: secondDescription.document,
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
      const secondKnowledge = await v6Service.analyze(request(secondManifest));
      const catalog = join(env.home, "catalog.sqlite");
      const snapshot = (path = catalog) => {
        const db = new DatabaseSync(path, { readOnly: true });
        try {
          return Object.fromEntries(
            [
              "knowledge_artifacts",
              "knowledge_input_materials",
              "knowledge_input_documents",
              "knowledge_input_artifacts",
              "knowledge_defaults",
              "artifact_objects",
            ].map((table) => [
              table,
              db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
            ]),
          );
        } finally {
          db.close();
        }
      };
      const before = snapshot();
      await v6Service.close();
      fake.agent.close();
      await env.app.close();
      await migrateSynthesisCatalog({
        catalog_path: catalog,
        backup_path: join(env.home, "before-v7.sqlite"),
      });
      expect(snapshot()).toEqual(before);
      expect(snapshot(join(env.home, "before-v7.sqlite"))).toEqual(before);
      v7app = await createApplication(env.home, {
        executionSchema: "require-v2",
      });
      const old = new SqliteKnowledgeStorage(
        v7app.database,
        v7app.files,
        v7app.documentRead,
      );
      expect(await old.byId(previous.artifact.artifact_id)).toEqual(
        previous.artifact,
      );
      expect(
        (await old.list(literatureId)).map((item) => item.artifact_id),
      ).toEqual([previous.artifact.artifact_id]);
      expect(
        await old.default(
          literatureId,
          "overview",
          await sha256(new TextEncoder().encode("")),
        ),
      ).toEqual({
        artifact_id: previous.artifact.artifact_id,
        revision: 1,
      });
      secondAgent = runtime();
      const oldService = new KnowledgeAnalysisService(
        v7app.documentRead,
        secondAgent.agent,
        old,
      );
      let sameLiteratureId = "";
      try {
        const newSingle = await oldService.analyze(
          request(env.manifest, {
            purpose: "question",
            question: "Which conditions?",
          }),
        );
        expect(newSingle.published).toBe(true);
        sameLiteratureId = newSingle.artifact.artifact_id;
      } finally {
        await oldService.close();
      }
      const longFake = longRuntime();
      const longService = new KnowledgeAnalysisService(
        v7app.documentRead,
        longFake.agent,
        old,
      );
      try {
        const long = await longService.analyzeLong(
          longRequest(env.manifest, { purpose: "detailed" }),
        );
        expect(long.published).toBe(true);
        expect(await old.byId(long.artifact.artifact_id)).toEqual(
          long.artifact,
        );
      } finally {
        await longService.close();
        longFake.agent.close();
      }
      const synth = new SqliteSynthesisStorage(
        v7app.database,
        v7app.files,
        v7app.documentRead,
      );
      const prepare = new SynthesisPreparationService(
        v7app.documentRead,
        v7app.library,
        synth,
      );
      const repeatedDocument = (inputId: string) => ({
        kind: "document" as const,
        input_id: inputId,
        literature_id: literatureId,
        asset_id: env.asset.asset_id,
        asset_sha256: env.asset.sha256,
        document_version_id:
          env.manifest.items[0]!.document!.document_version_id,
      });
      const originalVerifiedVersion =
        v7app.documentRead.withVerifiedVersion.bind(v7app.documentRead);
      let verifiedVersions = 0;
      v7app.documentRead.withVerifiedVersion = <T>(
        versionId: string,
        consume: Parameters<typeof originalVerifiedVersion<T>>[1],
        signal?: AbortSignal,
      ): Promise<T> => {
        verifiedVersions++;
        return originalVerifiedVersion(versionId, consume, signal);
      };
      try {
        await expect(
          prepare.prepare(
            {
              policy: "require-all",
              inputs: [repeatedDocument("doc-small")],
            },
            undefined,
            1,
          ),
        ).rejects.toMatchObject({ code: "synthesis-limit" });
        expect(verifiedVersions).toBe(0);
        const repeated = await prepare.prepare({
          policy: "require-all",
          inputs: [repeatedDocument("doc-a"), repeatedDocument("doc-b")],
        });
        expect(repeated.ready).toBe(true);
        expect(verifiedVersions).toBe(1);
        expect(repeated.manifest.items[0]).toMatchObject({
          literature_id: literatureId,
          material: {
            asset_id: env.asset.asset_id,
            asset_sha256: env.asset.sha256,
          },
          document: {
            document_version_id:
              env.manifest.items[0]!.document!.document_version_id,
          },
        });
        const firstDocument = repeated.manifest.items[0]!;
        if (firstDocument.kind !== "document")
          throw new Error("document expected");
        expect(repeated.manifest.items[1]).toMatchObject({
          material: firstDocument.material,
          document: firstDocument.document,
        });
      } finally {
        v7app.documentRead.withVerifiedVersion = originalVerifiedVersion;
      }
      const selections = [
        {
          kind: "knowledge",
          input_id: "source-1",
          source_artifact_id: previous.artifact.artifact_id,
        },
        {
          kind: "knowledge",
          input_id: "missing-2",
          source_artifact_id: id(999),
        },
      ];
      const strict = await prepare.prepare({
        policy: "require-all",
        inputs: selections,
      });
      expect(strict).toMatchObject({
        ready: false,
        gaps: [{ input_id: "missing-2", code: "knowledge-missing" }],
      });
      const partial = await prepare.prepare({
        policy: "allow-partial",
        inputs: selections,
      });
      expect(partial.ready).toBe(true);
      const mutableSelections = [
        {
          kind: "knowledge",
          input_id: "fixed-source",
          source_artifact_id: previous.artifact.artifact_id,
        },
      ];
      const preparing = prepare.prepare({
        policy: "require-all",
        inputs: mutableSelections,
      });
      mutableSelections[0]!.source_artifact_id = id(9999);
      mutableSelections.push({
        kind: "knowledge",
        input_id: "late-source",
        source_artifact_id: id(9999),
      });
      expect((await preparing).manifest.items).toMatchObject([
        {
          input_id: "fixed-source",
          source_artifact_id: previous.artifact.artifact_id,
        },
      ]);
      const sourceStatement = previous.artifact.content.statements[0]!;
      const content = {
        schema_version: 2 as const,
        title: "Synthetic comparison",
        statements: [
          {
            statement_id: "synthesis-1",
            category: sourceStatement.category,
            epistemic: sourceStatement.epistemic,
            relation: "single-source" as const,
            conflict_group_id: null,
            text: sourceStatement.text,
            conditions: sourceStatement.conditions,
            quantity: sourceStatement.quantity,
            evidence: [
              {
                input_id: "source-1",
                target_kind: "knowledge" as const,
                source_artifact_id: previous.artifact.artifact_id,
                source_content_sha256: previous.artifact.content_ref.sha256,
                statement_id: sourceStatement.statement_id,
                statement_sha256: await sha256(
                  extractionCanonicalJsonBytes(sourceStatement, 64 * 1024),
                ),
              },
            ],
          },
        ],
      };
      const method = {
        id: "synthetic-synthesis",
        version: "1",
        parameters_sha256: "a".repeat(64),
        model_binding_sha256: "b".repeat(64),
      };
      const comparison = await synthesisComparisonSha256({
        manifest_sha256: partial.manifest.manifest_sha256,
        question: "Which conditions?",
        policy: "allow-partial",
        method,
      });
      const bytes = synthesisContentBytes(content);
      const artifact = {
        schema_version: 2 as const,
        artifact_id: `${comparison.slice(0, 8)}-${comparison.slice(8, 12)}-${comparison.slice(12, 16)}-${comparison.slice(16, 20)}-${comparison.slice(20, 32)}`,
        comparison_sha256: comparison,
        purpose: "synthesis" as const,
        question: "Which conditions?",
        input: partial.manifest,
        method,
        content_ref: {
          sha256: await sha256(bytes),
          byte_size: bytes.length,
          media_type: "application/vnd.sciretriever.knowledge+json",
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
      const competingContent = { ...content, title: "Competing result" };
      const competingBytes = synthesisContentBytes(competingContent);
      const competing = {
        ...artifact,
        content: competingContent,
        content_ref: {
          ...artifact.content_ref,
          sha256: await sha256(competingBytes),
          byte_size: competingBytes.length,
        },
        provenance: { ...artifact.provenance, model: "competing" },
      };
      const outcomes = await Promise.all([
        synth.publish(artifact),
        synth.publish(competing),
      ]);
      expect(outcomes.filter((item) => item.published)).toHaveLength(1);
      expect(outcomes[0]?.artifact).toEqual(outcomes[1]?.artifact);
      const published = outcomes[0]!;
      const consensusArtifact = async (otherId: string) => {
        const fixed = await prepare.prepare({
          policy: "require-all",
          inputs: [
            {
              kind: "knowledge",
              input_id: "first",
              source_artifact_id: previous.artifact.artifact_id,
            },
            {
              kind: "knowledge",
              input_id: "second",
              source_artifact_id: otherId,
            },
          ],
        });
        expect(fixed.ready).toBe(true);
        const other = await synth.sourceById(otherId);
        if (!other) throw new Error("missing second source");
        const firstStatement = previous.artifact.content.statements[0]!;
        const otherStatement = other.artifact.content.statements[0]!;
        const consensusContent = {
          schema_version: 2 as const,
          title: "Two inputs",
          statements: [
            {
              ...content.statements[0]!,
              relation: "consensus" as const,
              evidence: [
                {
                  input_id: "first",
                  target_kind: "knowledge" as const,
                  source_artifact_id: previous.artifact.artifact_id,
                  source_content_sha256: previous.artifact.content_ref.sha256,
                  statement_id: firstStatement.statement_id,
                  statement_sha256: await sha256(
                    extractionCanonicalJsonBytes(firstStatement, 64 * 1024),
                  ),
                },
                {
                  input_id: "second",
                  target_kind: "knowledge" as const,
                  source_artifact_id: other.artifact.artifact_id,
                  source_content_sha256: other.artifact.content_ref.sha256,
                  statement_id: otherStatement.statement_id,
                  statement_sha256: await sha256(
                    extractionCanonicalJsonBytes(otherStatement, 64 * 1024),
                  ),
                },
              ],
            },
          ],
        };
        const consensusBytes = synthesisContentBytes(consensusContent);
        const hash = await synthesisComparisonSha256({
          manifest_sha256: fixed.manifest.manifest_sha256,
          question: artifact.question,
          policy: "require-all",
          method,
        });
        return parseSynthesisArtifact({
          ...artifact,
          input: fixed.manifest,
          comparison_sha256: hash,
          artifact_id: `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`,
          content: consensusContent,
          content_ref: {
            ...artifact.content_ref,
            sha256: await sha256(consensusBytes),
            byte_size: consensusBytes.length,
          },
          coverage: {
            schema_version: 2,
            status: "complete",
            policy: "require-all",
            unique_literature_count: otherId === sameLiteratureId ? 1 : 2,
            items: [
              { input_id: "first", status: "included", reason: null },
              { input_id: "second", status: "included", reason: null },
            ],
          },
          compression_depth: 2,
        });
      };
      const samePaper = await synth.publish(
        await consensusArtifact(sameLiteratureId),
      );
      expect(
        (await synth.byId(samePaper.artifact.artifact_id))
          ?.independent_literature_ids,
      ).toEqual([literatureId]);
      const realConsensus = await synth.publish(
        await consensusArtifact(secondKnowledge.artifact.artifact_id),
      );
      expect(
        (await synth.byId(realConsensus.artifact.artifact_id))
          ?.independent_literature_ids,
      ).toEqual([literatureId, secondLiteratureId]);
      const largeItems = Array.from({ length: 128 }, (_, n) => ({
        kind: "knowledge" as const,
        input_id: `i${String(n).padStart(3, "0")}${"a".repeat(123)}`,
        source_artifact_id: previous.artifact.artifact_id,
        source_content_sha256: previous.artifact.content_ref.sha256,
        source_manifest_sha256: previous.artifact.input.manifest_sha256,
        compression_depth: 1,
        state: "verified" as const,
      }));
      const largeManifest = await createSynthesisInputManifest(largeItems);
      const largeEvidenceHash = await synthesisStatementSha256(
        previous.artifact.content.statements[0]!,
      );
      const largeStatement = {
        ...content.statements[0]!,
        statement_id: "large-1",
        relation: "single-source" as const,
        text: "x".repeat(4096),
        conditions: Array(8).fill("y".repeat(1024)) as string[],
        evidence: largeItems.map((item) => ({
          input_id: item.input_id,
          target_kind: "knowledge" as const,
          source_artifact_id: item.source_artifact_id,
          source_content_sha256: item.source_content_sha256,
          statement_id: previous.artifact.content.statements[0]!.statement_id,
          statement_sha256: largeEvidenceHash,
        })),
      };
      expect(Buffer.byteLength(JSON.stringify(largeStatement))).toBeGreaterThan(
        64 * 1024,
      );
      const largeContent = {
        schema_version: 2 as const,
        title: "Large statement",
        statements: [largeStatement],
      };
      const largeBytes = synthesisContentBytes(largeContent);
      const largeComparison = await synthesisComparisonSha256({
        manifest_sha256: largeManifest.manifest_sha256,
        question: "Large statement?",
        policy: "require-all",
        method,
      });
      const largeArtifact = await parseSynthesisArtifact({
        ...artifact,
        input: largeManifest,
        comparison_sha256: largeComparison,
        artifact_id: `${largeComparison.slice(0, 8)}-${largeComparison.slice(8, 12)}-${largeComparison.slice(12, 16)}-${largeComparison.slice(16, 20)}-${largeComparison.slice(20, 32)}`,
        question: "Large statement?",
        content: largeContent,
        content_ref: {
          ...artifact.content_ref,
          sha256: await sha256(largeBytes),
          byte_size: largeBytes.length,
        },
        coverage: {
          schema_version: 2,
          status: "complete",
          policy: "require-all",
          unique_literature_count: 1,
          items: largeItems.map((item) => ({
            input_id: item.input_id,
            status: "included",
            reason: null,
          })),
        },
        compression_depth: 2,
      });
      expect((await synth.publish(largeArtifact)).published).toBe(true);
      const nestedManifest = await createSynthesisInputManifest([
        {
          kind: "knowledge",
          input_id: "large-source",
          source_artifact_id: largeArtifact.artifact_id,
          source_content_sha256: largeArtifact.content_ref.sha256,
          source_manifest_sha256: largeManifest.manifest_sha256,
          compression_depth: 2,
          state: "verified",
        },
      ]);
      const nestedContent = {
        schema_version: 2 as const,
        title: "Nested large source",
        statements: [
          {
            ...content.statements[0]!,
            statement_id: "nested-1",
            relation: "single-source" as const,
            evidence: [
              {
                input_id: "large-source",
                target_kind: "knowledge" as const,
                source_artifact_id: largeArtifact.artifact_id,
                source_content_sha256: largeArtifact.content_ref.sha256,
                statement_id: largeStatement.statement_id,
                statement_sha256:
                  await synthesisStatementSha256(largeStatement),
              },
            ],
          },
        ],
      };
      const nestedBytes = synthesisContentBytes(nestedContent);
      const nestedComparison = await synthesisComparisonSha256({
        manifest_sha256: nestedManifest.manifest_sha256,
        question: "Nested large source?",
        policy: "require-all",
        method,
      });
      const nestedArtifact = await parseSynthesisArtifact({
        ...artifact,
        input: nestedManifest,
        comparison_sha256: nestedComparison,
        artifact_id: `${nestedComparison.slice(0, 8)}-${nestedComparison.slice(8, 12)}-${nestedComparison.slice(12, 16)}-${nestedComparison.slice(16, 20)}-${nestedComparison.slice(20, 32)}`,
        question: "Nested large source?",
        content: nestedContent,
        content_ref: {
          ...artifact.content_ref,
          sha256: await sha256(nestedBytes),
          byte_size: nestedBytes.length,
        },
        coverage: {
          schema_version: 2,
          status: "complete",
          policy: "require-all",
          unique_literature_count: 1,
          items: [
            { input_id: "large-source", status: "included", reason: null },
          ],
        },
        compression_depth: 3,
      });
      expect((await synth.publish(nestedArtifact)).published).toBe(true);
      expect(
        (await synth.byId(nestedArtifact.artifact_id))
          ?.independent_literature_ids,
      ).toEqual([literatureId]);
      // Seed valid immutable closures through the synthetic v7 SQL writer so
      // the reader's 32-level boundary is exercised without 29 repeated
      // high-level publications of the same source PDF.
      let deep = nestedArtifact;
      let depth31 = nestedArtifact;
      const deepIds = [
        previous.artifact.artifact_id,
        largeArtifact.artifact_id,
        nestedArtifact.artifact_id,
      ];
      for (let depth = 4; depth <= 32; depth++) {
        const prior = deep;
        const priorStatement = prior.content.statements[0]!;
        const input = await createSynthesisInputManifest([
          {
            kind: "knowledge",
            input_id: "prior",
            source_artifact_id: prior.artifact_id,
            source_content_sha256: prior.content_ref.sha256,
            source_manifest_sha256: prior.input.manifest_sha256,
            compression_depth: depth - 1,
            state: "verified",
          },
        ]);
        const deepContent = {
          schema_version: 2 as const,
          title: `Depth ${depth}`,
          statements: [
            {
              ...content.statements[0]!,
              statement_id: `depth-${depth}`,
              relation: "single-source" as const,
              evidence: [
                {
                  input_id: "prior",
                  target_kind: "knowledge" as const,
                  source_artifact_id: prior.artifact_id,
                  source_content_sha256: prior.content_ref.sha256,
                  statement_id: priorStatement.statement_id,
                  statement_sha256:
                    await synthesisStatementSha256(priorStatement),
                },
              ],
            },
          ],
        };
        const deepBytes = synthesisContentBytes(deepContent);
        const question = `Depth ${depth}?`;
        const hash = await synthesisComparisonSha256({
          manifest_sha256: input.manifest_sha256,
          question,
          policy: "require-all",
          method,
        });
        deep = await parseSynthesisArtifact({
          ...prior,
          artifact_id: `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`,
          comparison_sha256: hash,
          question,
          input,
          content: deepContent,
          content_ref: {
            ...prior.content_ref,
            sha256: await sha256(deepBytes),
            byte_size: deepBytes.length,
          },
          coverage: {
            schema_version: 2,
            status: "complete",
            policy: "require-all",
            unique_literature_count: 1,
            items: [{ input_id: "prior", status: "included", reason: null }],
          },
          compression_depth: depth,
        });
        const reference = `objects/${deep.content_ref.sha256}.bin`;
        const stage = await v7app.files.stage({ maxBytes: deepBytes.length });
        try {
          await stage.write(deepBytes);
          await v7app.files.publish(stage, reference);
        } finally {
          await stage.discard();
        }
        expect(
          await v7app.database.knowledge<{ published: boolean }>(
            "publish-synthesis",
            {
              artifact_id: deep.artifact_id,
              comparison_sha256: deep.comparison_sha256,
              scope_kind: "manifest",
              scope_key: input.manifest_sha256,
              purpose: "synthesis",
              question_sha256: await sha256(new TextEncoder().encode(question)),
              question_text: question,
              manifest_sha256: input.manifest_sha256,
              manifest_json: JSON.stringify(input),
              method_id: method.id,
              method_version: method.version,
              parameters_sha256: method.parameters_sha256,
              method_json: JSON.stringify(method),
              content_sha256: deep.content_ref.sha256,
              content_size: deep.content_ref.byte_size,
              content_media_type: deep.content_ref.media_type,
              content_reference: reference,
              coverage_json: JSON.stringify(deep.coverage),
              provenance_json: JSON.stringify(deep.provenance),
              created_at: deep.provenance.generated_at,
              input: {
                materials: [],
                documents: [],
                artifacts: [
                  {
                    input_id: "prior",
                    source_artifact_id: prior.artifact_id,
                    source_content_sha256: prior.content_ref.sha256,
                    source_manifest_sha256: prior.input.manifest_sha256,
                    compression_depth: depth - 1,
                  },
                ],
                missing_knowledge: [],
                missing_pdf_literatures: [],
                missing_documents: [],
              },
            },
          ),
        ).toMatchObject({ published: true });
        if (depth === 31) depth31 = deep;
        deepIds.push(deep.artifact_id);
      }
      expect(
        (await synth.byId(deep.artifact_id))?.artifact.compression_depth,
      ).toBe(32);
      const deepBudgetDb = new DatabaseSync(catalog, { readOnly: true });
      const deepRows = deepIds.map(
        (artifactId) =>
          deepBudgetDb
            .prepare(
              "SELECT scope_kind,content_size,manifest_json,coverage_json FROM knowledge_artifacts WHERE artifact_id=?",
            )
            .get(artifactId) as {
            scope_kind: string;
            content_size: number;
            manifest_json: string;
            coverage_json: string;
          },
      );
      deepBudgetDb.close();
      const deepDocument = (await v7app.database.documentVersion(
        env.manifest.items[0]!.document!.document_version_id,
      ))!.version;
      const deepBudget =
        deepRows[0]!.content_size +
        Buffer.byteLength(deepRows[0]!.manifest_json) +
        deepDocument.source_material_ref.byte_size +
        deepDocument.markdown.byte_size +
        deepDocument.structure.byte_size +
        deepDocument.resources.reduce(
          (sum, resource) => sum + resource.artifact.byte_size,
          0,
        ) +
        deepRows
          .slice(1)
          .reduce(
            (sum, row) =>
              sum +
              row.content_size +
              Buffer.byteLength(row.manifest_json) +
              Buffer.byteLength(row.coverage_json),
            0,
          );
      expect(
        (
          await synth.sourceBatchByIds(
            [depth31.artifact_id, deep.artifact_id],
            deepBudget,
          )
        ).size,
      ).toBe(2);
      await expect(
        synth.sourceBatchByIds([deep.artifact_id], deepBudget - 1),
      ).rejects.toMatchObject({ code: "synthesis-limit" });
      const level33Manifest = await createSynthesisInputManifest([
        {
          kind: "knowledge",
          input_id: "prior",
          source_artifact_id: deep.artifact_id,
          source_content_sha256: deep.content_ref.sha256,
          source_manifest_sha256: deep.input.manifest_sha256,
          compression_depth: 32,
          state: "verified",
        },
      ]);
      await expect(
        synth.publish({
          ...deep,
          input: level33Manifest,
          compression_depth: 33,
        }),
      ).rejects.toMatchObject({ code: "synthesis-invalid" });
      const corruptCycle = new DatabaseSync(catalog);
      corruptCycle.exec("PRAGMA foreign_keys=ON");
      // This creates a physical two-node loop. Immutable manifest/pin
      // consistency rejects it before recursive cycle detection is reached.
      corruptCycle
        .prepare(
          "UPDATE knowledge_input_artifacts SET source_artifact_id=?,source_content_sha256=?,compression_depth=32 WHERE artifact_id=? AND input_id='prior'",
        )
        .run(deep.artifact_id, deep.content_ref.sha256, depth31.artifact_id);
      corruptCycle.close();
      await expect(synth.sourceById(deep.artifact_id)).rejects.toMatchObject({
        code: "synthesis-integrity",
      });
      const variant = async (question: string, title: string) => {
        const variantContent = { ...nestedArtifact.content, title };
        const variantBytes = synthesisContentBytes(variantContent);
        const hash = await synthesisComparisonSha256({
          manifest_sha256: nestedManifest.manifest_sha256,
          question,
          policy: "require-all",
          method,
        });
        return parseSynthesisArtifact({
          ...nestedArtifact,
          question,
          content: variantContent,
          comparison_sha256: hash,
          artifact_id: `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`,
          content_ref: {
            ...nestedArtifact.content_ref,
            sha256: await sha256(variantBytes),
            byte_size: variantBytes.length,
          },
        });
      };
      const mutablePublished = structuredClone(
        await variant("Mutable request?", "Captured content"),
      );
      const publishingFixed = synth.publish(mutablePublished);
      (mutablePublished.content as { title: string }).title = "Changed later";
      expect((await publishingFixed).artifact.content.title).toBe(
        "Captured content",
      );
      const queuedArtifact = await variant(
        "Queued cancellation?",
        "Never publish queued bytes",
      );
      let releaseAdmission!: () => void;
      const admissionGate = new Promise<void>((resolve) => {
        releaseAdmission = resolve;
      });
      let enteredAdmission!: () => void;
      const admissionEntered = new Promise<void>((resolve) => {
        enteredAdmission = resolve;
      });
      const originalWithWrite = v7app.files.withWrite.bind(v7app.files);
      const heldAdmission = originalWithWrite(async () => {
        enteredAdmission();
        await admissionGate;
      });
      await admissionEntered;
      let reachedQueue!: () => void;
      const queued = new Promise<void>((resolve) => {
        reachedQueue = resolve;
      });
      v7app.files.withWrite = <T>(
        operation: () => Promise<T>,
        signal?: AbortSignal,
      ): Promise<T> => {
        if (signal) reachedQueue();
        return originalWithWrite(operation, signal);
      };
      const queuedStop = new AbortController();
      try {
        const pending = synth.publish(queuedArtifact, queuedStop.signal);
        await queued;
        queuedStop.abort();
        releaseAdmission();
        await heldAdmission;
        await expect(pending).rejects.toMatchObject({
          code: "synthesis-cancelled",
        });
        expect(
          checkAbsent(queuedArtifact.artifact_id).map((row) => row.n),
        ).toEqual([0, 0, 0, 0]);
      } finally {
        releaseAdmission();
        await heldAdmission;
        v7app.files.withWrite = originalWithWrite;
      }
      const committedArtifact = await variant(
        "Committed cancellation?",
        "Committed bytes stay published",
      );
      const committedStop = new AbortController();
      const originalKnowledge = v7app.database.knowledge.bind(v7app.database);
      v7app.database.knowledge = async <T>(
        action: Parameters<typeof originalKnowledge>[0],
        args: unknown,
        signal?: AbortSignal,
      ): Promise<T> => {
        const result = await originalKnowledge<T>(action, args, signal);
        if (
          action === "publish-synthesis" &&
          (args as { artifact_id?: string }).artifact_id ===
            committedArtifact.artifact_id
        )
          committedStop.abort();
        return result;
      };
      try {
        expect(
          (await synth.publish(committedArtifact, committedStop.signal))
            .published,
        ).toBe(true);
        expect(committedStop.signal.aborted).toBe(true);
        expect(
          (await synth.byId(committedArtifact.artifact_id))?.artifact,
        ).toEqual(committedArtifact);
      } finally {
        v7app.database.knowledge = originalKnowledge;
      }
      const forkPartial = async (
        input: typeof partial.manifest,
        excludedReason: "material-missing" | "document-missing",
      ) => {
        const hash = await synthesisComparisonSha256({
          manifest_sha256: input.manifest_sha256,
          question: artifact.question,
          policy: "allow-partial",
          method,
        });
        return parseSynthesisArtifact({
          ...artifact,
          input,
          comparison_sha256: hash,
          artifact_id: `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`,
          coverage: {
            ...artifact.coverage,
            items: [
              { input_id: "source-1", status: "included", reason: null },
              {
                input_id: input.items[1]!.input_id,
                status: "excluded",
                reason: excludedReason,
              },
            ],
          },
        });
      };
      const unknownManifest = await createSynthesisInputManifest([
        partial.manifest.items[0]!,
        {
          kind: "document",
          input_id: "unknown-doc",
          literature_id: id(9998),
          material: null,
          document: null,
          capabilities: [],
          gaps: ["material-missing", "document-missing"],
        },
      ]);
      const unknownArtifact = await forkPartial(
        unknownManifest,
        "material-missing",
      );
      await expect(synth.publish(unknownArtifact)).rejects.toMatchObject({
        code: "synthesis-integrity",
      });
      function checkAbsent(artifactId: string) {
        const db = new DatabaseSync(catalog, { readOnly: true });
        try {
          return [
            "knowledge_artifacts",
            "knowledge_input_materials",
            "knowledge_input_documents",
            "knowledge_input_artifacts",
          ].map(
            (table) =>
              db
                .prepare(
                  `SELECT COUNT(*) AS n FROM ${table} WHERE artifact_id=?`,
                )
                .get(artifactId) as { n: number },
          );
        } finally {
          db.close();
        }
      }
      expect(
        checkAbsent(unknownArtifact.artifact_id).map((row) => row.n),
      ).toEqual([0, 0, 0, 0]);
      const defaultDb = new DatabaseSync(catalog);
      const defaultRow = defaultDb
        .prepare(
          "SELECT document_id,document_version_id,revision FROM document_defaults",
        )
        .get() as {
        document_id: string;
        document_version_id: string;
        revision: number;
      };
      defaultDb
        .prepare("DELETE FROM document_defaults WHERE document_id=?")
        .run(defaultRow.document_id);
      defaultDb.close();
      const missingDefault = await prepare.prepare({
        policy: "allow-partial",
        inputs: [
          {
            kind: "knowledge",
            input_id: "source-1",
            source_artifact_id: previous.artifact.artifact_id,
          },
          {
            kind: "document",
            input_id: "doc-gap",
            literature_id: literatureId,
            asset_id: env.asset.asset_id,
            asset_sha256: env.asset.sha256,
            document_version_id: null,
          },
        ],
      });
      expect(missingDefault).toMatchObject({
        ready: true,
        gaps: [{ input_id: "doc-gap", code: "document-missing" }],
      });
      await expect(
        prepare.prepare({
          policy: "allow-partial",
          inputs: [
            {
              kind: "knowledge",
              input_id: "source-1",
              source_artifact_id: previous.artifact.artifact_id,
            },
            {
              kind: "document",
              input_id: "doc-gap",
              literature_id: literatureId,
              asset_id: env.asset.asset_id,
              asset_sha256: env.asset.sha256,
              document_version_id: id(9999),
            },
          ],
        }),
      ).rejects.toMatchObject({ code: "synthesis-stale-binding" });
      const staleArtifact = await forkPartial(
        missingDefault.manifest,
        "document-missing",
      );
      const restoreDefault = new DatabaseSync(catalog);
      restoreDefault
        .prepare(
          "INSERT INTO document_defaults(document_id,document_version_id,revision) VALUES(?,?,?)",
        )
        .run(
          defaultRow.document_id,
          defaultRow.document_version_id,
          defaultRow.revision,
        );
      restoreDefault.close();
      await expect(synth.publish(staleArtifact)).rejects.toMatchObject({
        code: "synthesis-integrity",
      });
      expect(
        checkAbsent(staleArtifact.artifact_id).map((row) => row.n),
      ).toEqual([0, 0, 0, 0]);
      const malformedIds: string[] = [];
      for (const kind of ["evidence", "coverage"] as const) {
        const wrongContent =
          kind === "evidence"
            ? parseKnowledgeContent({
                ...previous.artifact.content,
                statements: previous.artifact.content.statements.map(
                  (statement, index) =>
                    index === 0
                      ? {
                          ...statement,
                          evidence: statement.evidence.map(
                            (evidence, evidenceIndex) =>
                              evidenceIndex === 0
                                ? {
                                    ...evidence,
                                    content_sha256: "f".repeat(64),
                                  }
                                : evidence,
                          ),
                        }
                      : statement,
                ),
              })
            : previous.artifact.content;
        const wrongCoverage =
          kind === "coverage"
            ? {
                ...previous.artifact.coverage,
                total_segments: previous.artifact.coverage.total_segments + 1,
                covered_segments:
                  previous.artifact.coverage.covered_segments + 1,
              }
            : previous.artifact.coverage;
        const wrongMethod = {
          ...previous.artifact.method,
          id: `invalid-${kind}`,
        };
        const wrongComparison = await knowledgeComparisonSha256({
          manifest_sha256: previous.artifact.input.manifest_sha256,
          purpose: "overview",
          question: null,
          method: wrongMethod,
        });
        const wrongBytes = knowledgeContentBytes(wrongContent);
        const malformed = {
          ...previous.artifact,
          method: wrongMethod,
          content: wrongContent,
          coverage: wrongCoverage,
          comparison_sha256: wrongComparison,
          artifact_id: `${wrongComparison.slice(0, 8)}-${wrongComparison.slice(8, 12)}-${wrongComparison.slice(12, 16)}-${wrongComparison.slice(16, 20)}-${wrongComparison.slice(20, 32)}`,
          content_ref: {
            ...previous.artifact.content_ref,
            sha256: await sha256(wrongBytes),
            byte_size: wrongBytes.length,
          },
        };
        await expect(old.publish(malformed)).rejects.toThrow();
        malformedIds.push(malformed.artifact_id);
        await expect(
          synth.sourceById(malformed.artifact_id),
        ).rejects.toMatchObject({ code: "synthesis-integrity" });
      }
      const sourceRow = await v7app.database.knowledge<{
        row: { content_size: number; manifest_json: string };
      }>("id", previous.artifact.artifact_id);
      const sourceDoc = (await v7app.database.documentVersion(
        env.manifest.items[0]!.document!.document_version_id,
      ))!.version;
      const oneSourceBudget =
        sourceRow.row.content_size +
        Buffer.byteLength(sourceRow.row.manifest_json) +
        sourceDoc.source_material_ref.byte_size +
        sourceDoc.markdown.byte_size +
        sourceDoc.structure.byte_size +
        sourceDoc.resources.reduce(
          (sum, resource) => sum + resource.artifact.byte_size,
          0,
        );
      expect(
        (
          await synth.sourceBatchByIds(
            [previous.artifact.artifact_id, previous.artifact.artifact_id],
            oneSourceBudget,
          )
        ).size,
      ).toBe(1);
      const mutableIds = [previous.artifact.artifact_id];
      const fixedBatch = synth.sourceBatchByIds(mutableIds, oneSourceBudget);
      mutableIds[0] = id(9999);
      mutableIds.push(id(9998));
      expect([...(await fixedBatch).keys()]).toEqual([
        previous.artifact.artifact_id,
      ]);
      const midflight = new AbortController();
      const recursiveStop = new AbortController();
      const originalBatchKnowledge = v7app.database.knowledge.bind(
        v7app.database,
      );
      v7app.database.knowledge = async <T>(
        action: Parameters<typeof originalBatchKnowledge>[0],
        args: unknown,
        signal?: AbortSignal,
      ): Promise<T> => {
        const result = await originalBatchKnowledge<T>(action, args, signal);
        if (action === "id" && args === id(9999)) midflight.abort();
        if (action === "id" && args === largeArtifact.artifact_id)
          recursiveStop.abort();
        return result;
      };
      try {
        await expect(
          synth.sourceBatchByIds(
            [previous.artifact.artifact_id, id(9999)],
            64 * 1024 * 1024,
            midflight.signal,
          ),
        ).rejects.toMatchObject({ code: "synthesis-cancelled" });
        await expect(
          synth.sourceById(nestedArtifact.artifact_id, recursiveStop.signal),
        ).rejects.toMatchObject({ code: "synthesis-cancelled" });
        const cacheStop = new AbortController();
        await expect(
          synth.withReadSession(
            async (session) => {
              await session.sourceById(previous.artifact.artifact_id);
              cacheStop.abort();
              return session.sourceById(previous.artifact.artifact_id);
            },
            undefined,
            cacheStop.signal,
          ),
        ).rejects.toMatchObject({ code: "synthesis-cancelled" });
      } finally {
        v7app.database.knowledge = originalBatchKnowledge;
      }
      await expect(
        synth.sourceBatchByIds(
          [previous.artifact.artifact_id, published.artifact.artifact_id],
          oneSourceBudget,
        ),
      ).rejects.toMatchObject({ code: "synthesis-limit" });
      expect(
        (await synth.byId(published.artifact.artifact_id))
          ?.independent_literature_ids,
      ).toEqual([literatureId]);
      await expect(
        old.byId(published.artifact.artifact_id),
      ).rejects.toMatchObject({ code: "knowledge-kind-unsupported" });
      await unlink(join(v7app.files.root, env.asset.path));
      for (const malformedId of malformedIds)
        await expect(synth.sourceById(malformedId)).rejects.toMatchObject({
          code: "synthesis-integrity",
        });
      expect(
        (await synth.sourceById(previous.artifact.artifact_id))?.state,
      ).toBe("source-only");
      expect(
        (await synth.byId(published.artifact.artifact_id))
          ?.current_source_states[0]?.state,
      ).toBe("source-only");
      await expect(old.byId(previous.artifact.artifact_id)).rejects.toThrow();
      const onlySource = [
        {
          kind: "knowledge",
          input_id: "source-1",
          source_artifact_id: previous.artifact.artifact_id,
        },
      ];
      expect(
        await prepare.prepare({ policy: "require-all", inputs: onlySource }),
      ).toMatchObject({
        ready: false,
        gaps: [{ input_id: "source-1", code: "original-unavailable" }],
      });
      const sourceOnly = await prepare.prepare({
        policy: "allow-partial",
        inputs: onlySource,
      });
      expect(sourceOnly.ready).toBe(true);
      const sourceOnlyComparison = await synthesisComparisonSha256({
        manifest_sha256: sourceOnly.manifest.manifest_sha256,
        question: "Which conditions?",
        policy: "allow-partial",
        method,
      });
      const sourceOnlyArtifact = {
        ...artifact,
        input: sourceOnly.manifest,
        comparison_sha256: sourceOnlyComparison,
        artifact_id: `${sourceOnlyComparison.slice(0, 8)}-${sourceOnlyComparison.slice(8, 12)}-${sourceOnlyComparison.slice(12, 16)}-${sourceOnlyComparison.slice(16, 20)}-${sourceOnlyComparison.slice(20, 32)}`,
        coverage: {
          ...artifact.coverage,
          items: [
            {
              input_id: "source-1",
              status: "degraded" as const,
              reason: "original-unavailable" as const,
            },
          ],
        },
      };
      expect(
        (await synth.publish(sourceOnlyArtifact)).artifact.coverage,
      ).toMatchObject({
        status: "partial",
        items: [{ status: "degraded", reason: "original-unavailable" }],
      });
      await writeFile(
        join(v7app.files.root, env.asset.path),
        Buffer.from("tampered"),
      );
      await expect(
        synth.sourceById(previous.artifact.artifact_id),
      ).rejects.toThrow();
      await unlink(join(v7app.files.root, env.asset.path));
      const document = await v7app.database.documentVersion(
        env.manifest.items[0]!.document!.document_version_id,
      );
      expect(document).not.toBeNull();
      await unlink(join(v7app.files.root, document!.markdown_artifact_path));
      await expect(
        synth.sourceById(previous.artifact.artifact_id),
      ).rejects.toMatchObject({ code: "synthesis-integrity" });
      const cancelled = new AbortController();
      cancelled.abort();
      await expect(
        synth.sourceById(previous.artifact.artifact_id, cancelled.signal),
      ).rejects.toMatchObject({ code: "synthesis-cancelled" });
      await expect(
        prepare.prepare({ policy: "invalid", inputs: [] }),
      ).rejects.toMatchObject({ code: "synthesis-invalid" });
      await prepare.close();
      await expect(
        prepare.prepare({ policy: "allow-partial", inputs: onlySource }),
      ).rejects.toMatchObject({ code: "synthesis-closed" });
      await synth.close();
      await expect(
        synth.sourceById(previous.artifact.artifact_id),
      ).rejects.toMatchObject({ code: "synthesis-closed" });
    } finally {
      secondAgent?.agent.close();
      await v7app?.close();
      await env.close();
    }
  }, 30000);

  it("treats default update as optional CAS and separates method identity", async () => {
    const env = await environment();
    const a = runtime();
    const b = runtime({ reasoning: "high" });
    const storage = new SqliteKnowledgeStorage(
      env.app.database,
      env.app.files,
      env.app.documentRead,
    );
    const firstService = new KnowledgeAnalysisService(
      env.app.documentRead,
      a.agent,
      storage,
    );
    const secondService = new KnowledgeAnalysisService(
      env.app.documentRead,
      b.agent,
      storage,
    );
    try {
      const first = await firstService.analyze(
        request(env.manifest, { default_update: { expected_revision: null } }),
      );
      expect(first).toMatchObject({
        default_updated: true,
        default_revision: 1,
      });
      const second = await secondService.analyze(
        request(env.manifest, { default_update: { expected_revision: null } }),
      );
      expect(second).toMatchObject({
        published: true,
        default_updated: false,
        default_revision: 1,
      });
      expect(second.artifact.artifact_id).not.toBe(first.artifact.artifact_id);
      expect(
        (
          await storage.default(
            literatureId,
            "overview",
            await sha256(new TextEncoder().encode("")),
          )
        )?.artifact_id,
      ).toBe(first.artifact.artifact_id);
    } finally {
      await firstService.close();
      await secondService.close();
      a.agent.close();
      b.agent.close();
      await env.close();
    }
  });

  it("preserves more than eight valid citations and coalesces repeated segment IDs", async () => {
    const env = await environment(
      Array.from({ length: 12 }, (_, i) => `Paragraph ${i}.\n\n`).join(""),
    );
    const ids = await env.app.documentRead.withVerifiedVersion(
      env.first.document.document_version_id,
      async (_document, _bytes, structure) =>
        structure.segments.map((segment) => segment.segment_id),
    );
    expect(ids.length).toBeGreaterThan(8);
    const fake = runtime({
      response: {
        outcome: "completed",
        title: "Evidence across the document",
        statements: [
          {
            statement_id: "result-1",
            category: "result",
            epistemic: "reported",
            text: "The result draws on multiple source paragraphs.",
            conditions: [],
            quantity: null,
            evidence_segment_ids: [...ids, ids[0]],
          },
        ],
      },
    });
    const storage = new SqliteKnowledgeStorage(
      env.app.database,
      env.app.files,
      env.app.documentRead,
    );
    const service = new KnowledgeAnalysisService(
      env.app.documentRead,
      fake.agent,
      storage,
    );
    try {
      const receipt = await service.analyze(request(env.manifest));
      const stored = await storage.byId(receipt.artifact.artifact_id);
      const evidence = stored!.content.statements[0]!.evidence;
      expect(
        evidence.map((item) =>
          item.target_kind === "document" ? item.locator.segment_id : null,
        ),
      ).toEqual(ids);
      for (const item of evidence) {
        const resolved = await env.app.documentRead.resolveEvidence({
          evidence: item,
          max_bytes: 1024,
          continuation: null,
        });
        if (!("text" in resolved))
          throw new Error("Expected document evidence");
        expect(resolved.content_sha256).toBe(item.content_sha256);
        expect(resolved.text).not.toBe("");
      }
    } finally {
      await service.close();
      fake.agent.close();
      await env.close();
    }
  }, 15000);

  it("rejects nonexistent evidence even when historical budgets are present", async () => {
    const env = await environment();
    const fake = runtime({ badEvidence: true });
    const storage = new SqliteKnowledgeStorage(
      env.app.database,
      env.app.files,
      env.app.documentRead,
    );
    const service = new KnowledgeAnalysisService(
      env.app.documentRead,
      fake.agent,
      storage,
    );
    try {
      await expect(
        service.analyze(
          request(env.manifest, {
            budget: { max_input_bytes: 1, max_output_tokens: 2048 },
          }),
        ),
      ).rejects.toMatchObject({ code: "knowledge-invalid-evidence" });
      expect(fake.calls).toHaveLength(1);
      await expect(
        service.analyze(request(env.manifest)),
      ).rejects.toMatchObject({ code: "knowledge-invalid-evidence" });
      expect(await storage.list(literatureId)).toHaveLength(0);
    } finally {
      await service.close();
      fake.agent.close();
      await env.close();
    }
  });
  it("processes more than 256 short segments without truncating the source", async () => {
    const source = Array.from(
      { length: 300 },
      (_, index) => `# Part ${index}\nText ${index}.\n\n`,
    ).join("");
    const env = await environment(source);
    const fake = runtime();
    const storage = new SqliteKnowledgeStorage(
      env.app.database,
      env.app.files,
      env.app.documentRead,
    );
    const service = new KnowledgeAnalysisService(
      env.app.documentRead,
      fake.agent,
      storage,
    );
    try {
      const described = await env.app.documentRead.describe({
        document_version_id: env.first.document.document_version_id,
      });
      expect(described.segment_count).toBeGreaterThan(256);
      await expect(
        service.analyze(request(env.manifest)),
      ).resolves.toMatchObject({ published: true });
      expect(fake.calls).toHaveLength(1);
    } finally {
      await service.close();
      fake.agent.close();
      await env.close();
    }
  });
  it("lets an in-flight query reader settle before its owner closes, then rejects new reads", async () => {
    const env = await environment();
    const fake = runtime();
    const storage = new SqliteKnowledgeStorage(
      env.app.database,
      env.app.files,
      env.app.documentRead,
    );
    const service = new KnowledgeAnalysisService(
      env.app.documentRead,
      fake.agent,
      storage,
    );
    let query: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
    try {
      const receipt = await service.analyze(request(env.manifest));
      query = await createQueryApplication(env.home);
      await expect(query.knowledgeRead!.byId("invalid")).rejects.toMatchObject({
        code: "knowledge-invalid",
      });
      await expect(query.knowledgeRead!.byId(id(999))).resolves.toBeNull();
      const reading = query.knowledgeRead!.byId(receipt.artifact.artifact_id);
      const closing = query.close();
      await expect(reading).resolves.toEqual(receipt.artifact);
      await closing;
      await expect(
        query.knowledgeRead!.byId(receipt.artifact.artifact_id),
      ).rejects.toMatchObject({ code: "knowledge-closed" });
    } finally {
      await query?.close();
      await service.close();
      fake.agent.close();
      await env.close();
    }
  });
  it("uses production Application model binding and adapter identity for reuse", async () => {
    const env = await environment();
    await env.app.close();
    const directory = join(env.home, ".sciretriever");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const config = (reasoning: string) =>
      [
        "[providers.fixture]",
        'api = "openai-chat-completions"',
        'base_url = "http://127.0.0.1:9/v1"',
        "",
        '[models."fixture/model"]',
        `reasoning = "${reasoning}"`,
        "stream = false",
        "",
        "[analyze]",
        'model = "fixture/model"',
        "",
      ].join("\n");
    await writeFile(join(directory, "config.toml"), config("medium"), {
      mode: 0o600,
    });
    let calls = 0;
    const transportFactory =
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
            segments?: { segment_id: string }[];
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
          const value = input.candidates
            ? {
                outcome: "completed",
                title: "Production long merge",
                statements: input.candidates.map((candidate, index) => ({
                  statement_id: `m${index + 1}`,
                  category: candidate.category,
                  epistemic: candidate.epistemic,
                  text: candidate.text,
                  conditions: candidate.conditions,
                  quantity: candidate.quantity,
                  source_ids: [candidate.id],
                })),
              }
            : input.core
              ? {
                  outcome: "completed",
                  title: "Production long finding",
                  statements: [
                    {
                      statement_id: "s1",
                      category: "result",
                      epistemic: "reported",
                      text: "The synthetic result",
                      conditions: [],
                      quantity: null,
                      evidence_segment_ids: [input.core[0]!.segment_id],
                    },
                  ],
                }
              : {
                  outcome: "completed",
                  title: "Production adapter finding",
                  statements: [
                    {
                      statement_id: "s1",
                      category: "result",
                      epistemic: "reported",
                      text: "The synthetic result",
                      conditions: [],
                      quantity: null,
                      evidence_segment_ids: [input.segments![0]!.segment_id],
                    },
                  ],
                };
          return value;
        });
        return {
          status: 200,
          headers: [],
          body: Buffer.from(JSON.stringify(reply)),
        };
      };
    let firstApp: Application | undefined;
    let secondApp: Application | undefined;
    try {
      firstApp = await createApplication(env.home, {
        executionSchema: "require-v2",
        agentTransportFactory: transportFactory,
      });
      const first = await firstApp.maintenance!.analyze!(request(env.manifest));
      const reused = await firstApp.maintenance!.analyze!(
        request(env.manifest),
      );
      expect(first.artifact.artifact_id).toBe(reused.artifact.artifact_id);
      expect(reused.published).toBe(false);
      expect(first.artifact.provenance).toMatchObject({
        provider: "fixture",
        model: "model",
      });
      expect(calls).toBe(2);
      const long = await firstApp.maintenance!.analyzeLong(
        longRequest(env.manifest),
      );
      expect(long.artifact.method.version).toBe("1");
      expect(long.artifact.provenance).toMatchObject({
        provider: "fixture",
        model: "model",
      });
      expect(calls).toBe(4);
      const query = await createQueryApplication(env.home);
      try {
        expect(
          await query.knowledgeRead!.byId(long.artifact.artifact_id),
        ).toEqual(long.artifact);
      } finally {
        await query.close();
      }
      await firstApp.close();
      firstApp = undefined;
      await writeFile(join(directory, "config.toml"), config("high"), {
        mode: 0o600,
      });
      secondApp = await createApplication(env.home, {
        executionSchema: "require-v2",
        agentTransportFactory: transportFactory,
      });
      const changed = await secondApp.maintenance!.analyze!(
        request(env.manifest),
      );
      expect(changed.artifact.method.model_binding_sha256).not.toBe(
        first.artifact.method.model_binding_sha256,
      );
      expect(changed.artifact.artifact_id).not.toBe(first.artifact.artifact_id);
      expect(calls).toBe(6);
    } finally {
      await firstApp?.close();
      await secondApp?.close();
      await env.close();
    }
  });

  it("returns the winner's stored bytes and provenance for concurrent identical methods", async () => {
    const env = await environment();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const a = runtime({ text: "first answer", gate });
    const b = runtime({ text: "second answer", gate });
    const storage = new SqliteKnowledgeStorage(
      env.app.database,
      env.app.files,
      env.app.documentRead,
    );
    const sa = new KnowledgeAnalysisService(
      env.app.documentRead,
      a.agent,
      storage,
    );
    const sb = new KnowledgeAnalysisService(
      env.app.documentRead,
      b.agent,
      storage,
    );
    try {
      const pa = sa.analyze(request(env.manifest));
      const pb = sb.analyze(request(env.manifest));
      release();
      const [ra, rb] = await Promise.all([pa, pb]);
      expect(ra.artifact).toEqual(rb.artifact);
      expect([ra.published, rb.published].sort()).toEqual([false, true]);
      expect(await storage.list(literatureId)).toHaveLength(1);
    } finally {
      await sa.close();
      await sb.close();
      a.agent.close();
      b.agent.close();
      await env.close();
    }
  });
});

describe("DSH document reading sessions", () => {
  const source = [
    `${"A".repeat(64000)} DRY_RESULT_4.2_eV\n`,
    `${"B".repeat(64000)} NEGATED_IMPROVEMENT\n`,
    `${"C".repeat(64000)} WET_CONTRADICTION_5.1_eV\n`,
  ].join("");
  async function setup(
    text: string,
    options: Parameters<typeof longRuntime>[0] = {},
  ) {
    const env = await environment(text);
    const fake = longRuntime(options);
    const storage = new SqliteKnowledgeStorage(
      env.app.database,
      env.app.files,
      env.app.documentRead,
    );
    const service = new KnowledgeAnalysisService(
      env.app.documentRead,
      fake.agent,
      storage,
    );
    return {
      env,
      fake,
      storage,
      service,
      async close() {
        await service.close();
        await fake.agent.close();
        await env.close();
      },
    };
  }
  it("reads every range in one DSH conversation, retains tail/negation and reuses immutable results", async () => {
    const f = await setup(source);
    try {
      const receipt = await f.service.analyzeLong(longRequest(f.env.manifest));
      expect(receipt.artifact.method).toMatchObject({
        id: "dsh-document-analysis",
        version: "1",
      });
      expect(receipt.artifact.coverage).toMatchObject({
        status: "complete",
        covered_utf8_bytes: Buffer.byteLength(source),
        total_segments: 3,
        covered_segments: 3,
      });
      expect(f.fake.modelCalls.length).toBeGreaterThan(3);
      const final = f.fake.modelCalls.at(-1)!;
      const pages = final.messages
        .filter((m) => m.role === "tool" && m.name === "read_document")
        .map(
          (m) =>
            JSON.parse((m.parts[0] as { text: string }).text) as {
              segments: { text: string }[];
            },
        );
      expect(pages.flatMap((p) => p.segments.map((s) => s.text)).join("")).toBe(
        source,
      );
      expect(receipt.artifact.content.statements.map((s) => s.text)).toEqual([
        "4.2 eV under dry conditions",
        "The treatment did not improve yield",
        "5.1 eV under wet conditions contradicts dry result",
      ]);
      expect(
        receipt.artifact.content.statements.map((s) => s.evidence[0]?.locator),
      ).toEqual(
        [1, 2, 3].map((n) => ({ kind: "segment", segment_id: `p${n}` })),
      );
      const count = f.fake.modelCalls.length;
      expect(
        (
          await f.service.analyzeLong(
            longRequest(f.env.manifest, {
              budget: {
                ...longRequest(f.env.manifest).budget,
                max_calls: 1,
                max_source_bytes: 1,
              },
            }),
          )
        ).published,
      ).toBe(false);
      expect(f.fake.modelCalls).toHaveLength(count);
      expect(await f.storage.byId(receipt.artifact.artifact_id)).toEqual(
        receipt.artifact,
      );
    } finally {
      await f.close();
    }
  });
  it.each([
    `${"中".repeat(30000)}DRY_RESULT_4.2_eV`,
    `${"a".repeat(23999)}😀${"😀".repeat(15000)}DRY_RESULT_4.2_eV`,
    `${"a".repeat(23999)}\n${"中".repeat(30000)}DRY_RESULT_4.2_eV`,
  ])("preserves UTF-8 bytes across paged reads (%#)", async (text) => {
    const f = await setup(text);
    try {
      const r = await f.service.analyzeLong(longRequest(f.env.manifest));
      const pages = f.fake.modelCalls
        .at(-1)!
        .messages.filter(
          (m) => m.role === "tool" && m.name === "read_document",
        );
      const actual = pages
        .flatMap(
          (m) =>
            (
              JSON.parse((m.parts[0] as { text: string }).text) as {
                segments: { text: string }[];
              }
            ).segments,
        )
        .map((s) => s.text)
        .join("");
      expect(actual).toBe(text);
      expect(actual).not.toContain("�");
      expect(r.artifact.coverage.covered_utf8_bytes).toBe(
        Buffer.byteLength(text),
      );
      for (const evidence of r.artifact.content.statements[0]!.evidence) {
        const resolved = await f.env.app.documentRead.resolveEvidence(evidence);
        expect(resolved.evidence.content_sha256).toBe(evidence.content_sha256);
      }
    } finally {
      await f.close();
    }
  });
  it("reads the complete tail after 8192 segments", async () => {
    const f = await setup(`${"x\n".repeat(8193)}DRY_RESULT_4.2_eV\n`);
    try {
      const r = await f.service.analyzeLong(longRequest(f.env.manifest));
      expect(r.artifact.coverage).toMatchObject({
        total_segments: 8194,
        covered_segments: 8194,
      });
      expect(r.artifact.content.statements[0]!.evidence[0]!.locator).toEqual({
        kind: "segment",
        segment_id: "p8194",
      });
    } finally {
      await f.close();
    }
  });
  it.each([
    [{ invalidEvidence: true }, "knowledge-invalid-evidence"],
    [{ invalidQuantity: true }, "knowledge-response"],
    [{ notApplicable: true }, "knowledge-not-applicable"],
    [{ outputTokens: Number.NaN }, "knowledge-response"],
  ] as const)(
    "rejects invalid submissions and usage without publishing (%#)",
    async (options, code) => {
      const f = await setup(source, options);
      try {
        await expect(
          f.service.analyzeLong(longRequest(f.env.manifest)),
        ).rejects.toMatchObject({ code });
        expect(await f.storage.list(literatureId)).toHaveLength(0);
      } finally {
        await f.close();
      }
    },
  );
  it("cancels a DSH continuation before publication and releases the session", async () => {
    const stop = new AbortController();
    const f = await setup(source, {
      onModel: (_request, index) => {
        if (index === 3) stop.abort();
      },
    });
    try {
      await expect(
        f.service.analyzeLong(longRequest(f.env.manifest), stop.signal),
      ).rejects.toMatchObject({ code: "knowledge-cancelled" });
      expect(f.fake.modelCalls).toHaveLength(3);
      expect(await f.storage.list(literatureId)).toHaveLength(0);
    } finally {
      await f.close();
    }
  });
  it("binds a distant condition and result to two original evidence references", async () => {
    const f = await setup(
      `CONDITION_DRY_ONLY${"A".repeat(65536)}\nMEASURE_4.2_eV\n`,
    );
    try {
      const r = await f.service.analyzeLong(longRequest(f.env.manifest));
      expect(r.artifact.content.statements[0]!.conditions).toEqual([
        "dry only",
      ]);
      expect(
        r.artifact.content.statements[0]!.evidence.map((e) => e.locator),
      ).toEqual([
        { kind: "segment", segment_id: "p2" },
        { kind: "segment", segment_id: "p1" },
      ]);
    } finally {
      await f.close();
    }
  });
  it("preserves English and Chinese negation without deterministic rewriting", async () => {
    const f = await setup(
      "CANNOT_REDUCE\nCHINESE_NEGATION\nAFFIRMATIVE_CONTROL\n",
    );
    try {
      const r = await f.service.analyzeLong(longRequest(f.env.manifest));
      expect(r.artifact.content.statements.map((s) => s.text)).toEqual([
        "It cannot reduce energy",
        "结果未显著改善",
        "The control improved yield",
      ]);
    } finally {
      await f.close();
    }
  });
});
