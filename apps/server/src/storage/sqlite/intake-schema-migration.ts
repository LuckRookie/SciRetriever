import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { acquireCatalogWriteLock } from "../write-admission.js";
import { schemaTargetFile, schemaTargetPath } from "./schema-path.js";
import {
  offlineTableCounts,
  verifyOfflineLayout,
} from "./archive-schema-migration.js";
import {
  INTAKE_SCHEMA,
  SCHEMA_VERSION,
  SCHEMA_MANIFEST,
  SCHEMA_FINGERPRINT,
  SCHEMA_MANIFEST_V14,
  SCHEMA_FINGERPRINT_V14,
} from "./schema.js";
import { migrateKeywordLayers } from "./intake-metadata-migration.js";
import { readMetadataRow } from "./metadata-rows.js";
import { metadataIndexChunks } from "../../retrieval/index.js";
import {
  prepareRetrievalVocab,
  retrievalHashes,
  RETRIEVAL_CORRUPT,
} from "./retrieval-engine.js";

function refuse(): never {
  throw Object.assign(new Error("intake schema migration refused"), {
    code: "intake-schema-migration-refused",
  });
}
function backfillBatches(db: DatabaseSync) {
  const insert = db.prepare(
    "INSERT INTO intake_batches(batch_id,kind,default_label,label,origin,created_at,finished_at,status,request_json,discovery_run_id,rejected,source_failures,owner_pid) VALUES(?,?,?,NULL,'migration',?,?,?,?,?,0,?,NULL)",
  );
  for (const run of db
    .prepare(
      "SELECT * FROM discovery_runs ORDER BY started_at,discovery_run_id",
    )
    .all()) {
    const id = randomUUID(),
      kind = String(run.kind),
      runId = String(run.discovery_run_id);
    let label: string, request: Record<string, unknown>;
    if (kind === "topic") {
      const r = db
        .prepare(
          "SELECT query,year_from,year_to FROM topic_discovery_inputs WHERE discovery_run_id=?",
        )
        .get(runId)!;
      label = String(r.query);
      request = { ...r };
    } else {
      const seed = db
        .prepare(
          "SELECT s.literature_id,m.title FROM citation_discovery_seeds s JOIN literature_metadata m USING(literature_id) WHERE discovery_run_id=? ORDER BY seed_ordinal LIMIT 1",
        )
        .get(runId);
      const r = db
        .prepare(
          "SELECT direction FROM citation_discovery_inputs WHERE discovery_run_id=?",
        )
        .get(runId)!;
      label = `${seed?.title ?? seed?.literature_id ?? "citation"} · ${r.direction}`;
      request = {
        ...(seed &&
        Number(
          db
            .prepare(
              "SELECT count(*) n FROM citation_discovery_seeds WHERE discovery_run_id=?",
            )
            .get(runId)!.n,
        ) === 1
          ? { seed_literature_id: seed.literature_id }
          : {}),
        ...(r.direction === "both" ? {} : { direction: r.direction }),
      };
    }
    request.providers = db
      .prepare(
        "SELECT provider_name FROM discovery_run_providers WHERE discovery_run_id=? ORDER BY provider_ordinal",
      )
      .all(runId)
      .map((r) => r.provider_name);
    const failures = Number(
      db
        .prepare(
          "SELECT count(*) n FROM discovery_source_results WHERE discovery_run_id=? AND outcome<>'EXHAUSTED'",
        )
        .get(runId)!.n,
    );
    const status = String(run.status).toLowerCase();
    insert.run(
      id,
      kind,
      label,
      new Date(String(run.started_at)).toISOString(),
      null,
      status === "running" ? "interrupted" : status,
      JSON.stringify(request),
      runId,
      failures,
    );
    db.prepare(
      "INSERT INTO intake_batch_members SELECT ?,actual_literature_id,'matched' FROM (SELECT actual_literature_id FROM topic_discovery_causes WHERE discovery_run_id=? UNION SELECT actual_literature_id FROM citation_discovery_causes WHERE discovery_run_id=?)",
    ).run(id, runId, runId);
    // Older runs may only contain Meta results. Include each known version
    // without inventing a historical created/enriched distinction.
    db.prepare(
      "INSERT OR IGNORE INTO intake_batch_members SELECT ?,l.literature_id,'matched' FROM discovery_results r JOIN literatures l USING(meta_literature_id) WHERE r.discovery_run_id=? AND NOT EXISTS(SELECT 1 FROM topic_discovery_causes c WHERE c.discovery_run_id=r.discovery_run_id AND c.meta_literature_id=r.meta_literature_id) AND NOT EXISTS(SELECT 1 FROM citation_discovery_causes c WHERE c.discovery_run_id=r.discovery_run_id AND c.meta_literature_id=r.meta_literature_id)",
    ).run(id, runId);
  }
  const legacy = randomUUID();
  const earliest = db
    .prepare(
      "SELECT min(i.intake_at) at FROM literatures l LEFT JOIN literature_intake i USING(literature_id) WHERE NOT EXISTS(SELECT 1 FROM intake_batch_members b WHERE b.literature_id=l.literature_id)",
    )
    .get()!.at;
  const at = typeof earliest === "string" ? earliest : new Date().toISOString();
  insert.run(legacy, "legacy", "早期入库", at, at, "completed", "{}", null, 0);
  db.prepare(
    "INSERT INTO intake_batch_members SELECT ?,l.literature_id,'legacy' FROM literatures l WHERE NOT EXISTS(SELECT 1 FROM intake_batch_members b WHERE b.literature_id=l.literature_id)",
  ).run(legacy);
  return legacy;
}
async function updateIndex(db: DatabaseSync, originalRevision: number) {
  const active = db
    .prepare(
      "SELECT g.* FROM retrieval_generations g JOIN retrieval_active_generation a USING(generation_id)",
    )
    .get();
  if (
    active?.content_sha256 === RETRIEVAL_CORRUPT ||
    active?.posting_sha256 === RETRIEVAL_CORRUPT
  )
    refuse();
  if (!active && db.prepare("SELECT 1 FROM document_versions LIMIT 1").get())
    refuse();
  const generation = randomUUID();
  db.prepare(
    "INSERT INTO retrieval_generations VALUES(?,1,'markdown-context-v1',0,'building',0,0,0,NULL,NULL,?)",
  ).run(generation, new Date().toISOString());
  // A new generation invalidates even cursors from a previously stale input.
  // Fixed document evidence is copied without reopening immutable artifacts.
  if (active) {
    const rows = db
      .prepare(
        "SELECT e.*,f.title,f.body FROM retrieval_entries e JOIN retrieval_fts f ON f.rowid=e.entry_id WHERE e.generation_id=? AND e.kind='document' ORDER BY e.entry_id",
      )
      .all(active.generation_id!);
    const copy = db.prepare(
      "INSERT INTO retrieval_entries(generation_id,kind,literature_id,meta_literature_id,metadata_revision,metadata_sha256,document_version_id,representation_sha256,source_asset_id,source_asset_sha256,unit_start_utf8,unit_end_utf8,unit_sha256,section_id,unit_ordinal,is_default) VALUES(?,'document',?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    for (const r of rows) {
      const result = copy.run(
        generation,
        r.literature_id!,
        r.meta_literature_id!,
        r.metadata_revision!,
        r.metadata_sha256!,
        r.document_version_id!,
        r.representation_sha256!,
        r.source_asset_id!,
        r.source_asset_sha256!,
        r.unit_start_utf8!,
        r.unit_end_utf8!,
        r.unit_sha256!,
        r.section_id!,
        r.unit_ordinal!,
        r.is_default!,
      );
      db.prepare(
        "INSERT INTO retrieval_fts(rowid,title,body) VALUES(?,?,?)",
      ).run(result.lastInsertRowid, r.title!, r.body!);
    }
  }
  const entry = db.prepare(
    "INSERT INTO retrieval_entries(generation_id,kind,literature_id,meta_literature_id,metadata_revision,metadata_sha256,document_version_id,representation_sha256,source_asset_id,source_asset_sha256,unit_start_utf8,unit_end_utf8,unit_sha256,section_id,unit_ordinal,is_default) VALUES(?,'metadata',?,?,?,?,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,1)",
  );
  const text = db.prepare(
    "INSERT INTO retrieval_fts(rowid,title,body) VALUES(?,?,?)",
  );
  for (const row of db
    .prepare(
      "SELECT l.literature_id,l.meta_literature_id,m.metadata_revision,m.metadata_sha256 FROM literatures l JOIN literature_metadata m USING(literature_id) ORDER BY l.literature_id",
    )
    .all()) {
    const metadata = readMetadataRow(
      db,
      "literature",
      String(row.literature_id),
    );
    for await (const chunk of metadataIndexChunks(metadata)) {
      const id = entry.run(
        generation,
        row.literature_id!,
        row.meta_literature_id!,
        row.metadata_revision!,
        row.metadata_sha256!,
      ).lastInsertRowid;
      text.run(id, chunk.title, chunk.body);
    }
  }
  db.prepare(
    "UPDATE retrieval_entries AS e SET metadata_revision=m.metadata_revision,metadata_sha256=m.metadata_sha256 FROM literature_metadata m WHERE e.literature_id=m.literature_id AND e.generation_id=? AND e.kind='document'",
  ).run(generation);
  prepareRetrievalVocab(db);
  db.exec("INSERT INTO retrieval_fts(retrieval_fts) VALUES('integrity-check')");
  const hashes = retrievalHashes(db, generation);
  const caughtUp = !active || active.source_revision === originalRevision;
  const revision = Number(
    db
      .prepare(
        "SELECT revision FROM retrieval_source_revision WHERE singleton=1",
      )
      .get()!.revision,
  );
  db.prepare(
    "UPDATE retrieval_generations SET status='ready',source_revision=?,entry_count=(SELECT count(*) FROM retrieval_entries WHERE generation_id=?),fts_count=(SELECT count(*) FROM retrieval_entries WHERE generation_id=?),source_count=(SELECT count(DISTINCT literature_id) FROM retrieval_entries WHERE generation_id=? AND kind='metadata')+(SELECT count(DISTINCT document_version_id) FROM retrieval_entries WHERE generation_id=? AND kind='document'),content_sha256=?,posting_sha256=? WHERE generation_id=?",
  ).run(
    caughtUp ? revision : Number(active!.source_revision),
    generation,
    generation,
    generation,
    generation,
    hashes.content_sha256,
    hashes.posting_sha256,
    generation,
  );
  db.prepare(
    "INSERT INTO retrieval_active_generation VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET generation_id=excluded.generation_id",
  ).run(generation);
  return {
    generation_id: generation,
    metadata_updated: true,
    source_revision: revision,
    index_stale: !caughtUp,
  };
}
/** Explicit offline 14 -> 15, atomic DDL, keyword reprojection, cohort backfill and index refresh. */
export async function migrateIntakeSchema(path: string) {
  await schemaTargetPath(path);
  if (!(await schemaTargetFile(path))) refuse();
  const lock = await acquireCatalogWriteLock(path);
  let db: DatabaseSync | undefined;
  const start = performance.now();
  const timings_ms: Record<string, number> = {};
  let phaseAt = start;
  const mark = (phase: string) => {
    const now = performance.now();
    timings_ms[phase] = now - phaseAt;
    phaseAt = now;
  };
  try {
    db = new DatabaseSync(path);
    db.exec(
      "PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0; PRAGMA synchronous=FULL",
    );
    const identity = db.prepare("SELECT * FROM schema_identity").get();
    if (
      identity?.schema_version !== 14 ||
      identity.schema_fingerprint !== SCHEMA_FINGERPRINT_V14
    )
      refuse();
    verifyOfflineLayout(db, SCHEMA_MANIFEST_V14, refuse);
    mark("input_check");
    db.exec("BEGIN IMMEDIATE");
    try {
      if (
        db
          .prepare(
            "SELECT 1 FROM execution_jobs WHERE status IN ('queued','running') LIMIT 1",
          )
          .get() ||
        db
          .prepare("SELECT 1 FROM archive_runs WHERE state='running' LIMIT 1")
          .get()
      )
        refuse();
      const before = offlineTableCounts(db, refuse),
        revision = Number(
          db.prepare("SELECT revision FROM retrieval_source_revision").get()!
            .revision,
        );
      for (const sql of INTAKE_SCHEMA) db.exec(sql);
      const legacy_batch_id = backfillBatches(db);
      mark("ddl_and_batches");
      const projected = migrateKeywordLayers(db);
      mark("projection");
      const index = await updateIndex(db, revision);
      mark("index");
      db.exec(
        "CREATE TEMP TABLE intake_identity AS SELECT * FROM schema_identity; DROP TABLE schema_identity",
      );
      db.exec(
        SCHEMA_MANIFEST.find((sql) =>
          sql.startsWith("CREATE TABLE schema_identity("),
        )!,
      );
      db.prepare(
        "INSERT INTO schema_identity SELECT singleton,product,?,?,created_at FROM intake_identity",
      ).run(SCHEMA_VERSION, SCHEMA_FINGERPRINT);
      db.exec("DROP TABLE intake_identity");
      db.exec(
        "UPDATE library_state_revision SET full_revision=revision,tracked_revision=revision WHERE singleton=1",
      );
      const after = offlineTableCounts(db, refuse);
      for (const table of [
        "literatures",
        "meta_literatures",
        "metadata_observations",
        "provenances",
        "literature_metadata_observations",
        "assets",
        "literature_assets",
        "document_versions",
        "reading_marks",
        "discovery_runs",
      ])
        if (before[table] !== after[table]) refuse();
      verifyOfflineLayout(db, SCHEMA_MANIFEST, refuse);
      if (db.prepare("PRAGMA foreign_key_check").all().length) refuse();
      const legacy_hits = Number(
        db
          .prepare(
            "SELECT count(*) n FROM intake_batch_members WHERE batch_id=?",
          )
          .get(legacy_batch_id)!.n,
      );
      db.exec("COMMIT");
      mark("output_check_and_commit");
      return {
        timings_ms,
        from_version: 14,
        to_version: SCHEMA_VERSION,
        elapsed_ms: performance.now() - start,
        before,
        after,
        projected,
        legacy_batch_id,
        legacy_hits,
        index,
        foreign_key_violations: 0,
      };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db?.close();
    await lock.release();
  }
}
