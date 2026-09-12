import { createHash, randomUUID } from "node:crypto";
import {
  contentCanonicalJsonBytes,
  parseArtifactRef,
  parseLiteratureContentProposal,
  parseAnalysisInputIdentity,
  analysisInputSha256,
  parseLiteratureMetadata,
  type AnalysisInputIdentity,
  type LiteratureContentProposal,
  type LiteratureDetail,
  type LiteratureMetadata,
} from "@sciretriever/contracts";
import type { AgentRuntime } from "../agents/runtime.js";
import type { AgentCall } from "../agents/protocol.js";
import type { LiteratureArtifactService } from "../literature/artifacts.js";
import type { FileStore } from "../storage/files/store.js";
import {
  AnalysisRuleError,
  metadataHash,
  parseContentDraft,
  renderCanonicalMarkdown,
  validateMetadataProposal,
} from "./ts-rules.js";
export interface AnalysisLimits {
  readonly metadata_max_output_tokens: number;
  readonly content_max_output_tokens: number;
  readonly max_input_bytes: number;
  readonly max_chunk_bytes: number;
  readonly max_chunk_count: number;
  readonly max_total_llm_requests: number;
  readonly max_total_output_tokens: number;
}
export interface AnalysisOptions {
  readonly timeoutMs?: number;
  readonly limits: AnalysisLimits;
}
export type AnalysisResult =
  | {
      readonly outcome: "proposal";
      readonly proposal: LiteratureContentProposal;
      readonly markdownBytes: Uint8Array;
    }
  | {
      readonly outcome: "no_usable_content";
      readonly input: AnalysisInputIdentity;
    };
