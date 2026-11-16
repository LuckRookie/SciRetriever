import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CURRENT_CATALOG_CONFIG } from "../src/storage/sqlite/catalog-layout.js";
import {
  SCHEMA_MANIFEST_V14,
  SCHEMA_FINGERPRINT_V14,
  SCHEMA_VERSION,
} from "../src/storage/sqlite/schema.js";
import { migrateIntakeSchema } from "../src/storage/sqlite/intake-schema-migration.js";
import { migrateImportSchema } from "../src/storage/sqlite/import-schema-migration.js";
import { migrateDraftTextSchema } from "../src/storage/sqlite/draft-text-schema-migration.js";
import { migrateUserOrganizationSchema } from "../src/storage/sqlite/user-organization-schema-migration.js";
import { inspectCatalogSchema } from "../src/storage/sqlite/catalog-schema.js";
import { createQueryApplication } from "../src/bootstrap/application.js";
import { parseIntakeBatchPage } from "@sciretriever/contracts";
function v14(path: string) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys=ON;BEGIN");
  for (const sql of SCHEMA_MANIFEST_V14) db.exec(sql);
  db.prepare(
    "INSERT INTO schema_identity VALUES(1,'sciretriever',14,?,'2026-11-01T00:00:00.000Z')",
  ).run(SCHEMA_FINGERPRINT_V14);
  db.prepare("INSERT INTO execution_schema_identity VALUES(1,?,?)").run(
    CURRENT_CATALOG_CONFIG.execution_schema_version,
    CURRENT_CATALOG_CONFIG.execution_schema_fingerprint,
  );
  db.prepare("INSERT INTO execution_runtime_schema_identity VALUES(1,?,?)").run(
    CURRENT_CATALOG_CONFIG.execution_runtime_schema_version,
    CURRENT_CATALOG_CONFIG.execution_runtime_schema_fingerprint,
  );
  db.exec(
    "INSERT INTO retrieval_source_revision VALUES(1,0);INSERT INTO vocabulary_state VALUES(1,0,0);COMMIT",
  );
  return db;
}
it("migrates 14 to 15 with legacy and discovery cohorts, correct keyword layers, verified index and preserved source hashes", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-intake-migration-")),
    path = join(home, "catalog.sqlite");
  const ids = [randomUUID(), randomUUID()],
    run = randomUUID();
  try {
    const db = v14(path);
    db.exec("BEGIN");
    for (const [n, id] of ids.entries()) {
      const meta = randomUUID(),
        o = randomUUID(),
        p = randomUUID();
      db.prepare("INSERT INTO meta_literatures VALUES(?,?)").run(meta, id);
      db.prepare("INSERT INTO literatures VALUES(?,?,'published')").run(
        id,
        meta,
      );
      db.prepare(
        "INSERT INTO literature_metadata(literature_id,metadata_revision,metadata_sha256,title) VALUES(?,1,?,?)",
      ).run(id, "a".repeat(64), `Paper ${n}`);
      db.prepare(
        "INSERT INTO provenances VALUES(?,'metadata-provider',?,?,? ,?,NULL)",
      ).run(
        p,
        n === 0 ? "openalex" : "europe-pmc",
        `record${n}`,
        `2026-10-0${n + 1}T00:00:00.000Z`,
        "b".repeat(64),
      );
      db.prepare(
        "INSERT INTO metadata_observations(observation_id,provenance_id,title) VALUES(?,?,?)",
      ).run(o, p, `Paper ${n}`);
      db.prepare(
        "INSERT INTO literature_metadata_observations VALUES(?,?)",
      ).run(id, o);
      for (let k = 0; k < (n === 0 ? 10 : 2); k++) {
        db.prepare(
          "INSERT INTO metadata_observation_keywords VALUES(?,?,?)",
        ).run(o, k, `word${k}`);
        db.prepare(
          "INSERT INTO metadata_observation_declared_keywords VALUES(?,?,?)",
        ).run(o, k, `word${k}`);
      }
      if (n === 0) {
        db.prepare(
          "INSERT INTO discovery_runs VALUES(?,'topic','COMPLETED','2026-10-02T00:00:00.000Z')",
        ).run(run);
        db.prepare(
          "INSERT INTO topic_discovery_inputs VALUES(?,'topic','query',NULL,NULL)",
        ).run(run);
        db.prepare("INSERT INTO discovery_results VALUES(?,?)").run(run, meta);
        db.prepare("INSERT INTO topic_discovery_causes VALUES(?,?,?,?)").run(
          run,
          meta,
          o,
          id,
        );
      }
    }
    const sibling = randomUUID(),
      meta0 = db
        .prepare(
          "SELECT meta_literature_id FROM literatures WHERE literature_id=?",
        )
        .get(ids[0]!)!.meta_literature_id;
    db.prepare("INSERT INTO literatures VALUES(?,?,'preprint')").run(
      sibling,
      meta0!,
    );
    db.prepare(
      "INSERT INTO literature_metadata(literature_id,metadata_revision,metadata_sha256,title) VALUES(?,1,?,'Later sibling')",
    ).run(sibling, "a".repeat(64));
    db.exec("COMMIT");
    db.close();
    await expect(inspectCatalogSchema(path)).rejects.toMatchObject({
      reason: "catalog-layout-not-current",
    });
    const result = await migrateIntakeSchema(path);
    expect(result).toMatchObject({
      from_version: 14,
      to_version: 15,
      legacy_hits: 2,
      projected: 3,
      foreign_key_violations: 0,
      index: { index_stale: false, metadata_updated: true },
    });
    expect(result.after.literatures).toBe(3);
    expect(result.after.metadata_observation_keywords).toBe(2);
    expect(result.after.literature_metadata_keywords).toBe(2);
    expect(result.after.metadata_observation_subject_terms).toBe(8);
    expect(result.after.literature_metadata_subject_terms).toBe(8);
    const check = new DatabaseSync(path, { readOnly: true });
    expect(
      check.prepare("SELECT DISTINCT input_sha256 FROM provenances").all(),
    ).toEqual([{ input_sha256: "b".repeat(64) }]);
    expect(check.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      check.prepare("SELECT schema_version FROM schema_identity").get()!
        .schema_version,
    ).toBe(15);
    check.close();
    // Historical tools keep their own targets; current openers need the final step.
    expect((await migrateImportSchema(path)).to_version).toBe(16);
    expect((await migrateDraftTextSchema(path)).to_version).toBe(17);
    expect((await migrateUserOrganizationSchema(path)).to_version).toBe(
      SCHEMA_VERSION,
    );
    const app = await createQueryApplication(home);
    try {
      const page = parseIntakeBatchPage(
        await app.query!.intakeBatches({ operation: "list", request: {} }),
      );
      expect(page.items.find((b) => b.kind === "legacy")).toMatchObject({
        created_at: "2026-10-02T00:00:00.000Z",
        counts: { hits: 2, created: 0, enriched: 0, matched: 0 },
      });
      expect(
        page.items.find((b) => b.discovery_run_id === run)?.counts,
      ).toMatchObject({ hits: 1, matched: 1 });
      expect(
        (await app.query!.detail(ids[0]!)).literature.metadata,
      ).toMatchObject({
        keywords: [],
        subject_terms: Array.from({ length: 8 }, (_, n) => `word${n}`),
      });
      expect(
        (await app.query!.detail(ids[1]!)).literature.metadata.keywords,
      ).toEqual(["word0", "word1"]);
    } finally {
      await app.close();
    }
    await expect(migrateIntakeSchema(path)).rejects.toMatchObject({
      code: "intake-schema-migration-refused",
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
it("refuses queued work and tampered v14 layouts without changing source bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "sciretriever-intake-refuse-"));
  try {
    for (const kind of ["running", "tampered"]) {
      const path = join(root, `${kind}.sqlite`),
        db = v14(path);
      if (kind === "running")
        db.exec(
          "INSERT INTO execution_jobs VALUES('job','selector','{}','p','queued','key','2026-11-01T00:00:00Z',NULL)",
        );
      else db.exec("CREATE TABLE unknown(x TEXT)");
      db.close();
      const before = createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
      await expect(migrateIntakeSchema(path)).rejects.toMatchObject({
        code: "intake-schema-migration-refused",
      });
      expect(
        createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
      ).toBe(before);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
