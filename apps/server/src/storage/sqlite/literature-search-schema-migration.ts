import { createReadStream } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import {
  acquireCatalogWriteLock,
  CatalogWriteAdmission,
} from "../write-admission.js";
import { verifySchemaObjects } from "./archive-schema-migration.js";
import {
  manifestObject,
  objectKey,
  registerCatalogAddition,
} from "./catalog-ddl.js";
import { readCatalogIdentity } from "./catalog-identity.js";
import { CURRENT_CATALOG_CONFIG } from "./catalog-layout.js";
import { libraryPagingReady } from "./library-paging-state.js";
import { RetrievalStorageEngine } from "./retrieval-engine.js";
import { schemaTargetFile, schemaTargetPath } from "./schema-path.js";
import {
  SCHEMA_FINGERPRINT,
  SCHEMA_FINGERPRINT_V19,
  SCHEMA_FINGERPRINT_V19_COUNTS,
  SCHEMA_FINGERPRINT_V19_COMBINED,
  SCHEMA_FINGERPRINT_V19_INTAKE_LOOKUPS,
  SCHEMA_FINGERPRINT_V19_RETRIEVAL_CHANGES,
  SCHEMA_FINGERPRINT_V19_STORED_STATES,
  SCHEMA_MANIFEST,
  SCHEMA_MANIFEST_V19,
  SCHEMA_MANIFEST_V19_COUNTS,
  SCHEMA_MANIFEST_V19_COMBINED,
  SCHEMA_MANIFEST_V19_INTAKE_LOOKUPS,
  SCHEMA_MANIFEST_V19_RETRIEVAL_CHANGES,
  SCHEMA_MANIFEST_V19_STORED_STATES,
  SCHEMA_VERSION,
  LIBRARY_SCALE_ADDITION,
} from "./schema.js";

function refuse(cause?: unknown): never {
  throw Object.assign(
    new Error("literature search schema migration refused", { cause }),
    {
      code: "literature-search-schema-migration-refused",
    },
  );
}

const previousLayouts = new Map<string, readonly string[]>([
  [SCHEMA_FINGERPRINT_V19, SCHEMA_MANIFEST_V19],
  [SCHEMA_FINGERPRINT_V19_INTAKE_LOOKUPS, SCHEMA_MANIFEST_V19_INTAKE_LOOKUPS],
  [
    SCHEMA_FINGERPRINT_V19_RETRIEVAL_CHANGES,
    SCHEMA_MANIFEST_V19_RETRIEVAL_CHANGES,
  ],
  [SCHEMA_FINGERPRINT_V19_STORED_STATES, SCHEMA_MANIFEST_V19_STORED_STATES],
  [SCHEMA_FINGERPRINT_V19_COUNTS, SCHEMA_MANIFEST_V19_COUNTS],
  [SCHEMA_FINGERPRINT_V19_COMBINED, SCHEMA_MANIFEST_V19_COMBINED],
]);
const legacyConfig = {
  schema_version: SCHEMA_VERSION,
  execution_schema_version: CURRENT_CATALOG_CONFIG.execution_schema_version,
  execution_schema_fingerprint:
    CURRENT_CATALOG_CONFIG.execution_schema_fingerprint,
  execution_runtime_schema_version:
    CURRENT_CATALOG_CONFIG.execution_runtime_schema_version,
  execution_runtime_schema_fingerprint:
    CURRENT_CATALOG_CONFIG.execution_runtime_schema_fingerprint,
};

