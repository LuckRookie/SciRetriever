import {
  SCHEMA_V9_FINGERPRINT,
  SCHEMA_V9_MANIFEST,
} from "../src/storage/sqlite/schema-v9.js";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseAsset, parseLiteratureId } from "@sciretriever/contracts";
import { runCli } from "../src/cli/main.js";
import { SqliteWorker } from "../src/storage/sqlite/worker.js";
import { acquireCatalogWriteLock } from "../src/storage/write-admission.js";
import {
  CatalogSchemaError,
  initializeCatalogSchema,
  inspectCatalogSchema,
  upgradeCatalogSchema,
} from "../src/storage/sqlite/catalog-schema.js";
import {
  withCatalogMigrationScope,
  type CatalogMigrationScope,
} from "../src/storage/sqlite/migration-scope.js";
import { migrateDocumentCatalog } from "../src/storage/sqlite/document-migration.js";
import {
  SCHEMA_FINGERPRINT,
  SCHEMA_MANIFEST,
} from "../src/storage/sqlite/schema.js";
import {
  SCHEMA_V2_FINGERPRINT,
  SCHEMA_V2_MANIFEST,
} from "../src/storage/sqlite/schema-v2.js";
import {
  SCHEMA_V3_FINGERPRINT,
  SCHEMA_V3_MANIFEST,
} from "../src/storage/sqlite/schema-v3.js";
import {
  SCHEMA_V4_FINGERPRINT,
  SCHEMA_V4_MANIFEST,
} from "../src/storage/sqlite/schema-v4.js";
import {
  SCHEMA_V5_FINGERPRINT,
  SCHEMA_V5_MANIFEST,
} from "../src/storage/sqlite/schema-v5.js";
import {
  SCHEMA_V6_FINGERPRINT,
  SCHEMA_V6_MANIFEST,
} from "../src/storage/sqlite/schema-v6.js";
import {
  SCHEMA_V7_FINGERPRINT,
  SCHEMA_V7_MANIFEST,
} from "../src/storage/sqlite/schema-v7.js";
import {
  SCHEMA_V8_FINGERPRINT,
  SCHEMA_V8_MANIFEST,
} from "../src/storage/sqlite/schema-v8.js";
import {
  EXECUTION_RUNTIME_SCHEMA_FINGERPRINT,
  EXECUTION_RUNTIME_SCHEMA_VERSION,
  EXECUTION_SCHEMA_FINGERPRINT,
  EXECUTION_SCHEMA_VERSION,
} from "../src/storage/sqlite/execution-schema.js";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";

const versions = [
  [1, SCHEMA_FINGERPRINT, SCHEMA_MANIFEST],
  [2, SCHEMA_V2_FINGERPRINT, SCHEMA_V2_MANIFEST],
  [3, SCHEMA_V3_FINGERPRINT, SCHEMA_V3_MANIFEST],
  [4, SCHEMA_V4_FINGERPRINT, SCHEMA_V4_MANIFEST],
  [5, SCHEMA_V5_FINGERPRINT, SCHEMA_V5_MANIFEST],
  [6, SCHEMA_V6_FINGERPRINT, SCHEMA_V6_MANIFEST],
  [7, SCHEMA_V7_FINGERPRINT, SCHEMA_V7_MANIFEST],
  [8, SCHEMA_V8_FINGERPRINT, SCHEMA_V8_MANIFEST],
  [9, SCHEMA_V9_FINGERPRINT, SCHEMA_V9_MANIFEST],
] as const;
const assetBytes = Buffer.from(
  "%PDF-1.4\n% synthetic schema migration asset\n%%EOF\n",
);
const fixtureAsset = parseAsset({
  asset_id: "00000000-0000-0000-0000-000000001991",
  sha256: createHash("sha256").update(assetBytes).digest("hex"),
  size_bytes: assetBytes.length,
  media_type: "application/pdf",
  path: "objects/schema-original.pdf",
});

