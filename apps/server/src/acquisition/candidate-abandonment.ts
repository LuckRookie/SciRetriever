import { parseDurableCandidate } from "@sciretriever/contracts";
import type { BrowserTransferCollector } from "../browser/transfer.js";
import type { ArtifactRecovery } from "../storage/files/recovery.js";
import type { SqliteWorker } from "../storage/sqlite/worker.js";
import type { CatalogWriteAdmission } from "../storage/write-admission.js";

export interface AbandonCandidateCommand {
  readonly article_id: string;
  readonly transfer_id: string;
  readonly sha256: string;
}
export interface CandidateAbandonmentResult {
  readonly transfer_id: string;
  readonly reclamation: {
    readonly deleted: readonly string[];
    readonly preserved: readonly string[];
    readonly missing: readonly string[];
  };
}
export class CandidateAbandonmentError extends Error {
  readonly code = "candidate-abandonment" as const;
  constructor(
    readonly catalog_committed: boolean,
    cause?: unknown,
  ) {
    super("candidate abandonment failed; evidence retained", { cause });
    this.name = "CandidateAbandonmentError";
  }
}

function command(value: unknown): AbandonCandidateCommand {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new CandidateAbandonmentError(false);
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).sort().join() !== "article_id,sha256,transfer_id" ||
    typeof input.article_id !== "string" ||
    typeof input.transfer_id !== "string" ||
    typeof input.sha256 !== "string" ||
    !/^[a-zA-Z0-9._:-]{1,128}$/u.test(input.article_id) ||
    !/^[a-zA-Z0-9._:-]{1,128}$/u.test(input.transfer_id) ||
    !/^[0-9a-f]{64}$/u.test(input.sha256)
  )
    throw new CandidateAbandonmentError(false);
  return {
    article_id: input.article_id,
    transfer_id: input.transfer_id,
    sha256: input.sha256,
  };
}

/** Acquisition retires only an unpublished Candidate and delegates bytes to recovery-safe reclamation. */
export class CandidateAbandonmentService {
  constructor(
    private readonly database: SqliteWorker,
    private readonly transfers: BrowserTransferCollector,
    private readonly recovery: ArtifactRecovery,
    private readonly writes: CatalogWriteAdmission,
  ) {}

  abandon(
    value: unknown,
    signal?: AbortSignal,
  ): Promise<CandidateAbandonmentResult> {
    const input = command(value);
    return this.writes.run(async () => {
      let committed = false;
      try {
        if (signal?.aborted) throw new Error("cancelled");
        const candidate = await this.transfers.recover(input.transfer_id);
        if (
          !candidate ||
          candidate.sha256 !== input.sha256 ||
          candidate.capture?.article_id !== input.article_id
        )
          throw new Error("candidate mismatch");
        const parsed = parseDurableCandidate(candidate);
        const retired = {
          reference: parsed.reference,
          artifact: {
            sha256: parsed.sha256,
            byte_size: parsed.size_bytes,
            media_type: "application/pdf",
          },
        } as const;
        const ticket = await this.recovery.prepare([retired]);
        if (signal?.aborted) throw new Error("cancelled");
        const removed = await this.database.retireCandidate(parsed);
        if (!removed) throw new Error("candidate is in use or stale");
        committed = true;
        this.transfers.forgetRetired([parsed.transfer_id]);
        const reclamation = await this.recovery.complete(ticket);
        return Object.freeze({
          transfer_id: parsed.transfer_id,
          reclamation,
        });
      } catch (cause) {
        throw new CandidateAbandonmentError(committed, cause);
      }
    }, signal);
  }
}
