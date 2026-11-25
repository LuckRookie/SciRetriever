import {
  LITERATURE_STATUSES,
  PROCESSOR_METHOD_REVISION,
} from "@sciretriever/contracts";
import { createHash } from "node:crypto";

const {
  CATALOG_ADDITIONS_DDL,
  defineCatalogAddition,
  manifestWithAdditions,
  nameCatalogInsertColumns,
}: typeof import("./catalog-ddl.js") = await import(
  new URL(
    import.meta.url.endsWith(".ts") ? "./catalog-ddl.ts" : "./catalog-ddl.js",
    import.meta.url,
  ).href
);

const {
  libraryPagingSchema,
  libraryTrashPagingTriggers,
}: typeof import("./library-paging-schema.js") = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./library-paging-schema.ts"
      : "./library-paging-schema.js",
    import.meta.url,
  ).href
);

const { DEFAULT_DOCUMENT_LEFT_JOIN }: typeof import("./document-defaults.js") =
  await import(
    new URL(
      import.meta.url.endsWith(".ts")
        ? "./document-defaults.ts"
        : "./document-defaults.js",
      import.meta.url,
    ).href
  );

// One current catalog layout. This is not a migration ladder or a list of supported historic layouts.
export const SCHEMA_VERSION = 19 as const;
// Inputs read by archiveStates/deriveCurrentState, including view dependencies.
// Reading history, folders and processing outputs do not invalidate this projection.
export const LIBRARY_STATE_INPUT_TABLES_V16 = [
  "literatures",
  "literature_metadata",
  "literature_metadata_authors",
  "literature_assets",
  "assets",
  "raw_parse_current",
  "raw_parse_pins",
  "raw_parses",
  "proofread_current",
  "proofread_versions",
  "proofread_manual_state",
  "document_defaults",
  "document_versions",
  "structure_annotation_current",
  "structure_annotations",
  "archive_runs",
  "execution_jobs",
  "archive_steps",
  "archive_issues",
  "literature_tag_items",
  "archive_description_heads",
] as const;
export const LIBRARY_STATE_INPUT_TABLES = [
  ...LIBRARY_STATE_INPUT_TABLES_V16,
  "draft_current",
  "draft_version_facts",
] as const;
const earliestIntake = (id: string) =>
  `(SELECT strftime('%Y-%m-%dT%H:%M:%fZ',min(julianday(p.observed_at))) FROM literature_metadata_observations lo JOIN metadata_observations o ON o.observation_id=lo.observation_id JOIN provenances p ON p.provenance_id=o.provenance_id WHERE lo.literature_id=${id})`;
/** Explicit offline backfill only; opening a catalog never applies it. */
export const LIBRARY_INTAKE_BACKFILL_SQL = `INSERT INTO literature_intake SELECT l.literature_id,${earliestIntake("l.literature_id")} FROM literatures l WHERE true ON CONFLICT(literature_id) DO UPDATE SET intake_at=excluded.intake_at`;
const stateOwners = (table: string, side: string): string | null => {
  if (["raw_parse_current", "raw_parses"].includes(table)) return null;
  if (table === "execution_jobs")
    return `SELECT DISTINCT literature_id FROM archive_runs WHERE job_id=${side}.job_id ORDER BY literature_id LIMIT 33`;
  if (
    [
      "document_defaults",
      "structure_annotation_current",
      "structure_annotations",
    ].includes(table)
  )
    return `SELECT literature_id FROM document_versions WHERE document_version_id=${side}.document_version_id`;
  const asset =
    table === "assets"
      ? `${side}.asset_id`
      : [
            "proofread_current",
            "proofread_versions",
            "proofread_manual_state",
          ].includes(table)
        ? `${side}.part_asset_id`
        : table === "raw_parse_pins"
          ? `(SELECT part_asset_id FROM proofread_versions WHERE proofread_id=${side}.proofread_id)`
          : null;
  return asset
    ? `SELECT DISTINCT literature_id FROM literature_assets WHERE asset_id=${asset} ORDER BY literature_id LIMIT 33`
    : `SELECT ${side}.literature_id AS literature_id`;
};
/** Only invalidation hints, never another source of readiness facts. */
export const LIBRARY_STATE_SCHEMA = [
  "CREATE TABLE library_state_revision(singleton INTEGER PRIMARY KEY CHECK(singleton=1),revision INTEGER NOT NULL CHECK(revision>=0),full_revision INTEGER NOT NULL DEFAULT 0 CHECK(full_revision>=0),tracked_revision INTEGER NOT NULL DEFAULT 0 CHECK(tracked_revision>=0)) STRICT",
  "CREATE TABLE library_state_changes(literature_id TEXT PRIMARY KEY CHECK(length(trim(literature_id))>0),revision INTEGER NOT NULL CHECK(revision>=0)) STRICT",
  "CREATE INDEX library_state_changes_revision ON library_state_changes(revision,literature_id)",
  "CREATE INDEX library_state_asset_owners ON literature_assets(asset_id,literature_id)",
  "CREATE INDEX library_state_job_owners ON archive_runs(job_id,literature_id)",
  ...["INSERT", "UPDATE"].map(
    (event) =>
      `CREATE TRIGGER library_state_revision_${event.toLowerCase()} AFTER ${event} ON library_state_revision WHEN NEW.revision<>NEW.tracked_revision BEGIN UPDATE library_state_revision SET full_revision=revision,tracked_revision=revision WHERE singleton=1; END`,
  ),
  ...LIBRARY_STATE_INPUT_TABLES_V16.flatMap((table) =>
    ["INSERT", "UPDATE", "DELETE"].map((event) => {
      const sides =
        event === "INSERT"
          ? ["NEW"]
          : event === "DELETE"
            ? ["OLD"]
            : ["OLD", "NEW"];
      const sources = sides.map((side) => stateOwners(table, side));
      const owners =
        sources.every((source) => source !== null) &&
        !(table === "literatures" && event === "UPDATE")
          ? sources
              .map((source) => `SELECT literature_id FROM (${source})`)
              .join(" UNION ")
          : null;
      const bump =
        "INSERT INTO library_state_revision(singleton,revision,tracked_revision) VALUES(1,1,1) ON CONFLICT(singleton) DO UPDATE SET revision=revision+1,tracked_revision=revision+1;";
      const invalidate = owners
        ? `UPDATE library_state_revision SET full_revision=revision WHERE singleton=1 AND (SELECT count(*) FROM (${owners})) NOT BETWEEN 1 AND 32; INSERT INTO library_state_changes SELECT literature_id,(SELECT revision FROM library_state_revision WHERE singleton=1) FROM (${owners}) WHERE (SELECT full_revision<revision FROM library_state_revision WHERE singleton=1) ON CONFLICT(literature_id) DO UPDATE SET revision=excluded.revision;`
        : "UPDATE library_state_revision SET full_revision=revision WHERE singleton=1;";
      return `CREATE TRIGGER library_state_${table}_${event.toLowerCase()} AFTER ${event} ON ${table} BEGIN ${bump} ${invalidate} END`;
    }),
  ),
] as const;
export const LIBRARY_PERFORMANCE_SCHEMA = [
  ...LIBRARY_STATE_SCHEMA,
  "CREATE TABLE literature_intake(literature_id TEXT PRIMARY KEY,intake_at TEXT,FOREIGN KEY(literature_id) REFERENCES literatures(literature_id) ON DELETE CASCADE ON UPDATE CASCADE) STRICT",
  "CREATE INDEX literature_intake_order ON literature_intake(intake_at DESC,literature_id ASC)",
  "CREATE TRIGGER literature_intake_create AFTER INSERT ON literatures BEGIN INSERT INTO literature_intake VALUES(NEW.literature_id,NULL); END",
  ...["INSERT", "UPDATE", "DELETE"].flatMap((event) => {
    const sides =
      event === "INSERT"
        ? ["NEW"]
        : event === "DELETE"
          ? ["OLD"]
          : ["OLD", "NEW"];
    return [
      "literature_metadata_observations",
      "metadata_observations",
      "provenances",
    ].map((table) => {
      const ids = sides
        .map((side) =>
          table === "literature_metadata_observations"
            ? `SELECT ${side}.literature_id`
            : table === "metadata_observations"
              ? `SELECT literature_id FROM literature_metadata_observations WHERE observation_id=${side}.observation_id`
              : `SELECT lo.literature_id FROM literature_metadata_observations lo JOIN metadata_observations o ON o.observation_id=lo.observation_id WHERE o.provenance_id=${side}.provenance_id`,
        )
        .join(" UNION ");
      return `CREATE TRIGGER literature_intake_${table}_${event.toLowerCase()} AFTER ${event} ON ${table} BEGIN UPDATE literature_intake SET intake_at=${earliestIntake("literature_intake.literature_id")} WHERE literature_id IN (${ids}); END`;
    });
  }),
] as const;

