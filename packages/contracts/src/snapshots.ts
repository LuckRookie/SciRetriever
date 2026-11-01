import {
  canonicalJsonBytes,
  ContractValidationError,
  parseAssetId,
  parseLibraryQuery,
  parseLiteratureId,
  parseLiteratureMetadata,
  parseUtcTimestamp,
  sha256,
  type LibraryQuery,
  type LiteratureMetadata,
} from "./index.js";
import { tagRecord, tagText, tagInteger } from "./tags.js";
export type SnapshotDefinition =
  | { readonly kind: "literatures"; readonly literature_ids: readonly string[] }
  | { readonly kind: "query"; readonly query: LibraryQuery };
export interface ArchiveInputPart {
  readonly asset_id: string;
  readonly asset_sha256: string;
  readonly part: "main" | "supplementary";
  readonly available: boolean;
  readonly content_version: string | null;
  readonly document_version_id: string | null;
  readonly structure_annotation_id: string | null;
}
export interface SnapshotMember {
  readonly literature_id: string;
  readonly parts: readonly ArchiveInputPart[];
  readonly description_version: string;
  readonly metadata: LiteratureMetadata;
  readonly tags: readonly {
    readonly tag_id: string;
    readonly rank: number;
    readonly name_zh: string;
    readonly name_en: string;
  }[];
}
export interface Snapshot {
  readonly snapshot_id: string;
  readonly created_at: string;
  readonly definition: SnapshotDefinition;
  readonly members: readonly SnapshotMember[];
  readonly content_sha256: string;
}
export interface SnapshotHeader extends Omit<Snapshot, "members"> {
  readonly name: string;
  readonly name_source: "generated" | "manual";
  readonly member_count: number;
  readonly excluded_count: number;
}
/** Display labels are independent of immutable snapshot identity. Empty resets. */
export function parseSnapshotName(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (
    typeof value !== "string" ||
    value.length > 256 ||
    /[\p{Cc}\p{Cf}]/u.test(value)
  )
    fail();
  return value.trim() || null;
}
export function parseSnapshotCreate(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const { name, ...definition } = value as Record<string, unknown>;
  return {
    definition: parseSnapshotDefinition(definition),
    name: parseSnapshotName(name),
  };
}
export function parseSnapshotRename(value: unknown) {
  const r = tagRecord(value, ["snapshot_id", "name"]);
  return {
    snapshot_id: parseAssetId(r.snapshot_id),
    name: parseSnapshotName(r.name),
  };
}
export function parseSnapshotHeader(value: unknown): SnapshotHeader {
  const r = tagRecord(value, [
    "snapshot_id",
    "created_at",
    "definition",
    "content_sha256",
    "member_count",
    "excluded_count",
    "name",
    "name_source",
  ]);
  const name = parseSnapshotName(r.name);
  if (!name || !["generated", "manual"].includes(String(r.name_source))) fail();
  return {
    snapshot_id: parseAssetId(r.snapshot_id),
    created_at: parseUtcTimestamp(r.created_at),
    definition: parseSnapshotDefinition(r.definition),
    content_sha256: hash(r.content_sha256),
    member_count: tagInteger(r.member_count),
    excluded_count: tagInteger(r.excluded_count),
    name,
    name_source: r.name_source as SnapshotHeader["name_source"],
  };
}
export interface SnapshotDifference {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly content_changed: readonly string[];
  readonly description_changed: readonly string[];
}
function fail(): never {
  throw new ContractValidationError();
}
function hash(v: unknown): string {
  if (typeof v !== "string" || !/^[a-f0-9]{64}$/u.test(v)) fail();
  return v;
}
export function parseArchiveInputPart(value: unknown): ArchiveInputPart {
  const r = tagRecord(value, [
    "asset_id",
    "asset_sha256",
    "part",
    "available",
    "content_version",
    "document_version_id",
    "structure_annotation_id",
  ]);
  if (
    !["main", "supplementary"].includes(String(r.part)) ||
    typeof r.available !== "boolean"
  )
    fail();
  if (
    r.available
      ? [
          r.content_version,
          r.document_version_id,
          r.structure_annotation_id,
        ].some((v) => v === null)
      : [
          r.content_version,
          r.document_version_id,
          r.structure_annotation_id,
        ].some((v) => v !== null)
  )
    fail();
  return {
    asset_id: parseAssetId(r.asset_id),
    asset_sha256: hash(r.asset_sha256),
    part: r.part as ArchiveInputPart["part"],
    available: r.available,
    content_version:
      r.content_version === null ? null : hash(r.content_version),
    document_version_id:
      r.document_version_id === null
        ? null
        : parseAssetId(r.document_version_id),
    structure_annotation_id:
      r.structure_annotation_id === null
        ? null
        : hash(r.structure_annotation_id),
  };
}
export function parseSnapshotDefinition(value: unknown): SnapshotDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const r = value as Record<string, unknown>;
  if (r.kind === "literatures") {
    tagRecord(r, ["kind", "literature_ids"]);
    if (
      !Array.isArray(r.literature_ids) ||
      !r.literature_ids.length ||
      r.literature_ids.length > 10000
    )
      fail();
    return {
      kind: r.kind,
      literature_ids: [
        ...new Set(r.literature_ids.map(parseLiteratureId)),
      ].sort(),
    };
  }
  if (r.kind === "query") {
    tagRecord(r, ["kind", "query"]);
    const query = parseLibraryQuery(r.query);
    if (query.statuses.some((s) => s !== "READY")) fail();
    return { kind: r.kind, query };
  }
  return fail();
}
export function parseSnapshotMember(value: unknown): SnapshotMember {
  const r = tagRecord(value, [
    "literature_id",
    "parts",
    "description_version",
    "metadata",
    "tags",
  ]);
  if (
    !Array.isArray(r.parts) ||
    !r.parts.length ||
    r.parts.length > 1000 ||
    !Array.isArray(r.tags) ||
    r.tags.length > 64
  )
    fail();
  const parts = r.parts.map(parseArchiveInputPart);
  if (
    parts.filter((p) => p.part === "main" && p.available).length !== 1 ||
    new Set(parts.map((p) => p.asset_id)).size !== parts.length
  )
    fail();
  const tags = r.tags.map((v) => {
    const t = tagRecord(v, ["tag_id", "rank", "name_zh", "name_en"]);
    if (
      typeof t.name_zh !== "string" ||
      typeof t.name_en !== "string" ||
      t.name_zh.length > 256 ||
      t.name_en.length > 256
    )
      fail();
    return {
      tag_id: tagText(t.tag_id),
      rank: tagInteger(t.rank, 1),
      name_zh: t.name_zh,
      name_en: t.name_en,
    };
  });
  return {
    literature_id: parseLiteratureId(r.literature_id),
    parts,
    description_version: hash(r.description_version),
    metadata: parseLiteratureMetadata(r.metadata),
    tags,
  };
}
/** Empty fields introduced after v1 do not change immutable historical hashes. */
export function snapshotMemberValue(member: SnapshotMember) {
  const { subject_terms, ...metadata } = member.metadata;
  return {
    ...member,
    metadata: subject_terms.length ? member.metadata : metadata,
  };
}
export function snapshotDefinitionValue(definition: SnapshotDefinition) {
  if (definition.kind !== "query") return definition;
  const { intake_batch_ids, subject_terms, ...query } = definition.query;
  return {
    ...definition,
    query: {
      ...query,
      ...(intake_batch_ids.length ? { intake_batch_ids } : {}),
      ...(subject_terms.length ? { subject_terms } : {}),
    },
  };
}
export async function snapshotHash(
  definition: SnapshotDefinition,
  members: readonly SnapshotMember[],
) {
  const manifest = await Promise.all(
    members.map(async (m) => ({
      literature_id: m.literature_id,
      sha256: await sha256(canonicalJsonBytes(snapshotMemberValue(m))),
    })),
  );
  return sha256(
    canonicalJsonBytes({
      definition: snapshotDefinitionValue(definition),
      members: manifest,
    }),
  );
}
