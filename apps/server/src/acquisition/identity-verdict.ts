export type IdentityDisposition = "accepted" | "rejected" | "uncertain";
export interface IdentityEvidence {
  readonly kind: "identifier" | "version" | "content";
  readonly value: string;
}
export interface IdentityVerdict {
  readonly disposition: IdentityDisposition;
  readonly evidence: readonly IdentityEvidence[];
}
export class IdentityVerdictError extends Error {
  readonly code = "identity-verdict" as const;
  constructor() {
    super("identity verdict failed");
    this.name = "IdentityVerdictError";
  }
}

export function judgeIdentity(input: {
  readonly targetIdentifier: string;
  readonly candidateIdentifier?: string;
  readonly targetVersion?: string;
  readonly candidateVersion?: string;
  readonly isPdf: boolean;
}): IdentityVerdict {
  if (
    typeof input.targetIdentifier !== "string" ||
    input.targetIdentifier.length === 0
  )
    throw new IdentityVerdictError();
  const evidence: IdentityEvidence[] = [];
  if (!input.isPdf)
    return Object.freeze({
      disposition: "rejected",
      evidence: Object.freeze(evidence),
    });
  if (
    input.candidateIdentifier === undefined ||
    input.candidateIdentifier !== input.targetIdentifier
  )
    return Object.freeze({
      disposition: "uncertain",
      evidence: Object.freeze(evidence),
    });
  evidence.push({ kind: "identifier", value: input.targetIdentifier });
  if (
    input.targetVersion !== undefined &&
    input.candidateVersion !== input.targetVersion
  )
    return Object.freeze({
      disposition: "uncertain",
      evidence: Object.freeze(evidence),
    });
  if (input.candidateVersion !== undefined)
    evidence.push({ kind: "version", value: input.candidateVersion });
  evidence.push({ kind: "content", value: "pdf-basic-acceptance" });
  return Object.freeze({
    disposition: "accepted",
    evidence: Object.freeze(evidence),
  });
}
