export const PROCESSOR_METHOD_REVISION = "text-evidence-hierarchical-v2";
import type { ProcessorResult } from "./processors.js";
import { ContractValidationError } from "./index.js";
export interface ProcessorOutcomeCounts {
  readonly with_result: number;
  readonly empty: number;
  readonly incomplete: number;
}
export function parseProcessorOutcomeCounts(
  value: unknown,
): ProcessorOutcomeCounts {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== "empty,incomplete,with_result"
  )
    throw new ContractValidationError();
  const r = value as Record<string, unknown>;
  if (Object.values(r).some((n) => !Number.isSafeInteger(n) || Number(n) < 0))
    throw new ContractValidationError();
  return {
    with_result: Number(r.with_result),
    empty: Number(r.empty),
    incomplete: Number(r.incomplete),
  };
}
/** Count papers, never parts or records. Incomplete reading takes precedence. */
type OutcomeInput = Pick<
  ProcessorResult,
  "literature_ids" | "coverage" | "content"
> & { readonly invocation: Pick<ProcessorResult["invocation"], "inputs"> };
export function processorOutcomeCounts(
  result: OutcomeInput,
  mapped: readonly OutcomeInput[] = [],
): ProcessorOutcomeCounts {
  const counts = { with_result: 0, empty: 0, incomplete: 0 };
  const parts = result.coverage.flatMap((c) => c.parts);
  const ids = new Set([
    ...result.literature_ids,
    ...parts.map((p) => p.literature_id),
  ]);
  const hasContent = (r: OutcomeInput) =>
    r.content.kind === "records"
      ? r.content.records.length > 0
      : r.content.text.trim().length > 0 || r.content.claims.length > 0;
  const isMapped = result.invocation.inputs.some((i) => i.kind === "snapshot");
  for (const id of ids) {
    const selected = parts.filter((p) => p.literature_id === id),
      sources = mapped.filter((r) => r.literature_ids.includes(id));
    if (
      selected.some((p) => p.outcome === "incomplete") ||
      (!selected.length &&
        result.coverage.some((c) => c.status !== "complete")) ||
      (isMapped && !sources.length)
    )
      counts.incomplete++;
    else if (isMapped ? sources.some(hasContent) : hasContent(result))
      counts.with_result++;
    else counts.empty++;
  }
  return counts;
}
