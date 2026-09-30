import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteWorker } from "../src/storage/sqlite/worker.js";
import { migrateDocumentCatalog } from "../src/storage/sqlite/document-migration.js";
import {
  inspectRetrievalCatalog,
  migrateRetrievalCatalog,
} from "../src/storage/sqlite/retrieval-migration.js";
import { SCHEMA_V4_FINGERPRINT } from "../src/storage/sqlite/schema-v4.js";

async function v3(root: string): Promise<string> {
  const catalog = join(root, "catalog.sqlite");
  const worker = new SqliteWorker(catalog);
  await worker.schema();
  await worker.close();
  await migrateDocumentCatalog({
    catalog_path: catalog,
    backup_path: join(root, "before-v3.sqlite"),
  });
  return catalog;
}

describe("retrieval catalog v4 migration", () => {
  it("keeps v3 readable, creates a verified backup, and records the exact v4 manifest", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "sciretriever-retrieval-migration-"),
    );
    try {
      const catalog = await v3(root);
      const backup = join(root, "before-v4.sqlite");
      expect(await inspectRetrievalCatalog(catalog)).toMatchObject({
        schema_version: 3,
      });
      expect(
        await migrateRetrievalCatalog({ catalog_path: catalog, dry_run: true }),
      ).toMatchObject({ action: "dry-run", from_version: 3 });
      const migrated = await migrateRetrievalCatalog({
        catalog_path: catalog,
        backup_path: backup,
      });
      expect(migrated).toMatchObject({
        action: "migrated",
        from_version: 3,
        to_version: 4,
        manifest_fingerprint: SCHEMA_V4_FINGERPRINT,
      });
      expect(await inspectRetrievalCatalog(backup)).toMatchObject({
        schema_version: 3,
      });
      expect(await inspectRetrievalCatalog(catalog)).toMatchObject({
        schema_version: 4,
        source_revision: 0,
        active_generation: null,
      });
      const reader = new SqliteWorker(catalog, undefined, { readOnly: true });
      try {
        expect(await reader.queryPreflight()).toMatchObject({
          status: "ready",
          schema: { schema_version: 4 },
        });
      } finally {
        await reader.close();
      }
      const writer = new SqliteWorker(catalog);
      try {
        expect(await writer.schema()).toMatchObject({ schema_version: 4 });
      } finally {
        await writer.close();
      }
      expect(
        await migrateRetrievalCatalog({ catalog_path: catalog }),
      ).toMatchObject({ action: "already-v4" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rolls back a failed transaction and refuses a partial v4 manifest", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "sciretriever-retrieval-migration-"),
    );
    try {
      const catalog = await v3(root);
      await expect(
        migrateRetrievalCatalog({
          catalog_path: catalog,
          backup_path: join(root, "before-v4.sqlite"),
          checkpoint: (stage) => {
            if (stage === "before-commit") throw new Error("injected failure");
          },
        }),
      ).rejects.toThrow("injected failure");
      expect(await inspectRetrievalCatalog(catalog)).toMatchObject({
        schema_version: 3,
      });
      await migrateRetrievalCatalog({
        catalog_path: catalog,
        backup_path: join(root, "retry.sqlite"),
      });
      const db = new DatabaseSync(catalog);
      try {
        db.exec("DROP INDEX retrieval_entries_version");
      } finally {
        db.close();
      }
      await expect(inspectRetrievalCatalog(catalog)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
