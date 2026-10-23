import { ContractValidationError } from "./index.js";

/** Caller-selected reading scope; chunking is owned by the operator method. */
export interface ProcessorReading {
  readonly scope: "full" | "search";
  readonly query: string | null;
}

export const PROCESSOR_READING_SCHEMA = {
  type: "object",
  properties: {
    scope: { enum: ["full", "search"] },
    query: { type: ["string", "null"] },
  },
  additionalProperties: false,
};

export function parseProcessorReading(value: unknown = {}): ProcessorReading {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ContractValidationError();
  const r = value as Record<string, unknown>;
  if (Object.keys(r).some((key) => !["scope", "query"].includes(key)))
    throw new ContractValidationError();
  const scope = r.scope ?? "full",
    query = r.query ?? null;
  if (scope !== "full" && scope !== "search")
    throw new ContractValidationError();
  if (
    scope === "full"
      ? query !== null
      : typeof query !== "string" || !query.trim() || query.length > 1024
  )
    throw new ContractValidationError();
  return Object.freeze({ scope, query: query as string | null });
}