/** Frozen v13 layout: the 12 -> 13 migration target and the 13 -> 14 input. */
export const SCHEMA_MANIFEST_V13 = [
  "CREATE TABLE proofread_correction_cache(cache_key TEXT NOT NULL PRIMARY KEY CHECK(length(cache_key)=64),cache_id TEXT NOT NULL UNIQUE,artifact_reference TEXT NOT NULL,sha256 TEXT NOT NULL,byte_size INTEGER NOT NULL,media_type TEXT NOT NULL,FOREIGN KEY(artifact_reference,sha256,byte_size,media_type) REFERENCES artifact_objects(relative_path,sha256,byte_size,media_type) ON DELETE RESTRICT) STRICT",
  "CREATE TABLE schema_identity(singleton INTEGER NOT NULL PRIMARY KEY CHECK(singleton=1),product TEXT NOT NULL CHECK(product='sciretriever'),schema_version INTEGER NOT NULL CHECK(schema_version=13),schema_fingerprint TEXT NOT NULL CHECK(length(schema_fingerprint)=64 AND schema_fingerprint=lower(schema_fingerprint) AND schema_fingerprint NOT GLOB '*[^0-9a-f]*'),created_at TEXT NOT NULL CHECK(length(trim(created_at))>0)) STRICT",
  "CREATE TABLE artifact_objects(artifact_id TEXT NOT NULL PRIMARY KEY CHECK(length(trim(artifact_id))>0),sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256=lower(sha256) AND sha256 NOT GLOB '*[^0-9a-f]*'),byte_size INTEGER NOT NULL CHECK(typeof(byte_size)='integer' AND byte_size>0),media_type TEXT NOT NULL CHECK(length(trim(media_type))>0),relative_path TEXT NOT NULL UNIQUE CHECK(length(trim(relative_path))>0 AND relative_path NOT LIKE '/%' AND relative_path NOT LIKE '%\\\\%' AND relative_path NOT LIKE '%//%' AND relative_path NOT LIKE '../%' AND relative_path NOT LIKE '%/../%' AND relative_path NOT LIKE './%' AND relative_path NOT LIKE '%/./%' AND relative_path NOT IN ('.','..')) ,UNIQUE(sha256,byte_size),UNIQUE(relative_path,sha256,byte_size,media_type)) STRICT",
  "CREATE TABLE provenances(provenance_id TEXT NOT NULL PRIMARY KEY CHECK(length(trim(provenance_id))>0),source_kind TEXT NOT NULL CHECK(source_kind IN ('metadata-provider','asset-provider','parser','analysis','user')),source_name TEXT NOT NULL CHECK(length(trim(source_name))>0),source_record_id TEXT CHECK(source_record_id IS NULL OR length(trim(source_record_id))>0),observed_at TEXT NOT NULL CHECK(length(trim(observed_at))>0),input_sha256 TEXT CHECK(input_sha256 IS NULL OR (length(input_sha256)=64 AND input_sha256=lower(input_sha256) AND input_sha256 NOT GLOB '*[^0-9a-f]*')),parameters_sha256 TEXT CHECK(parameters_sha256 IS NULL OR (length(parameters_sha256)=64 AND parameters_sha256=lower(parameters_sha256) AND parameters_sha256 NOT GLOB '*[^0-9a-f]*'))) STRICT",
  "CREATE TABLE meta_literatures(meta_literature_id TEXT NOT NULL PRIMARY KEY CHECK(length(trim(meta_literature_id))>0),representative_literature_id TEXT NOT NULL,FOREIGN KEY(meta_literature_id,representative_literature_id) REFERENCES literatures(meta_literature_id,literature_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED) STRICT",
  "CREATE TABLE literatures(literature_id TEXT NOT NULL PRIMARY KEY CHECK(length(trim(literature_id))>0),meta_literature_id TEXT NOT NULL,version_role TEXT NOT NULL CHECK(version_role IN ('published','accepted-manuscript','preprint','other')),UNIQUE(meta_literature_id,literature_id),FOREIGN KEY(meta_literature_id) REFERENCES meta_literatures(meta_literature_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED) STRICT",
  "CREATE TABLE literature_metadata(literature_id TEXT NOT NULL PRIMARY KEY,metadata_revision INTEGER NOT NULL CHECK(typeof(metadata_revision)='integer' AND metadata_revision>=1),metadata_sha256 TEXT NOT NULL CHECK(length(metadata_sha256)=64 AND metadata_sha256=lower(metadata_sha256) AND metadata_sha256 NOT GLOB '*[^0-9a-f]*'),title TEXT,abstract TEXT,publication_date TEXT,publication_year INTEGER,publication_form TEXT CHECK(publication_form IS NULL OR publication_form IN ('journal-article','conference-paper','book-or-chapter','thesis','patent','report-or-standard','dataset')),article_kind TEXT CHECK(article_kind IS NULL OR article_kind IN ('research-article','review','letter-or-communication','perspective-or-commentary','correction-or-editorial')),language TEXT,venue TEXT,publisher TEXT,volume TEXT,issue TEXT,pages TEXT,UNIQUE(literature_id,metadata_revision,metadata_sha256),FOREIGN KEY(literature_id) REFERENCES literatures(literature_id) ON DELETE CASCADE,CHECK(publication_year IS NULL OR (typeof(publication_year)='integer' AND publication_year BETWEEN 1 AND 9999))) STRICT",
  "CREATE TABLE literature_metadata_authors(literature_id TEXT NOT NULL,ordinal INTEGER NOT NULL CHECK(typeof(ordinal)='integer' AND ordinal>=0),kind TEXT NOT NULL CHECK(kind IN ('person','organization','unknown')),display_name TEXT NOT NULL CHECK(length(trim(display_name))>0),given_name TEXT,family_name TEXT,orcid TEXT,PRIMARY KEY(literature_id,ordinal),FOREIGN KEY(literature_id) REFERENCES literature_metadata(literature_id) ON DELETE CASCADE) STRICT",
  "CREATE TABLE literature_metadata_author_affiliations(literature_id TEXT NOT NULL,author_ordinal INTEGER NOT NULL CHECK(author_ordinal>=0),affiliation_ordinal INTEGER NOT NULL CHECK(affiliation_ordinal>=0),name TEXT NOT NULL CHECK(length(trim(name))>0),ror TEXT,PRIMARY KEY(literature_id,author_ordinal,affiliation_ordinal),FOREIGN KEY(literature_id,author_ordinal) REFERENCES literature_metadata_authors(literature_id,ordinal) ON DELETE CASCADE) STRICT",
  "CREATE TABLE literature_metadata_identifiers(literature_id TEXT NOT NULL,ordinal INTEGER NOT NULL CHECK(ordinal>=0),namespace TEXT NOT NULL CHECK(length(trim(namespace))>0),value TEXT NOT NULL CHECK(length(trim(value))>0),PRIMARY KEY(literature_id,namespace,value),UNIQUE(literature_id,ordinal),FOREIGN KEY(literature_id) REFERENCES literature_metadata(literature_id) ON DELETE CASCADE) STRICT",
  "CREATE TABLE literature_metadata_keywords(literature_id TEXT NOT NULL,ordinal INTEGER NOT NULL CHECK(ordinal>=0),keyword TEXT NOT NULL CHECK(length(trim(keyword))>0),PRIMARY KEY(literature_id,keyword),UNIQUE(literature_id,ordinal),FOREIGN KEY(literature_id) REFERENCES literature_metadata(literature_id) ON DELETE CASCADE) STRICT",
  "CREATE TABLE literature_fallback_identity_indexes(literature_id TEXT NOT NULL PRIMARY KEY,fallback_identity_sha256 TEXT NOT NULL CHECK(length(fallback_identity_sha256)=64 AND fallback_identity_sha256=lower(fallback_identity_sha256) AND fallback_identity_sha256 NOT GLOB '*[^0-9a-f]*'),FOREIGN KEY(literature_id) REFERENCES literatures(literature_id) ON DELETE CASCADE) STRICT",
  "CREATE TABLE metadata_observations(observation_id TEXT NOT NULL PRIMARY KEY CHECK(length(trim(observation_id))>0),provenance_id TEXT NOT NULL,version_role TEXT,reference_count INTEGER,cited_by_count INTEGER,title TEXT,abstract TEXT,publication_date TEXT,publication_year INTEGER,source_type TEXT,source_type_mapping_version TEXT,publication_form TEXT CHECK(publication_form IS NULL OR publication_form IN ('journal-article','conference-paper','book-or-chapter','thesis','patent','report-or-standard','dataset')),article_kind TEXT CHECK(article_kind IS NULL OR article_kind IN ('research-article','review','letter-or-communication','perspective-or-commentary','correction-or-editorial')),language TEXT,venue TEXT,publisher TEXT,volume TEXT,issue TEXT,pages TEXT,CHECK(version_role IS NULL OR version_role IN ('published','accepted-manuscript','preprint','other')),CHECK(reference_count IS NULL OR (typeof(reference_count)='integer' AND reference_count>=0)),CHECK(cited_by_count IS NULL OR (typeof(cited_by_count)='integer' AND cited_by_count>=0)),CHECK(publication_year IS NULL OR (typeof(publication_year)='integer' AND publication_year BETWEEN 1 AND 9999)),FOREIGN KEY(provenance_id) REFERENCES provenances(provenance_id) ON DELETE RESTRICT) STRICT",
  "CREATE TABLE metadata_observation_authors(observation_id TEXT NOT NULL,ordinal INTEGER NOT NULL CHECK(ordinal>=0),kind TEXT NOT NULL CHECK(kind IN ('person','organization','unknown')),display_name TEXT NOT NULL CHECK(length(trim(display_name))>0),given_name TEXT,family_name TEXT,orcid TEXT,PRIMARY KEY(observation_id,ordinal),FOREIGN KEY(observation_id) REFERENCES metadata_observations(observation_id) ON DELETE CASCADE) STRICT",
  "CREATE TABLE metadata_observation_author_affiliations(observation_id TEXT NOT NULL,author_ordinal INTEGER NOT NULL CHECK(author_ordinal>=0),affiliation_ordinal INTEGER NOT NULL CHECK(affiliation_ordinal>=0),name TEXT NOT NULL CHECK(length(trim(name))>0),ror TEXT,PRIMARY KEY(observation_id,author_ordinal,affiliation_ordinal),FOREIGN KEY(observation_id,author_ordinal) REFERENCES metadata_observation_authors(observation_id,ordinal) ON DELETE CASCADE) STRICT",
  "CREATE TABLE metadata_observation_identifiers(observation_id TEXT NOT NULL,ordinal INTEGER NOT NULL CHECK(ordinal>=0),namespace TEXT NOT NULL CHECK(length(trim(namespace))>0),value TEXT NOT NULL CHECK(length(trim(value))>0),PRIMARY KEY(observation_id,namespace,value),UNIQUE(observation_id,ordinal),FOREIGN KEY(observation_id) REFERENCES metadata_observations(observation_id) ON DELETE CASCADE) STRICT",
  "CREATE TABLE metadata_observation_keywords(observation_id TEXT NOT NULL,ordinal INTEGER NOT NULL CHECK(ordinal>=0),keyword TEXT NOT NULL CHECK(length(trim(keyword))>0),PRIMARY KEY(observation_id,keyword),UNIQUE(observation_id,ordinal),FOREIGN KEY(observation_id) REFERENCES metadata_observations(observation_id) ON DELETE CASCADE) STRICT",
  "CREATE TABLE metadata_observation_declared_keywords(observation_id TEXT NOT NULL,ordinal INTEGER NOT NULL CHECK(ordinal>=0),keyword TEXT NOT NULL CHECK(length(trim(keyword))>0),PRIMARY KEY(observation_id,ordinal),FOREIGN KEY(observation_id) REFERENCES metadata_observations(observation_id) ON DELETE CASCADE) STRICT",
  "CREATE TABLE metadata_observation_reference_texts(observation_id TEXT NOT NULL,reference_index INTEGER NOT NULL CHECK(reference_index>=0),reference_text TEXT NOT NULL CHECK(length(trim(reference_text))>0),PRIMARY KEY(observation_id,reference_index),FOREIGN KEY(observation_id) REFERENCES metadata_observations(observation_id) ON DELETE CASCADE) STRICT",
  "CREATE TABLE metadata_observation_asset_hints(observation_id TEXT NOT NULL,hint_ordinal INTEGER NOT NULL CHECK(hint_ordinal>=0),url TEXT NOT NULL CHECK(length(trim(url))>0),kind TEXT NOT NULL CHECK(kind IN ('direct-file','landing-page')),media_type TEXT,asset_role TEXT CHECK(asset_role IS NULL OR asset_role IN ('primary-pdf','supplementary-pdf','xml','html','supplementary')),version_role TEXT CHECK(version_role IS NULL OR version_role IN ('published','accepted-manuscript','preprint','other')),access_status TEXT,license TEXT,PRIMARY KEY(observation_id,hint_ordinal),FOREIGN KEY(observation_id) REFERENCES metadata_observations(observation_id) ON DELETE CASCADE) STRICT",
  "CREATE TABLE metadata_observation_version_links(observation_id TEXT NOT NULL,link_ordinal INTEGER NOT NULL CHECK(link_ordinal>=0),record_id TEXT,PRIMARY KEY(observation_id,link_ordinal),CHECK(record_id IS NULL OR length(trim(record_id))>0),FOREIGN KEY(observation_id) REFERENCES metadata_observations(observation_id) ON DELETE CASCADE) STRICT",
  "CREATE TABLE metadata_observation_version_link_identifiers(observation_id TEXT NOT NULL,link_ordinal INTEGER NOT NULL,ordinal INTEGER NOT NULL CHECK(ordinal>=0),namespace TEXT NOT NULL CHECK(length(trim(namespace))>0),value TEXT NOT NULL CHECK(length(trim(value))>0),PRIMARY KEY(observation_id,link_ordinal,namespace,value),UNIQUE(observation_id,link_ordinal,ordinal),FOREIGN KEY(observation_id,link_ordinal) REFERENCES metadata_observation_version_links(observation_id,link_ordinal) ON DELETE CASCADE) STRICT",
  "CREATE TABLE literature_metadata_observations(literature_id TEXT NOT NULL,observation_id TEXT NOT NULL UNIQUE,PRIMARY KEY(literature_id,observation_id),FOREIGN KEY(literature_id) REFERENCES literatures(literature_id) ON DELETE CASCADE,FOREIGN KEY(observation_id) REFERENCES metadata_observations(observation_id) ON DELETE RESTRICT) STRICT",
  "CREATE TABLE user_observation_semantic_indexes(observation_id TEXT NOT NULL PRIMARY KEY,semantic_sha256 TEXT NOT NULL CHECK(length(semantic_sha256)=64 AND semantic_sha256=lower(semantic_sha256) AND semantic_sha256 NOT GLOB '*[^0-9a-f]*'),FOREIGN KEY(observation_id) REFERENCES metadata_observations(observation_id) ON DELETE CASCADE) STRICT",
  "CREATE TABLE provider_relation_observations(observation_id TEXT NOT NULL PRIMARY KEY CHECK(length(trim(observation_id))>0),provenance_id TEXT NOT NULL,FOREIGN KEY(provenance_id) REFERENCES provenances(provenance_id) ON DELETE RESTRICT) STRICT",
  "CREATE TABLE provider_relation_endpoints(observation_id TEXT NOT NULL,endpoint_kind TEXT NOT NULL CHECK(endpoint_kind IN ('citing','cited')),record_id TEXT,CHECK(record_id IS NULL OR length(trim(record_id))>0),PRIMARY KEY(observation_id,endpoint_kind),FOREIGN KEY(observation_id) REFERENCES provider_relation_observations(observation_id) ON DELETE CASCADE) STRICT",
  "CREATE TABLE provider_relation_endpoint_identifiers(observation_id TEXT NOT NULL,endpoint_kind TEXT NOT NULL,ordinal INTEGER NOT NULL CHECK(ordinal>=0),namespace TEXT NOT NULL CHECK(length(trim(namespace))>0),value TEXT NOT NULL CHECK(length(trim(value))>0),PRIMARY KEY(observation_id,endpoint_kind,namespace,value),UNIQUE(observation_id,endpoint_kind,ordinal),FOREIGN KEY(observation_id,endpoint_kind) REFERENCES provider_relation_endpoints(observation_id,endpoint_kind) ON DELETE CASCADE) STRICT",
  "CREATE TABLE literature_references(reference_id TEXT NOT NULL PRIMARY KEY CHECK(length(trim(reference_id))>0),source_literature_id TEXT NOT NULL,target_literature_id TEXT NOT NULL,CHECK(source_literature_id<>target_literature_id),UNIQUE(source_literature_id,target_literature_id),FOREIGN KEY(source_literature_id) REFERENCES literatures(literature_id) ON DELETE RESTRICT,FOREIGN KEY(target_literature_id) REFERENCES literatures(literature_id) ON DELETE RESTRICT) STRICT",
  "CREATE TABLE provider_relation_reference_supports(reference_id TEXT NOT NULL,observation_id TEXT NOT NULL,PRIMARY KEY(reference_id,observation_id),FOREIGN KEY(reference_id) REFERENCES literature_references(reference_id) ON DELETE RESTRICT,FOREIGN KEY(observation_id) REFERENCES provider_relation_observations(observation_id) ON DELETE RESTRICT) STRICT",
  "CREATE TABLE metadata_reference_text_supports(reference_id TEXT NOT NULL,metadata_observation_id TEXT NOT NULL,reference_index INTEGER NOT NULL CHECK(reference_index>=0),PRIMARY KEY(reference_id,metadata_observation_id,reference_index),FOREIGN KEY(reference_id) REFERENCES literature_references(reference_id) ON DELETE RESTRICT,FOREIGN KEY(metadata_observation_id,reference_index) REFERENCES metadata_observation_reference_texts(observation_id,reference_index) ON DELETE RESTRICT) STRICT",
  "CREATE TABLE assets(asset_id TEXT NOT NULL PRIMARY KEY CHECK(length(trim(asset_id))>0),sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256=lower(sha256) AND sha256 NOT GLOB '*[^0-9a-f]*'),size_bytes INTEGER NOT NULL CHECK(typeof(size_bytes)='integer' AND size_bytes>0),media_type TEXT NOT NULL CHECK(length(trim(media_type))>0),relative_path TEXT NOT NULL UNIQUE,UNIQUE(asset_id,sha256),UNIQUE(sha256,size_bytes),FOREIGN KEY(relative_path,sha256,size_bytes,media_type) REFERENCES artifact_objects(relative_path,sha256,byte_size,media_type) ON DELETE RESTRICT) STRICT",
  "CREATE TABLE literature_assets(literature_asset_id TEXT NOT NULL PRIMARY KEY CHECK(length(trim(literature_asset_id))>0),literature_id TEXT NOT NULL,asset_id TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('primary-pdf','supplementary-pdf','xml','html','supplementary')),provenance_id TEXT NOT NULL,source_url TEXT,UNIQUE(literature_id,asset_id,role),FOREIGN KEY(literature_id) REFERENCES literatures(literature_id) ON DELETE CASCADE,FOREIGN KEY(asset_id) REFERENCES assets(asset_id) ON DELETE RESTRICT,FOREIGN KEY(provenance_id) REFERENCES provenances(provenance_id) ON DELETE RESTRICT) STRICT",
  "CREATE TABLE automatic_pdf_acquisition_exhaustions(literature_id TEXT NOT NULL PRIMARY KEY,FOREIGN KEY(literature_id) REFERENCES literatures(literature_id) ON DELETE CASCADE) STRICT",
  "CREATE VIRTUAL TABLE literature_search_fts USING fts5(literature_id UNINDEXED,title,abstract,authors,affiliations,identifiers,keywords,venue,publisher,volume,issue,pages,content_body,tokenize='unicode61')",
  "CREATE INDEX literature_metadata_identifier_lookup ON literature_metadata_identifiers(namespace,value,literature_id)",
  "CREATE INDEX literature_fallback_identity_lookup ON literature_fallback_identity_indexes(fallback_identity_sha256,literature_id)",
  "CREATE INDEX metadata_observation_identifier_lookup ON metadata_observation_identifiers(namespace,value,observation_id)",
  "CREATE INDEX metadata_observation_provenance_lookup ON metadata_observations(provenance_id,observation_id)",
  "CREATE INDEX provenance_provider_record_lookup ON provenances(source_kind,source_name,source_record_id,provenance_id) WHERE source_kind='metadata-provider' AND source_record_id IS NOT NULL",
  "CREATE INDEX user_observation_semantic_lookup ON user_observation_semantic_indexes(semantic_sha256,observation_id)",
  "CREATE UNIQUE INDEX one_primary_pdf_per_literature ON literature_assets(literature_id) WHERE role='primary-pdf'",
  "CREATE INDEX literature_reference_source_lookup ON literature_references(source_literature_id,target_literature_id,reference_id)",
  "CREATE INDEX literature_reference_target_lookup ON literature_references(target_literature_id,source_literature_id,reference_id)",
  "CREATE TABLE discovery_runs(discovery_run_id TEXT NOT NULL PRIMARY KEY CHECK(length(trim(discovery_run_id))>0),kind TEXT NOT NULL CHECK(kind IN ('topic','citation')),status TEXT NOT NULL CHECK(status IN ('RUNNING','COMPLETED','PARTIAL','FAILED','INTERRUPTED')),started_at TEXT NOT NULL CHECK(length(trim(started_at))>0),UNIQUE(discovery_run_id,kind)) STRICT",
  "CREATE TABLE topic_discovery_inputs(discovery_run_id TEXT NOT NULL PRIMARY KEY,kind TEXT NOT NULL CHECK(kind='topic'),query TEXT NOT NULL CHECK(length(trim(query))>0),year_from INTEGER,year_to INTEGER,CHECK(year_from IS NULL OR (typeof(year_from)='integer' AND year_from BETWEEN 1 AND 9999)),CHECK(year_to IS NULL OR (typeof(year_to)='integer' AND year_to BETWEEN 1 AND 9999)),CHECK(year_from IS NULL OR year_to IS NULL OR year_from<=year_to),FOREIGN KEY(discovery_run_id,kind) REFERENCES discovery_runs(discovery_run_id,kind) ON DELETE RESTRICT) STRICT",
  "CREATE TABLE citation_discovery_inputs(discovery_run_id TEXT NOT NULL PRIMARY KEY,kind TEXT NOT NULL CHECK(kind='citation'),direction TEXT NOT NULL CHECK(direction IN ('references','cited-by','both')),max_depth INTEGER NOT NULL CHECK(typeof(max_depth)='integer' AND max_depth>=0),result_limit INTEGER NOT NULL CHECK(typeof(result_limit)='integer' AND result_limit>=1),FOREIGN KEY(discovery_run_id,kind) REFERENCES discovery_runs(discovery_run_id,kind) ON DELETE RESTRICT) STRICT",
  "CREATE TABLE citation_discovery_seeds(discovery_run_id TEXT NOT NULL,seed_ordinal INTEGER NOT NULL CHECK(typeof(seed_ordinal)='integer' AND seed_ordinal>=0),literature_id TEXT NOT NULL,PRIMARY KEY(discovery_run_id,seed_ordinal),UNIQUE(discovery_run_id,literature_id),FOREIGN KEY(discovery_run_id) REFERENCES citation_discovery_inputs(discovery_run_id) ON DELETE RESTRICT,FOREIGN KEY(literature_id) REFERENCES literatures(literature_id) ON DELETE RESTRICT) STRICT",
  "CREATE TABLE discovery_run_providers(discovery_run_id TEXT NOT NULL,provider_ordinal INTEGER NOT NULL CHECK(typeof(provider_ordinal)='integer' AND provider_ordinal>=0),provider_name TEXT NOT NULL CHECK(length(trim(provider_name))>0),scan_limit INTEGER NOT NULL CHECK(typeof(scan_limit)='integer' AND scan_limit>=1),PRIMARY KEY(discovery_run_id,provider_ordinal),UNIQUE(discovery_run_id,provider_name),FOREIGN KEY(discovery_run_id) REFERENCES discovery_runs(discovery_run_id) ON DELETE RESTRICT) STRICT",
  "CREATE TABLE discovery_source_results(discovery_run_id TEXT NOT NULL,provider_name TEXT NOT NULL,outcome TEXT NOT NULL CHECK(outcome IN ('EXHAUSTED','SCAN_LIMIT_REACHED','FAILED')),failure_code TEXT,failure_reason TEXT,failure_action TEXT,failure_retryable INTEGER,PRIMARY KEY(discovery_run_id,provider_name),CHECK(failure_code IS NULL OR length(trim(failure_code))>0),CHECK(failure_reason IS NULL OR length(trim(failure_reason))>0),CHECK(failure_action IS NULL OR length(trim(failure_action))>0),CHECK(failure_retryable IS NULL OR (typeof(failure_retryable)='integer' AND failure_retryable IN (0,1))),CHECK((outcome='FAILED' AND failure_code IS NOT NULL AND failure_reason IS NOT NULL AND failure_action IS NOT NULL AND failure_retryable IS NOT NULL) OR (outcome<>'FAILED' AND failure_code IS NULL AND failure_reason IS NULL AND failure_action IS NULL AND failure_retryable IS NULL)),FOREIGN KEY(discovery_run_id,provider_name) REFERENCES discovery_run_providers(discovery_run_id,provider_name) ON DELETE RESTRICT) STRICT",
  "CREATE TABLE discovery_results(discovery_run_id TEXT NOT NULL,meta_literature_id TEXT NOT NULL,PRIMARY KEY(discovery_run_id,meta_literature_id),FOREIGN KEY(discovery_run_id) REFERENCES discovery_runs(discovery_run_id) ON DELETE RESTRICT,FOREIGN KEY(meta_literature_id) REFERENCES meta_literatures(meta_literature_id) ON DELETE RESTRICT) STRICT",
  "CREATE TABLE topic_discovery_causes(discovery_run_id TEXT NOT NULL,meta_literature_id TEXT NOT NULL,metadata_observation_id TEXT NOT NULL,actual_literature_id TEXT NOT NULL,PRIMARY KEY(discovery_run_id,meta_literature_id,metadata_observation_id),UNIQUE(discovery_run_id,metadata_observation_id),FOREIGN KEY(discovery_run_id) REFERENCES topic_discovery_inputs(discovery_run_id) ON DELETE RESTRICT,FOREIGN KEY(discovery_run_id,meta_literature_id) REFERENCES discovery_results(discovery_run_id,meta_literature_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,FOREIGN KEY(actual_literature_id,metadata_observation_id) REFERENCES literature_metadata_observations(literature_id,observation_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,FOREIGN KEY(meta_literature_id,actual_literature_id) REFERENCES literatures(meta_literature_id,literature_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED) STRICT",
  "CREATE TABLE citation_discovery_causes(discovery_run_id TEXT NOT NULL,meta_literature_id TEXT NOT NULL,source_literature_id TEXT NOT NULL,target_literature_id TEXT NOT NULL,actual_literature_id TEXT NOT NULL,depth INTEGER NOT NULL CHECK(typeof(depth)='integer' AND depth>=1),CHECK(source_literature_id<>target_literature_id),CHECK(actual_literature_id IN (source_literature_id,target_literature_id)),PRIMARY KEY(discovery_run_id,meta_literature_id,source_literature_id,target_literature_id,depth),UNIQUE(discovery_run_id,source_literature_id,target_literature_id,depth),FOREIGN KEY(discovery_run_id) REFERENCES citation_discovery_inputs(discovery_run_id) ON DELETE RESTRICT,FOREIGN KEY(discovery_run_id,meta_literature_id) REFERENCES discovery_results(discovery_run_id,meta_literature_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,FOREIGN KEY(source_literature_id) REFERENCES literatures(literature_id) ON DELETE RESTRICT,FOREIGN KEY(target_literature_id) REFERENCES literatures(literature_id) ON DELETE RESTRICT,FOREIGN KEY(meta_literature_id,actual_literature_id) REFERENCES literatures(meta_literature_id,literature_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED) STRICT",
  "CREATE INDEX discovery_run_status_lookup ON discovery_runs(status,started_at,discovery_run_id)",
  "CREATE INDEX citation_discovery_seed_literature_lookup ON citation_discovery_seeds(literature_id,discovery_run_id,seed_ordinal)",
  "CREATE INDEX discovery_result_meta_lookup ON discovery_results(meta_literature_id,discovery_run_id)",
  "CREATE INDEX topic_discovery_cause_observation_lookup ON topic_discovery_causes(metadata_observation_id,actual_literature_id,discovery_run_id,meta_literature_id)",
  "CREATE INDEX citation_discovery_cause_source_lookup ON citation_discovery_causes(source_literature_id,discovery_run_id,meta_literature_id,depth,target_literature_id)",
  "CREATE INDEX citation_discovery_cause_target_lookup ON citation_discovery_causes(target_literature_id,discovery_run_id,meta_literature_id,depth,source_literature_id)",
  "CREATE TRIGGER topic_discovery_cause_insert_closure BEFORE INSERT ON topic_discovery_causes WHEN NOT EXISTS(SELECT 1 FROM literature_metadata_observations AS ownership JOIN literatures AS literature ON literature.literature_id=ownership.literature_id WHERE ownership.observation_id=NEW.metadata_observation_id AND ownership.literature_id=NEW.actual_literature_id AND literature.meta_literature_id=NEW.meta_literature_id) BEGIN SELECT RAISE(ABORT,'invalid topic discovery cause closure'); END",
  "CREATE TRIGGER topic_discovery_cause_update_identity BEFORE UPDATE ON topic_discovery_causes WHEN NEW.discovery_run_id IS NOT OLD.discovery_run_id OR NEW.metadata_observation_id IS NOT OLD.metadata_observation_id BEGIN SELECT RAISE(ABORT,'topic discovery cause identity is immutable'); END",
  "CREATE TRIGGER citation_discovery_cause_insert_closure BEFORE INSERT ON citation_discovery_causes WHEN NEW.actual_literature_id NOT IN (NEW.source_literature_id,NEW.target_literature_id) OR NOT EXISTS(SELECT 1 FROM literatures AS literature WHERE literature.literature_id=NEW.actual_literature_id AND literature.meta_literature_id=NEW.meta_literature_id) BEGIN SELECT RAISE(ABORT,'invalid citation discovery cause closure'); END",
  "CREATE TRIGGER citation_discovery_cause_update_identity BEFORE UPDATE ON citation_discovery_causes WHEN NEW.discovery_run_id IS NOT OLD.discovery_run_id OR NEW.source_literature_id IS NOT OLD.source_literature_id OR NEW.target_literature_id IS NOT OLD.target_literature_id OR NEW.actual_literature_id IS NOT OLD.actual_literature_id OR NEW.depth IS NOT OLD.depth BEGIN SELECT RAISE(ABORT,'citation discovery cause identity is immutable'); END",
  "CREATE TABLE execution_schema_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, fingerprint TEXT NOT NULL) STRICT",
  "CREATE TABLE execution_candidates(transfer_id TEXT PRIMARY KEY, record_json TEXT NOT NULL CHECK(json_valid(record_json))) STRICT",
  "CREATE TABLE execution_receipts(receipt_id TEXT PRIMARY KEY, transfer_id TEXT NOT NULL REFERENCES execution_candidates(transfer_id), intent_json TEXT NOT NULL CHECK(json_valid(intent_json)), result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json))) STRICT",
  "CREATE TABLE execution_runtime_schema_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64)) STRICT",
  "CREATE TABLE execution_jobs(job_id TEXT PRIMARY KEY CHECK(length(trim(job_id))>0), target_kind TEXT NOT NULL CHECK(target_kind IN ('literature','selector','discovery')), selector_json TEXT NOT NULL CHECK(json_valid(selector_json)), policy_version TEXT NOT NULL CHECK(length(trim(policy_version))>0), status TEXT NOT NULL CHECK(status IN ('queued','running','paused','cancelled','completed','failed','interrupted')), idempotency_key TEXT NOT NULL UNIQUE CHECK(length(trim(idempotency_key))>0), created_at TEXT NOT NULL, finished_at TEXT) STRICT",
  "CREATE TABLE execution_budgets(job_id TEXT PRIMARY KEY, max_attempts INTEGER NOT NULL CHECK(typeof(max_attempts)='integer' AND max_attempts BETWEEN 1 AND 100000), max_network_bytes INTEGER NOT NULL CHECK(typeof(max_network_bytes)='integer' AND max_network_bytes BETWEEN 1 AND 1099511627776), max_model_calls INTEGER NOT NULL CHECK(typeof(max_model_calls)='integer' AND max_model_calls BETWEEN 0 AND 100000), used_attempts INTEGER NOT NULL CHECK(typeof(used_attempts)='integer' AND used_attempts>=0 AND used_attempts<=max_attempts), used_network_bytes INTEGER NOT NULL CHECK(typeof(used_network_bytes)='integer' AND used_network_bytes>=0 AND used_network_bytes<=max_network_bytes), used_model_calls INTEGER NOT NULL CHECK(typeof(used_model_calls)='integer' AND used_model_calls>=0 AND used_model_calls<=max_model_calls), updated_at TEXT NOT NULL, FOREIGN KEY(job_id) REFERENCES execution_jobs(job_id) ON DELETE CASCADE) STRICT",
  "CREATE TABLE execution_targets(target_id TEXT PRIMARY KEY CHECK(length(trim(target_id))>0), job_id TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK(typeof(ordinal)='integer' AND ordinal>=0), literature_id TEXT, version_role TEXT CHECK(version_role IS NULL OR version_role IN ('published','accepted-manuscript','preprint','other')), stage TEXT NOT NULL CHECK(stage IN ('queued','acquisition','parsing','analysis','literature','completed','failed','skipped','interrupted')), disposition TEXT CHECK(disposition IS NULL OR disposition IN ('pending','completed','failed','skipped','interrupted')), next_eligible_at TEXT, UNIQUE(job_id,ordinal), FOREIGN KEY(job_id) REFERENCES execution_jobs(job_id) ON DELETE CASCADE, FOREIGN KEY(literature_id) REFERENCES literatures(literature_id) ON DELETE RESTRICT) STRICT",
  "CREATE TABLE execution_policy_snapshots(policy_version TEXT PRIMARY KEY CHECK(length(trim(policy_version))>0), policy_sha256 TEXT NOT NULL CHECK(length(policy_sha256)=64 AND policy_sha256=lower(policy_sha256) AND policy_sha256 NOT GLOB '*[^0-9a-f]*'), policy_json TEXT NOT NULL CHECK(json_valid(policy_json)), frozen_at TEXT NOT NULL) STRICT",
  "CREATE TABLE execution_attempts(attempt_id TEXT PRIMARY KEY CHECK(length(trim(attempt_id))>0), target_id TEXT NOT NULL, stage TEXT NOT NULL CHECK(stage IN ('acquisition','parsing','analysis','literature')), status TEXT NOT NULL CHECK(status IN ('running','completed','failed','interrupted','unknown')), started_at TEXT NOT NULL, finished_at TEXT, failure_code TEXT, failure_reason TEXT, failure_action TEXT, failure_retryable INTEGER CHECK(failure_retryable IS NULL OR failure_retryable IN (0,1)), usage_json TEXT CHECK(usage_json IS NULL OR json_valid(usage_json)), FOREIGN KEY(target_id) REFERENCES execution_targets(target_id) ON DELETE CASCADE) STRICT",
  "CREATE TABLE execution_events(event_id TEXT PRIMARY KEY CHECK(length(trim(event_id))>0), job_id TEXT NOT NULL, sequence INTEGER NOT NULL CHECK(typeof(sequence)='integer' AND sequence>=0), kind TEXT NOT NULL CHECK(length(trim(kind))>0), payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), created_at TEXT NOT NULL, UNIQUE(job_id,sequence), FOREIGN KEY(job_id) REFERENCES execution_jobs(job_id) ON DELETE CASCADE) STRICT",
  "CREATE TABLE execution_interventions(intervention_id TEXT PRIMARY KEY CHECK(length(trim(intervention_id))>0), job_id TEXT NOT NULL, target_id TEXT, mode TEXT NOT NULL CHECK(mode IN ('never','notify','pause')), status TEXT NOT NULL CHECK(status IN ('open','resolved','expired','declined')), failure_json TEXT NOT NULL CHECK(json_valid(failure_json) AND length(failure_json)<=16384), created_at TEXT NOT NULL, expires_at TEXT NOT NULL, resolved_at TEXT, resolution_json TEXT CHECK(resolution_json IS NULL OR (json_valid(resolution_json) AND length(resolution_json)<=16384)), FOREIGN KEY(job_id) REFERENCES execution_jobs(job_id) ON DELETE CASCADE, FOREIGN KEY(target_id) REFERENCES execution_targets(target_id) ON DELETE CASCADE) STRICT",
  "CREATE TABLE execution_leases(lease_id TEXT PRIMARY KEY CHECK(length(trim(lease_id))>0), job_id TEXT NOT NULL, workspace_id TEXT, boot_id TEXT NOT NULL, control_epoch INTEGER NOT NULL CHECK(typeof(control_epoch)='integer' AND control_epoch>=0), acquired_at TEXT NOT NULL, released_at TEXT, FOREIGN KEY(job_id) REFERENCES execution_jobs(job_id) ON DELETE CASCADE) STRICT",
  "CREATE UNIQUE INDEX execution_workspace_active_lease ON execution_leases(workspace_id) WHERE workspace_id IS NOT NULL AND released_at IS NULL",
  "CREATE TABLE document_versions(document_version_id TEXT NOT NULL PRIMARY KEY CHECK(length(trim(document_version_id))>0),document_id TEXT NOT NULL CHECK(length(trim(document_id))>0),schema_version INTEGER NOT NULL CHECK(schema_version=2),literature_id TEXT NOT NULL,source_asset_id TEXT NOT NULL,source_sha256 TEXT NOT NULL CHECK(length(source_sha256)=64 AND source_sha256=lower(source_sha256) AND source_sha256 NOT GLOB '*[^0-9a-f]*'),source_byte_size INTEGER NOT NULL CHECK(source_byte_size>0),source_media_type TEXT NOT NULL CHECK(length(trim(source_media_type))>0),source_artifact_path TEXT NOT NULL,builder_version TEXT NOT NULL CHECK(length(trim(builder_version))>0),locator_scheme TEXT NOT NULL CHECK(length(trim(locator_scheme))>0),representation_sha256 TEXT NOT NULL CHECK(length(representation_sha256)=64 AND representation_sha256=lower(representation_sha256) AND representation_sha256 NOT GLOB '*[^0-9a-f]*'),markdown_artifact_path TEXT NOT NULL,markdown_sha256 TEXT NOT NULL CHECK(length(markdown_sha256)=64 AND markdown_sha256=lower(markdown_sha256) AND markdown_sha256 NOT GLOB '*[^0-9a-f]*'),markdown_byte_size INTEGER NOT NULL CHECK(markdown_byte_size>0),markdown_media_type TEXT NOT NULL CHECK(markdown_media_type='text/markdown'),structure_artifact_path TEXT NOT NULL,structure_sha256 TEXT NOT NULL CHECK(length(structure_sha256)=64 AND structure_sha256=lower(structure_sha256) AND structure_sha256 NOT GLOB '*[^0-9a-f]*'),structure_byte_size INTEGER NOT NULL CHECK(structure_byte_size>0),structure_media_type TEXT NOT NULL CHECK(structure_media_type='application/json'),proofread_id TEXT NOT NULL,proofread_content_sha256 TEXT NOT NULL,created_at TEXT NOT NULL CHECK(length(trim(created_at))>0),FOREIGN KEY(proofread_id,proofread_content_sha256) REFERENCES proofread_versions(proofread_id,content_sha256) ON DELETE RESTRICT,UNIQUE(document_id,representation_sha256),UNIQUE(document_id,document_version_id),UNIQUE(document_version_id,representation_sha256),FOREIGN KEY(literature_id) REFERENCES literatures(literature_id) ON DELETE RESTRICT,FOREIGN KEY(source_asset_id,source_sha256) REFERENCES assets(asset_id,sha256) ON DELETE RESTRICT,FOREIGN KEY(source_artifact_path,source_sha256,source_byte_size,source_media_type) REFERENCES artifact_objects(relative_path,sha256,byte_size,media_type) ON DELETE RESTRICT,FOREIGN KEY(markdown_artifact_path,markdown_sha256,markdown_byte_size,markdown_media_type) REFERENCES artifact_objects(relative_path,sha256,byte_size,media_type) ON DELETE RESTRICT,FOREIGN KEY(structure_artifact_path,structure_sha256,structure_byte_size,structure_media_type) REFERENCES artifact_objects(relative_path,sha256,byte_size,media_type) ON DELETE RESTRICT) STRICT",
  "CREATE TABLE document_version_resources(document_version_id TEXT NOT NULL,ordinal INTEGER NOT NULL CHECK(ordinal>=0),resource_id TEXT NOT NULL CHECK(length(trim(resource_id))>0),reference TEXT NOT NULL CHECK(length(trim(reference))>0),relation TEXT NOT NULL CHECK(relation IN ('image','table-source','supplement','other')),artifact_path TEXT NOT NULL,artifact_sha256 TEXT NOT NULL CHECK(length(artifact_sha256)=64 AND artifact_sha256=lower(artifact_sha256) AND artifact_sha256 NOT GLOB '*[^0-9a-f]*'),artifact_byte_size INTEGER NOT NULL CHECK(artifact_byte_size>=0),artifact_media_type TEXT NOT NULL CHECK(length(trim(artifact_media_type))>0),PRIMARY KEY(document_version_id,ordinal),UNIQUE(document_version_id,resource_id),UNIQUE(document_version_id,reference),FOREIGN KEY(document_version_id) REFERENCES document_versions(document_version_id) ON DELETE RESTRICT,FOREIGN KEY(artifact_path,artifact_sha256,artifact_byte_size,artifact_media_type) REFERENCES artifact_objects(relative_path,sha256,byte_size,media_type) ON DELETE RESTRICT) STRICT",
  "CREATE TABLE document_defaults(document_id TEXT NOT NULL PRIMARY KEY,document_version_id TEXT NOT NULL UNIQUE,revision INTEGER NOT NULL CHECK(revision>=1),FOREIGN KEY(document_id,document_version_id) REFERENCES document_versions(document_id,document_version_id) ON DELETE RESTRICT) STRICT",
  "CREATE TABLE retrieval_source_revision(singleton INTEGER NOT NULL PRIMARY KEY CHECK(singleton=1),revision INTEGER NOT NULL CHECK(revision>=0)) STRICT",
  "CREATE TABLE retrieval_generations(generation_id TEXT NOT NULL PRIMARY KEY CHECK(length(trim(generation_id))>0),index_schema_version INTEGER NOT NULL CHECK(index_schema_version=1),unit_rule TEXT NOT NULL CHECK(unit_rule='markdown-context-v1'),source_revision INTEGER NOT NULL CHECK(source_revision>=0),status TEXT NOT NULL CHECK(status IN ('building','ready')),entry_count INTEGER NOT NULL CHECK(entry_count>=0),fts_count INTEGER NOT NULL CHECK(fts_count>=0),source_count INTEGER NOT NULL CHECK(source_count>=0),content_sha256 TEXT CHECK(content_sha256 IS NULL OR (length(content_sha256)=64 AND content_sha256=lower(content_sha256) AND content_sha256 NOT GLOB '*[^0-9a-f]*')),posting_sha256 TEXT CHECK(posting_sha256 IS NULL OR (length(posting_sha256)=64 AND posting_sha256=lower(posting_sha256) AND posting_sha256 NOT GLOB '*[^0-9a-f]*')),created_at TEXT NOT NULL CHECK(length(trim(created_at))>0),CHECK(status='building' OR (content_sha256 IS NOT NULL AND posting_sha256 IS NOT NULL))) STRICT",
  "CREATE TABLE retrieval_active_generation(singleton INTEGER NOT NULL PRIMARY KEY CHECK(singleton=1),generation_id TEXT NOT NULL,FOREIGN KEY(generation_id) REFERENCES retrieval_generations(generation_id) ON DELETE RESTRICT) STRICT",
  "CREATE TABLE retrieval_entries(entry_id INTEGER PRIMARY KEY,generation_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('metadata','document')),literature_id TEXT NOT NULL,meta_literature_id TEXT NOT NULL,metadata_revision INTEGER NOT NULL CHECK(metadata_revision>=1),metadata_sha256 TEXT NOT NULL CHECK(length(metadata_sha256)=64),document_version_id TEXT,representation_sha256 TEXT,source_asset_id TEXT,source_asset_sha256 TEXT,unit_start_utf8 INTEGER,unit_end_utf8 INTEGER,unit_sha256 TEXT,section_id TEXT,unit_ordinal INTEGER NOT NULL CHECK(unit_ordinal>=0),is_default INTEGER NOT NULL CHECK(is_default IN (0,1)),CHECK((kind='metadata' AND document_version_id IS NULL AND representation_sha256 IS NULL AND source_asset_id IS NULL AND source_asset_sha256 IS NULL AND unit_start_utf8 IS NULL AND unit_end_utf8 IS NULL AND unit_sha256 IS NULL AND section_id IS NULL) OR (kind='document' AND document_version_id IS NOT NULL AND representation_sha256 IS NOT NULL AND source_asset_id IS NOT NULL AND source_asset_sha256 IS NOT NULL AND unit_start_utf8>=0 AND unit_end_utf8>unit_start_utf8 AND unit_sha256 IS NOT NULL)),FOREIGN KEY(generation_id) REFERENCES retrieval_generations(generation_id) ON DELETE CASCADE) STRICT",
  "CREATE VIRTUAL TABLE retrieval_fts USING fts5(title,body,tokenize='unicode61')",
  "CREATE INDEX retrieval_entries_scope ON retrieval_entries(generation_id,kind,literature_id,is_default,document_version_id,entry_id)",
  "CREATE INDEX retrieval_entries_version ON retrieval_entries(generation_id,document_version_id,unit_ordinal)",
  "CREATE TRIGGER retrieval_revision_literatures_insert AFTER INSERT ON literatures BEGIN UPDATE retrieval_source_revision SET revision=revision+1 WHERE singleton=1; END",
  "CREATE TRIGGER retrieval_revision_literatures_update AFTER UPDATE ON literatures BEGIN UPDATE retrieval_source_revision SET revision=revision+1 WHERE singleton=1; END",
  "CREATE TRIGGER retrieval_revision_literatures_delete AFTER DELETE ON literatures BEGIN UPDATE retrieval_source_revision SET revision=revision+1 WHERE singleton=1; END",
  "CREATE TRIGGER retrieval_revision_literature_metadata_insert AFTER INSERT ON literature_metadata BEGIN UPDATE retrieval_source_revision SET revision=revision+1 WHERE singleton=1; END",
  "CREATE TRIGGER retrieval_revision_literature_metadata_update AFTER UPDATE ON literature_metadata BEGIN UPDATE retrieval_source_revision SET revision=revision+1 WHERE singleton=1; END",
  "CREATE TRIGGER retrieval_revision_literature_metadata_delete AFTER DELETE ON literature_metadata BEGIN UPDATE retrieval_source_revision SET revision=revision+1 WHERE singleton=1; END",
  "CREATE TRIGGER retrieval_revision_literature_metadata_authors_insert AFTER INSERT ON literature_metadata_authors BEGIN UPDATE retrieval_source_revision SET revision=revision+1 WHERE singleton=1; END",
  "CREATE TRIGGER retrieval_revision_literature_metadata_authors_update AFTER UPDATE ON literature_metadata_authors BEGIN UPDATE retrieval_source_revision SET revision=revision+1 WHERE singleton=1; END",
  "CREATE TRIGGER retrieval_revision_literature_metadata_authors_delete AFTER DELETE ON literature_metadata_authors BEGIN UPDATE retrieval_source_revision SET revision=revision+1 WHERE singleton=1; END",
  "CREATE TRIGGER retrieval_revision_literature_metadata_author_affiliations_insert AFTER INSERT ON literature_metadata_author_affiliations BEGIN UPDATE retrieval_source_revision SET revision=revision+1 WHERE singleton=1; END",
  "CREATE TRIGGER retrieval_revision_literature_metadata_author_affiliations_update AFTER UPDATE ON literature_metadata_author_affiliations BEGIN UPDATE retrieval_source_revision SET revision=revision+1 WHERE singleton=1; END",
  "CREATE TRIGGER retrieval_revision_literature_metadata_author_affiliations_delete AFTER DELETE ON literature_metadata_author_affiliations BEGIN UPDATE retrieval_source_revision SET revision=revision+1 WHERE singleton=1; END",
  "CREATE TRIGGER retrieval_revision_literature_metadata_identifiers_insert AFTER INSERT ON literature_metadata_identifiers BEGIN UPDATE retrieval_source_revision SET revision=revision+1 WHERE singleton=1; END",
  "CREATE TRIGGER retrieval_revision_literature_metadata_identifiers_update AFTER UPDATE ON literature_metadata_identifiers BEGIN UPDATE retrieval_source_revision SET revision=revision+1 WHERE singleton=1; END",
  "CREATE TRIGGER retrieval_revision_literature_metadata_identifiers_delete AFTER DELETE ON literature_metadata_identifiers BEGIN UPDATE retrieval_source_revision SET revision=revision+1 WHERE singleton=1; END",
  "CREATE TRIGGER retrieval_revision_literature_metadata_keywords_insert AFTER INSERT ON literature_metadata_keywords BEGIN UPDATE retrieval_source_revision SET revision=revision+1 WHERE singleton=1; END",
  "CREATE TRIGGER retrieval_revision_literature_metadata_keywords_update AFTER UPDATE ON literature_metadata_keywords BEGIN UPDATE retrieval_source_revision SET revision=revision+1 WHERE singleton=1; END",
  "CREATE TRIGGER retrieval_revision_literature_metadata_keywords_delete AFTER DELETE ON literature_metadata_keywords BEGIN UPDATE retrieval_source_revision SET revision=revision+1 WHERE singleton=1; END",
  "CREATE TRIGGER retrieval_revision_assets_insert AFTER INSERT ON assets BEGIN UPDATE retrieval_source_revision SET revision=revision+1 WHERE singleton=1; END",
  "CREATE TRIGGER retrieval_revision_assets_update AFTER UPDATE ON assets BEGIN UPDATE retrieval_source_revision SET revision=revision+1 WHERE singleton=1; END",
  "CREATE TRIGGER retrieval_revision_assets_delete AFTER DELETE ON assets BEGIN UPDATE retrieval_source_revision SET revision=revision+1 WHERE singleton=1; END",
  "CREATE TRIGGER retrieval_revision_literature_assets_insert AFTER INSERT ON literature_assets BEGIN UPDATE retrieval_source_revision SET revision=revision+1 WHERE singleton=1; END",
  "CREATE TRIGGER retrieval_revision_literature_assets_update AFTER UPDATE ON literature_assets BEGIN UPDATE retrieval_source_revision SET revision=revision+1 WHERE singleton=1; END",
  "CREATE TRIGGER retrieval_revision_literature_assets_delete AFTER DELETE ON literature_assets BEGIN UPDATE retrieval_source_revision SET revision=revision+1 WHERE singleton=1; END",
  "CREATE TRIGGER retrieval_revision_document_versions_insert AFTER INSERT ON document_versions BEGIN UPDATE retrieval_source_revision SET revision=revision+1 WHERE singleton=1; END",
  "CREATE TRIGGER retrieval_revision_document_versions_update AFTER UPDATE ON document_versions BEGIN UPDATE retrieval_source_revision SET revision=revision+1 WHERE singleton=1; END",
  "CREATE TRIGGER retrieval_revision_document_versions_delete AFTER DELETE ON document_versions BEGIN UPDATE retrieval_source_revision SET revision=revision+1 WHERE singleton=1; END",
  "CREATE TRIGGER retrieval_revision_document_version_resources_insert AFTER INSERT ON document_version_resources BEGIN UPDATE retrieval_source_revision SET revision=revision+1 WHERE singleton=1; END",
  "CREATE TRIGGER retrieval_revision_document_version_resources_update AFTER UPDATE ON document_version_resources BEGIN UPDATE retrieval_source_revision SET revision=revision+1 WHERE singleton=1; END",
  "CREATE TRIGGER retrieval_revision_document_version_resources_delete AFTER DELETE ON document_version_resources BEGIN UPDATE retrieval_source_revision SET revision=revision+1 WHERE singleton=1; END",
  "CREATE TRIGGER retrieval_revision_document_defaults_insert AFTER INSERT ON document_defaults BEGIN UPDATE retrieval_source_revision SET revision=revision+1 WHERE singleton=1; END",
  "CREATE TRIGGER retrieval_revision_document_defaults_update AFTER UPDATE ON document_defaults BEGIN UPDATE retrieval_source_revision SET revision=revision+1 WHERE singleton=1; END",
  "CREATE TRIGGER retrieval_revision_document_defaults_delete AFTER DELETE ON document_defaults BEGIN UPDATE retrieval_source_revision SET revision=revision+1 WHERE singleton=1; END",
  "CREATE TABLE extraction_specs(caller_id TEXT NOT NULL,spec_id TEXT NOT NULL,spec_version TEXT NOT NULL,spec_sha256 TEXT NOT NULL CHECK(length(spec_sha256)=64 AND spec_sha256=lower(spec_sha256) AND spec_sha256 NOT GLOB '*[^0-9a-f]*'),spec_json TEXT NOT NULL CHECK(length(CAST(spec_json AS BLOB))>0 AND length(CAST(spec_json AS BLOB))<=65536),PRIMARY KEY(caller_id,spec_id,spec_version),UNIQUE(caller_id,spec_id,spec_version,spec_sha256)) STRICT",
  "CREATE TABLE extraction_operations(operation_id TEXT NOT NULL PRIMARY KEY,caller_id TEXT NOT NULL,spec_id TEXT NOT NULL,spec_version TEXT NOT NULL,spec_sha256 TEXT NOT NULL,manifest_sha256 TEXT NOT NULL CHECK(length(manifest_sha256)=64 AND manifest_sha256=lower(manifest_sha256) AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'),manifest_json TEXT NOT NULL CHECK(length(CAST(manifest_json AS BLOB))>0 AND length(CAST(manifest_json AS BLOB))<=262144),status TEXT NOT NULL CHECK(status IN ('open','closed','cancelled')),created_at TEXT NOT NULL,accept_until TEXT NOT NULL,closed_at TEXT,FOREIGN KEY(caller_id,spec_id,spec_version,spec_sha256) REFERENCES extraction_specs(caller_id,spec_id,spec_version,spec_sha256) ON DELETE RESTRICT,CHECK((status='open' AND closed_at IS NULL) OR (status<>'open' AND closed_at IS NOT NULL))) STRICT",
  "CREATE TABLE extraction_receipts(receipt_id TEXT NOT NULL PRIMARY KEY,operation_id TEXT NOT NULL,submission_key TEXT NOT NULL,batch_id TEXT NOT NULL,submission_sha256 TEXT NOT NULL CHECK(length(submission_sha256)=64 AND submission_sha256=lower(submission_sha256) AND submission_sha256 NOT GLOB '*[^0-9a-f]*'),accepted_at TEXT NOT NULL,receipt_expires_at TEXT NOT NULL,protection_expires_at TEXT NOT NULL,checks_json TEXT NOT NULL CHECK(length(CAST(checks_json AS BLOB))>0 AND length(CAST(checks_json AS BLOB))<=4096),UNIQUE(operation_id,submission_key),UNIQUE(operation_id,batch_id),FOREIGN KEY(operation_id) REFERENCES extraction_operations(operation_id) ON DELETE RESTRICT) STRICT",
  "CREATE TABLE extraction_receipt_materials(receipt_id TEXT NOT NULL,input_id TEXT NOT NULL,literature_id TEXT NOT NULL,asset_id TEXT NOT NULL,asset_sha256 TEXT NOT NULL,PRIMARY KEY(receipt_id,input_id),FOREIGN KEY(receipt_id) REFERENCES extraction_receipts(receipt_id) ON DELETE CASCADE,FOREIGN KEY(literature_id) REFERENCES literatures(literature_id) ON DELETE RESTRICT,FOREIGN KEY(asset_id,asset_sha256) REFERENCES assets(asset_id,sha256) ON DELETE RESTRICT) STRICT",
  "CREATE TABLE extraction_receipt_documents(receipt_id TEXT NOT NULL,input_id TEXT NOT NULL,document_version_id TEXT NOT NULL,representation_sha256 TEXT NOT NULL,PRIMARY KEY(receipt_id,input_id),FOREIGN KEY(receipt_id,input_id) REFERENCES extraction_receipt_materials(receipt_id,input_id) ON DELETE CASCADE,FOREIGN KEY(document_version_id,representation_sha256) REFERENCES document_versions(document_version_id,representation_sha256) ON DELETE RESTRICT) STRICT",
  "CREATE INDEX extraction_receipts_expiry ON extraction_receipts(receipt_expires_at,receipt_id)",
  "CREATE INDEX extraction_operations_expiry ON extraction_operations(accept_until,operation_id)",
  "CREATE TABLE article_identity_assessments(assessment_id TEXT NOT NULL PRIMARY KEY,literature_id TEXT NOT NULL,asset_id TEXT NOT NULL,asset_sha256 TEXT NOT NULL,document_version_id TEXT NOT NULL,representation_sha256 TEXT NOT NULL,metadata_revision INTEGER NOT NULL CHECK(metadata_revision>=1),metadata_sha256 TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('match-supported','conflict','insufficient-evidence')),assessment_json TEXT NOT NULL CHECK(json_valid(assessment_json) AND length(CAST(assessment_json AS BLOB))<=65536),created_at TEXT NOT NULL,FOREIGN KEY(literature_id) REFERENCES literatures(literature_id) ON DELETE RESTRICT,FOREIGN KEY(asset_id,asset_sha256) REFERENCES assets(asset_id,sha256) ON DELETE RESTRICT,FOREIGN KEY(document_version_id,representation_sha256) REFERENCES document_versions(document_version_id,representation_sha256) ON DELETE RESTRICT) STRICT",
  "CREATE INDEX article_identity_current ON article_identity_assessments(literature_id,asset_id,metadata_revision,metadata_sha256,created_at,assessment_id)",
  "CREATE TABLE processor_results(result_id TEXT NOT NULL PRIMARY KEY,comparison_sha256 TEXT NOT NULL CHECK(length(comparison_sha256)=64),processor_id TEXT NOT NULL,processor_version TEXT NOT NULL,complete INTEGER NOT NULL CHECK(complete IN (0,1)),producer TEXT NOT NULL CHECK(producer IN ('internal','external')),content_reference TEXT NOT NULL,content_sha256 TEXT NOT NULL,content_size INTEGER NOT NULL CHECK(content_size>0 AND content_size<=8388608),content_media_type TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(result_id,content_sha256),FOREIGN KEY(content_reference,content_sha256,content_size,content_media_type) REFERENCES artifact_objects(relative_path,sha256,byte_size,media_type) ON DELETE RESTRICT) STRICT",
  "CREATE UNIQUE INDEX processor_complete_comparison ON processor_results(comparison_sha256) WHERE complete=1 AND producer='internal'",
  "CREATE TABLE processor_result_literatures(result_id TEXT NOT NULL,literature_id TEXT NOT NULL,PRIMARY KEY(result_id,literature_id),FOREIGN KEY(result_id) REFERENCES processor_results(result_id) ON DELETE RESTRICT,FOREIGN KEY(literature_id) REFERENCES literatures(literature_id) ON DELETE RESTRICT) STRICT",
  "CREATE INDEX processor_result_literature_lookup ON processor_result_literatures(literature_id,result_id)",
  "CREATE TABLE processor_result_documents(result_id TEXT NOT NULL,literature_id TEXT NOT NULL,asset_id TEXT NOT NULL,asset_sha256 TEXT NOT NULL,document_version_id TEXT NOT NULL,representation_sha256 TEXT NOT NULL,PRIMARY KEY(result_id,document_version_id),FOREIGN KEY(result_id) REFERENCES processor_results(result_id) ON DELETE RESTRICT,FOREIGN KEY(literature_id) REFERENCES literatures(literature_id) ON DELETE RESTRICT,FOREIGN KEY(asset_id,asset_sha256) REFERENCES assets(asset_id,sha256) ON DELETE RESTRICT,FOREIGN KEY(document_version_id,representation_sha256) REFERENCES document_versions(document_version_id,representation_sha256) ON DELETE RESTRICT) STRICT",
  "CREATE TABLE processor_result_materials(result_id TEXT NOT NULL,literature_id TEXT NOT NULL,asset_id TEXT NOT NULL,asset_sha256 TEXT NOT NULL,PRIMARY KEY(result_id,asset_id),FOREIGN KEY(result_id) REFERENCES processor_results(result_id) ON DELETE RESTRICT,FOREIGN KEY(literature_id) REFERENCES literatures(literature_id) ON DELETE RESTRICT,FOREIGN KEY(asset_id,asset_sha256) REFERENCES assets(asset_id,sha256) ON DELETE RESTRICT) STRICT",
  "CREATE TABLE processor_result_inputs(result_id TEXT NOT NULL,source_result_id TEXT NOT NULL,source_sha256 TEXT NOT NULL,PRIMARY KEY(result_id,source_result_id),CHECK(result_id<>source_result_id),FOREIGN KEY(result_id) REFERENCES processor_results(result_id) ON DELETE RESTRICT,FOREIGN KEY(source_result_id,source_sha256) REFERENCES processor_results(result_id,content_sha256) ON DELETE RESTRICT) STRICT",
  "CREATE TABLE processor_collections(collection_id TEXT NOT NULL PRIMARY KEY,run_id TEXT NOT NULL,name TEXT NOT NULL,processor_id TEXT NOT NULL,spec_json TEXT NOT NULL,content_reference TEXT NOT NULL,content_sha256 TEXT NOT NULL,content_size INTEGER NOT NULL,content_media_type TEXT NOT NULL,created_at TEXT NOT NULL,FOREIGN KEY(content_reference,content_sha256,content_size,content_media_type) REFERENCES artifact_objects(relative_path,sha256,byte_size,media_type) ON DELETE RESTRICT) STRICT",
  "CREATE TABLE processor_collection_members(collection_id TEXT NOT NULL,target_id TEXT NOT NULL,result_id TEXT,content_sha256 TEXT,gap TEXT,PRIMARY KEY(collection_id,target_id),FOREIGN KEY(collection_id) REFERENCES processor_collections(collection_id) ON DELETE RESTRICT,FOREIGN KEY(result_id,content_sha256) REFERENCES processor_results(result_id,content_sha256) ON DELETE RESTRICT) STRICT",
  "CREATE TABLE processor_record_projection(result_id TEXT NOT NULL,record_id TEXT NOT NULL,ordinal INTEGER NOT NULL,payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),PRIMARY KEY(result_id,record_id),FOREIGN KEY(result_id) REFERENCES processor_results(result_id) ON DELETE CASCADE) STRICT",
  "CREATE TABLE processor_projection_state(result_id TEXT NOT NULL PRIMARY KEY,content_sha256 TEXT NOT NULL,record_count INTEGER NOT NULL,FOREIGN KEY(result_id,content_sha256) REFERENCES processor_results(result_id,content_sha256) ON DELETE CASCADE) STRICT",
  "CREATE VIRTUAL TABLE processor_result_fts USING fts5(result_id UNINDEXED,record_id UNINDEXED,body,tokenize='unicode61')",
  "CREATE VIRTUAL TABLE processor_collection_fts USING fts5(collection_id UNINDEXED,body,tokenize='unicode61')",
  "CREATE INDEX processor_collection_runs ON processor_collections(run_id,created_at,collection_id)",
  "CREATE TABLE raw_parses(raw_parse_id TEXT NOT NULL PRIMARY KEY,source_asset_id TEXT NOT NULL,source_sha256 TEXT NOT NULL,profile TEXT NOT NULL CHECK(profile IN ('pipeline','vlm-engine','vlm-engine-markdown-only')),parameters_sha256 TEXT NOT NULL CHECK(length(parameters_sha256)=64),result_sha256 TEXT NOT NULL CHECK(length(result_sha256)=64),manifest_reference TEXT NOT NULL,manifest_sha256 TEXT NOT NULL,manifest_size INTEGER NOT NULL CHECK(manifest_size>0),manifest_media_type TEXT NOT NULL CHECK(manifest_media_type='application/json'),created_at TEXT NOT NULL,UNIQUE(raw_parse_id,result_sha256),UNIQUE(raw_parse_id,source_asset_id,source_sha256,profile),FOREIGN KEY(source_asset_id,source_sha256) REFERENCES assets(asset_id,sha256) ON DELETE RESTRICT,FOREIGN KEY(manifest_reference,manifest_sha256,manifest_size,manifest_media_type) REFERENCES artifact_objects(relative_path,sha256,byte_size,media_type) ON DELETE RESTRICT) STRICT",
  "CREATE TABLE raw_parse_resources(raw_parse_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('blocks','markdown','private-content-list','image')),reference TEXT NOT NULL,artifact_reference TEXT NOT NULL,sha256 TEXT NOT NULL,byte_size INTEGER NOT NULL CHECK(byte_size>0),media_type TEXT NOT NULL,PRIMARY KEY(raw_parse_id,kind,reference),FOREIGN KEY(raw_parse_id) REFERENCES raw_parses(raw_parse_id) ON DELETE RESTRICT,FOREIGN KEY(artifact_reference,sha256,byte_size,media_type) REFERENCES artifact_objects(relative_path,sha256,byte_size,media_type) ON DELETE RESTRICT) STRICT",
  "CREATE TABLE raw_parse_current(source_asset_id TEXT NOT NULL,source_sha256 TEXT NOT NULL,profile TEXT NOT NULL CHECK(profile IN ('pipeline','vlm-engine','vlm-engine-markdown-only')),raw_parse_id TEXT,last_failure_code TEXT,last_parameters_sha256 TEXT,PRIMARY KEY(source_asset_id,profile),FOREIGN KEY(source_asset_id,source_sha256) REFERENCES assets(asset_id,sha256) ON DELETE RESTRICT,FOREIGN KEY(raw_parse_id,source_asset_id,source_sha256,profile) REFERENCES raw_parses(raw_parse_id,source_asset_id,source_sha256,profile) ON DELETE RESTRICT) STRICT",
  "CREATE TABLE raw_parse_pins(raw_parse_id TEXT NOT NULL,proofread_id TEXT NOT NULL,PRIMARY KEY(raw_parse_id,proofread_id),FOREIGN KEY(raw_parse_id) REFERENCES raw_parses(raw_parse_id) ON DELETE RESTRICT) STRICT",
  "CREATE INDEX raw_parse_asset_profiles ON raw_parses(source_asset_id,profile,parameters_sha256)",
  "CREATE TABLE proofread_versions(proofread_id TEXT NOT NULL PRIMARY KEY,part_asset_id TEXT NOT NULL,part_sha256 TEXT NOT NULL,content_sha256 TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('complete','incomplete','failed')),manifest_reference TEXT NOT NULL,manifest_sha256 TEXT NOT NULL,manifest_size INTEGER NOT NULL,manifest_media_type TEXT NOT NULL CHECK(manifest_media_type='application/json'),created_at TEXT NOT NULL,UNIQUE(proofread_id,part_asset_id,part_sha256),FOREIGN KEY(part_asset_id,part_sha256) REFERENCES assets(asset_id,sha256) ON DELETE RESTRICT,FOREIGN KEY(manifest_reference,manifest_sha256,manifest_size,manifest_media_type) REFERENCES artifact_objects(relative_path,sha256,byte_size,media_type) ON DELETE RESTRICT) STRICT",
  "CREATE TABLE proofread_resources(proofread_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('blocks','markdown','drafts','image')),reference TEXT NOT NULL,artifact_reference TEXT NOT NULL,sha256 TEXT NOT NULL,byte_size INTEGER NOT NULL,media_type TEXT NOT NULL,PRIMARY KEY(proofread_id,kind,reference),FOREIGN KEY(proofread_id) REFERENCES proofread_versions(proofread_id) ON DELETE RESTRICT,FOREIGN KEY(artifact_reference,sha256,byte_size,media_type) REFERENCES artifact_objects(relative_path,sha256,byte_size,media_type) ON DELETE RESTRICT) STRICT",
  "CREATE TABLE proofread_current(part_asset_id TEXT NOT NULL PRIMARY KEY,manual_revision INTEGER NOT NULL CHECK(manual_revision>=0),part_sha256 TEXT NOT NULL,proofread_id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),FOREIGN KEY(proofread_id,part_asset_id,part_sha256) REFERENCES proofread_versions(proofread_id,part_asset_id,part_sha256) ON DELETE RESTRICT) STRICT",
  "CREATE TABLE proofread_manual_state(part_asset_id TEXT NOT NULL PRIMARY KEY,revision INTEGER NOT NULL CHECK(revision>=0),FOREIGN KEY(part_asset_id) REFERENCES assets(asset_id) ON DELETE RESTRICT) STRICT",
  "CREATE TABLE proofread_manual_decisions(decision_id TEXT NOT NULL PRIMARY KEY,part_asset_id TEXT NOT NULL,block_id TEXT NOT NULL,scope_key TEXT NOT NULL,manifest_reference TEXT NOT NULL,manifest_sha256 TEXT NOT NULL,manifest_size INTEGER NOT NULL,manifest_media_type TEXT NOT NULL CHECK(manifest_media_type='application/json'),active INTEGER NOT NULL CHECK(active IN (0,1)),actor TEXT NOT NULL,created_at TEXT NOT NULL,revoked_by TEXT,revoked_at TEXT,FOREIGN KEY(part_asset_id) REFERENCES assets(asset_id) ON DELETE RESTRICT,FOREIGN KEY(manifest_reference,manifest_sha256,manifest_size,manifest_media_type) REFERENCES artifact_objects(relative_path,sha256,byte_size,media_type) ON DELETE RESTRICT) STRICT",
  "CREATE UNIQUE INDEX proofread_manual_active_scope ON proofread_manual_decisions(part_asset_id,scope_key) WHERE active=1",
  "CREATE UNIQUE INDEX proofread_content_binding ON proofread_versions(proofread_id,content_sha256)",
  "CREATE TABLE structure_annotations(annotation_id TEXT NOT NULL PRIMARY KEY,structure_satisfied INTEGER NOT NULL CHECK(structure_satisfied IN (0,1)),document_version_id TEXT NOT NULL,method_sha256 TEXT NOT NULL,manual_revision INTEGER NOT NULL CHECK(manual_revision>=0),manifest_reference TEXT NOT NULL,manifest_sha256 TEXT NOT NULL,manifest_size INTEGER NOT NULL,manifest_media_type TEXT NOT NULL CHECK(manifest_media_type='application/json'),created_at TEXT NOT NULL,UNIQUE(document_version_id,method_sha256,manual_revision),UNIQUE(annotation_id,document_version_id),FOREIGN KEY(document_version_id) REFERENCES document_versions(document_version_id) ON DELETE RESTRICT,FOREIGN KEY(manifest_reference,manifest_sha256,manifest_size,manifest_media_type) REFERENCES artifact_objects(relative_path,sha256,byte_size,media_type) ON DELETE RESTRICT) STRICT",
  "CREATE TABLE structure_annotation_current(document_version_id TEXT NOT NULL PRIMARY KEY,annotation_id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),FOREIGN KEY(annotation_id,document_version_id) REFERENCES structure_annotations(annotation_id,document_version_id) ON DELETE RESTRICT) STRICT",
  "CREATE TABLE structure_role_state(document_version_id TEXT NOT NULL PRIMARY KEY,revision INTEGER NOT NULL CHECK(revision>=0),FOREIGN KEY(document_version_id) REFERENCES document_versions(document_version_id) ON DELETE RESTRICT) STRICT",
  "CREATE TABLE structure_role_decisions(decision_id TEXT NOT NULL PRIMARY KEY,document_version_id TEXT NOT NULL,section_id TEXT NOT NULL,role TEXT NOT NULL,active INTEGER NOT NULL CHECK(active IN (0,1)),actor TEXT NOT NULL,created_at TEXT NOT NULL,revoked_by TEXT,revoked_at TEXT,FOREIGN KEY(document_version_id) REFERENCES document_versions(document_version_id) ON DELETE RESTRICT) STRICT",
  "CREATE UNIQUE INDEX structure_active_role ON structure_role_decisions(document_version_id,section_id) WHERE active=1",
  "CREATE TABLE literature_metadata_field_states(literature_id TEXT NOT NULL,field TEXT NOT NULL,source TEXT NOT NULL CHECK(source IN ('authority','proofread','manual')),value_json TEXT NOT NULL,evidence_json TEXT NOT NULL,conflict INTEGER NOT NULL CHECK(conflict IN (0,1)),conflicts_json TEXT NOT NULL,locked INTEGER NOT NULL CHECK(locked IN (0,1)),revision INTEGER NOT NULL CHECK(revision>0),PRIMARY KEY(literature_id,field),FOREIGN KEY(literature_id) REFERENCES literatures(literature_id) ON DELETE CASCADE) STRICT",
  "CREATE TABLE archive_reference_text_supports(reference_id TEXT NOT NULL,document_version_id TEXT NOT NULL,annotation_id TEXT NOT NULL,reference_index INTEGER NOT NULL CHECK(reference_index>=0),segment_ids_json TEXT NOT NULL,matching_basis TEXT NOT NULL CHECK(matching_basis IN ('doi','stable-identifier','strict-fallback')),target_metadata_revision INTEGER NOT NULL CHECK(target_metadata_revision>0),target_metadata_sha256 TEXT NOT NULL,PRIMARY KEY(reference_id,document_version_id,annotation_id,reference_index),FOREIGN KEY(reference_id) REFERENCES literature_references(reference_id) ON DELETE RESTRICT,FOREIGN KEY(annotation_id,document_version_id) REFERENCES structure_annotations(annotation_id,document_version_id) ON DELETE RESTRICT) STRICT",
  "CREATE INDEX archive_reference_source_lookup ON archive_reference_text_supports(document_version_id,annotation_id,reference_index)",
  "CREATE TABLE tags(tag_id TEXT NOT NULL PRIMARY KEY,parent_id TEXT,status TEXT NOT NULL CHECK(status IN ('active','merged')),merged_into TEXT,locked INTEGER NOT NULL CHECK(locked IN (0,1)),created_vocab_version INTEGER NOT NULL CHECK(created_vocab_version>0),backfilled_vocab_version INTEGER,row_json TEXT NOT NULL,FOREIGN KEY(parent_id) REFERENCES tags(tag_id) DEFERRABLE INITIALLY DEFERRED,FOREIGN KEY(merged_into) REFERENCES tags(tag_id) DEFERRABLE INITIALLY DEFERRED) STRICT",
  "CREATE TABLE tag_aliases(normalized_name TEXT NOT NULL PRIMARY KEY,tag_id TEXT NOT NULL,FOREIGN KEY(tag_id) REFERENCES tags(tag_id) ON DELETE CASCADE) STRICT",
  "CREATE INDEX tag_parent_lookup ON tags(parent_id,status)",
  "CREATE VIRTUAL TABLE tag_search USING fts5(tag_id UNINDEXED,names,definition,tokenize='unicode61')",
  "CREATE TABLE vocabulary_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL CHECK(version>=0),consolidated_version INTEGER NOT NULL CHECK(consolidated_version>=0)) STRICT",
  "CREATE TABLE vocabulary_changes(version INTEGER NOT NULL PRIMARY KEY,row_json TEXT NOT NULL,undone_by INTEGER,FOREIGN KEY(undone_by) REFERENCES vocabulary_changes(version) DEFERRABLE INITIALLY DEFERRED) STRICT",
  "CREATE TABLE vocabulary_change_tags(version INTEGER NOT NULL,tag_id TEXT NOT NULL,PRIMARY KEY(version,tag_id),FOREIGN KEY(version) REFERENCES vocabulary_changes(version)) STRICT",
  "CREATE INDEX vocabulary_tag_changes ON vocabulary_change_tags(tag_id,version)",
  "CREATE TABLE vocabulary_change_assignments(version INTEGER NOT NULL,literature_id TEXT NOT NULL,before_json TEXT NOT NULL,after_sha256 TEXT NOT NULL,after_revision INTEGER NOT NULL,PRIMARY KEY(version,literature_id),FOREIGN KEY(version) REFERENCES vocabulary_changes(version)) STRICT",
  "CREATE TABLE literature_tag_assignments(literature_id TEXT NOT NULL PRIMARY KEY,revision INTEGER NOT NULL CHECK(revision>0),vocab_version INTEGER NOT NULL CHECK(vocab_version>=0),assignment_sha256 TEXT NOT NULL,row_json TEXT NOT NULL,FOREIGN KEY(literature_id) REFERENCES literatures(literature_id) ON DELETE RESTRICT) STRICT",
  "CREATE TABLE literature_tag_items(literature_id TEXT NOT NULL,tag_id TEXT NOT NULL,rank INTEGER NOT NULL CHECK(rank>0),locked INTEGER NOT NULL CHECK(locked IN (0,1)),PRIMARY KEY(literature_id,tag_id),UNIQUE(literature_id,rank),FOREIGN KEY(literature_id) REFERENCES literature_tag_assignments(literature_id) ON DELETE CASCADE,FOREIGN KEY(tag_id) REFERENCES tags(tag_id) ON DELETE RESTRICT) STRICT",
  "CREATE INDEX literature_tag_lookup ON literature_tag_items(tag_id,rank,literature_id)",
  "CREATE TABLE tag_assignment_changes(change_id TEXT NOT NULL PRIMARY KEY,literature_id TEXT NOT NULL,revision INTEGER NOT NULL,actor TEXT NOT NULL,before_json TEXT,after_json TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(literature_id,revision),FOREIGN KEY(literature_id) REFERENCES literatures(literature_id)) STRICT",
  "CREATE TABLE tag_backfill_coverage(tag_id TEXT NOT NULL,literature_id TEXT NOT NULL,vocab_version INTEGER NOT NULL,PRIMARY KEY(tag_id,literature_id),FOREIGN KEY(tag_id) REFERENCES tags(tag_id),FOREIGN KEY(literature_id) REFERENCES literatures(literature_id)) STRICT",
  "CREATE TABLE archive_runs(literature_id TEXT NOT NULL PRIMARY KEY,asset_id TEXT NOT NULL,mode TEXT NOT NULL CHECK(mode IN ('full','legacy-vlm-markdown')),run_id TEXT NOT NULL,job_id TEXT,state TEXT NOT NULL CHECK(state IN ('running','finished','interrupted')),started_at TEXT NOT NULL,finished_at TEXT,FOREIGN KEY(literature_id) REFERENCES literatures(literature_id),FOREIGN KEY(asset_id) REFERENCES assets(asset_id)) STRICT",
  "CREATE TABLE archive_steps(literature_id TEXT NOT NULL,asset_id TEXT NOT NULL,step TEXT NOT NULL CHECK(step IN ('arrange','proofread','render','metadata','references','tags','document','structure')),status TEXT NOT NULL CHECK(status IN ('pending','running','done','failed','unavailable')),input_sha256 TEXT NOT NULL,output_json TEXT NOT NULL,reason TEXT,elapsed_ms INTEGER NOT NULL,calls INTEGER NOT NULL,input_tokens INTEGER NOT NULL,output_tokens INTEGER NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(literature_id,asset_id,step),FOREIGN KEY(literature_id) REFERENCES literatures(literature_id),FOREIGN KEY(asset_id) REFERENCES assets(asset_id)) STRICT",
  "CREATE TABLE archive_attempts(attempt_id INTEGER PRIMARY KEY,literature_id TEXT NOT NULL,asset_id TEXT NOT NULL,step TEXT NOT NULL,elapsed_ms INTEGER NOT NULL,calls INTEGER NOT NULL,input_tokens INTEGER NOT NULL,output_tokens INTEGER NOT NULL,stats_json TEXT NOT NULL,created_at TEXT NOT NULL) STRICT",
  "CREATE TABLE archive_issues(issue_id TEXT NOT NULL PRIMARY KEY,literature_id TEXT NOT NULL,asset_id TEXT NOT NULL,step TEXT NOT NULL,reason TEXT NOT NULL,detail_json TEXT NOT NULL,resolution TEXT CHECK(resolution IN ('continue','skip','cancel')),updated_at TEXT NOT NULL,FOREIGN KEY(literature_id) REFERENCES literatures(literature_id),FOREIGN KEY(asset_id) REFERENCES assets(asset_id)) STRICT",
  "CREATE INDEX archive_issues_literature ON archive_issues(literature_id,asset_id,step)",
  "CREATE TABLE archive_batch_hooks(job_id TEXT NOT NULL PRIMARY KEY,state TEXT NOT NULL CHECK(state IN ('running','done','failed')),result_json TEXT NOT NULL) STRICT",
  "CREATE TABLE archive_content_heads(literature_id TEXT NOT NULL,asset_id TEXT NOT NULL,source_json TEXT,part TEXT NOT NULL CHECK(part IN ('main','supplementary')),PRIMARY KEY(literature_id,asset_id)) STRICT",
  "CREATE TABLE archive_description_heads(literature_id TEXT NOT NULL PRIMARY KEY,source_json TEXT NOT NULL) STRICT",
  "CREATE TABLE archive_version_events(sequence INTEGER PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('content-version-changed','description-version-changed')),literature_id TEXT NOT NULL,asset_id TEXT,old_part TEXT,new_part TEXT,old_json TEXT,new_json TEXT,created_at TEXT NOT NULL) STRICT",
  "CREATE INDEX archive_events_literature ON archive_version_events(literature_id,sequence)",
  "CREATE VIEW archive_current_parts AS SELECT la.literature_id,a.asset_id,a.sha256 AS asset_sha256,CASE WHEN la.role='primary-pdf' THEN 'main' ELSE 'supplementary' END AS part,pc.proofread_id,pv.status AS proofread_status,d.document_version_id AS document_version_id,ac.annotation_id,COALESCE(an.structure_satisfied,0) AS structure_satisfied,CASE WHEN ac.annotation_id IS NOT NULL THEN json_object('document_version_id',d.document_version_id,'structure_annotation_id',ac.annotation_id) ELSE NULL END AS version_json FROM literature_assets la JOIN assets a ON a.asset_id=la.asset_id LEFT JOIN proofread_current pc ON pc.part_asset_id=a.asset_id AND pc.part_sha256=a.sha256 AND pc.manual_revision=COALESCE((SELECT revision FROM proofread_manual_state WHERE part_asset_id=a.asset_id),0) AND NOT EXISTS(SELECT 1 FROM raw_parse_pins rp JOIN raw_parses r ON r.raw_parse_id=rp.raw_parse_id LEFT JOIN raw_parse_current rc ON rc.source_asset_id=r.source_asset_id AND rc.profile=r.profile WHERE rp.proofread_id=pc.proofread_id AND (rc.raw_parse_id IS NULL OR rc.raw_parse_id!=rp.raw_parse_id)) LEFT JOIN proofread_versions pv ON pv.proofread_id=pc.proofread_id LEFT JOIN (document_defaults dd JOIN document_versions d ON d.document_version_id=dd.document_version_id AND d.schema_version=2) ON d.literature_id=la.literature_id AND d.source_asset_id=a.asset_id AND d.source_sha256=a.sha256 AND d.proofread_content_sha256=pv.content_sha256 AND pv.status='complete' LEFT JOIN structure_annotation_current ac ON ac.document_version_id=d.document_version_id LEFT JOIN structure_annotations an ON an.annotation_id=ac.annotation_id WHERE la.role IN ('primary-pdf','supplementary-pdf') AND a.media_type='application/pdf'",
  "CREATE VIEW archive_current_descriptions AS SELECT m.literature_id,json_object('metadata_revision',m.metadata_revision,'metadata_sha256',m.metadata_sha256,'assignment_sha256',a.assignment_sha256) AS version_json FROM literature_metadata m LEFT JOIN literature_tag_assignments a ON a.literature_id=m.literature_id",
  "CREATE TRIGGER archive_event_content_insert AFTER INSERT ON archive_content_heads BEGIN INSERT INTO archive_version_events(kind,literature_id,asset_id,old_part,new_part,old_json,new_json,created_at) VALUES('content-version-changed',NEW.literature_id,NEW.asset_id,NULL,NEW.part,NULL,NEW.source_json,strftime('%Y-%m-%dT%H:%M:%fZ','now')); END",
  "CREATE TRIGGER archive_event_content_update AFTER UPDATE ON archive_content_heads WHEN OLD.source_json IS NOT NEW.source_json OR OLD.part IS NOT NEW.part BEGIN INSERT INTO archive_version_events(kind,literature_id,asset_id,old_part,new_part,old_json,new_json,created_at) VALUES('content-version-changed',NEW.literature_id,NEW.asset_id,OLD.part,NEW.part,OLD.source_json,NEW.source_json,strftime('%Y-%m-%dT%H:%M:%fZ','now')); END",
  "CREATE TRIGGER archive_event_content_delete AFTER DELETE ON archive_content_heads BEGIN INSERT INTO archive_version_events(kind,literature_id,asset_id,old_part,new_part,old_json,new_json,created_at) VALUES('content-version-changed',OLD.literature_id,OLD.asset_id,OLD.part,NULL,OLD.source_json,NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now')); END",
  "CREATE TRIGGER archive_event_description_insert AFTER INSERT ON archive_description_heads WHEN NULL IS NOT NEW.source_json BEGIN INSERT INTO archive_version_events(kind,literature_id,asset_id,old_part,new_part,old_json,new_json,created_at) VALUES('description-version-changed',NEW.literature_id,NULL,NULL,NULL,NULL,NEW.source_json,strftime('%Y-%m-%dT%H:%M:%fZ','now')); END",
  "CREATE TRIGGER archive_event_description_update AFTER UPDATE ON archive_description_heads WHEN OLD.source_json IS NOT NEW.source_json BEGIN INSERT INTO archive_version_events(kind,literature_id,asset_id,old_part,new_part,old_json,new_json,created_at) VALUES('description-version-changed',NEW.literature_id,NULL,NULL,NULL,OLD.source_json,NEW.source_json,strftime('%Y-%m-%dT%H:%M:%fZ','now')); END",
  "CREATE TRIGGER archive_event_description_delete AFTER DELETE ON archive_description_heads WHEN OLD.source_json IS NOT NULL BEGIN INSERT INTO archive_version_events(kind,literature_id,asset_id,old_part,new_part,old_json,new_json,created_at) VALUES('description-version-changed',OLD.literature_id,NULL,NULL,NULL,OLD.source_json,NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now')); END",
  "CREATE TRIGGER archive_content_literature_assets_insert AFTER INSERT ON literature_assets BEGIN INSERT INTO archive_content_heads SELECT literature_id,asset_id,version_json,part FROM archive_current_parts WHERE literature_id IN (SELECT NEW.literature_id) ON CONFLICT(literature_id,asset_id) DO UPDATE SET source_json=excluded.source_json,part=excluded.part; DELETE FROM archive_content_heads WHERE literature_id IN (SELECT NEW.literature_id) AND NOT EXISTS(SELECT 1 FROM archive_current_parts p WHERE p.literature_id=archive_content_heads.literature_id AND p.asset_id=archive_content_heads.asset_id); END",
  "CREATE TRIGGER archive_content_literature_assets_update AFTER UPDATE ON literature_assets BEGIN INSERT INTO archive_content_heads SELECT literature_id,asset_id,version_json,part FROM archive_current_parts WHERE literature_id IN (SELECT NEW.literature_id UNION SELECT OLD.literature_id) ON CONFLICT(literature_id,asset_id) DO UPDATE SET source_json=excluded.source_json,part=excluded.part; DELETE FROM archive_content_heads WHERE literature_id IN (SELECT NEW.literature_id UNION SELECT OLD.literature_id) AND NOT EXISTS(SELECT 1 FROM archive_current_parts p WHERE p.literature_id=archive_content_heads.literature_id AND p.asset_id=archive_content_heads.asset_id); END",
  "CREATE TRIGGER archive_content_literature_assets_delete AFTER DELETE ON literature_assets BEGIN INSERT INTO archive_content_heads SELECT literature_id,asset_id,version_json,part FROM archive_current_parts WHERE literature_id IN (SELECT OLD.literature_id) ON CONFLICT(literature_id,asset_id) DO UPDATE SET source_json=excluded.source_json,part=excluded.part; DELETE FROM archive_content_heads WHERE literature_id IN (SELECT OLD.literature_id) AND NOT EXISTS(SELECT 1 FROM archive_current_parts p WHERE p.literature_id=archive_content_heads.literature_id AND p.asset_id=archive_content_heads.asset_id); END",
  "CREATE TRIGGER archive_content_document_defaults_insert AFTER INSERT ON document_defaults BEGIN INSERT INTO archive_content_heads SELECT literature_id,asset_id,version_json,part FROM archive_current_parts WHERE literature_id IN (SELECT literature_id FROM document_versions WHERE document_id=NEW.document_id) ON CONFLICT(literature_id,asset_id) DO UPDATE SET source_json=excluded.source_json,part=excluded.part; DELETE FROM archive_content_heads WHERE literature_id IN (SELECT literature_id FROM document_versions WHERE document_id=NEW.document_id) AND NOT EXISTS(SELECT 1 FROM archive_current_parts p WHERE p.literature_id=archive_content_heads.literature_id AND p.asset_id=archive_content_heads.asset_id); END",
  "CREATE TRIGGER archive_content_document_defaults_update AFTER UPDATE ON document_defaults BEGIN INSERT INTO archive_content_heads SELECT literature_id,asset_id,version_json,part FROM archive_current_parts WHERE literature_id IN (SELECT literature_id FROM document_versions WHERE document_id=NEW.document_id UNION SELECT literature_id FROM document_versions WHERE document_id=OLD.document_id) ON CONFLICT(literature_id,asset_id) DO UPDATE SET source_json=excluded.source_json,part=excluded.part; DELETE FROM archive_content_heads WHERE literature_id IN (SELECT literature_id FROM document_versions WHERE document_id=NEW.document_id UNION SELECT literature_id FROM document_versions WHERE document_id=OLD.document_id) AND NOT EXISTS(SELECT 1 FROM archive_current_parts p WHERE p.literature_id=archive_content_heads.literature_id AND p.asset_id=archive_content_heads.asset_id); END",
  "CREATE TRIGGER archive_content_document_defaults_delete AFTER DELETE ON document_defaults BEGIN INSERT INTO archive_content_heads SELECT literature_id,asset_id,version_json,part FROM archive_current_parts WHERE literature_id IN (SELECT literature_id FROM document_versions WHERE document_id=OLD.document_id) ON CONFLICT(literature_id,asset_id) DO UPDATE SET source_json=excluded.source_json,part=excluded.part; DELETE FROM archive_content_heads WHERE literature_id IN (SELECT literature_id FROM document_versions WHERE document_id=OLD.document_id) AND NOT EXISTS(SELECT 1 FROM archive_current_parts p WHERE p.literature_id=archive_content_heads.literature_id AND p.asset_id=archive_content_heads.asset_id); END",
  "CREATE TRIGGER archive_content_structure_annotation_current_insert AFTER INSERT ON structure_annotation_current BEGIN INSERT INTO archive_content_heads SELECT literature_id,asset_id,version_json,part FROM archive_current_parts WHERE literature_id IN (SELECT literature_id FROM document_versions WHERE document_version_id=NEW.document_version_id) ON CONFLICT(literature_id,asset_id) DO UPDATE SET source_json=excluded.source_json,part=excluded.part; DELETE FROM archive_content_heads WHERE literature_id IN (SELECT literature_id FROM document_versions WHERE document_version_id=NEW.document_version_id) AND NOT EXISTS(SELECT 1 FROM archive_current_parts p WHERE p.literature_id=archive_content_heads.literature_id AND p.asset_id=archive_content_heads.asset_id); END",
  "CREATE TRIGGER archive_content_structure_annotation_current_update AFTER UPDATE ON structure_annotation_current BEGIN INSERT INTO archive_content_heads SELECT literature_id,asset_id,version_json,part FROM archive_current_parts WHERE literature_id IN (SELECT literature_id FROM document_versions WHERE document_version_id=NEW.document_version_id UNION SELECT literature_id FROM document_versions WHERE document_version_id=OLD.document_version_id) ON CONFLICT(literature_id,asset_id) DO UPDATE SET source_json=excluded.source_json,part=excluded.part; DELETE FROM archive_content_heads WHERE literature_id IN (SELECT literature_id FROM document_versions WHERE document_version_id=NEW.document_version_id UNION SELECT literature_id FROM document_versions WHERE document_version_id=OLD.document_version_id) AND NOT EXISTS(SELECT 1 FROM archive_current_parts p WHERE p.literature_id=archive_content_heads.literature_id AND p.asset_id=archive_content_heads.asset_id); END",
  "CREATE TRIGGER archive_content_structure_annotation_current_delete AFTER DELETE ON structure_annotation_current BEGIN INSERT INTO archive_content_heads SELECT literature_id,asset_id,version_json,part FROM archive_current_parts WHERE literature_id IN (SELECT literature_id FROM document_versions WHERE document_version_id=OLD.document_version_id) ON CONFLICT(literature_id,asset_id) DO UPDATE SET source_json=excluded.source_json,part=excluded.part; DELETE FROM archive_content_heads WHERE literature_id IN (SELECT literature_id FROM document_versions WHERE document_version_id=OLD.document_version_id) AND NOT EXISTS(SELECT 1 FROM archive_current_parts p WHERE p.literature_id=archive_content_heads.literature_id AND p.asset_id=archive_content_heads.asset_id); END",
  "CREATE TRIGGER archive_content_proofread_current_insert AFTER INSERT ON proofread_current BEGIN INSERT INTO archive_content_heads SELECT literature_id,asset_id,version_json,part FROM archive_current_parts WHERE literature_id IN (SELECT literature_id FROM literature_assets WHERE asset_id=NEW.part_asset_id) ON CONFLICT(literature_id,asset_id) DO UPDATE SET source_json=excluded.source_json,part=excluded.part; DELETE FROM archive_content_heads WHERE literature_id IN (SELECT literature_id FROM literature_assets WHERE asset_id=NEW.part_asset_id) AND NOT EXISTS(SELECT 1 FROM archive_current_parts p WHERE p.literature_id=archive_content_heads.literature_id AND p.asset_id=archive_content_heads.asset_id); END",
  "CREATE TRIGGER archive_content_proofread_current_update AFTER UPDATE ON proofread_current BEGIN INSERT INTO archive_content_heads SELECT literature_id,asset_id,version_json,part FROM archive_current_parts WHERE literature_id IN (SELECT literature_id FROM literature_assets WHERE asset_id=NEW.part_asset_id UNION SELECT literature_id FROM literature_assets WHERE asset_id=OLD.part_asset_id) ON CONFLICT(literature_id,asset_id) DO UPDATE SET source_json=excluded.source_json,part=excluded.part; DELETE FROM archive_content_heads WHERE literature_id IN (SELECT literature_id FROM literature_assets WHERE asset_id=NEW.part_asset_id UNION SELECT literature_id FROM literature_assets WHERE asset_id=OLD.part_asset_id) AND NOT EXISTS(SELECT 1 FROM archive_current_parts p WHERE p.literature_id=archive_content_heads.literature_id AND p.asset_id=archive_content_heads.asset_id); END",
  "CREATE TRIGGER archive_content_proofread_current_delete AFTER DELETE ON proofread_current BEGIN INSERT INTO archive_content_heads SELECT literature_id,asset_id,version_json,part FROM archive_current_parts WHERE literature_id IN (SELECT literature_id FROM literature_assets WHERE asset_id=OLD.part_asset_id) ON CONFLICT(literature_id,asset_id) DO UPDATE SET source_json=excluded.source_json,part=excluded.part; DELETE FROM archive_content_heads WHERE literature_id IN (SELECT literature_id FROM literature_assets WHERE asset_id=OLD.part_asset_id) AND NOT EXISTS(SELECT 1 FROM archive_current_parts p WHERE p.literature_id=archive_content_heads.literature_id AND p.asset_id=archive_content_heads.asset_id); END",
  "CREATE TRIGGER archive_content_proofread_manual_state_insert AFTER INSERT ON proofread_manual_state BEGIN INSERT INTO archive_content_heads SELECT literature_id,asset_id,version_json,part FROM archive_current_parts WHERE literature_id IN (SELECT literature_id FROM literature_assets WHERE asset_id=NEW.part_asset_id) ON CONFLICT(literature_id,asset_id) DO UPDATE SET source_json=excluded.source_json,part=excluded.part; DELETE FROM archive_content_heads WHERE literature_id IN (SELECT literature_id FROM literature_assets WHERE asset_id=NEW.part_asset_id) AND NOT EXISTS(SELECT 1 FROM archive_current_parts p WHERE p.literature_id=archive_content_heads.literature_id AND p.asset_id=archive_content_heads.asset_id); END",
  "CREATE TRIGGER archive_content_proofread_manual_state_update AFTER UPDATE ON proofread_manual_state BEGIN INSERT INTO archive_content_heads SELECT literature_id,asset_id,version_json,part FROM archive_current_parts WHERE literature_id IN (SELECT literature_id FROM literature_assets WHERE asset_id=NEW.part_asset_id UNION SELECT literature_id FROM literature_assets WHERE asset_id=OLD.part_asset_id) ON CONFLICT(literature_id,asset_id) DO UPDATE SET source_json=excluded.source_json,part=excluded.part; DELETE FROM archive_content_heads WHERE literature_id IN (SELECT literature_id FROM literature_assets WHERE asset_id=NEW.part_asset_id UNION SELECT literature_id FROM literature_assets WHERE asset_id=OLD.part_asset_id) AND NOT EXISTS(SELECT 1 FROM archive_current_parts p WHERE p.literature_id=archive_content_heads.literature_id AND p.asset_id=archive_content_heads.asset_id); END",
  "CREATE TRIGGER archive_content_proofread_manual_state_delete AFTER DELETE ON proofread_manual_state BEGIN INSERT INTO archive_content_heads SELECT literature_id,asset_id,version_json,part FROM archive_current_parts WHERE literature_id IN (SELECT literature_id FROM literature_assets WHERE asset_id=OLD.part_asset_id) ON CONFLICT(literature_id,asset_id) DO UPDATE SET source_json=excluded.source_json,part=excluded.part; DELETE FROM archive_content_heads WHERE literature_id IN (SELECT literature_id FROM literature_assets WHERE asset_id=OLD.part_asset_id) AND NOT EXISTS(SELECT 1 FROM archive_current_parts p WHERE p.literature_id=archive_content_heads.literature_id AND p.asset_id=archive_content_heads.asset_id); END",
  "CREATE TRIGGER archive_content_raw_parse_current_insert AFTER INSERT ON raw_parse_current BEGIN INSERT INTO archive_content_heads SELECT literature_id,asset_id,version_json,part FROM archive_current_parts WHERE literature_id IN (SELECT literature_id FROM literature_assets WHERE asset_id=NEW.source_asset_id) ON CONFLICT(literature_id,asset_id) DO UPDATE SET source_json=excluded.source_json,part=excluded.part; DELETE FROM archive_content_heads WHERE literature_id IN (SELECT literature_id FROM literature_assets WHERE asset_id=NEW.source_asset_id) AND NOT EXISTS(SELECT 1 FROM archive_current_parts p WHERE p.literature_id=archive_content_heads.literature_id AND p.asset_id=archive_content_heads.asset_id); END",
  "CREATE TRIGGER archive_content_raw_parse_current_update AFTER UPDATE ON raw_parse_current BEGIN INSERT INTO archive_content_heads SELECT literature_id,asset_id,version_json,part FROM archive_current_parts WHERE literature_id IN (SELECT literature_id FROM literature_assets WHERE asset_id=NEW.source_asset_id UNION SELECT literature_id FROM literature_assets WHERE asset_id=OLD.source_asset_id) ON CONFLICT(literature_id,asset_id) DO UPDATE SET source_json=excluded.source_json,part=excluded.part; DELETE FROM archive_content_heads WHERE literature_id IN (SELECT literature_id FROM literature_assets WHERE asset_id=NEW.source_asset_id UNION SELECT literature_id FROM literature_assets WHERE asset_id=OLD.source_asset_id) AND NOT EXISTS(SELECT 1 FROM archive_current_parts p WHERE p.literature_id=archive_content_heads.literature_id AND p.asset_id=archive_content_heads.asset_id); END",
  "CREATE TRIGGER archive_content_raw_parse_current_delete AFTER DELETE ON raw_parse_current BEGIN INSERT INTO archive_content_heads SELECT literature_id,asset_id,version_json,part FROM archive_current_parts WHERE literature_id IN (SELECT literature_id FROM literature_assets WHERE asset_id=OLD.source_asset_id) ON CONFLICT(literature_id,asset_id) DO UPDATE SET source_json=excluded.source_json,part=excluded.part; DELETE FROM archive_content_heads WHERE literature_id IN (SELECT literature_id FROM literature_assets WHERE asset_id=OLD.source_asset_id) AND NOT EXISTS(SELECT 1 FROM archive_current_parts p WHERE p.literature_id=archive_content_heads.literature_id AND p.asset_id=archive_content_heads.asset_id); END",
  "CREATE TRIGGER archive_description_literature_metadata_insert AFTER INSERT ON literature_metadata BEGIN INSERT INTO archive_description_heads SELECT literature_id,version_json FROM archive_current_descriptions WHERE literature_id IN (SELECT NEW.literature_id) ON CONFLICT(literature_id) DO UPDATE SET source_json=excluded.source_json; DELETE FROM archive_description_heads WHERE literature_id IN (SELECT NEW.literature_id) AND NOT EXISTS(SELECT 1 FROM literature_metadata m WHERE m.literature_id=archive_description_heads.literature_id); END",
  "CREATE TRIGGER archive_description_literature_metadata_update AFTER UPDATE ON literature_metadata BEGIN INSERT INTO archive_description_heads SELECT literature_id,version_json FROM archive_current_descriptions WHERE literature_id IN (SELECT NEW.literature_id) ON CONFLICT(literature_id) DO UPDATE SET source_json=excluded.source_json; DELETE FROM archive_description_heads WHERE literature_id IN (SELECT NEW.literature_id) AND NOT EXISTS(SELECT 1 FROM literature_metadata m WHERE m.literature_id=archive_description_heads.literature_id); END",
  "CREATE TRIGGER archive_description_literature_metadata_delete AFTER DELETE ON literature_metadata BEGIN INSERT INTO archive_description_heads SELECT literature_id,version_json FROM archive_current_descriptions WHERE literature_id IN (SELECT OLD.literature_id) ON CONFLICT(literature_id) DO UPDATE SET source_json=excluded.source_json; DELETE FROM archive_description_heads WHERE literature_id IN (SELECT OLD.literature_id) AND NOT EXISTS(SELECT 1 FROM literature_metadata m WHERE m.literature_id=archive_description_heads.literature_id); END",
  "CREATE TRIGGER archive_description_literature_tag_assignments_insert AFTER INSERT ON literature_tag_assignments BEGIN INSERT INTO archive_description_heads SELECT literature_id,version_json FROM archive_current_descriptions WHERE literature_id IN (SELECT NEW.literature_id) ON CONFLICT(literature_id) DO UPDATE SET source_json=excluded.source_json; DELETE FROM archive_description_heads WHERE literature_id IN (SELECT NEW.literature_id) AND NOT EXISTS(SELECT 1 FROM literature_metadata m WHERE m.literature_id=archive_description_heads.literature_id); END",
  "CREATE TRIGGER archive_description_literature_tag_assignments_update AFTER UPDATE ON literature_tag_assignments BEGIN INSERT INTO archive_description_heads SELECT literature_id,version_json FROM archive_current_descriptions WHERE literature_id IN (SELECT NEW.literature_id) ON CONFLICT(literature_id) DO UPDATE SET source_json=excluded.source_json; DELETE FROM archive_description_heads WHERE literature_id IN (SELECT NEW.literature_id) AND NOT EXISTS(SELECT 1 FROM literature_metadata m WHERE m.literature_id=archive_description_heads.literature_id); END",
  "CREATE TRIGGER archive_description_literature_tag_assignments_delete AFTER DELETE ON literature_tag_assignments BEGIN INSERT INTO archive_description_heads SELECT literature_id,version_json FROM archive_current_descriptions WHERE literature_id IN (SELECT OLD.literature_id) ON CONFLICT(literature_id) DO UPDATE SET source_json=excluded.source_json; DELETE FROM archive_description_heads WHERE literature_id IN (SELECT OLD.literature_id) AND NOT EXISTS(SELECT 1 FROM literature_metadata m WHERE m.literature_id=archive_description_heads.literature_id); END",
  "CREATE TABLE raw_parse_attempts(attempt_id INTEGER PRIMARY KEY,asset_id TEXT NOT NULL,profile TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('published','reused','failed')),page_count INTEGER,elapsed_ms INTEGER NOT NULL CHECK(elapsed_ms>=0),raw_parse_id TEXT,failure_code TEXT,created_at TEXT NOT NULL,FOREIGN KEY(asset_id) REFERENCES assets(asset_id)) STRICT",
  "CREATE INDEX archive_document_material_lookup ON document_versions(literature_id,source_asset_id,source_sha256)",
  "CREATE INDEX raw_parse_pins_proofread_lookup ON raw_parse_pins(proofread_id)",
  "CREATE TABLE snapshots(snapshot_id TEXT NOT NULL PRIMARY KEY,created_at TEXT NOT NULL,definition_json TEXT NOT NULL,content_sha256 TEXT NOT NULL,member_count INTEGER NOT NULL CHECK(member_count>=0),excluded_count INTEGER NOT NULL CHECK(excluded_count>=0)) STRICT",
  "CREATE TABLE folders(folder_id TEXT NOT NULL PRIMARY KEY,parent_id TEXT,name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 128),position INTEGER NOT NULL CHECK(position>=0),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,FOREIGN KEY(parent_id) REFERENCES folders(folder_id) ON DELETE CASCADE,CHECK(parent_id IS NULL OR parent_id<>folder_id)) STRICT",
  "CREATE UNIQUE INDEX folders_sibling_name ON folders(COALESCE(parent_id,''),name)",
  "CREATE TABLE folder_members(folder_id TEXT NOT NULL,literature_id TEXT NOT NULL,added_at TEXT NOT NULL,actor TEXT NOT NULL,PRIMARY KEY(folder_id,literature_id),FOREIGN KEY(folder_id) REFERENCES folders(folder_id) ON DELETE CASCADE,FOREIGN KEY(literature_id) REFERENCES literatures(literature_id) ON DELETE CASCADE) STRICT",
  "CREATE INDEX folder_members_literature ON folder_members(literature_id,folder_id)",
  "CREATE TABLE reading_history(literature_id TEXT NOT NULL PRIMARY KEY,last_opened_at TEXT NOT NULL,open_count INTEGER NOT NULL CHECK(open_count>=1),FOREIGN KEY(literature_id) REFERENCES literatures(literature_id) ON DELETE CASCADE) STRICT",
  "CREATE INDEX reading_history_opened ON reading_history(last_opened_at DESC,literature_id)",
  "CREATE TABLE snapshot_labels(snapshot_id TEXT NOT NULL PRIMARY KEY,name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 256),updated_at TEXT NOT NULL,actor TEXT NOT NULL,FOREIGN KEY(snapshot_id) REFERENCES snapshots(snapshot_id) ON DELETE CASCADE) STRICT",
  "CREATE TABLE snapshot_members(snapshot_id TEXT NOT NULL,literature_id TEXT NOT NULL,ordinal INTEGER NOT NULL,member_sha256 TEXT NOT NULL,member_json TEXT NOT NULL,PRIMARY KEY(snapshot_id,literature_id),UNIQUE(snapshot_id,ordinal),FOREIGN KEY(snapshot_id) REFERENCES snapshots(snapshot_id),FOREIGN KEY(literature_id) REFERENCES literatures(literature_id)) STRICT",
  "CREATE TABLE processor_result_freshness(result_id TEXT NOT NULL PRIMARY KEY,state TEXT NOT NULL CHECK(state IN ('current','stale')),FOREIGN KEY(result_id) REFERENCES processor_results(result_id) ON DELETE CASCADE) STRICT",
  "CREATE TABLE processor_result_archive_scopes(result_id TEXT NOT NULL,literature_id TEXT NOT NULL,parts TEXT NOT NULL CHECK(parts IN ('main','supplementary','all','none')),uses_description INTEGER NOT NULL CHECK(uses_description IN (0,1)),description_version TEXT NOT NULL,PRIMARY KEY(result_id,literature_id),FOREIGN KEY(result_id) REFERENCES processor_results(result_id) ON DELETE CASCADE) STRICT",
  "CREATE TABLE processor_result_archive_parts(result_id TEXT NOT NULL,literature_id TEXT NOT NULL,asset_id TEXT NOT NULL,part TEXT NOT NULL,source_json TEXT,PRIMARY KEY(result_id,literature_id,asset_id),FOREIGN KEY(result_id,literature_id) REFERENCES processor_result_archive_scopes(result_id,literature_id) ON DELETE CASCADE) STRICT",
  "CREATE TABLE processor_result_freshness_reasons(result_id TEXT NOT NULL,reason_key TEXT NOT NULL,event_sequence INTEGER,literature_id TEXT NOT NULL,asset_id TEXT,kind TEXT NOT NULL,old_json TEXT,new_json TEXT,expected_version TEXT,PRIMARY KEY(result_id,reason_key),FOREIGN KEY(result_id) REFERENCES processor_results(result_id) ON DELETE CASCADE) STRICT",
  "CREATE INDEX processor_freshness_event_lookup ON processor_result_freshness_reasons(event_sequence,result_id)",
  "CREATE INDEX processor_scope_literature_lookup ON processor_result_archive_scopes(literature_id,parts)",
  "CREATE TRIGGER processor_consume_archive_event AFTER INSERT ON archive_version_events BEGIN INSERT OR IGNORE INTO processor_result_freshness_reasons SELECT s.result_id,'event:'||NEW.sequence,NEW.sequence,NEW.literature_id,NEW.asset_id,NEW.kind,NEW.old_json,NEW.new_json,NULL FROM processor_result_archive_scopes s WHERE s.literature_id=NEW.literature_id AND ((NEW.kind='description-version-changed' AND s.uses_description=1) OR (NEW.kind='content-version-changed' AND (s.parts='all' OR s.parts=NEW.old_part OR s.parts=NEW.new_part) AND (NEW.old_part IS NULL OR NEW.new_part IS NULL OR NEW.old_part IS NOT NEW.new_part OR (SELECT p.source_json FROM processor_result_archive_parts p WHERE p.result_id=s.result_id AND p.literature_id=s.literature_id AND p.asset_id=NEW.asset_id) IS NOT NEW.new_json))); UPDATE processor_result_freshness SET state='stale' WHERE result_id IN (SELECT result_id FROM processor_result_freshness_reasons WHERE event_sequence=NEW.sequence); END",
  "CREATE TABLE operation_records(sequence INTEGER PRIMARY KEY,operation_id TEXT NOT NULL UNIQUE,actor TEXT NOT NULL,operation TEXT NOT NULL,scope_json TEXT NOT NULL,result_json TEXT,status TEXT NOT NULL CHECK(status IN ('running','completed','failed')),created_at TEXT NOT NULL,finished_at TEXT) STRICT",
  "CREATE INDEX operation_records_actor ON operation_records(actor,sequence)",
  "CREATE TABLE job_origins(job_id TEXT NOT NULL PRIMARY KEY,actor TEXT NOT NULL,operation TEXT NOT NULL,created_at TEXT NOT NULL) STRICT",
  "CREATE TABLE agent_sessions(session_id TEXT PRIMARY KEY,role TEXT NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,actor TEXT NOT NULL,job_id TEXT,literature_id TEXT,subject_json TEXT NOT NULL,status TEXT NOT NULL,started_at TEXT NOT NULL,finished_at TEXT,calls INTEGER NOT NULL DEFAULT 0,input_tokens INTEGER NOT NULL DEFAULT 0,output_tokens INTEGER NOT NULL DEFAULT 0,event_bytes INTEGER NOT NULL DEFAULT 0,truncated INTEGER NOT NULL DEFAULT 0) STRICT",
  "CREATE INDEX agent_sessions_job ON agent_sessions(job_id,started_at)",
  "CREATE INDEX agent_sessions_literature ON agent_sessions(literature_id,started_at)",
  "CREATE TABLE agent_session_events(sequence INTEGER PRIMARY KEY,session_id TEXT NOT NULL,kind TEXT NOT NULL,payload_json TEXT NOT NULL,created_at TEXT NOT NULL,truncated INTEGER NOT NULL,FOREIGN KEY(session_id) REFERENCES agent_sessions(session_id) ON DELETE CASCADE) STRICT",
  "CREATE INDEX agent_session_events_session ON agent_session_events(session_id,sequence)",
  "CREATE TABLE agent_view_revision(singleton INTEGER PRIMARY KEY CHECK(singleton=1),revision INTEGER NOT NULL) STRICT",
  "CREATE TRIGGER agent_revision_insert AFTER INSERT ON agent_sessions BEGIN INSERT INTO agent_view_revision VALUES(1,1) ON CONFLICT(singleton) DO UPDATE SET revision=revision+1; END",
  "CREATE TRIGGER agent_revision_update AFTER UPDATE ON agent_sessions BEGIN INSERT INTO agent_view_revision VALUES(1,1) ON CONFLICT(singleton) DO UPDATE SET revision=revision+1; END",
  "CREATE TRIGGER agent_revision_delete AFTER DELETE ON agent_sessions BEGIN INSERT INTO agent_view_revision VALUES(1,1) ON CONFLICT(singleton) DO UPDATE SET revision=revision+1; END",
  "CREATE TABLE task_steps(job_id TEXT NOT NULL,literature_id TEXT NOT NULL,asset_id TEXT NOT NULL,step TEXT NOT NULL,status TEXT NOT NULL,reason TEXT,calls INTEGER NOT NULL,input_tokens INTEGER NOT NULL,output_tokens INTEGER NOT NULL,elapsed_ms INTEGER NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(job_id,literature_id,asset_id,step)) STRICT",
  "CREATE TABLE task_model_usage(job_id TEXT NOT NULL,literature_id TEXT NOT NULL,role TEXT NOT NULL,calls INTEGER NOT NULL,input_tokens INTEGER NOT NULL,output_tokens INTEGER NOT NULL,PRIMARY KEY(job_id,literature_id,role)) STRICT",
  "CREATE TRIGGER task_view_event AFTER INSERT ON execution_events BEGIN INSERT INTO agent_view_revision VALUES(1,1) ON CONFLICT(singleton) DO UPDATE SET revision=revision+1; END",
  "CREATE TRIGGER task_view_state AFTER UPDATE ON execution_jobs BEGIN INSERT INTO agent_view_revision VALUES(1,1) ON CONFLICT(singleton) DO UPDATE SET revision=revision+1; END",
  "CREATE TRIGGER task_view_step AFTER INSERT ON task_steps BEGIN INSERT INTO agent_view_revision VALUES(1,1) ON CONFLICT(singleton) DO UPDATE SET revision=revision+1; END",
  "CREATE TRIGGER task_view_step_update AFTER UPDATE ON task_steps BEGIN INSERT INTO agent_view_revision VALUES(1,1) ON CONFLICT(singleton) DO UPDATE SET revision=revision+1; END",
  "CREATE INDEX task_event_target ON execution_events(job_id,json_extract(payload_json,'$.target_id'),sequence)",
  "CREATE TABLE processor_result_summaries(result_id TEXT PRIMARY KEY,usage_json TEXT,outcomes_json TEXT NOT NULL, method_revision TEXT,FOREIGN KEY(result_id) REFERENCES processor_results(result_id) ON DELETE CASCADE) STRICT",
  `CREATE VIEW processor_result_currentness AS SELECT f.result_id,CASE WHEN COALESCE(s.method_revision,'legacy')='${PROCESSOR_METHOD_REVISION}' THEN f.state ELSE 'stale' END AS state FROM processor_result_freshness f LEFT JOIN processor_result_summaries s USING(result_id)`,
  "CREATE TABLE processor_run_requests(job_id TEXT PRIMARY KEY,request_json TEXT NOT NULL) STRICT",
  ...LIBRARY_PERFORMANCE_SCHEMA,
] as const;
export const SCHEMA_FINGERPRINT_V13 = createHash("sha256")
  .update(JSON.stringify(SCHEMA_MANIFEST_V13))
  .digest("hex");
