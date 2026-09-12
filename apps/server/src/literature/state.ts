import type { LiteratureStatus, MissingStep } from "@sciretriever/contracts";

export interface CurrentStateEvidence {
  readonly metadata_revision: number;
  readonly metadata_sha256: string;
  readonly primary: {
    readonly asset_id: string;
    readonly sha256: string;
    readonly media_type: string;
  } | null;
  readonly parser: {
    readonly source_asset_id: string;
    readonly source_sha256: string;
  } | null;
  readonly content: {
    readonly metadata_revision: number;
    readonly metadata_sha256: string;
    readonly primary_asset_id: string;
    readonly primary_asset_sha256: string;
    readonly source_kind: string;
    readonly input_sha256: string | null;
    readonly expected_input_sha256: string;
  } | null;
}

/** Shared pure truth table; the worker invokes this same function on one read snapshot. */
export function deriveCurrentState(facts: CurrentStateEvidence): {
  status: LiteratureStatus;
  missing_step: MissingStep | null;
} {
  const primary = facts.primary;
  if (!primary || primary.media_type !== "application/pdf")
    return { status: "UNREVIEWED", missing_step: "primary-pdf" };
  const content = facts.content;
  const ready =
    !!content &&
    content.metadata_revision === facts.metadata_revision &&
    content.metadata_sha256 === facts.metadata_sha256 &&
    content.primary_asset_id === primary.asset_id &&
    content.primary_asset_sha256 === primary.sha256 &&
    content.source_kind === "analysis" &&
    content.input_sha256 === content.expected_input_sha256;
  const parser = facts.parser;
  return {
    status: ready ? "CONTENT_READY" : "ASSET_READY",
    missing_step:
      !parser ||
      parser.source_asset_id !== primary.asset_id ||
      parser.source_sha256 !== primary.sha256
        ? "parser-result"
        : ready
          ? null
          : "literature-content",
  };
}
