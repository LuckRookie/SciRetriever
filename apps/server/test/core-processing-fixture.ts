import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseProvenance,
  sha256,
  type ArticleIdentityRequest,
  type ArtifactRef,
} from "@sciretriever/contracts";
import {
  createApplication,
  type Application,
  type ApplicationOptions,
} from "../src/bootstrap/application.js";
import { initializeCatalogSchema } from "../src/storage/sqlite/catalog-schema.js";
import { TypeScriptParserArtifactRules } from "../src/parsing/artifact-rules.js";
import {
  FIXTURE_LITERATURE,
  FIXTURE_DOI,
  FIXTURE_TITLE,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";

export interface ModelInput {
  readonly segments?: readonly { segment_id: string; text: string }[];
  readonly purpose?: string;
  readonly [key: string]: unknown;
}
const baseConfiguration =
  '[providers.fixture]\napi="openai-chat-completions"\nbase_url="http://127.0.0.1:9/v1"\n[models."fixture/model"]\nreasoning="medium"\nstream=false\n[analyze]\nmodel="fixture/model"\n';
const legacyBudgets =
  "metadata_max_output_tokens=2048\ncontent_max_output_tokens=4096\nmax_input_bytes=1048576\nmax_chunk_bytes=1048576\nmax_chunk_count=1\nmax_total_llm_requests=2\nmax_total_output_tokens=6144\n";
export async function coreProcessingFixture(
  optionsInput: {
    legacyAnalysis?: boolean;
    analysisModel?: boolean;
    inspectResponseSchema?: (schema: unknown) => void;
  } = {},
) {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-core-processing-"));
  const config = join(home, ".sciretriever");
  await mkdir(config, { mode: 0o700 });
  await writeFile(
    join(config, "config.toml"),
    (optionsInput.analysisModel === false
      ? baseConfiguration.replace('[analyze]\nmodel="fixture/model"\n', "")
      : baseConfiguration) + (optionsInput.legacyAnalysis ? legacyBudgets : ""),
    { mode: 0o600 },
  );
  await initializeCatalogSchema(join(home, "catalog.sqlite"));
  let text = `# ${FIXTURE_TITLE}\nDOI: ${FIXTURE_DOI}\nA synthetic finding.\n`;
  let parseCalls = 0;
  let parseHook: (signal?: AbortSignal) => Promise<void> = async () => {};
  let modelCalls = 0;
  let modelReply: (
    input: ModelInput,
    signal?: AbortSignal,
  ) => unknown | Promise<unknown> = (input) => {
    if (input.stage === "metadata")
      return { outcome: "usable", metadata: FIXTURE_LITERATURE.metadata };
    if (input.stage === "content")
      return {
        markdown:
          "# 研究背景与目标\n\nThe fixture studies spectroscopy.\n\n# 研究方法\n\n未提供\n\n# 数据\n\n未提供\n\n# 结论与局限性\n\n未提供\n\n# 参考文献\n\n1. Fixture reference.\n",
      };
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
  };
  const options: ApplicationOptions = {
    executionSchema: "require-v2",
    parsing: {
      rules: new TypeScriptParserArtifactRules(),
      parser: {
        parse: async (request, signal) => {
          parseCalls++;
          await parseHook(signal);
          const bytes = Buffer.from(text);
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
                provenance_id: randomUUID(),
                source_kind: "parser",
                source_name: "synthetic",
                source_record_id: null,
                observed_at: new Date().toISOString(),
                input_sha256: request.source_sha256,
                parameters_sha256: "a".repeat(64),
              }),
              parser_version: "fixture-1",
              mode: null,
              model_identity: null,
            },
          };
        },
      },
    },
    agentTransportFactory: () => async (request) => {
      modelCalls++;
      const wire = JSON.parse(new TextDecoder().decode(request.body)) as {
        messages: { content: { text: string }[] }[];
        response_format?: { json_schema?: { schema?: unknown } };
      };
      optionsInput.inspectResponseSchema?.(
        wire.response_format?.json_schema?.schema,
      );
      const input = JSON.parse(
        wire.messages[1]!.content[0]!.text,
      ) as ModelInput;
      const value = await modelReply(input, request.signal);
      return {
        status: 200,
        headers: [],
        body: Buffer.from(
          JSON.stringify({
            model: "model",
            choices: [
              {
                index: 0,
                finish_reason: "stop",
                message: { role: "assistant", content: JSON.stringify(value) },
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 50 },
          }),
        ),
      };
    },
  };
  let app: Application;
  let opened: Application | undefined;
  try {
    app = await createApplication(home, options);
    opened = app;
    await app.database.putLiterature(FIXTURE_LITERATURE);
    await app.maintenance!.ingestPdf({
      literature_id: FIXTURE_LITERATURE.literature_id,
      bytes: workbenchPdf(),
    });
    const asset = (await app.library.detail(FIXTURE_LITERATURE.literature_id))
      .primary_pdf!.asset;
    const parseRequest = {
      literature_id: FIXTURE_LITERATURE.literature_id,
      asset_id: asset.asset_id,
      asset_sha256: asset.sha256,
      mode: "reparse" as const,
      expected_default_revision: null,
    };
    return {
      home,
      asset,
      parseRequest,
      get app() {
        return app;
      },
      get parseCalls() {
        return parseCalls;
      },
      get modelCalls() {
        return modelCalls;
      },
      setText: (value: string) => {
        text = value;
      },
      setParseHook: (hook: typeof parseHook) => {
        parseHook = hook;
      },
      setModel: (reply: typeof modelReply) => {
        modelReply = reply;
      },
      async identityRequest(): Promise<ArticleIdentityRequest> {
        const detail = await app.library.detail(
          FIXTURE_LITERATURE.literature_id,
        );
        const current = await app.documentRead.default({
          literature_id: parseRequest.literature_id,
          asset_id: asset.asset_id,
          asset_sha256: asset.sha256,
        });
        const version = await app.documentRead.describe({
          document_version_id: current.default!.document_version_id,
        });
        return {
          schema_version: 1,
          literature_id: parseRequest.literature_id,
          document_version_id: version.document.document_version_id,
          representation_sha256: version.document.representation_sha256,
          metadata_revision: detail.metadata_revision,
          metadata_sha256: detail.metadata_sha256,
          budget: { max_input_bytes: 65536, max_output_tokens: 2048 },
        };
      },
      async enableLegacyAnalysis() {
        await writeFile(
          join(config, "config.toml"),
          baseConfiguration + legacyBudgets,
          { mode: 0o600 },
        );
      },
      async reopen() {
        await app.close();
        app = await createApplication(home, options);
      },
      openAnother: () => createApplication(home, options),
      async close() {
        await app.close();
        await rm(home, { recursive: true, force: true });
      },
    };
  } catch (error) {
    try {
      await opened?.close();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
    throw error;
  }
}
