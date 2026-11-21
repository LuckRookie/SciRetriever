import { DatabaseSync } from "node:sqlite";
import { acquireCatalogWriteLock } from "../write-admission.js";
import { verifySchemaObjects } from "./archive-schema-migration.js";
import { readCatalogIdentity } from "./catalog-identity.js";
import { CURRENT_CATALOG_CONFIG } from "./catalog-layout.js";
import { schemaTargetFile, schemaTargetPath } from "./schema-path.js";
import {
  INTAKE_LOOKUP_INDEXES,
  SCHEMA_FINGERPRINT,
  SCHEMA_FINGERPRINT_V19,
  SCHEMA_MANIFEST_V19,
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

/** Explicit intake lookup indexes for layout 19. */
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
      verifySchemaObjects(db, SCHEMA_MANIFEST_V19, refuse);
      if (
        !readCatalogIdentity(db, {
          ...CURRENT_CATALOG_CONFIG,
          schema_manifest: SCHEMA_MANIFEST_V19,
          schema_fingerprint: SCHEMA_FINGERPRINT_V19,
        })
      )
        refuse();
      for (const sql of INTAKE_LOOKUP_INDEXES) db.exec(sql);
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
        from_fingerprint: SCHEMA_FINGERPRINT_V19,
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
