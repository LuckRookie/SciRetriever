import {
  ContractValidationError,
  EMPTY_METADATA,
  parseAssetId,
  canonicalJsonBytes,
  type LiteratureMetadata,
} from "./index.js";
import {
  parseWebPageData,
  intakeSourceUrl,
  parseIntakeFileName,
} from "./intake-page.js";
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
/** Only original page data crosses the capture boundary. */
export function parseIntakePagePreview(value: unknown) {
  const r = importObject(value, ["page"]);
  return { page: parseWebPageData(r.page) };
}
export function parseIntakePageSave(value: unknown) {
  const r = importObject(
    value,
    ["request_id", "page"],
    ["folder_ids", "file", "duplicate_decision"],
  );
  if (canonicalJsonBytes(r).byteLength > INTAKE_PAGE_MAX_REQUEST_BYTES)
    throw new ContractValidationError();
  const { page } = parseIntakePagePreview({ page: r.page });
  const folderIds = r.folder_ids ?? [];
  if (!Array.isArray(folderIds) || folderIds.length > 100)
    throw new ContractValidationError();
  let file = null;
  if (r.file !== null && r.file !== undefined) {
    const { source_url, ...f } = importObject(
      r.file,
      ["file_name", "source_url"],
      ["size_bytes", "sha256"],
    );
    if (typeof source_url !== "string") throw new ContractValidationError();
    parseIntakeFileName(f.file_name);
    const parsedFile = parseIntakeData({
      records: [
        {
          external_id: "page",
          metadata: EMPTY_METADATA,
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
    file = { ...parsedFile, source_url: intakeSourceUrl(source_url) };
  }
  let duplicate_decision:
    | { kind: "new" }
    | { kind: "merge"; literature_id: string }
    | null = null;
  if (r.duplicate_decision !== undefined) {
    const d = importObject(r.duplicate_decision, ["kind"], ["literature_id"]);
    if (d.kind === "new") {
      importObject(r.duplicate_decision, ["kind"]);
      duplicate_decision = { kind: "new" };
    } else if (d.kind === "merge") {
      importObject(r.duplicate_decision, ["kind", "literature_id"]);
      duplicate_decision = {
        kind: "merge",
        literature_id: parseAssetId(d.literature_id),
      };
    } else throw new ContractValidationError();
  }
  return {
    request_id: parseAssetId(r.request_id),
    page,
    folder_ids: [...new Set(folderIds.map(parseAssetId))],
    file,
    duplicate_decision,
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
  readonly file: IntakeFileStatus | IntakePendingPageFile | null;
}
/** A PDF page has an upload ID before recognition establishes a Literature. */
export interface IntakePendingPageFile
  extends Omit<IntakeFileStatus, "literature_id"> {
  readonly literature_id: null;
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
