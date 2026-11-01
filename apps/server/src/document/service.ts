import type { ParsingCommit } from "../parsing/ports.js";
import {
  parseDocumentRequest,
  parseDocumentReceipt,
  parseLiteratureDetail,
  type ParseDocumentReceipt,
} from "@sciretriever/contracts";
import type { RawParsingService } from "../parsing/raw-service.js";
import type { SqliteWorker } from "../storage/sqlite/worker.js";

export type {
  ParseDocumentRequest,
  ParseDocumentReceipt,
} from "@sciretriever/contracts";
export class DocumentProcessingError extends Error {
  constructor(
    readonly code:
      | "material-missing"
      | "material-stale"
      | "parser-unavailable"
      | "document-cancelled"
      | "catalog-v12-required",
    options?: ErrorOptions,
  ) {
    super("document parsing failed", options);
    this.name = "DocumentProcessingError";
  }
}
/** The public parsing boundary. Building readable documents belongs to archiving. */
export class DocumentProcessingService {
  private readonly stop = new AbortController();
  private readonly active = new Set<Promise<unknown>>();
  private closing: Promise<void> | undefined;
  constructor(
    private readonly database: SqliteWorker,
    private readonly parsing: RawParsingService | null,
  ) {}
  async parseDocuments(
    value: unknown,
    signal?: AbortSignal,
    commit?: ParsingCommit,
  ): Promise<ParseDocumentReceipt> {
    const request = parseDocumentRequest(value);
    if (this.stop.signal.aborted)
      throw new DocumentProcessingError("document-cancelled");
    const combined = signal
      ? AbortSignal.any([signal, this.stop.signal])
      : this.stop.signal;
    const operation = (async () => {
      if (combined.aborted)
        throw new DocumentProcessingError("document-cancelled");
      if (![15].includes(Number((await this.database.schema()).schema_version)))
        throw new DocumentProcessingError("catalog-v12-required");
      const facts = await this.database.currentFacts(request.literature_id);
      const asset = await this.database.getAsset(request.asset_id);
      if (!facts || !asset)
        throw new DocumentProcessingError("material-missing");
      // Binding to an accepted literature asset also allows supplementary PDFs.
      const snapshot = await this.database.literatureDetailSnapshot(
        request.literature_id,
      );
      if (!snapshot) throw new DocumentProcessingError("material-missing");
      const detail = await parseLiteratureDetail(snapshot.detail);
      const assets = [
        ...(detail.primary_pdf ? [detail.primary_pdf] : []),
        ...detail.additional_assets,
      ];
      if (
        asset.sha256 !== request.asset_sha256 ||
        asset.media_type !== "application/pdf" ||
        !assets.some((a) => a.asset.asset_id === request.asset_id)
      )
        throw new DocumentProcessingError("material-stale");
      if (!this.parsing)
        throw new DocumentProcessingError("parser-unavailable");
      const outcomes = await this.parsing.parseAsset(
        asset.asset_id,
        request.profiles,
        combined,
        {
          force: request.force,
          expected_sha256: request.asset_sha256,
          ...(commit ? { commit } : {}),
        },
      );
      return parseDocumentReceipt({
        literature_id: request.literature_id,
        asset_id: asset.asset_id,
        asset_sha256: asset.sha256,
        profiles: outcomes.map((o) => ({
          profile: o.profile,
          status: o.status,
          raw_parse_id: o.result?.raw_parse_id ?? null,
          result_sha256: o.result?.result_sha256 ?? null,
          failure_code: o.failure_code,
          failure_source_type: o.failure_source_type,
        })),
      });
    })();
    this.active.add(operation);
    try {
      return await operation;
    } finally {
      this.active.delete(operation);
    }
  }
  close(): Promise<void> {
    if (!this.closing) {
      let resolve!: () => void;
      this.closing = new Promise<void>((done) => {
        resolve = done;
      });
      this.stop.abort();
      void Promise.allSettled([...this.active]).then(() => resolve());
    }
    return this.closing;
  }
}
