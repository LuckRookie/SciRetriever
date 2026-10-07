import { randomUUID } from "node:crypto";
import {
  parseLiteratureId,
  type CandidatePublicationReceipt,
} from "@sciretriever/contracts";
import type { CandidateAcceptanceService } from "../acquisition/candidate-acceptance.js";
import type { CandidateAbandonmentService } from "../acquisition/candidate-abandonment.js";
import { CandidatePublicationError } from "../acquisition/candidate-publication.js";
import { acceptPdf } from "../acquisition/pdf-acceptance.js";
import type { BrowserTransferCollector } from "../browser/transfer.js";
import type { LiteratureQueryService } from "../literature/query.js";
import { LiteraturePublicationError } from "../literature/primary-pdf.js";

const MAX_PDF_BYTES = 16 * 1024 * 1024;

export interface IngestPdfRequest {
  readonly literature_id: string;
  /** Explicitly supplied bytes. An adapter alone may read a local path. */
  readonly bytes: Uint8Array;
}

export class ManualPdfInputError extends Error {
  constructor(readonly code: "manual-pdf-invalid" | "manual-pdf-cancelled") {
    super("manual PDF input was rejected");
  }
}

/** Shared maintenance use case for CLI, TypeScript callers and controlled uploads. */
export class ManualPdfIngestionService {
  private readonly stop = new AbortController();
  private readonly active = new Set<Promise<CandidatePublicationReceipt>>();
  constructor(
    private readonly library: Pick<LiteratureQueryService, "detail">,
    private readonly transfers: BrowserTransferCollector,
    private readonly acceptance: Pick<CandidateAcceptanceService, "accept">,
    private readonly abandonment: Pick<CandidateAbandonmentService, "abandon">,
  ) {}

  ingestPdf(
    input: IngestPdfRequest,
    signal?: AbortSignal,
  ): Promise<CandidatePublicationReceipt> {
    if (this.stop.signal.aborted)
      return Promise.reject(new ManualPdfInputError("manual-pdf-cancelled"));
    const active = signal
      ? AbortSignal.any([signal, this.stop.signal])
      : this.stop.signal;
    const pending = this.execute(input, active);
    this.active.add(pending);
    void pending.then(
      () => this.active.delete(pending),
      () => this.active.delete(pending),
    );
    return pending;
  }

  private async execute(
    input: IngestPdfRequest,
    signal: AbortSignal,
  ): Promise<CandidatePublicationReceipt> {
    const check = () => {
      if (signal.aborted) throw new ManualPdfInputError("manual-pdf-cancelled");
    };
    check();
    let id: string;
    try {
      if (
        !input ||
        Object.keys(input).sort().join() !== "bytes,literature_id" ||
        !(input.bytes instanceof Uint8Array) ||
        input.bytes.byteLength < 1 ||
        input.bytes.byteLength > MAX_PDF_BYTES
      )
        throw new Error("invalid manual PDF request");
      id = parseLiteratureId(input.literature_id);
    } catch {
      throw new ManualPdfInputError("manual-pdf-invalid");
    }
    const detail = await this.library.detail(id);
    check();
    if (detail.primary_pdf)
      throw new LiteraturePublicationError("primary-asset-conflict");
    // Reject invalid files before creating a durable transfer. Article identity
    // remains unverified, just as for automatic downloads.
    await acceptPdf(input.bytes, 10000, signal);
    check();
    const transferId = `manual-${randomUUID()}`;
    await this.transfers.begin(
      transferId,
      MAX_PDF_BYTES,
      {
        session_id: "manual-pdf",
        article_id: id,
        page_id: "manual-pdf",
        document_generation: 0,
        source_url: "https://sciretriever.local/manual-pdf",
        captured_at: new Date().toISOString(),
      },
      "manual-pdf",
    );
    let completedSha256: string | null = null;
    try {
      check();
      await this.transfers.append(transferId, input.bytes);
      check();
      completedSha256 = (await this.transfers.complete(transferId)).sha256;
      check();
      return await this.acceptance.accept(
        {
          literature_id: id,
          transfer_id: transferId,
          receipt_id: `manual-receipt-${randomUUID()}`,
          metadata_snapshot: {
            revision: detail.metadata_revision,
            sha256: detail.metadata_sha256,
          },
        },
        signal,
      );
    } catch (error) {
      if (completedSha256 === null) {
        try {
          await this.transfers.discard(transferId);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "manual PDF intake and transfer cleanup failed",
            { cause: error },
          );
        }
      } else if (
        !(error instanceof CandidatePublicationError && error.bytes_published)
      ) {
        try {
          await this.abandonment.abandon({
            article_id: id,
            transfer_id: transferId,
            sha256: completedSha256,
          });
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "manual PDF intake and candidate cleanup failed",
            { cause: error },
          );
        }
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    this.stop.abort();
    await Promise.allSettled([...this.active]);
  }
}
