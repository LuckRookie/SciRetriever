import {
  parseSnapshotHeader,
  parseSnapshotCreate,
  parseSnapshotRename,
  parseSnapshotMember,
} from "@sciretriever/contracts";
import type { ApiClient } from "./api.js";
import { archiveQuery, archiveWrite } from "./archive.js";
import { record } from "./wire.js";

function header(value: Record<string, unknown>) {
  return parseSnapshotHeader(
    Object.fromEntries(
      [
        "snapshot_id",
        "created_at",
        "definition",
        "content_sha256",
        "member_count",
        "excluded_count",
        "name",
        "name_source",
      ].map((k) => [k, value[k]]),
    ),
  );
}
export async function listSnapshots(
  api: ApiClient,
  after: string | null = null,
  limit = 50,
  signal?: AbortSignal,
) {
  const r = record(
    await archiveQuery(
      api,
      "snapshots",
      { operation: "list", request: { after, limit } },
      signal,
    ),
    "snapshots",
  );
  if (
    !Array.isArray(r.items) ||
    (r.next_after !== null && typeof r.next_after !== "string")
  )
    throw new Error("快照列表回执无效");
  return {
    items: r.items.map(parseSnapshotHeader),
    next_after: r.next_after as string | null,
  };
}
export async function readSnapshot(
  api: ApiClient,
  snapshot_id: string,
  offset = 0,
  signal?: AbortSignal,
) {
  const r = record(
    await archiveQuery(
      api,
      "snapshots",
      {
        operation: "read",
        request: { snapshot_id, offset, limit: 100, max_bytes: 262144 },
      },
      signal,
    ),
    "snapshot",
  );
  if (
    !Array.isArray(r.members) ||
    (r.next_offset !== null &&
      (!Number.isSafeInteger(r.next_offset) || Number(r.next_offset) < 0))
  )
    throw new Error("快照回执无效");
  return {
    ...header(r),
    members: r.members.map(parseSnapshotMember),
    next_offset: r.next_offset as number | null,
  };
}
export async function createSnapshot(
  api: ApiClient,
  value: unknown,
  signal?: AbortSignal,
) {
  const { definition, name } = parseSnapshotCreate(value);
  const r = record(
    await archiveWrite(api, "snapshots", { ...definition, name }, signal),
    "snapshot",
  );
  return {
    ...header(r),
    excluded: r.excluded,
    excluded_truncated: r.excluded_truncated,
  };
}
export async function renameSnapshot(
  api: ApiClient,
  value: unknown,
  signal?: AbortSignal,
) {
  return parseSnapshotHeader(
    await archiveWrite(
      api,
      "snapshot-rename",
      parseSnapshotRename(value),
      signal,
    ),
  );
}
