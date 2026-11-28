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
  splitSentences,
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
/** A call of the reading layers (ADR 0073) as the fake model sees it. */
export type LayersCall =
  | { readonly kind: "section" | "line" | "document"; readonly input: string }
  | {
      readonly kind: "translation-section";
      readonly input: LayersTranslationSectionInput;
    }
  | {
      readonly kind: "translation-document";
      readonly input: LayersTranslationDocumentInput;
    };
export interface LayersTranslationSectionInput {
  readonly title: string | null;
  readonly section: string | null;
  readonly part: { readonly index: number; readonly of: number } | null;
  readonly paragraphs: readonly {
    readonly id: string;
    readonly kind: string | null;
    readonly text: string;
    readonly evidence: readonly {
      readonly id: string;
      readonly original: string;
    }[];
  }[];
}
export interface LayersTranslationDocumentInput {
  readonly title: string | null;
  readonly sections: readonly {
    readonly heading: string | null;
    readonly line: string | null;
    readonly notes: readonly { readonly id: string; readonly note: string }[];
  }[];
  readonly write: {
    readonly summary: string;
    readonly limits: readonly { readonly id: string; readonly text: string }[];
    readonly advice: {
      readonly text: string;
      readonly places: readonly {
        readonly id: string;
        readonly text: string;
      }[];
    } | null;
    readonly data: readonly {
      readonly id: string;
      readonly quantity: string;
    }[];
  };
}
/** A text's sentences by the contracts' rule, as strings. */
export const sentencesOf = (text: string) =>
  splitSentences(text).map((s) => text.slice(s.start, s.end));
/**
 * The paragraphs of a section call's input: short id, kind, the text on the
 * line after the head, and that text's sentences.
 */
export function layersParagraphs(input: string) {
  const out: { id: string; kind: string; text: string; sentences: string[] }[] =
    [];
  let open = false;
  for (const line of input.split("\n")) {
    const head = /^\[(p\d+)\] (.+)$/u.exec(line);
    if (head) {
      out.push({ id: head[1]!, kind: head[2]!, text: "", sentences: [] });
      open = true;
      continue;
    }
    if (open && out.length) {
      const p = out.at(-1)!;
      out[out.length - 1] = { ...p, text: line, sentences: sentencesOf(line) };
    }
    open = false;
  }
  return out;
}
/** The notes of a whole-document input: short id, kind and note. */
export function layersNotes(input: string) {
  return [...input.matchAll(/^\[(p\d+)\] ([a-z]+): (.*)$/gmu)].map((m) => ({
    id: m[1]!,
    kind: m[2]!,
    note: m[3]!,
  }));
}
const words = (s: string, n: number) =>
  s
    .replace(/[.!?]$/u, "")
    .split(/\s+/u)
    .slice(0, n)
    .join(" ");
/**
 * Valid answers to the layers calls (ADR 0073, spec 10.3). A section call:
 * every paragraph's note is its first sentence (cut to 20 words) and its
 * reason the second, its evidence the first sentence quoted; its label the
 * note's second to fourth words, its key term the first long word; the
 * first paragraph of the whole document is
 * context, the rest results. A section line names the section. The
 * whole-document call: the first three notes are the trunk, each later note
 * follows the one before it, one data row quotes the first note's
 * wavelength, the advice names the heading `s4`.
 */
export function defaultLayersReply(call: LayersCall): unknown {
  if (call.kind === "section") {
    const paragraphs = layersParagraphs(call.input);
    const heading = /^This section: (?:\[s\d+\] )?(.*)$/mu.exec(
      call.input,
    )?.[1];
    const part = /^This is part /mu.test(call.input);
    return {
      section: part
        ? { statement: "", label: "" }
        : {
            statement: `The ${heading ?? "section"} section establishes stable spectra.`,
            label: "stable spectra",
          },
      units: paragraphs.map((p) => {
        const statement = `${words(p.sentences[0] ?? "", 20)}.`;
        const tokens = statement.split(/\s+/u);
        return {
          id: p.id,
          kind: p.id === "p1" ? "context" : "result",
          statement,
          reason: p.sentences[1] ? words(p.sentences[1], 25) + "." : "",
          label: tokens.slice(1, 4).join(" "),
          evidence: p.sentences.slice(0, 1),
          key_terms: [
            tokens.find((w) => /^[A-Za-z]{5,}$/u.test(w)) ?? tokens[0]!,
          ],
          see: [],
        };
      }),
    };
  }
  if (call.kind === "line")
    return {
      section: {
        statement: "The section establishes stable spectra.",
        label: "stable spectra",
      },
    };
  if (call.kind === "document") {
    const notes = layersNotes(call.input);
    const first = notes[0]?.id ?? "p1";
    const value = /\d+ nm/u.exec(notes[0]?.note ?? "")?.[0] ?? "1 nm";
    return {
      digest: {
        summary: {
          text: "A synthetic study of spectra measured in water. It records each sample and concludes that the spectra are stable.",
          units: [first],
          key_terms: ["synthetic study"],
        },
        limits: [
          { text: "Only water was used as the medium.", units: [first] },
        ],
        advice: {
          text: "Read Results for the spectra.",
          not_given: null,
          units: [],
          key_terms: ["spectra"],
          places: [{ text: "Results", target: "s4" }],
        },
      },
      primary: notes.slice(0, 3).map((n) => n.id),
      relations: notes.slice(1).map((n, i) => ({
        from: n.id,
        word: "follows",
        targets: [notes[i]!.id],
      })),
      data: [
        { quantity: "Spectrum of the first sample", value, source: first },
      ],
    };
  }
  return defaultLayersTranslationReply(call);
}
/**
 * The translation part written from the stored translation: a note is its
 * paragraph's first translated sentence, its reason the second, its label
 * the note's first three tokens; every evidence quotes the note. The digest is
 * the original's prefixed, its places' words kept.
 */
