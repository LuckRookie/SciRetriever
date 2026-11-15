import { createHash, randomUUID } from "node:crypto";
import {
  importHash,
  type ImportFileStatus,
  type CandidatePublicationReceipt,
} from "@sciretriever/contracts";
import type { SqliteWorker } from "../storage/sqlite/worker.js";
import type { FileStore } from "../storage/files/store.js";
import type { CatalogWriteAdmission } from "../storage/write-admission.js";
import type { ArtifactRecovery } from "../storage/files/recovery.js";
import {
  CandidatePublicationError,
  CandidatePublisher,
} from "../acquisition/candidate-publication.js";
import { PdfAcceptanceError } from "../acquisition/pdf-acceptance.js";
import { LiteraturePublicationError } from "../literature/primary-pdf.js";
import { BrowserTransferCollector } from "../browser/transfer.js";
import {
  BrowserDownloadResourceError,
  type BrowserDownloadResources,
} from "../browser/resources.js";
import { CandidateAcceptanceService } from "../acquisition/candidate-acceptance.js";
import { CandidateAbandonmentService } from "../acquisition/candidate-abandonment.js";
export class ImportSessionError extends Error {
  constructor(
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super("Intake request rejected", options);
  }
}
export function intakeResourceFailure(error: unknown): unknown {
  let current: unknown = error;
  for (let i = 0; i < 8 && current && typeof current === "object"; i++) {
    if ("code" in current && current.code === "ENOSPC")
      return new ImportSessionError("intake-disk-space", { cause: error });
    if (current instanceof BrowserDownloadResourceError)
      return new ImportSessionError(
        current.code === "browser-download-disk-reserve"
          ? "intake-disk-space"
          : "intake-disk-unavailable",
        { cause: error },
      );
    current = "cause" in current ? current.cause : null;
  }
  return error;
}
/** Abort a waiting source without retaining a whole upload or waiting on an uncooperative iterator. */
export async function* uploadChunks(
  source: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
) {
  const iterator = source[Symbol.asyncIterator]();
  try {
    for (;;) {
      if (signal.aborted)
        throw new ImportSessionError("intake-upload-cancelled");
      const next = await new Promise<IteratorResult<Uint8Array>>(
        (resolve, reject) => {
          const abort = () =>
            reject(new ImportSessionError("intake-upload-cancelled"));
          signal.addEventListener("abort", abort, { once: true });
          Promise.resolve(iterator.next()).then(
            (value) => {
              signal.removeEventListener("abort", abort);
              resolve(value);
            },
            (error) => {
              signal.removeEventListener("abort", abort);
              reject(error);
            },
          );
          if (signal.aborted) abort();
        },
      );
      if (next.done) return;
      yield next.value;
    }
  } finally {
    void Promise.resolve()
      .then(() => iterator.return?.())
      .catch(() => undefined);
  }
}
type Asset = { asset_id: string; sha256: string } | null;
export function settleFileState(
  file: ImportFileStatus,
  sha256: string,
  asset: Asset,
  uploaded: boolean,
): ImportFileStatus {
  if (file.status !== "pending") {
    if (file.sha256 !== sha256)
      throw new ImportSessionError("intake-file-conflict");
    return file;
  }
  const mismatch =
    (file.expected_sha256 !== null && file.expected_sha256 !== sha256) ||
    asset?.sha256 !== sha256;
  return {
    ...file,
    status: mismatch ? "conflict" : uploaded ? "uploaded" : "existing",
    sha256,
    reason: mismatch ? "intake-file-conflict" : null,
  };
}
export type FileSettlement = (
  file: ImportFileStatus,
  sha256: string,
  asset: Asset,
  uploaded: boolean,
) => Promise<ImportFileStatus>;
/** Import and capture share byte streaming, replay, disk guards, PDF acceptance and CAS. */
export class ImportFileChannel {
  constructor(
    private readonly database: SqliteWorker,
    private readonly files: FileStore,
    private readonly writes: CatalogWriteAdmission,
    private readonly recovery: ArtifactRecovery,
    private readonly resources: BrowserDownloadResources,
    private readonly now: () => number,
  ) {}
  async reportHash(
    file: ImportFileStatus,
    sha256: string,
    settle: FileSettlement,
  ) {
    importHash(sha256);
    const facts = await this.database.currentFacts(file.literature_id);
    if (!facts?.primary_asset)
      throw new ImportSessionError("intake-file-upload-required");
    return settle(file, sha256, facts.primary_asset, false);
  }
  async upload(
    id: string,
    file: ImportFileStatus,
    chunks: AsyncIterable<Uint8Array>,
    active: AbortSignal,
    assertActive: () => Promise<void>,
    settle: FileSettlement,
    source: "import" | "web-capture" | "manual-pdf" = "import",
    onAccepted?: (receipt: CandidatePublicationReceipt) => void,
  ): Promise<ImportFileStatus> {
    const transfers = new BrowserTransferCollector(
      this.files,
      this.database,
      this.resources,
    );
    const acceptance = new CandidateAcceptanceService(
      this.database,
      transfers,
      new CandidatePublisher(transfers, this.database),
    );
    const abandonment = new CandidateAbandonmentService(
      this.database,
      transfers,
      this.recovery,
      this.writes,
    );

    if (file.status !== "pending") {
      const digest = createHash("sha256");
      for await (const chunk of uploadChunks(chunks, active)) {
        if (active.aborted)
          throw new ImportSessionError("intake-upload-cancelled");
        digest.update(chunk);
      }
      const sha = digest.digest("hex");
      if (sha !== file.sha256)
        throw new ImportSessionError("intake-file-conflict");
      return file;
    }
    await assertActive();
    if (file.action === "hash" && source !== "manual-pdf")
      throw new ImportSessionError("intake-file-hash-required");
    const transferId = `${source}-${randomUUID()}`;
    const baseline = await this.database.currentFacts(file.literature_id);
    if (!baseline) throw new ImportSessionError("intake-literature-missing");
    if (baseline.primary_asset && source !== "manual-pdf")
      throw new ImportSessionError("intake-file-hash-required");
    const streamHash = createHash("sha256");
    let completed: string | null = null,
      published = false;
    let failure: unknown;
    let failed = false;
    const cleanup = async () => {
      try {
        if (completed === null) await transfers.discard(transferId);
        else if (!published)
          await abandonment.abandon({
            article_id: file.literature_id,
            transfer_id: transferId,
            sha256: completed,
          });
      } catch (error) {
        if (failed)
          throw new AggregateError(
            [failure, error],
            "Intake and candidate cleanup failed",
            { cause: failure },
          );
        throw error;
      }
    };
    try {
      await transfers.begin(
        transferId,
        Number.MAX_SAFE_INTEGER,
        {
          session_id: id,
          article_id: file.literature_id,
          page_id: source,
          document_generation: 0,
          source_url: `https://sciretriever.local/${source}`,
          captured_at: new Date(this.now()).toISOString(),
        },
        source,
        source === "import" ? file.external_id : null,
        active,
      );
      for await (const chunk of uploadChunks(chunks, active)) {
        if (active.aborted)
          throw new ImportSessionError("intake-upload-cancelled");
        if (chunk.byteLength) {
          streamHash.update(chunk);
          await transfers.append(transferId, chunk);
        }
      }
      const candidate = await transfers.complete(transferId);
      completed = candidate.sha256;
      if (streamHash.digest("hex") !== candidate.sha256)
        throw new ImportSessionError("intake-file-hash-mismatch");
      if (
        file.expected_sha256 !== null &&
        file.expected_sha256 !== candidate.sha256
      )
        throw new ImportSessionError("intake-file-hash-mismatch");
      if (file.size_bytes !== null && file.size_bytes !== candidate.size_bytes)
        throw new ImportSessionError("intake-file-size-mismatch");
      await assertActive();
      if (active.aborted)
        throw new ImportSessionError("intake-upload-cancelled");
      const facts = await this.database.currentFacts(file.literature_id);
      if (!facts) throw new ImportSessionError("intake-literature-missing");
      if (facts.primary_asset)
        return await settle(file, candidate.sha256, facts.primary_asset, false);
      const receipt = await acceptance.accept(
        {
          receipt_id: `${source}-${randomUUID()}`,
          literature_id: file.literature_id,
          transfer_id: transferId,
          metadata_snapshot: baseline.metadata_snapshot,
          ...(source === "web-capture"
            ? {
                source_url: (
                  await this.database.run<{
                    ok: boolean;
                    value: string | null;
                  }>({
                    kind: "import_read",
                    action: {
                      op: "items-read",
                      query: { kind: "source-url", file_id: file.file_id },
                    },
                  })
                ).value,
              }
            : {}),
        },
        active,
      );
      published = true;
      onAccepted?.(receipt);
      const accepted = await this.database.currentFacts(file.literature_id);
      return await settle(
        file,
        candidate.sha256,
        accepted!.primary_asset,
        true,
      );
    } catch (error) {
      failure = error;
      failed = true;
      if (error instanceof CandidatePublicationError && error.bytes_published)
        published = true;
      if (active.aborted && !published)
        throw new ImportSessionError("intake-upload-cancelled", {
          cause: error,
        });
      if (error instanceof PdfAcceptanceError)
        throw new ImportSessionError("intake-pdf-invalid", { cause: error });
      if (error instanceof LiteraturePublicationError)
        throw new ImportSessionError(
          error.code === "primary-asset-conflict"
            ? "intake-file-conflict"
            : "intake-source-stale",
          { cause: error },
        );

      throw intakeResourceFailure(error);
    } finally {
      await cleanup();
    }
  }
}