async function fixture(path: string, version = 1) {
  const definition = versions.find(([number]) => number === version)!;
  const db = new DatabaseSync(path);
  try {
    for (const ddl of definition[2]) db.exec(ddl);
    db.prepare(
      "INSERT INTO schema_identity(singleton,product,schema_version,schema_fingerprint,created_at) VALUES(1,'sciretriever',?,?,'2026-09-30T00:00:00Z')",
    ).run(version, definition[1]);
    if (version >= 2) {
      db.prepare(
        "INSERT INTO execution_schema_identity(singleton,version,fingerprint) VALUES(1,?,?)",
      ).run(EXECUTION_SCHEMA_VERSION, EXECUTION_SCHEMA_FINGERPRINT);
      db.prepare(
        "INSERT INTO execution_runtime_schema_identity(singleton,version,fingerprint) VALUES(1,?,?)",
      ).run(
        EXECUTION_RUNTIME_SCHEMA_VERSION,
        EXECUTION_RUNTIME_SCHEMA_FINGERPRINT,
      );
    }
    if (version >= 4)
      db.exec("INSERT INTO retrieval_source_revision VALUES(1,0)");
    if (version >= 8)
      db.exec("INSERT INTO knowledge_retrieval_source_revision VALUES(1,0)");
  } finally {
    db.close();
  }
  const worker = new SqliteWorker(path);
  try {
    await worker.putLiterature(FIXTURE_LITERATURE);
    await worker.putAsset(fixtureAsset);
  } finally {
    await worker.close();
  }
}

async function bytesHash(path: string) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

function sourceFacts(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => String(row.name))
      .filter(
        (name) =>
          /^(?:literature|meta_literature|metadata_|provenances|assets|artifact_objects)/.test(
            name,
          ) && !name.includes("fts"),
      );
    return tables.map((name) => ({
      name,
      rows: db
        .prepare(`SELECT * FROM ${name}`)
        .all()
        .sort((left, right) =>
          JSON.stringify(left).localeCompare(JSON.stringify(right)),
        ),
    }));
  } finally {
    db.close();
  }
}

