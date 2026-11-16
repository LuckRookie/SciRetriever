import { artifactReference } from "../storage/artifact-layout.js";
import {
  canonicalJsonBytes,
  parseCandidatePublicationIntent,
  sha256,
  type Asset,
  type CandidatePublicationIntent,
  type CandidatePublicationReceipt,
  type LiteratureCurrentFacts,
  type MetadataSnapshot,
} from "@sciretriever/contracts";
import {
  requireCurrentCandidate,
  LiteraturePublicationError,
} from "../literature/primary-pdf.js";
import { BrowserTransferCollector } from "../browser/transfer.js";
import { CandidatePublisher } from "./candidate-publication.js";
import { acceptPdfFile } from "./pdf-acceptance.js";

export interface AcceptCandidateCommand {
  readonly source_url?: string | null;
  readonly receipt_id: string;
  readonly literature_id: string;
  readonly transfer_id: string;
  readonly metadata_snapshot: MetadataSnapshot;
}
export interface CandidateAcceptanceRepository {
  currentFacts(literatureId: string): Promise<LiteratureCurrentFacts | null>;
  assetByHash(hash: string): Promise<Asset | null>;
  getReceiptIntent(
    receiptId: string,
  ): Promise<CandidatePublicationIntent | null>;
}
export class CandidateAcceptanceError extends Error {
  constructor(
    readonly code:
      | "candidate-command-invalid"
      | "candidate-not-found"
      | "literature-not-found"
      | "candidate-cancelled"
      | "candidate-receipt-conflict",
  ) {
    super("candidate acceptance failed");
  }
}
function validate(command: AcceptCandidateCommand): void {
  if (
    !command ||
    Object.keys(command)
      .filter((k) => k !== "source_url")
      .sort()
      .join() !== "literature_id,metadata_snapshot,receipt_id,transfer_id" ||
    typeof command.literature_id !== "string" ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(
      command.literature_id,
    ) ||
    [command.receipt_id, command.transfer_id].some(
      (value) =>
        typeof value !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/u.test(value),
    ) ||
    !command.metadata_snapshot ||
    Object.keys(command.metadata_snapshot).sort().join() !==
      "revision,sha256" ||
    !Number.isSafeInteger(command.metadata_snapshot.revision) ||
    command.metadata_snapshot.revision < 1 ||
    typeof command.metadata_snapshot.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(command.metadata_snapshot.sha256)
  )
    throw new CandidateAcceptanceError("candidate-command-invalid");
}
async function stableId(scope: string, value: unknown): Promise<string> {
  const hash = await sha256(canonicalJsonBytes({ scope, value }));
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

/** The command carries IDs and a CAS baseline; callers cannot supply an identity verdict or output path. */
export class CandidateAcceptanceService {
  constructor(
    private readonly repository: CandidateAcceptanceRepository,
    private readonly collector: BrowserTransferCollector,
    private readonly publisher: CandidatePublisher,
    private readonly intakeBatchId?: string,
  ) {}
  async accept(
    command: AcceptCandidateCommand,
    signal?: AbortSignal,
  ): Promise<CandidatePublicationReceipt> {
    validate(command);
    // Copy the caller's baseline before yielding to I/O.
    const input = {
      ...command,
      metadata_snapshot: { ...command.metadata_snapshot },
    };
    const check = () => {
      if (signal?.aborted)
        throw new CandidateAcceptanceError("candidate-cancelled");
    };
    check();
    const previous = await this.repository.getReceiptIntent(input.receipt_id);
    check();
    if (previous) {
      if (
        (input.source_url !== undefined &&
          previous.source_url !== input.source_url) ||
        previous.literature_id !== input.literature_id ||
        previous.candidate.transfer_id !== input.transfer_id ||
        previous.metadata_snapshot.revision !==
          input.metadata_snapshot.revision ||
        previous.metadata_snapshot.sha256 !== input.metadata_snapshot.sha256
      )
        throw new CandidateAcceptanceError("candidate-receipt-conflict");
      return this.publisher.publish(previous);
    }
    const candidate = await this.collector.recover(input.transfer_id);
    if (!candidate) throw new CandidateAcceptanceError("candidate-not-found");
    const facts = await this.repository.currentFacts(input.literature_id);
    if (!facts) throw new CandidateAcceptanceError("literature-not-found");
    // Reject stale or misattributed inputs before invoking PDF tools.
    requireCurrentCandidate(facts, input.metadata_snapshot, candidate);
    const userSupplied =
      candidate.source_name === "manual-pdf" ||
      candidate.source_name === "import" ||
      candidate.source_name === "web-capture";
    if (userSupplied && facts.primary_asset)
      throw new LiteraturePublicationError("primary-asset-conflict");
    check();
    // Acquisition establishes file validity, not article identity. Parsing may
    // later verify the association using the complete document and metadata.
    await this.collector.withCandidate(
      candidate,
      (file) => acceptPdfFile(file, 10000, signal),
      signal ? { signal } : {},
    );
    const existing =
      facts.primary_asset ??
      (await this.repository.assetByHash(candidate.sha256));
    if (
      existing &&
      (existing.media_type !== "application/pdf" ||
        existing.size_bytes !== candidate.size_bytes)
    )
      throw new LiteraturePublicationError("primary-asset-conflict");
    const assetId =
      existing?.asset_id ?? (await stableId("pdf-asset", candidate.sha256));
    const intent = parseCandidatePublicationIntent({
      ...(this.intakeBatchId ? { intake_batch_id: this.intakeBatchId } : {}),
      receipt_id: input.receipt_id,
      literature_id: input.literature_id,
      metadata_snapshot: input.metadata_snapshot,
      candidate,
      asset_id: assetId,
      literature_asset_id: await stableId("primary-pdf", {
        literature_id: input.literature_id,
        asset_id: assetId,
      }),
      target:
        existing?.path ??
        artifactReference("original-pdf", {
          sha256: candidate.sha256,
          media_type: "application/pdf",
        }),
      provenance: {
        provenance_id: await stableId("candidate-publication", input),
        source_kind: userSupplied ? "user" : "asset-provider",
        source_name: candidate.source_name,
        source_record_id: userSupplied
          ? null
          : (candidate.source_record_id ?? candidate.transfer_id),
        observed_at: candidate.capture!.captured_at,
        input_sha256: candidate.sha256,
        parameters_sha256: null,
      },
      source_url: userSupplied
        ? (input.source_url ?? null)
        : candidate.capture!.source_url,
      identity: "unverified",
    });
    check();
    // Once publication begins it completes or leaves a durable receipt for reconciliation.
    return this.publisher.publish(intent);
  }
}
