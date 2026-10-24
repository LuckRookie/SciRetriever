import type {
  ArchiveProcessorInput,
  ProcessorCitation,
  ProcessorInvocation,
} from "@sciretriever/contracts";

/** Only summary's fixed whole main document can retain an unresolved segment claim. */
export function summaryCitationInput(
  invocation: ProcessorInvocation,
  citation: ProcessorCitation,
): ArchiveProcessorInput | null {
  const input = invocation.inputs[0];
  if (
    invocation.processor.id !== "summary" ||
    invocation.processor.version !== "2" ||
    invocation.execution.reads.parts !== "main" ||
    invocation.execution.reads.roles !== "all" ||
    invocation.inputs.length !== 1 ||
    input?.kind !== "archive-document" ||
    input.parts.length !== 1 ||
    citation.kind !== "document" ||
    citation.evidence.target_kind !== "document"
  )
    return null;
  const part = input.parts[0]!;
  return part.available &&
    part.part === "main" &&
    part.document_version_id === citation.evidence.document_version_id
    ? input
    : null;
}
