import {
  canonicalJsonBytes,
  ContractValidationError,
  parseLiteratureId,
  sha256,
} from "./index.js";

export const ARCHIVE_STEPS = [
  "proofread",
  "document",
  "structure",
  "metadata",
  "references",
  "tags",
] as const;
export type ArchiveStep = (typeof ARCHIVE_STEPS)[number];
export type ArchiveMode = "full" | "legacy-vlm-markdown";
export type ArchiveStepStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "unavailable";
export interface ArchiveBuildRequest {
  readonly literature_id: string;
  readonly mode: ArchiveMode;
  readonly from_step: ArchiveStep | null;
}
export interface ArchiveStepReceipt {
  readonly literature_id: string;
  readonly asset_id: string;
  readonly step: ArchiveStep;
  readonly status: ArchiveStepStatus;
  readonly input_sha256: string;
  readonly output: Readonly<Record<string, unknown>>;
  readonly reason: string | null;
  readonly elapsed_ms: number;
  readonly calls: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
}
export interface ArchivePart {
  readonly asset_id: string;
  readonly asset_sha256: string;
  readonly part: "main" | "supplementary";
  readonly raw_profiles: readonly string[];
  readonly proofread_id: string | null;
  readonly proofread_complete: boolean;
  readonly document_version_id: string | null;
  readonly structure_annotation_id: string | null;
  readonly structure_satisfied: boolean;
  readonly content_version: string | null;
  readonly steps: readonly ArchiveStepReceipt[];
}
export interface ArchiveIssue {
  readonly issue_id: string;
  readonly literature_id: string;
  readonly asset_id: string;
  readonly part: "main" | "supplementary";
  readonly step: ArchiveStep;
  readonly reason: string;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly affects_readiness: boolean;
  readonly resolution: "continue" | "skip" | "cancel" | null;
}
export interface ArchiveState {
  readonly literature_id: string;
  readonly mode: ArchiveMode;
  readonly started: boolean;
  readonly running: boolean;
  readonly parts: readonly ArchivePart[];
  readonly issues: readonly ArchiveIssue[];
  readonly article_kind: string | null;
  readonly metadata_missing: readonly string[];
  readonly tag_count: number;
  readonly description_version: string | null;
}
export interface ArchiveVersionEvent {
  readonly sequence: number;
  readonly kind: "content-version-changed" | "description-version-changed";
  readonly literature_id: string;
  readonly asset_id: string | null;
  readonly old_part: "main" | "supplementary" | null;
  readonly new_part: "main" | "supplementary" | null;
  readonly old_version: string | null;
  readonly new_version: string | null;
  readonly created_at: string;
}
export function parseArchiveBuildRequest(value: unknown): ArchiveBuildRequest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ContractValidationError();
  const r = value as Record<string, unknown>;
  if (
    Object.keys(r).some(
      (k) => !["literature_id", "mode", "from_step"].includes(k),
    ) ||
    (r.mode !== undefined &&
      !["full", "legacy-vlm-markdown"].includes(String(r.mode))) ||
    (r.from_step !== undefined &&
      r.from_step !== null &&
      !ARCHIVE_STEPS.includes(r.from_step as ArchiveStep))
  )
    throw new ContractValidationError();
  return Object.freeze({
    literature_id: parseLiteratureId(r.literature_id),
    mode: (r.mode ?? "full") as ArchiveMode,
    from_step: (r.from_step ?? null) as ArchiveStep | null,
  });
}
export const archiveContentVersion = (
  document_version_id: string,
  structure_annotation_id: string,
) =>
  sha256(canonicalJsonBytes({ document_version_id, structure_annotation_id }));
export const archiveDescriptionVersion = (
  metadata_revision: number,
  metadata_sha256: string,
  assignment_sha256: string | null,
) =>
  sha256(
    canonicalJsonBytes({
      metadata_revision,
      metadata_sha256,
      assignment_sha256,
    }),
  );
