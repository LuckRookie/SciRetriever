import {
  parseCandidatePublicationIntent,
  type CandidatePublicationIntent,
  type MetadataSnapshot,
  type CandidatePublicationReceipt,
} from "@sciretriever/contracts";
import type { ObservationProvenance } from "../storage/sqlite/repositories.js";
import {
  BrowserTransferCollector,
  type DurableCandidate,
} from "../browser/transfer.js";
import { settlePreparedPublication } from "../storage/files/publication.js";

export interface CandidatePublicationInput {
  readonly metadata_snapshot: MetadataSnapshot;
  readonly receipt_id: string;
  readonly candidate: DurableCandidate;
  readonly literature_id: string;
  readonly asset_id: string;
  readonly literature_asset_id: string;
  readonly target: string;
  readonly provenance: ObservationProvenance;
  readonly source_url: string | null;
  readonly identity: "unverified" | "accepted" | "rejected" | "uncertain";
}
export type CandidatePublication = CandidatePublicationReceipt;
export class CandidatePublicationError extends Error {
  readonly code = "candidate-publication" as const;
  constructor(
    readonly bytes_published: boolean,
    cause?: unknown,
  ) {
    super("candidate publication operation failed", { cause });
    this.name = "CandidatePublicationError";
  }
}
export interface CandidatePublicationRepository {
  prepareReceipt(
    intent: CandidatePublicationIntent,
  ): Promise<CandidatePublicationReceipt | null>;
  commitReceipt(
    intent: CandidatePublicationIntent,
    created: boolean,
  ): Promise<CandidatePublicationReceipt>;
  pendingReceipts(): Promise<readonly CandidatePublicationIntent[]>;
}

function requireMatchingReceipt(
  intent: CandidatePublicationIntent,
  receipt: CandidatePublicationReceipt,
): CandidatePublicationReceipt {
  if (
    receipt.reference !== intent.target ||
    receipt.sha256 !== intent.candidate.sha256 ||
    receipt.receipt_id !== intent.receipt_id ||
    receipt.literature_id !== intent.literature_id ||
    receipt.asset_id !== intent.asset_id
  )
    throw new Error("candidate publication receipt mismatch");
  return receipt;
}

/** Acquisition orders immutable bytes before the atomic fact + receipt transaction. */
export class CandidatePublisher {
  constructor(
    private readonly collector: BrowserTransferCollector,
    private readonly repository: CandidatePublicationRepository,
  ) {}

  async publish(
    input: CandidatePublicationInput,
  ): Promise<CandidatePublication> {
    const copy = structuredClone(input);
    let bytesPublished = false;
    try {
      const intent = parseCandidatePublicationIntent(copy);
      const previous = await this.collector.withPublication(() =>
        this.repository.prepareReceipt(intent),
      );
      if (previous) {
        requireMatchingReceipt(intent, previous);
        bytesPublished = true;
        await this.collector.verifyPublished(
          intent.candidate,
          previous.reference,
        );
        return previous;
      }
      const prepared = await this.collector.preparePublication(
        intent.candidate,
        intent.target,
      );
      try {
        return await settlePreparedPublication(prepared, () =>
          this.collector.withPublication(async () => {
            const replay = await this.repository.prepareReceipt(intent);
            if (replay) {
              requireMatchingReceipt(intent, replay);
              bytesPublished = true;
            }
            const published = await this.collector.commitPrepared(prepared);
            bytesPublished = true;
            if (
              published.sha256 !== intent.candidate.sha256 ||
              published.size !== intent.candidate.size_bytes
            )
              throw new Error("candidate publication integrity mismatch");
            return (
              replay ??
              requireMatchingReceipt(
                intent,
                await this.repository.commitReceipt(intent, published.created),
              )
            );
          }),
        );
      } finally {
        await this.collector.releasePrepared(prepared);
      }
    } catch (cause) {
      throw new CandidatePublicationError(bytesPublished, cause);
    }
  }

  async reconcile(): Promise<readonly CandidatePublication[]> {
    const results: CandidatePublication[] = [];
    for (const intent of await this.repository.pendingReceipts())
      results.push(await this.publish(intent));
    return results;
  }
}
