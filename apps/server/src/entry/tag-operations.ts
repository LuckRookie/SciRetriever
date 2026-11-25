import {
  parseTagAssignmentItem,
  tagInteger,
  tagRecord,
  tagText,
} from "@sciretriever/contracts";
import type { TagService } from "../tags/service.js";
import { TagError } from "../tags/rules.js";
export async function queryTags(
  tags: TagService,
  value: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const r = tagRecord(value, ["operation", "request"]);
  if (r.operation === "list" || r.operation === "search") {
    if (!r.request || typeof r.request !== "object" || Array.isArray(r.request))
      throw new TagError("tags-invalid");
    const input = r.request as Record<string, unknown>;
    if (
      Object.keys(input).some(
        (k) =>
          ![
            "query",
            "limit",
            "offset",
            "status",
            "parent_id",
            "category",
          ].includes(k),
      )
    )
      throw new TagError("tags-invalid");
    return tags.list(input, signal);
  }
  if (r.operation === "undo-preview") {
    const q = tagRecord(r.request, ["change_version"]);
    return tags.undoPreview(tagInteger(q.change_version, 1), signal);
  }
  if (r.operation === "state") {
    tagRecord(r.request, []);
    return {
      ...(await tags.state(signal)),
      max_per_literature: tags.configuration.max_per_literature,
    };
  }
  if (r.operation === "show") {
    const q = tagRecord(r.request, ["tag_id"]);
    return tags.get(tagText(q.tag_id), signal);
  }
  if (r.operation === "changes") {
    const q = tagRecord(r.request, ["since", "limit"]);
    return tags.changes(tagInteger(q.since), tagInteger(q.limit, 1), signal);
  }
  if (r.operation === "assignment") {
    const q = tagRecord(r.request, ["literature_id"]);
    return tags.assignment(tagText(q.literature_id), signal);
  }
  if (r.operation === "assignment-detail") {
    const q = tagRecord(r.request, ["literature_id"]);
    return tags.assignmentDetail(tagText(q.literature_id), signal);
  }
  if (r.operation === "backfill-preview") {
    const q = tagRecord(r.request, ["tag_ids"]);
    if (!Array.isArray(q.tag_ids)) throw new TagError("tags-invalid");
    return tags.backfill(
      q.tag_ids.map((v) => tagText(v)),
      true,
      signal,
    );
  }
  throw new TagError("tags-invalid");
}
export async function manageTags(
  tags: TagService,
  value: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const r = tagRecord(value, ["operation", "request"]);
  if (r.operation === "change") return tags.change(r.request, "manual", signal);
  if (r.operation === "assign") {
    const q = tagRecord(r.request, [
      "literature_id",
      "items",
      "expected_revision",
      "expected_version",
      "reason",
      "model",
    ]);
    if (!Array.isArray(q.items)) throw new TagError("tags-invalid");
    return tags.assign(
      {
        ...q,
        items: q.items.map((v) => ({
          ...parseTagAssignmentItem(v),
          origin: "manual",
          locked: true,
        })),
      },
      "manual",
      signal,
    );
  }
  if (r.operation === "build") return tags.build(r.request, signal);
  if (r.operation === "consolidate") {
    tagRecord(r.request, []);
    return tags.consolidate(signal);
  }
  if (r.operation === "backfill") {
    const q = tagRecord(r.request, ["tag_ids", "dry_run"]);
    if (!Array.isArray(q.tag_ids) || typeof q.dry_run !== "boolean")
      throw new TagError("tags-invalid");
    return tags.backfill(
      q.tag_ids.map((v) => tagText(v)),
      q.dry_run,
      signal,
    );
  }
  if (r.operation === "lock") {
    const q = tagRecord(r.request, [
      "literature_id",
      "tag_id",
      "locked",
      "expected_revision",
    ]);
    if (typeof q.locked !== "boolean") throw new TagError("tags-invalid");
    const prior = await tags.assignment(tagText(q.literature_id), signal);
    if (
      !prior ||
      prior.revision !== q.expected_revision ||
      !prior.items.some((i) => i.tag_id === q.tag_id)
    )
      throw new TagError("tag-assignment-stale");
    return tags.assign(
      {
        literature_id: prior.literature_id,
        items: prior.items.map((i) =>
          i.tag_id === q.tag_id
            ? { ...i, locked: q.locked, origin: "manual" }
            : i,
        ),
        expected_revision: prior.revision,
        expected_version: (await tags.state(signal)).version,
        model: null,
        reason: "Manual tag lock",
      },
      "manual",
      signal,
    );
  }
  throw new TagError("tags-invalid");
}
