from typing import Final

CONTENT_DDL: Final = (
    "CREATE TABLE artifacts(id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('raw',"
    "'light-document','analysis')),sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND "
    "sha256=lower(sha256)),storage_path TEXT NOT NULL CHECK(storage_path<>'' AND substr("
    "storage_path,1,1)<>'/' AND instr(storage_path,'..')=0),byte_size INTEGER NOT NULL CHECK("
    "byte_size>=0),media_type TEXT,UNIQUE(kind,sha256),UNIQUE(id,kind),UNIQUE(id,sha256)) "
    "STRICT",
    "CREATE TABLE raw_assets(artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE "
    "RESTRICT,asset_role TEXT NOT NULL CHECK(asset_role IN ('primary-pdf','supplementary-pdf',"
    "'xml','html','supplementary')),source_json TEXT NOT NULL CHECK(json_valid(source_json))) "
    "STRICT",
    "CREATE TABLE work_version_assets(id TEXT PRIMARY KEY,work_version_id TEXT NOT NULL "
    "REFERENCES work_versions(id) ON DELETE CASCADE,artifact_id TEXT NOT NULL REFERENCES "
    "raw_assets(artifact_id),role TEXT NOT NULL CHECK(role IN ('primary-pdf',"
    "'supplementary-pdf','xml','html','supplementary')),UNIQUE(work_version_id,artifact_id,role)"
    ",UNIQUE(id,work_version_id)) STRICT",
    "CREATE TABLE accepted_primary_assets(work_version_id TEXT PRIMARY KEY REFERENCES "
    "work_versions(id) ON DELETE CASCADE,work_version_asset_id TEXT NOT NULL UNIQUE,UNIQUE("
    "work_version_id,work_version_asset_id),FOREIGN KEY(work_version_asset_id,work_version_id) "
    "REFERENCES work_version_assets(id,work_version_id)) STRICT",
    "CREATE TABLE light_documents(id TEXT PRIMARY KEY,work_version_id TEXT NOT NULL REFERENCES "
    "work_versions(id) ON DELETE CASCADE,primary_asset_id TEXT NOT NULL,artifact_id TEXT NOT "
    "NULL REFERENCES artifacts(id),sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND "
    "sha256=sciretriever_sha256(sciretriever_canonical_json(document_json))),document_json TEXT "
    "NOT NULL CHECK(json_valid(document_json) AND document_json=sciretriever_canonical_json("
    "document_json)),provenance_json TEXT NOT NULL CHECK(json_valid(provenance_json) AND "
    "provenance_json=sciretriever_canonical_json(provenance_json)),complete INTEGER NOT NULL "
    "CHECK(complete=1),UNIQUE(id,work_version_id),FOREIGN KEY(work_version_id,primary_asset_id) "
    "REFERENCES accepted_primary_assets(work_version_id,work_version_asset_id)) STRICT",
    "CREATE TABLE work_version_current_light_document(work_version_id TEXT PRIMARY KEY "
    "REFERENCES work_versions(id) ON DELETE CASCADE,light_document_id TEXT NOT NULL UNIQUE,"
    "FOREIGN KEY(light_document_id,work_version_id) REFERENCES light_documents(id,"
    "work_version_id)) STRICT",
    "CREATE TABLE analysis_artifacts(id TEXT PRIMARY KEY,work_version_id TEXT NOT NULL "
    "REFERENCES work_versions(id) ON DELETE CASCADE,light_document_id TEXT NOT NULL,artifact_id "
    "TEXT NOT NULL REFERENCES artifacts(id),sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND "
    "sha256=sciretriever_sha256(sciretriever_canonical_json(proposal_json))),input_sha256 TEXT "
    "NOT NULL CHECK(length(input_sha256)=64),proposal_json TEXT NOT NULL CHECK(json_valid("
    "proposal_json) AND proposal_json=sciretriever_canonical_json(proposal_json)),"
    "provenance_json TEXT NOT NULL CHECK(json_valid(provenance_json) AND "
    "provenance_json=sciretriever_canonical_json(provenance_json)),nine_categories_complete "
    "INTEGER NOT NULL CHECK(nine_categories_complete=1),UNIQUE(id,work_version_id),FOREIGN KEY("
    "light_document_id,work_version_id) REFERENCES light_documents(id,work_version_id)) STRICT",
    "CREATE TABLE completion_bundles(work_version_id TEXT PRIMARY KEY REFERENCES work_versions("
    "id) ON DELETE CASCADE,light_document_id TEXT NOT NULL,analysis_artifact_id TEXT NOT NULL,"
    "metadata_snapshot_id TEXT NOT NULL,reference_set_id TEXT NOT NULL,tag_set_id TEXT NOT NULL,"
    "identity_sha256 TEXT NOT NULL CHECK(length(identity_sha256)=64 AND identity_sha256=lower("
    "identity_sha256)),created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY("
    "light_document_id,work_version_id) REFERENCES light_documents(id,work_version_id),FOREIGN "
    "KEY(analysis_artifact_id,work_version_id) REFERENCES analysis_artifacts(id,work_version_id)"
    ",FOREIGN KEY(metadata_snapshot_id,work_version_id) REFERENCES metadata_snapshots(id,"
    "work_version_id),FOREIGN KEY(reference_set_id,work_version_id) REFERENCES reference_sets("
    "id,work_version_id),FOREIGN KEY(tag_set_id,work_version_id) REFERENCES tag_sets(id,"
    "work_version_id)) STRICT",
)
