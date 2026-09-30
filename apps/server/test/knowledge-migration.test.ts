import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteWorker } from "../src/storage/sqlite/worker.js";
import { migrateDocumentCatalog } from "../src/storage/sqlite/document-migration.js";
import { migrateRetrievalCatalog } from "../src/storage/sqlite/retrieval-migration.js";
import { migrateExtractionCatalog } from "../src/storage/sqlite/extraction-migration.js";
import {
  inspectKnowledgeCatalog,
  migrateKnowledgeCatalog,
} from "../src/storage/sqlite/knowledge-migration.js";
import { SCHEMA_V6_FINGERPRINT } from "../src/storage/sqlite/schema-v6.js";
import { SCHEMA_V7_FINGERPRINT } from "../src/storage/sqlite/schema-v7.js";
import {
  inspectSynthesisCatalog,
  migrateSynthesisCatalog,
} from "../src/storage/sqlite/synthesis-migration.js";

async function v5(root: string): Promise<string> {
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
  await migrateExtractionCatalog({
    catalog_path: catalog,
    backup_path: join(root, "before-v5.sqlite"),
  });
  return catalog;
}

describe("knowledge catalog v6 migration", () => {
  it("preserves v5, freezes v6 and allows a read-only worker", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "sciretriever-knowledge-migration-"),
    );
    try {
      const catalog = await v5(root);
      const backup = join(root, "before-v6.sqlite");
      const before = await inspectKnowledgeCatalog(catalog);
      expect(before.schema_version).toBe(5);
      expect(
        await migrateKnowledgeCatalog({ catalog_path: catalog, dry_run: true }),
      ).toMatchObject({ action: "dry-run", from_version: 5 });
      expect(
        await migrateKnowledgeCatalog({
          catalog_path: catalog,
          backup_path: backup,
        }),
      ).toMatchObject({
        action: "migrated",
        from_version: 5,
        to_version: 6,
        manifest_fingerprint: SCHEMA_V6_FINGERPRINT,
      });
      expect((await inspectKnowledgeCatalog(backup)).schema_version).toBe(5);
      expect((await inspectKnowledgeCatalog(catalog)).schema_version).toBe(6);
      const reader = new SqliteWorker(catalog, undefined, { readOnly: true });
      try {
        expect(await reader.queryPreflight()).toMatchObject({
          status: "ready",
          schema: { schema_version: 6 },
        });
      } finally {
        await reader.close();
      }
      expect(
        await migrateKnowledgeCatalog({ catalog_path: catalog }),
      ).toMatchObject({ action: "already-v6" });
      const db = new DatabaseSync(catalog);
      try {
        db.exec("DROP INDEX knowledge_input_documents_version");
      } finally {
        db.close();
      }
      await expect(inspectKnowledgeCatalog(catalog)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rolls back failed migration and leaves a restorable v5 backup", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "sciretriever-knowledge-migration-"),
    );
    try {
      const catalog = await v5(root);
      const backup = join(root, "before-v6.sqlite");
      await expect(
        migrateKnowledgeCatalog({
          catalog_path: catalog,
          backup_path: backup,
          checkpoint: (stage) => {
            if (stage === "before-commit") throw new Error("injected");
          },
        }),
      ).rejects.toThrow("injected");
      expect((await inspectKnowledgeCatalog(catalog)).schema_version).toBe(5);
      expect((await inspectKnowledgeCatalog(backup)).schema_version).toBe(5);
      await migrateKnowledgeCatalog({
        catalog_path: catalog,
        backup_path: join(root, "retry.sqlite"),
      });
      expect((await inspectKnowledgeCatalog(catalog)).schema_version).toBe(6);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("synthesis catalog v7 migration", () => {
  it("preserves v6 backup, exposes exact v7 DDL, and refuses a colliding backup", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "sciretriever-synthesis-migration-"),
    );
    try {
      const catalog = await v5(root);
      await migrateKnowledgeCatalog({
        catalog_path: catalog,
        backup_path: join(root, "before-v6.sqlite"),
      });
      const backup = join(root, "before-v7.sqlite");
      expect(
        await migrateSynthesisCatalog({ catalog_path: catalog, dry_run: true }),
      ).toMatchObject({ from_version: 6, to_version: 7 });
      expect(
        await migrateSynthesisCatalog({
          catalog_path: catalog,
          backup_path: backup,
        }),
      ).toMatchObject({
        action: "migrated",
        from_version: 6,
        to_version: 7,
        manifest_fingerprint: SCHEMA_V7_FINGERPRINT,
      });
      expect((await inspectKnowledgeCatalog(backup)).schema_version).toBe(6);
      expect((await inspectSynthesisCatalog(catalog)).schema_version).toBe(7);
      const reader = new SqliteWorker(catalog, undefined, { readOnly: true });
      try {
        expect(await reader.queryPreflight()).toMatchObject({
          status: "ready",
          schema: { schema_version: 7 },
        });
      } finally {
        await reader.close();
      }
      expect(
        await migrateSynthesisCatalog({ catalog_path: catalog }),
      ).toMatchObject({ action: "already-v7" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("rolls back before commit, retains v6 data and rejects an existing backup path", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "sciretriever-synthesis-migration-"),
    );
    try {
      const catalog = await v5(root);
      await migrateKnowledgeCatalog({
        catalog_path: catalog,
        backup_path: join(root, "before-v6.sqlite"),
      });
      const backup = join(root, "before-v7.sqlite");
      await expect(
        migrateSynthesisCatalog({
          catalog_path: catalog,
          backup_path: backup,
          checkpoint: (stage) => {
            if (stage === "before-commit") throw new Error("injected");
          },
        }),
      ).rejects.toThrow("injected");
      expect((await inspectKnowledgeCatalog(catalog)).schema_version).toBe(6);
      expect((await inspectKnowledgeCatalog(backup)).schema_version).toBe(6);
      await expect(
        migrateSynthesisCatalog({ catalog_path: catalog, backup_path: backup }),
      ).rejects.toThrow();
      expect((await inspectKnowledgeCatalog(catalog)).schema_version).toBe(6);
      await migrateSynthesisCatalog({
        catalog_path: catalog,
        backup_path: join(root, "retry-v7.sqlite"),
      });
      expect((await inspectSynthesisCatalog(catalog)).schema_version).toBe(7);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