async function cli(args: string[]) {
  let stdout = "";
  let stderr = "";
  const result = await runCli(args, {
    json: true,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return {
    code: result.code,
    stdout: stdout ? JSON.parse(stdout) : null,
    stderr: stderr ? JSON.parse(stderr) : null,
  };
}

describe("explicit catalog schema activation", () => {
  it("preserves an occupied init target and reports a valid publication after a late failure", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "sciretriever-schema-init-failure-"),
    );
    const catalog = join(root, "catalog.sqlite");
    try {
      await expect(
        initializeCatalogSchema(catalog, (stage) => {
          if (stage === "before-publish")
            throw new Error("synthetic prepublication failure");
        }),
      ).rejects.toMatchObject({
        progress: { current_version: null, completed_versions: [] },
      });
      expect((await inspectCatalogSchema(catalog)).status).toBe(
        "not-initialized",
      );
      await expect(
        initializeCatalogSchema(catalog, async (stage) => {
          if (stage === "before-publish")
            await writeFile(catalog, "synthetic racing target");
        }),
      ).rejects.toBeInstanceOf(CatalogSchemaError);
      expect(await readFile(catalog, "utf8")).toBe("synthetic racing target");
      await rm(catalog);
      await expect(
        initializeCatalogSchema(catalog, (stage) => {
          if (stage === "published")
            throw new Error("synthetic postpublication failure");
        }),
      ).rejects.toMatchObject({
        progress: { current_version: 9, completed_versions: [9] },
      });
      expect((await inspectCatalogSchema(catalog)).schema_version).toBe(9);
      expect(
        (await readdir(root)).filter((name) =>
          name.startsWith(".sciretriever-init-"),
        ),
      ).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("keeps inspect/dry-run read-only and initializes all v9 owners without touching siblings", async () => {
    const root = await mkdtemp(join(tmpdir(), "sciretriever-schema-init-"));
    const catalog = join(root, "catalog.sqlite");
    try {
      await writeFile(
        join(root, "original-asset.pdf"),
        "synthetic original asset",
      );
      const siblings = await readdir(root);
      expect(
        await cli(["storage", "schema-inspect", "--catalog", catalog]),
      ).toMatchObject({ code: 0, stdout: { status: "not-initialized" } });
      expect(
        await cli([
          "storage",
          "schema-upgrade",
          "--catalog",
          catalog,
          "--dry-run",
        ]),
      ).toMatchObject({ code: 3, stderr: { reason: "catalog-missing" } });
      expect(await readdir(root)).toEqual(siblings);
      expect(
        await cli(["storage", "schema-init", "--catalog", catalog]),
      ).toMatchObject({
        code: 0,
        stdout: {
          action: "initialized",
          inspection: {
            schema_version: 9,
            schema_fingerprint: SCHEMA_V9_FINGERPRINT,
          },
        },
      });
      expect(await readFile(join(root, "original-asset.pdf"), "utf8")).toBe(
        "synthetic original asset",
      );
      const db = new DatabaseSync(catalog, { readOnly: true });
      try {
        expect(
          db.prepare("SELECT * FROM execution_schema_identity").get(),
        ).toMatchObject({
          version: EXECUTION_SCHEMA_VERSION,
          fingerprint: EXECUTION_SCHEMA_FINGERPRINT,
        });
        expect(
          db.prepare("SELECT * FROM execution_runtime_schema_identity").get(),
        ).toMatchObject({
          version: EXECUTION_RUNTIME_SCHEMA_VERSION,
          fingerprint: EXECUTION_RUNTIME_SCHEMA_FINGERPRINT,
        });
        expect(
          db.prepare("SELECT * FROM retrieval_source_revision").get(),
        ).toMatchObject({ revision: 0 });
        expect(
          db.prepare("SELECT * FROM knowledge_retrieval_source_revision").get(),
        ).toMatchObject({ revision: 0 });
        for (const table of [
          "literatures",
          "document_versions",
          "knowledge_artifacts",
          "extraction_operations",
          "execution_jobs",
          "retrieval_active_generation",
          "knowledge_retrieval_active",
        ])
          expect(
            db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n,
          ).toBe(0);
      } finally {
        db.close();
      }
      const current = await bytesHash(catalog);
      expect(
        await cli(["storage", "schema-init", "--catalog", catalog]),
      ).toMatchObject({
        code: 3,
        stderr: { reason: "catalog-already-exists" },
      });
      expect(await bytesHash(catalog)).toBe(current);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  for (const [version] of versions) {
    it(`upgrades v${version} through the public CLI and preserves the original facts and backup`, async () => {
      const root = await mkdtemp(join(tmpdir(), "sciretriever-schema-matrix-"));
      const catalog = join(root, "catalog.sqlite");
      const backup = join(root, "before-v8.sqlite");
      try {
        await fixture(catalog, version);
        const before = sourceFacts(catalog);
        const originalBytes = await bytesHash(catalog);
        const entries = await readdir(root);
        expect(
          await cli([
            "storage",
            "schema-upgrade",
            "--catalog",
            catalog,
            "--dry-run",
          ]),
        ).toMatchObject({
          code: 0,
          stdout: { action: "dry-run", from_version: version, to_version: 9 },
        });
        expect(await bytesHash(catalog)).toBe(originalBytes);
        expect(await readdir(root)).toEqual(entries);
        expect(
          await cli([
            "storage",
            "schema-upgrade",
            "--catalog",
            catalog,
            "--backup",
            backup,
          ]),
        ).toMatchObject({
          code: 0,
          stdout: {
            action: version === 9 ? "already-v9" : "upgraded",
            from_version: version,
            to_version: 9,
          },
        });
        expect(sourceFacts(catalog)).toEqual(before);
        expect((await inspectCatalogSchema(catalog)).schema_version).toBe(9);
        if (version < 9) {
          expect((await inspectCatalogSchema(backup)).schema_version).toBe(
            version,
          );
          expect(sourceFacts(backup)).toEqual(before);
        } else {
          expect(await bytesHash(catalog)).toBe(originalBytes);
          expect(await readdir(root)).not.toContain("before-v8.sqlite");
        }
        const reader = new SqliteWorker(catalog, undefined, { readOnly: true });
        try {
          expect(await reader.queryPreflight()).toMatchObject({
            status: "ready",
          });
          expect(
            await reader.getLiterature(FIXTURE_LITERATURE.literature_id),
          ).toMatchObject(FIXTURE_LITERATURE);
        } finally {
          await reader.close();
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }, 15000);
  }

  it("refuses malformed input, unsafe targets, occupied backups and unknown DDL before upgrading", async () => {
    const root = await mkdtemp(join(tmpdir(), "sciretriever-schema-refusal-"));
    const catalog = join(root, "catalog.sqlite");
    const backup = join(root, "before.sqlite");
    try {
      await fixture(catalog);
      const before = await bytesHash(catalog);
      for (const args of [
        ["storage", "schema-upgrade", "--catalog", catalog],
        ["storage", "schema-init", "--catalog", catalog, "--force"],
        [
          "storage",
          "schema-inspect",
          "--catalog",
          catalog,
          "--catalog",
          catalog,
        ],
        [
          "storage",
          "schema-upgrade",
          "--catalog",
          catalog,
          "--dry-run",
          "--backup",
          backup,
        ],
      ])
        expect((await cli(args)).code).toBe(2);
      await writeFile(backup, "occupied backup");
      expect(
        (
          await cli([
            "storage",
            "schema-upgrade",
            "--catalog",
            catalog,
            "--backup",
            backup,
          ])
        ).code,
      ).toBe(3);
      expect(await bytesHash(catalog)).toBe(before);
      expect(await readFile(backup, "utf8")).toBe("occupied backup");
      await symlink(catalog, join(root, "alias.sqlite"));
      await link(catalog, join(root, "hardlink.sqlite"));
      expect(
        (
          await cli([
            "storage",
            "schema-inspect",
            "--catalog",
            join(root, "alias.sqlite"),
          ])
        ).code,
      ).toBe(3);
      expect(
        (await cli(["storage", "schema-inspect", "--catalog", catalog])).code,
      ).toBe(3);
      await rm(join(root, "hardlink.sqlite"));
      await mkdir(join(root, "real"));
      await symlink(join(root, "real"), join(root, "linked-parent"));
      expect(
        (
          await cli([
            "storage",
            "schema-init",
            "--catalog",
            join(root, "linked-parent", "new.sqlite"),
          ])
        ).code,
      ).toBe(3);
      const db = new DatabaseSync(catalog);
      try {
        db.exec("CREATE TABLE unrecognized(value TEXT)");
      } finally {
        db.close();
      }
      const drifted = await bytesHash(catalog);
      expect(
        (
          await cli([
            "storage",
            "schema-upgrade",
            "--catalog",
            catalog,
            "--backup",
            join(root, "new-backup.sqlite"),
          ])
        ).code,
      ).toBe(3);
      expect(await bytesHash(catalog)).toBe(drifted);
      await writeFile(join(root, "damaged.sqlite"), "synthetic damaged bytes");
      expect(
        (
          await cli([
            "storage",
            "schema-inspect",
            "--catalog",
            join(root, "damaged.sqlite"),
          ])
        ).code,
      ).toBe(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("holds the business write lock across every step and reports a failed chain without restoring away facts", async () => {
    const root = await mkdtemp(join(tmpdir(), "sciretriever-schema-recovery-"));
    const catalog = join(root, "catalog.sqlite");
    const backup = join(root, "original-v1.sqlite");
    try {
      await fixture(catalog);
      const original = sourceFacts(catalog);
      let lockChecks = 0;
      await expect(
        upgradeCatalogSchema({
          catalog_path: catalog,
          backup_path: backup,
          checkpoint: async (version, stage) => {
            if (stage === "backed-up" || stage === "completed") {
              await expect(
                acquireCatalogWriteLock(catalog),
              ).rejects.toMatchObject({ code: "write-admission-conflict" });
              lockChecks++;
            }
            if (version === 6 && stage === "before-commit")
              throw new Error("synthetic migration fault");
          },
        }),
      ).rejects.toMatchObject({
        progress: {
          from_version: 1,
          current_version: 5,
          completed_versions: [3, 4, 5],
          failed_step: 6,
          backup_path: backup,
        },
      });
      expect(lockChecks).toBeGreaterThan(3);
      expect(sourceFacts(catalog)).toEqual(original);
      expect(sourceFacts(backup)).toEqual(original);
      expect((await inspectCatalogSchema(backup)).schema_version).toBe(1);
      const backupBytes = await bytesHash(backup);
      const restoredCopy = join(root, "separate-restore-check.sqlite");
      await copyFile(backup, restoredCopy);
      expect((await inspectCatalogSchema(restoredCopy)).schema_version).toBe(1);
      expect(sourceFacts(restoredCopy)).toEqual(original);
      const released = await acquireCatalogWriteLock(catalog);
      await released.release();
      const retried = await upgradeCatalogSchema({
        catalog_path: catalog,
        backup_path: join(root, "retry-from-v5.sqlite"),
      });
      expect(retried).toMatchObject({
        from_version: 5,
        to_version: 9,
        completed_versions: [6, 7, 8, 9],
      });
      expect(await bytesHash(backup)).toBe(backupBytes);
      const writer = new SqliteWorker(catalog);
      try {
        await writer.putLiterature({
          ...FIXTURE_LITERATURE,
          literature_id: parseLiteratureId(
            "00000000-0000-0000-0000-000000000999",
          ),
        });
      } finally {
        await writer.close();
      }
      expect(sourceFacts(catalog)).not.toEqual(sourceFacts(backup));
      expect((await inspectCatalogSchema(catalog)).schema_version).toBe(9);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20000);

  it("refuses concurrent init and upgrade and never accepts a forged or expired internal scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "sciretriever-schema-scope-"));
    const catalog = join(root, "catalog.sqlite");
    const backup = join(root, "before.sqlite");
    try {
      const lock = await acquireCatalogWriteLock(catalog);
      try {
        expect(
          (await cli(["storage", "schema-init", "--catalog", catalog])).stderr,
        ).toMatchObject({ reason: "write-admission-conflict" });
      } finally {
        await lock.release();
      }
      await fixture(catalog);
      const original = await bytesHash(catalog);
      const existing = await acquireCatalogWriteLock(catalog);
      try {
        expect(
          (
            await cli([
              "storage",
              "schema-upgrade",
              "--catalog",
              catalog,
              "--backup",
              backup,
            ])
          ).stderr,
        ).toMatchObject({ reason: "write-admission-conflict" });
      } finally {
        await existing.release();
      }
      await expect(
        migrateDocumentCatalog({
          catalog_path: catalog,
          backup_path: backup,
          migration_scope: { catalog_path: catalog },
        }),
      ).rejects.toBeInstanceOf(CatalogSchemaError);
      let expired: CatalogMigrationScope | undefined;
      await withCatalogMigrationScope(catalog, backup, async (scope) => {
        expired = scope;
      });
      await expect(
        migrateDocumentCatalog({
          catalog_path: catalog,
          backup_path: backup,
          migration_scope: expired!,
        }),
      ).rejects.toMatchObject({ reason: "migration-scope-expired" });
      expect(await bytesHash(catalog)).toBe(original);
      vi.stubEnv("TMPDIR", root);
      await expect(
        migrateDocumentCatalog({ catalog_path: catalog, backup_path: backup }),
      ).rejects.toBeDefined();
      expect(
        await cli([
          "storage",
          "schema-upgrade",
          "--catalog",
          catalog,
          "--backup",
          backup,
        ]),
      ).toMatchObject({ code: 0, stdout: { to_version: 9 } });
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });
});
