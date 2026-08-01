from typing import Final

BIBLIOGRAPHY_DDL: Final = (
    "CREATE TABLE works(id TEXT PRIMARY KEY,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP) "
    "STRICT",
    "CREATE TABLE work_versions(id TEXT PRIMARY KEY,work_id TEXT NOT NULL REFERENCES works(id) "
    "ON DELETE CASCADE,version_role TEXT NOT NULL CHECK(version_role IN ('formal',"
    "'accepted-manuscript','preprint','other')),created_at TEXT NOT NULL DEFAULT "
    "CURRENT_TIMESTAMP,UNIQUE(id,work_id)) STRICT",
    "CREATE TABLE work_version_relations(id TEXT PRIMARY KEY,left_version_id TEXT NOT NULL "
    "REFERENCES work_versions(id) ON DELETE CASCADE,right_version_id TEXT NOT NULL REFERENCES "
    "work_versions(id) ON DELETE CASCADE,relation TEXT NOT NULL,CHECK("
    "left_version_id<>right_version_id),UNIQUE(left_version_id,right_version_id,relation)) "
    "STRICT",
    "CREATE TABLE stable_identifiers(id TEXT PRIMARY KEY,work_version_id TEXT NOT NULL "
    "REFERENCES work_versions(id) ON DELETE CASCADE,namespace TEXT NOT NULL,value TEXT NOT NULL,"
    "UNIQUE(namespace,value)) STRICT",
    "CREATE TABLE metadata_observations(id TEXT PRIMARY KEY,work_version_id TEXT NOT NULL "
    "REFERENCES work_versions(id) ON DELETE CASCADE,provider TEXT NOT NULL,provider_record_id "
    "TEXT NOT NULL,payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256)=64),payload_json "
    "TEXT NOT NULL CHECK(json_valid(payload_json)),observed_at TEXT NOT NULL,UNIQUE(provider,"
    "provider_record_id,payload_sha256)) STRICT",
    "CREATE TABLE metadata_snapshots(id TEXT PRIMARY KEY,work_version_id TEXT NOT NULL "
    "REFERENCES work_versions(id) ON DELETE CASCADE,revision INTEGER NOT NULL CHECK(revision>=1)"
    ",sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256=sciretriever_metadata_sha256("
    "revision,values_json,provenance_json)),values_json TEXT NOT NULL CHECK(json_valid("
    "values_json) AND values_json=sciretriever_canonical_json(values_json)),provenance_json "
    "TEXT NOT NULL CHECK(json_valid(provenance_json) AND "
    "provenance_json=sciretriever_canonical_json(provenance_json)),UNIQUE(id,work_version_id),"
    "UNIQUE(work_version_id,revision)) STRICT",
    "CREATE TABLE work_version_current_metadata(work_version_id TEXT PRIMARY KEY REFERENCES "
    "work_versions(id) ON DELETE CASCADE,metadata_snapshot_id TEXT NOT NULL,FOREIGN KEY("
    "metadata_snapshot_id,work_version_id) REFERENCES metadata_snapshots(id,work_version_id)) "
    "STRICT",
    "CREATE TABLE work_representative_versions(work_id TEXT PRIMARY KEY REFERENCES works(id) ON "
    "DELETE CASCADE,work_version_id TEXT NOT NULL,FOREIGN KEY(work_version_id,work_id) "
    "REFERENCES work_versions(id,work_id)) STRICT",
    "CREATE TABLE reference_sets(id TEXT PRIMARY KEY,work_version_id TEXT NOT NULL REFERENCES "
    "work_versions(id) ON DELETE CASCADE,revision INTEGER NOT NULL CHECK(revision>=1),complete "
    "INTEGER NOT NULL CHECK(complete=1),UNIQUE(id,work_version_id),UNIQUE(work_version_id,"
    "revision)) STRICT",
    "CREATE TABLE reference_members(id TEXT PRIMARY KEY,reference_set_id TEXT NOT NULL "
    "REFERENCES reference_sets(id) ON DELETE CASCADE,ordinal INTEGER NOT NULL CHECK(ordinal>=0),"
    "target_work_id TEXT REFERENCES works(id),target_work_version_id TEXT REFERENCES "
    "work_versions(id),reference_json TEXT NOT NULL CHECK(json_valid(reference_json)),UNIQUE("
    "reference_set_id,ordinal)) STRICT",
    "CREATE TABLE unresolved_references(id TEXT PRIMARY KEY,reference_set_id TEXT NOT NULL "
    "REFERENCES reference_sets(id) ON DELETE CASCADE,ordinal INTEGER NOT NULL CHECK(ordinal>=0),"
    "raw_text TEXT NOT NULL,reference_json TEXT NOT NULL CHECK(json_valid(reference_json)),"
    "UNIQUE(reference_set_id,ordinal)) STRICT",
    "CREATE TABLE tag_sets(id TEXT PRIMARY KEY,work_version_id TEXT NOT NULL REFERENCES "
    "work_versions(id) ON DELETE CASCADE,revision INTEGER NOT NULL CHECK(revision>=1),complete "
    "INTEGER NOT NULL CHECK(complete=1),UNIQUE(id,work_version_id),UNIQUE(work_version_id,"
    "revision)) STRICT",
    "CREATE TABLE tag_members(id TEXT PRIMARY KEY,tag_set_id TEXT NOT NULL REFERENCES tag_sets("
    "id) ON DELETE CASCADE,name TEXT NOT NULL,evidence_json TEXT NOT NULL CHECK(json_valid("
    "evidence_json)),UNIQUE(tag_set_id,name)) STRICT",
)
