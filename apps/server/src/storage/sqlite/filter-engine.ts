import type { DatabaseSync } from "node:sqlite";
import {
  ContractValidationError,
  parseFilterOperation,
  parseFilterImportInput,
  parseSavedFilter,
  parseUtcTimestamp,
  truncateFilterName,
  type FilterImportItem,
  type FilterInput,
  type SavedFilter,
} from "@sciretriever/contracts";

function fail(code: string): never {
  throw Object.assign(new Error(code), { code });
}
function row(db: DatabaseSync, id: string) {
  const value = db
    .prepare("SELECT * FROM saved_filters WHERE filter_id=?")
    .get(id);
  if (!value) fail("filter-not-found");
  return value;
}
function present(
  db: DatabaseSync,
  value: Record<string, unknown>,
): SavedFilter {
  const query = JSON.parse(String(value.query_json));
  const folder = query.folder?.id;
  return parseSavedFilter({
    filter_id: value.filter_id,
    name: value.name,
    query,
    sort: value.sort,
    missing_folder_id:
      folder &&
      !db.prepare("SELECT 1 FROM folders WHERE folder_id=?").get(folder)
        ? folder
        : null,
    created_at: value.created_at,
    updated_at: value.updated_at,
  });
}
function ensureRoom(db: DatabaseSync) {
  if (
    Number(db.prepare("SELECT count(*) n FROM saved_filters").get()!.n) >= 200
  )
    fail("filter-limit");
}
function insert(db: DatabaseSync, input: FilterInput, id: string, now: string) {
  ensureRoom(db);
  db.prepare("INSERT INTO saved_filters VALUES(?,?,?,?,?,?)").run(
    id,
    input.name,
    JSON.stringify(input.query),
    input.sort,
    now,
    now,
  );
  return present(db, row(db, id));
}
export function runFilterStorage(db: DatabaseSync, value: unknown): unknown {
  const r = value as {
    operation: string;
    request: unknown;
    now?: string;
    filter_id?: string;
    import_ids?: readonly string[];
  };
  const op = parseFilterOperation({
    operation: r.operation,
    request: r.request,
  });
  db.exec(op.operation === "list" ? "BEGIN" : "BEGIN IMMEDIATE");
  try {
    let result: unknown;
    if (op.operation === "list") {
      result = {
        items: db
          .prepare("SELECT * FROM saved_filters ORDER BY name COLLATE BINARY")
          .all()
          .map((v) => present(db, v)),
      };
    } else {
      const now = parseUtcTimestamp(r.now);
      if (op.operation === "import") {
        const items: FilterImportItem[] = [];
        for (const [index, value] of op.request.items.entries()) {
          let input: FilterInput;
          try {
            input = parseFilterImportInput(value);
          } catch (error) {
            if (!(error instanceof ContractValidationError)) throw error;
            items.push({
              index,
              status: "invalid",
              filter: null,
              reason:
                error.path[0] === "filter-condition"
                  ? "filter-condition-invalid"
                  : "invalid-contract",
            });
            continue;
          }
          let name = input.name,
            suffix = 1;
          for (;;) {
            const existing = db
              .prepare("SELECT * FROM saved_filters WHERE name=?")
              .get(name);
            if (!existing) {
              items.push({
                index,
                status: suffix === 1 ? "imported" : "renamed",
                filter: insert(
                  db,
                  { ...input, name },
                  r.import_ids![index]!,
                  now,
                ),
                reason: null,
              });
              break;
            }
            if (
              existing.query_json === JSON.stringify(input.query) &&
              existing.sort === input.sort
            ) {
              items.push({
                index,
                status: "skipped",
                filter: present(db, existing),
                reason: null,
              });
              break;
            }
            const ending = ` (${++suffix})`;
            name = truncateFilterName(input.name, 128 - ending.length) + ending;
          }
        }
        result = { items };
      } else if (op.operation === "delete") {
        row(db, op.request.filter_id);
        db.prepare("DELETE FROM saved_filters WHERE filter_id=?").run(
          op.request.filter_id,
        );
        result = { filter_id: op.request.filter_id };
      } else {
        const id =
          op.operation === "create" ? r.filter_id! : op.request.filter_id;
        if (op.operation !== "create") row(db, id);
        if (
          op.operation !== "update" &&
          db
            .prepare(
              "SELECT 1 FROM saved_filters WHERE name=? AND filter_id<>?",
            )
            .get(op.request.name, id)
        )
          fail("filter-name-conflict");
        if (op.operation === "create") result = insert(db, op.request, id, now);
        else {
          if (op.operation === "rename")
            db.prepare(
              "UPDATE saved_filters SET name=?,updated_at=? WHERE filter_id=?",
            ).run(op.request.name, now, id);
          else
            db.prepare(
              "UPDATE saved_filters SET query_json=?,sort=?,updated_at=? WHERE filter_id=?",
            ).run(JSON.stringify(op.request.query), op.request.sort, now, id);
          result = present(db, row(db, id));
        }
      }
    }
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
