import {
  archiveHash,
  archiveList,
  type ArchiveMetadataFragmentEvidence,
} from "./archive-publication.js";
import { parseSourceSpan } from "./archive-text.js";
import {
  ContractValidationError,
  parseLiteratureMetadata,
  parseProvenance,
  type LiteratureMetadata,
  type Provenance,
} from "./index.js";

export const METADATA_FIELDS = [
  "title",
  "authors",
  "abstract",
  "publication_date",
  "publication_year",
  "publication_form",
  "article_kind",
  "language",
  "venue",
  "publisher",
  "volume",
  "issue",
  "pages",
  "identifiers",
  "keywords",
] as const;
export type MetadataField = (typeof METADATA_FIELDS)[number];
export type MetadataValue = LiteratureMetadata[MetadataField];
export type MetadataFieldEvidence =
  | {
      readonly source: "proofread";
      readonly schema_version: 2;
      readonly document_version_id: string;
      readonly archive_fragments: readonly ArchiveMetadataFragmentEvidence[];
    }
  | {
      readonly source: "authority";
      readonly observation_id: string;
      readonly provenance: Provenance;
    }
  | {
      readonly source: "proofread";
      readonly document_version_id: string;
      readonly fragment_ids: readonly string[];
    }
  | {
      readonly source: "manual";
      readonly observation_id: string;
      readonly provenance: Provenance;
    };
export interface MetadataFieldCandidate {
  readonly field: MetadataField;
  readonly value: MetadataValue;
  readonly evidence: MetadataFieldEvidence;
}
export interface MetadataFieldState extends MetadataFieldCandidate {
  readonly locked: boolean;
  readonly conflict: boolean;
  readonly conflicts: readonly MetadataFieldCandidate[];
}
export const EMPTY_METADATA: LiteratureMetadata = Object.freeze({
  title: null,
  authors: [],
  abstract: null,
  publication_date: null,
  publication_year: null,
  publication_form: null,
  article_kind: null,
  language: null,
  venue: null,
  publisher: null,
  volume: null,
  issue: null,
  pages: null,
  identifiers: [],
  keywords: [],
});

function fail(): never {
  throw new ContractValidationError(["metadata_field"]);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail();
  return value as Record<string, unknown>;
}
function exact(value: unknown, keys: readonly string[]) {
  const row = object(value);
  if (
    Object.keys(row).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(row, k))
  )
    fail();
  return row;
}
function text(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    /[\p{Cc}\uD800-\uDFFF]/u.test(value)
  )
    return fail();
  return value;
}
export function parseMetadataField(value: unknown): MetadataField {
  if (
    typeof value !== "string" ||
    !METADATA_FIELDS.includes(value as MetadataField)
  )
    return fail();
  return value as MetadataField;
}
export function parseMetadataFieldCandidate(
  value: unknown,
): MetadataFieldCandidate {
  const row = exact(value, ["field", "value", "evidence"]);
  const field = parseMetadataField(row.field);
  const normalized = parseLiteratureMetadata({
    ...EMPTY_METADATA,
    [field]: row.value,
  })[field];
  const raw = object(row.evidence);
  let evidence: MetadataFieldEvidence;
  if (raw.source === "proofread") {
    if (raw.schema_version === 2) {
      exact(raw, [
        "source",
        "schema_version",
        "document_version_id",
        "archive_fragments",
      ]);
      const fragments = archiveList(
        raw.archive_fragments,
        (v): ArchiveMetadataFragmentEvidence => {
          const q = object(v);
          if (q.kind === "document-segment") {
            exact(q, ["kind", "document_version_id", "segment_ids"]);
            return {
              kind: q.kind,
              document_version_id: text(q.document_version_id),
              segment_ids: archiveList(q.segment_ids, text, 64),
            };
          }
          exact(q, [
            "kind",
            "proofread_id",
            "arrangement_id",
            "raw_parse_id",
            "leaf_id",
            "source",
            "drop_reason",
          ]);
          if (q.kind !== "arrangement-leaf" || q.drop_reason !== "bibliography")
            fail();
          return {
            kind: q.kind,
            proofread_id: text(q.proofread_id),
            arrangement_id: archiveHash(q.arrangement_id),
            raw_parse_id: text(q.raw_parse_id),
            leaf_id: text(q.leaf_id),
            source: parseSourceSpan(q.source),
            drop_reason: q.drop_reason,
          };
        },
        64,
      );
      if (!fragments.length) fail();
      evidence = {
        source: "proofread",
        schema_version: 2,
        document_version_id: text(raw.document_version_id),
        archive_fragments: fragments,
      };
    } else {
      exact(raw, ["source", "document_version_id", "fragment_ids"]);
      if (
        !Array.isArray(raw.fragment_ids) ||
        raw.fragment_ids.length === 0 ||
        raw.fragment_ids.length > 64
      )
        fail();
      const ids = raw.fragment_ids.map(text);
      if (new Set(ids).size !== ids.length) fail();
      evidence = {
        source: "proofread",
        document_version_id: text(raw.document_version_id),
        fragment_ids: Object.freeze(ids),
      };
    }
  } else {
    exact(raw, ["source", "observation_id", "provenance"]);
    if (raw.source !== "authority" && raw.source !== "manual") fail();
    const provenance = parseProvenance(raw.provenance);
    if (
      (raw.source === "authority" &&
        provenance.source_kind !== "metadata-provider") ||
      (raw.source === "manual" && provenance.source_kind !== "user")
    )
      fail();
    evidence = {
      source: raw.source,
      observation_id: text(raw.observation_id),
      provenance,
    };
  }
  return Object.freeze({
    field,
    value: normalized,
    evidence: Object.freeze(evidence),
  });
}

