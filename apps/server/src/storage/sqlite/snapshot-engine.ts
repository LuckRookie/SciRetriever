import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  canonicalJsonBytes,
  parseSnapshotMember,
  parseSnapshotDefinition,
  type SnapshotMember,
  type SnapshotHeader,
} from "@sciretriever/contracts";
import type * as Archive from "./archive-engine.js";
import type * as Metadata from "./metadata-rows.js";
import type * as State from "../../literature/state.js";
const { archiveStates }: typeof Archive = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./archive-engine.ts"
      : "./archive-engine.js",
    import.meta.url,
  ).href
);
const { readMetadataRow }: typeof Metadata = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./metadata-rows.ts"
      : "./metadata-rows.js",
    import.meta.url,
  ).href
);
const { deriveCurrentState }: typeof State = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "../../literature/state.ts"
      : "../../literature/state.js",
    import.meta.url,
  ).href
);
export type SnapshotStorageAction =
  | "capture"
  | "publish"
  | "read"
  | "list"
  | "member";
const hash = (v: unknown) =>
  createHash("sha256").update(canonicalJsonBytes(v)).digest("hex");
const json = (v: unknown) =>
  Buffer.from(canonicalJsonBytes(v)).toString("utf8");
function fail(code: string): never {
  throw Object.assign(new Error("snapshot storage refused"), { code });
}
function capture(
  db: DatabaseSync,
  ids: readonly string[],
  maxTags: number,
  archiveProfile: "pipeline" | "vlm-engine",
) {
  const states = archiveStates(db, ids),
    members: SnapshotMember[] = [],
    excluded: { literature_id: string; reason: string }[] = [];
  for (const id of ids) {
    const state = states.get(id);
    if (!state) {
      excluded.push({ literature_id: id, reason: "not-found" });
      continue;
    }
    const { status } = deriveCurrentState(state, maxTags, archiveProfile);
    if (status !== "READY") {
      excluded.push({ literature_id: id, reason: status });
      continue;
    }
    const tags = db
      .prepare(
        "SELECT t.row_json,i.rank FROM literature_tag_items i JOIN tags t ON t.tag_id=i.tag_id WHERE i.literature_id=? ORDER BY i.rank",
      )
      .all(id)
      .map((row) => {
        const t = JSON.parse(String(row.row_json)) as {
          tag_id: string;
          name_zh: string;
          name_en: string;
        };
        return {
          tag_id: t.tag_id,
          name_zh: t.name_zh,
          name_en: t.name_en,
          rank: Number(row.rank),
        };
      });
    members.push(
      parseSnapshotMember({
        literature_id: id,
        parts: state.parts
          .map((p) => ({
            asset_id: p.asset_id,
            asset_sha256: p.asset_sha256,
            part: p.part,
            available: p.content_version !== null,
            content_version: p.content_version,
            document_version_id: p.content_version
              ? p.document_version_id
              : null,
            structure_annotation_id: p.content_version
              ? p.structure_annotation_id
              : null,
          }))
          .sort((a, b) => a.asset_id.localeCompare(b.asset_id)),
        description_version: state.description_version,
        metadata: readMetadataRow(db, "literature", id),
        tags,
      }),
    );
  }
  return {
    members: members.sort((a, b) =>
      a.literature_id.localeCompare(b.literature_id),
    ),
    excluded,
  };
}
function header(row: Record<string, unknown>): SnapshotHeader {
  return {
    snapshot_id: String(row.snapshot_id),
    created_at: String(row.created_at),
    definition: parseSnapshotDefinition(
      JSON.parse(String(row.definition_json)),
    ),
    content_sha256: String(row.content_sha256),
    member_count: Number(row.member_count),
    excluded_count: Number(row.excluded_count),
  };
}
export function runSnapshotStorage(
  db: DatabaseSync,
  action: SnapshotStorageAction,
  value: unknown,
  maxTags = 6,
  archiveProfile: "pipeline" | "vlm-engine" = "vlm-engine",
): unknown {
  const r = value as Record<string, unknown>;
  db.exec(action === "publish" ? "BEGIN IMMEDIATE" : "BEGIN");
  try {
    let result: unknown;
    if (action === "capture")
      result = capture(db, r.ids as string[], maxTags, archiveProfile);
    else if (action === "publish") {
      const definition = parseSnapshotDefinition(r.definition),
        members = (r.members as unknown[]).map(parseSnapshotMember),
        ids = members.map((m) => m.literature_id);
      const current = capture(db, ids, maxTags, archiveProfile);
      if (current.excluded.length || hash(current.members) !== hash(members))
        fail("snapshot-input-changed");
      const manifest = members.map((m) => ({
          literature_id: m.literature_id,
          sha256: hash(m),
        })),
        digest = hash({ definition, members: manifest });
      if (r.content_sha256 !== digest) fail("snapshot-integrity");
      db.prepare("INSERT INTO snapshots VALUES(?,?,?,?,?,?)").run(
        String(r.snapshot_id),
        String(r.created_at),
        json(definition),
        digest,
        members.length,
        Number(r.excluded_count),
      );
      for (const member of members)
        if (Buffer.byteLength(json(member)) > 1024 * 1024)
          fail("snapshot-member-budget");
      for (const [ordinal, member] of members.entries())
        db.prepare("INSERT INTO snapshot_members VALUES(?,?,?,?,?)").run(
          String(r.snapshot_id),
          member.literature_id,
          ordinal,
          hash(member),
          json(member),
        );
      result = header(
        db
          .prepare("SELECT * FROM snapshots WHERE snapshot_id=?")
          .get(String(r.snapshot_id))!,
      );
    } else if (action === "member") {
      const row = db
        .prepare("SELECT * FROM snapshots WHERE snapshot_id=?")
        .get(String(r.snapshot_id));
      if (!row) fail("snapshot-not-found");
      const manifest = db
        .prepare(
          "SELECT literature_id,member_sha256 FROM snapshot_members WHERE snapshot_id=? ORDER BY ordinal",
        )
        .all(String(r.snapshot_id))
        .map((m) => ({
          literature_id: m.literature_id,
          sha256: m.member_sha256,
        }));
      if (
        hash({
          definition: JSON.parse(String(row.definition_json)),
          members: manifest,
        }) !== row.content_sha256
      )
        fail("snapshot-integrity");
      let member: SnapshotMember | null = null;
      if (r.literature_id !== null) {
        const saved = db
          .prepare(
            "SELECT member_json,member_sha256 FROM snapshot_members WHERE snapshot_id=? AND literature_id=?",
          )
          .get(String(r.snapshot_id), String(r.literature_id));
        if (!saved) fail("snapshot-member-missing");
        member = parseSnapshotMember(JSON.parse(String(saved.member_json)));
        if (hash(member) !== saved.member_sha256) fail("snapshot-integrity");
      }
      result = { ...header(row), member };
    } else if (action === "read") {
      const row = db
        .prepare("SELECT * FROM snapshots WHERE snapshot_id=?")
        .get(String(r.snapshot_id));
      if (!row) fail("snapshot-not-found");
      const offset = Number(r.offset ?? 0),
        limit = Math.min(200, Number(r.limit ?? 100)),
        budget = Number(r.max_bytes ?? 262144);
      const saved = db
        .prepare(
          "SELECT * FROM snapshot_members WHERE snapshot_id=? AND ordinal>=? ORDER BY ordinal LIMIT ?",
        )
        .all(String(r.snapshot_id), offset, limit);
      const members: SnapshotMember[] = [];
      let bytes = Buffer.byteLength(json(header(row))) + 256;
      if (bytes > budget) fail("snapshot-read-budget");
      if (offset < Number(row.member_count) && saved.length === 0)
        fail("snapshot-integrity");
      for (const m of saved) {
        if (m.ordinal !== offset + members.length) fail("snapshot-integrity");
        const size = Buffer.byteLength(String(m.member_json));
        if (bytes + size > budget) {
          if (!members.length) fail("snapshot-member-budget");
          break;
        }
        const parsed = parseSnapshotMember(JSON.parse(String(m.member_json)));
        if (hash(parsed) !== m.member_sha256) fail("snapshot-integrity");
        members.push(parsed);
        bytes += size;
      }
      const meta = header(row);
      result = {
        ...meta,
        members,
        next_offset:
          offset + members.length < meta.member_count
            ? offset + members.length
            : null,
      };
    } else if (action === "list") {
      const after = String(r.after ?? ""),
        limit = Math.min(200, Number(r.limit ?? 50)),
        list = db
          .prepare(
            "SELECT * FROM snapshots WHERE snapshot_id>? ORDER BY snapshot_id LIMIT ?",
          )
          .all(after, limit + 1);
      const items: SnapshotHeader[] = [];
      let bytes = 128;
      for (const row of list.slice(0, limit)) {
        const h = header(row),
          size = Buffer.byteLength(json(h));
        if (bytes + size > 1024 * 1024) break;
        items.push(h);
        bytes += size;
      }
      if (list.length && !items.length) fail("snapshot-read-budget");
      result = {
        items,
        next_after:
          list.length > items.length ? items.at(-1)!.snapshot_id : null,
      };
    } else fail("snapshot-operation-invalid");
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