/** Explicit, additive upgrade from earlier layout 19 fingerprints. */
export async function migrateLiteratureSearchSchema(path: string) {
  await schemaTargetPath(path);
  if (!(await schemaTargetFile(path))) refuse();
  const lock = await acquireCatalogWriteLock(path);
  const started = performance.now();
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path);
    db.exec(
      "PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0; PRAGMA synchronous=FULL",
    );
    db.exec("BEGIN IMMEDIATE");
    try {
      const previous = db
        .prepare(
          "SELECT schema_fingerprint FROM schema_identity WHERE singleton=1",
        )
        .get()?.schema_fingerprint;
      if (typeof previous !== "string") refuse();
      const manifest = previousLayouts.get(previous);
      if (!manifest) refuse();
      verifySchemaObjects(db, manifest, refuse);
      if (
        !readCatalogIdentity(db, {
          ...legacyConfig,
          schema_manifest: manifest,
          schema_fingerprint: previous,
        })
      )
        refuse();
      const existing = new Map(
        manifest.map((sql) => {
          const object = manifestObject(sql);
          return [objectKey(object), object];
        }),
      );
      const target = new Map(
        SCHEMA_MANIFEST.map((sql) => {
          const object = manifestObject(sql);
          return [objectKey(object), sql];
        }),
      );
      // This release is the documented offline exception. Preserve SQLite's
      // current firing order when adding explicit trigger column lists.
      const triggerTables = new Set<string>();
      const triggers = db
        .prepare(
          "SELECT name,tbl_name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY rowid",
        )
        .all();
      const recreate = triggers.flatMap((trigger) => {
        const sql = target.get(`trigger:${trigger.name}`);
        if (!sql) refuse();
        if (sql !== trigger.sql) triggerTables.add(String(trigger.tbl_name));
        return triggerTables.has(String(trigger.tbl_name))
          ? [{ name: trigger.name, sql }]
          : [];
      });
      for (const trigger of recreate) db.exec(`DROP TRIGGER ${trigger.name}`);
      for (const trigger of recreate) db.exec(trigger.sql);
      for (const sql of SCHEMA_MANIFEST) {
        const object = manifestObject(sql);
        const before = existing.get(objectKey(object));
        if (!before) db.exec(sql);
        else if (before.sql !== sql && before.type !== "trigger") {
          if (before.type !== "view" || before.name !== "archive_current_parts")
            refuse();
          db.exec("DROP VIEW archive_current_parts");
          db.exec(sql);
        }
      }
      if (manifest.length < SCHEMA_MANIFEST_V19_RETRIEVAL_CHANGES.length)
        db.exec(
          "INSERT INTO retrieval_change_state(singleton,processed_position) VALUES(1,NULL)",
        );
      const backfilled =
        !!db
          .prepare(
            "SELECT 1 FROM library_state_progress WHERE singleton=1 AND ready=1 AND collection_ready=1",
          )
          .get() &&
        !!db
          .prepare(
            "SELECT 1 FROM library_count_progress WHERE singleton=1 AND ready=1",
          )
          .get() &&
        libraryPagingReady(db);
      registerCatalogAddition(
        db,
        LIBRARY_SCALE_ADDITION,
        new Date().toISOString(),
        backfilled,
      );
      db.prepare(
        "UPDATE schema_identity SET schema_fingerprint=? WHERE singleton=1",
      ).run(SCHEMA_FINGERPRINT);
      // Check the exact new layout under the same lock. Full catalog verify is
      // explicit and can run separately on a read snapshot after the commit.
      verifySchemaObjects(db, CURRENT_CATALOG_CONFIG.schema_manifest, refuse);
      if (!readCatalogIdentity(db, CURRENT_CATALOG_CONFIG)) refuse();
      db.exec("COMMIT");
      return {
        from_version: SCHEMA_VERSION,
        to_version: SCHEMA_VERSION,
        from_fingerprint: previous,
        schema_fingerprint: SCHEMA_FINGERPRINT,
        elapsed_ms: performance.now() - started,
      };
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      refuse(error);
    }
  } finally {
    try {
      db?.close();
    } finally {
      await lock.release();
    }
  }
}

/** Explicit post-migration reconciliation. Concurrent writes log themselves. */
export async function reconcileLiteratureSearchSchema(path: string) {
  await schemaTargetPath(path);
  if (!(await schemaTargetFile(path))) refuse();
  const generations = new CatalogWriteAdmission(`${path}.retrieval-index`);
  const writes = new CatalogWriteAdmission(path, { waitMs: 10_000 });
  const started = performance.now();
  try {
    return await generations.run(async () => {
      const root = await mkdtemp(
        join(tmpdir(), "sciretriever-index-reconcile-"),
      );
      try {
        const pathToChanges = join(root, "literatures.ndjson");
        const spool = await open(pathToChanges, "wx", 0o600);
        let differences = 0;
        const pageSize = 512;
        let ids: string[] = [];
        try {
          const reader = new RetrievalStorageEngine(
            path,
            true,
            CURRENT_CATALOG_CONFIG,
          );
          try {
            for (const id of reader.migrationDifferences()) {
              ids.push(JSON.stringify(id));
              differences++;
              if (ids.length < pageSize) continue;
              await spool.writeFile(ids.join("\n") + "\n");
              ids = [];
            }
            if (ids.length) await spool.writeFile(ids.join("\n") + "\n");
          } finally {
            reader.close();
          }
        } finally {
          await spool.close();
        }
        const scan_ms = performance.now() - started;
        const writer = new RetrievalStorageEngine(
          path,
          false,
          CURRENT_CATALOG_CONFIG,
        );
        try {
          ids = [];
          const lines = createInterface({
            input: createReadStream(pathToChanges),
            crlfDelay: Infinity,
          });
          try {
            const flush = async () => {
              if (!ids.length) return;
              await writes.run(async () => writer.recordMigrationChanges(ids));
              ids = [];
            };
            for await (const line of lines) {
              ids.push(JSON.parse(line) as string);
              if (ids.length >= pageSize) await flush();
            }
            await flush();
          } finally {
            lines.close();
          }
          // Keep the null position until every difference is durable. After
          // interruption a rerun may queue an ID again; no IDs can be skipped.
          const reconciled = await writes.run(async () =>
            writer.completeMigration(),
          );
          return {
            reconciled,
            differences,
            scan_ms,
            elapsed_ms: performance.now() - started,
          };
        } finally {
          writer.close();
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  } finally {
    await writes.close();
    await generations.close();
  }
}