export function parseMetadataFieldState(value: unknown): MetadataFieldState {
  const row = exact(value, [
    "field",
    "value",
    "evidence",
    "locked",
    "conflict",
    "conflicts",
  ]);
  const selected = parseMetadataFieldCandidate({
    field: row.field,
    value: row.value,
    evidence: row.evidence,
  });
  if (
    typeof row.locked !== "boolean" ||
    typeof row.conflict !== "boolean" ||
    !Array.isArray(row.conflicts)
  )
    fail();
  if (row.locked && selected.evidence.source !== "manual") fail();
  const conflicts = row.conflicts.map(parseMetadataFieldCandidate);
  if (
    conflicts.some((c) => c.field !== selected.field) ||
    row.conflict !== conflicts.length > 0
  )
    fail();
  return Object.freeze({
    ...selected,
    locked: row.locked,
    conflict: row.conflict,
    conflicts: Object.freeze(conflicts),
  });
}

export interface MetadataEditRequest {
  readonly literature_id: string;
  readonly expected_revision: number;
  readonly set: readonly {
    readonly field: MetadataField;
    readonly value: MetadataValue;
  }[];
  readonly unlock: readonly MetadataField[];
}
export function parseMetadataEditRequest(value: unknown): MetadataEditRequest {
  const row = exact(value, [
    "literature_id",
    "expected_revision",
    "set",
    "unlock",
  ]);
  if (
    typeof row.expected_revision !== "number" ||
    !Number.isSafeInteger(row.expected_revision) ||
    row.expected_revision < 1 ||
    !Array.isArray(row.set) ||
    !Array.isArray(row.unlock)
  )
    fail();
  const set = row.set.map((value) => {
    const r = exact(value, ["field", "value"]);
    const field = parseMetadataField(r.field);
    return Object.freeze({
      field,
      value: parseLiteratureMetadata({ ...EMPTY_METADATA, [field]: r.value })[
        field
      ],
    });
  });
  const unlock = row.unlock.map(parseMetadataField);
  const fields = [...set.map((s) => s.field), ...unlock];
  if (!fields.length || new Set(fields).size !== fields.length) fail();
  return Object.freeze({
    literature_id: text(row.literature_id),
    expected_revision: row.expected_revision,
    set: Object.freeze(set),
    unlock: Object.freeze(unlock),
  });
}
