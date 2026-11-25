import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseLiterature, parseLiteratureId } from "@sciretriever/contracts";
import { expect, it } from "vitest";
import {
  createApplication,
  createQueryApplication,
} from "../src/bootstrap/application.js";
import { runCli } from "../src/cli/main.js";
import { DatabaseCompletionService } from "../src/entry/database-completion.js";
import { applyCatalogAddition } from "../src/storage/sqlite/catalog-additions.js";
import { runCatalogBackfillBatch } from "../src/storage/sqlite/catalog-backfill.js";
import {
  defineCatalogAddition,
  manifestObject,
  registerCatalogAddition,
} from "../src/storage/sqlite/catalog-ddl.js";
import { readCatalogLayout } from "../src/storage/sqlite/catalog-identity.js";
import {
  catalogConfigFor,
  initializeCurrentCatalog,
} from "../src/storage/sqlite/catalog-layout.js";
import { inspectCatalogSchema } from "../src/storage/sqlite/catalog-schema.js";
import {
  beginCatalogWrite,
  commitCatalogWrite,
} from "../src/storage/sqlite/catalog-write.js";
import { StoredLibraryState } from "../src/storage/sqlite/library-state.js";
import { withoutDocumentTranslations } from "./document-translations-fixture.js";
import {
  ARCHIVE_ISSUES_ADDITION,
  DOCUMENT_TRANSLATIONS_ADDITION,
  LIBRARY_SCALE_ADDITION,
  LIBRARY_TRASH_ADDITION,
  SCHEMA_FINGERPRINT,
  SCHEMA_MANIFEST,
} from "../src/storage/sqlite/schema.js";
import { SqliteWorker } from "../src/storage/sqlite/worker.js";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";
import {
  fullTextCatalogRows,
  fullTextId as id,
  libraryFullTextFixture,
} from "./library-fulltext-fixture.js";

