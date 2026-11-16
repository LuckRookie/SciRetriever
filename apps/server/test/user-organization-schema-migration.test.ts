import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { runMarkStorage } from "../src/storage/sqlite/marks-engine.js";
import { migrateUserOrganizationSchema } from "../src/storage/sqlite/user-organization-schema-migration.js";
import { verifyOfflineLayout } from "../src/storage/sqlite/archive-schema-migration.js";
import {
  SCHEMA_MANIFEST,
  SCHEMA_MANIFEST_V17,
} from "../src/storage/sqlite/schema.js";
import {
  emptyUserOrganizationInput,
  organizationRows,
  userOrganizationFixture,
} from "./user-organization-schema-fixture.js";

it("migrates populated exact 17 preserving all old logical rows, artifacts, FTS, state and freshness", async () => {
  const f = await userOrganizationFixture();
  try {
    for (const table of [
      "folders",
      "folder_members",
      "reading_history",
      "reading_marks",
      "processor_results",
      "processor_result_documents",
      "processor_result_freshness",
      "retrieval_fts",
      "processor_result_fts",
    ])
      expect(f.rows[table]!.length, table).toBeGreaterThan(0);
    expect(f.rows.document_versions!.map((r) => r.schema_version)).toEqual(
      expect.arrayContaining([2, 3]),
    );
    expect(f.rows.reading_marks!.some((r) => r.deleted_at !== null)).toBe(true);
    expect(f.rows.device_connections).toHaveLength(2);
    expect(
      f.rows.device_connections!.some(
        (row) =>
          row.paired_at !== null &&
          row.revoked_at !== null &&
          row.last_used_at !== null,
      ),
    ).toBe(true);
    const result = await migrateUserOrganizationSchema(f.path);
    expect(result).toMatchObject({
      from_version: 17,
      to_version: 18,
      foreign_key_violations: 0,
      integrity_check: "ok",
    });
    for (const [table, count] of Object.entries(result.before))
      expect(result.after[table], table).toBe(count);
    expect(result.after.saved_filters).toBe(0);
    expect(result.after.reading_mark_places).toBe(0);
    const db = new DatabaseSync(f.path, { readOnly: true });
    try {
      verifyOfflineLayout(db, SCHEMA_MANIFEST);
      const after = organizationRows(db),
        before = structuredClone(f.rows);
      // Preserve every original device field, adding only the nullable kind.
      before.device_connections = before.device_connections!.map((row) => ({
        ...row,
        kind: null,
      }));
      expect(after.device_connections).toEqual(before.device_connections);
      // Other old rows only change their schema identity.
      expect(after.schema_identity![0]).toMatchObject({
        ...before.schema_identity![0],
        schema_version: 18,
        schema_fingerprint: expect.any(String),
      });
      delete after.schema_identity;
      delete before.schema_identity;
      expect(after).toEqual(before);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      for (const table of ["retrieval_fts", "processor_result_fts"])
        expect(
          db
            .prepare(
              `SELECT count(*) n FROM ${table} WHERE ${table} MATCH 'finding'`,
            )
            .get()!.n,
        ).toBeGreaterThan(0);
    } finally {
      db.close();
    }
    const { createHash } = await import("node:crypto");
    for (const [path, hash] of f.assets)
      expect(
        createHash("sha256")
          .update(await readFile(join(f.env.home, "artifacts", path)))
          .digest("hex"),
      ).toBe(hash);
    console.info(
      "Synthetic 17 -> 18",
      JSON.stringify({
        elapsed_ms: result.elapsed_ms,
        result_tables: f.resultTables,
        assets: f.assets.length,
      }),
    );
  } finally {
    await f.close();
  }
}, 120000);

