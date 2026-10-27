import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { acquireCatalogWriteLock } from "../write-admission.js";
import { schemaTargetFile, schemaTargetPath } from "./schema-path.js";
import { SCHEMA_MANIFEST, SCHEMA_FINGERPRINT } from "./schema.js";

/** Explicit, offline 11 -> 12 migration. Never called by catalog open. */
export const ARCHIVE_PREVIOUS_FINGERPRINT =
  "b8fd91845be24f5c30124d1d0acf89639f4921391e3b02a039ae0daa602a275c";
export const archivePreviousManifest = SCHEMA_MANIFEST.map((sql) =>
  sql
    .replace("CHECK(schema_version=12)", "CHECK(schema_version=11)")
    .replace(
      "'arrange','proofread','render','metadata','references','tags','document','structure'",
      "'proofread','document','structure','metadata','references','tags'",
    ),
);
function refuse(): never {
  throw Object.assign(new Error("archive schema migration refused"), {
    code: "archive-schema-migration-refused",
  });
}
function verify(db: DatabaseSync, manifest: readonly string[]) {
  const names = new Set<string>();
  for (const sql of manifest) {
    const name =
      /^CREATE (?:UNIQUE )?(?:VIRTUAL )?(?:TABLE|INDEX|TRIGGER|VIEW) ([a-z_][a-z0-9_]*)/u.exec(
        sql,
      )?.[1];
    if (
      !name ||
      db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(name)
        ?.sql !== sql
    )
      refuse();
    names.add(name);
    if (sql.startsWith("CREATE VIRTUAL TABLE "))
      for (const suffix of ["data", "idx", "content", "docsize", "config"])
        names.add(`${name}_${suffix}`);
  }
  if (
    db
      .prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
      .all()
      .some((row) => !names.has(String(row.name)))
  )
    refuse();
  if (db.prepare("PRAGMA foreign_key_check").all().length) refuse();
  for (const sql of manifest) {
    const table = /^CREATE TABLE ([a-z_][a-z0-9_]*)/u.exec(sql)?.[1];
    if (
      table &&
      db.prepare(`PRAGMA integrity_check(${table})`).get()?.integrity_check !==
        "ok"
    )
      refuse();
  }
}
function counts(db: DatabaseSync) {
  return Object.fromEntries(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => {
        const name = String(row.name);
        if (!/^[a-z_][a-z0-9_]*$/u.test(name)) refuse();
        return [
          name,
          Number(db.prepare(`SELECT count(*) AS n FROM ${name}`).get()!.n),
        ];
      }),
  );
}
export async function migrateArchiveSchema(path: string) {
  await schemaTargetPath(path);
  if (!(await schemaTargetFile(path))) refuse();
  const lock = await acquireCatalogWriteLock(path);
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path);
    db.exec(
      "PRAGMA busy_timeout=0; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL",
    );
    const identity = db
      .prepare("SELECT * FROM schema_identity WHERE singleton=1")
      .get();
    if (
      identity?.product !== "sciretriever" ||
      identity.schema_version !== 11 ||
      identity.schema_fingerprint !== ARCHIVE_PREVIOUS_FINGERPRINT ||
      createHash("sha256")
        .update(JSON.stringify(archivePreviousManifest))
        .digest("hex") !== ARCHIVE_PREVIOUS_FINGERPRINT
    )
      refuse();
    verify(db, archivePreviousManifest);
    db.exec("BEGIN IMMEDIATE");
    try {
      if (
        db
          .prepare(
            "SELECT 1 FROM execution_jobs WHERE status IN ('queued','running') LIMIT 1",
          )
          .get() ||
        db
          .prepare("SELECT 1 FROM archive_runs WHERE state='running' LIMIT 1")
          .get()
      )
        refuse();
      const before = counts(db);
      for (const table of ["archive_steps", "schema_identity"]) {
        const triggers = archivePreviousManifest.filter(
          (sql) =>
            sql.startsWith("CREATE TRIGGER ") &&
            new RegExp(` ON ${table} `, "u").test(sql),
        );
        for (const sql of triggers)
          db.exec(`DROP TRIGGER ${/^CREATE TRIGGER (\w+)/u.exec(sql)![1]}`);
        db.exec(
          `CREATE TEMP TABLE migration_${table} AS SELECT * FROM ${table}`,
        );
        db.exec(`DROP TABLE ${table}`);
        db.exec(
          SCHEMA_MANIFEST.find((sql) =>
            sql.startsWith(`CREATE TABLE ${table}(`),
          )!,
        );
        if (table === "schema_identity")
          db.prepare(
            "INSERT INTO schema_identity SELECT singleton,product,12,?,created_at FROM migration_schema_identity",
          ).run(SCHEMA_FINGERPRINT);
        else db.exec(`INSERT INTO ${table} SELECT * FROM migration_${table}`);
        db.exec(`DROP TABLE migration_${table}`);
        for (const sql of triggers) db.exec(sql);
      }
      verify(db, SCHEMA_MANIFEST);
      const after = counts(db);
      if (JSON.stringify(before) !== JSON.stringify(after)) refuse();
      db.exec("COMMIT");
      return {
        from_version: 11,
        to_version: 12,
        before,
        after,
        foreign_key_violations: 0,
      };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db?.close();
    await lock.release();
  }
}
