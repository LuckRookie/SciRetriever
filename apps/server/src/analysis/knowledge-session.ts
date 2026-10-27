import {
  extractionCanonicalJsonBytes,
  parseEvidenceRef,
  parseSummaryContent,
  sha256,
  type InputManifest,
  type SummaryContent,
  type SummaryStatement,
} from "@sciretriever/contracts";
import type { DshAgentRuntime } from "../agents/dsh/runtime.js";
import { runDshTask, taskAccounting } from "../agents/dsh/task.js";
import {
  AgentFailure,
  type AgentPart,
  type AgentToolDeclaration,
} from "../agents/protocol.js";
import type { DocumentReadService } from "../document/read.js";
import { readingImage } from "./reading-image.js";
import {
  KnowledgeAnalysisFailure,
  knowledgeResponseSchema,
} from "./summary-response.js";

export const DOCUMENT_ANALYSIS_METHOD = "dsh-document-analysis";
export const DOCUMENT_ANALYSIS_VERSION = "2";
const INSTRUCTIONS = `Read the fixed paper in a persistent DSH session and produce an evidence-grounded analysis. Read the entire text with read_document, inspect its saved figures with view_image when supported, and use search_document/read_segments to check numbers, conditions, limitations and apparent contradictions before submitting. Treat headings and OCR as fallible: an attachment link or publisher marker is not necessarily a section title. Do not silently repair the stored source. Compare prose with figures/tables and describe unresolved inconsistencies rather than inventing a correction.
Write a coherent Chinese account, retaining original scientific terms, units and exact conditions. Overview: explain the research question and contribution first, then methods, decisive results and limitations. Detailed: retain additional experimental detail and scope. Question: focus on what the paper can and cannot answer. Distinguish author reports from your inference and claimed applications from demonstrated validation. Explain resource/visual limitations in the result. Use statements with concise paragraphs and original segment citations, including the Markdown anchor when citing a figure. A summary is not a paraphrase of the abstract. Complete textual coverage does not certify scientific accuracy. Use reading_status to check unread text/resources. Return not_applicable only after reviewing the whole source.`;
export function documentAnalysisParameters(
  _budget: unknown,
  bindingHash: string,
): object {
  return {
    method_id: DOCUMENT_ANALYSIS_METHOD,
    method_version: DOCUMENT_ANALYSIS_VERSION,
    prompt: INSTRUCTIONS,
    response_schema: knowledgeResponseSchema(),
    model_binding_sha256: bindingHash,
    tools: "fixed-document-reading-v1",
  };
}
export interface AnalysisAccounting {
  calls: number;
  canonical_call_bytes: number;
  reported_calls: number;
  reported_input_tokens: number;
  reported_output_tokens: number;
}
export interface DocumentAnalysisResult {
  content: SummaryContent | null;
  source_bytes: number;
  segment_count: number;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  gaps: readonly string[];
}
const json = (value: unknown): readonly AgentPart[] => [
  { media_type: "application/json", text: JSON.stringify(value) },
];
const object = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const string = { type: "string" };
const tools: readonly AgentToolDeclaration[] = [
  {
    name: "read_document",
    description:
      "Read the next bounded UTF-8 text range with segment IDs. Start at 0; follow next_start_utf8 until null. Repeat any range to verify it.",
    parameters: object({ start_utf8: { type: "integer" } }),
  },
  {
    name: "read_segments",
    description:
      "Reread specified segments with their neighbours. Oversized passages return their start offset for paged read_document.",
    parameters: object({
      ids: { type: "array", items: string },
    }),
  },
  {
    name: "search_document",
    description:
      "Find a literal phrase or number within this fixed document. Matches identify segments to reread; search alone is not full reading.",
    parameters: object({ query: string }),
  },
  {
    name: "view_image",
    description:
      "Read a saved figure as an image and return its source anchors. Only IDs from the supplied resource manifest are available.",
    parameters: object({ resource_id: string }),
  },
  {
    name: "reading_status",
    description:
      "Check unread text ranges and figures before final submission.",
    parameters: object({}),
  },
];
export async function analyzeDocumentSession(
  request: {
    readonly input: InputManifest;
    readonly purpose: "overview" | "detailed" | "question";
    readonly question: string | null;
  },
  documents: DocumentReadService,
  agents: DshAgentRuntime,
  binding: {
    readonly provider: string;
    readonly model: string;
    readonly max_output_tokens: number;
  },
  signal: AbortSignal,
  shared?: AnalysisAccounting,
  allowNotApplicable = false,
): Promise<DocumentAnalysisResult> {
  const item = request.input.items[0]!,
    ref = item.document!,
    material = item.material!;
  const source = await documents.withVerifiedVersion(
    ref.document_version_id,
    async (version, bytes, structure) => {
      if (
        version.representation_sha256 !== ref.representation_sha256 ||
        version.source_material_ref.asset_id !== material.asset_id ||
        version.source_material_ref.asset_sha256 !== material.asset_sha256 ||
        version.source_material_ref.literature_id !== item.literature_id
      )
        throw new KnowledgeAnalysisFailure("knowledge-input-invalidated");
      // The verified arranged builder keeps deterministic scaffold bytes
      // outside source leaf segments. Legacy documents cover every byte.
      const scaffold = version.builder_version === "arranged-leaves-v2";
      let end = 0;
      const segments = await Promise.all(
        structure.segments.map(async (s) => {
          if (
            s.start_utf8 < end ||
            (!scaffold && s.start_utf8 !== end) ||
            s.end_utf8 <= end ||
            s.end_utf8 > bytes.length
          )
            throw new KnowledgeAnalysisFailure("knowledge-input-invalidated");
          end = s.end_utf8;
          return {
            ...s,
            text: new TextDecoder("utf-8", { fatal: true }).decode(
              bytes.subarray(s.start_utf8, s.end_utf8),
            ),
            hash: await sha256(bytes.subarray(s.start_utf8, s.end_utf8)),
          };
        }),
      );
      if (!scaffold && end !== bytes.length)
        throw new KnowledgeAnalysisFailure("knowledge-input-invalidated");
      return { version, bytes, segments, sections: structure.sections };
    },
    signal,
  );
  const read: [number, number][] = [],
    viewed = new Set<string>(),
    unavailable = new Set<string>();
  const imageCapable = agents.supports("analysis", "image_input");
  const resources = source.version.resources.map((r) => ({
    ...r,
    anchor_segment_ids: source.segments
      .filter((s) => s.text.includes(r.reference))
      .map((s) => s.segment_id),
  }));
  const imageResources = resources.filter((r) =>
    /^image\/(png|jpeg|webp)$/.test(r.artifact.media_type),
  );
  const eligibleImages = imageCapable
    ? imageResources.filter((r) => r.artifact.byte_size <= 16 * 1024 * 1024)
    : [];
  const status = () => {
    let end = 0;
    for (const [a, b] of read.slice().sort((a, b) => a[0] - b[0])) {
      if (a > end) break;
      end = Math.max(end, b);
    }
    return {
      next_unread_utf8: end < source.bytes.length ? end : null,
      text_bytes: source.bytes.length,
      viewed_images: [...viewed],
      unread_images: eligibleImages
        .filter(
          (r) => !viewed.has(r.resource_id) && !unavailable.has(r.resource_id),
        )
        .map((r) => r.resource_id),
      unavailable_images: [...unavailable],
      image_input: imageCapable,
    };
  };
  let content: SummaryContent | null = null;
  const input = {
    purpose: request.purpose,
    question: request.question,
    document_version_id: ref.document_version_id,
    total_bytes: source.bytes.length,
    segment_count: source.segments.length,
    outline: source.sections,
    resources,
    image_input: imageCapable,
    instructions:
      "Start with read_document at 0. Read all text, inspect available images, then verify uncertain claims before submit_result.",
  };
  let readingFailure: unknown;
  let imageCount = 0,
    imageBytes = 0;
  const accounting = taskAccounting();
  try {
    const result = await runDshTask(
      agents,
      {
        trace: {
          literature_id: item.literature_id,
          asset_id: material.asset_id,
          asset_sha256: material.asset_sha256,
          document_version_id: ref.document_version_id,
          kind: "summary",
        },
        system: INSTRUCTIONS,
        accounting,
        input,
        input_sha256: await sha256(
          extractionCanonicalJsonBytes(input, 1024 * 1024, {
            maxArrayLength: 20480,
            maxNodes: 20480,
            maxDepth: 32,
          }),
        ),
        schema: knowledgeResponseSchema(),
        tools,
        executeTool: async (call, context) => {
          context.signal.throwIfAborted();
          const reject = (error: string) => ({
            status: "rejected" as const,
            parts: json({ error }),
          });
          let value: unknown;
          if (call.name === "reading_status") value = status();
          else if (call.name === "read_document") {
            const start = call.arguments.start_utf8;
            if (
              typeof start !== "number" ||
              !Number.isSafeInteger(start) ||
              start < 0 ||
              start >= source.bytes.length ||
              (source.bytes[start]! & 192) === 128
            )
              return reject("invalid-text-offset");
            let end = Math.min(source.bytes.length, start + 24000);
            while (
              end < source.bytes.length &&
              (source.bytes[end]! & 192) === 128
            )
              end--;
            const segments = source.segments
              .filter((s) => s.end_utf8 > start && s.start_utf8 < end)
              .map((s) => ({
                segment_id: s.segment_id,
                start_utf8: Math.max(start, s.start_utf8),
                end_utf8: Math.min(end, s.end_utf8),
                text: new TextDecoder().decode(
                  source.bytes.subarray(
                    Math.max(start, s.start_utf8),
                    Math.min(end, s.end_utf8),
                  ),
                ),
              }));
            read.push([start, end]);
            value = {
              segments,
              next_start_utf8: end < source.bytes.length ? end : null,
            };
          } else if (call.name === "search_document") {
            const q = call.arguments.query;
            if (typeof q !== "string" || !q.trim() || q.length > 1024)
              return reject("invalid-search-query");
            const matches = source.segments.filter((s) =>
              s.text.toLowerCase().includes(q.toLowerCase()),
            );
            value = {
              matches: matches.slice(0, 24).map((s) => ({
                segment_id: s.segment_id,
                start_utf8: s.start_utf8,
                preview: s.text.slice(0, 400),
              })),
              total_matches: matches.length,
            };
          } else if (call.name === "read_segments") {
            const ids = call.arguments.ids;
            if (
              !Array.isArray(ids) ||
              !ids.length ||
              ids.length > 16 ||
              ids.some(
                (id) => !source.segments.some((s) => s.segment_id === id),
              )
            )
              return reject("invalid-segment-ids");
            const indices = new Set<number>();
            for (const id of ids) {
              const n = source.segments.findIndex((s) => s.segment_id === id);
              for (
                let i = Math.max(0, n - 1);
                i <= Math.min(source.segments.length - 1, n + 1);
                i++
              )
                indices.add(i);
            }
            const selected = [...indices]
              .sort((a, b) => a - b)
              .map((i) => source.segments[i]!);
            if (
              selected.reduce((n, s) => n + s.end_utf8 - s.start_utf8, 0) >
              48000
            )
              return {
                status: "success",
                parts: json({
                  use_read_document: true,
                  start_utf8: selected[0]!.start_utf8,
                }),
              };
            for (const s of selected) read.push([s.start_utf8, s.end_utf8]);
            value = {
              segments: selected.map((s) => ({
                segment_id: s.segment_id,
                text: s.text,
              })),
            };
          } else if (call.name === "view_image") {
            const r = resources.find(
              (r) => r.resource_id === call.arguments.resource_id,
            );
            if (!r) return reject("unknown-resource");
            if (!imageCapable) return reject("model-image-input-unavailable");
            if (!eligibleImages.includes(r)) {
              unavailable.add(r.resource_id);
              return reject("resource-media-or-size-unsupported");
            }
            if (
              imageCount >= 16 ||
              imageBytes + r.artifact.byte_size > 64 * 1024 * 1024
            ) {
              unavailable.add(r.resource_id);
              return reject("image-context-limit");
            }
            const chunks: Uint8Array[] = [];
            let continuation: string | null = null,
              offset = 0;
            try {
              do {
                const page = await documents.resource(
                  {
                    document_version_id: ref.document_version_id,
                    resource_id: r.resource_id,
                    max_bytes: 65536,
                    continuation,
                  },
                  context.signal,
                );
                if (
                  !page.bytes_base64 ||
                  page.document.representation_sha256 !==
                    ref.representation_sha256 ||
                  page.resource.artifact.sha256 !== r.artifact.sha256 ||
                  page.actual_range?.start_byte !== offset
                )
                  throw new KnowledgeAnalysisFailure(
                    "knowledge-input-invalidated",
                  );
                const chunk = Buffer.from(page.bytes_base64, "base64");
                offset += chunk.length;
                if (
                  page.actual_range.end_byte !== offset ||
                  offset > r.artifact.byte_size
                )
                  throw new KnowledgeAnalysisFailure(
                    "knowledge-input-invalidated",
                  );
                chunks.push(chunk);
                continuation = page.continuation;
              } while (continuation);
              const bytes = Buffer.concat(chunks);
              if (
                bytes.length !== r.artifact.byte_size ||
                (await sha256(bytes)) !== r.artifact.sha256
              )
                throw new KnowledgeAnalysisFailure(
                  "knowledge-input-invalidated",
                );
              const image = readingImage(bytes, r.artifact.media_type);
              viewed.add(r.resource_id);
              imageCount++;
              imageBytes += bytes.length;
              return {
                status: "success",
                parts: [
                  ...json({
                    resource_id: r.resource_id,
                    reference: r.reference,
                    anchor_segment_ids: r.anchor_segment_ids,
                  }),
                  image,
                ],
              };
            } catch (error) {
              readingFailure = error;
              throw error;
            }
          } else return reject("unknown-tool");
          return { status: "success", parts: json(value) };
        },
        accept(value) {
          if (readingFailure)
            throw new KnowledgeAnalysisFailure("knowledge-input-invalidated");
          const coverage = status();
          if (coverage.next_unread_utf8 !== null)
            throw new KnowledgeAnalysisFailure(
              "knowledge-text-unread-use-reading-status",
            );
          if (coverage.unread_images.length)
            throw new KnowledgeAnalysisFailure(
              "knowledge-images-unread-use-reading-status",
            );
          if (value.outcome === "not_applicable") {
            if (!Array.isArray(value.statements) || value.statements.length)
              throw new KnowledgeAnalysisFailure("knowledge-response");
            return;
          }
          const statements = (
            value.statements as Record<string, unknown>[]
          ).map((s) => ({
            statement_id: s.statement_id,
            category: s.category,
            epistemic: s.epistemic,
            text: s.text,
            conditions: s.conditions,
            quantity: s.quantity,
            evidence: [...new Set(s.evidence_segment_ids as string[])].map(
              (id) => {
                const segment = source.segments.find(
                  (s) => s.segment_id === id,
                );
                return parseEvidenceRef({
                  schema_version: 1,
                  target_kind: "document",
                  locator_scheme: "utf8-segment-v1",
                  document_version_id: ref.document_version_id,
                  representation_sha256: ref.representation_sha256,
                  locator: { kind: "segment", segment_id: id },
                  content_sha256: segment?.hash ?? null,
                });
              },
            ),
          }));
          try {
            content = parseSummaryContent({
              schema_version: 1,
              title: value.title,
              statements: statements.map(
                (s) =>
                  ({
                    statement_id: s.statement_id,
                    category: s.category,
                    epistemic: s.epistemic,
                    text: s.text,
                    conditions: s.conditions,
                    quantity: s.quantity,
                    evidence: s.evidence,
                  }) as SummaryStatement,
              ),
            });
          } catch (error) {
            throw new KnowledgeAnalysisFailure("knowledge-response", {
              cause: error,
            });
          }
        },
      },
      signal,
    );
    if (!content && !allowNotApplicable)
      throw new KnowledgeAnalysisFailure("knowledge-not-applicable");
    return {
      content,
      source_bytes: source.bytes.length,
      segment_count: source.segments.length,
      provider: binding.provider,
      model: binding.model,
      input_tokens: result.provenance.usage.input_tokens,
      output_tokens: result.provenance.usage.output_tokens,
      gaps: [
        "table-structure-unavailable",
        "figure-caption-unavailable",
        "page-location-unavailable",
        "bbox-unavailable",
        ...(!imageCapable && imageResources.length
          ? ["model-image-input-unavailable"]
          : []),
        ...(resources.some((r) => !viewed.has(r.resource_id))
          ? ["some-resource-content-unread"]
          : []),
      ],
    };
  } catch (error) {
    if (signal.aborted)
      throw new KnowledgeAnalysisFailure("knowledge-cancelled");
    if (readingFailure)
      throw new KnowledgeAnalysisFailure("knowledge-input-invalidated", {
        cause: readingFailure,
      });
    if (error instanceof KnowledgeAnalysisFailure) throw error;
    if (
      error instanceof AgentFailure &&
      ["agent-usage", "agent-result-schema"].includes(error.code)
    )
      throw new KnowledgeAnalysisFailure("knowledge-response", {
        cause: error,
        accounting: { ...accounting },
      });
    throw new KnowledgeAnalysisFailure("knowledge-model-failed", {
      accounting: {
        ...accounting,
        usage_complete:
          accounting.usage_complete &&
          accounting.calls_dispatched === accounting.reported_calls,
      },
      cause: error,
      ...(error instanceof AgentFailure
        ? { reason: error.code, retryable: error.retryable }
        : {}),
    });
  } finally {
    if (shared) {
      shared.calls += accounting.calls_dispatched;
      shared.canonical_call_bytes += accounting.canonical_call_bytes;
      shared.reported_calls += accounting.reported_calls;
      shared.reported_input_tokens += accounting.reported_input_tokens;
      shared.reported_output_tokens += accounting.reported_output_tokens;
    }
  }
}