const settings = { max_tags: 6, archive_profile: "vlm-engine" } as const;
const at = "2026-11-22T04:00:00.000Z";
const catalogFixture = async (
  work: (directory: string, path: string) => Promise<void>,
) => {
  const directory = await mkdtemp(
    join(tmpdir(), "sciretriever-catalog-addition-"),
  );
  try {
    await work(directory, join(directory, "catalog.sqlite"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

function futureDefinition() {
  const appended = [
    ["literature_intake", "compat_note TEXT DEFAULT 'future'"],
    ["reading_history", "compat_counter INTEGER NOT NULL DEFAULT 0"],
    ["library_state_changes", "compat_state TEXT"],
    ["library_collection_times", "compat_time TEXT"],
    ["execution_jobs", "compat_data TEXT"],
  ] as const;
  const objects = [
    "CREATE TABLE future_audit(literature_id TEXT PRIMARY KEY,opened_count INTEGER NOT NULL) STRICT",
    "CREATE INDEX future_audit_count ON future_audit(opened_count)",
    "CREATE VIEW future_recent AS SELECT literature_id FROM future_audit WHERE opened_count>0",
    "CREATE TRIGGER future_record_open AFTER INSERT ON reading_history BEGIN INSERT INTO future_audit(literature_id,opened_count) VALUES(new.literature_id,abs(new.open_count)); END",
  ];
  return defineCatalogAddition(
    "future-addition",
    [
      ...appended.map(
        ([table, column]) => `ALTER TABLE ${table} ADD COLUMN ${column}`,
      ),
      ...objects,
    ],
    [],
    [
      ...appended.map(([table, column]) => {
        const sql = SCHEMA_MANIFEST.find((value) =>
          value.startsWith(`CREATE TABLE ${table}(`),
        )!;
        return table === "literature_intake" ||
          table === "reading_history" ||
          table === "library_collection_times"
          ? sql.replace(",FOREIGN KEY", `, ${column},FOREIGN KEY`)
          : sql.replace(/\)( STRICT(?:, WITHOUT ROWID)?)$/u, `, ${column})$1`);
      }),
      ...objects,
    ],
  );
}

it("keeps an open app running through a future addition and inspects all added objects and columns", async () => {
  await catalogFixture(async (home, path) => {
    const app = await createApplication(home, {
      metadata: {},
      indexRefreshIntervalMs: null,
    });
    const future = futureDefinition();
    const literature = parseLiterature({
      ...FIXTURE_LITERATURE,
      literature_id: id(10),
      meta_literature_id: id(110),
    });
    try {
      await expect(app.database.schema()).resolves.toMatchObject({
        schema_version: 19,
      });
      await expect(applyCatalogAddition(path, future)).resolves.toMatchObject({
        name: future.name,
        ddl_fingerprint: future.ddl_fingerprint,
        ddl_hold_ms: expect.any(Number),
      });
      await expect(app.database.putLiterature(literature)).resolves.toBe(true);
      expect(
        await app.folders.opened({ literature_id: literature.literature_id }),
      ).toEqual({
        literature_id: literature.literature_id,
        last_opened_at: expect.any(String),
        open_count: 1,
      });
      expect(
        (await app.library.detail(literature.literature_id)).literature,
      ).toEqual(literature);

      const reader = await createQueryApplication(home, { catalog_path: path });
      try {
        expect(
          (await reader.query!.detail(literature.literature_id)).literature,
        ).toEqual(literature);
      } finally {
        await reader.close();
      }
      const report = await runCli(
        ["storage", "schema-inspect", "--catalog", path],
        {
          home,
          stdout: () => {},
          stderr: () => {},
        },
      );
      expect(report).toMatchObject({
        code: 0,
        value: {
          status: "ready",
          additions: expect.arrayContaining([
            expect.objectContaining({
              name: future.name,
              ddl_fingerprint: future.ddl_fingerprint,
              applied_at: expect.any(String),
            }),
          ]),
          extra_objects: [
            { type: "index", name: "future_audit_count" },
            { type: "table", name: "future_audit" },
            { type: "trigger", name: "future_record_open" },
            { type: "view", name: "future_recent" },
          ],
          extra_columns: expect.arrayContaining([
            {
              table: "literature_intake",
              name: "compat_note",
              nullable: true,
              default_sql: "'future'",
            },
            {
              table: "reading_history",
              name: "compat_counter",
              nullable: false,
              default_sql: "0",
            },
            {
              table: "library_state_changes",
              name: "compat_state",
              nullable: true,
              default_sql: null,
            },
            {
              table: "library_collection_times",
              name: "compat_time",
              nullable: true,
              default_sql: null,
            },
            {
              table: "execution_jobs",
              name: "compat_data",
              nullable: true,
              default_sql: null,
            },
          ]),
        },
      });
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        expect(
          db
            .prepare("SELECT literature_id,opened_count FROM future_audit")
            .all(),
        ).toEqual([
          { literature_id: literature.literature_id, opened_count: 1 },
        ]);
        expect(
          db
            .prepare(
              "SELECT compat_note FROM literature_intake WHERE literature_id=?",
            )
            .get(literature.literature_id),
        ).toEqual({ compat_note: "future" });
      } finally {
        db.close();
      }
      await expect(applyCatalogAddition(path, future)).rejects.toMatchObject({
        reason: "catalog-addition-already-applied",
      });
    } finally {
      await app.close();
    }
  });
});

it("reports a missing required addition from the CLI and both application openers", async () => {
  await catalogFixture(async (home, path) => {
    const db = new DatabaseSync(path);
    try {
      initializeCurrentCatalog(db, at);
      db.prepare("DELETE FROM catalog_schema_additions WHERE name=?").run(
        LIBRARY_SCALE_ADDITION.name,
      );
    } finally {
      db.close();
    }
    const expected = {
      code: "catalog-addition-required",
      addition: LIBRARY_SCALE_ADDITION.name,
    };
    await expect(inspectCatalogSchema(path)).rejects.toMatchObject(expected);
    await expect(
      createApplication(home, { metadata: {}, indexRefreshIntervalMs: null }),
    ).rejects.toMatchObject(expected);
    await expect(
      createQueryApplication(home, { catalog_path: path }),
    ).rejects.toMatchObject(expected);
    let stderr = "";
    const cli = await runCli(["storage", "schema-inspect", "--catalog", path], {
      home,
      stdout: () => {},
      stderr: (message) => {
        stderr += message;
      },
    });
    expect(cli.code).not.toBe(0);
    expect(JSON.parse(stderr)).toMatchObject(expected);
  });
});

it("rechecks the required addition on an already open backfill connection", async () => {
  await catalogFixture(async (_home, path) => {
    const db = new DatabaseSync(path);
    const worker = new SqliteWorker(path);
    try {
      initializeCurrentCatalog(db, at);
      await expect(worker.refreshLibraryState()).resolves.toMatchObject({
        more: false,
      });
      db.prepare("DELETE FROM catalog_schema_additions WHERE name=?").run(
        LIBRARY_SCALE_ADDITION.name,
      );
      await expect(worker.refreshLibraryState()).rejects.toMatchObject({
        code: "catalog-addition-required",
        addition: LIBRARY_SCALE_ADDITION.name,
      });
    } finally {
      await worker.close();
      db.close();
    }
  });
});

it("installs the unresolved-issue index on the existing layout while old readers remain compatible", async () => {
  await catalogFixture(async (home, path) => {
    const db = new DatabaseSync(path);
    try {
      initializeCurrentCatalog(db, at);
      // Start from the layout before the three later additions.
      withoutDocumentTranslations(db);
      for (const sql of [...LIBRARY_TRASH_ADDITION.statements].reverse()) {
        const object = manifestObject(sql);
        db.exec(`DROP ${object.type.toUpperCase()} ${object.name}`);
      }
      db.exec("DROP INDEX archive_issues_unresolved");
      db.prepare(
        "DELETE FROM catalog_schema_additions WHERE name IN (?,?)",
      ).run(ARCHIVE_ISSUES_ADDITION.name, LIBRARY_TRASH_ADDITION.name);
      const previous = catalogConfigFor([LIBRARY_SCALE_ADDITION]);
      expect(readCatalogLayout(db, previous)?.extra_objects).toEqual([]);
      await expect(inspectCatalogSchema(path)).rejects.toMatchObject({
        reason: "catalog-addition-required",
        addition: ARCHIVE_ISSUES_ADDITION.name,
      });

      const applied = await runCli(
        [
          "storage",
          "schema-apply",
          "--catalog",
          path,
          "--addition",
          ARCHIVE_ISSUES_ADDITION.name,
        ],
        { home, stdout: () => {}, stderr: () => {} },
      );
      expect(applied).toMatchObject({
        code: 0,
        value: {
          name: ARCHIVE_ISSUES_ADDITION.name,
          ddl_fingerprint: ARCHIVE_ISSUES_ADDITION.ddl_fingerprint,
        },
      });
      expect(readCatalogLayout(db, previous)?.extra_objects).toEqual([
        { type: "index", name: "archive_issues_unresolved" },
      ]);
      await expect(inspectCatalogSchema(path)).rejects.toMatchObject({
        reason: "catalog-addition-required",
        addition: LIBRARY_TRASH_ADDITION.name,
      });
      expect(
        await runCli(
          [
            "storage",
            "schema-apply",
            "--catalog",
            path,
            "--addition",
            LIBRARY_TRASH_ADDITION.name,
          ],
          { home, stdout: () => {}, stderr: () => {} },
        ),
      ).toMatchObject({
        code: 0,
        value: { name: LIBRARY_TRASH_ADDITION.name },
      });
      await expect(inspectCatalogSchema(path)).rejects.toMatchObject({
        reason: "catalog-addition-required",
        addition: DOCUMENT_TRANSLATIONS_ADDITION.name,
      });
      expect(
        await runCli(
          [
            "storage",
            "schema-apply",
            "--catalog",
            path,
            "--addition",
            DOCUMENT_TRANSLATIONS_ADDITION.name,
          ],
          { home, stdout: () => {}, stderr: () => {} },
        ),
      ).toMatchObject({
        code: 0,
        value: { name: DOCUMENT_TRANSLATIONS_ADDITION.name },
      });
      await expect(inspectCatalogSchema(path)).resolves.toMatchObject({
        status: "ready",
        schema_fingerprint: SCHEMA_FINGERPRINT,
        additions: [
          {
            name: ARCHIVE_ISSUES_ADDITION.name,
            backfill_step: 0,
            backfill_cursor: null,
          },
          { name: DOCUMENT_TRANSLATIONS_ADDITION.name },
          { name: LIBRARY_SCALE_ADDITION.name },
          {
            name: LIBRARY_TRASH_ADDITION.name,
            backfill_step: 0,
            backfill_cursor: null,
          },
        ],
      });
    } finally {
      db.close();
    }
  });
});

it("keeps known DDL exact and refuses an incompatible or non-additive application atomically", async () => {
  await catalogFixture(async (home, path) => {
    const db = new DatabaseSync(path);
    try {
      initializeCurrentCatalog(db, at);
      const extra = "CREATE TABLE rejected_probe(note TEXT) STRICT";
      const trigger =
        "CREATE TRIGGER rejected_function AFTER INSERT ON reading_history BEGIN SELECT application_only(new.literature_id); END";
      await expect(
        applyCatalogAddition(
          path,
          defineCatalogAddition("invalid-function", [extra, trigger]),
        ),
      ).rejects.toMatchObject({ reason: "catalog-addition-invalid-trigger" });
      await expect(
        applyCatalogAddition(
          path,
          defineCatalogAddition(
            "non-additive",
            [
              extra,
              "ALTER TABLE reading_history RENAME COLUMN open_count TO changed",
            ],
            [extra],
          ),
        ),
      ).rejects.toMatchObject({ reason: "catalog-addition-not-additive" });
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_schema WHERE name IN ('rejected_probe','rejected_function')",
          )
          .all(),
      ).toEqual([]);
      expect(
        db
          .prepare("SELECT name FROM catalog_schema_additions ORDER BY name")
          .all(),
      ).toEqual([
        { name: ARCHIVE_ISSUES_ADDITION.name },
        { name: DOCUMENT_TRANSLATIONS_ADDITION.name },
        { name: LIBRARY_SCALE_ADDITION.name },
        { name: LIBRARY_TRASH_ADDITION.name },
      ]);

      db.prepare(
        "UPDATE catalog_schema_additions SET ddl_fingerprint=? WHERE name=?",
      ).run("e".repeat(64), LIBRARY_SCALE_ADDITION.name);
      await expect(inspectCatalogSchema(path)).rejects.toMatchObject({
        reason: "catalog-integrity-refused",
      });
      db.prepare(
        "UPDATE catalog_schema_additions SET ddl_fingerprint=? WHERE name=?",
      ).run(
        LIBRARY_SCALE_ADDITION.ddl_fingerprint,
        LIBRARY_SCALE_ADDITION.name,
      );
      db.exec(
        "ALTER TABLE reading_history ADD COLUMN unfillable TEXT NOT NULL",
      );
      await expect(inspectCatalogSchema(path)).rejects.toMatchObject({
        reason: "catalog-integrity-refused",
      });

      const errors: string[] = [];
      const cli = await runCli(
        [
          "storage",
          "schema-apply",
          "--catalog",
          path,
          "--addition",
          "undeclared",
        ],
        {
          home,
          stdout: () => {},
          stderr: (message) => errors.push(message),
        },
      );
      expect(cli.code).not.toBe(0);
      expect(JSON.parse(errors.join(""))).toMatchObject({
        reason: "catalog-addition-unknown",
      });
    } finally {
      db.close();
    }
  });
});