/**
 * Reading marks (ADR 0046): user data on one paper. The PDF anchor and the
 * full-text anchor are each optional but never half-filled; a region always
 * lives on a PDF page. No foreign key on the document version: the quote can
 * place a mark again when versions change.
 */
export const READING_MARKS_SCHEMA = [
  "CREATE TABLE reading_marks(mark_id TEXT NOT NULL PRIMARY KEY CHECK(length(mark_id)=36),literature_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('highlight','region')),color TEXT NOT NULL CHECK(color IN ('yellow','blue','green','red','purple')),note TEXT NOT NULL CHECK(length(note)<=20000),quote TEXT NOT NULL CHECK(length(quote)<=4000),quote_prefix TEXT NOT NULL CHECK(length(quote_prefix)<=200),quote_suffix TEXT NOT NULL CHECK(length(quote_suffix)<=200),pdf_sha256 TEXT CHECK(pdf_sha256 IS NULL OR (length(pdf_sha256)=64 AND pdf_sha256=lower(pdf_sha256) AND pdf_sha256 NOT GLOB '*[^0-9a-f]*')),pdf_page INTEGER CHECK(pdf_page IS NULL OR pdf_page>=1),pdf_rects_json TEXT CHECK(pdf_rects_json IS NULL OR json_valid(pdf_rects_json)),document_version_id TEXT,document_start_utf8 INTEGER,document_end_utf8 INTEGER,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT,actor TEXT NOT NULL,CHECK((pdf_sha256 IS NULL)=(pdf_page IS NULL) AND (pdf_page IS NULL)=(pdf_rects_json IS NULL)),CHECK((document_version_id IS NULL)=(document_start_utf8 IS NULL) AND (document_start_utf8 IS NULL)=(document_end_utf8 IS NULL) AND (document_start_utf8 IS NULL OR (document_start_utf8>=0 AND document_end_utf8>document_start_utf8))),CHECK(pdf_page IS NOT NULL OR document_version_id IS NOT NULL),CHECK(kind='highlight' OR pdf_page IS NOT NULL),FOREIGN KEY(literature_id) REFERENCES literatures(literature_id) ON DELETE CASCADE) STRICT",
  "CREATE INDEX reading_marks_literature ON reading_marks(literature_id,deleted_at,created_at)",
] as const;
export const SCHEMA_MANIFEST_V14 = [
  ...SCHEMA_MANIFEST_V13.map((sql) =>
    sql.replace("CHECK(schema_version=13)", "CHECK(schema_version=14)"),
  ),
  ...READING_MARKS_SCHEMA,
] as const;
export const SCHEMA_FINGERPRINT_V14 = createHash("sha256")
  .update(JSON.stringify(SCHEMA_MANIFEST_V14))
  .digest("hex");

