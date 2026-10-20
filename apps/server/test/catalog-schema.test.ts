import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  initializeCatalogSchema,
  inspectCatalogSchema,
} from "../src/storage/sqlite/catalog-schema.js";
import { initializeCurrentCatalog } from "../src/storage/sqlite/catalog-layout.js";
import {
  SCHEMA_VERSION,
  SCHEMA_FINGERPRINT,
} from "../src/storage/sqlite/schema.js";
import { SqliteWorker } from "../src/storage/sqlite/worker.js";
import { runCli } from "../src/cli/main.js";
const digest = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
async function fixture(run: (root: string, catalog: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "sciretriever-current-catalog-"));
  try {
    await run(root, join(root, "catalog.sqlite"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
it("initializes all current owners once and keeps absent inspection read-only", async () =>
  fixture(async (root, catalog) => {
    expect(await inspectCatalogSchema(catalog)).toMatchObject({
      status: "not-initialized",
    });
    expect(await readdir(root)).toEqual([]);
    expect(await initializeCatalogSchema(catalog)).toMatchObject({
      action: "initialized",
      to_version: SCHEMA_VERSION,
      inspection: { status: "ready", schema_fingerprint: SCHEMA_FINGERPRINT },
    });
    const db = new DatabaseSync(catalog, { readOnly: true });
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r) => r.name);
      for (const table of [
        "raw_parses",
        "proofread_versions",
        "structure_annotations",
        "literature_metadata_field_states",
        "archive_reference_text_supports",
        "tags",
        "execution_jobs",
      ])
        expect(tables).toContain(table);
      expect(tables.filter((t) => String(t).endsWith("_migrations"))).toEqual(
        [],
      );
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
    const before = await digest(catalog);
    await expect(initializeCatalogSchema(catalog)).rejects.toMatchObject({
      reason: "catalog-target-exists",
    });
    expect(await digest(catalog)).toBe(before);
  }));
it("rolls back a partial DDL creation and never replaces an occupied target", async () =>
  fixture(async (root, catalog) => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE TABLE existing(value TEXT)");
      expect(() => initializeCurrentCatalog(db)).toThrow(
        "catalog-initialization-target-not-empty",
      );
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(),
      ).toEqual([{ name: "existing" }]);
    } finally {
      db.close();
    }
    await expect(
      initializeCatalogSchema(catalog, () => {
        throw new Error("synthetic interruption");
      }),
    ).rejects.toThrow("synthetic interruption");
    expect((await inspectCatalogSchema(catalog)).status).toBe(
      "not-initialized",
    );
    await expect(
      initializeCatalogSchema(catalog, async (stage) => {
        if (stage === "before-publish")
          await writeFile(catalog, "racing writer");
      }),
    ).rejects.toBeDefined();
    expect(await readFile(catalog, "utf8")).toBe("racing writer");
    expect(
      (await readdir(root)).some((n) => n.startsWith(".sciretriever-init-")),
    ).toBe(false);
  }));
it("reports a valid published catalog even when a late observer fails", async () =>
  fixture(async (_, catalog) => {
    await expect(
      initializeCatalogSchema(catalog, (stage) => {
        if (stage === "published") throw new Error("observer failed");
      }),
    ).rejects.toThrow("observer failed");
    expect((await inspectCatalogSchema(catalog)).status).toBe("ready");
  }));
it("refuses foreign, older and drifted layouts without repairing or writing them", async () =>
  fixture(async (root, catalog) => {
    const db = new DatabaseSync(catalog);
    db.exec(
      "CREATE TABLE schema_identity(singleton INTEGER,product TEXT,schema_version INTEGER,schema_fingerprint TEXT)",
    );
    db.prepare("INSERT INTO schema_identity VALUES(1,'sciretriever',10,?)").run(
      "a".repeat(64),
    );
    db.close();
    const before = await digest(catalog);
    await expect(inspectCatalogSchema(catalog)).rejects.toMatchObject({
      reason: "catalog-layout-not-current",
    });
    expect(await digest(catalog)).toBe(before);
    const current = join(root, "current.sqlite");
    await initializeCatalogSchema(current);
    const changed = new DatabaseSync(current);
    changed.exec("CREATE TABLE unknown_payload(value TEXT)");
    changed.close();
    await expect(inspectCatalogSchema(current)).rejects.toMatchObject({
      reason: "catalog-integrity-refused",
    });
    const reader = new SqliteWorker(current, undefined, { readOnly: true });
    try {
      expect((await reader.queryPreflight()).status).toBe("unavailable");
    } finally {
      await reader.close();
    }
  }));
it("refuses linked targets and has no public historical migration command", async () =>
  fixture(async (root, catalog) => {
    const target = join(root, "target.sqlite");
    await initializeCatalogSchema(target);
    await symlink(target, catalog);
    await expect(inspectCatalogSchema(catalog)).rejects.toMatchObject({
      reason: "target-file-unsafe",
    });
    for (const command of [
      "schema-upgrade",
      "migrate",
      "document-migrate",
      "retrieval-migrate",
      "extraction-migrate",
    ]) {
      const result = await runCli(["storage", command, "--catalog", target], {
        home: root,
        stdout: () => {},
        stderr: () => {},
      });
      expect(result.code).toBe(2);
    }
  }));
