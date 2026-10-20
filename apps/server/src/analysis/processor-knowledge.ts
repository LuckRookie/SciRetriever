import {
  processorText,
  processorJson,
  type ProcessorInvocation,
  type ArchiveProcessorInput,
} from "@sciretriever/contracts";
import { processorError, type Processor } from "./processor.js";
import { documentAnalysisParameters } from "./knowledge-session.js";
export function onlyDocument(
  invocation: ProcessorInvocation,
): ArchiveProcessorInput {
  const input = invocation.inputs[0];
  if (invocation.inputs.length !== 1 || input?.kind !== "archive-document")
    processorError("processor-archive-document-required");
  return input;
}
export const summaryProcessor: Processor = {
  id: "summary",
  version: "2",
  scope: "document",
  accepts: ["archive-document"],
  reads: { parts: "main", roles: "all" },
  model: true,
  output_kind: "report",
  definition: processorJson(
    documentAnalysisParameters(undefined, "bound-separately"),
  ),
  spec_schema: {
    type: "object",
    properties: {
      purpose: { enum: ["overview", "detailed", "question"] },
      question: { type: ["string", "null"] },
    },
    additionalProperties: false,
  },
  normalizeSpec(value) {
    if (Object.keys(value).some((k) => !["purpose", "question"].includes(k)))
      processorError("processor-spec");
    const purpose = value.purpose ?? "overview",
      question = value.question ?? null;
    if (!["overview", "detailed", "question"].includes(String(purpose)))
      processorError("processor-spec");
    if (purpose === "question") processorText(question, 4096);
    else if (question !== null) processorError("processor-spec");
    return { purpose, question };
  },
  async run(invocation, ctx) {
    const input = onlyDocument(invocation),
      result = await ctx.summarize(
        input,
        invocation.spec.purpose as "overview" | "detailed" | "question",
        invocation.spec.question as string | null,
      );
    const segments = result.content ? await ctx.readDocument(input) : [],
      claims =
        result.content?.statements.map((s) => ({
          record_id: s.statement_id,
          text: s.text,
          sources: s.evidence.map((evidence) => ({
            kind: "document" as const,
            evidence,
          })),
        })) ?? [];
    return {
      status: claims.length ? "ok" : "empty",
      content: {
        kind: "report",
        text: claims.map((c, n) => `${c.text} [${n + 1}]`).join("\n\n"),
        claims,
      },
      coverage: [
        {
          input_id: input.input_id,
          status: "complete",
          read_segments: segments.map((s) => s.segment_id),
          gaps: [],
        },
      ],
      provenance: {
        limitations: [...result.gaps],
        session: "dsh-document-analysis",
      },
    };
  },
};