async function fixture(run: (path: string) => Promise<void>) {
  const root = await mkdtemp(
    join(tmpdir(), "sciretriever-organization-migration-"),
  );
  try {
    await run(join(root, "catalog.sqlite"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
it(
  "runs the built offline script only with an explicit absolute catalog path",
  async () =>
    fixture(async (path) => {
      const input = emptyUserOrganizationInput(path);
      input.exec(
        "INSERT INTO device_connections VALUES('legacy','Synthetic legacy','[\"read\"]',NULL,'2026-11-17T00:00:00Z',NULL,NULL,NULL)",
      );
      input.close();
      const script = fileURLToPath(
        new URL(
          "../../../scripts/migrate-user-organization-v18.mjs",
          import.meta.url,
        ),
      );
      const run = promisify(execFile);
      await expect(
        run(process.execPath, [script, "relative.sqlite"]),
      ).rejects.toThrow();
      expect(
        JSON.parse(
          (await run(process.execPath, [script, path], { timeout: 30000 }))
            .stdout,
        ),
      ).toMatchObject({
        from_version: 17,
        to_version: 18,
        foreign_key_violations: 0,
      });
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        verifyOfflineLayout(db, SCHEMA_MANIFEST);
        expect(
          db
            .prepare(
              "SELECT kind FROM device_connections WHERE connection_id='legacy'",
            )
            .get(),
        ).toEqual({ kind: null });
      } finally {
        db.close();
      }
    }),
  40000,
);

it.each([
  "fingerprint",
  "unknown",
  "already18",
  "queued",
  "running",
  "archive",
  "identity-layout",
  "empty-identity",
  "execution",
  "foreign-key",
] as const)(
  "refuses %s without changing the input",
  async (kind) =>
    fixture(async (path) => {
      const db = emptyUserOrganizationInput(path);
      if (kind === "fingerprint")
        db.exec(
          "UPDATE schema_identity SET schema_fingerprint=printf('%064d',0)",
        );
      if (kind === "unknown") db.exec("CREATE TABLE unknown(x TEXT)");
      if (kind === "identity-layout")
        db.exec(
          "DROP TABLE schema_identity;CREATE TABLE schema_identity(x TEXT)",
        );
      if (kind === "empty-identity") db.exec("DELETE FROM schema_identity");
      if (kind === "execution")
        db.exec(
          "UPDATE execution_runtime_schema_identity SET fingerprint=printf('%064d',0)",
        );
      if (kind === "queued" || kind === "running")
        db.prepare(
          "INSERT INTO execution_jobs VALUES('job','selector','{}','p',?,'key','2026-11-16T00:00:00Z',NULL)",
        ).run(kind);
      if (kind === "archive") {
        db.exec(
          "BEGIN;INSERT INTO meta_literatures VALUES('meta','paper');INSERT INTO literatures VALUES('paper','meta','published')",
        );
        db.prepare(
          "INSERT INTO artifact_objects VALUES('pdf',?,1,'application/pdf','objects/fake.pdf')",
        ).run("a".repeat(64));
        db.prepare(
          "INSERT INTO assets VALUES('pdf',?,1,'application/pdf','objects/fake.pdf')",
        ).run("a".repeat(64));
        db.exec(
          "INSERT INTO archive_runs VALUES('paper','pdf','full','run',NULL,'running','2026-11-16T00:00:00Z',NULL);COMMIT",
        );
        expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      }
      if (kind === "foreign-key")
        db.exec(
          "PRAGMA foreign_keys=OFF;INSERT INTO folder_members VALUES('missing','missing','2026-11-16T00:00:00Z','fixture')",
        );
      db.close();
      if (kind === "already18") await migrateUserOrganizationSchema(path);
      const bytes = await readFile(path);
      await expect(migrateUserOrganizationSchema(path)).rejects.toMatchObject({
        code: "user-organization-schema-migration-refused",
      });
      expect(await readFile(path)).toEqual(bytes);
    }),
  30000,
);

it.each([
  "second table",
  "device kind",
  "identity",
  "already rolled back",
  "rollback throws",
] as const)(
  "preserves the original error on %s and can rerun exact 17",
  async (mode) =>
    fixture(async (path) => {
      emptyUserOrganizationInput(path).close();
      const bytes = await readFile(path),
        original = DatabaseSync.prototype.exec,
        failure = new Error("Synthetic original migration failure");
      const spy = vi
        .spyOn(DatabaseSync.prototype, "exec")
        .mockImplementation(function (this: DatabaseSync, sql: string) {
          if (
            sql.startsWith(
              mode === "device kind"
                ? "ALTER TABLE device_connections ADD COLUMN "
                : mode === "identity"
                  ? "CREATE TABLE schema_identity("
                  : "CREATE TABLE reading_mark_places(",
            )
          ) {
            if (mode === "already rolled back") original.call(this, "ROLLBACK");
            throw failure;
          }
          original.call(this, sql);
          if (mode === "rollback throws" && sql === "ROLLBACK")
            throw new Error("Synthetic cleanup failure");
        });
      try {
        await expect(migrateUserOrganizationSchema(path)).rejects.toBe(failure);
      } finally {
        spy.mockRestore();
      }
      expect(await readFile(path)).toEqual(bytes);
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        verifyOfflineLayout(db, SCHEMA_MANIFEST_V17);
      } finally {
        db.close();
      }
      expect((await migrateUserOrganizationSchema(path)).to_version).toBe(18);
    }),
  30000,
);

it("enforces both new table constraints and cascades places on mark retention cleanup and paper deletion", async () => {
  const f = await userOrganizationFixture();
  try {
    await migrateUserOrganizationSchema(f.path);
    const db = new DatabaseSync(f.path);
    db.exec("PRAGMA foreign_keys=ON");
    try {
      const mark = String(
        db.prepare("SELECT mark_id FROM reading_marks LIMIT 1").get()!.mark_id,
      );
      const insert = db.prepare(
        "INSERT INTO reading_mark_places VALUES(?,?,?,?,?,?,?,?,?,?)",
      );
      const pdf = [
        mark,
        "pdf",
        "a".repeat(64),
        1,
        "[[0,0,10,10]]",
        null,
        null,
        0.7,
        "mark-locate-v1",
        "2026-11-16T00:00:00Z",
      ];
      const invalid = (indices: Record<number, string | number | null>) => {
        const values = [...pdf];
        for (const [i, v] of Object.entries(indices)) values[Number(i)] = v;
        expect(() => insert.run(...values)).toThrow();
      };
      for (const changes of [
        { 0: "absent" },
        { 1: "other" },
        { 2: "A".repeat(64) },
        { 3: 0 },
        { 3: null },
        { 4: "invalid" },
        { 4: null },
        { 5: 0 },
        { 7: 0.69 },
        { 7: 1.01 },
        { 8: "" },
        { 9: null },
      ])
        invalid(changes);
      insert.run(...pdf);
      expect(() => insert.run(...pdf)).toThrow();
      const document = [
        mark,
        "document",
        "fixed-version",
        null,
        null,
        0,
        20,
        1,
        "mark-locate-v1",
        "2026-11-16T00:00:00Z",
      ];
      insert.run(...document);
      expect(() =>
        insert.run(mark, "document", "bad", null, null, 20, 20, 1, "m", "time"),
      ).toThrow();
      expect(() =>
        insert.run(
          mark,
          "document",
          "bad",
          null,
          null,
          null,
          20,
          1,
          "m",
          "time",
        ),
      ).toThrow();
      db.prepare("UPDATE reading_marks SET deleted_at=? WHERE mark_id=?").run(
        "2026-11-16T00:00:00Z",
        mark,
      );
      expect(
        db.prepare("SELECT count(*) n FROM reading_mark_places").get()!.n,
      ).toBe(2);
      const secondary = "cascade-paper";
      db.prepare("INSERT INTO literatures VALUES(?,?,'other')").run(
        secondary,
        f.rows.literatures![0]!.meta_literature_id!,
      );
      const copy = {
        ...db.prepare("SELECT * FROM reading_marks WHERE mark_id=?").get(mark)!,
        mark_id: "00000000-0000-0000-0000-000000000099",
        literature_id: secondary,
        deleted_at: null,
      };
      const columns = Object.keys(copy);
      db.prepare(
        `INSERT INTO reading_marks(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
      ).run(...Object.values(copy));
      insert.run(copy.mark_id, ...pdf.slice(1));
      db.prepare("DELETE FROM literatures WHERE literature_id=?").run(
        secondary,
      );
      expect(
        db
          .prepare("SELECT 1 FROM reading_marks WHERE mark_id=?")
          .get(copy.mark_id),
      ).toBeUndefined();
      expect(
        db.prepare("SELECT count(*) n FROM reading_mark_places").get()!.n,
      ).toBe(2);
      // Existing mark writer purges soft-deleted marks after 30 days; the new
      // dependent rows disappear through FK cascade without a new cleanup path.
      runMarkStorage(db, {
        operation: "create",
        mark_id: "00000000-0000-0000-0000-000000000098",
        now: "2026-12-17T00:00:00Z",
        actor: "fixture",
        request: {
          literature_id: f.env.parseRequest.literature_id,
          kind: "region",
          color: "yellow",
          pdf: { sha256: f.env.asset.sha256, page: 1, rects: [[0, 0, 10, 10]] },
        },
      });
      expect(
        db.prepare("SELECT 1 FROM reading_marks WHERE mark_id=?").get(mark),
      ).toBeUndefined();
      expect(
        db.prepare("SELECT count(*) n FROM reading_mark_places").get()!.n,
      ).toBe(0);
      const filter = db.prepare(
        "INSERT INTO saved_filters VALUES(?,?,?,?,?,?)",
      );
      for (const values of [
        [null, "n", "{}", "title-asc", "t", "t"],
        ["f", "", "{}", "title-asc", "t", "t"],
        ["f", "n", "broken", "title-asc", "t", "t"],
        ["f", "n", "{}", "", "t", "t"],
        ["f", "n", "{}", "title-asc", null, "t"],
      ])
        expect(() => filter.run(...values)).toThrow();
      filter.run("f", "Name", "{}", "title-asc", "t", "t");
      expect(() =>
        filter.run("g", "Name", "{}", "title-asc", "t", "t"),
      ).toThrow();
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  } finally {
    await f.close();
  }
}, 120000);
