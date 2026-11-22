import { DatabaseSync } from "node:sqlite";
import { CatalogWriteAdmission } from "../write-admission.js";
import {
  appendedColumns,
  catalogObjects,
  registerCatalogAddition,
  type CatalogAddition,
} from "./catalog-ddl.js";
import { readCatalogLayout } from "./catalog-identity.js";
import { catalogConfigFor, CURRENT_CATALOG_CONFIG } from "./catalog-layout.js";
import { CATALOG_ADDITIONS } from "./schema.js";
import {
  CatalogSchemaError,
  schemaTargetFile,
  schemaTargetPath,
} from "./schema-path.js";

function validateNewTrigger(db: DatabaseSync, name: string, sql: string) {
  const event =
    /^CREATE TRIGGER [a-z_][a-z0-9_]*\s+(?:(?:BEFORE|AFTER|INSTEAD OF)\s+)?(INSERT|UPDATE|DELETE)\b/iu
      .exec(sql)?.[1]
      ?.toUpperCase();
  const target = String(
    db
      .prepare(
        "SELECT tbl_name FROM sqlite_schema WHERE type='trigger' AND name=?",
      )
      .get(name)!.tbl_name,
  );
  const quote = (identifier: string) =>
    '"' + identifier.replaceAll('"', '""') + '"';
  let write: string;
  switch (event) {
    case "INSERT":
      write = `INSERT INTO ${quote(target)} DEFAULT VALUES`;
      break;
    case "DELETE":
      write = `DELETE FROM ${quote(target)}`;
      break;
    case "UPDATE": {
      const columns = db
        .prepare("SELECT name FROM pragma_table_xinfo(?) WHERE hidden=0")
        .all(target);
      write = `UPDATE ${quote(target)} SET ${columns
        .map(({ name }) => {
          const column = quote(String(name));
          return `${column}=${column}`;
        })
        .join(",")}`;
      break;
    }
    default:
      throw new CatalogSchemaError("catalog-addition-invalid-trigger");
  }
  try {
    // Compilation resolves trigger expressions without any application functions
    // registered, as on a connection owned by an older release.
    db.prepare("EXPLAIN " + write);
  } catch (cause) {
    throw new CatalogSchemaError("catalog-addition-invalid-trigger", { cause });
  }
}

/** Applies a built-in addition from the applying release under business admission. */
export async function applyCatalogAddition(
  path: string,
  addition: CatalogAddition,
  signal?: AbortSignal,
) {
  await schemaTargetPath(path);
  if (!(await schemaTargetFile(path)))
    throw new CatalogSchemaError("catalog-not-initialized");
  const writes = new CatalogWriteAdmission(path, { waitMs: 10_000 });
  const waiting = performance.now();
  let started = waiting;
  try {
    const applied = await writes.run(async () => {
      started = performance.now();
      const db = new DatabaseSync(path);
      try {
        db.exec(
          "PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0; PRAGMA synchronous=FULL; BEGIN IMMEDIATE",
        );
        const position = CATALOG_ADDITIONS.findIndex(
          (known) => known.name === addition.name,
        );
        const previous =
          position < 0
            ? CURRENT_CATALOG_CONFIG
            : catalogConfigFor(CATALOG_ADDITIONS.slice(0, position));
        const layout = readCatalogLayout(db, previous);
        if (!layout) throw new CatalogSchemaError("catalog-not-initialized");
        if (layout.additions.some((entry) => entry.name === addition.name))
          throw new CatalogSchemaError("catalog-addition-already-applied");
        const before = catalogObjects(db);
        for (const sql of addition.statements) {
          if (
            !/^\s*(?:CREATE\s+(?:(?:UNIQUE\s+)?INDEX|(?:VIRTUAL\s+)?TABLE|TRIGGER|VIEW)\b|ALTER\s+TABLE\s+\S+\s+ADD\s+)/iu.test(
              sql,
            )
          )
            throw new CatalogSchemaError("catalog-addition-not-additive");
          const statement = db.prepare(sql);
          const normalize = (source: string) =>
            source.trim().replace(/;$/u, "");
          if (normalize(statement.sourceSQL) !== normalize(sql))
            throw new CatalogSchemaError("catalog-addition-not-additive");
          statement.run();
        }
        const after = catalogObjects(db);
        for (const [key, old] of before) {
          const current = after.get(key);
          if (
            !current ||
            (old.sql !== current.sql && !appendedColumns(db, old, current))
          )
            throw new CatalogSchemaError("catalog-addition-not-additive");
        }
        for (const [key, object] of after) {
          if (!before.has(key) && object.type === "trigger")
            validateNewTrigger(db, object.name, object.sql);
        }
        const appliedAt = new Date().toISOString();
        registerCatalogAddition(db, addition, appliedAt);
        readCatalogLayout(
          db,
          catalogConfigFor([
            ...(position < 0
              ? CATALOG_ADDITIONS
              : CATALOG_ADDITIONS.slice(0, position)),
            addition,
          ]),
        );
        db.exec("COMMIT");
        return {
          name: addition.name,
          ddl_fingerprint: addition.ddl_fingerprint,
          applied_at: appliedAt,
        };
      } finally {
        try {
          if (db.isTransaction) db.exec("ROLLBACK");
        } finally {
          db.close();
        }
      }
    }, signal);
    return {
      ...applied,
      admission_wait_ms: started - waiting,
      ddl_hold_ms: performance.now() - started,
    };
  } finally {
    await writes.close();
  }
}
