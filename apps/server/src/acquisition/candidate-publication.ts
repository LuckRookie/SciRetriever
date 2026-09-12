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
  readonly identity: "accepted" | "rejected" | "uncertain";
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

/** Acquisition orders immutable bytes before the atomic fact + receipt transaction. */
export class CandidatePublisher {
  constructor(
    private readonly collector: BrowserTransferCollector,
    private readonly repository: CandidatePublicationRepository,
  ) {}

  publish(input: CandidatePublicationInput): Promise<CandidatePublication> {
    const copy = structuredClone(input);
    return this.collector.withPublication(() => this.publishAdmitted(copy));
  }
  private async publishAdmitted(
    input: CandidatePublicationInput,
  ): Promise<CandidatePublication> {
    let bytesPublished = false;
    try {
      const intent = parseCandidatePublicationIntent(input);
      const previous = await this.repository.prepareReceipt(intent);
      if (previous) {
        bytesPublished = true;
        await this.collector.verifyPublished(
          intent.candidate,
          previous.reference,
        );
        return previous;
      }
      const published = await this.collector.publish(
        intent.candidate,
        intent.target,
      );
      bytesPublished = true;
      if (
        published.sha256 !== intent.candidate.sha256 ||
        published.size !== intent.candidate.size_bytes
      )
        throw new Error("candidate publication integrity mismatch");
      return await this.repository.commitReceipt(intent, published.created);
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