export class AnalysisFailure extends Error {
  constructor(readonly code: string) {
    super(`literature analysis failed (${code})`);
  }
}
function fail(code = "analysis-failed"): never {
  throw new AnalysisFailure(code);
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    fail();
  return value;
}
function identity(detail: LiteratureDetail) {
  if (!detail.primary_pdf || !detail.parser_result) fail("analysis-input");
  return parseAnalysisInputIdentity({
    literature_id: detail.literature.literature_id,
    primary_asset_id: detail.primary_pdf.asset.asset_id,
    primary_pdf_sha256: detail.primary_pdf.asset.sha256,
    parser_result_sha256: detail.parser_result.result_sha256,
    input_metadata_revision: detail.metadata_revision,
    input_metadata_sha256: detail.metadata_sha256,
  });
}
export class AnalysisService {
  private readonly stop = new AbortController();
  private readonly options: AnalysisOptions;
  constructor(
    private readonly library: { detail(id: string): Promise<LiteratureDetail> },
    private readonly artifacts: LiteratureArtifactService,
    private readonly files: FileStore,
    private readonly agents: AgentRuntime,
    options: AnalysisOptions,
  ) {
    if (
      !Number.isSafeInteger(options.timeoutMs ?? 180000) ||
      (options.timeoutMs ?? 180000) < 1 ||
      (options.timeoutMs ?? 180000) > 3600000
    )
      fail("analysis-configuration");
    for (const value of Object.values(options.limits)) integer(value);
    if (
      options.limits.max_input_bytes > 16 * 1024 * 1024 ||
      options.limits.max_chunk_bytes > 16 * 1024 * 1024 ||
      options.limits.metadata_max_output_tokens > 131072 ||
      options.limits.content_max_output_tokens > 131072
    )
      fail("analysis-configuration");
    this.options = { ...options, limits: { ...options.limits } };
  }
  async analyzeContent(
    literatureId: string,
    signal?: AbortSignal,
  ): Promise<AnalysisResult> {
    const deadline = new AbortController();
    const active = AbortSignal.any([
      this.stop.signal,
      deadline.signal,
      ...(signal ? [signal] : []),
    ]);
    const timer = setTimeout(
      () => deadline.abort(),
      this.options.timeoutMs ?? 180000,
    );
    const check = () => {
      if (!active.aborted) return;
      fail(
        signal?.aborted || this.stop.signal.aborted
          ? "analysis-cancelled"
          : "analysis-timeout",
      );
    };
    try {
      check();
      const detail = await this.library.detail(literatureId);
      const baseline = identity(detail);
      const limits = this.options.limits;
      if (
        detail.parser_result === null ||
        detail.primary_pdf === null ||
        detail.parser_result.markdown.byte_size > limits.max_input_bytes ||
        limits.max_total_llm_requests < 2 ||
        limits.metadata_max_output_tokens + limits.content_max_output_tokens >
          limits.max_total_output_tokens
      )
        fail("analysis-content-budget");
      const chunks = Math.ceil(
        detail.parser_result.markdown.byte_size / limits.max_chunk_bytes,
      );
      if (chunks > limits.max_chunk_count)
        fail(
          chunks === 1
            ? "analysis-content-budget"
            : "analysis-content-chunking-unsupported",
        );
      const parser = detail.parser_result;
      const markdownBytes = await this.artifacts.withArtifact(
        parser.markdown,
        async (parts) => {
          const values: Buffer[] = [];
          for await (const part of parts) values.push(Buffer.from(part));
          return Buffer.concat(values);
        },
        { maxBytes: limits.max_input_bytes, signal: active },
      );
      check();
      const markdown = new TextDecoder("utf-8", { fatal: true }).decode(
        markdownBytes,
      );
      if (
        markdownBytes.byteLength !== parser.markdown.byte_size ||
        createHash("sha256").update(markdownBytes).digest("hex") !==
          parser.markdown.sha256 ||
        !markdown.trim() ||
        markdown.includes("\u0000")
      )
        fail("analysis-content-artifact-read");
      const baselineBytes = Buffer.from(contentCanonicalJsonBytes(baseline));
      const current = async () => {
        const now = identity(await this.library.detail(literatureId));
        return Buffer.from(contentCanonicalJsonBytes(now)).equals(
          baselineBytes,
        );
      };
      if (!(await current())) fail("analysis-content-input-stale");
      const binding = this.agents.identity("analysis");
      let modelCalls = 0;
      const execute = async (
        input: Record<string, unknown>,
        schema: Record<string, unknown>,
        maxOutputTokens: number,
      ): Promise<{
        value: Record<string, unknown>;
        provider: string;
        model: string;
        usage: { input_tokens: number; output_tokens: number };
      }> => {
        check();
        const inputBytes = contentCanonicalJsonBytes(input);
        const call: AgentCall = {
          role: "analysis",
          required_capabilities: ["structured_text"],
          input_sha256: createHash("sha256").update(inputBytes).digest("hex"),
          messages: [
            {
              role: "system",
              parts: [
                {
                  media_type: "text/plain",
                  text: "You perform a bounded SciRetriever Analysis stage. Return only the requested JSON schema and preserve source facts.",
                },
              ],
            },
            {
              role: "user",
              parts: [
                {
                  media_type: "application/json",
                  text: new TextDecoder().decode(inputBytes),
                },
              ],
            },
          ],
          response_schema: schema,
          max_output_tokens: maxOutputTokens,
        };
        modelCalls += 1;
        if (modelCalls > 2) fail("analysis-budget");
        let result;
        try {
          result = await this.agents.execute(call, active);
        } catch (error) {
          if (active.aborted) check();
          throw new AnalysisFailure(
            error instanceof Error &&
            "code" in error &&
            (error as { code?: string }).code === "agent-cancelled"
              ? "analysis-cancelled"
              : "analysis-response",
          );
        }
        if (result.kind !== "structured") fail("analysis-response");
        return {
          value: structuredClone(result.value),
          provider: result.provenance.provider,
          model: result.provenance.model,
          usage: result.provenance.usage,
        };
      };
      const metadataSchema = {
        type: "object",
        additionalProperties: false,
        properties: {
          outcome: { type: "string", enum: ["usable", "no_usable_content"] },
          metadata: {
            anyOf: [
              { type: "null" },
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  title: { anyOf: [{ type: "string" }, { type: "null" }] },
                  authors: {
                    type: "array",
                    items: {
                      type: "object",
                      additionalProperties: false,
                      properties: {
                        kind: {
                          type: "string",
                          enum: ["person", "organization", "unknown"],
                        },
                        display_name: { type: "string" },
                        given_name: {
                          anyOf: [{ type: "string" }, { type: "null" }],
                        },
                        family_name: {
                          anyOf: [{ type: "string" }, { type: "null" }],
                        },
                        orcid: {
                          anyOf: [{ type: "string" }, { type: "null" }],
                        },
                        affiliations: {
                          type: "array",
                          items: {
                            type: "object",
                            additionalProperties: false,
                            properties: {
                              name: { type: "string" },
                              ror: {
                                anyOf: [{ type: "string" }, { type: "null" }],
                              },
                            },
                            required: ["name", "ror"],
                          },
                        },
                      },
                      required: [
                        "kind",
                        "display_name",
                        "given_name",
                        "family_name",
                        "orcid",
                        "affiliations",
                      ],
                    },
                  },
                  abstract: { anyOf: [{ type: "string" }, { type: "null" }] },
                  publication_date: {
                    anyOf: [{ type: "string" }, { type: "null" }],
                  },
                  publication_year: {
                    anyOf: [{ type: "integer" }, { type: "null" }],
                  },
                  document_type: {
                    anyOf: [{ type: "string" }, { type: "null" }],
                  },
                  language: { anyOf: [{ type: "string" }, { type: "null" }] },
                  venue: { anyOf: [{ type: "string" }, { type: "null" }] },
                  publisher: { anyOf: [{ type: "string" }, { type: "null" }] },
                  volume: { anyOf: [{ type: "string" }, { type: "null" }] },
                  issue: { anyOf: [{ type: "string" }, { type: "null" }] },
                  pages: { anyOf: [{ type: "string" }, { type: "null" }] },
                  identifiers: {
                    type: "array",
                    items: {
                      type: "object",
                      additionalProperties: false,
                      properties: {
                        namespace: { type: "string" },
                        value: { type: "string" },
                      },
                      required: ["namespace", "value"],
                    },
                  },
                  keywords: { type: "array", items: { type: "string" } },
                },
                required: [
                  "title",
                  "authors",
                  "abstract",
                  "publication_date",
                  "publication_year",
                  "document_type",
                  "language",
                  "venue",
                  "publisher",
                  "volume",
                  "issue",
                  "pages",
                  "identifiers",
                  "keywords",
                ],
              },
            ],
          },
        },
        required: ["outcome", "metadata"],
      } as Record<string, unknown>;
      const metadataCall = await execute(
        {
          stage: "metadata",
          parser: {
            source_asset_id: parser.source_asset_id,
            source_sha256: parser.source_sha256,
            result_sha256: parser.result_sha256,
            markdown_sha256: parser.markdown.sha256,
            page_count: parser.page_count,
          },
          initial_metadata: detail.literature.metadata,
          input_metadata_revision: detail.metadata_revision,
          input_metadata_sha256: detail.metadata_sha256,
          parser_markdown: markdown,
        },
        metadataSchema,
        limits.metadata_max_output_tokens,
      );
      const metadataResponse = metadataCall.value;
      if (metadataResponse.outcome === "no_usable_content") {
        if (metadataResponse.metadata !== null || !(await current()))
          fail("analysis-content-contract");
        return { outcome: "no_usable_content", input: baseline };
      }
      if (metadataResponse.outcome !== "usable")
        fail("analysis-metadata-structure");
      let finalMetadata: LiteratureMetadata;
      try {
        finalMetadata = parseLiteratureMetadata(metadataResponse.metadata);
        validateMetadataProposal(
          detail.literature.metadata,
          finalMetadata,
          markdown,
        );
      } catch (error) {
        if (error instanceof AnalysisRuleError)
          throw new AnalysisFailure(`analysis-${error.code}`);
        throw new AnalysisFailure("analysis-metadata-proposal");
      }
      const contentSchema = {
        type: "object",
        additionalProperties: false,
        properties: { markdown: { type: "string" } },
        required: ["markdown"],
      } as Record<string, unknown>;
      const contentCall = await execute(
        {
          stage: "content",
          parser_result: parser,
          parser_markdown: markdown,
          final_metadata: finalMetadata,
        },
        contentSchema,
        limits.content_max_output_tokens,
      );
      if (
        contentCall.value.markdown !== undefined &&
        typeof contentCall.value.markdown !== "string"
      )
        fail("analysis-content-draft");
      let parsed;
      try {
        parsed = parseContentDraft(
          String(contentCall.value.markdown ?? ""),
          parser,
          markdown,
        );
      } catch (error) {
        throw new AnalysisFailure(
          error instanceof AnalysisRuleError
            ? `analysis-${error.code}`
            : "analysis-content-draft",
        );
      }
      if (!(await current())) fail("analysis-content-input-stale");
      const rendered = renderCanonicalMarkdown(
        finalMetadata,
        parsed.sections,
        parsed.references,
      );
      const markdownRef = parseArtifactRef({
        media_type: "text/markdown",
        byte_size: rendered.byteLength,
        sha256: createHash("sha256").update(rendered).digest("hex"),
      });
      const stage = await this.files.stage({ maxBytes: rendered.byteLength });
      try {
        await stage.write(rendered);
        await this.files.publish(stage, `objects/${markdownRef.sha256}.bin`);
      } finally {
        await stage.discard();
      }
      const finalMetadataSha = metadataHash(finalMetadata);
      const provenance = {
        provenance_id: randomUUID(),
        source_kind: "analysis" as const,
        source_name: `${contentCall.provider}/${contentCall.model}`,
        source_record_id: null,
        observed_at: new Date().toISOString(),
        input_sha256: await analysisInputSha256(
          baseline.primary_pdf_sha256,
          baseline.parser_result_sha256,
          finalMetadataSha,
        ),
        parameters_sha256: createHash("sha256")
          .update(
            contentCanonicalJsonBytes({
              schema: "sciretriever-analysis-content-parameters-v1",
              binding,
              metadata_output_tokens: limits.metadata_max_output_tokens,
              content_output_tokens: limits.content_max_output_tokens,
            }),
          )
          .digest("hex"),
      };
      const proposal = await parseLiteratureContentProposal({
        ...baseline,
        final_metadata: finalMetadata,
        metadata_sha256: finalMetadataSha,
        sections: parsed.sections,
        references: parsed.references,
        literature_content_sha256: await (async () =>
          createHash("sha256")
            .update(
              contentCanonicalJsonBytes({
                metadata_sha256: finalMetadataSha,
                sections: parsed.sections,
                references: parsed.references,
              }),
            )
            .digest("hex"))(),
        markdown: markdownRef,
        provenance,
      });
      return { outcome: "proposal", proposal, markdownBytes: rendered };
    } catch (error) {
      if (error instanceof AnalysisFailure) throw error;
      if (error instanceof Error && error.message.includes("UTF-8"))
        throw new AnalysisFailure("analysis-content-artifact-read");
      throw new AnalysisFailure("analysis-failed");
    } finally {
      clearTimeout(timer);
      deadline.abort();
    }
  }
  close(): void {
    this.stop.abort();
  }
}
