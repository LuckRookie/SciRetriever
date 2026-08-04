from typing import Final

BATCH_DDL: Final = (
    "CREATE TABLE batch_runs(id TEXT PRIMARY KEY,batch_type TEXT NOT NULL CHECK(batch_type IN ("
    "'process','bibliography-import','bibliography-export')),status TEXT NOT NULL CHECK(status "
    "IN ('created','running','no-target','completed','partial','failed','interrupted')),"
    "scope_json TEXT NOT NULL CHECK(json_valid(scope_json)),counts_json TEXT NOT NULL CHECK("
    "json_valid(counts_json)),publication_phase TEXT NOT NULL DEFAULT 'none' CHECK("
    "publication_phase IN ('none','prepared','published')),trigger_collection_run_id TEXT "
    "UNIQUE REFERENCES collection_runs(id),started_at TEXT,finished_at TEXT) STRICT",
    "CREATE TABLE batch_targets(id TEXT PRIMARY KEY,batch_run_id TEXT NOT NULL REFERENCES "
    "batch_runs(id) ON DELETE CASCADE,target_kind TEXT NOT NULL,target_id TEXT NOT NULL,"
    "input_ordinal INTEGER,started INTEGER NOT NULL DEFAULT 0 CHECK(started IN (0,1)),"
    "initial_state TEXT,target_state TEXT,result_json TEXT CHECK(result_json IS NULL OR "
    "json_valid(result_json)),UNIQUE(batch_run_id,target_kind,target_id),UNIQUE(batch_run_id,"
    "input_ordinal)) STRICT",
    "CREATE TABLE batch_counts(batch_run_id TEXT PRIMARY KEY REFERENCES batch_runs(id) ON "
    "DELETE CASCADE,counts_json TEXT NOT NULL CHECK(json_valid(counts_json))) STRICT",
    "CREATE TABLE current_failures(id TEXT PRIMARY KEY,subject_kind TEXT NOT NULL,subject_id "
    "TEXT NOT NULL,stage TEXT NOT NULL,code TEXT NOT NULL,reason TEXT NOT NULL,action TEXT NOT "
    "NULL,retryable INTEGER NOT NULL CHECK(retryable IN (0,1)),updated_at TEXT NOT NULL,UNIQUE("
    "subject_kind,subject_id,stage)) STRICT",
    "CREATE TABLE parser_attempts(id TEXT PRIMARY KEY,work_version_id TEXT NOT NULL REFERENCES "
    "work_versions(id) ON DELETE CASCADE,external_task_id TEXT,parser_name TEXT NOT NULL,"
    "input_sha256 TEXT NOT NULL CHECK(length(input_sha256)=64),attempted_at TEXT NOT NULL) "
    "STRICT",
)

_ASSET_READY: Final = "EXISTS(SELECT 1 FROM accepted_primary_assets p WHERE p.work_version_id=v.id)"
_LIGHT_READY: Final = (
    "EXISTS(SELECT 1 FROM accepted_primary_assets p JOIN work_version_current_light_document c "
    "ON c.work_version_id=p.work_version_id JOIN light_documents d ON d.id=c.light_document_id "
    "AND d.work_version_id=p.work_version_id AND d.primary_asset_id=p.work_version_asset_id "
    "WHERE p.work_version_id=v.id AND d.complete=1)"
)
_COMPLETED: Final = (
    "EXISTS(SELECT 1 FROM accepted_primary_assets p JOIN work_version_current_light_document c "
    "ON c.work_version_id=p.work_version_id JOIN light_documents d ON d.id=c.light_document_id "
    "AND d.work_version_id=p.work_version_id AND d.primary_asset_id=p.work_version_asset_id AND "
    "d.complete=1 JOIN completion_bundles b ON b.work_version_id=p.work_version_id AND "
    "b.light_document_id=c.light_document_id JOIN analysis_artifacts a ON "
    "a.id=b.analysis_artifact_id AND a.work_version_id=p.work_version_id AND "
    "a.light_document_id=c.light_document_id AND a.input_sha256=d.sha256 AND "
    "a.nine_categories_complete=1 JOIN work_version_current_metadata m ON "
    "m.work_version_id=p.work_version_id AND m.metadata_snapshot_id=b.metadata_snapshot_id JOIN "
    "metadata_snapshots s ON s.id=m.metadata_snapshot_id AND "
    "s.work_version_id=p.work_version_id JOIN reference_sets r ON r.id=b.reference_set_id AND "
    "r.work_version_id=p.work_version_id AND r.complete=1 JOIN tag_sets t ON t.id=b.tag_set_id "
    "AND t.work_version_id=p.work_version_id AND t.complete=1 WHERE p.work_version_id=v.id AND "
    "c.light_document_id IS NOT NULL AND d.sha256 IS NOT NULL AND b.light_document_id IS NOT "
    "NULL AND b.analysis_artifact_id IS NOT NULL AND a.light_document_id IS NOT NULL AND "
    "a.input_sha256 IS NOT NULL AND m.metadata_snapshot_id IS NOT NULL AND s.revision IS NOT "
    "NULL AND s.sha256 IS NOT NULL AND b.metadata_snapshot_id IS NOT NULL AND "
    "b.reference_set_id IS NOT NULL AND b.tag_set_id IS NOT NULL)"
)
_STATE_CASE: Final = (
    f"CASE WHEN {_COMPLETED} THEN 'completed' WHEN {_LIGHT_READY} THEN 'light-text-ready' "
    f"WHEN {_ASSET_READY} THEN 'asset-ready' ELSE 'unreviewed' END"
)

DERIVED_DDL: Final = (
    "CREATE VIEW work_views AS SELECT w.id AS work_id,r.work_version_id FROM works w LEFT JOIN "
    "work_representative_versions r ON r.work_id=w.id",
    "CREATE VIEW work_version_details AS SELECT v.id AS work_version_id,v.work_id FROM "
    "work_versions v",
    f"CREATE VIEW work_version_state_view AS SELECT v.id AS work_version_id,{_STATE_CASE} AS "
    f"state,CASE {_STATE_CASE} WHEN 'unreviewed' THEN 'primary-pdf' WHEN 'asset-ready' THEN "
    "'light-document' WHEN 'light-text-ready' THEN 'completion' WHEN 'completed' THEN NULL END AS "
    "missing_step FROM work_versions v",
    "CREATE VIEW missing_step_view AS SELECT work_version_id,missing_step FROM "
    "work_version_state_view",
    "CREATE VIEW work_status_summary AS SELECT work_version_id,state FROM work_version_state_view",
    "CREATE VIEW citation_graph_view AS SELECT s.work_version_id,m.target_work_id,"
    "m.target_work_version_id,m.id AS reference_id FROM reference_members m JOIN reference_sets "
    "s ON s.id=m.reference_set_id WHERE m.target_work_id IS NOT NULL",
    "CREATE VIRTUAL TABLE metadata_fts USING fts5(work_version_id UNINDEXED,content)",
    "CREATE VIRTUAL TABLE light_text_fts USING fts5(work_version_id UNINDEXED,content)",
    "CREATE VIRTUAL TABLE analysis_fts USING fts5(work_version_id UNINDEXED,content)",
)
