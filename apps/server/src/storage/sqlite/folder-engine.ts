const {
  visibleLiteratureSql,
  visibleObjectSql,
}: typeof import("./intake-visibility.js") = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./intake-visibility.ts"
      : "./intake-visibility.js",
    import.meta.url,
  ).href
);
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
const {
  beginCatalogWrite,
  commitCatalogWrite,
}: typeof import("./catalog-write.js") = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./catalog-write.ts"
      : "./catalog-write.js",
    import.meta.url,
  ).href
);
import {
  parseFolderOperation,
  parseFolderNode,
  parseReadingOpen,
  parseFolderExportRequest,
  type FolderExportNode,
} from "@sciretriever/contracts";
const {
  recordIntakeObject,
  intakeMemberObjectId,
}: typeof import("./intake-objects.js") = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./intake-objects.ts"
      : "./intake-objects.js",
    import.meta.url,
  ).href
);
export const FOLDER_DESCENDANTS_SQL = `WITH RECURSIVE descendants(id) AS (SELECT folder_id FROM folders WHERE folder_id=? AND ${visibleObjectSql("folder", "folder_id")} UNION SELECT f.folder_id FROM folders f JOIN descendants d ON f.parent_id=d.id WHERE ${visibleObjectSql("folder", "f.folder_id")}) SELECT id FROM descendants`;
function fail(code: string): never {
  throw Object.assign(new Error(code), { code });
}
function folder(db: DatabaseSync, id: string) {
  const row = db
    .prepare(
      `SELECT folder_id,parent_id,name,position,created_at,updated_at FROM folders WHERE folder_id=? AND ${visibleObjectSql("folder", "folder_id")}`,
    )
    .get(id);
  if (!row) fail("folder-not-found");
  return row;
}
function impact(db: DatabaseSync, id: string) {
  folder(db, id);
  const ids = db
    .prepare(FOLDER_DESCENDANTS_SQL)
    .all(id)
    .map((r) => String(r.id));
  const counts = db
    .prepare(
      `SELECT count(*) AS members,count(DISTINCT literature_id) AS papers FROM folder_members WHERE ${visibleLiteratureSql("literature_id")} AND ${visibleObjectSql("folder-member", "json_array(folder_id,literature_id)")} AND folder_id IN (SELECT value FROM json_each(?))`,
    )
    .get(JSON.stringify(ids))!;
  return {
    ids,
    folder_count: ids.length,
    descendant_count: ids.length - 1,
    literature_count: Number(counts.papers),
    membership_count: Number(counts.members),
  };
}
function present(db: DatabaseSync, row: Record<string, unknown>) {
  const id = String(row.folder_id),
    counts = impact(db, id);
  return parseFolderNode({
    ...row,
    own_count: Number(
      db
        .prepare(
          `SELECT count(*) AS n FROM folder_members WHERE folder_id=? AND ${visibleLiteratureSql("literature_id")} AND ${visibleObjectSql("folder-member", "json_array(folder_id,literature_id)")}`,
        )
        .get(id)!.n,
    ),
    total_count: counts.literature_count,
  });
}
function orderSiblings(
  db: DatabaseSync,
  parent: string | null,
  id: string | null,
  index = 0,
) {
  const ids = db
    .prepare(
      "SELECT folder_id FROM folders WHERE parent_id IS ? ORDER BY position,folder_id",
    )
    .all(parent)
    .map((r) => String(r.folder_id))
    .filter((v) => v !== id);
  if (id !== null) ids.splice(Math.min(index, ids.length), 0, id);
  for (const [position, folderId] of ids.entries())
    db.prepare(
      "UPDATE folders SET position=? WHERE folder_id=? AND position<>?",
    ).run(position, folderId, position);
}
export function libraryMembership(db: DatabaseSync, id: string) {
  return {
    folder_ids: db
      .prepare(
        `SELECT folder_id FROM folder_members WHERE literature_id=? AND ${visibleObjectSql("folder", "folder_id")} AND ${visibleObjectSql("folder-member", "json_array(folder_id,literature_id)")} ORDER BY folder_id`,
      )
      .all(id)
      .map((r) => String(r.folder_id)),
    last_opened_at:
      db
        .prepare(
          "SELECT last_opened_at FROM reading_history WHERE literature_id=?",
        )
        .get(id)?.last_opened_at ?? null,
  };
}
export interface FolderExportStoragePage {
  readonly folders: readonly FolderExportNode[] | null;
  readonly members: readonly { folder_id: string; literature_id: string }[];
  readonly more: boolean;
}
function readExport(db: DatabaseSync, value: unknown): FolderExportStoragePage {
  const r = value as {
    request: unknown;
    export_after?: readonly [string, string] | null;
    export_folder_id?: string;
    export_tree_only?: boolean;
    export_include_tree?: boolean;
  };
  const request = parseFolderExportRequest(r.request),
    own = !db.isTransaction;
  if (own) db.exec("BEGIN");
  try {
    const folders = r.export_include_tree
      ? (db
          .prepare(
            `SELECT folder_id,name,parent_id,position FROM folders WHERE ${visibleObjectSql("folder", "folder_id")} ORDER BY folder_id`,
          )
          .all() as unknown as FolderExportNode[])
      : null;
    const where: string[] = [
        visibleLiteratureSql("literature_id"),
        visibleObjectSql("folder", "folder_id"),
        visibleObjectSql(
          "folder-member",
          "json_array(folder_id,literature_id)",
        ),
      ],
      args: SQLInputValue[] = [];
    if (r.export_folder_id !== undefined) {
      where.push("folder_id=?");
      args.push(r.export_folder_id);
    }
    if (r.export_after) {
      if (r.export_folder_id !== undefined) {
        where.push("literature_id>?");
        args.push(r.export_after[1]);
      } else {
        where.push("(folder_id,literature_id)>(?,?)");
        args.push(...r.export_after);
      }
    }
    const members = r.export_tree_only
      ? []
      : (db
          .prepare(
            "SELECT folder_id,literature_id FROM folder_members" +
              (where.length ? " WHERE " + where.join(" AND ") : "") +
              " ORDER BY folder_id,literature_id LIMIT ?",
          )
          .all(...args, request.limit + 1) as unknown as {
          folder_id: string;
          literature_id: string;
        }[]);
    const more = members.length > request.limit;
    if (more) members.pop();
    if (own) db.exec("COMMIT");
    return { folders, members, more };
  } catch (error) {
    if (own && db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
export function runFolderStorage(db: DatabaseSync, value: unknown): unknown {
  const r = value as {
    operation: string;
    request: unknown;
    now?: string;
    actor?: string;
    folder_id?: string;
    intake_batch_id?: string;
  };
  if (r.operation === "export") return readExport(db, value);
  const write = !["list", "delete-preview"].includes(r.operation);
  if (write) beginCatalogWrite(db);
  else db.exec("BEGIN");
  try {
    let result: unknown;
    if (r.operation === "opened") {
      const { literature_id } = parseReadingOpen(r.request);
      if (
        !db
          .prepare(
            `SELECT 1 FROM literatures WHERE literature_id=? AND ${visibleLiteratureSql("literature_id")}`,
          )
          .get(literature_id)
      )
        fail("literature-not-found");
      db.prepare(
        "INSERT INTO reading_history(literature_id,last_opened_at,open_count) VALUES(?,?,1) ON CONFLICT(literature_id) DO UPDATE SET last_opened_at=MAX(last_opened_at,excluded.last_opened_at),open_count=open_count+1",
      ).run(literature_id, r.now!);
      result = db
        .prepare(
          "SELECT literature_id,last_opened_at,open_count FROM reading_history WHERE literature_id=?",
        )
        .get(literature_id);
    } else {
      const op = parseFolderOperation({
        operation: r.operation,
        request: r.request,
      });
      if (op.operation === "export") fail("folder-read-operation-invalid");
      const req = op.request;
      if (op.operation === "list")
        result = {
          items: db
            .prepare(
              `SELECT folder_id,parent_id,name,position,created_at,updated_at FROM folders WHERE ${visibleObjectSql("folder", "folder_id")} ORDER BY parent_id,position,folder_id`,
            )
            .all()
            .map((row) => present(db, row)),
        };
      else if (op.operation === "delete-preview" || op.operation === "delete") {
        const { ids, ...counts } = impact(db, op.request.folder_id);
        if (op.operation === "delete")
          db.prepare(
            "DELETE FROM folders WHERE folder_id IN (SELECT value FROM json_each(?))",
          ).run(JSON.stringify(ids));
        result = counts;
      } else if (op.operation === "add" || op.operation === "remove") {
        folder(db, op.request.folder_id);
        const ids = op.request.literature_ids;
        if (
          Number(
            db
              .prepare(
                `SELECT count(*) AS n FROM literatures WHERE ${visibleLiteratureSql("literature_id")} AND literature_id IN (SELECT value FROM json_each(?))`,
              )
              .get(JSON.stringify(ids))!.n,
          ) !== ids.length
        )
          fail("literature-not-found");
        // The ids that really changed let a caller undo exactly this change.
        const changedIds: string[] = [];
        for (const id of ids)
          if (
            Number(
              op.operation === "add"
                ? db
                    .prepare(
                      "INSERT INTO folder_members(folder_id,literature_id,added_at,actor) VALUES(?,?,?,?) ON CONFLICT DO NOTHING",
                    )
                    .run(op.request.folder_id, id, r.now!, r.actor!).changes
                : db
                    .prepare(
                      "DELETE FROM folder_members WHERE folder_id=? AND literature_id=?",
                    )
                    .run(op.request.folder_id, id).changes,
            )
          ) {
            changedIds.push(id);
            if (op.operation === "add")
              recordIntakeObject(
                db,
                r.intake_batch_id,
                "folder-member",
                intakeMemberObjectId(op.request.folder_id, id),
              );
          }
        result = {
          folder_id: op.request.folder_id,
          changed: changedIds.length,
          changed_ids: changedIds,
        };
      } else {
        const id =
          op.operation === "create" ? r.folder_id! : op.request.folder_id;
        const old = op.operation === "create" ? null : folder(db, id);
        const parent =
          "parent_id" in req
            ? req.parent_id
            : (old!.parent_id as string | null);
        if (parent !== null) folder(db, parent);
        if (
          op.operation === "move" &&
          (parent === id ||
            (parent !== null && impact(db, id).ids.includes(parent)))
        )
          fail("folder-cycle");
        const name = "name" in req ? req.name : String(old!.name);
        if (
          db
            .prepare(
              "SELECT 1 FROM folders WHERE parent_id IS ? AND name=? AND folder_id<>?",
            )
            .get(parent, name, id)
        )
          fail("folder-name-conflict");
        const position =
          "position" in req && req.position !== null
            ? req.position
            : old
              ? Number(old.position)
              : Number(
                  db
                    .prepare(
                      "SELECT COALESCE(MAX(position),-1)+1 AS n FROM folders WHERE parent_id IS ?",
                    )
                    .get(parent)!.n,
                );
        if (op.operation === "create")
          db.prepare(
            "INSERT INTO folders(folder_id,parent_id,name,position,created_at,updated_at) VALUES(?,?,?,?,?,?)",
          ).run(id, parent, name, position, r.now!, r.now!);
        else
          db.prepare(
            "UPDATE folders SET parent_id=?,name=?,position=?,updated_at=? WHERE folder_id=?",
          ).run(parent, name, position, r.now!, id);
        if (op.operation === "create" || op.operation === "move") {
          if (op.operation === "create")
            recordIntakeObject(db, r.intake_batch_id, "folder", id);
          if (old && old.parent_id !== parent)
            orderSiblings(db, old.parent_id as string | null, null);
          orderSiblings(db, parent, id, position);
        }
        result = present(db, folder(db, id));
      }
    }
    if (write) commitCatalogWrite(db);
    else db.exec("COMMIT");
    return result;
  } catch (e) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw e;
  }
}
