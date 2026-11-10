import {
  ContractValidationError,
  EMPTY_METADATA,
  parseAssetId,
  parseIdentifier,
  parseLiteratureMetadata,
  canonicalJsonBytes,
  type LiteratureMetadata,
} from "./index.js";
import {
  importObject,
  parseImportData,
  type ImportFileStatus,
} from "./import-sessions.js";

export const CAPTURE_MAX_REQUEST_BYTES = 64 * 1024;
export class CaptureIdentifierRequiredError extends Error {
  readonly code = "capture-identifier-required" as const;
  constructor() {
    super("Capture identifier required");
  }
}
export function parseCaptureIdentifiers(value: unknown) {
  if (!Array.isArray(value) || !value.length || value.length > 16)
    throw new ContractValidationError();
  const identifiers = value.map(parseIdentifier);
  if (identifiers.some((i) => !["doi", "arxiv"].includes(i.namespace)))
    throw new ContractValidationError();
  return identifiers;
}
export function parseCaptureSave(value: unknown) {
  const r = importObject(
    value,
    ["request_id", "metadata"],
    ["folder_ids", "file"],
  );
  if (canonicalJsonBytes(r).byteLength > CAPTURE_MAX_REQUEST_BYTES)
    throw new ContractValidationError();
  const fields = importObject(r.metadata, [], Object.keys(EMPTY_METADATA));
  const metadata = parseLiteratureMetadata({ ...EMPTY_METADATA, ...fields });
  if (!metadata.identifiers.some((i) => ["doi", "arxiv"].includes(i.namespace)))
    throw new CaptureIdentifierRequiredError();
  const folderIds = r.folder_ids ?? [];
  if (!Array.isArray(folderIds) || folderIds.length > 100)
    throw new ContractValidationError();
  let file = null;
  if (r.file !== null && r.file !== undefined) {
    const f = importObject(r.file, ["file_name"], ["size_bytes", "sha256"]);
    file = parseImportData({
      records: [
        {
          external_id: "capture",
          metadata,
          files: [
            {
              ...f,
              external_id: "pdf",
              media_type: "application/pdf",
              preferred: true,
            },
          ],
        },
      ],
    }).records[0]!.files[0]!;
  }
  return {
    request_id: parseAssetId(r.request_id),
    metadata,
    folder_ids: [...new Set(folderIds.map(parseAssetId))],
    file,
  };
}
export interface CaptureCompletion {
  readonly status: "completed" | "partial" | "unavailable" | "failed";
  readonly job_id: string | null;
  readonly code: string | null;
}
export interface CaptureResult {
  readonly capture_id: string;
  readonly batch_id: string;
  readonly literature_id: string;
  readonly disposition: "created" | "enriched" | "matched";
  readonly metadata: CaptureCompletion;
  readonly missing_folder_ids: readonly string[];
  readonly file: ImportFileStatus | null;
}
export type CapturePageMetadata = Partial<LiteratureMetadata>;
