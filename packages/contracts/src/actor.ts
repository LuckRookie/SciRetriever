import { ContractValidationError } from "./index.js";

/** Read projection; raw identity remains available in technical details. */
export interface ActorPresentation {
  readonly actor: string | null;
  readonly actor_label: string;
}
export function parseActorPresentation(value: unknown): ActorPresentation {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ContractValidationError();
  const r = value as Record<string, unknown>;
  if (
    (r.actor !== null && typeof r.actor !== "string") ||
    typeof r.actor_label !== "string" ||
    !r.actor_label.trim()
  )
    throw new ContractValidationError();
  return { actor: r.actor as string | null, actor_label: r.actor_label };
}
