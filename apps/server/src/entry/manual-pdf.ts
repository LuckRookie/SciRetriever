import {
  parseLiteratureId,
  type CandidatePublicationReceipt,
} from "@sciretriever/contracts";
import type { LiteratureQueryService } from "../literature/query.js";
import { LiteraturePublicationError } from "../literature/primary-pdf.js";
import { activityContext } from "../logging/activity.js";
import { ImportSessionError } from "./import-files.js";
import type { ImportSessionService } from "./import-sessions.js";

export interface IngestPdfRequest {
  readonly literature_id: string;
  readonly bytes: Uint8Array;
}
export interface IngestPdfStreamRequest {
  readonly literature_id: string;
  readonly chunks: AsyncIterable<Uint8Array>;
  readonly file_name?: string;
  readonly size_bytes?: number;
  readonly sha256?: string;
}
export class ManualPdfInputError extends Error {
  constructor(readonly code: "manual-pdf-invalid" | "manual-pdf-cancelled") {
    super("manual PDF input was rejected");
  }
}
/** Legacy receipt adapter. Intake owns the batch, streaming, validation and publication. */
export class ManualPdfIngestionService {
  private readonly stop = new AbortController();
  private readonly active = new Set<Promise<CandidatePublicationReceipt>>();
  constructor(
    private readonly library: Pick<LiteratureQueryService, "detail">,
    private readonly intake: () => ImportSessionService,
  ) {}
  ingestPdf(
    input: IngestPdfRequest,
    signal?: AbortSignal,
  ): Promise<CandidatePublicationReceipt> {
    if (
      !input ||
      Object.keys(input).sort().join() !== "bytes,literature_id" ||
      !(input.bytes instanceof Uint8Array) ||
      !input.bytes.byteLength
    )
      return Promise.reject(new ManualPdfInputError("manual-pdf-invalid"));
    return this.ingestPdfStream(
      {
        literature_id: input.literature_id,
        chunks: (async function* () {
          yield input.bytes;
        })(),
      },
      signal,
    );
  }
  ingestPdfStream(
    input: IngestPdfStreamRequest,
    signal?: AbortSignal,
  ): Promise<CandidatePublicationReceipt> {
    const active = AbortSignal.any([
      this.stop.signal,
      ...(signal ? [signal] : []),
    ]);
    const pending = this.execute(input, active);
    this.active.add(pending);
    const done = () => this.active.delete(pending);
    void pending.then(done, done);
    return pending;
  }
  private async execute(
    input: IngestPdfStreamRequest,
    signal: AbortSignal,
  ): Promise<CandidatePublicationReceipt> {
    const check = () => {
      if (signal.aborted) throw new ManualPdfInputError("manual-pdf-cancelled");
    };
    check();
    let id: string;
    try {
      id = parseLiteratureId(input.literature_id);
    } catch {
      throw new ManualPdfInputError("manual-pdf-invalid");
    }
    const detail = await this.library.detail(id);
    check();
    // Preserve the legacy receipt API's conflict result. The new file API exposes existing/conflict.
    if (detail.primary_pdf)
      throw new LiteraturePublicationError("primary-asset-conflict");
    const actor = activityContext().actor;
    const origin = actor.startsWith("cli:")
      ? "cli"
      : actor.startsWith("mcp:")
        ? "mcp"
        : "web";
    let receipt: CandidatePublicationReceipt | null = null;
    try {
      await this.intake().supplementPdf(
        id,
        input.chunks,
        origin,
        signal,
        undefined,
        (r) => {
          receipt = r;
        },
        {
          ...(input.file_name ? { file_name: input.file_name } : {}),
          ...(input.size_bytes !== undefined
            ? { size_bytes: input.size_bytes }
            : {}),
          ...(input.sha256 ? { sha256: input.sha256 } : {}),
        },
      );
      if (!receipt)
        throw new LiteraturePublicationError("primary-asset-conflict");
      return receipt;
    } catch (error) {
      if (
        error instanceof ImportSessionError &&
        error.code === "intake-upload-cancelled"
      )
        throw new ManualPdfInputError("manual-pdf-cancelled");
      if (
        error instanceof ImportSessionError &&
        error.code === "intake-pdf-invalid"
      )
        throw new ManualPdfInputError("manual-pdf-invalid");
      if (
        error instanceof ImportSessionError &&
        error.cause instanceof LiteraturePublicationError
      )
        throw error.cause;
      throw error;
    }
  }
  async close() {
    this.stop.abort();
    await Promise.allSettled([...this.active]);
  }
}
