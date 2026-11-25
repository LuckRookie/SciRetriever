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
  LIBRARY_STATE_INPUT_TABLES,
  CATALOG_BASE_SCHEMA,
  LIBRARY_SCALE_ADDITION,
  ARCHIVE_ISSUES_ADDITION,
  SCHEMA_FINGERPRINT,
  SCHEMA_MANIFEST,
  SCHEMA_MANIFEST_V16,
  SCHEMA_MANIFEST_V17,
  SCHEMA_MANIFEST_V18,
  SCHEMA_MANIFEST_V19,
  SCHEMA_FINGERPRINT_V19,
  SCHEMA_FINGERPRINT_V19_COUNTS,
  SCHEMA_FINGERPRINT_V19_COMBINED,
  SCHEMA_MANIFEST_V19_COUNTS,
  SCHEMA_MANIFEST_V19_COMBINED,
  RETRIEVAL_CHANGE_SCHEMA,
  SCHEMA_FINGERPRINT_V19_INTAKE_LOOKUPS,
  SCHEMA_FINGERPRINT_V19_RETRIEVAL_CHANGES,
  SCHEMA_MANIFEST_V19_RETRIEVAL_CHANGES,
  LIBRARY_STORED_STATE_SCHEMA,
  LIBRARY_COUNT_SCHEMA,
  SCHEMA_FINGERPRINT_V19_STORED_STATES,
  SCHEMA_MANIFEST_V19_STORED_STATES,
  SCHEMA_MANIFEST_V19_INTAKE_LOOKUPS,
  SCHEMA_FINGERPRINT_V18,
  SCHEMA_FINGERPRINT_V17,
  SCHEMA_FINGERPRINT_V16,
} from "../src/storage/sqlite/schema.js";
import { SqliteWorker } from "../src/storage/sqlite/worker.js";
import { runCli } from "../src/cli/main.js";
const digest = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
it("pins the frozen 16–19 manifests, current additive layout and version-specific checks", () => {
  expect(SCHEMA_VERSION).toBe(19);
  expect(SCHEMA_FINGERPRINT_V19).toBe(
    "a605840d3d19206f08551c2cb5b78199d5c4190b93673c9502d5fb412b1cd88c",
  );
  expect(SCHEMA_FINGERPRINT_V19_INTAKE_LOOKUPS).toBe(
    "9bab69bb545756269749bbba675478132a098f3bd19ddb6444f3de74b5a2cd38",
  );
  expect(SCHEMA_FINGERPRINT_V19_RETRIEVAL_CHANGES).toBe(
    "f0f568e9e772c847d76edac7cf61bbd561bf29247ee53722666d3f45b1ed761c",
  );
  expect(SCHEMA_FINGERPRINT_V19_STORED_STATES).toBe(
    "e1c89740d2a9ae211d99c5e914e60709863f3b03e47020e6a0ee51279ababc14",
  );
  expect(SCHEMA_FINGERPRINT_V19_COUNTS).toBe(
    "dda502a9c79b0f09255da30725a4294c1a1b793edfdd2c5edbe2eb8bb96a060c",
  );
  expect(SCHEMA_FINGERPRINT_V19_COMBINED).toBe(
    "14c693f06f287f426f3fde730f7b5743c9ec64d2304919272d1b1d2e51202952",
  );
  // The indexed archive_current_parts view belongs to the current base only.
  expect(SCHEMA_FINGERPRINT).toBe(
    "ce2c67b1c7465072a9fce1ab8799617c81c814377f42bd716a2c8442ce2db90f",
  );
  expect(SCHEMA_FINGERPRINT_V18).toBe(
    "a95b796f5f8dd69839748571476a8bcc0f3d38ed1547d8f8aab25c38b1e2d8cf",
  );
  expect(
    createHash("sha256")
      .update(JSON.stringify(SCHEMA_MANIFEST_V18))
      .digest("hex"),
  ).toBe(SCHEMA_FINGERPRINT_V18);
  expect(SCHEMA_MANIFEST_V19).toHaveLength(SCHEMA_MANIFEST_V18.length);
  expect(SCHEMA_MANIFEST_V19_RETRIEVAL_CHANGES).toEqual([
    ...SCHEMA_MANIFEST_V19_INTAKE_LOOKUPS,
    ...RETRIEVAL_CHANGE_SCHEMA,
  ]);
  expect(SCHEMA_MANIFEST_V19_STORED_STATES).toEqual([
    ...SCHEMA_MANIFEST_V19_RETRIEVAL_CHANGES,
    ...LIBRARY_STORED_STATE_SCHEMA,
  ]);
  expect(SCHEMA_MANIFEST_V19_COUNTS).toEqual([
    ...SCHEMA_MANIFEST_V19_STORED_STATES,
    ...LIBRARY_COUNT_SCHEMA,
  ]);
  expect(
    SCHEMA_MANIFEST_V19_COMBINED.slice(0, SCHEMA_MANIFEST_V19_COUNTS.length),
  ).toEqual(SCHEMA_MANIFEST_V19_COUNTS);
  expect(SCHEMA_FINGERPRINT_V17).toBe(
    "b8c82c83c57f6f4826e9ed8fdb4080942b1acc863b10581a45221abc3441de91",
  );
  expect(
    createHash("sha256")
      .update(JSON.stringify(SCHEMA_MANIFEST_V17))
      .digest("hex"),
  ).toBe(SCHEMA_FINGERPRINT_V17);
  expect(SCHEMA_MANIFEST_V19).toHaveLength(SCHEMA_MANIFEST_V17.length + 2);
  expect(SCHEMA_MANIFEST_V16).toHaveLength(378);
  expect(SCHEMA_FINGERPRINT_V16).toBe(
    "8545637a22c2341066427f71195eec5465e4c906f3dabd2c2cbad2a4c512f0f8",
  );
  expect(
    createHash("sha256")
      .update(JSON.stringify(CATALOG_BASE_SCHEMA))
      .digest("hex"),
  ).toBe(SCHEMA_FINGERPRINT);
  expect(
    createHash("sha256")
      .update(JSON.stringify(LIBRARY_SCALE_ADDITION.statements))
      .digest("hex"),
  ).toBe(LIBRARY_SCALE_ADDITION.ddl_fingerprint);
  expect(ARCHIVE_ISSUES_ADDITION.ddl_fingerprint).toBe(
    "979c4fef462150975fd66fdb107d585bf86574846ad3754d3e98969d23a9e919",
  );
  for (const name of ["saved_filters", "reading_mark_places"]) {
    expect(LIBRARY_STATE_INPUT_TABLES as readonly string[]).not.toContain(name);
    expect(
      SCHEMA_MANIFEST.some(
        (sql) =>
          sql.startsWith("CREATE TRIGGER ") && sql.includes(` ON ${name} `),
      ),
    ).toBe(false);
  }
  const db = new DatabaseSync(":memory:");
  try {
    initializeCurrentCatalog(db);
    for (const sql of SCHEMA_MANIFEST) {
      const name =
        /^CREATE (?:UNIQUE )?(?:VIRTUAL )?(?:TABLE|INDEX|TRIGGER|VIEW) ([a-z_][a-z0-9_]*)/u.exec(
          sql,
        )![1]!;
      expect(
        db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(name)!.sql,
        name,
      ).toBe(sql);
    }
    // Isolate CHECK/level constraints here; transaction tests use real complete FKs.
    db.exec("PRAGMA foreign_keys=OFF");
    const hash = "a".repeat(64);
    const v2 = {
      document_version_id: "corrected",
      document_id: "doc",
      schema_version: 2,
      literature_id: "paper",
      source_asset_id: "pdf",
      source_sha256: hash,
      source_byte_size: 1,
      source_media_type: "application/pdf",
      source_artifact_path: "originals/pdf/a.pdf",
      builder_version: "proofread-blocks-v1",
      locator_scheme: "utf8-segment-v1",
      representation_sha256: hash,
      markdown_artifact_path: "parsed/a.md",
      markdown_sha256: hash,
      markdown_byte_size: 1,
      markdown_media_type: "text/markdown",
      structure_artifact_path: "parsed/a.json",
      structure_sha256: hash,
      structure_byte_size: 1,
      structure_media_type: "application/json",
      proofread_id: "proofread",
      proofread_content_sha256: hash,
      created_at: "2026-11-15T00:00:00Z",
    };
    const v3 = {
      ...v2,
      document_version_id: "draft",
      representation_sha256: "b".repeat(64),
      schema_version: 3,
      proofread_id: null,
      proofread_content_sha256: null,
      builder_version: "draft-leaves-v1",
      raw_parse_id: "raw",
      raw_parse_result_sha256: hash,
      page_layer_sha256: hash,
      draft_method_sha256: hash,
      draft_content_artifact_path: "parsed/draft/content/a.json",
      draft_content_sha256: hash,
      draft_content_byte_size: 1,
      draft_content_media_type: "application/json",
    };
    const insert = (row: Record<string, string | number | null>) =>
      db
        .prepare(
          "INSERT INTO document_versions(" +
            Object.keys(row).join(",") +
            ") VALUES(" +
            Object.keys(row)
              .map(() => "?")
              .join(",") +
            ")",
        )
        .run(...Object.values(row));
    let n = 0;
    const invalid = (row: Record<string, string | number | null>) => {
      expect(() =>
        insert({ ...row, document_version_id: "invalid-" + ++n }),
      ).toThrow(/CHECK/u);
    };
    invalid({ ...v2, proofread_id: null });
    invalid({ ...v2, proofread_content_sha256: null });
    for (const key of [
      "raw_parse_id",
      "raw_parse_result_sha256",
      "page_layer_sha256",
      "draft_method_sha256",
      "draft_content_artifact_path",
      "draft_content_sha256",
      "draft_content_byte_size",
      "draft_content_media_type",
    ])
      invalid({ ...v3, [key]: null });
    invalid({ ...v2, raw_parse_id: "raw" });
    invalid({
      ...v3,
      proofread_id: "proofread",
      proofread_content_sha256: hash,
    });
    invalid({ ...v3, schema_version: 4 });
    invalid({ ...v3, page_layer_sha256: "A".repeat(64) });
    invalid({ ...v3, draft_content_byte_size: 0 });
    invalid({ ...v3, draft_content_media_type: "text/plain" });
    insert(v2);
    insert(v3);
    expect(() =>
      db.exec("INSERT INTO draft_version_facts VALUES('corrected',0,0,0)"),
    ).toThrow("draft version required");
    expect(() =>
      db.exec(
        "INSERT INTO draft_current VALUES('pdf','" + hash + "','corrected',1)",
      ),
    ).toThrow("draft version required");
    expect(() =>
      db.exec(
        "INSERT INTO processor_unfound_citations VALUES('result','record','/value','corrected')",
      ),
    ).toThrow("draft version required");
    db.exec("INSERT INTO draft_version_facts VALUES('draft',1,2,0)");
    expect(() =>
      db.exec("UPDATE draft_version_facts SET differences=2"),
    ).toThrow("draft version facts are immutable");
    expect(() =>
      db.exec("INSERT INTO draft_version_facts VALUES('missing',-1,0,0)"),
    ).toThrow();
  } finally {
    db.close();
  }
});
it("adds literature ownership from 18 onward while preserving the registration index and cascading batch FK", () => {
  const frozen = SCHEMA_MANIFEST_V17.find((sql) =>
    sql.startsWith("CREATE TABLE intake_batch_objects("),
  )!;
  expect(SCHEMA_MANIFEST_V16).toContain(frozen);
  expect(frozen).toContain(
    "object_kind IN ('folder','folder-member','literature-asset','mark')",
  );
  const db = new DatabaseSync(":memory:");
  try {
    initializeCurrentCatalog(db);
    db.exec("PRAGMA foreign_keys=ON");
    db.exec(
      "INSERT INTO intake_batches(batch_id,kind,default_label,origin,created_at,state,initiated_by,request_json) VALUES('batch','import','Synthetic','web','2026-11-17T00:00:00Z','running','local:web','{}')",
    );
    const insert = db.prepare(
      "INSERT INTO intake_batch_objects VALUES(?,?,'batch')",
    );
    for (const kind of [
      "literature",
      "folder",
      "folder-member",
      "literature-asset",
      "mark",
    ])
      insert.run(kind, kind);
    for (const kind of ["paper", "Literature", "", "other"])
      expect(() => insert.run(kind, kind)).toThrow(/CHECK/u);
    expect(() =>
      db.exec(
        "INSERT INTO intake_batch_objects VALUES('literature','missing','absent')",
      ),
    ).toThrow(/FOREIGN KEY/u);
    expect(
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE name='intake_batch_objects_batch'",
        )
        .get()!.sql,
    ).toBe(
      SCHEMA_MANIFEST_V17.find((sql) =>
        sql.startsWith("CREATE INDEX intake_batch_objects_batch "),
      ),
    );
    db.exec("DELETE FROM intake_batches WHERE batch_id='batch'");
    expect(db.prepare("SELECT * FROM intake_batch_objects").all()).toEqual([]);
  } finally {
    db.close();
  }
});
it("adds a nullable, closed display kind from 18 onward devices", () => {
  const frozen = SCHEMA_MANIFEST_V17.find((sql) =>
    sql.startsWith("CREATE TABLE device_connections("),
  )!;
  expect(frozen).not.toContain("kind TEXT");
  const db = new DatabaseSync(":memory:");
  try {
    initializeCurrentCatalog(db);
    expect(
      db
        .prepare("PRAGMA table_info(device_connections)")
        .all()
        .find((row) => row.name === "kind"),
    ).toMatchObject({ type: "TEXT", notnull: 0, dflt_value: null });
    const insert = db.prepare(
      "INSERT INTO device_connections(connection_id,name,purposes_json,created_at,kind) VALUES(?,'Synthetic','[\"read\"]','2026-11-17T00:00:00Z',?)",
    );
    for (const [n, kind] of [null, "extension", "agent"].entries())
      insert.run("valid-" + n, kind);
    db.exec(
      "INSERT INTO device_connections(connection_id,name,purposes_json,created_at) VALUES('omitted','Synthetic','[\"read\"]','2026-11-17T00:00:00Z')",
    );
    expect(
      db
        .prepare(
          "SELECT kind FROM device_connections WHERE connection_id='omitted'",
        )
        .get(),
    ).toEqual({ kind: null });
    for (const kind of ["browser", "", "Extension", 1])
      expect(() => insert.run("invalid", kind)).toThrow(/CHECK/u);
  } finally {
    db.close();
  }
});
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
        "saved_filters",
        "reading_mark_places",
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
    changed.exec(
      "DROP INDEX literature_intake_order; CREATE INDEX literature_intake_order ON literature_intake(intake_at ASC,literature_id ASC)",
    );
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