it("makes each backfill batch's results and cursor durable together", () => {
  const db = new DatabaseSync(":memory:");
  try {
    initializeCurrentCatalog(db, at);
    const addition = defineCatalogAddition(
      "test-runner",
      [],
      ["first", "second"],
    );
    registerCatalogAddition(db, addition, at);
    db.exec("CREATE TABLE backfill_output(value INTEGER); BEGIN IMMEDIATE");
    expect(() =>
      runCatalogBackfillBatch(db, addition, {
        first() {
          db.exec("INSERT INTO backfill_output(value) VALUES(1)");
          throw new Error("interrupted");
        },
      }),
    ).toThrow("interrupted");
    db.exec("ROLLBACK");
    expect(db.prepare("SELECT value FROM backfill_output").all()).toEqual([]);
    const write = (cursor: unknown) => {
      const value = Number(cursor ?? 0) + 1;
      db.prepare("INSERT INTO backfill_output(value) VALUES(?)").run(value);
      return { done: value === 2, cursor: value, value };
    };
    for (const value of [1, 2]) {
      db.exec("BEGIN IMMEDIATE");
      expect(runCatalogBackfillBatch(db, addition, { first: write })).toBe(
        value,
      );
      db.exec("COMMIT");
    }
    db.exec("BEGIN IMMEDIATE");
    expect(
      runCatalogBackfillBatch(db, addition, {
        second(cursor) {
          expect(cursor).toBeNull();
          db.exec("INSERT INTO backfill_output(value) VALUES(3)");
          return { done: true, cursor: null, value: 3 };
        },
      }),
    ).toBe(3);
    db.exec("COMMIT");
    expect(
      db
        .prepare(
          "SELECT backfill_step,backfill_cursor_json FROM catalog_schema_additions WHERE name=?",
        )
        .get(addition.name),
    ).toEqual({ backfill_step: 2, backfill_cursor_json: "null" });
    expect(
      db.prepare("SELECT value FROM backfill_output ORDER BY value").all(),
    ).toEqual([1, 2, 3].map((value) => ({ value })));
  } finally {
    db.close();
  }
});

