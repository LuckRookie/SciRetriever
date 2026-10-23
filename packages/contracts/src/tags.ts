import {
  ContractValidationError,
  parseLiteratureId,
  parseAssetId,
  canonicalJsonBytes,
  sha256,
} from "./index.js";

export interface TagEvidence {
  readonly document_version_id: string;
  readonly segment_ids: readonly string[];
}
export interface TagDefinition {
  readonly includes: string;
  readonly excludes: string;
}
export interface TagDraft {
  readonly name_zh: string;
  readonly name_en: string;
  readonly aliases: readonly string[];
  readonly definition: TagDefinition;
  readonly parent_id: string | null;
  readonly category: string | null;
  readonly kind: "topic" | "compound";
}
export interface Tag extends TagDraft {
  readonly tag_id: string;
  readonly status: "active" | "merged";
  readonly merged_into: string | null;
  readonly locked: boolean;
  readonly created_vocab_version: number;
  readonly backfilled_vocab_version: number | null;
  readonly examples: readonly {
    readonly literature_id: string;
    readonly evidence: TagEvidence;
  }[];
}
export interface TagAssignmentItem {
  readonly tag_id: string;
  readonly rank: number;
  readonly reason: string;
  readonly evidence: readonly TagEvidence[];
  readonly origin: "auto" | "manual" | "backfill";
  readonly locked: boolean;
}
export interface TagAssignment {
  readonly literature_id: string;
  readonly items: readonly TagAssignmentItem[];
  readonly vocab_version: number;
  readonly model: string | null;
  readonly assignment_sha256: string;
  readonly revision: number;
}
export type VocabularyActor =
  | "tagging"
  | "consolidation"
  | "manual"
  | "backfill";
export type VocabularyMutation =
  | { readonly op: "create"; readonly tag: TagDraft }
  | { readonly op: "merge"; readonly tag_id: string; readonly into: string }
  | {
      readonly op: "set-parent";
      readonly tag_id: string;
      readonly parent_id: string | null;
    }
  | {
      readonly op: "set-category";
      readonly tag_id: string;
      readonly category: string | null;
    }
  | {
      readonly op: "edit-definition";
      readonly tag_id: string;
      readonly definition: TagDefinition;
    }
  | {
      readonly op: "rename";
      readonly tag_id: string;
      readonly name_zh: string;
      readonly name_en: string;
      readonly aliases: readonly string[];
    }
  | {
      readonly op: "set-lock";
      readonly tag_id: string;
      readonly locked: boolean;
    }
  | {
      readonly op: "undo";
      readonly change_version: number;
      readonly cascade: boolean;
    };
export interface VocabularyChange {
  readonly created_at: string;
  readonly version: number;
  readonly op: VocabularyMutation["op"];
  readonly payload: VocabularyMutation;
  readonly inverse: readonly {
    readonly tag_id: string;
    readonly before: Tag | null;
  }[];
  readonly actor: VocabularyActor;
  readonly actor_label?: string;
  readonly reason: string;
  readonly affected_literatures: number;
  readonly outcome: "applied" | "skipped-locked";
  readonly undone_by: number | null;
}

