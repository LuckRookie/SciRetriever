import { activityContext } from "../logging/activity.js";
import { randomUUID } from "node:crypto";
import {
  parseAssetId,
  parseSnapshotCreate,
  parseSnapshotRename,
  snapshotHash,
  tagRecord,
  tagInteger,
  canonicalJsonBytes,
  type SnapshotMember,
  type SnapshotHeader,
  type SnapshotDifference,
} from "@sciretriever/contracts";
import type { SqliteWorker } from "../storage/sqlite/worker.js";
import type { LiteratureQueryService } from "../literature/query.js";
export class SnapshotError extends Error {
  readonly code: string;
  constructor(code: string) {
    super("snapshot operation failed");
    this.name = "SnapshotError";
    this.code = code;
  }
}
export class SnapshotService {
  constructor(
    private readonly database: SqliteWorker,
    private readonly library: Pick<LiteratureQueryService, "search">,
  ) {}
  async create(value: unknown, signal?: AbortSignal) {
    const { definition, name } = parseSnapshotCreate(value);
    let ids: readonly string[];
    if (definition.kind === "literatures") ids = definition.literature_ids;
    else {
      const selected = await this.library.search(
        {
          query: definition.query,
          sort: "title-asc",
          limit: 10001,
          cursor: null,
        },
        signal,
        "selection",
      );
      if (selected.next_cursor !== null || selected.items.length > 10000)
        throw new SnapshotError("snapshot-member-limit");
      ids = selected.items.map((i) => i.literature.literature_id);
    }
    const captured = await this.database.snapshot<{
      members: SnapshotMember[];
      excluded: { literature_id: string; reason: string }[];
    }>("capture", { ids }, signal);
    const snapshot = {
      snapshot_id: randomUUID(),
      name,
      actor: activityContext().actor,
      created_at: new Date().toISOString(),
      definition,
      members: captured.members,
      content_sha256: await snapshotHash(definition, captured.members),
      excluded_count: captured.excluded.length,
    };
    const header = await this.database.snapshot<SnapshotHeader>(
      "publish",
      snapshot,
      signal,
    );
    return {
      ...header,
      excluded: captured.excluded.slice(0, 200),
      excluded_truncated: captured.excluded.length > 200,
    };
  }
  rename(value: unknown, signal?: AbortSignal): Promise<SnapshotHeader> {
    return this.database.snapshot(
      "rename",
      {
        ...parseSnapshotRename(value),
        actor: activityContext().actor,
        updated_at: new Date().toISOString(),
      },
      signal,
    );
  }
  read(value: unknown, signal?: AbortSignal) {
    const r = tagRecord(value, ["snapshot_id", "offset", "limit", "max_bytes"]),
      limit = tagInteger(r.limit, 1),
      max_bytes = tagInteger(r.max_bytes, 1024);
    if (limit > 200 || max_bytes > 4 * 1024 * 1024)
      throw new SnapshotError("snapshot-read-limit");
    return this.database.snapshot<
      SnapshotHeader & { members: SnapshotMember[]; next_offset: number | null }
    >(
      "read",
      {
        snapshot_id: parseAssetId(r.snapshot_id),
        offset: tagInteger(r.offset),
        limit,
        max_bytes,
      },
      signal,
    );
  }
  list(value: unknown, signal?: AbortSignal) {
    const r = tagRecord(value, ["after", "limit"]),
      limit = tagInteger(r.limit, 1);
    if (limit > 200) throw new SnapshotError("snapshot-read-limit");
    return this.database.snapshot<{
      items: SnapshotHeader[];
      next_after: string | null;
    }>(
      "list",
      { after: r.after === null ? "" : parseAssetId(r.after), limit },
      signal,
    );
  }
  async all(id: string, signal?: AbortSignal) {
    let offset = 0,
      bytes = 0;
    const members: SnapshotMember[] = [];
    for (;;) {
      const page = await this.read(
        { snapshot_id: id, offset, limit: 200, max_bytes: 4 * 1024 * 1024 },
        signal,
      );
      bytes += canonicalJsonBytes(page.members).byteLength;
      if (bytes > 64 * 1024 * 1024)
        throw new SnapshotError("snapshot-memory-limit");
      members.push(...page.members);
      if (page.next_offset === null) {
        if (
          (await snapshotHash(page.definition, members)) !== page.content_sha256
        )
          throw new SnapshotError("snapshot-integrity");
        return { ...page, members };
      }
      offset = page.next_offset;
    }
  }
  async diff(
    value: unknown,
    signal?: AbortSignal,
  ): Promise<SnapshotDifference> {
    const r = tagRecord(value, ["before", "after"]),
      before = await this.all(parseAssetId(r.before), signal),
      after = await this.all(parseAssetId(r.after), signal);
    const old = new Map(before.members.map((m) => [m.literature_id, m])),
      fresh = new Map(after.members.map((m) => [m.literature_id, m]));
    const content = (m: SnapshotMember) =>
      JSON.stringify(m.parts.map((p) => [p.asset_id, p.content_version]));
    return {
      added: after.members
        .filter((m) => !old.has(m.literature_id))
        .map((m) => m.literature_id),
      removed: before.members
        .filter((m) => !fresh.has(m.literature_id))
        .map((m) => m.literature_id),
      content_changed: after.members
        .filter(
          (m) =>
            old.has(m.literature_id) &&
            content(m) !== content(old.get(m.literature_id)!),
        )
        .map((m) => m.literature_id),
      description_changed: after.members
        .filter(
          (m) =>
            old.has(m.literature_id) &&
            m.description_version !==
              old.get(m.literature_id)!.description_version,
        )
        .map((m) => m.literature_id),
    };
  }
  query(value: unknown, signal?: AbortSignal): Promise<unknown> {
    const r = tagRecord(value, ["operation", "request"]);
    if (r.operation === "read") return this.read(r.request, signal);
    if (r.operation === "list") return this.list(r.request, signal);
    if (r.operation === "diff") return this.diff(r.request, signal);
    throw new SnapshotError("snapshot-operation-invalid");
  }
}
