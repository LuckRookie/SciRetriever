import type { ArtifactRecovery } from "../storage/files/recovery.js";
import {
  parseDurableCandidate,
  type AnalysisInputIdentity,
} from "@sciretriever/contracts";
import { prepareCandidateCleanup } from "../acquisition/candidate-cleanup.js";
import type { BrowserTransferCollector } from "../browser/transfer.js";
import {
  ContentCleanupFailure,
  type LiteratureCleanupService,
  type RetiredArtifact,
} from "../literature/cleanup.js";
import type { ArtifactReclaimer } from "../storage/files/reclamation.js";
import type { SqliteWorker } from "../storage/sqlite/worker.js";
import type { CatalogWriteAdmission } from "../storage/write-admission.js";
export class NoUsableContentReclamationFailure extends Error {
  readonly code = "no-usable-content-reclamation";
  constructor(
    readonly input: AnalysisInputIdentity,
    readonly retired_artifacts: readonly RetiredArtifact[],
  ) {
    super("catalog cleanup committed; artifact reclamation requires retry");
  }
}
/** Entry combines owner decisions in one catalog transaction before reclaiming bytes. */
export class NoUsableContentService {
  constructor(
    private readonly literature: LiteratureCleanupService,
    private readonly repository: Pick<
      SqliteWorker,
      | "candidateCleanupSnapshot"
      | "cleanupNoUsableContent"
      | "contentCleanupSnapshot"
    >,
    private readonly recovery: ArtifactRecovery,
    private readonly writes: CatalogWriteAdmission,
    private readonly collector?: BrowserTransferCollector,
  ) {}
  cleanup(
    value: unknown,
    signal?: AbortSignal,
  ): Promise<{
    readonly outcome: "no_usable_content_cleaned";
    readonly input: AnalysisInputIdentity;
    readonly reclamation: Awaited<ReturnType<ArtifactReclaimer["reclaim"]>>;
  }> {
    const copy = structuredClone(value);
    return this.writes.run(async () => {
      const command = await this.literature.prepare(copy, signal);
      const execution = await this.repository.candidateCleanupSnapshot();
      const decision = prepareCandidateCleanup(command.input, execution);
      const captured = await this.repository.contentCleanupSnapshot(
        command.input.literature_id,
      );
      if (!captured || captured.token !== command.token)
        throw new ContentCleanupFailure("content-cleanup-stale");
      const candidates = execution.candidates
        .filter((row) => decision.transfer_ids.includes(row.transfer_id))
        .map((row) => {
          const candidate = parseDurableCandidate(JSON.parse(row.record_json));
          return {
            reference: candidate.reference,
            artifact: {
              sha256: candidate.sha256,
              byte_size: candidate.size_bytes,
              media_type: "application/pdf",
            },
          };
        });
      const ticket = await this.recovery.prepare([
        ...captured.artifacts,
        ...candidates,
      ]);
      if (signal?.aborted)
        throw new ContentCleanupFailure("content-cleanup-cancelled");
      const retired = await this.repository.cleanupNoUsableContent({
        ...command,
        candidate_cleanup: decision,
      });
      if (retired === null)
        throw new ContentCleanupFailure("content-cleanup-stale");
      this.collector?.forgetRetired(decision.transfer_ids);
      // A committed removal must finish/retry reclamation even if cancellation races the SQL commit.
      try {
        const reclamation = await this.recovery.complete(ticket);
        return {
          outcome: "no_usable_content_cleaned",
          input: command.input,
          reclamation,
        };
      } catch {
        throw new NoUsableContentReclamationFailure(
          command.input,
          ticket.artifacts,
        );
      }
    }, signal);
  }
}