export function defaultLayersTranslationReply(call: LayersCall): unknown {
  if (call.kind === "translation-section") {
    const { input } = call;
    return {
      section: input.part
        ? { statement: "", label: "" }
        : {
            statement: `译文：${input.section ?? ""}一节确立了稳定的光谱。`,
            label: "稳定的光谱",
          },
      units: input.paragraphs.map((p) => {
        const sentences = sentencesOf(p.text);
        const statement = sentences[0] ?? "";
        const tokens = statement.split(/\s+/u);
        return {
          id: p.id,
          statement,
          reason: sentences[1] ?? "",
          label: tokens.slice(0, 3).join(" "),
          key_terms: tokens[1] ? [tokens[1]] : [],
          evidence: p.evidence.map((e) => ({ id: e.id, quote: statement })),
        };
      }),
    };
  }
  if (call.kind === "translation-document") {
    const { write } = call.input;
    return {
      summary: {
        text: `译文：${write.summary}`,
        key_terms: ["synthetic study"],
      },
      limits: write.limits.map((l) => ({ id: l.id, text: `译文：${l.text}` })),
      advice: write.advice
        ? {
            text: `译文：${write.advice.text}`,
            key_terms: ["spectra"],
            places: write.advice.places.map((p) => ({
              id: p.id,
              text: p.text,
            })),
          }
        : { text: null, key_terms: [], places: [] },
      data: write.data.map((d) => ({
        id: d.id,
        quantity: `译文：${d.quantity}`,
      })),
    };
  }
  return defaultLayersReply(call);
}
/** Which layers call a system prompt starts, or null for other calls. */
export function layersCallOf(system: string, user: string): LayersCall | null {
  if (system.startsWith("You write the reading notes of one section"))
    return { kind: "section", input: user };
  if (system.startsWith("You write the line of one section"))
    return { kind: "line", input: user };
  if (system.startsWith("You write the digest of a whole document"))
    return { kind: "document", input: user };
  if (/^You rewrite in .+ the reading notes of one section/u.test(system))
    return {
      kind: "translation-section",
      input: JSON.parse(user) as LayersTranslationSectionInput,
    };
  if (/^You rewrite in .+ the digest of a whole document/u.test(system))
    return {
      kind: "translation-document",
      input: JSON.parse(user) as LayersTranslationDocumentInput,
    };
  return null;
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
    restoreRequestedTasks?: boolean;
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
  /** Archive translation (ADR 0068): every unit back, prefixed, formulas kept. */
  let translationReply: (input: {
    readonly title: string | null;
    readonly sections: readonly string[];
    readonly units: readonly { id: string; text: string }[];
  }) => unknown = (input) => ({
    translations: input.units.map((u) => ({
      id: u.id,
      translation: `译文：${u.text}`,
    })),
  });
  /** Reading layers (ADR 0073): the section, section-line and whole-document calls. */
  let layersReply: (call: LayersCall) => unknown = defaultLayersReply;
  /** The layers translation part (spec 10.5): its section and whole-document calls. */
  let layersTranslationReply: (call: LayersCall) => unknown =
    defaultLayersTranslationReply;
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
    ...(optionsInput.restoreRequestedTasks === undefined
      ? {}
      : { restoreRequestedTasks: optionsInput.restoreRequestedTasks }),
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
      const system = wire.messages[0]?.content;
      const systemText =
        typeof system === "string" ? system : (system?.[0]?.text ?? "");
      const userText = wire.messages[1]!.content[0]!.text;
      const layers = layersCallOf(systemText, userText);
      const value = layers
        ? layers.kind.startsWith("translation-")
          ? layersTranslationReply(layers)
          : layersReply(layers)
        : systemText.startsWith("You translate the paragraphs")
          ? translationReply(
              JSON.parse(userText) as Parameters<typeof translationReply>[0],
            )
          : await modelReply(
              JSON.parse(userText) as ModelInput,
              request.signal,
            );
      return {
        status: 200,
        headers: [],
        body: Buffer.from(
          JSON.stringify({
            model: "model",
            choices: [
              {
                index: 0,
                // A translation reply of {truncated: true} is an answer cut off at the output limit.
                finish_reason:
                  (value as { truncated?: unknown } | null)?.truncated === true
                    ? "length"
                    : "stop",
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
      setTranslation: (reply: typeof translationReply) => {
        translationReply = reply;
      },
      setLayers: (reply: typeof layersReply) => {
        layersReply = reply;
      },
      setLayersTranslation: (reply: typeof layersTranslationReply) => {
        layersTranslationReply = reply;
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
