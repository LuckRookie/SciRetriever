import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { migrateCitationLimitsSchema } from "../src/storage/sqlite/citation-limits-schema-migration.js";
import { migrateLiteratureSearchSchema } from "../src/storage/sqlite/literature-search-schema-migration.js";
import { verifyOfflineLayout } from "../src/storage/sqlite/archive-schema-migration.js";
import {
  SCHEMA_MANIFEST_V19,
  SCHEMA_FINGERPRINT_V19,
  SCHEMA_MANIFEST_V18,
  SCHEMA_FINGERPRINT_V18,
} from "../src/storage/sqlite/schema.js";
import {
  EXECUTION_SCHEMA_VERSION,
  EXECUTION_SCHEMA_FINGERPRINT,
  EXECUTION_RUNTIME_SCHEMA_VERSION,
  EXECUTION_RUNTIME_SCHEMA_FINGERPRINT,
} from "../src/storage/sqlite/execution-schema.js";

const at = "2026-11-19T00:00:00.000Z";
function input(path: string) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys=ON;BEGIN");
  for (const sql of SCHEMA_MANIFEST_V18) db.exec(sql);
  db.prepare("INSERT INTO schema_identity VALUES(1,'sciretriever',18,?,?)").run(
    SCHEMA_FINGERPRINT_V18,
    at,
  );
  db.prepare("INSERT INTO execution_schema_identity VALUES(1,?,?)").run(
    EXECUTION_SCHEMA_VERSION,
    EXECUTION_SCHEMA_FINGERPRINT,
  );
  db.prepare("INSERT INTO execution_runtime_schema_identity VALUES(1,?,?)").run(
    EXECUTION_RUNTIME_SCHEMA_VERSION,
    EXECUTION_RUNTIME_SCHEMA_FINGERPRINT,
  );
  db.exec(
    "INSERT INTO retrieval_source_revision VALUES(1,0);INSERT INTO vocabulary_state VALUES(1,0,0)",
  );
  for (const id of ["seed", "target"]) {
    db.prepare("INSERT INTO meta_literatures VALUES(?,?)").run(
      "meta-" + id,
      id,
    );
    db.prepare("INSERT INTO literatures VALUES(?,?,'published')").run(
      id,
      "meta-" + id,
    );
  }
  db.prepare(
    "INSERT INTO discovery_runs VALUES('topic','topic','COMPLETED',?)",
  ).run(at);
  db.exec(
    "INSERT INTO topic_discovery_inputs VALUES('topic','topic','synthetic',NULL,NULL)",
  );
  db.exec(
    "INSERT INTO discovery_run_providers VALUES('topic',0,'crossref',50000)",
  );
  db.prepare(
    "INSERT INTO discovery_runs VALUES('citation','citation','COMPLETED',?)",
  ).run(at);
  db.exec(
    "INSERT INTO citation_discovery_inputs VALUES('citation','citation','references',2,9007199254740991)",
  );
  db.exec("INSERT INTO citation_discovery_seeds VALUES('citation',0,'seed')");
  db.exec(
    "INSERT INTO discovery_run_providers VALUES('citation',0,'crossref',4321)",
  );
  db.exec(
    "INSERT INTO discovery_source_results VALUES('citation','crossref','EXHAUSTED',NULL,NULL,NULL,NULL)",
  );
  db.exec("INSERT INTO discovery_results VALUES('citation','meta-target')");
  db.exec("COMMIT");
  return db;
}
function rows(db: DatabaseSync) {
  return Object.fromEntries(
    db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((r) => {
        const name = String(r.name);
        if (!/^[a-z_][a-z0-9_]*$/u.test(name))
          throw new Error("Invalid synthetic table name");
        return [
          name,
          db
            .prepare(`SELECT * FROM ${name}`)
            .all()
            .map((r) => JSON.stringify(r))
            .sort(),
        ];
      }),
  );
}
async function fixture(run: (path: string) => Promise<void>) {
  const home = await mkdtemp(
    join(tmpdir(), "sciretriever-citation-migration-"),
  );
  try {
    await run(join(home, "catalog.sqlite"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

it("migrates exact populated 18 to exact 19, preserving all old values and incoming FKs", async () =>
  fixture(async (path) => {
    const old = input(path);
    const before = rows(old);
    const layout = old
      .prepare(
        "SELECT name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all();
    old.close();
    expect(SCHEMA_FINGERPRINT_V18).toBe(
      "a95b796f5f8dd69839748571476a8bcc0f3d38ed1547d8f8aab25c38b1e2d8cf",
    );
    expect(SCHEMA_FINGERPRINT_V19).toBe(
      "a605840d3d19206f08551c2cb5b78199d5c4190b93673c9502d5fb412b1cd88c",
    );
    const receipt = await migrateCitationLimitsSchema(path);
    expect(receipt).toMatchObject({
      from_version: 18,
      to_version: 19,
      schema_fingerprint: SCHEMA_FINGERPRINT_V19,
      foreign_key_violations: 0,
      integrity_check: "ok",
    });
    expect(receipt.after).toEqual(receipt.before);
    const db = new DatabaseSync(path);
    try {
      verifyOfflineLayout(db, SCHEMA_MANIFEST_V19);
      const after = rows(db);
      // Only the schema identity and the new provider kind differ in old rows.
      after.schema_identity = after.schema_identity!.map((r) =>
        JSON.stringify({
          ...JSON.parse(r),
          schema_version: 18,
          schema_fingerprint: SCHEMA_FINGERPRINT_V18,
        }),
      );
      after.discovery_run_providers = after
        .discovery_run_providers!.map((r) => {
          const { kind, ...oldRow } = JSON.parse(r) as Record<string, unknown>;
          expect(kind).toBe(
            oldRow.discovery_run_id === "topic" ? "topic" : "citation",
          );
          return JSON.stringify(oldRow);
        })
        .sort();
      expect(after).toEqual(before);
      for (const row of layout)
        if (
          ![
            "schema_identity",
            "citation_discovery_inputs",
            "discovery_run_providers",
          ].includes(String(row.name))
        )
          expect(
            db
              .prepare("SELECT sql FROM sqlite_schema WHERE name=?")
              .get(row.name!)?.sql,
          ).toBe(row.sql);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      db.exec("PRAGMA foreign_keys=ON");
      db.prepare(
        "INSERT INTO discovery_runs VALUES('unlimited','citation','COMPLETED',?)",
      ).run(at);
      db.exec(
        "INSERT INTO citation_discovery_inputs VALUES('unlimited','citation','both',1,NULL)",
      );
      db.exec(
        "INSERT INTO discovery_run_providers VALUES('unlimited',0,'crossref',NULL,'citation')",
      );
      expect(
        db
          .prepare(
            "SELECT result_limit FROM citation_discovery_inputs WHERE discovery_run_id='unlimited'",
          )
          .get(),
      ).toEqual({ result_limit: null });
      expect(
        db
          .prepare(
            "SELECT scan_limit FROM discovery_run_providers WHERE discovery_run_id='unlimited'",
          )
          .get(),
      ).toEqual({ scan_limit: null });
      expect(() =>
        db.exec(
          "INSERT INTO discovery_run_providers VALUES('topic',1,'fixture',NULL,'topic')",
        ),
      ).toThrow(/CHECK/u);
      expect(() =>
        db.exec(
          "INSERT INTO discovery_run_providers VALUES('topic',1,'fixture',NULL,'citation')",
        ),
      ).toThrow(/FOREIGN KEY/u);
      for (const n of [0, -1, 1.5]) {
        expect(() =>
          db
            .prepare(
              "UPDATE citation_discovery_inputs SET result_limit=? WHERE discovery_run_id='unlimited'",
            )
            .run(n),
        ).toThrow();
        expect(() =>
          db
            .prepare(
              "UPDATE discovery_run_providers SET scan_limit=? WHERE discovery_run_id='unlimited'",
            )
            .run(n),
        ).toThrow();
      }
      expect(() =>
        db.exec(
          "DELETE FROM citation_discovery_inputs WHERE discovery_run_id='citation'",
        ),
      ).toThrow(/FOREIGN KEY/u);
      expect(() =>
        db.exec(
          "DELETE FROM discovery_run_providers WHERE discovery_run_id='citation'",
        ),
      ).toThrow(/FOREIGN KEY/u);
    } finally {
      db.close();
    }
  }));

it("rolls back both rebuilt tables and identity when publication fails midway", async () =>
  fixture(async (path) => {
    const db = input(path);
    const before = rows(db);
    db.close();
    const exec = DatabaseSync.prototype.exec;
    let injected = false;
    const spy = vi
      .spyOn(DatabaseSync.prototype, "exec")
      .mockImplementation(function (this: DatabaseSync, sql: string) {
        if (
          !injected &&
          sql.startsWith("INSERT INTO discovery_run_providers(")
        ) {
          injected = true;
          throw new Error("synthetic migration failure");
        }
        return exec.call(this, sql);
      });
    try {
      await expect(migrateCitationLimitsSchema(path)).rejects.toThrow(
        "synthetic migration failure",
      );
    } finally {
      spy.mockRestore();
    }
    expect(injected).toBe(true);
    const check = new DatabaseSync(path, { readOnly: true });
    try {
      verifyOfflineLayout(check, SCHEMA_MANIFEST_V18);
      expect(rows(check)).toEqual(before);
    } finally {
      check.close();
    }
    await expect(migrateCitationLimitsSchema(path)).resolves.toMatchObject({
      to_version: 19,
    });
  }));

it("refuses drift, wrong versions and active jobs without changing their files", async () => {
  for (const mode of ["drift", "identity", "active"] as const)
    await fixture(async (path) => {
      const db = input(path);
      if (mode === "drift")
        db.exec("CREATE INDEX unapproved_index ON discovery_runs(status)");
      if (mode === "identity")
        db.exec(
          "UPDATE schema_identity SET schema_fingerprint='" +
            "a".repeat(64) +
            "'",
        );
      if (mode === "active")
        db.prepare(
          "INSERT INTO execution_jobs VALUES('active','selector','{}','fixture','queued','active',?,NULL)",
        ).run(at);
      db.close();
      const before = createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
      await expect(migrateCitationLimitsSchema(path)).rejects.toMatchObject({
        code: "citation-limits-schema-migration-refused",
      });
      expect(
        createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
      ).toBe(before);
    });
});

it(
  "runs the offline script only against an explicit path and leaves startup migrations disabled",
  async () =>
    fixture(async (path) => {
      input(path).close();
      const run = promisify(execFile),
        script = resolve("scripts/migrate-citation-limits-v19.mjs");
      await expect(
        run(process.execPath, [script, "relative.sqlite"]),
      ).rejects.toThrow();
      const { inspectCatalogSchema } = await import(
        "../src/storage/sqlite/catalog-schema.js"
      );
      await expect(inspectCatalogSchema(path)).rejects.toThrow();
      const result = await run(process.execPath, [script, path], {
        timeout: 30000,
      });
      expect(JSON.parse(result.stdout)).toMatchObject({
        from_version: 18,
        to_version: 19,
        schema_fingerprint: SCHEMA_FINGERPRINT_V19,
      });
      await expect(inspectCatalogSchema(path)).rejects.toMatchObject({
        reason: "catalog-layout-not-current",
      });
      await migrateLiteratureSearchSchema(path);
      await expect(inspectCatalogSchema(path)).resolves.toMatchObject({
        schema_version: 19,
      });
      await expect(migrateCitationLimitsSchema(path)).rejects.toMatchObject({
        code: "citation-limits-schema-migration-refused",
      });
    }),
  40000,
);