/** Durable acquisition cohorts and provider-neutral classification terms. */
export const INTAKE_SCHEMA = [
  "CREATE TABLE intake_batches(batch_id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('topic','citation','import','legacy')),default_label TEXT NOT NULL,label TEXT CHECK(label IS NULL OR length(trim(label)) BETWEEN 1 AND 120),origin TEXT NOT NULL CHECK(origin IN ('web','cli','mcp','migration')),created_at TEXT NOT NULL,finished_at TEXT,status TEXT NOT NULL CHECK(status IN ('running','completed','partial','failed','interrupted')),request_json TEXT NOT NULL CHECK(json_valid(request_json)),discovery_run_id TEXT UNIQUE,rejected INTEGER NOT NULL DEFAULT 0 CHECK(rejected>=0),source_failures INTEGER NOT NULL DEFAULT 0 CHECK(source_failures>=0),owner_pid INTEGER,FOREIGN KEY(discovery_run_id) REFERENCES discovery_runs(discovery_run_id) ON DELETE RESTRICT) STRICT",
  "CREATE INDEX intake_batches_order ON intake_batches(created_at DESC,batch_id DESC)",
  "CREATE TABLE intake_batch_members(batch_id TEXT NOT NULL,literature_id TEXT NOT NULL,disposition TEXT NOT NULL CHECK(disposition IN ('created','enriched','matched','legacy')),PRIMARY KEY(batch_id,literature_id),FOREIGN KEY(batch_id) REFERENCES intake_batches(batch_id) ON DELETE CASCADE,FOREIGN KEY(literature_id) REFERENCES literatures(literature_id) ON DELETE CASCADE ON UPDATE CASCADE) STRICT",
  "CREATE INDEX intake_batch_members_literature ON intake_batch_members(literature_id,batch_id)",
  "CREATE TABLE literature_metadata_subject_terms(literature_id TEXT NOT NULL,ordinal INTEGER NOT NULL CHECK(ordinal>=0 AND ordinal<8),term TEXT NOT NULL CHECK(length(trim(term))>0),normalized_term TEXT NOT NULL,PRIMARY KEY(literature_id,ordinal),UNIQUE(literature_id,normalized_term),FOREIGN KEY(literature_id) REFERENCES literature_metadata(literature_id) ON DELETE CASCADE) STRICT",
  "CREATE INDEX literature_subject_terms_normalized ON literature_metadata_subject_terms(normalized_term,literature_id,term)",
  "CREATE TABLE metadata_observation_subject_terms(observation_id TEXT NOT NULL,ordinal INTEGER NOT NULL CHECK(ordinal>=0),term TEXT NOT NULL CHECK(length(trim(term))>0),PRIMARY KEY(observation_id,ordinal),FOREIGN KEY(observation_id) REFERENCES metadata_observations(observation_id) ON DELETE CASCADE) STRICT",
  ...["INSERT", "UPDATE", "DELETE"].map(
    (event) =>
      `CREATE TRIGGER retrieval_revision_subject_terms_${event.toLowerCase()} AFTER ${event} ON literature_metadata_subject_terms BEGIN UPDATE retrieval_source_revision SET revision=revision+1 WHERE singleton=1; END`,
  ),
] as const;
export const SCHEMA_MANIFEST_V15 = [
  ...SCHEMA_MANIFEST_V14.map((sql) =>
    sql.replace("CHECK(schema_version=14)", "CHECK(schema_version=15)"),
  ),
  ...INTAKE_SCHEMA,
] as const;
export const SCHEMA_FINGERPRINT_V15 = createHash("sha256")
  .update(JSON.stringify(SCHEMA_MANIFEST_V15))
  .digest("hex");

