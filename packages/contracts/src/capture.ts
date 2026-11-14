import {
  ContractValidationError,
  EMPTY_METADATA,
  parseAssetId,
  parseLiteratureMetadata,
  canonicalJsonBytes,
  type LiteratureMetadata,
} from "./index.js";
import {
  importObject,
  parseIntakeData,
  type IntakeFileStatus,
  type IntakeBatchItem,
} from "./intake.js";

export const INTAKE_PAGE_MAX_REQUEST_BYTES = 640 * 1024;
export class IntakeItemEmptyError extends Error {
  readonly code = "intake-item-empty" as const;
  constructor() {
    super("Intake item empty");
  }
}
/** Transitional decoded metadata input, until the raw WebPageData adapter is connected. */
export function parseIntakePagePreview(value: unknown) {
  const r = importObject(value, ["metadata"]);
  const fields = importObject(r.metadata, [], Object.keys(EMPTY_METADATA));
  return {
    metadata: parseLiteratureMetadata({ ...EMPTY_METADATA, ...fields }),
  };
}
export function parseIntakePageSave(value: unknown) {
  const r = importObject(
    value,
    ["request_id", "metadata"],
    ["folder_ids", "file"],
  );
  if (canonicalJsonBytes(r).byteLength > INTAKE_PAGE_MAX_REQUEST_BYTES)
    throw new ContractValidationError();
  const { metadata } = parseIntakePagePreview({ metadata: r.metadata });
  const folderIds = r.folder_ids ?? [];
  if (!Array.isArray(folderIds) || folderIds.length > 100)
    throw new ContractValidationError();
  let file = null;
  if (r.file !== null && r.file !== undefined) {
    const f = importObject(r.file, ["file_name"], ["size_bytes", "sha256"]);
    file = parseIntakeData({
      records: [
        {
          external_id: "page",
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
  if (!metadata.title?.trim() && !metadata.identifiers.length && !file)
    throw new IntakeItemEmptyError();
  return {
    request_id: parseAssetId(r.request_id),
    metadata,
    folder_ids: [...new Set(folderIds.map(parseAssetId))],
    file,
  };
}
export interface IntakePageCompletion {
  readonly status:
    | "completed"
    | "partial"
    | "unavailable"
    | "failed"
    | "pending";
  readonly job_id: string | null;
  readonly code: string | null;
}
export interface IntakePageResult {
  readonly item_id: string;
  readonly batch_id: string;
  readonly literature_id: string | null;
  readonly disposition: "created" | "enriched" | "matched" | null;
  readonly metadata: IntakePageCompletion;
  readonly missing_folder_ids: readonly string[];
  readonly file: IntakeFileStatus | null;
}
export interface IntakePagePreview {
  readonly found: boolean;
  readonly literature_id: string | null;
  readonly library_title: string | null;
  readonly metadata: LiteratureMetadata;
  readonly has_pdf: boolean;
  readonly pdf_url: string | null;
  readonly possible_duplicates: IntakeBatchItem["possible_duplicates"];
}
