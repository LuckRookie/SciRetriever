from __future__ import annotations

import hashlib
from typing import Final

from sciretriever.literature_store.sqlite.schema_batches import BATCH_DDL, DERIVED_DDL
from sciretriever.literature_store.sqlite.schema_bibliography import BIBLIOGRAPHY_DDL
from sciretriever.literature_store.sqlite.schema_collections import COLLECTION_DDL
from sciretriever.literature_store.sqlite.schema_content import CONTENT_DDL

_IDENTITY_DDL: Final = (
    "CREATE TABLE schema_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),product TEXT "
    "NOT NULL CHECK(product='sciretriever'),schema_version INTEGER NOT NULL CHECK("
    "schema_version=2),schema_fingerprint TEXT NOT NULL CHECK(length(schema_fingerprint)=64)) "
    "STRICT",
)
_INDEX_DDL: Final = (
    "CREATE INDEX idx_collection_runs_collection ON collection_runs(collection_id,created_at,id)",
    "CREATE INDEX idx_memberships_work ON collection_memberships(work_id,collection_id)",
    "CREATE INDEX idx_versions_work ON work_versions(work_id,version_role,id)",
    "CREATE INDEX idx_observations_version ON metadata_observations(work_version_id,observed_at,"
    "id)",
    "CREATE INDEX idx_identifiers_version ON stable_identifiers(work_version_id,namespace,value)",
    "CREATE INDEX idx_assets_version ON work_version_assets(work_version_id,role,id)",
    "CREATE INDEX idx_batch_targets_run ON batch_targets(batch_run_id,input_ordinal,id)",
    "CREATE INDEX idx_failures_subject ON current_failures(subject_kind,subject_id,stage)",
    "CREATE INDEX idx_extensions_namespace ON opaque_extension_records(namespace,record_id)",
)
_TRIGGER_DDL: Final = (
    "CREATE TRIGGER trg_membership_run_collection BEFORE INSERT ON collection_memberships WHEN "
    "NOT EXISTS(SELECT 1 FROM collection_runs r WHERE r.id=NEW.first_collection_run_id AND "
    "r.collection_id=NEW.collection_id) BEGIN SELECT RAISE(ABORT,'membership run must belong to "
    "collection'); END",
    "CREATE TRIGGER trg_cause_run_collection BEFORE INSERT ON collection_causes WHEN NOT EXISTS("
    "SELECT 1 FROM collection_memberships m JOIN collection_runs r ON "
    "r.id=NEW.collection_run_id WHERE m.id=NEW.membership_id AND "
    "r.collection_id=m.collection_id) BEGIN SELECT RAISE(ABORT,'cause run must belong to "
    "collection'); END",
    "CREATE TRIGGER trg_path_run_collection BEFORE INSERT ON collection_paths WHEN NOT EXISTS("
    "SELECT 1 FROM collection_memberships m JOIN collection_runs r ON "
    "r.id=NEW.collection_run_id WHERE m.id=NEW.membership_id AND "
    "r.collection_id=m.collection_id) BEGIN SELECT RAISE(ABORT,'path run must belong to "
    "collection'); END",
    "CREATE TRIGGER trg_primary_role_insert BEFORE INSERT ON accepted_primary_assets WHEN NOT "
    "EXISTS(SELECT 1 FROM work_version_assets a WHERE a.id=NEW.work_version_asset_id AND "
    "a.work_version_id=NEW.work_version_id AND a.role='primary-pdf') BEGIN SELECT RAISE(ABORT,"
    "'accepted primary asset must have primary-pdf role'); END",
    "CREATE TRIGGER trg_primary_role_update BEFORE UPDATE OF work_version_id,"
    "work_version_asset_id ON accepted_primary_assets WHEN NOT EXISTS(SELECT 1 FROM "
    "work_version_assets a WHERE a.id=NEW.work_version_asset_id AND "
    "a.work_version_id=NEW.work_version_id AND a.role='primary-pdf') BEGIN SELECT RAISE(ABORT,"
    "'accepted primary asset must retain primary-pdf role'); END",
    "CREATE TRIGGER trg_accepted_asset_relation_update BEFORE UPDATE OF work_version_id,"
    "artifact_id,role ON work_version_assets WHEN EXISTS(SELECT 1 FROM accepted_primary_assets "
    "p WHERE p.work_version_asset_id=OLD.id) AND (NEW.work_version_id<>OLD.work_version_id OR "
    "NEW.artifact_id<>OLD.artifact_id OR NEW.role<>'primary-pdf') BEGIN SELECT RAISE(ABORT,"
    "'accepted primary relation is immutable'); END",
    "CREATE TRIGGER trg_light_current_alignment BEFORE INSERT ON "
    "work_version_current_light_document WHEN NOT EXISTS(SELECT 1 FROM light_documents d JOIN "
    "accepted_primary_assets p ON p.work_version_id=d.work_version_id AND "
    "p.work_version_asset_id=d.primary_asset_id WHERE d.id=NEW.light_document_id AND "
    "d.work_version_id=NEW.work_version_id) BEGIN SELECT RAISE(ABORT,'current light document "
    "must align to current primary asset'); END",
    "CREATE TRIGGER trg_light_current_alignment_update BEFORE UPDATE ON "
    "work_version_current_light_document WHEN NOT EXISTS(SELECT 1 FROM light_documents d JOIN "
    "accepted_primary_assets p ON p.work_version_id=d.work_version_id AND "
    "p.work_version_asset_id=d.primary_asset_id WHERE d.id=NEW.light_document_id AND "
    "d.work_version_id=NEW.work_version_id) BEGIN SELECT RAISE(ABORT,'current light document "
    "must retain primary asset alignment'); END",
    "CREATE TRIGGER trg_light_artifact_identity_insert BEFORE INSERT ON light_documents WHEN "
    "NOT EXISTS(SELECT 1 FROM artifacts a WHERE a.id=NEW.artifact_id AND "
    "a.kind='light-document' AND a.sha256=NEW.sha256 AND a.byte_size=length(CAST("
    "sciretriever_canonical_json(NEW.document_json) AS BLOB))) BEGIN SELECT RAISE(ABORT,'light "
    "document must equal published artifact bytes'); END",
    "CREATE TRIGGER trg_light_artifact_identity_update BEFORE UPDATE OF artifact_id,sha256,"
    "document_json ON light_documents WHEN NOT EXISTS(SELECT 1 FROM artifacts a WHERE "
    "a.id=NEW.artifact_id AND a.kind='light-document' AND a.sha256=NEW.sha256 AND "
    "a.byte_size=length(CAST(sciretriever_canonical_json(NEW.document_json) AS BLOB))) BEGIN "
    "SELECT RAISE(ABORT,'light document must retain published artifact identity'); END",
    "CREATE TRIGGER trg_analysis_artifact_identity_insert BEFORE INSERT ON analysis_artifacts "
    "WHEN NOT EXISTS(SELECT 1 FROM artifacts a WHERE a.id=NEW.artifact_id AND a.kind='analysis' "
    "AND a.sha256=NEW.sha256 AND a.byte_size=length(CAST(sciretriever_canonical_json("
    "NEW.proposal_json) AS BLOB))) BEGIN SELECT RAISE(ABORT,'analysis proposal must equal "
    "published artifact bytes'); END",
    "CREATE TRIGGER trg_analysis_artifact_identity_update BEFORE UPDATE OF artifact_id,sha256,"
    "proposal_json ON analysis_artifacts WHEN NOT EXISTS(SELECT 1 FROM artifacts a WHERE "
    "a.id=NEW.artifact_id AND a.kind='analysis' AND a.sha256=NEW.sha256 AND a.byte_size=length("
    "CAST(sciretriever_canonical_json(NEW.proposal_json) AS BLOB))) BEGIN SELECT RAISE(ABORT,"
    "'analysis proposal must retain published artifact identity'); END",
    "CREATE TRIGGER trg_completion_alignment_insert BEFORE INSERT ON completion_bundles WHEN "
    "NOT EXISTS(SELECT 1 FROM work_version_current_light_document l JOIN "
    "work_version_current_metadata m ON m.work_version_id=l.work_version_id JOIN "
    "light_documents d ON d.id=l.light_document_id AND d.work_version_id=l.work_version_id JOIN "
    "analysis_artifacts a ON a.id=NEW.analysis_artifact_id AND "
    "a.work_version_id=l.work_version_id AND a.light_document_id=d.id AND "
    "a.input_sha256=d.sha256 WHERE l.work_version_id=NEW.work_version_id AND "
    "l.light_document_id=NEW.light_document_id AND "
    "m.metadata_snapshot_id=NEW.metadata_snapshot_id) BEGIN SELECT RAISE(ABORT,'completion "
    "bundle must align to current facts and analysis input'); END",
    "CREATE TRIGGER trg_completion_alignment_update BEFORE UPDATE ON completion_bundles WHEN "
    "NOT EXISTS(SELECT 1 FROM work_version_current_light_document l JOIN "
    "work_version_current_metadata m ON m.work_version_id=l.work_version_id JOIN "
    "light_documents d ON d.id=l.light_document_id AND d.work_version_id=l.work_version_id JOIN "
    "analysis_artifacts a ON a.id=NEW.analysis_artifact_id AND "
    "a.work_version_id=l.work_version_id AND a.light_document_id=d.id AND "
    "a.input_sha256=d.sha256 WHERE l.work_version_id=NEW.work_version_id AND "
    "l.light_document_id=NEW.light_document_id AND "
    "m.metadata_snapshot_id=NEW.metadata_snapshot_id) BEGIN SELECT RAISE(ABORT,'completion "
    "bundle must retain current analysis alignment'); END",
    "CREATE TRIGGER trg_completed_light_update BEFORE UPDATE OF work_version_id,"
    "primary_asset_id,artifact_id,sha256 ON light_documents WHEN EXISTS(SELECT 1 FROM "
    "completion_bundles b WHERE b.light_document_id=OLD.id) AND ("
    "NEW.work_version_id<>OLD.work_version_id OR NEW.primary_asset_id<>OLD.primary_asset_id OR "
    "NEW.artifact_id<>OLD.artifact_id OR NEW.sha256<>OLD.sha256) BEGIN SELECT RAISE(ABORT,"
    "'completed light document identity is immutable'); END",
    "CREATE TRIGGER trg_completed_analysis_update BEFORE UPDATE OF work_version_id,"
    "light_document_id,artifact_id,sha256,input_sha256 ON analysis_artifacts WHEN EXISTS(SELECT "
    "1 FROM completion_bundles b WHERE b.analysis_artifact_id=OLD.id) AND ("
    "NEW.work_version_id<>OLD.work_version_id OR NEW.light_document_id<>OLD.light_document_id "
    "OR NEW.artifact_id<>OLD.artifact_id OR NEW.sha256<>OLD.sha256 OR "
    "NEW.input_sha256<>OLD.input_sha256) BEGIN SELECT RAISE(ABORT,'completed analysis identity "
    "is immutable'); END",
    "CREATE TRIGGER trg_completed_current_light_update BEFORE UPDATE ON "
    "work_version_current_light_document WHEN EXISTS(SELECT 1 FROM completion_bundles b WHERE "
    "b.work_version_id=OLD.work_version_id) AND (NEW.work_version_id<>OLD.work_version_id OR "
    "NEW.light_document_id<>OLD.light_document_id) BEGIN SELECT RAISE(ABORT,'completed current "
    "light pointer is immutable'); END",
    "CREATE TRIGGER trg_completed_current_light_delete BEFORE DELETE ON "
    "work_version_current_light_document WHEN EXISTS(SELECT 1 FROM completion_bundles b WHERE "
    "b.work_version_id=OLD.work_version_id) BEGIN SELECT RAISE(ABORT,'completed current light "
    "pointer cannot be removed'); END",
    "CREATE TRIGGER trg_completed_current_metadata_update BEFORE UPDATE ON "
    "work_version_current_metadata WHEN EXISTS(SELECT 1 FROM completion_bundles b WHERE "
    "b.work_version_id=OLD.work_version_id) AND (NEW.work_version_id<>OLD.work_version_id OR "
    "NEW.metadata_snapshot_id<>OLD.metadata_snapshot_id) BEGIN SELECT RAISE(ABORT,'completed "
    "current metadata pointer is immutable'); END",
    "CREATE TRIGGER trg_completed_current_metadata_delete BEFORE DELETE ON "
    "work_version_current_metadata WHEN EXISTS(SELECT 1 FROM completion_bundles b WHERE "
    "b.work_version_id=OLD.work_version_id) BEGIN SELECT RAISE(ABORT,'completed current "
    "metadata pointer cannot be removed'); END",
    "CREATE TRIGGER trg_batch_trigger_type BEFORE INSERT ON batch_runs WHEN "
    "NEW.trigger_collection_run_id IS NOT NULL AND NEW.batch_type<>'process' BEGIN SELECT RAISE("
    "ABORT,'only process batches may advance collection runs'); END",
    "CREATE TRIGGER trg_collection_advancement_match BEFORE UPDATE OF advancement_batch_id ON "
    "collection_runs WHEN NEW.advancement_batch_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM "
    "batch_runs b WHERE b.id=NEW.advancement_batch_id AND b.batch_type='process' AND "
    "b.trigger_collection_run_id=NEW.id) BEGIN SELECT RAISE(ABORT,'collection advancement batch "
    "must point back to run'); END",
)

