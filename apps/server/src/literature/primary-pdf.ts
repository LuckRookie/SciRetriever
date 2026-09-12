import type {
  DurableCandidate,
  LiteratureCurrentFacts,
  MetadataSnapshot,
} from "@sciretriever/contracts";

export class LiteraturePublicationError extends Error {
  constructor(
    readonly code:
      | "literature-stale"
      | "candidate-misattributed"
      | "candidate-uncertain"
      | "candidate-rejected"
      | "primary-asset-conflict",
  ) {
    super("literature publication refused");
  }
}

/** Literature owns current-fact admission. Acquisition supplies verified byte evidence. */
export function requireCurrentCandidate(
  facts: LiteratureCurrentFacts,
  expected: MetadataSnapshot,
  candidate: DurableCandidate,
): void {
  if (
    facts.metadata_snapshot.revision !== expected.revision ||
    facts.metadata_snapshot.sha256 !== expected.sha256
  )
    throw new LiteraturePublicationError("literature-stale");
  if (candidate.capture?.article_id !== facts.literature.literature_id)
    throw new LiteraturePublicationError("candidate-misattributed");
  if (
    facts.primary_asset &&
    (facts.primary_asset.sha256 !== candidate.sha256 ||
      facts.primary_asset.size_bytes !== candidate.size_bytes)
  )
    throw new LiteraturePublicationError("primary-asset-conflict");
}
export function admitPrimaryPdf(
  facts: LiteratureCurrentFacts,
  expected: MetadataSnapshot,
  candidate: DurableCandidate,
  disposition: "accepted" | "rejected" | "uncertain",
): void {
  requireCurrentCandidate(facts, expected, candidate);
  if (disposition !== "accepted")
    throw new LiteraturePublicationError(
      disposition === "rejected" ? "candidate-rejected" : "candidate-uncertain",
    );
}