function oldFacts(db: DatabaseSync) {
  const meta = db.prepare(
    "INSERT INTO meta_literatures(meta_literature_id,representative_literature_id) VALUES(?,?)",
  );
  const version = db.prepare(
    "INSERT INTO literatures(literature_id,meta_literature_id,version_role) VALUES(?,?,'published')",
  );
  const metadata = db.prepare(
    "INSERT INTO literature_metadata(literature_id,metadata_revision,metadata_sha256,title) VALUES(?,1,?,?)",
  );
  for (let n = 1; n <= 265; n++) {
    meta.run(id(1000 + n), id(n));
    version.run(id(n), id(1000 + n));
    metadata.run(id(n), "a".repeat(64), "Synthetic article " + n);
  }
  db.prepare(
    "UPDATE literatures SET meta_literature_id=? WHERE literature_id=?",
  ).run(id(1001), id(2));
  db.prepare("DELETE FROM meta_literatures WHERE meta_literature_id=?").run(
    id(1002),
  );
  db.prepare(
    "INSERT INTO folders(folder_id,parent_id,name,position,created_at,updated_at) VALUES('f',NULL,'Fixture',0,?,?)",
  ).run(at, at);
  db.prepare(
    "INSERT INTO folder_members(folder_id,literature_id,added_at,actor) VALUES('f',?,?,'local:cli')",
  ).run(id(2), at);
  db.prepare(
    "INSERT INTO intake_batches(batch_id,kind,default_label,origin,created_at,state,initiated_by,request_json) VALUES('import','import','Fixture','web',?,'running','local:web','{}')",
  ).run(at);
  db.prepare(
    "INSERT INTO intake_batch_members(batch_id,literature_id,disposition) VALUES('import',?,'matched')",
  ).run(id(3));
  db.prepare(
    "INSERT INTO intake_items(item_id,batch_id,origin,disposition,literature_id,created_at,decided_at) VALUES('page','import','page','matched',?,?,?)",
  ).run(id(4), at, at);
  db.prepare(
    "INSERT INTO intake_batch_members(batch_id,literature_id,disposition) VALUES('import',?,'matched')",
  ).run(id(4));
  db.prepare(
    "INSERT INTO reading_history(literature_id,last_opened_at,open_count) VALUES(?,?,1)",
  ).run(id(5), at);
  const change = db.prepare(
    "INSERT INTO tag_assignment_changes(change_id,literature_id,revision,actor,before_json,after_json,reason,created_at) VALUES(?,?,?,'manual',?,?,'fixture',?)",
  );
  const manual = JSON.stringify({
    items: [{ tag_id: id(9998), origin: "manual" }],
  });
  const automated = JSON.stringify({
    items: [{ tag_id: id(9999), origin: "auto" }],
  });
  change.run("first-tag", id(6), 1, null, manual, at);
  change.run("audited-tag", id(7), 2, automated, manual, at);
  change.run("merged-tag", id(8), 2, automated, manual, at);
  db.prepare(
    "INSERT INTO operation_records(operation_id,actor,operation,scope_json,result_json,status,created_at,finished_at) VALUES('assign','local:cli','tags',?,?,'completed',?,?)",
  ).run(
    JSON.stringify({ operation: "assign", request: { literature_id: id(7) } }),
    JSON.stringify({ revision: 2 }),
    at,
    at,
  );
  db.prepare(
    "INSERT INTO execution_jobs(job_id,target_kind,selector_json,policy_version,status,idempotency_key,created_at) VALUES('job','literature','{\"goal\":\"pdf\"}','v1','running','key',?)",
  ).run(at);
  db.prepare(
    "INSERT INTO execution_targets(target_id,job_id,ordinal,literature_id,stage) VALUES('target','job',0,?,'acquisition')",
  ).run(id(9));
  db.prepare(
    "INSERT INTO execution_attempts(attempt_id,target_id,stage,status,started_at) VALUES('attempt','target','acquisition','running',?)",
  ).run(at);
  db.prepare(
    "INSERT INTO discovery_runs(discovery_run_id,kind,status,started_at) VALUES('run','citation','COMPLETED',?)",
  ).run(at);
  db.exec(
    "INSERT INTO citation_discovery_inputs(discovery_run_id,kind,direction,max_depth,result_limit) VALUES('run','citation','references',1,1)",
  );
  db.prepare(
    "INSERT INTO discovery_results(discovery_run_id,meta_literature_id) VALUES('run',?)",
  ).run(id(1010));
  db.prepare(
    "INSERT INTO citation_discovery_causes(discovery_run_id,meta_literature_id,source_literature_id,target_literature_id,actual_literature_id,depth) VALUES('run',?,?,?,?,1)",
  ).run(id(1010), id(1), id(10), id(10));
}

