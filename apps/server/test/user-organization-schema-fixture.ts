import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  SCHEMA_MANIFEST_V17,
  SCHEMA_FINGERPRINT_V17,
} from "../src/storage/sqlite/schema.js";
import { CURRENT_CATALOG_CONFIG } from "../src/storage/sqlite/catalog-layout.js";
import { verifyOfflineLayout } from "../src/storage/sqlite/archive-schema-migration.js";
import { processorFixture } from "./processor-fixture.js";

export function emptyUserOrganizationInput(path: string) {
  const db = new DatabaseSync(path);
  db.exec("BEGIN");
  for (const sql of SCHEMA_MANIFEST_V17) db.exec(sql);
  db.prepare(
    "INSERT INTO schema_identity VALUES(1,'sciretriever',17,?,'2026-11-16T00:00:00Z')",
  ).run(SCHEMA_FINGERPRINT_V17);
  db.prepare("INSERT INTO execution_schema_identity VALUES(1,?,?)").run(
    CURRENT_CATALOG_CONFIG.execution_schema_version,
    CURRENT_CATALOG_CONFIG.execution_schema_fingerprint,
  );
  db.prepare("INSERT INTO execution_runtime_schema_identity VALUES(1,?,?)").run(
    CURRENT_CATALOG_CONFIG.execution_runtime_schema_version,
    CURRENT_CATALOG_CONFIG.execution_runtime_schema_fingerprint,
  );
  db.exec(
    "INSERT INTO retrieval_source_revision VALUES(1,0);INSERT INTO vocabulary_state VALUES(1,0,0);COMMIT;PRAGMA foreign_keys=ON",
  );
  return db;
}

/** All logical rows, including virtual FTS rowids, but never FTS shadow internals. */
export function organizationRows(db: DatabaseSync) {
  return Object.fromEntries(
    SCHEMA_MANIFEST_V17.flatMap((sql) => {
      const name = /^CREATE (?:VIRTUAL )?TABLE ([a-z_][a-z0-9_]*)/u.exec(
        sql,
      )?.[1];
      if (!name) return [];
      const columns = sql.startsWith("CREATE VIRTUAL TABLE ") ? "rowid,*" : "*";
      return [
        [
          name,
          db.prepare(`SELECT ${columns} FROM ${name} ORDER BY rowid`).all(),
        ],
      ];
    }),
  );
}

/** Build through real owners with fake parser/pages/model, then project onto frozen 17. */
export async function userOrganizationFixture() {
  const env = await processorFixture({ offline: true });
  try {
    const parsed = await env.app.documentProcessing.parseDocuments(
      env.rawParseRequest,
    );
    if (parsed.draft.status !== "formed")
      throw new Error("Synthetic draft missing");
    await env.build(env.parseRequest);
    const state = await env.app.processors!.runBatch({
      schema_version: 1,
      idempotency_key: "organization-migration",
      name: "Synthetic result",
      processor: { id: "summary", version: "2" },
      spec: {},
      inputs: [
        { kind: "literature", literature_id: env.parseRequest.literature_id },
      ],
    });
    if (state.failures.length) throw new Error(JSON.stringify(state.failures));
    const parent = (await env.app.folders.manage({
      operation: "create",
      request: { name: "Parent" },
    })) as { folder_id: string };
    const child = (await env.app.folders.manage({
      operation: "create",
      request: { name: "Child", parent_id: parent.folder_id },
    })) as { folder_id: string };
    await env.app.folders.manage({
      operation: "add",
      request: {
        folder_id: child.folder_id,
        literature_ids: [env.parseRequest.literature_id],
      },
    });
    await env.app.folders.opened({
      literature_id: env.parseRequest.literature_id,
    });
    for (let n = 0; n < 3; n++) {
      const mark = await env.app.marks.manage({
        operation: "create",
        request: {
          literature_id: env.parseRequest.literature_id,
          kind: n === 1 ? "highlight" : "region",
          color: "yellow",
          note: `Synthetic mark ${n}`,
          ...(n === 1
            ? {
                quote: "A synthetic finding.",
                document: {
                  document_version_id: parsed.draft.document_version_id,
                  start_utf8: 0,
                  end_utf8: 20,
                },
              }
            : {
                pdf: {
                  sha256: env.asset.sha256,
                  page: 1,
                  rects: [[0, 0, 10, 10]],
                },
              }),
        },
      });
      if (n === 2)
        await env.app.marks.manage({
          operation: "delete",
          request: { mark_id: mark.mark_id },
        });
    }
    await env.app.maintenance!.refreshIndex!();
    await env.app.close();
    const path = join(env.home, "frozen-v17.sqlite"),
      db = new DatabaseSync(path);
    try {
      db.prepare("ATTACH DATABASE ? AS fixture_source").run(
        join(env.home, "catalog.sqlite"),
      );
      db.exec("PRAGMA foreign_keys=OFF;BEGIN");
      for (const sql of SCHEMA_MANIFEST_V17)
        if (!sql.startsWith("CREATE TRIGGER ")) db.exec(sql);
      for (const sql of SCHEMA_MANIFEST_V17) {
        const table = /^CREATE (?:VIRTUAL )?TABLE ([a-z_][a-z0-9_]*)/u.exec(
          sql,
        )?.[1];
        if (!table) continue;
        if (table === "schema_identity") {
          db.prepare(
            "INSERT INTO schema_identity SELECT singleton,product,17,?,created_at FROM fixture_source.schema_identity",
          ).run(SCHEMA_FINGERPRINT_V17);
          continue;
        }
        const columns = db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .map((r) => String(r.name));
        const list =
          (sql.startsWith("CREATE VIRTUAL TABLE ") ? "rowid," : "") +
          columns.join(",");
        db.exec(
          `INSERT INTO ${table}(${list}) SELECT ${list} FROM fixture_source.${table}`,
        );
      }
      for (const sql of SCHEMA_MANIFEST_V17)
        if (sql.startsWith("CREATE TRIGGER ")) db.exec(sql);
      verifyOfflineLayout(db, SCHEMA_MANIFEST_V17);
      db.exec("COMMIT;DETACH DATABASE fixture_source;PRAGMA foreign_keys=ON");
      const rows = organizationRows(db);
      // Some result projections (e.g. unfound citations) are legally empty until
      // their publisher ships. Keep all tables in the snapshot, including those.
      const resultTables = Object.fromEntries(
        Object.entries(rows)
          .filter(([name]) => /processor_|result|collection/u.test(name))
          .map(([name, values]) => [
            name,
            {
              rows: values.length,
              empty_reason: values.length
                ? null
                : "No applicable result kind/projection in this summary fixture",
            },
          ]),
      );
      const assets = await Promise.all(
        db
          .prepare(
            "SELECT relative_path FROM artifact_objects ORDER BY relative_path",
          )
          .all()
          .map(async (r) => {
            const bytes = await readFile(
              join(env.home, "artifacts", String(r.relative_path)),
            );
            return [
              String(r.relative_path),
              createHash("sha256").update(bytes).digest("hex"),
            ] as const;
          }),
      );
      return {
        env,
        path,
        rows,
        assets,
        resultTables,
        close: () => env.close(),
      };
    } finally {
      db.close();
    }
  } catch (error) {
    await env.close();
    throw error;
  }
}