function fail(): never {
  throw new ContractValidationError(["tag"]);
}
export function tagRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const r = value as Record<string, unknown>;
  if (
    Object.keys(r).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(r, k))
  )
    fail();
  return r;
}
export function tagText(
  value: unknown,
  allowEmpty = false,
  max = 4096,
): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    /[\p{Cc}\uD800-\uDFFF]/u.test(value)
  )
    fail();
  const result = value.normalize("NFC").trim();
  if (!allowEmpty && !result) fail();
  return result;
}
export function normalizedTagName(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .trim()
    .replace(/\s+/gu, " ");
}
function names(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 64) fail();
  const result = value.map((v) => tagText(v, false, 256));
  if (new Set(result.map(normalizedTagName)).size !== result.length) fail();
  return Object.freeze(result);
}
export function tagInteger(value: unknown, min = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < min) fail();
  return value as number;
}
function bool(value: unknown): boolean {
  if (typeof value !== "boolean") fail();
  return value;
}
export function parseTagDefinition(value: unknown): TagDefinition {
  const r = tagRecord(value, ["includes", "excludes"]);
  return Object.freeze({
    includes: tagText(r.includes),
    excludes: tagText(r.excludes, true),
  });
}
export function parseTagDraft(value: unknown): TagDraft {
  const r = tagRecord(value, [
    "name_zh",
    "name_en",
    "aliases",
    "definition",
    "parent_id",
    "category",
    "kind",
  ]);
  const name_zh = tagText(r.name_zh, true, 256),
    name_en = tagText(r.name_en, true, 256);
  if (!name_zh && !name_en) fail();
  if (r.kind !== "topic" && r.kind !== "compound") fail();
  return Object.freeze({
    name_zh,
    name_en,
    aliases: names(r.aliases),
    definition: parseTagDefinition(r.definition),
    parent_id: r.parent_id === null ? null : parseAssetId(r.parent_id),
    category: r.category === null ? null : tagText(r.category, false, 256),
    kind: r.kind,
  });
}
export function parseTagEvidence(value: unknown): TagEvidence {
  const r = tagRecord(value, ["document_version_id", "segment_ids"]);
  if (
    !Array.isArray(r.segment_ids) ||
    r.segment_ids.length < 1 ||
    r.segment_ids.length > 64
  )
    fail();
  const ids = r.segment_ids.map((v) => tagText(v, false, 256));
  if (new Set(ids).size !== ids.length) fail();
  return Object.freeze({
    document_version_id: parseAssetId(r.document_version_id),
    segment_ids: Object.freeze(ids),
  });
}
export function parseTagAssignmentItem(value: unknown): TagAssignmentItem {
  const r = tagRecord(value, [
    "tag_id",
    "rank",
    "reason",
    "evidence",
    "origin",
    "locked",
  ]);
  if (
    !Array.isArray(r.evidence) ||
    !r.evidence.length ||
    r.evidence.length > 64
  )
    fail();
  if (r.origin !== "auto" && r.origin !== "manual" && r.origin !== "backfill")
    fail();
  return Object.freeze({
    tag_id: parseAssetId(r.tag_id),
    rank: tagInteger(r.rank, 1),
    reason: tagText(r.reason),
    evidence: Object.freeze(r.evidence.map(parseTagEvidence)),
    origin: r.origin,
    locked: bool(r.locked),
  });
}
export async function tagAssignmentHash(
  value: Pick<TagAssignment, "literature_id" | "items">,
): Promise<string> {
  return sha256(
    canonicalJsonBytes({
      literature_id: parseLiteratureId(value.literature_id),
      items: value.items.map(parseTagAssignmentItem),
    }),
  );
}
export function parseVocabularyMutation(value: unknown): VocabularyMutation {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const op = (value as Record<string, unknown>).op;
  if (op === "create") {
    const r = tagRecord(value, ["op", "tag"]);
    return Object.freeze({ op, tag: parseTagDraft(r.tag) });
  }
  if (op === "undo") {
    const r = tagRecord(value, ["op", "change_version", "cascade"]);
    return Object.freeze({
      op,
      change_version: tagInteger(r.change_version, 1),
      cascade: bool(r.cascade),
    });
  }
  const extra =
    op === "merge"
      ? ["into"]
      : op === "set-parent"
        ? ["parent_id"]
        : op === "set-category"
          ? ["category"]
          : op === "edit-definition"
            ? ["definition"]
            : op === "rename"
              ? ["name_zh", "name_en", "aliases"]
              : op === "set-lock"
                ? ["locked"]
                : fail();
  const r = tagRecord(value, ["op", "tag_id", ...extra]),
    tag_id = parseAssetId(r.tag_id);
  switch (op) {
    case "merge":
      return Object.freeze({ op, tag_id, into: parseAssetId(r.into) });
    case "set-parent":
      return Object.freeze({
        op,
        tag_id,
        parent_id: r.parent_id === null ? null : parseAssetId(r.parent_id),
      });
    case "set-category":
      return Object.freeze({
        op,
        tag_id,
        category: r.category === null ? null : tagText(r.category, false, 256),
      });
    case "edit-definition":
      return Object.freeze({
        op,
        tag_id,
        definition: parseTagDefinition(r.definition),
      });
    case "rename": {
      const name_zh = tagText(r.name_zh, true, 256),
        name_en = tagText(r.name_en, true, 256);
      if (!name_zh && !name_en) fail();
      return Object.freeze({
        op,
        tag_id,
        name_zh,
        name_en,
        aliases: names(r.aliases),
      });
    }
    case "set-lock":
      return Object.freeze({ op, tag_id, locked: bool(r.locked) });
    default:
      return fail();
  }
}

export function parseTag(value: unknown): Tag {
  const r = tagRecord(value, [
    "name_zh",
    "name_en",
    "aliases",
    "definition",
    "parent_id",
    "category",
    "kind",
    "tag_id",
    "status",
    "merged_into",
    "locked",
    "created_vocab_version",
    "backfilled_vocab_version",
    "examples",
  ]);
  const draft = parseTagDraft(
    Object.fromEntries(
      [
        "name_zh",
        "name_en",
        "aliases",
        "definition",
        "parent_id",
        "category",
        "kind",
      ].map((k) => [k, r[k]]),
    ),
  );
  if (r.status !== "active" && r.status !== "merged") fail();
  const into = r.merged_into === null ? null : parseAssetId(r.merged_into);
  if (
    (r.status === "active") !== (into === null) ||
    !Array.isArray(r.examples) ||
    r.examples.length > 8
  )
    fail();
  return Object.freeze({
    ...draft,
    tag_id: parseAssetId(r.tag_id),
    status: r.status,
    merged_into: into,
    locked: bool(r.locked),
    created_vocab_version: tagInteger(r.created_vocab_version, 1),
    backfilled_vocab_version:
      r.backfilled_vocab_version === null
        ? null
        : tagInteger(r.backfilled_vocab_version),
    examples: Object.freeze(
      r.examples.map((v) => {
        const x = tagRecord(v, ["literature_id", "evidence"]);
        return Object.freeze({
          literature_id: parseLiteratureId(x.literature_id),
          evidence: parseTagEvidence(x.evidence),
        });
      }),
    ),
  });
}
export function parseTagAssignment(value: unknown): TagAssignment {
  const r = tagRecord(value, [
    "literature_id",
    "items",
    "vocab_version",
    "model",
    "assignment_sha256",
    "revision",
  ]);
  if (
    !Array.isArray(r.items) ||
    r.items.length < 1 ||
    r.items.length > 64 ||
    typeof r.assignment_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(r.assignment_sha256)
  )
    fail();
  const items = r.items.map(parseTagAssignmentItem);
  if (
    new Set(items.map((i) => i.tag_id)).size !== items.length ||
    items.some((i, n) => i.rank !== n + 1)
  )
    fail();
  return Object.freeze({
    literature_id: parseLiteratureId(r.literature_id),
    items: Object.freeze(items),
    vocab_version: tagInteger(r.vocab_version),
    model: r.model === null ? null : tagText(r.model),
    assignment_sha256: r.assignment_sha256,
    revision: tagInteger(r.revision, 1),
  });
}