it("commits only a completed slice at the deadline and resumes all projections", async () => {
  await catalogFixture(async (home, interrupted) => {
    const uninterrupted = join(home, "uninterrupted.sqlite");
    for (const path of [interrupted, uninterrupted]) {
      const db = new DatabaseSync(path);
      try {
        initializeCurrentCatalog(db, at);
        db.exec("BEGIN IMMEDIATE; PRAGMA defer_foreign_keys=ON");
        db.prepare(
          "UPDATE catalog_schema_additions SET backfill_step=0 WHERE name=?",
        ).run(LIBRARY_SCALE_ADDITION.name);
        oldFacts(db);
        db.prepare(
          "INSERT OR IGNORE INTO folder_members(folder_id,literature_id,added_at,actor) SELECT 'f',literature_id,?,'local:cli' FROM literatures LIMIT 90",
        ).run(at);
        db.exec("DELETE FROM library_ordered_members; COMMIT");
      } finally {
        db.close();
      }
    }

    const openState = (path: string) => {
      const db = new DatabaseSync(path);
      const state = new StoredLibraryState(db, settings);
      state.registerWrites();
      const batch = (deadline?: number) => {
        beginCatalogWrite(db);
        const result = state.refreshBatch(
          deadline === undefined
            ? undefined
            : () => performance.now() >= deadline,
        );
        commitCatalogWrite(db);
        return result;
      };
      return { db, batch };
    };
    const first = openState(interrupted);
    try {
      // The elapsed deadline admits one indivisible slice, then forces a commit.
      expect(first.batch(performance.now())).toMatchObject({
        rebuilt: 32,
        more: true,
      });
      expect(
        first.db.prepare("SELECT after_id FROM library_state_progress").get(),
      ).toEqual({ after_id: id(32) });
      const registry = first.db
        .prepare(
          "SELECT backfill_step,backfill_cursor_json FROM catalog_schema_additions WHERE name=?",
        )
        .get(LIBRARY_SCALE_ADDITION.name)!;
      expect(registry.backfill_step).toBe(0);
      expect(
        JSON.parse(String(registry.backfill_cursor_json)).state.after_id,
      ).toBe(id(32));
    } finally {
      first.db.close();
    }
    const resumed = openState(interrupted);
    const expected = openState(uninterrupted);
    try {
      while (resumed.batch(performance.now()).more) {
        // Each phase yields at the first completed slice.
      }
      while (expected.batch().more) {
        // Complete the same input with the original row budget.
      }
      for (const table of [
        "library_literature_states",
        "library_collected",
        "library_collection_times",
        "library_count_totals",
        "library_count_contributions",
        "library_ordered_members",
        "library_discovery_invalid",
        "library_discovery_replaced",
        "catalog_schema_additions",
      ]) {
        const rows = (db: DatabaseSync) =>
          db
            .prepare(`SELECT * FROM ${table}`)
            .all()
            .map((row) => JSON.stringify(row))
            .sort();
        expect(rows(resumed.db), table).toEqual(rows(expected.db));
      }
      expect(
        resumed.db
          .prepare(
            "SELECT count(*) AS n FROM library_ordered_members WHERE kind='folder'",
          )
          .get()?.n,
      ).toBe(90);
    } finally {
      resumed.db.close();
      expected.db.close();
    }
  });
});

