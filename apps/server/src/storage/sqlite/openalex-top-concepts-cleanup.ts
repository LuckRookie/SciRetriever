import { DatabaseSync } from "node:sqlite";
import { acquireCatalogWriteLock } from "../write-admission.js";
import { schemaTargetFile, schemaTargetPath } from "./schema-path.js";
import {
  offlineTableCounts,
  verifyOfflineLayout,
} from "./archive-schema-migration.js";
import {
  SCHEMA_FINGERPRINT,
  SCHEMA_MANIFEST,
  SCHEMA_VERSION,
} from "./schema.js";
import { reprojectKeywordLayers } from "./intake-metadata-migration.js";

const TOP_CONCEPTS = [
  "Art",
  "Biology",
  "Business",
  "Chemistry",
  "Computer science",
  "Economics",
  "Engineering",
  "Environmental science",
  "Geography",
  "Geology",
  "History",
  "Materials science",
  "Mathematics",
  "Medicine",
  "Philosophy",
  "Physics",
  "Political science",
  "Psychology",
  "Sociology",
].map((name) => name.toLowerCase());
const TOP_PREDICATE = "lower(s.term) IN (SELECT value FROM json_each(?))";
const SOURCE_PREDICATE =
  "p.source_kind='metadata-provider' AND p.source_name='openalex'";

function refuse(): never {
  throw Object.assign(new Error("OpenAlex top concept cleanup refused"), {
    code: "openalex-top-concepts-cleanup-refused",
  });
}

/** Explicit offline maintenance only. No opener or Application invokes this function. */
export async function cleanupOpenAlexTopConcepts(path: string) {
  const started = performance.now();
  await schemaTargetPath(path);
  if (!(await schemaTargetFile(path))) refuse();
  const lock = await acquireCatalogWriteLock(path);
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path);
    db.exec(
      "PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0; PRAGMA synchronous=FULL",
    );
    db.exec("BEGIN IMMEDIATE");
    try {
      const identity = db.prepare("SELECT * FROM schema_identity").get();
      if (
        identity?.product !== "sciretriever" ||
        identity.schema_version !== 15 ||
        SCHEMA_VERSION !== 15 ||
        identity.schema_fingerprint !== SCHEMA_FINGERPRINT
      )
        refuse();
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
      verifyOfflineLayout(db, SCHEMA_MANIFEST, refuse);
      const before = offlineTableCounts(db, refuse);
      const names = JSON.stringify(TOP_CONCEPTS);
      const selected = db
        .prepare(
          `SELECT s.observation_id,count(*) AS removed FROM metadata_observation_subject_terms s JOIN metadata_observations o USING(observation_id) JOIN provenances p USING(provenance_id) WHERE ${SOURCE_PREDICATE} AND ${TOP_PREDICATE} GROUP BY s.observation_id ORDER BY s.observation_id`,
        )
        .all(names);
      const observationIds = JSON.stringify(
        selected.map((row) => String(row.observation_id)),
      );
      const literatureIds = db
        .prepare(
          "SELECT DISTINCT literature_id FROM literature_metadata_observations WHERE observation_id IN (SELECT value FROM json_each(?)) ORDER BY literature_id",
        )
        .all(observationIds)
        .map((row) => String(row.literature_id));
      const deleted = selected.reduce(
        (sum, row) => sum + Number(row.removed),
        0,
      );
      const revisionBefore = Number(
        db.prepare("SELECT revision FROM retrieval_source_revision").get()!
          .revision,
      );
      if (selected.length) {
        const remaining = db
          .prepare(
            `SELECT observation_id,term FROM metadata_observation_subject_terms s WHERE observation_id IN (SELECT value FROM json_each(?)) AND NOT (${TOP_PREDICATE}) ORDER BY observation_id,ordinal`,
          )
          .all(observationIds, names);
        db.prepare(
          "DELETE FROM metadata_observation_subject_terms WHERE observation_id IN (SELECT value FROM json_each(?))",
        ).run(observationIds);
        const insert = db.prepare(
          "INSERT INTO metadata_observation_subject_terms VALUES(?,?,?)",
        );
        let previous: string | null = null,
          ordinal = 0;
        for (const row of remaining) {
          const id = String(row.observation_id);
          if (id !== previous) {
            previous = id;
            ordinal = 0;
          }
          insert.run(id, ordinal++, row.term!);
        }
      }
      const reprojected = reprojectKeywordLayers(db, literatureIds);
      const affectedWithoutTerms = Number(
        db
          .prepare(
            "SELECT count(*) AS n FROM literature_metadata m WHERE m.literature_id IN (SELECT value FROM json_each(?)) AND NOT EXISTS(SELECT 1 FROM literature_metadata_subject_terms s WHERE s.literature_id=m.literature_id)",
          )
          .get(JSON.stringify(literatureIds))!.n,
      );
      const totalWithoutTerms = Number(
        db
          .prepare(
            "SELECT count(*) AS n FROM literature_metadata m WHERE NOT EXISTS(SELECT 1 FROM literature_metadata_subject_terms s WHERE s.literature_id=m.literature_id)",
          )
          .get()!.n,
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
        "intake_batches",
        "intake_batch_members",
      ])
        if (before[table] !== after[table]) refuse();
      if (
        before.metadata_observation_subject_terms! -
          after.metadata_observation_subject_terms! !==
        deleted
      )
        refuse();
      const foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
      const integrity = db
        .prepare("PRAGMA integrity_check")
        .all()
        .map((row) => String(row.integrity_check));
      if (foreignKeys.length || integrity.length !== 1 || integrity[0] !== "ok")
        refuse();
      db.exec(
        "INSERT INTO literature_search_fts(literature_search_fts) VALUES('integrity-check')",
      );
      const revisionAfter = Number(
        db.prepare("SELECT revision FROM retrieval_source_revision").get()!
          .revision,
      );
      const active = db
        .prepare(
          "SELECT g.source_revision FROM retrieval_generations g JOIN retrieval_active_generation a USING(generation_id)",
        )
        .get();
      db.exec("COMMIT");
      return {
        schema_version: SCHEMA_VERSION,
        before,
        after,
        deleted_observation_rows: deleted,
        affected_observations: selected.length,
        reprojected_literatures: reprojected,
        affected_without_subject_terms: affectedWithoutTerms,
        total_without_subject_terms: totalWithoutTerms,
        foreign_key_violations: foreignKeys.length,
        integrity_check: integrity,
        library_fts_integrity: "ok",
        source_revision_before: revisionBefore,
        source_revision_after: revisionAfter,
        indexed_revision: active ? Number(active.source_revision) : null,
        elapsed_ms: performance.now() - started,
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