SCHEMA_MANIFEST: Final = (
    _IDENTITY_DDL
    + COLLECTION_DDL
    + BIBLIOGRAPHY_DDL
    + CONTENT_DDL
    + BATCH_DDL
    + _INDEX_DDL
    + _TRIGGER_DDL
    + DERIVED_DDL
)
SCHEMA_FINGERPRINT: Final = hashlib.sha256("\n".join(SCHEMA_MANIFEST).encode("utf-8")).hexdigest()
SCHEMA_TABLES: Final = (
    "schema_identity",
    "collections",
    "collection_runs",
    "collection_source_results",
    "collection_memberships",
    "collection_causes",
    "collection_paths",
    "works",
    "work_versions",
    "work_version_relations",
    "stable_identifiers",
    "metadata_observations",
    "metadata_snapshots",
    "work_version_current_metadata",
    "work_representative_versions",
    "reference_sets",
    "reference_members",
    "unresolved_references",
    "tag_sets",
    "tag_members",
    "artifacts",
    "raw_assets",
    "work_version_assets",
    "accepted_primary_assets",
    "light_documents",
    "work_version_current_light_document",
    "analysis_artifacts",
    "completion_bundles",
    "batch_runs",
    "batch_targets",
    "batch_counts",
    "current_failures",
    "parser_attempts",
    "opaque_extension_records",
    "metadata_fts",
    "light_text_fts",
    "analysis_fts",
)