it("repairs named writes from a connection that has no application functions or knowledge of the projections", async () => {
  await catalogFixture(async (home, oldPath) => {
    const currentPath = join(home, "current.sqlite");
    const old = new DatabaseSync(oldPath);
    const current = new DatabaseSync(currentPath);
    let worker: SqliteWorker | undefined;
    try {
      for (const db of [old, current]) {
        initializeCurrentCatalog(db, at);
        db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON");
        db.exec(
          "INSERT INTO library_state_progress(singleton,generation,max_tags,archive_profile,after_id,ready,collection_ready) VALUES(1,1,6,'vlm-engine','',0,0)",
        );
        db.prepare(
          "UPDATE catalog_schema_additions SET backfill_step=0 WHERE name=?",
        ).run(LIBRARY_SCALE_ADDITION.name);
      }
      old.exec("BEGIN IMMEDIATE; PRAGMA defer_foreign_keys=ON");
      oldFacts(old);
      old.exec("COMMIT");
      const state = new StoredLibraryState(current, settings);
      state.registerWrites();
      beginCatalogWrite(current);
      current.exec("PRAGMA defer_foreign_keys=ON");
      oldFacts(current);
      commitCatalogWrite(current);
      expect(
        old.prepare("SELECT 1 FROM library_state_dirty LIMIT 1").get(),
      ).toBeTruthy();
      expect(
        current
          .prepare(
            "SELECT 1 FROM library_literature_states WHERE literature_id=?",
          )
          .get(id(2)),
      ).toBeTruthy();

      worker = new SqliteWorker(oldPath);
      expect(await worker.refreshLibraryState()).toMatchObject({
        rebuilt: 256,
        more: true,
      });
      await worker.close();
      worker = new SqliteWorker(oldPath);
      const cursor = old
        .prepare(
          "SELECT backfill_step,backfill_cursor_json FROM catalog_schema_additions WHERE name=?",
        )
        .get(LIBRARY_SCALE_ADDITION.name)!;
      expect(cursor.backfill_step).toBe(0);
      expect(
        JSON.parse(String(cursor.backfill_cursor_json)).state.after_id,
      ).toBe(id(256));
      while ((await worker.refreshLibraryState()).more) {
        /* continue from durable cursor */
      }
      await worker.close();
      worker = new SqliteWorker(currentPath);
      while ((await worker.refreshLibraryState()).more) {
        /* finish baseline */
      }
      expect(
        old
          .prepare(
            "SELECT literature_id,collected_at FROM library_collection_times ORDER BY literature_id",
          )
          .all(),
      ).toEqual(
        [2, 3, 4, 5, 6, 7, 9].map((n) => ({
          literature_id: id(n),
          collected_at: at,
        })),
      );
      expect(
        old.prepare("SELECT count(*) AS n FROM library_ordered_members").get()
          ?.n,
      ).toBeGreaterThanOrEqual(3);
      for (const table of [
        "library_literature_states",
        "library_collected",
        "library_collection_times",
        "library_count_totals",
        "library_count_contributions",
        "library_ordered_members",
        "library_discovery_invalid",
        "library_discovery_replaced",
        "retrieval_changes",
      ]) {
        const dump = (db: DatabaseSync) =>
          db
            .prepare(`SELECT * FROM ${table}`)
            .all()
            .map((row) => JSON.stringify(row))
            .sort();
        expect(dump(old), table).toEqual(dump(current));
      }
      expect(old.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      await worker?.close();
      old.close();
      current.close();
    }
  });
});

it("cannot infer an old satisfied PDF request with no durable evidence but records a current request", async () => {
  const f = await libraryFullTextFixture();
  try {
    const base = new DatabaseCompletionService({
      library: f.app.library,
      database: f.app.database,
      writes: f.app.writes,
      completion: null,
      acquisition: {
        async acquire() {
          throw new Error("fixture should already have a PDF");
        },
      },
    });
    const request = {
      selector: {
        kind: "literatures" as const,
        literature_ids: [parseLiteratureId(id(2))],
      },
      goal: "ASSET_READY" as const,
    };
    const before = fullTextCatalogRows(f.home);
    const legacy = await base.run(request);
    expect(legacy.skipped[0]?.reason).toBe("already-satisfied");
    expect(fullTextCatalogRows(f.home)).toEqual(before);
    expect(await f.app.databaseCompletion!.run(request)).toEqual(legacy);
    const db = new DatabaseSync(join(f.home, "catalog.sqlite"), {
      readOnly: true,
    });
    try {
      expect(
        db
          .prepare(
            "SELECT literature_id FROM library_collected WHERE literature_id=?",
          )
          .get(id(2)),
      ).toEqual({ literature_id: id(2) });
    } finally {
      db.close();
    }
  } finally {
    await f.close();
  }
});
