import { randomUUID } from "node:crypto";
import {
  rawParseIdentity,
  canonicalJsonBytes,
  parseRawParseInput,
  type RawBlockType,
  type ArrangementOperation,
  type ArchiveSectionRole,
} from "@sciretriever/contracts";
import { DshAgentRuntime } from "../src/agents/dsh/runtime.js";
import type { AgentAdapter } from "../src/agents/protocol.js";
import type {
  ModelRequest,
  ModelResponse,
} from "../src/agents/model-protocol.js";
import type { PdfPages, ProofreadCache } from "../src/proofread/contract.js";
import type { PdfPageInspection } from "../src/browser/pdf-region.js";
import {
  prepareArrangementSource,
  byteHash,
  type ArchiveTextSource,
} from "../src/archive/text-source.js";
import {
  arrangementLeafId,
  reviewArrangement,
  acceptArrangement,
} from "../src/archive/arrangement.js";
export const imageBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
  "base64",
);
export async function archiveTextFixture(
  values: readonly {
    text: string;
    page?: number;
    type?: RawBlockType;
    html?: string;
    image?: boolean;
    /** The parser's own block type (MinerU `table` for table notes). */
    source_type?: string;
  }[],
  options: { layers?: readonly string[]; page_count?: number } = {},
) {
  const count =
    options.page_count ?? Math.max(1, ...values.map((v) => (v.page ?? 0) + 1));
  const resource = {
    reference: "images/fixture.png",
    artifact: {
      sha256: byteHash(imageBytes),
      byte_size: imageBytes.length,
      media_type: "image/png",
    },
  };
  const ordinals = new Map<number, number>();
  const blocks = values.map((v) => {
    const page = v.page ?? 0,
      index = ordinals.get(page) ?? 0;
    ordinals.set(page, index + 1);
    return {
      page,
      index,
      type: v.type ?? "text",
      title_level: v.type === "title" ? 2 : null,
      text: v.text,
      html: v.html ?? null,
      image_ref: v.image ? resource.reference : null,
      bbox: [0, 0, 900, 200],
      source_type: v.source_type ?? "synthetic",
    };
  });
  const bytes = canonicalJsonBytes({
      schema_version: 1,
      page_count: count,
      blocks,
    }),
    markdown = Buffer.from(values.map((v) => v.text).join("\n\n"));
  const input = parseRawParseInput({
    source_asset_id: "00000000-0000-0000-0000-000000000991",
    source_sha256: "a".repeat(64),
    profile: "vlm-engine",
    parser_version: "synthetic-v1",
    model_identity: "synthetic",
    parameters_sha256: "b".repeat(64),
    page_count: count,
    page_sizes: Array.from({ length: count }, () => [595, 842] as const),
    blocks: {
      sha256: byteHash(bytes),
      byte_size: bytes.length,
      media_type: "application/json",
    },
    markdown: {
      sha256: byteHash(markdown),
      byte_size: markdown.length || 1,
      media_type: "text/markdown",
    },
    resources: values.some((v) => v.image) ? [resource] : [],
    private_content_list: {
      sha256: byteHash(bytes),
      byte_size: bytes.length,
      media_type: "application/json",
    },
  });
  const raw = { ...input, ...(await rawParseIdentity(input)) };
  const pages: PdfPageInspection[] = Array.from(
    { length: count },
    (_, page) => {
      const text =
        options.layers?.[page] ??
        values
          .filter((v) => (v.page ?? 0) === page)
          .map((v) => v.text)
          .join(" ");
      return {
        page,
        kind: text ? "text-layer" : "image-only",
        text,
        visible_glyphs: [...text].length,
        unmapped_glyphs: 0,
        hidden_glyphs: 0,
        has_graphics: !text,
      };
    },
  );
  const source = await prepareArrangementSource(
    raw,
    {
      readArtifact: async (_id, kind) => (kind === "blocks" ? bytes : markdown),
    },
    pages,
  );
  return { source, pages, bytes, markdown, input };
}
export function assigned(
  source: ArchiveTextSource,
  role: Exclude<ArchiveSectionRole, "additional"> = "methods",
): ArrangementOperation[] {
  return source.blocks.map((b) => ({
    kind: "assign",
    leaf_id: arrangementLeafId(
      b.root_block_id,
      0,
      [...b.text].length,
      source.raw.result_sha256,
    ),
    target: { role },
    presentation: { kind: "content" },
  }));
}
export function arranged(source: ArchiveTextSource, ops = assigned(source)) {
  const review = reviewArrangement(source, ops);
  const withMerges = ops;
  return acceptArrangement(
    source,
    {
      schema_version: 1,
      source_input_sha256: source.input_sha256,
      reviewed_candidates_sha256: review.candidates_sha256,
      operations: withMerges,
      break_decisions: review.candidates.map((c) => ({
        candidate_id: c.candidate_id,
        decision: "keep",
        reason: "separate",
      })),
    },
    "c".repeat(64),
  );
}
export function memoryTextCache() {
  const entries = new Map<
    string,
    { id: string; bytes: Uint8Array; media_type: string }
  >();
  const cache: ProofreadCache = {
    read: async (key) => entries.get(key) ?? null,
    save: async (key, bytes, media_type) => {
      const old = entries.get(key);
      if (old) {
        if (byteHash(old.bytes) !== byteHash(bytes))
          throw Error("immutable-cache-conflict");
        return old.id;
      }
      const id = randomUUID();
      entries.set(key, { id, bytes, media_type });
      return id;
    },
  };
  return { cache, entries };
}
export function fakePages(
  inspections: readonly PdfPageInspection[] = [],
): PdfPages {
  return {
    method: "synthetic-pdf-v1",
    inspect: async () => inspections,
    image: async () => ({
      media_type: "image/png",
      data: imageBytes,
      width: 1,
      height: 1,
    }),
  };
}
export const modelTool = (
  name: string,
  args: Record<string, unknown>,
): ModelResponse => ({
  message: {
    role: "assistant",
    parts: [],
    tool_calls: [{ id: randomUUID(), name, arguments: args }],
  },
  stop_reason: "tool_calls",
  provenance: {
    provider: "fixture",
    model: "vision",
    usage: { input_tokens: 13, output_tokens: 7 },
  },
});
export function fakeTextRuntime(
  execute: NonNullable<AgentAdapter["executeModel"]>,
  context = 1000000,
) {
  return new DshAgentRuntime([
    {
      role: "proofreading",
      provider: "fixture",
      model: "vision",
      capabilities: ["structured_text", "tool_decision", "image_input"],
      reasoning: "default",
      stream: false,
      context_window_tokens: context,
      max_output_tokens: 4096,
      adapter: {
        provider: "fixture",
        model: "vision",
        execute: async () => {
          throw Error("atomic-model-forbidden");
        },
        executeModel: async (request, options, signal, lifecycle) => {
          lifecycle?.onDispatched();
          return execute(request, options, signal, lifecycle);
        },
      },
    },
  ]);
}
export function lastTool(request: ModelRequest) {
  return [...request.messages].reverse().find((m) => m.role === "tool");
}
export function toolJson(request: ModelRequest): Record<string, unknown> {
  for (const part of lastTool(request)?.parts ?? [])
    if ("text" in part)
      try {
        return JSON.parse(part.text) as Record<string, unknown>;
      } catch {
        /* Skip the framework's plain text tool preamble. */
      }
  throw Error("missing-tool-json");
}
export const modelText = (text: string): ModelResponse => ({
  message: { role: "assistant", parts: [{ media_type: "text/plain", text }] },
  stop_reason: "complete",
  provenance: {
    provider: "fixture",
    model: "vision",
    usage: { input_tokens: 13, output_tokens: 7 },
  },
});
export function initialPage(request: ModelRequest): {
  page_index: number;
  page_input_sha256: string;
} {
  for (const m of request.messages)
    for (const p of m.parts)
      if ("text" in p)
        try {
          const v = JSON.parse(p.text) as Record<string, unknown>;
          if (
            typeof v.page_index === "number" &&
            typeof v.page_input_sha256 === "string"
          )
            return {
              page_index: v.page_index,
              page_input_sha256: v.page_input_sha256,
            };
        } catch {
          /* Non-JSON source messages are ordinary model context. */
        }
  throw Error("missing-page-input");
}