export const DEVICE_CONNECTION_SCHEMA = [
  "CREATE TABLE device_connections(connection_id TEXT PRIMARY KEY,name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 120),purposes_json TEXT NOT NULL CHECK(json_valid(purposes_json)),token_sha256 TEXT UNIQUE CHECK(token_sha256 IS NULL OR length(token_sha256)=64),created_at TEXT NOT NULL,paired_at TEXT,last_used_at TEXT,revoked_at TEXT) STRICT",
  "CREATE TABLE device_pairings(code_sha256 TEXT PRIMARY KEY CHECK(length(code_sha256)=64),connection_id TEXT NOT NULL UNIQUE,expires_at TEXT NOT NULL,used_at TEXT,FOREIGN KEY(connection_id) REFERENCES device_connections(connection_id) ON DELETE CASCADE) STRICT",
  "CREATE TABLE device_exchange_limits(bucket TEXT PRIMARY KEY,window_start INTEGER NOT NULL,attempts INTEGER NOT NULL CHECK(attempts>0)) STRICT",
  "CREATE INDEX device_exchange_limits_window ON device_exchange_limits(window_start)",
] as const;
export const INTAKE_SCHEMA_V16 = [
  "CREATE TABLE intake_batches(batch_id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('topic','citation','import','legacy')),default_label TEXT NOT NULL,label TEXT CHECK(label IS NULL OR length(trim(label)) BETWEEN 1 AND 120),origin TEXT NOT NULL CHECK(origin IN ('web','cli','mcp','migration')),created_at TEXT NOT NULL,finished_at TEXT,state TEXT NOT NULL CHECK(state IN ('collecting','awaiting-confirmation','running','finished','cancelled','withdrawn')),result TEXT CHECK(result IS NULL OR result IN ('completed','partial','failed','interrupted')),confirmation TEXT CHECK(confirmation IS NULL OR confirmation IN ('batch','per-item')),confirmed_at TEXT,initiated_by TEXT NOT NULL CHECK(initiated_by='migration' OR initiated_by IN ('local:web','local:cli','local:mcp') OR initiated_by GLOB 'device:*'),request_json TEXT NOT NULL CHECK(json_valid(request_json)),discovery_run_id TEXT UNIQUE,rejected INTEGER NOT NULL DEFAULT 0 CHECK(rejected>=0),source_failures INTEGER NOT NULL DEFAULT 0 CHECK(source_failures>=0),owner_pid INTEGER,CHECK((state='finished' AND result IS NOT NULL) OR state='withdrawn' OR (state NOT IN ('finished','withdrawn') AND result IS NULL)),FOREIGN KEY(discovery_run_id) REFERENCES discovery_runs(discovery_run_id) ON DELETE RESTRICT) STRICT",
  "CREATE INDEX intake_batches_order ON intake_batches(created_at DESC,batch_id DESC)",
  "CREATE TABLE intake_batch_members(batch_id TEXT NOT NULL,literature_id TEXT NOT NULL,disposition TEXT NOT NULL CHECK(disposition IN ('created','enriched','matched','restored','legacy')),PRIMARY KEY(batch_id,literature_id),FOREIGN KEY(batch_id) REFERENCES intake_batches(batch_id) ON DELETE CASCADE,FOREIGN KEY(literature_id) REFERENCES literatures(literature_id) ON DELETE CASCADE ON UPDATE CASCADE) STRICT",
  "CREATE INDEX intake_batch_members_literature ON intake_batch_members(literature_id,batch_id)",
] as const;
export const IMPORT_SESSION_SCHEMA = [
  "CREATE TABLE import_libraries(library_key TEXT PRIMARY KEY,system TEXT NOT NULL,external_library_id TEXT NOT NULL,identity_scope TEXT NOT NULL,name TEXT NOT NULL,created_at TEXT NOT NULL) STRICT",
  "CREATE TABLE external_object_mappings(library_key TEXT NOT NULL,object_kind TEXT NOT NULL CHECK(object_kind IN ('record','group','file','annotation')),external_id TEXT NOT NULL,internal_id TEXT NOT NULL,content_sha256 TEXT,observation_id TEXT,state TEXT NOT NULL DEFAULT 'settled' CHECK(state IN ('pending','settled')),PRIMARY KEY(library_key,object_kind,external_id),FOREIGN KEY(library_key) REFERENCES import_libraries(library_key) ON DELETE RESTRICT) STRICT",
  "CREATE TABLE import_sessions(batch_id TEXT PRIMARY KEY,library_key TEXT NOT NULL,library_json TEXT NOT NULL CHECK(json_valid(library_json)),format TEXT NOT NULL,scope TEXT NOT NULL,file_name TEXT,import_user_tags INTEGER NOT NULL CHECK(import_user_tags IN (0,1)),active INTEGER NOT NULL CHECK(active IN (0,1)),phase TEXT NOT NULL DEFAULT 'metadata' CHECK(phase IN ('metadata','files','closing')),storage_failures INTEGER NOT NULL DEFAULT 0 CHECK(storage_failures>=0),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,last_file_at TEXT,metadata_complete INTEGER NOT NULL DEFAULT 0 CHECK(metadata_complete IN (0,1)),record_count INTEGER NOT NULL DEFAULT 0 CHECK(record_count>=0),summary_json TEXT CHECK(summary_json IS NULL OR json_valid(summary_json)),FOREIGN KEY(library_key) REFERENCES import_libraries(library_key),FOREIGN KEY(batch_id) REFERENCES intake_batches(batch_id) ON DELETE CASCADE) STRICT",
  "CREATE UNIQUE INDEX import_sessions_active_library ON import_sessions(library_key) WHERE active=1",
  "CREATE INDEX import_sessions_order ON import_sessions(created_at DESC,batch_id DESC)",
  "CREATE INDEX import_sessions_expiry ON import_sessions(active,created_at,last_file_at)",
  "CREATE TABLE intake_items(item_id TEXT PRIMARY KEY,batch_id TEXT NOT NULL,origin TEXT NOT NULL CHECK(origin IN ('data','file','page')),sequence INTEGER CHECK(sequence IS NULL OR sequence>=0),record_index INTEGER CHECK(record_index IS NULL OR record_index>=0),external_id TEXT,title TEXT,file_name TEXT,candidate_transfer_id TEXT,recognition_json TEXT CHECK(recognition_json IS NULL OR json_valid(recognition_json)),possible_duplicates_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(possible_duplicates_json)),unpaired INTEGER NOT NULL DEFAULT 0 CHECK(unpaired IN (0,1)),needs_decision INTEGER NOT NULL DEFAULT 0 CHECK(needs_decision IN (0,1)),decision_json TEXT CHECK(decision_json IS NULL OR json_valid(decision_json)),decided_by TEXT,decided_at TEXT,disposition TEXT CHECK(disposition IS NULL OR disposition IN ('created','enriched','matched','restored','conflict','rejected','pending-decision','excluded')),literature_id TEXT,retain_until TEXT,created_at TEXT NOT NULL,UNIQUE(batch_id,sequence,record_index),FOREIGN KEY(batch_id) REFERENCES intake_batches(batch_id) ON DELETE CASCADE,FOREIGN KEY(literature_id) REFERENCES literatures(literature_id) ON DELETE SET NULL ON UPDATE CASCADE,FOREIGN KEY(candidate_transfer_id) REFERENCES execution_candidates(transfer_id) ON DELETE RESTRICT) STRICT",
  "CREATE INDEX intake_items_batch ON intake_items(batch_id,item_id)",
  "CREATE INDEX intake_items_retention ON intake_items(retain_until) WHERE retain_until IS NOT NULL",
  "CREATE TABLE import_parts(batch_id TEXT NOT NULL,sequence INTEGER NOT NULL CHECK(sequence>=0 AND sequence<1024),artifact_id TEXT NOT NULL,record_count INTEGER NOT NULL CHECK(record_count>=0),PRIMARY KEY(batch_id,sequence),FOREIGN KEY(batch_id) REFERENCES import_sessions(batch_id) ON DELETE CASCADE,FOREIGN KEY(artifact_id) REFERENCES artifact_objects(artifact_id) ON DELETE RESTRICT) STRICT",
  "CREATE TABLE import_staged_keys(batch_id TEXT NOT NULL,object_kind TEXT NOT NULL,external_id TEXT NOT NULL,sequence INTEGER NOT NULL,PRIMARY KEY(batch_id,object_kind,external_id),FOREIGN KEY(batch_id,sequence) REFERENCES import_parts(batch_id,sequence) ON DELETE CASCADE) STRICT",
  "CREATE TABLE import_record_results(batch_id TEXT NOT NULL,sequence INTEGER NOT NULL,record_index INTEGER NOT NULL,item_id TEXT NOT NULL,external_id TEXT NOT NULL,disposition TEXT NOT NULL CHECK(disposition IN ('created','enriched','matched','restored','conflict','rejected','pending-decision','excluded')),literature_id TEXT,meta_literature_id TEXT,reason TEXT,PRIMARY KEY(batch_id,sequence,record_index),UNIQUE(item_id),FOREIGN KEY(batch_id) REFERENCES import_sessions(batch_id) ON DELETE CASCADE,FOREIGN KEY(item_id) REFERENCES intake_items(item_id) ON DELETE CASCADE,FOREIGN KEY(literature_id) REFERENCES literatures(literature_id) ON DELETE SET NULL ON UPDATE CASCADE) STRICT",
  "CREATE TABLE import_files(file_id TEXT PRIMARY KEY,batch_id TEXT NOT NULL,item_id TEXT,external_id TEXT NOT NULL,record_external_id TEXT NOT NULL,literature_id TEXT NOT NULL,file_name TEXT NOT NULL,size_bytes INTEGER CHECK(size_bytes IS NULL OR size_bytes>=0),expected_sha256 TEXT CHECK(expected_sha256 IS NULL OR length(expected_sha256)=64),action TEXT NOT NULL CHECK(action IN ('upload','hash')),status TEXT NOT NULL CHECK(status IN ('pending','uploaded','existing','conflict')),sha256 TEXT CHECK(sha256 IS NULL OR length(sha256)=64),reason TEXT,source_url TEXT,UNIQUE(batch_id,external_id),FOREIGN KEY(batch_id) REFERENCES import_sessions(batch_id) ON DELETE CASCADE,FOREIGN KEY(item_id) REFERENCES intake_items(item_id) ON DELETE CASCADE,FOREIGN KEY(literature_id) REFERENCES literatures(literature_id) ON DELETE CASCADE ON UPDATE CASCADE) STRICT",
  "CREATE INDEX import_files_pending ON import_files(batch_id,status,file_id)",
  "CREATE TABLE intake_open_batches(opener TEXT NOT NULL CHECK(opener GLOB 'device:*' OR opener IN ('supplement:web','supplement:cli','supplement:mcp')),day TEXT NOT NULL CHECK(length(day)=10),batch_id TEXT NOT NULL UNIQUE,PRIMARY KEY(opener,day),FOREIGN KEY(batch_id) REFERENCES intake_batches(batch_id) ON DELETE CASCADE) STRICT",
  "CREATE TABLE intake_page_requests(connection_id TEXT NOT NULL,request_id TEXT NOT NULL,request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64),item_id TEXT NOT NULL UNIQUE,batch_id TEXT NOT NULL,result_json TEXT CHECK(result_json IS NULL OR (json_valid(result_json) AND length(CAST(result_json AS BLOB))<=65536)),PRIMARY KEY(connection_id,request_id),FOREIGN KEY(connection_id) REFERENCES device_connections(connection_id) ON DELETE RESTRICT,FOREIGN KEY(item_id) REFERENCES intake_items(item_id) ON DELETE CASCADE,FOREIGN KEY(batch_id) REFERENCES intake_batches(batch_id) ON DELETE CASCADE) STRICT",
  "CREATE TABLE literature_needs_metadata(literature_id TEXT PRIMARY KEY,set_at TEXT NOT NULL,batch_id TEXT,FOREIGN KEY(literature_id) REFERENCES literatures(literature_id) ON DELETE CASCADE ON UPDATE CASCADE,FOREIGN KEY(batch_id) REFERENCES intake_batches(batch_id) ON DELETE SET NULL) STRICT",
  "CREATE TABLE intake_batch_objects(object_kind TEXT NOT NULL CHECK(object_kind IN ('folder','folder-member','literature-asset','mark')),object_id TEXT NOT NULL,batch_id TEXT NOT NULL,PRIMARY KEY(object_kind,object_id),FOREIGN KEY(batch_id) REFERENCES intake_batches(batch_id) ON DELETE CASCADE) STRICT",
  "CREATE INDEX intake_batch_objects_batch ON intake_batch_objects(batch_id)",
  "CREATE TABLE intake_withdrawals(batch_id TEXT PRIMARY KEY,prior_state TEXT NOT NULL CHECK(prior_state IN ('finished','cancelled')),withdrawn_at TEXT NOT NULL,withdrawn_by TEXT NOT NULL,restored_at TEXT,report_json TEXT NOT NULL CHECK(json_valid(report_json)),restoration_json TEXT CHECK(restoration_json IS NULL OR json_valid(restoration_json)),FOREIGN KEY(batch_id) REFERENCES intake_batches(batch_id) ON DELETE CASCADE) STRICT",
  "CREATE TABLE intake_withdrawn_objects(object_kind TEXT NOT NULL CHECK(object_kind IN ('literature','literature-asset','folder','folder-member','mark')),object_id TEXT NOT NULL,batch_id TEXT NOT NULL,withdrawn_at TEXT NOT NULL,PRIMARY KEY(object_kind,object_id),FOREIGN KEY(batch_id) REFERENCES intake_batches(batch_id) ON DELETE CASCADE) STRICT",
  "CREATE INDEX intake_withdrawn_objects_batch ON intake_withdrawn_objects(batch_id)",
] as const;
/** The single M1 15 -> 16 migration, including all accepted intake DDL. */
export const IMPORT_SCHEMA_V16 = [
  ...INTAKE_SCHEMA_V16,
  ...DEVICE_CONNECTION_SCHEMA,
  ...IMPORT_SESSION_SCHEMA,
] as const;
export const SCHEMA_MANIFEST_V16 = [
  ...SCHEMA_MANIFEST_V15.filter(
    (sql) =>
      !/^CREATE (?:TABLE intake_batches\(|INDEX intake_batches_order |INDEX intake_batch_members_literature |TABLE intake_batch_members\()/u.test(
        sql,
      ),
  ).map((sql) => {
    const next = sql.replace(
      "CHECK(schema_version=15)",
      "CHECK(schema_version=16)",
    );
    // A mutable current processor method must not redefine the offline v16 input.
    return next.startsWith("CREATE VIEW processor_result_currentness ")
      ? next.replace(
          "'" + PROCESSOR_METHOD_REVISION + "'",
          "'text-evidence-hierarchical-v2'",
        )
      : next;
  }),
  ...IMPORT_SCHEMA_V16,
] as const;
export const SCHEMA_FINGERPRINT_V16 = createHash("sha256")
  .update(JSON.stringify(SCHEMA_MANIFEST_V16))
  .digest("hex");

const nullableDraftHash = (name: string) =>
  `${name} TEXT CHECK(${name} IS NULL OR (length(${name})=64 AND ${name}=lower(${name}) AND ${name} NOT GLOB '*[^0-9a-f]*'))`;
const draftColumns = [
  "raw_parse_id TEXT",
  nullableDraftHash("raw_parse_result_sha256"),
  nullableDraftHash("page_layer_sha256"),
  nullableDraftHash("draft_method_sha256"),
  "draft_content_artifact_path TEXT",
  nullableDraftHash("draft_content_sha256"),
  "draft_content_byte_size INTEGER CHECK(draft_content_byte_size IS NULL OR draft_content_byte_size>0)",
  "draft_content_media_type TEXT CHECK(draft_content_media_type IS NULL OR draft_content_media_type='application/json')",
];
const draftColumnNames = draftColumns.map((column) => column.split(" ")[0]!);
const draftPairCheck = `CHECK((schema_version=2 AND proofread_id IS NOT NULL AND proofread_content_sha256 IS NOT NULL AND ${draftColumnNames.map((name) => `${name} IS NULL`).join(" AND ")}) OR (schema_version=3 AND proofread_id IS NULL AND proofread_content_sha256 IS NULL AND ${draftColumnNames.map((name) => `${name} IS NOT NULL`).join(" AND ")}))`;

/** New DDL only; the frozen v16 manifest remains the exact offline input. */
export const DRAFT_TEXT_SCHEMA_V17 = [
  "CREATE TABLE draft_current(part_asset_id TEXT NOT NULL PRIMARY KEY,part_sha256 TEXT NOT NULL,document_version_id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),FOREIGN KEY(document_version_id,part_asset_id,part_sha256) REFERENCES document_versions(document_version_id,source_asset_id,source_sha256) ON DELETE RESTRICT) STRICT",
  "CREATE TABLE draft_version_facts(document_version_id TEXT NOT NULL PRIMARY KEY,differs_segments INTEGER NOT NULL CHECK(differs_segments>=0),differences INTEGER NOT NULL CHECK(differences>=0),image_only_pages INTEGER NOT NULL CHECK(image_only_pages>=0),FOREIGN KEY(document_version_id) REFERENCES document_versions(document_version_id) ON DELETE RESTRICT) STRICT",
  "CREATE TABLE processor_unfound_citations(result_id TEXT NOT NULL,record_id TEXT NOT NULL CHECK(length(trim(record_id))>0),pointer TEXT NOT NULL,document_version_id TEXT NOT NULL,PRIMARY KEY(result_id,record_id,pointer,document_version_id),FOREIGN KEY(result_id) REFERENCES processor_results(result_id) ON DELETE CASCADE,FOREIGN KEY(document_version_id) REFERENCES document_versions(document_version_id) ON DELETE RESTRICT) STRICT",
  "CREATE INDEX document_versions_raw_parse ON document_versions(raw_parse_id)",
  "CREATE INDEX processor_result_documents_version ON processor_result_documents(document_version_id,result_id)",
  "CREATE INDEX processor_unfound_citations_version ON processor_unfound_citations(document_version_id,result_id,record_id,pointer)",
  ...[
    "draft_current",
    "draft_version_facts",
    "processor_unfound_citations",
  ].flatMap((table) =>
    (table === "draft_version_facts" ? ["INSERT"] : ["INSERT", "UPDATE"]).map(
      (event) =>
        `CREATE TRIGGER ${table}_draft_${event.toLowerCase()} BEFORE ${event} ON ${table} WHEN NOT EXISTS(SELECT 1 FROM document_versions WHERE document_version_id=NEW.document_version_id AND schema_version=3) BEGIN SELECT RAISE(ABORT,'draft version required'); END`,
    ),
  ),
  "CREATE TRIGGER draft_version_facts_immutable BEFORE UPDATE ON draft_version_facts BEGIN SELECT RAISE(ABORT,'draft version facts are immutable'); END",
  ...["draft_current", "draft_version_facts"].flatMap((table) => {
    const source =
      table === "draft_current" ? "proofread_current" : "structure_annotations";
    return LIBRARY_STATE_SCHEMA.filter((sql) =>
      sql.startsWith("CREATE TRIGGER library_state_" + source + "_"),
    ).map((sql) => sql.replaceAll(source, table));
  }),
] as const;

export const SCHEMA_MANIFEST_V17 = [
  ...SCHEMA_MANIFEST_V16.map((sql) => {
    // V16 already pins the method used by deployed V17. Keep its SQL bytes
    // frozen when the current processor method changes in a later release.
    if (sql.startsWith("CREATE TABLE schema_identity("))
      return sql.replace(
        "CHECK(schema_version=16)",
        "CHECK(schema_version=17)",
      );
    if (sql.startsWith("CREATE TABLE document_versions("))
      return sql
        .replace("CHECK(schema_version=2)", "CHECK(schema_version IN (2,3))")
        .replace("proofread_id TEXT NOT NULL", "proofread_id TEXT")
        .replace(
          "proofread_content_sha256 TEXT NOT NULL",
          "proofread_content_sha256 TEXT",
        )
        .replace(
          "FOREIGN KEY(proofread_id,",
          `${draftColumns.join(",")},${draftPairCheck},UNIQUE(document_version_id,source_asset_id,source_sha256),FOREIGN KEY(raw_parse_id,raw_parse_result_sha256) REFERENCES raw_parses(raw_parse_id,result_sha256) ON DELETE RESTRICT,FOREIGN KEY(draft_content_artifact_path,draft_content_sha256,draft_content_byte_size,draft_content_media_type) REFERENCES artifact_objects(relative_path,sha256,byte_size,media_type) ON DELETE RESTRICT,FOREIGN KEY(proofread_id,`,
        );
    if (sql.startsWith("CREATE VIEW archive_current_parts ")) {
      // Draft content-version JSON is intentionally ordered text_level, then
      // document_version_id. Keep the v2 JSON expression byte-for-byte unchanged.
      return sql
        .replace(
          "CASE WHEN ac.annotation_id IS NOT NULL THEN json_object",
          "CASE WHEN d.schema_version=3 THEN json_object('text_level','draft','document_version_id',d.document_version_id) WHEN ac.annotation_id IS NOT NULL THEN json_object",
        )
        .replace(" AND d.schema_version=2)", ")")
        .replace(
          "AND d.proofread_content_sha256=pv.content_sha256 AND pv.status='complete'",
          "AND ((d.schema_version=2 AND d.proofread_content_sha256=pv.content_sha256 AND pv.status='complete') OR (d.schema_version=3 AND EXISTS(SELECT 1 FROM draft_current dc JOIN raw_parses r ON r.raw_parse_id=d.raw_parse_id AND r.result_sha256=d.raw_parse_result_sha256 JOIN raw_parse_current rc ON rc.source_asset_id=r.source_asset_id AND rc.source_sha256=r.source_sha256 AND rc.profile=r.profile AND rc.raw_parse_id=r.raw_parse_id WHERE dc.document_version_id=d.document_version_id AND dc.part_asset_id=a.asset_id AND dc.part_sha256=a.sha256)))",
        )
        .replace(
          "ac.document_version_id=d.document_version_id LEFT",
          "ac.document_version_id=d.document_version_id AND d.schema_version=2 LEFT",
        );
    }
    return sql;
  }),
  ...DRAFT_TEXT_SCHEMA_V17,
] as const;
export const SCHEMA_FINGERPRINT_V17 = createHash("sha256")
  .update(JSON.stringify(SCHEMA_MANIFEST_V17))
  .digest("hex");

/** Display-only connection kind; frozen V16/V17 definitions above stay unchanged. */
export const DEVICE_KIND_COLUMN_V18 =
  "kind TEXT CHECK(kind IS NULL OR kind IN ('extension','agent'))";
/** No library-state or retrieval revision triggers. */
export const USER_ORGANIZATION_SCHEMA_V18 = [
  "CREATE TABLE saved_filters(filter_id TEXT NOT NULL PRIMARY KEY,name TEXT NOT NULL COLLATE BINARY UNIQUE CHECK(length(trim(name))>0),query_json TEXT NOT NULL CHECK(json_valid(query_json)),sort TEXT NOT NULL CHECK(length(trim(sort))>0),created_at TEXT NOT NULL,updated_at TEXT NOT NULL) STRICT",
  "CREATE TABLE reading_mark_places(mark_id TEXT NOT NULL,target_kind TEXT NOT NULL CHECK(target_kind IN ('pdf','document')),target_id TEXT NOT NULL CHECK(target_kind<>'pdf' OR (length(target_id)=64 AND target_id=lower(target_id) AND target_id NOT GLOB '*[^0-9a-f]*')),pdf_page INTEGER CHECK(pdf_page IS NULL OR pdf_page>=1),pdf_rects_json TEXT CHECK(pdf_rects_json IS NULL OR json_valid(pdf_rects_json)),document_start_utf8 INTEGER,document_end_utf8 INTEGER,similarity REAL NOT NULL CHECK(similarity BETWEEN 0.7 AND 1.0),method TEXT NOT NULL CHECK(length(trim(method))>0),located_at TEXT NOT NULL,PRIMARY KEY(mark_id,target_kind,target_id),FOREIGN KEY(mark_id) REFERENCES reading_marks(mark_id) ON DELETE CASCADE,CHECK((target_kind='pdf' AND pdf_page IS NOT NULL AND pdf_rects_json IS NOT NULL AND document_start_utf8 IS NULL AND document_end_utf8 IS NULL) OR (target_kind='document' AND pdf_page IS NULL AND pdf_rects_json IS NULL AND document_start_utf8 IS NOT NULL AND document_end_utf8 IS NOT NULL AND document_start_utf8>=0 AND document_end_utf8>document_start_utf8))) STRICT",
] as const;
/** Frozen V18: the 17 -> 18 target and 18 -> 19 input. */
export const SCHEMA_MANIFEST_V18 = [
  ...SCHEMA_MANIFEST_V17.map((sql) => {
    const next = sql.replace(
      "CHECK(schema_version=17)",
      "CHECK(schema_version=18)",
    );
    // Match SQLite ADD COLUMN's stored SQL exactly, including its comma-space.
    if (next.startsWith("CREATE TABLE device_connections("))
      return next.replace(/\) STRICT$/u, `, ${DEVICE_KIND_COLUMN_V18}) STRICT`);
    // New literature ownership is recorded from V18 onward; V16/V17 stay frozen.
    if (next.startsWith("CREATE TABLE intake_batch_objects("))
      return next.replace(
        "object_kind IN ('folder',",
        "object_kind IN ('literature','folder',",
      );
    return next.startsWith("CREATE VIEW processor_result_currentness ")
      ? next.replace(
          "'text-evidence-hierarchical-v2'",
          "'" + PROCESSOR_METHOD_REVISION + "'",
        )
      : next;
  }),
  ...USER_ORGANIZATION_SCHEMA_V18,
] as const;
export const SCHEMA_FINGERPRINT_V18 = createHash("sha256")
  .update(JSON.stringify(SCHEMA_MANIFEST_V18))
  .digest("hex");

export const SCHEMA_MANIFEST_V19 = SCHEMA_MANIFEST_V18.map((sql) => {
  if (sql.startsWith("CREATE TABLE citation_discovery_inputs("))
    return sql.replace(
      "result_limit INTEGER NOT NULL CHECK(typeof(result_limit)='integer' AND result_limit>=1)",
      "result_limit INTEGER CHECK(result_limit IS NULL OR (typeof(result_limit)='integer' AND result_limit>=1))",
    );
  if (sql.startsWith("CREATE TABLE discovery_run_providers("))
    return sql
      .replace(
        "scan_limit INTEGER NOT NULL CHECK(typeof(scan_limit)='integer' AND scan_limit>=1)",
        "scan_limit INTEGER CHECK(scan_limit IS NULL OR (typeof(scan_limit)='integer' AND scan_limit>=1)),kind TEXT NOT NULL CHECK(kind IN ('topic','citation')),CHECK(kind='citation' OR scan_limit IS NOT NULL)",
      )
      .replace(
        "FOREIGN KEY(discovery_run_id) REFERENCES discovery_runs(discovery_run_id)",
        "FOREIGN KEY(discovery_run_id,kind) REFERENCES discovery_runs(discovery_run_id,kind)",
      );
  return sql.replace("CHECK(schema_version=18)", "CHECK(schema_version=19)");
});
export const SCHEMA_FINGERPRINT_V19 = createHash("sha256")
  .update(JSON.stringify(SCHEMA_MANIFEST_V19))
  .digest("hex");

export const INTAKE_LOOKUP_INDEXES = [
  // FTS5's internal-content format stores the FTS rowid as id INTEGER PRIMARY
  // KEY and the first declared column (literature_id) as c0. SQLite's c0
  // index already carries id as rowid, covering the lookup in rowid order.
  "CREATE INDEX literature_search_fts_content_owner ON literature_search_fts_content(c0)",
  "CREATE INDEX topic_discovery_cause_actual_lookup ON topic_discovery_causes(actual_literature_id)",
  "CREATE INDEX citation_discovery_cause_actual_lookup ON citation_discovery_causes(actual_literature_id)",
] as const;

export const SCHEMA_MANIFEST_V19_INTAKE_LOOKUPS = [
  ...SCHEMA_MANIFEST_V19,
  ...INTAKE_LOOKUP_INDEXES,
] as const;
export const SCHEMA_FINGERPRINT_V19_INTAKE_LOOKUPS = createHash("sha256")
  .update(JSON.stringify(SCHEMA_MANIFEST_V19_INTAKE_LOOKUPS))
  .digest("hex");

const changeEvents = ["INSERT", "UPDATE", "DELETE"] as const;
const retrievalChangeTriggers = (
  table: string,
  owners: (row: "old" | "new") => string,
  updateRevision = false,
) =>
  changeEvents.map((event) => {
    // On UPDATE either side can move to a different literature. Keep one
    // occurrence per owner even when both sides refer to the same paper.
    const affected =
      event === "INSERT"
        ? owners("new")
        : event === "DELETE"
          ? owners("old")
          : `${owners("old")} UNION ${owners("new")}`;
    // Withdrawal marks have no legacy revision trigger. A direct SQL writer
    // must make both the recorded change and the lag visible at commit.
    const revision = updateRevision
      ? " UPDATE retrieval_source_revision SET revision=revision+1 WHERE singleton=1 AND changes()>0;"
      : "";
    return `CREATE TRIGGER retrieval_change_${table}_${event.toLowerCase()} AFTER ${event} ON ${table} BEGIN INSERT INTO retrieval_changes(literature_id) ${affected};${revision} END`;
  });

// SQLite can replace a conflicting row without firing its DELETE trigger.
// Record the prior owner for keys that can be reused by another literature.
const retrievalReplacementOwners = [
  [
    "literature_assets",
    "SELECT literature_id FROM literature_assets WHERE literature_asset_id=new.literature_asset_id AND literature_id<>new.literature_id",
  ],
  [
    "document_versions",
    "SELECT literature_id FROM document_versions WHERE (document_version_id=new.document_version_id OR (document_id=new.document_id AND representation_sha256=new.representation_sha256)) AND literature_id<>new.literature_id",
  ],
  [
    "document_defaults",
    "SELECT v.literature_id FROM document_defaults d JOIN document_versions v ON v.document_version_id=d.document_version_id WHERE (d.document_id=new.document_id OR d.document_version_id=new.document_version_id) AND d.document_version_id<>new.document_version_id",
  ],
] as const;

export const RETRIEVAL_CHANGE_SCHEMA = [
  // The position survives deletion of the processed prefix. Deletions must
  // also leave a change behind, so the journal does not reference literatures.
  "CREATE TABLE retrieval_changes(position INTEGER PRIMARY KEY AUTOINCREMENT,literature_id TEXT NOT NULL) STRICT",
  "CREATE TABLE retrieval_change_state(singleton INTEGER NOT NULL PRIMARY KEY CHECK(singleton=1),processed_position INTEGER CHECK(processed_position>=0)) STRICT",
  ...[
    "literatures",
    "literature_metadata",
    "literature_metadata_authors",
    "literature_metadata_author_affiliations",
    "literature_metadata_identifiers",
    "literature_metadata_keywords",
    "literature_metadata_subject_terms",
    "literature_assets",
    "document_versions",
  ].flatMap((table) =>
    retrievalChangeTriggers(table, (row) => `SELECT ${row}.literature_id`),
  ),
  // Links have an index on asset_id. Historical document versions carry
  // their own immutable asset hashes and have their own revision triggers.
  ...retrievalChangeTriggers(
    "assets",
    (row) =>
      `SELECT DISTINCT literature_id FROM literature_assets WHERE asset_id=${row}.asset_id`,
  ),
  ...["document_version_resources", "document_defaults"].flatMap((table) =>
    retrievalChangeTriggers(
      table,
      (row) =>
        `SELECT literature_id FROM document_versions WHERE document_version_id=${row}.document_version_id`,
    ),
  ),
  ...retrievalChangeTriggers(
    "intake_withdrawn_objects",
    (row) => `SELECT ${row}.object_id WHERE ${row}.object_kind='literature'`,
    true,
  ),
  ...retrievalReplacementOwners.flatMap(([table, owners]) =>
    (["INSERT", "UPDATE"] as const).map(
      (event) =>
        `CREATE TRIGGER retrieval_change_${table}_replacement_${event.toLowerCase()} BEFORE ${event} ON ${table} BEGIN INSERT INTO retrieval_changes(literature_id) ${owners}; UPDATE retrieval_source_revision SET revision=revision+1 WHERE singleton=1 AND changes()>0; END`,
    ),
  ),
] as const;

// The existing identity table constrains its version to 19. The fingerprint
// distinguishes the additive layout without replacing any existing object.
export const SCHEMA_MANIFEST_V19_RETRIEVAL_CHANGES = [
  ...SCHEMA_MANIFEST_V19_INTAKE_LOOKUPS,
  ...RETRIEVAL_CHANGE_SCHEMA,
] as const;
export const SCHEMA_FINGERPRINT_V19_RETRIEVAL_CHANGES = createHash("sha256")
  .update(JSON.stringify(SCHEMA_MANIFEST_V19_RETRIEVAL_CHANGES))
  .digest("hex");

const byAsset = (asset: string) =>
  `SELECT literature_id FROM literature_assets WHERE asset_id=${asset}`;
const byRawParse = (parse: string) =>
  `SELECT literature_id FROM document_versions WHERE raw_parse_id=${parse}
   UNION SELECT la.literature_id FROM raw_parse_pins pin JOIN proofread_versions p USING(proofread_id)
   JOIN literature_assets la ON la.asset_id=p.part_asset_id WHERE pin.raw_parse_id=${parse}`;
const queueStateOwners = (owners: string) =>
  `INSERT INTO library_state_dirty(literature_id) SELECT literature_id FROM (${owners}) WHERE literature_id IS NOT NULL ON CONFLICT(literature_id) DO UPDATE SET position=excluded.position;`;
const stateDirtyTriggers = (
  table: string,
  owners: (row: "new" | "old") => string,
  events: readonly (typeof changeEvents)[number][] = changeEvents,
) =>
  events.map((event) => {
    const affected =
      event === "INSERT"
        ? owners("new")
        : event === "DELETE"
          ? owners("old")
          : `${owners("old")} UNION ${owners("new")}`;
    return `CREATE TRIGGER stored_state_${table}_${event.toLowerCase()} AFTER ${event} ON ${table} BEGIN ${queueStateOwners(affected)} END`;
  });
const collect = (ids: string) =>
  `INSERT INTO library_collected(literature_id,intake_at) SELECT owner.literature_id,
    (SELECT intake_at FROM literature_intake WHERE literature_id=owner.literature_id)
    FROM (${ids}) owner WHERE owner.literature_id IS NOT NULL ON CONFLICT(literature_id) DO NOTHING;`;

export const collectionTaskTargetSql = (target: string, job: string) =>
  `${target}.literature_id IS NOT NULL AND ${job}.target_kind<>'discovery' AND (
    json_extract(${job}.selector_json,'$.goal') IN ('pdf','parser','draft') OR EXISTS(
      SELECT 1 FROM json_each(${job}.selector_json,'$.request.operations') op
      WHERE op.key=${target}.ordinal AND op.type='object' AND json_extract(op.value,'$.operation') IN (
        'build-archive','run-processor','parse-documents','assess-article-identity'
      )
    ) OR EXISTS(SELECT 1 FROM processor_run_requests r WHERE r.job_id=${job}.job_id)
  )`;
const taskSelection = (jobId: string) =>
  `SELECT t.literature_id FROM execution_targets t JOIN execution_jobs j USING(job_id)
    WHERE t.job_id=${jobId} AND ${collectionTaskTargetSql("t", "j")}
   UNION SELECT l.literature_id FROM execution_jobs j
    JOIN json_each(j.selector_json,'$.request.operations') op
    JOIN json_each(CASE WHEN op.type='object' THEN op.value ELSE '{}' END,'$.request.inputs') input
    JOIN literatures l ON l.literature_id=json_extract(CASE WHEN input.type='object' THEN input.value ELSE '{}' END,'$.literature_id')
    WHERE j.job_id=${jobId} AND op.type='object' AND input.type='object'
      AND json_extract(op.value,'$.operation')='run-processor'
   UNION SELECT l.literature_id FROM execution_jobs j
    JOIN json_each(j.selector_json,'$.frozen_targets') t
    JOIN json_each(CASE WHEN t.type='object' THEN t.value ELSE '{}' END,'$.candidates') candidate
    JOIN literatures l ON l.literature_id=candidate.value
    WHERE j.job_id=${jobId} AND json_extract(j.selector_json,'$.goal') IN ('pdf','parser')`;
export const manualTagChangeAddedSql = (change: string) =>
  `EXISTS(SELECT 1 FROM json_each(${change}.after_json,'$.items') item
    WHERE json_extract(item.value,'$.origin')='manual' AND NOT EXISTS(
      SELECT 1 FROM json_each(${change}.before_json,'$.items') prior WHERE
        json_extract(prior.value,'$.tag_id')=json_extract(item.value,'$.tag_id')
        AND json_extract(prior.value,'$.origin')='manual'))`;

export const LIBRARY_STORED_STATE_SCHEMA = [
  "CREATE TABLE library_state_progress(singleton INTEGER PRIMARY KEY CHECK(singleton=1),generation INTEGER NOT NULL CHECK(generation>0),max_tags INTEGER NOT NULL,archive_profile TEXT NOT NULL CHECK(archive_profile IN ('pipeline','vlm-engine')),after_id TEXT NOT NULL,ready INTEGER NOT NULL CHECK(ready IN (0,1)),collection_ready INTEGER NOT NULL CHECK(collection_ready IN (0,1))) STRICT",
  "CREATE TABLE library_literature_states(literature_id TEXT PRIMARY KEY,status TEXT NOT NULL CHECK(status IN ('UNREVIEWED','ASSET_READY','ARCHIVING','ARCHIVE_FAILED','EXCLUDED','READY')),missing_step TEXT,generation INTEGER NOT NULL CHECK(generation>0),intake_at TEXT,FOREIGN KEY(literature_id) REFERENCES literatures(literature_id) ON DELETE CASCADE ON UPDATE CASCADE) STRICT",
  "CREATE INDEX library_literature_states_status ON library_literature_states(status,intake_at DESC,literature_id)",
  "CREATE INDEX library_literature_states_missing ON library_literature_states(missing_step,intake_at DESC,literature_id)",
  "CREATE TABLE library_collected(literature_id TEXT PRIMARY KEY,intake_at TEXT,FOREIGN KEY(literature_id) REFERENCES literatures(literature_id) ON DELETE CASCADE ON UPDATE CASCADE) STRICT",
  "CREATE INDEX library_collected_order ON library_collected(intake_at DESC,literature_id)",
  "CREATE TABLE library_state_dirty(position INTEGER PRIMARY KEY,literature_id TEXT NOT NULL UNIQUE) STRICT",
  "CREATE INDEX snapshot_members_literature ON snapshot_members(literature_id)",
  "CREATE INDEX intake_folder_member_literature ON intake_batch_objects(CASE WHEN json_valid(object_id) THEN json_extract(object_id,'$[1]') END) WHERE object_kind='folder-member'",
  "CREATE INDEX execution_targets_literature ON execution_targets(literature_id,job_id) WHERE literature_id IS NOT NULL",
  "CREATE INDEX execution_start_requests ON execution_events(job_id) WHERE kind='task-start-requested'",
  "CREATE INDEX execution_attempts_target ON execution_attempts(target_id)",
  "CREATE INDEX operation_manual_tags ON operation_records(json_extract(scope_json,'$.request.literature_id'),json_extract(result_json,'$.revision')) WHERE operation='tags' AND status='completed' AND json_valid(scope_json) AND json_valid(result_json) AND json_extract(scope_json,'$.operation')='assign'",
  // Ordinary changes already carry owners. Keep the legacy journal intact for
  // open older writers, and mirror its keyed invalidations into the work queue.
  ...stateDirtyTriggers(
    "library_state_changes",
    (r) => `SELECT ${r}.literature_id AS literature_id`,
    ["INSERT", "UPDATE"],
  ),
  ...stateDirtyTriggers(
    "literatures",
    (r) => `SELECT ${r}.literature_id AS literature_id`,
    ["UPDATE"],
  ),
  ...stateDirtyTriggers(
    "literature_intake",
    (r) => `SELECT ${r}.literature_id AS literature_id`,
  ),
  ...changeEvents.map(
    (event) =>
      `CREATE TRIGGER library_collect_intake_order_${event.toLowerCase()} AFTER ${event} ON literature_intake BEGIN
      ${event === "INSERT" ? "" : `UPDATE library_collected SET intake_at=NULL WHERE literature_id=old.literature_id AND intake_at IS NOT NULL${event === "UPDATE" ? " AND old.literature_id<>new.literature_id" : ""};`}
      ${event === "DELETE" ? "" : "UPDATE library_collected SET intake_at=new.intake_at WHERE literature_id=new.literature_id AND intake_at IS NOT new.intake_at;"}
    END`,
  ),
  ...stateDirtyTriggers(
    "raw_parse_current",
    (r) =>
      `${byAsset(`${r}.source_asset_id`)} UNION ${byRawParse(`${r}.raw_parse_id`)}`,
  ),
  ...stateDirtyTriggers(
    "raw_parses",
    (r) =>
      `${byAsset(`${r}.source_asset_id`)} UNION ${byRawParse(`${r}.raw_parse_id`)}`,
  ),
  // The old hints cap shared owner discovery at 32. These tables can fan
  // out through a content-addressed asset or one execution job, so keep all
  // owners for them and let the consumer use bounded batches.
  ...[
    "assets",
    "execution_jobs",
    "proofread_current",
    "proofread_versions",
    "proofread_manual_state",
    "raw_parse_pins",
    "draft_current",
  ].flatMap((table) =>
    stateDirtyTriggers(table, (r) =>
      stateOwners(
        table === "draft_current" ? "proofread_current" : table,
        r,
      )!.replace(" ORDER BY literature_id LIMIT 33", ""),
    ),
  ),
  ...retrievalReplacementOwners.flatMap(([table, owners]) =>
    (["INSERT", "UPDATE"] as const).map(
      (event) =>
        `CREATE TRIGGER stored_state_${table}_replacement_${event.toLowerCase()} BEFORE ${event} ON ${table} BEGIN ${queueStateOwners(owners)} END`,
    ),
  ),
  ...["INSERT", "UPDATE"].flatMap((event) => [
    `CREATE TRIGGER library_collect_intake_${event.toLowerCase()} AFTER ${event} ON intake_batch_members WHEN EXISTS(SELECT 1 FROM intake_batches WHERE batch_id=new.batch_id AND kind='import') BEGIN ${collect("SELECT new.literature_id AS literature_id")} END`,
    ...["folder_members", "snapshot_members", "reading_history"].map(
      (table) =>
        `CREATE TRIGGER library_collect_${table}_${event.toLowerCase()} AFTER ${event} ON ${table} BEGIN ${collect("SELECT new.literature_id AS literature_id")} END`,
    ),
  ]),
  `CREATE TRIGGER library_collect_folder_history BEFORE DELETE ON folder_members WHEN EXISTS(SELECT 1 FROM literatures WHERE literature_id=old.literature_id) BEGIN ${collect("SELECT old.literature_id AS literature_id")} END`,
  `CREATE TRIGGER library_collect_audited_tag AFTER UPDATE OF status ON operation_records
    WHEN new.operation='tags' AND new.status='completed' AND json_valid(new.scope_json)
      AND json_valid(new.result_json) AND json_extract(new.scope_json,'$.operation')='assign' BEGIN
    ${collect(`SELECT c.literature_id FROM tag_assignment_changes c
      WHERE c.literature_id=json_extract(new.scope_json,'$.request.literature_id')
        AND c.revision=json_extract(new.result_json,'$.revision')
        AND c.actor='manual' AND ${manualTagChangeAddedSql("c")}`)}
  END`,
  `CREATE TRIGGER library_collect_archive_begin AFTER INSERT ON archive_runs BEGIN ${collect("SELECT new.literature_id AS literature_id")} END`,
  `CREATE TRIGGER library_collect_archive_restart AFTER UPDATE OF run_id ON archive_runs BEGIN ${collect("SELECT new.literature_id AS literature_id")} END`,
  `CREATE TRIGGER library_collect_task_start AFTER INSERT ON execution_events WHEN new.kind='task-start-requested' BEGIN
    ${collect(taskSelection("new.job_id"))}
  END`,
  `CREATE TRIGGER library_collect_task_run AFTER UPDATE OF status ON execution_jobs
    WHEN new.status='running' AND old.status<>'running' AND new.target_kind<>'discovery' BEGIN
    ${collect(taskSelection("new.job_id"))}
  END`,
] as const;

export const SCHEMA_MANIFEST_V19_STORED_STATES = [
  ...SCHEMA_MANIFEST_V19_RETRIEVAL_CHANGES,
  ...LIBRARY_STORED_STATE_SCHEMA,
] as const;
export const SCHEMA_FINGERPRINT_V19_STORED_STATES = createHash("sha256")
  .update(JSON.stringify(SCHEMA_MANIFEST_V19_STORED_STATES))
  .digest("hex");

export const LIBRARY_COUNT_COLUMNS = [
  "versions",
  "with_primary_pdf",
  "unavailable_pdf",
  ...LITERATURE_STATUSES.map(
    (status) => status.toLowerCase() as Lowercase<typeof status>,
  ),
  "papers",
  "obtained",
  "exhausted",
] as const;
const countColumns = LIBRARY_COUNT_COLUMNS.map(
  (name) => `${name} INTEGER NOT NULL CHECK(${name}>=0)`,
).join(",");
const countScopes = "scope TEXT NOT NULL CHECK(scope IN ('all','collected'))";
const queueCountOwners = (owners: string) =>
  `INSERT INTO library_count_dirty(meta_literature_id) SELECT meta_literature_id FROM (${owners}) WHERE true ON CONFLICT(meta_literature_id) DO UPDATE SET position=excluded.position;`;
const countOwner = (id: string) =>
  `SELECT meta_literature_id FROM literatures WHERE literature_id=${id}`;
const withdrawalCountOwner = (row: "old" | "new") =>
  `${countOwner(`${row}.object_id`)} AND ${row}.object_kind='literature'
   UNION SELECT l.meta_literature_id FROM literature_assets a JOIN literatures l USING(literature_id)
   WHERE a.literature_asset_id=${row}.object_id AND a.role='primary-pdf' AND ${row}.object_kind='literature-asset'`;
const countDirtyTriggers = (
  table: string,
  keys: readonly string[],
  owners: (row: "old" | "new") => string,
) =>
  changeEvents.map((event) => {
    const affected =
      event === "INSERT"
        ? owners("new")
        : event === "DELETE"
          ? owners("old")
          : `${owners("old")} UNION ${owners("new")}`;
    const action = event === "UPDATE" ? `UPDATE OF ${keys.join(",")}` : event;
    const changed =
      event === "UPDATE"
        ? ` WHEN ${keys.map((key) => `old.${key} IS NOT new.${key}`).join(" OR ")}`
        : "";
    return `CREATE TRIGGER library_count_${table}_${event.toLowerCase()} AFTER ${action} ON ${table}${changed} BEGIN ${queueCountOwners(affected)} END`;
  });

export const LIBRARY_COUNT_SCHEMA = [
  "CREATE TABLE library_count_progress(singleton INTEGER PRIMARY KEY CHECK(singleton=1),after_id TEXT NOT NULL,ready INTEGER NOT NULL CHECK(ready IN (0,1))) STRICT",
  // Retain the old contribution until it has been subtracted, even after deletion.
  `CREATE TABLE library_count_contributions(meta_literature_id TEXT NOT NULL,${countScopes},${countColumns},PRIMARY KEY(meta_literature_id,scope)) STRICT, WITHOUT ROWID`,
  `CREATE TABLE library_count_totals(${countScopes} PRIMARY KEY,${countColumns}) STRICT, WITHOUT ROWID`,
  "CREATE TABLE library_count_dirty(position INTEGER PRIMARY KEY,meta_literature_id TEXT NOT NULL UNIQUE) STRICT",
  ...["automatic_pdf_acquisition_exhaustions", "library_collected"].flatMap(
    (table) =>
      countDirtyTriggers(table, ["literature_id"], (row) =>
        countOwner(`${row}.literature_id`),
      ),
  ),
  ...countDirtyTriggers(
    "intake_withdrawn_objects",
    ["object_kind", "object_id"],
    withdrawalCountOwner,
  ),
  // A state invalidation identifies the current owner. Capture the previous
  // paper too, including replacements that bypass SQLite's DELETE triggers.
  `CREATE TRIGGER library_count_literatures_delete AFTER DELETE ON literatures BEGIN ${queueCountOwners("SELECT old.meta_literature_id AS meta_literature_id")} END`,
  `CREATE TRIGGER library_count_literatures_move AFTER UPDATE OF meta_literature_id ON literatures WHEN old.meta_literature_id<>new.meta_literature_id BEGIN ${queueCountOwners("SELECT old.meta_literature_id AS meta_literature_id")} END`,
  `CREATE TRIGGER library_count_literatures_replace BEFORE INSERT ON literatures BEGIN ${queueCountOwners(`${countOwner("new.literature_id")} AND meta_literature_id<>new.meta_literature_id`)} END`,
  `CREATE TRIGGER library_count_literatures_replace_key BEFORE UPDATE OF literature_id ON literatures WHEN old.literature_id<>new.literature_id BEGIN ${queueCountOwners(`${countOwner("new.literature_id")} AND meta_literature_id<>new.meta_literature_id`)} END`,
] as const;

export const SCHEMA_MANIFEST_V19_COUNTS = [
  ...SCHEMA_MANIFEST_V19_STORED_STATES,
  ...LIBRARY_COUNT_SCHEMA,
] as const;
export const SCHEMA_FINGERPRINT_V19_COUNTS = createHash("sha256")
  .update(JSON.stringify(SCHEMA_MANIFEST_V19_COUNTS))
  .digest("hex");

export const historicalManualTagSql = (id: string) =>
  `c.actor='manual' AND (c.before_json IS NULL OR EXISTS(
    SELECT 1 FROM operation_records o WHERE o.operation='tags' AND o.status='completed'
    AND json_valid(o.scope_json) AND json_valid(o.result_json)
    AND json_extract(o.scope_json,'$.operation')='assign'
    AND json_extract(o.scope_json,'$.request.literature_id')=${id}
    AND json_extract(o.result_json,'$.revision')=c.revision)) AND ${manualTagChangeAddedSql("c")}`;

/** Match the historical selection proofs and use the oldest available timestamp. */
export function historicalCollectionTimeSql(id: string) {
  return `(SELECT strftime('%Y-%m-%dT%H:%M:%fZ',min(julianday(selected_at))) FROM (
    SELECT coalesce(b.confirmed_at,b.created_at) AS selected_at
    FROM intake_batch_members m JOIN intake_batches b USING(batch_id)
    WHERE m.literature_id=${id} AND b.kind='import'
    UNION ALL SELECT coalesce(i.decided_at,i.created_at)
    FROM intake_items i JOIN intake_batches b USING(batch_id)
    WHERE i.literature_id=${id} AND i.origin='page' AND b.kind='import'
      AND i.disposition IN ('created','enriched','matched','restored')
    UNION ALL SELECT last_opened_at FROM reading_history WHERE literature_id=${id}
    UNION ALL SELECT added_at FROM folder_members WHERE literature_id=${id}
    UNION ALL SELECT s.created_at FROM snapshot_members m JOIN snapshots s USING(snapshot_id)
      WHERE m.literature_id=${id}
    UNION ALL SELECT coalesce(b.confirmed_at,b.created_at)
    FROM intake_batch_objects o JOIN intake_batches b USING(batch_id)
    WHERE o.object_kind='folder-member'
      AND CASE WHEN json_valid(o.object_id) THEN json_extract(o.object_id,'$[1]') END=${id}
    UNION ALL SELECT started_at FROM archive_runs WHERE literature_id=${id}
    UNION ALL SELECT e.created_at FROM execution_targets t JOIN execution_jobs j USING(job_id)
    JOIN execution_events e ON e.job_id=t.job_id AND e.kind='task-start-requested'
    WHERE t.literature_id=${id} AND ${collectionTaskTargetSql("t", "j")}
    UNION ALL SELECT a.started_at FROM execution_targets t JOIN execution_jobs j USING(job_id)
    JOIN execution_attempts a USING(target_id)
    WHERE t.literature_id=${id} AND ${collectionTaskTargetSql("t", "j")}
    UNION ALL SELECT c.created_at FROM tag_assignment_changes c
    WHERE c.literature_id=${id} AND ${historicalManualTagSql(id)}
  ))`;
}

export const LIBRARY_PAGING_SCHEMA = libraryPagingSchema(
  historicalCollectionTimeSql("new.literature_id"),
);
export const SCHEMA_MANIFEST_V19_COMBINED = [
  ...SCHEMA_MANIFEST_V19_COUNTS,
  ...LIBRARY_PAGING_SCHEMA,
] as const;
export const SCHEMA_FINGERPRINT_V19_COMBINED = createHash("sha256")
  .update(JSON.stringify(SCHEMA_MANIFEST_V19_COMBINED))
  .digest("hex");

export const CATALOG_BASE_SCHEMA = [
  ...SCHEMA_MANIFEST_V19.map((sql) => {
    if (sql.startsWith("CREATE TRIGGER ")) return nameCatalogInsertColumns(sql);
    if (sql.startsWith("CREATE VIEW archive_current_parts "))
      return sql.replace(
        "LEFT JOIN (document_defaults dd JOIN document_versions d ON d.document_version_id=dd.document_version_id) ON d.literature_id=la.literature_id AND d.source_asset_id=a.asset_id AND d.source_sha256=a.sha256",
        DEFAULT_DOCUMENT_LEFT_JOIN.trim(),
      );
    return sql;
  }),
  CATALOG_ADDITIONS_DDL,
] as const;
export const SCHEMA_FINGERPRINT = createHash("sha256")
  .update(JSON.stringify(CATALOG_BASE_SCHEMA))
  .digest("hex");

export const LIBRARY_SCALE_ADDITION = defineCatalogAddition(
  "library-scale-04-07",
  [
    ...SCHEMA_MANIFEST_V19_COMBINED.slice(SCHEMA_MANIFEST_V19.length).map(
      (sql) =>
        sql.startsWith("CREATE TRIGGER ") ? nameCatalogInsertColumns(sql) : sql,
    ),
    `CREATE TRIGGER library_collect_first_manual_tag AFTER INSERT ON tag_assignment_changes
    WHEN new.actor='manual' AND new.before_json IS NULL AND json_valid(new.after_json) BEGIN
      ${collect(`SELECT c.literature_id FROM tag_assignment_changes c
      WHERE c.change_id=new.change_id AND ${manualTagChangeAddedSql("c")}`)}
    END`,
    `CREATE TRIGGER library_collect_audited_tag_insert AFTER INSERT ON operation_records
    WHEN new.operation='tags' AND new.status='completed' AND json_valid(new.scope_json)
      AND json_valid(new.result_json) AND json_extract(new.scope_json,'$.operation')='assign' BEGIN
      ${collect(`SELECT c.literature_id FROM tag_assignment_changes c
      WHERE c.literature_id=json_extract(new.scope_json,'$.request.literature_id')
        AND c.revision=json_extract(new.result_json,'$.revision')
        AND c.actor='manual' AND ${manualTagChangeAddedSql("c")}`)}
    END`,
    `CREATE TRIGGER library_collect_task_attempt AFTER INSERT ON execution_attempts BEGIN
      ${collect(`SELECT t.literature_id FROM execution_targets t JOIN execution_jobs j USING(job_id)
      WHERE t.target_id=new.target_id AND ${collectionTaskTargetSql("t", "j")}`)}
    END`,
  ],
  ["library-projections"],
);

export const ARCHIVE_ISSUES_ADDITION = defineCatalogAddition(
  "archive-unresolved-issues",
  [
    "CREATE INDEX archive_issues_unresolved ON archive_issues(literature_id,asset_id,step) WHERE resolution IS NULL",
  ],
);

/** Recently deleted papers (09 user organization). Hidden like a withdrawal:
 * counts, ordered members and the retrieval change log follow the table. */
export const LIBRARY_TRASH_ADDITION = defineCatalogAddition("library-trash", [
  "CREATE TABLE library_trash(literature_id TEXT PRIMARY KEY,deleted_at TEXT NOT NULL,deleted_by TEXT NOT NULL,FOREIGN KEY(literature_id) REFERENCES literatures(literature_id) ON DELETE CASCADE ON UPDATE CASCADE) STRICT, WITHOUT ROWID",
  "CREATE INDEX library_trash_order ON library_trash(deleted_at DESC,literature_id)",
  ...countDirtyTriggers("library_trash", ["literature_id"], (row) =>
    countOwner(`${row}.literature_id`),
  ),
  ...retrievalChangeTriggers(
    "library_trash",
    (row) => `SELECT ${row}.literature_id`,
    true,
  ),
  ...libraryTrashPagingTriggers(),
]);

const ARCHIVE_STEPS_BASE = CATALOG_BASE_SCHEMA.find((sql) =>
  sql.startsWith("CREATE TABLE archive_steps("),
)!;
/**
 * archive_steps checks only the form of a step name, so a later step needs no
 * rebuild; which names are valid is the code's business (ARCHIVE_STEPS and the
 * historical names), checked before every write. Every other byte is kept.
 */
export const ARCHIVE_STEPS_TRANSLATE_SQL = ARCHIVE_STEPS_BASE.replace(
  "CHECK(step IN ('arrange','proofread','render','metadata','references','tags','document','structure'))",
  "CHECK(length(step) BETWEEN 1 AND 32 AND step GLOB '[a-z]*' AND step NOT GLOB '*[^a-z-]*')",
);
if (ARCHIVE_STEPS_TRANSLATE_SQL === ARCHIVE_STEPS_BASE)
  throw new Error("archive_steps step check not found");
const DOCUMENT_TRANSLATIONS_TABLE_SQL =
  "CREATE TABLE document_translations(literature_id TEXT NOT NULL,asset_id TEXT NOT NULL,content_version TEXT NOT NULL CHECK(length(content_version)=64 AND content_version NOT GLOB '*[^0-9a-f]*'),target_language TEXT NOT NULL CHECK(length(trim(target_language))>0),document_version_id TEXT NOT NULL,annotation_id TEXT NOT NULL CHECK(length(annotation_id)=64),artifact_reference TEXT NOT NULL,sha256 TEXT NOT NULL,byte_size INTEGER NOT NULL,media_type TEXT NOT NULL CHECK(media_type='application/json'),unit_count INTEGER NOT NULL CHECK(unit_count>=0),translated_count INTEGER NOT NULL CHECK(translated_count>=0 AND translated_count<=unit_count),status TEXT NOT NULL CHECK(status IN ('complete','partial','same-language')),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(literature_id,asset_id,content_version,target_language),FOREIGN KEY(literature_id) REFERENCES literatures(literature_id),FOREIGN KEY(asset_id) REFERENCES assets(asset_id),FOREIGN KEY(document_version_id) REFERENCES document_versions(document_version_id) ON DELETE RESTRICT,FOREIGN KEY(artifact_reference,sha256,byte_size,media_type) REFERENCES artifact_objects(relative_path,sha256,byte_size,media_type) ON DELETE RESTRICT) STRICT, WITHOUT ROWID";
const DOCUMENT_TRANSLATIONS_INDEX_SQL = [
  "CREATE INDEX document_translations_version ON document_translations(document_version_id,target_language)",
  "CREATE INDEX document_translations_latest ON document_translations(literature_id,target_language,updated_at)",
] as const;
/**
 * Full-text search covers stored translations (document spec 9.7). Every
 * writer of a translation, and a change of the current annotation that
 * changes which translation is current, records the paper in the change
 * journal by trigger, so the incremental refresh needs no application code
 * in the writing transaction.
 */
const DOCUMENT_TRANSLATION_RETRIEVAL = [
  ...retrievalChangeTriggers(
    "document_translations",
    (row) => `SELECT ${row}.literature_id`,
    true,
  ),
  ...retrievalChangeTriggers(
    "structure_annotation_current",
    (row) =>
      `SELECT literature_id FROM document_versions WHERE document_version_id=${row}.document_version_id`,
    true,
  ),
];
const baseTable = (name: string) =>
  CATALOG_BASE_SCHEMA.find((sql) => sql.startsWith(`CREATE TABLE ${name}(`))!;
/** SQLite writes an added column before the table constraints. */
const withColumns = (sql: string, before: string, columns: string[]) => {
  if (!sql.includes(before)) throw new Error("catalog column anchor missing");
  return sql.replace(
    before,
    `${columns.map((c) => `, ${c}`).join("")}${before}`,
  );
};
/**
 * A translation entry is a `document` entry with the original unit's range
 * and the language and file of the translation; a generation records the
 * text rule and translation language it was built with, so an index older
 * than either reads as stale until an explicit rebuild.
 */
const DOCUMENT_TRANSLATION_RETRIEVAL_COLUMNS = [
  [
    "retrieval_entries",
    "ALTER TABLE retrieval_entries ADD COLUMN translation_language TEXT",
  ],
  [
    "retrieval_entries",
    "ALTER TABLE retrieval_entries ADD COLUMN translation_sha256 TEXT",
  ],
  [
    "retrieval_generations",
    "ALTER TABLE retrieval_generations ADD COLUMN text_rule TEXT",
  ],
  [
    "retrieval_generations",
    "ALTER TABLE retrieval_generations ADD COLUMN translation_language TEXT",
  ],
] as const;
export const RETRIEVAL_ENTRIES_TRANSLATION_SQL = withColumns(
  baseTable("retrieval_entries"),
  ",CHECK((kind='metadata'",
  ["translation_language TEXT", "translation_sha256 TEXT"],
);
export const RETRIEVAL_GENERATIONS_RULE_SQL = withColumns(
  baseTable("retrieval_generations"),
  ",CHECK(status='building'",
  ["text_rule TEXT", "translation_language TEXT"],
);
/**
 * Stored full-text translations (ADR 0068, document spec 9.4). One row per
 * literature, primary PDF, proofread content version and language registers
 * the immutable file: its identity and counts, never the translated text. The
 * archive_steps rebuild is the storage spec 4.4 exception: stop the service.
 */
export const DOCUMENT_TRANSLATIONS_ADDITION = defineCatalogAddition(
  "document-translations",
  [
    ARCHIVE_STEPS_TRANSLATE_SQL,
    DOCUMENT_TRANSLATIONS_TABLE_SQL,
    ...DOCUMENT_TRANSLATIONS_INDEX_SQL,
    ...DOCUMENT_TRANSLATION_RETRIEVAL,
    ...DOCUMENT_TRANSLATION_RETRIEVAL_COLUMNS.map(([, sql]) => sql),
  ],
  [],
  [
    ARCHIVE_STEPS_TRANSLATE_SQL,
    DOCUMENT_TRANSLATIONS_TABLE_SQL,
    DOCUMENT_TRANSLATIONS_INDEX_SQL[0],
    DOCUMENT_TRANSLATIONS_INDEX_SQL[1],
    ...DOCUMENT_TRANSLATION_RETRIEVAL,
    RETRIEVAL_ENTRIES_TRANSLATION_SQL,
    RETRIEVAL_GENERATIONS_RULE_SQL,
  ],
  ["archive_steps"],
);

export const CATALOG_ADDITIONS = [
  LIBRARY_SCALE_ADDITION,
  ARCHIVE_ISSUES_ADDITION,
  LIBRARY_TRASH_ADDITION,
  DOCUMENT_TRANSLATIONS_ADDITION,
] as const;
export const SCHEMA_MANIFEST = manifestWithAdditions(
  CATALOG_BASE_SCHEMA,
  CATALOG_ADDITIONS,
);
