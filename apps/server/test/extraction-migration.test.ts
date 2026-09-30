import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteWorker } from "../src/storage/sqlite/worker.js";
import { CatalogWriteAdmission } from "../src/storage/write-admission.js";
import { RetrievalStorageClient } from "../src/storage/sqlite/retrieval-client.js";
import { migrateDocumentCatalog } from "../src/storage/sqlite/document-migration.js";
import { migrateRetrievalCatalog } from "../src/storage/sqlite/retrieval-migration.js";
import {
  inspectExtractionCatalog,
  migrateExtractionCatalog,
} from "../src/storage/sqlite/extraction-migration.js";
import { SCHEMA_V5_FINGERPRINT } from "../src/storage/sqlite/schema-v5.js";

async function v4(root: string) {
  const catalog = join(root, "catalog.sqlite");
  const worker = new SqliteWorker(catalog);
  try {
    await worker.schema();
  } finally {
    await worker.close();
  }
  await migrateDocumentCatalog({
    catalog_path: catalog,
    backup_path: join(root, "before-v3.sqlite"),
  });
  await migrateRetrievalCatalog({
    catalog_path: catalog,
    backup_path: join(root, "before-v4.sqlite"),
  });
  return catalog;
}

describe("extraction catalog v5 migration", () => {
  it("preserves v4 and exposes v5 through source and retrieval readers", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "sciretriever-extraction-migration-"),
    );
    try {
      const catalog = await v4(root);
      expect(await inspectExtractionCatalog(catalog)).toMatchObject({
        schema_version: 4,
      });
      const writer = new SqliteWorker(
        catalog,
        new CatalogWriteAdmission(catalog),
      );
      try {
        const retrieval = new RetrievalStorageClient(writer);
        const revision = await retrieval.revision();
        const generation = await retrieval.beginGeneration(revision);
        await retrieval.publish(generation, revision);
      } finally {
        await writer.close();
      }
      const before = await inspectExtractionCatalog(catalog);
      expect(before).toMatchObject({
        schema_version: 4,
        active_generation: expect.any(String),
      });
      const migrated = await migrateExtractionCatalog({
        catalog_path: catalog,
        backup_path: join(root, "before-v5.sqlite"),
      });
      expect(migrated).toMatchObject({
        action: "migrated",
        from_version: 4,
        to_version: 5,
        manifest_fingerprint: SCHEMA_V5_FINGERPRINT,
      });
      expect(await inspectExtractionCatalog(catalog)).toMatchObject({
        schema_version: 5,
        active_generation: before.active_generation,
      });
      expect(
        await inspectExtractionCatalog(join(root, "before-v5.sqlite")),
      ).toMatchObject({ schema_version: 4 });
      const reader = new SqliteWorker(catalog, undefined, { readOnly: true });
      try {
        expect(await reader.queryPreflight()).toMatchObject({
          status: "ready",
          schema: { schema_version: 5 },
        });
        expect(await new RetrievalStorageClient(reader).active()).toMatchObject(
          { generation_id: before.active_generation },
        );
      } finally {
        await reader.close();
      }
      expect(
        await migrateExtractionCatalog({ catalog_path: catalog }),
      ).toMatchObject({ action: "already-v5" });
      const db = new DatabaseSync(catalog);
      try {
        db.exec("PRAGMA foreign_keys=ON");
        db.prepare(
          "INSERT INTO extraction_specs(caller_id,spec_id,spec_version,spec_sha256,spec_json) VALUES('caller','spec','1',?,'{}')",
        ).run("a".repeat(64));
        expect(() =>
          db
            .prepare(
              "INSERT INTO extraction_operations(operation_id,caller_id,spec_id,spec_version,spec_sha256,manifest_sha256,manifest_json,status,created_at,accept_until,closed_at) VALUES('operation','caller','spec','1',?,?,'{}','open','now','later',NULL)",
            )
            .run("b".repeat(64), "c".repeat(64)),
        ).toThrow();
        expect(() =>
          db
            .prepare(
              "INSERT INTO extraction_specs(caller_id,spec_id,spec_version,spec_sha256,spec_json) VALUES('caller','large','1',?,?)",
            )
            .run("d".repeat(64), "界".repeat(21846)),
        ).toThrow();
        db.exec("DROP INDEX extraction_receipts_expiry");
      } finally {
        db.close();
      }
      await expect(inspectExtractionCatalog(catalog)).rejects.toThrow();
      const damaged = new SqliteWorker(catalog, undefined, { readOnly: true });
      try {
        expect(await damaged.queryPreflight()).toMatchObject({
          status: "unavailable",
        });
      } finally {
        await damaged.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("rolls back failed schema publication and rejects unknown identity", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "sciretriever-extraction-migration-"),
    );
    try {
      const catalog = await v4(root);
      const unpublished = join(root, "unpublished-v5.sqlite");
      await expect(
        migrateExtractionCatalog({
          catalog_path: catalog,
          backup_path: unpublished,
          checkpoint: (stage) => {
            if (stage === "before-backup-publish")
              throw new Error("backup injection");
          },
        }),
      ).rejects.toThrow("backup injection");
      expect(await inspectExtractionCatalog(catalog)).toMatchObject({
        schema_version: 4,
      });
      await expect(inspectExtractionCatalog(unpublished)).rejects.toThrow();
      await expect(
        migrateExtractionCatalog({
          catalog_path: catalog,
          backup_path: join(root, "before-v5.sqlite"),
          checkpoint: (stage) => {
            if (stage === "before-commit") throw new Error("injected");
          },
        }),
      ).rejects.toThrow("injected");
      expect(await inspectExtractionCatalog(catalog)).toMatchObject({
        schema_version: 4,
      });
      await migrateExtractionCatalog({
        catalog_path: catalog,
        backup_path: join(root, "retry.sqlite"),
      });
      const db = new DatabaseSync(catalog);
      try {
        db.exec("PRAGMA ignore_check_constraints=ON");
        db.exec("UPDATE schema_identity SET schema_version=6");
      } finally {
        db.close();
      }
      await expect(inspectExtractionCatalog(catalog)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
