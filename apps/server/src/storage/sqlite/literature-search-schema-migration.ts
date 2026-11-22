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
import { readCatalogIdentity } from "./catalog-identity.js";
import { CURRENT_CATALOG_CONFIG } from "./catalog-layout.js";
import { RetrievalStorageEngine } from "./retrieval-engine.js";
import { schemaTargetFile, schemaTargetPath } from "./schema-path.js";
import {
  SCHEMA_FINGERPRINT,
  SCHEMA_FINGERPRINT_V19,
  SCHEMA_FINGERPRINT_V19_INTAKE_LOOKUPS,
  SCHEMA_FINGERPRINT_V19_RETRIEVAL_CHANGES,
  SCHEMA_FINGERPRINT_V19_STORED_STATES,
  SCHEMA_MANIFEST,
  SCHEMA_MANIFEST_V19,
  SCHEMA_MANIFEST_V19_INTAKE_LOOKUPS,
  SCHEMA_MANIFEST_V19_RETRIEVAL_CHANGES,
  SCHEMA_MANIFEST_V19_STORED_STATES,
  SCHEMA_VERSION,
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
]);

/** Explicit, additive upgrade from the four earlier layout 19 fingerprints. */
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
      if (!manifest || !manifest.every((sql, i) => SCHEMA_MANIFEST[i] === sql))
        refuse();
      verifySchemaObjects(db, manifest, refuse);
      if (
        !readCatalogIdentity(db, {
          ...CURRENT_CATALOG_CONFIG,
          schema_manifest: manifest,
          schema_fingerprint: previous,
        })
      )
        refuse();
      for (const sql of SCHEMA_MANIFEST.slice(manifest.length)) db.exec(sql);
      if (manifest.length < SCHEMA_MANIFEST_V19_RETRIEVAL_CHANGES.length)
        db.exec("INSERT INTO retrieval_change_state VALUES(1,NULL)");
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
  const writes = new CatalogWriteAdmission(path);
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
