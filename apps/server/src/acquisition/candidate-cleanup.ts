import {
  parseAnalysisInputIdentity,
  parseDurableCandidate,
  parseCandidatePublicationIntent,
  parseCandidatePublicationReceipt,
  type AnalysisInputIdentity,
  type DurableCandidate,
} from "@sciretriever/contracts";
export interface CandidateCleanupSnapshot {
  readonly candidates: readonly { transfer_id: string; record_json: string }[];
  readonly receipts: readonly {
    receipt_id: string;
    transfer_id: string;
    intent_json: string;
    result_json: string | null;
  }[];
}
export interface CandidateCleanupDecision {
  readonly transfer_ids: readonly string[];
  readonly receipt_ids: readonly string[];
}
/** Acquisition owns which execution records belong to the rejected input; other articles retain their evidence. */
export function prepareCandidateCleanup(
  value: AnalysisInputIdentity,
  snapshot: CandidateCleanupSnapshot,
): CandidateCleanupDecision {
  const input = parseAnalysisInputIdentity(value);
  const candidates = new Map<string, DurableCandidate>();
  for (const row of snapshot.candidates) {
    const c = parseDurableCandidate(JSON.parse(row.record_json));
    if (c.transfer_id !== row.transfer_id || candidates.has(c.transfer_id))
      throw new Error("invalid candidate cleanup snapshot");
    candidates.set(c.transfer_id, c);
  }
  const removedReceipts = new Set<string>(),
    affectedTransfers = new Set<string>(),
    retainedTransfers = new Set<string>();
  const seen = new Set<string>();
  for (const row of snapshot.receipts) {
    const intent = parseCandidatePublicationIntent(JSON.parse(row.intent_json));
    if (
      intent.receipt_id !== row.receipt_id ||
      intent.candidate.transfer_id !== row.transfer_id ||
      JSON.stringify(candidates.get(row.transfer_id)) !==
        JSON.stringify(intent.candidate) ||
      seen.has(row.receipt_id)
    )
      throw new Error("invalid candidate cleanup snapshot");
    seen.add(row.receipt_id);
    if (row.result_json !== null) {
      const r = parseCandidatePublicationReceipt(JSON.parse(row.result_json));
      if (
        r.receipt_id !== intent.receipt_id ||
        r.asset_id !== intent.asset_id ||
        r.literature_id !== intent.literature_id ||
        r.sha256 !== intent.candidate.sha256 ||
        r.reference !== intent.target
      )
        throw new Error("invalid candidate cleanup snapshot");
    }
    if (
      intent.literature_id === input.literature_id &&
      intent.candidate.sha256 === input.primary_pdf_sha256
    ) {
      removedReceipts.add(row.receipt_id);
      affectedTransfers.add(row.transfer_id);
    } else retainedTransfers.add(row.transfer_id);
  }
  return {
    receipt_ids: [...removedReceipts].sort(),
    transfer_ids: [...candidates.values()]
      .filter(
        (c) =>
          c.sha256 === input.primary_pdf_sha256 &&
          !retainedTransfers.has(c.transfer_id) &&
          (c.capture?.article_id === input.literature_id ||
            (c.capture === null && affectedTransfers.has(c.transfer_id))),
      )
      .map((c) => c.transfer_id)
      .sort(),
  };
}
