import {
  createInputManifest,
  processorExact,
  processorJson,
  processorText,
  type ProcessorInvocation,
  type ProcessorObject,
  type ProcessorInput,
} from "@sciretriever/contracts";
import {
  knowledgeMethodDefinition,
  type KnowledgeAnalysisService,
} from "./knowledge.js";
import { longMethodParameters } from "./knowledge-long.js";
import {
  processorError,
  type Processor,
  type ProcessorRegistry,
} from "./processor.js";

export function documentManifest(
  input: Extract<ProcessorInput, { kind: "document" }>,
) {
  return createInputManifest([
    {
      input_id: input.input_id,
      literature_id: input.document.source_material_ref.literature_id,
      material: input.document.source_material_ref,
      document: input.document,
      capabilities: [
        "material-file-v1",
        "document-segment-v1",
        "document-text-v1",
      ],
      gaps: [],
    },
  ]);
}
export function onlyDocument(
  invocation: ProcessorInvocation,
): Extract<ProcessorInput, { kind: "document" }> {
  const input = invocation.inputs[0];
  if (invocation.inputs.length !== 1 || input?.kind !== "document")
    processorError("processor-document-required");
  return input;
}
export function registerLegacyProcessors(
  registry: ProcessorRegistry,
  service: KnowledgeAnalysisService | null,
): void {
  for (const variant of ["overview", "detailed", "question", "long"] as const) {
    const long = variant === "long";
    const p: Processor = {
      id: `knowledge-${variant}`,
      version: "1",
      scope: "document",
      accepts: ["document"],
      model: true,
      output_kind: "knowledge",
      definition: processorJson(
        long
          ? longMethodParameters(undefined, "bound-separately")
          : knowledgeMethodDefinition(),
      ),
      spec_schema: {
        type: "object",
        properties: {
          question: { type: ["string", "null"] },
          ...(long
            ? { purpose: { enum: ["overview", "detailed", "question"] } }
            : {}),
        },
        additionalProperties: false,
      },
      normalizeSpec(value) {
        const purpose = long ? (value.purpose ?? "overview") : variant;
        if (!["overview", "detailed", "question"].includes(String(purpose)))
          processorError("processor-spec");
        const spec = {
          ...(long ? { purpose } : {}),
          question: value.question ?? null,
        };
        if (Object.keys(value).some((k) => !Object.hasOwn(spec, k)))
          processorError("processor-spec");
        if (purpose === "question") processorText(spec.question, 4096);
        else if (spec.question !== null) processorError("processor-spec");
        return processorJson(spec);
      },
      async run(invocation, ctx) {
        if (!service) processorError("processor-execution-unavailable");
        const input = onlyDocument(invocation);
        const segments = await ctx.readDocument(input);
        const purpose = (long ? invocation.spec.purpose : variant) as
          | "overview"
          | "detailed"
          | "question";
        const request = {
          schema_version: 1 as const,
          input: await documentManifest(input),
          purpose,
          question: invocation.spec.question as string | null,
          default_update: null,
        };
        const receipt = long
          ? await service.analyzeLong(
              { ...request, schema_version: 2 },
              ctx.signal,
            )
          : await service.analyze(request, ctx.signal);
        return {
          status: "ok",
          content: {
            kind: "knowledge",
            artifact_id: receipt.artifact.artifact_id,
            content_sha256: receipt.artifact.content_ref.sha256,
          },
          coverage: [
            {
              input_id: input.input_id,
              status: "complete",
              read_segments: segments.map((s) => s.segment_id),
              gaps: receipt.artifact.coverage.capability_gaps,
            },
          ],
          provenance: processorJson(receipt.artifact.provenance),
        };
      },
    };
    registry.register(p);
  }
}

export function questionSpec(value: ProcessorObject): ProcessorObject {
  const r = processorExact(value, ["question", "policy"]);
  if (r.policy !== "require-all" && r.policy !== "allow-partial")
    processorError("processor-spec");
  return { question: processorText(r.question, 4096), policy: r.policy };
}
