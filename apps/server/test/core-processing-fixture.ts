import { archiveChatReply } from "./archive-chat-fixture.js";
import { imageBytes } from "./archive-text-fixture.js";
import { rawParserFixture } from "./raw-parser-fixture.js";
import { dshChatReply } from "./dsh-analysis-fixture.js";
import type {
  StagedParserResource,
  RawParserBackend,
} from "../src/parsing/ports.js";
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
  '[providers.fixture]\napi="openai-chat-completions"\nbase_url="http://127.0.0.1:9/v1"\n[models."fixture/model"]\nreasoning="medium"\nimage=true\nstream=false\n[analyze]\nmodel="fixture/model"\n';
export async function coreProcessingFixture(
  optionsInput: {
    homeParent?: string;
    configurationText?: string;
    offline?: boolean;
    sourcePdf?: Uint8Array;
    pageCount?: number;
    pageText?: (page: number, text: string) => string;
    pageMethod?: string;
    analysisModel?: boolean;
    textLayer?: (text: string) => string;
    headerOnly?: boolean;
    rawParser?: RawParserBackend;
    archiveProfile?: "pipeline" | "vlm-engine";
    inspectResponseSchema?: (schema: unknown) => void;
    metadata?: ApplicationOptions["metadata"];
    autoIndexRefresh?: boolean;
  } = {},
) {
  const home = await mkdtemp(
    join(optionsInput.homeParent ?? tmpdir(), "sciretriever-core-processing-"),
  );
  const config = join(home, ".sciretriever");
  await mkdir(config, { mode: 0o700 });
  await writeFile(
    join(config, "config.toml"),
    (optionsInput.analysisModel === false
      ? baseConfiguration.replace('[analyze]\nmodel="fixture/model"\n', "")
      : baseConfiguration) +
      (optionsInput.archiveProfile
        ? `[parsing]\narchive_profile="${optionsInput.archiveProfile}"\n`
        : "") +
      (optionsInput.configurationText ?? ""),
    { mode: 0o600 },
  );
  await initializeCatalogSchema(join(home, "catalog.sqlite"));
  let text = `# ${FIXTURE_TITLE}\nDOI: ${FIXTURE_DOI}\nA synthetic finding.\n`;
  const assetTexts = new Map<string, string>();
  let resources: readonly StagedParserResource[] = [];
  let parseCalls = 0;
  let parseHook: (signal?: AbortSignal) => Promise<void> = async () => {};
  let modelCalls = 0;
  let modelReply: (
    input: ModelInput,
    signal?: AbortSignal,
  ) => unknown | Promise<unknown> = (input) => {
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
    // Most processor tests explicitly own index phases. Automatic-refresh tests
    // opt into a short clock while exercising the same production assembly.
    indexRefreshIntervalMs: optionsInput.autoIndexRefresh ? 25 : null,
    ...(optionsInput.offline
      ? {
          metadataAssembly: {
            resolver: async () => {
              throw new Error("Synthetic external metadata request blocked");
            },
          },
          acquisitionAssembly: {
            resolver: async () => {
              throw new Error("Synthetic external acquisition request blocked");
            },
          },
        }
      : {}),
    ...(optionsInput.metadata ? { metadata: optionsInput.metadata } : {}),
    proofreadPages: {
      method: optionsInput.pageMethod ?? "synthetic-pdf-page-v1",
      async inspect(_asset, _hash, signal) {
        signal?.throwIfAborted();
        return Array.from(
          { length: optionsInput.pageCount ?? 1 },
          (_, page) => ({
            page,
            kind: "text-layer",
            text:
              optionsInput.textLayer?.(assetTexts.get(_asset) ?? text) ??
              assetTexts.get(_asset) ??
              text,
            visible_glyphs: (assetTexts.get(_asset) ?? text).length,
            hidden_glyphs: 0,
            unmapped_glyphs: 0,
            has_graphics: false,
          }),
        );
      },
      async image() {
        return {
          media_type: "image/png",
          data: imageBytes,
          width: 1,
          height: 1,
        };
      },
    },
    parsing: {
      rawParser:
        optionsInput.rawParser ??
        rawParserFixture(
          {
            parse: async (request, signal) => {
              parseCalls++;
              assetTexts.set(request.source_asset_id, text);
              await parseHook(signal);
              const bytes = Buffer.from(text);
              return {
                source_asset_id: request.source_asset_id,
                source_sha256: request.source_sha256,
                page_count: optionsInput.pageCount ?? 1,
                markdown: {
                  artifact: {
                    sha256: await sha256(bytes),
                    byte_size: bytes.length,
                    media_type: "text/markdown",
                  } as ArtifactRef,
                  bytes,
                },
                resources,
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
          optionsInput.headerOnly,
          (optionsInput.pageCount ?? 1) > 1,
          optionsInput.pageText,
        ),
    },
    agentTransportFactory: () => async (request) => {
      modelCalls++;
      request.onDispatched?.();
      const wire = JSON.parse(new TextDecoder().decode(request.body)) as {
        messages: { role: string; content: { text: string }[] }[];
        tools?: {
          function: {
            name: string;
            description: string;
            parameters: Record<string, unknown>;
          };
        }[];
        response_format?: { json_schema?: { schema?: unknown } };
      };
      optionsInput.inspectResponseSchema?.(
        wire.response_format?.json_schema?.schema,
      );
      if (
        wire.tools?.some((t) =>
          [
            "submit_arrangement",
            "submit_breaks",
            "submit_corrections",
          ].includes(t.function.name),
        )
      ) {
        return {
          status: 200,
          headers: [],
          body: Buffer.from(JSON.stringify(archiveChatReply(wire))),
        };
      }
      if (wire.tools?.some((t) => t.function.name === "submit_result")) {
        const value = await dshChatReply(wire, (input) =>
          modelReply(input, request.signal),
        );
        return {
          status: 200,
          headers: [],
          body: Buffer.from(JSON.stringify(value)),
        };
      }
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
      bytes: optionsInput.sourcePdf ?? workbenchPdf(),
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
      rawParseRequest: {
        literature_id: parseRequest.literature_id,
        asset_id: asset.asset_id,
        asset_sha256: asset.sha256,
        profiles: ["pipeline", "vlm-engine"],
        force: false,
      },
      get app() {
        return app;
      },
      get parseCalls() {
        return parseCalls;
      },
      get modelCalls() {
        return modelCalls;
      },
      setResources: (value: readonly StagedParserResource[]) => {
        resources = value;
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
      async disableAnalysis() {
        await writeFile(
          join(config, "config.toml"),
          baseConfiguration.replace('[analyze]\nmodel="fixture/model"\n', ""),
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
