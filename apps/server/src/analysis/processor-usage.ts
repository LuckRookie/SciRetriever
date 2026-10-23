import type { ProcessorResult } from "@sciretriever/contracts";
export function processorUsage(result: ProcessorResult) {
  const total = { calls: 0, input_tokens: 0, output_tokens: 0 };
  const values = result.provenance.model_calls;
  if (!Array.isArray(values)) return null;
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return null;
    const usage = value.usage;
    if (!usage || typeof usage !== "object" || Array.isArray(usage))
      return null;
    const calls = value.accounting === "session-aggregate" ? value.calls : 1;
    if (
      ![calls, usage.input_tokens, usage.output_tokens].every(
        (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0,
      )
    )
      return null;
    total.calls += Number(calls);
    total.input_tokens += Number(usage.input_tokens);
    total.output_tokens += Number(usage.output_tokens);
  }
  const check = result.provenance.value_check_usage;
  if (check && typeof check === "object" && !Array.isArray(check))
    for (const key of ["calls", "input_tokens", "output_tokens"] as const) {
      const n = check[key];
      if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0)
        return null;
      total[key] += n;
    }
  return total;
}
