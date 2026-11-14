import { createHash, randomUUID } from "node:crypto";
import { importHash, type ImportFileStatus } from "@sciretriever/contracts";
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
    super("Import session request rejected", options);
  }
}
/** Abort a waiting source without retaining a whole upload or waiting on an uncooperative iterator. */
async function* uploadChunks(
  source: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
) {
  const iterator = source[Symbol.asyncIterator]();
  try {
    for (;;) {
      if (signal.aborted)
        throw new ImportSessionError("import-upload-cancelled");
      const next = await new Promise<IteratorResult<Uint8Array>>(
        (resolve, reject) => {
          const abort = () =>
            reject(new ImportSessionError("import-upload-cancelled"));
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
      throw new ImportSessionError("import-file-conflict");
    return file;
  }
  const mismatch =
    (file.expected_sha256 !== null && file.expected_sha256 !== sha256) ||
    asset?.sha256 !== sha256;
  return {
    ...file,
    status: mismatch ? "conflict" : uploaded ? "uploaded" : "existing",
    sha256,
    reason: mismatch ? "import-file-conflict" : null,
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
      throw new ImportSessionError("import-file-upload-required");
    return settle(file, sha256, facts.primary_asset, false);
  }
  async upload(
    id: string,
    file: ImportFileStatus,
    chunks: AsyncIterable<Uint8Array>,
    active: AbortSignal,
    assertActive: () => Promise<void>,
    settle: FileSettlement,
    source: "import" | "web-capture" = "import",
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
          throw new ImportSessionError("import-upload-cancelled");
        digest.update(chunk);
      }
      const sha = digest.digest("hex");
      if (sha !== file.sha256)
        throw new ImportSessionError("import-file-conflict");
      return file;
    }
    await assertActive();
    if (file.action === "hash")
      throw new ImportSessionError("import-file-hash-required");
    const transferId = `${source}-${randomUUID()}`;
    const baseline = await this.database.currentFacts(file.literature_id);
    if (!baseline) throw new ImportSessionError("import-literature-missing");
    if (baseline.primary_asset)
      throw new ImportSessionError("import-file-hash-required");
    const streamHash = createHash("sha256");
    let completed: string | null = null,
      published = false;
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
        source === "web-capture" ? null : file.external_id,
        active,
      );
      for await (const chunk of uploadChunks(chunks, active)) {
        if (active.aborted)
          throw new ImportSessionError("import-upload-cancelled");
        if (chunk.byteLength) {
          streamHash.update(chunk);
          await transfers.append(transferId, chunk);
        }
      }
      const candidate = await transfers.complete(transferId);
      completed = candidate.sha256;
      if (streamHash.digest("hex") !== candidate.sha256)
        throw new ImportSessionError("import-file-hash-mismatch");
      if (
        file.expected_sha256 !== null &&
        file.expected_sha256 !== candidate.sha256
      )
        throw new ImportSessionError("import-file-hash-mismatch");
      if (file.size_bytes !== null && file.size_bytes !== candidate.size_bytes)
        throw new ImportSessionError("import-file-size-mismatch");
      await assertActive();
      if (active.aborted)
        throw new ImportSessionError("import-upload-cancelled");
      const facts = await this.database.currentFacts(file.literature_id);
      if (!facts) throw new ImportSessionError("import-literature-missing");
      if (facts.primary_asset)
        return await settle(file, candidate.sha256, facts.primary_asset, false);
      const receipt = await acceptance.accept(
        {
          receipt_id: `${source}-${randomUUID()}`,
          literature_id: file.literature_id,
          transfer_id: transferId,
          metadata_snapshot: baseline.metadata_snapshot,
        },
        active,
      );
      void receipt;
      published = true;
      const accepted = await this.database.currentFacts(file.literature_id);
      return await settle(
        file,
        candidate.sha256,
        accepted!.primary_asset,
        true,
      );
    } catch (error) {
      if (error instanceof CandidatePublicationError && error.bytes_published)
        published = true;
      if (active.aborted && !published)
        throw new ImportSessionError("import-upload-cancelled", {
          cause: error,
        });
      if (error instanceof PdfAcceptanceError)
        throw new ImportSessionError("import-pdf-invalid", { cause: error });
      if (error instanceof LiteraturePublicationError)
        throw new ImportSessionError(
          error.code === "primary-asset-conflict"
            ? "import-file-conflict"
            : "import-source-stale",
          { cause: error },
        );

      let current: unknown = error;
      for (let i = 0; i < 8 && current && typeof current === "object"; i++) {
        if ("code" in current && current.code === "ENOSPC")
          throw new ImportSessionError("import-disk-space", { cause: error });
        if (current instanceof BrowserDownloadResourceError)
          throw new ImportSessionError(
            current.code === "browser-download-disk-reserve"
              ? "import-disk-space"
              : "import-disk-unavailable",
            { cause: error },
          );
        current = "cause" in current ? current.cause : null;
      }
      throw error;
    } finally {
      if (completed === null) await transfers.discard(transferId);
      else if (!published)
        await abandonment.abandon({
          article_id: file.literature_id,
          transfer_id: transferId,
          sha256: completed,
        });
    }
  }
}
