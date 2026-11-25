import type { DatabaseSync } from "node:sqlite";
import type { LibraryTrashRequest } from "@sciretriever/contracts";
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
const { visibleLiteratureSql }: typeof import("./intake-visibility.js") =
  await import(
    new URL(
      import.meta.url.endsWith(".ts")
        ? "./intake-visibility.ts"
        : "./intake-visibility.js",
      import.meta.url,
    ).href
  );

export type LibraryTrashStorageCommand =
  | { readonly kind: "count" }
  | {
      readonly kind: "list";
      readonly limit: number;
      readonly after:
        | readonly [deleted_at: string, literature_id: string]
        | null;
    }
  | {
      readonly kind: "write";
      readonly request: LibraryTrashRequest;
      readonly at: string;
      readonly actor: string;
    };
export interface LibraryTrashStorageItem {
  readonly literature: {
    readonly literature_id: string;
    readonly identifiers: readonly { namespace: unknown; value: unknown }[];
    readonly title: unknown;
    readonly year: unknown;
  };
  readonly deleted_at: string;
  readonly deleted_by: string;
}
export interface LibraryTrashStoragePage {
  readonly items: readonly LibraryTrashStorageItem[];
  readonly more: boolean;
}

function fail(code: string): never {
  throw Object.assign(new Error(code), { code });
}

/** Both reads touch only library_trash and the listed papers' bibliography. */
function read<T>(db: DatabaseSync, operation: () => T): T {
  const own = !db.isTransaction;
  if (own) db.exec("BEGIN");
  try {
    const value = operation();
    if (own) db.exec("COMMIT");
    return value;
  } catch (error) {
    if (own && db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

function list(
  db: DatabaseSync,
  limit: number,
  after: readonly [string, string] | null,
): LibraryTrashStoragePage {
  const select =
    "SELECT t.literature_id,t.deleted_at,t.deleted_by,m.title,m.publication_year AS year FROM library_trash t INDEXED BY library_trash_order LEFT JOIN literature_metadata m ON m.literature_id=t.literature_id";
  const order = " ORDER BY t.deleted_at DESC,t.literature_id LIMIT ?";
  const rows = after
    ? db
        .prepare(
          select +
            " WHERE t.deleted_at<=? AND (t.deleted_at<? OR t.literature_id>?)" +
            order,
        )
        .all(after[0], after[0], after[1], limit + 1)
    : db.prepare(select + order).all(limit + 1);
  const page = rows.slice(0, limit);
  const identifiers = new Map<
    string,
    { namespace: unknown; value: unknown }[]
  >();
  for (const row of db
    .prepare(
      "SELECT literature_id,namespace,value FROM literature_metadata_identifiers WHERE literature_id IN (SELECT value FROM json_each(?)) ORDER BY literature_id,ordinal",
    )
    .all(JSON.stringify(page.map((row) => row.literature_id)))) {
    const id = String(row.literature_id),
      items = identifiers.get(id) ?? [];
    items.push({ namespace: row.namespace, value: row.value });
    identifiers.set(id, items);
  }
  return {
    items: page.map((row) => ({
      literature: {
        literature_id: String(row.literature_id),
        identifiers: identifiers.get(String(row.literature_id)) ?? [],
        title: row.title ?? null,
        year: row.year ?? null,
      },
      deleted_at: String(row.deleted_at),
      deleted_by: String(row.deleted_by),
    })),
    more: rows.length > limit,
  };
}

/** One write transaction. A missing, withdrawn or already deleted paper is not
 * a change; a paper targeted by a queued or running task refuses the request,
 * as an intake withdrawal does. */
function write(
  db: DatabaseSync,
  {
    request,
    at,
    actor,
  }: Extract<LibraryTrashStorageCommand, { kind: "write" }>,
) {
  const ids = JSON.stringify(request.selector.literature_ids);
  beginCatalogWrite(db);
  try {
    let changed: number;
    if (request.operation === "delete") {
      const targets = db
        .prepare(
          `SELECT l.literature_id FROM json_each(?) j JOIN literatures l ON l.literature_id=j.value WHERE ${visibleLiteratureSql("l.literature_id")} ORDER BY l.literature_id`,
        )
        .all(ids)
        .map((row) => String(row.literature_id));
      const keys = JSON.stringify(targets);
      if (
        targets.length &&
        db
          .prepare(
            "SELECT 1 FROM json_each(?) j JOIN execution_targets t ON t.literature_id=j.value JOIN execution_jobs job ON job.job_id=t.job_id WHERE job.status IN ('queued','running') LIMIT 1",
          )
          .get(keys)
      )
        fail("library-trash-busy");
      const insert = db.prepare(
        "INSERT INTO library_trash(literature_id,deleted_at,deleted_by) VALUES(?,?,?)",
      );
      for (const id of targets) insert.run(id, at, actor);
      changed = targets.length;
    } else
      changed = Number(
        db
          .prepare(
            "DELETE FROM library_trash WHERE literature_id IN (SELECT value FROM json_each(?))",
          )
          .run(ids).changes,
      );
    // Each marker row advances the source revision from its trigger, as a
    // direct SQL writer would; one request publishes one revision.
    if (changed)
      db.prepare(
        "UPDATE retrieval_source_revision SET revision=revision+1-? WHERE singleton=1",
      ).run(changed);
    commitCatalogWrite(db);
    return {
      operation: request.operation,
      target_count: request.selector.literature_ids.length,
      changed,
    };
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

export function runLibraryTrashStorage(
  db: DatabaseSync,
  command: LibraryTrashStorageCommand,
) {
  if (command.kind === "count")
    return read(db, () => ({
      total_count: Number(
        db.prepare("SELECT count(*) AS n FROM library_trash").get()!.n,
      ),
    }));
  if (command.kind === "list")
    return read(db, () => list(db, command.limit, command.after));
  return write(db, command);
}
