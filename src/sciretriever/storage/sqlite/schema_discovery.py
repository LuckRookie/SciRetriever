"""Relationship DDL for durable, bounded DiscoveryRun facts.

The Entry-owned repository will publish these rows in later integration work.
This module only defines the closed relational foundation needed to preserve
typed inputs, provider boundaries, accepted results, and their direct causes.
It deliberately has no lifecycle triggers, publication logic, process state,
or fallback JSON representation.  Its small integrity triggers only freeze
cause identity fields and validate the normalized concrete-Literature binding
that cannot be expressed by a scalar ``CHECK``.
"""

from __future__ import annotations

from typing import Final

_DISCOVERY_RUNS_DDL: Final[str] = (
    "CREATE TABLE discovery_runs("
    "discovery_run_id TEXT NOT NULL PRIMARY KEY "
    "CHECK(length(trim(discovery_run_id))>0),"
    "kind TEXT NOT NULL CHECK(kind IN ('topic','citation')),"
    "status TEXT NOT NULL CHECK(status IN "
    "('RUNNING','COMPLETED','PARTIAL','FAILED','INTERRUPTED')),"
    "started_at TEXT NOT NULL CHECK(length(trim(started_at))>0),"
    "UNIQUE(discovery_run_id,kind)"
    ") STRICT"
)

_TOPIC_DISCOVERY_INPUTS_DDL: Final[str] = (
    "CREATE TABLE topic_discovery_inputs("
    "discovery_run_id TEXT NOT NULL PRIMARY KEY,"
    "kind TEXT NOT NULL CHECK(kind='topic'),"
    "query TEXT NOT NULL CHECK(length(trim(query))>0),"
    "year_from INTEGER,year_to INTEGER,"
    "CHECK(year_from IS NULL OR "
    "(typeof(year_from)='integer' AND year_from BETWEEN 1 AND 9999)),"
    "CHECK(year_to IS NULL OR "
    "(typeof(year_to)='integer' AND year_to BETWEEN 1 AND 9999)),"
    "CHECK(year_from IS NULL OR year_to IS NULL OR year_from<=year_to),"
    "FOREIGN KEY(discovery_run_id,kind) "
    "REFERENCES discovery_runs(discovery_run_id,kind) ON DELETE RESTRICT"
    ") STRICT"
)

_CITATION_DISCOVERY_INPUTS_DDL: Final[str] = (
    "CREATE TABLE citation_discovery_inputs("
    "discovery_run_id TEXT NOT NULL PRIMARY KEY,"
    "kind TEXT NOT NULL CHECK(kind='citation'),"
    "direction TEXT NOT NULL CHECK(direction IN ('references','cited-by','both')),"
    "max_depth INTEGER NOT NULL "
    "CHECK(typeof(max_depth)='integer' AND max_depth>=0),"
    "result_limit INTEGER NOT NULL "
    "CHECK(typeof(result_limit)='integer' AND result_limit>=1),"
    "FOREIGN KEY(discovery_run_id,kind) "
    "REFERENCES discovery_runs(discovery_run_id,kind) ON DELETE RESTRICT"
    ") STRICT"
)

_CITATION_DISCOVERY_SEEDS_DDL: Final[str] = (
    "CREATE TABLE citation_discovery_seeds("
    "discovery_run_id TEXT NOT NULL,"
    "seed_ordinal INTEGER NOT NULL "
    "CHECK(typeof(seed_ordinal)='integer' AND seed_ordinal>=0),"
    "literature_id TEXT NOT NULL,"
    "PRIMARY KEY(discovery_run_id,seed_ordinal),"
    "UNIQUE(discovery_run_id,literature_id),"
    "FOREIGN KEY(discovery_run_id) "
    "REFERENCES citation_discovery_inputs(discovery_run_id) ON DELETE RESTRICT,"
    "FOREIGN KEY(literature_id) REFERENCES literatures(literature_id) ON DELETE RESTRICT"
    ") STRICT"
)

_DISCOVERY_RUN_PROVIDERS_DDL: Final[str] = (
    "CREATE TABLE discovery_run_providers("
    "discovery_run_id TEXT NOT NULL,"
    "provider_ordinal INTEGER NOT NULL "
    "CHECK(typeof(provider_ordinal)='integer' AND provider_ordinal>=0),"
    "provider_name TEXT NOT NULL CHECK(length(trim(provider_name))>0),"
    "scan_limit INTEGER NOT NULL "
    "CHECK(typeof(scan_limit)='integer' AND scan_limit>=1),"
    "PRIMARY KEY(discovery_run_id,provider_ordinal),"
    "UNIQUE(discovery_run_id,provider_name),"
    "FOREIGN KEY(discovery_run_id) "
    "REFERENCES discovery_runs(discovery_run_id) ON DELETE RESTRICT"
    ") STRICT"
)

_DISCOVERY_SOURCE_RESULTS_DDL: Final[str] = (
    "CREATE TABLE discovery_source_results("
    "discovery_run_id TEXT NOT NULL,"
    "provider_name TEXT NOT NULL,"
    "outcome TEXT NOT NULL CHECK(outcome IN "
    "('EXHAUSTED','SCAN_LIMIT_REACHED','FAILED')),"
    "failure_code TEXT,failure_reason TEXT,failure_action TEXT,failure_retryable INTEGER,"
    "PRIMARY KEY(discovery_run_id,provider_name),"
    "CHECK(failure_code IS NULL OR length(trim(failure_code))>0),"
    "CHECK(failure_reason IS NULL OR length(trim(failure_reason))>0),"
    "CHECK(failure_action IS NULL OR length(trim(failure_action))>0),"
    "CHECK(failure_retryable IS NULL OR "
    "(typeof(failure_retryable)='integer' AND failure_retryable IN (0,1))),"
    "CHECK((outcome='FAILED' AND failure_code IS NOT NULL AND "
    "failure_reason IS NOT NULL AND failure_action IS NOT NULL AND "
    "failure_retryable IS NOT NULL) OR "
    "(outcome<>'FAILED' AND failure_code IS NULL AND failure_reason IS NULL AND "
    "failure_action IS NULL AND failure_retryable IS NULL)),"
    "FOREIGN KEY(discovery_run_id,provider_name) REFERENCES "
    "discovery_run_providers(discovery_run_id,provider_name) ON DELETE RESTRICT"
    ") STRICT"
)

_DISCOVERY_RESULTS_DDL: Final[str] = (
    "CREATE TABLE discovery_results("
    "discovery_run_id TEXT NOT NULL,meta_literature_id TEXT NOT NULL,"
    "PRIMARY KEY(discovery_run_id,meta_literature_id),"
    "FOREIGN KEY(discovery_run_id) "
    "REFERENCES discovery_runs(discovery_run_id) ON DELETE RESTRICT,"
    "FOREIGN KEY(meta_literature_id) "
    "REFERENCES meta_literatures(meta_literature_id) ON DELETE RESTRICT"
    ") STRICT"
)

_TOPIC_DISCOVERY_CAUSES_DDL: Final[str] = (
    "CREATE TABLE topic_discovery_causes("
    "discovery_run_id TEXT NOT NULL,meta_literature_id TEXT NOT NULL,"
    "metadata_observation_id TEXT NOT NULL,actual_literature_id TEXT NOT NULL,"
    "PRIMARY KEY(discovery_run_id,meta_literature_id,metadata_observation_id),"
    "UNIQUE(discovery_run_id,metadata_observation_id),"
    "FOREIGN KEY(discovery_run_id) "
    "REFERENCES topic_discovery_inputs(discovery_run_id) ON DELETE RESTRICT,"
    "FOREIGN KEY(discovery_run_id,meta_literature_id) REFERENCES "
    "discovery_results(discovery_run_id,meta_literature_id) "
    "ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,"
    "FOREIGN KEY(actual_literature_id,metadata_observation_id) REFERENCES "
    "literature_metadata_observations(literature_id,observation_id) "
    "ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,"
    "FOREIGN KEY(meta_literature_id,actual_literature_id) REFERENCES "
    "literatures(meta_literature_id,literature_id) "
    "ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED"
    ") STRICT"
)

_CITATION_DISCOVERY_CAUSES_DDL: Final[str] = (
    "CREATE TABLE citation_discovery_causes("
    "discovery_run_id TEXT NOT NULL,meta_literature_id TEXT NOT NULL,"
    "source_literature_id TEXT NOT NULL,target_literature_id TEXT NOT NULL,"
    "actual_literature_id TEXT NOT NULL,"
    "depth INTEGER NOT NULL CHECK(typeof(depth)='integer' AND depth>=1),"
    "CHECK(source_literature_id<>target_literature_id),"
    "CHECK(actual_literature_id IN (source_literature_id,target_literature_id)),"
    "PRIMARY KEY(discovery_run_id,meta_literature_id,source_literature_id,"
    "target_literature_id,depth),"
    "UNIQUE(discovery_run_id,source_literature_id,target_literature_id,depth),"
    "FOREIGN KEY(discovery_run_id) "
    "REFERENCES citation_discovery_inputs(discovery_run_id) ON DELETE RESTRICT,"
    "FOREIGN KEY(discovery_run_id,meta_literature_id) REFERENCES "
    "discovery_results(discovery_run_id,meta_literature_id) "
    "ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,"
    "FOREIGN KEY(source_literature_id) "
    "REFERENCES literatures(literature_id) ON DELETE RESTRICT,"
    "FOREIGN KEY(target_literature_id) "
    "REFERENCES literatures(literature_id) ON DELETE RESTRICT,"
    "FOREIGN KEY(meta_literature_id,actual_literature_id) REFERENCES "
    "literatures(meta_literature_id,literature_id) "
    "ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED"
    ") STRICT"
)

_TOPIC_DISCOVERY_CAUSE_INSERT_CLOSURE_DDL: Final[str] = (
    "CREATE TRIGGER topic_discovery_cause_insert_closure "
    "BEFORE INSERT ON topic_discovery_causes "
    "WHEN NOT EXISTS("
    "SELECT 1 FROM literature_metadata_observations AS ownership "
    "JOIN literatures AS literature "
    "ON literature.literature_id=ownership.literature_id "
    "WHERE ownership.observation_id=NEW.metadata_observation_id "
    "AND ownership.literature_id=NEW.actual_literature_id "
    "AND literature.meta_literature_id=NEW.meta_literature_id) "
    "BEGIN SELECT RAISE(ABORT,'invalid topic discovery cause closure'); END"
)

_TOPIC_DISCOVERY_CAUSE_UPDATE_IDENTITY_DDL: Final[str] = (
    "CREATE TRIGGER topic_discovery_cause_update_identity "
    "BEFORE UPDATE ON topic_discovery_causes "
    "WHEN NEW.discovery_run_id IS NOT OLD.discovery_run_id "
    "OR NEW.metadata_observation_id IS NOT OLD.metadata_observation_id "
    "BEGIN SELECT RAISE(ABORT,'topic discovery cause identity is immutable'); END"
)

_CITATION_DISCOVERY_CAUSE_INSERT_CLOSURE_DDL: Final[str] = (
    "CREATE TRIGGER citation_discovery_cause_insert_closure "
    "BEFORE INSERT ON citation_discovery_causes "
    "WHEN NEW.actual_literature_id NOT IN "
    "(NEW.source_literature_id,NEW.target_literature_id) "
    "OR NOT EXISTS(SELECT 1 FROM literatures AS literature "
    "WHERE literature.literature_id=NEW.actual_literature_id "
    "AND literature.meta_literature_id=NEW.meta_literature_id) "
    "BEGIN SELECT RAISE(ABORT,'invalid citation discovery cause closure'); END"
)

_CITATION_DISCOVERY_CAUSE_UPDATE_IDENTITY_DDL: Final[str] = (
    "CREATE TRIGGER citation_discovery_cause_update_identity "
    "BEFORE UPDATE ON citation_discovery_causes "
    "WHEN NEW.discovery_run_id IS NOT OLD.discovery_run_id "
    "OR NEW.source_literature_id IS NOT OLD.source_literature_id "
    "OR NEW.target_literature_id IS NOT OLD.target_literature_id "
    "OR NEW.actual_literature_id IS NOT OLD.actual_literature_id "
    "OR NEW.depth IS NOT OLD.depth "
    "BEGIN SELECT RAISE(ABORT,'citation discovery cause identity is immutable'); END"
)

_DISCOVERY_RUN_STATUS_LOOKUP_DDL: Final[str] = (
    "CREATE INDEX discovery_run_status_lookup ON discovery_runs(status,started_at,discovery_run_id)"
)

_CITATION_DISCOVERY_SEED_LITERATURE_LOOKUP_DDL: Final[str] = (
    "CREATE INDEX citation_discovery_seed_literature_lookup "
    "ON citation_discovery_seeds(literature_id,discovery_run_id,seed_ordinal)"
)

_DISCOVERY_RESULT_META_LOOKUP_DDL: Final[str] = (
    "CREATE INDEX discovery_result_meta_lookup "
    "ON discovery_results(meta_literature_id,discovery_run_id)"
)

_TOPIC_DISCOVERY_CAUSE_OBSERVATION_LOOKUP_DDL: Final[str] = (
    "CREATE INDEX topic_discovery_cause_observation_lookup "
    "ON topic_discovery_causes(metadata_observation_id,actual_literature_id,"
    "discovery_run_id,meta_literature_id)"
)

_CITATION_DISCOVERY_CAUSE_SOURCE_LOOKUP_DDL: Final[str] = (
    "CREATE INDEX citation_discovery_cause_source_lookup "
    "ON citation_discovery_causes(source_literature_id,discovery_run_id,"
    "meta_literature_id,depth,target_literature_id)"
)

_CITATION_DISCOVERY_CAUSE_TARGET_LOOKUP_DDL: Final[str] = (
    "CREATE INDEX citation_discovery_cause_target_lookup "
    "ON citation_discovery_causes(target_literature_id,discovery_run_id,"
    "meta_literature_id,depth,source_literature_id)"
)


DISCOVERY_SCHEMA_MANIFEST: Final[tuple[str, ...]] = (
    _DISCOVERY_RUNS_DDL,
    _TOPIC_DISCOVERY_INPUTS_DDL,
    _CITATION_DISCOVERY_INPUTS_DDL,
    _CITATION_DISCOVERY_SEEDS_DDL,
    _DISCOVERY_RUN_PROVIDERS_DDL,
    _DISCOVERY_SOURCE_RESULTS_DDL,
    _DISCOVERY_RESULTS_DDL,
    _TOPIC_DISCOVERY_CAUSES_DDL,
    _CITATION_DISCOVERY_CAUSES_DDL,
    _DISCOVERY_RUN_STATUS_LOOKUP_DDL,
    _CITATION_DISCOVERY_SEED_LITERATURE_LOOKUP_DDL,
    _DISCOVERY_RESULT_META_LOOKUP_DDL,
    _TOPIC_DISCOVERY_CAUSE_OBSERVATION_LOOKUP_DDL,
    _CITATION_DISCOVERY_CAUSE_SOURCE_LOOKUP_DDL,
    _CITATION_DISCOVERY_CAUSE_TARGET_LOOKUP_DDL,
    _TOPIC_DISCOVERY_CAUSE_INSERT_CLOSURE_DDL,
    _TOPIC_DISCOVERY_CAUSE_UPDATE_IDENTITY_DDL,
    _CITATION_DISCOVERY_CAUSE_INSERT_CLOSURE_DDL,
    _CITATION_DISCOVERY_CAUSE_UPDATE_IDENTITY_DDL,
)

DISCOVERY_SCHEMA_TABLES: Final[tuple[str, ...]] = (
    "discovery_runs",
    "topic_discovery_inputs",
    "citation_discovery_inputs",
    "citation_discovery_seeds",
    "discovery_run_providers",
    "discovery_source_results",
    "discovery_results",
    "topic_discovery_causes",
    "citation_discovery_causes",
)

DISCOVERY_SCHEMA_INDEXES: Final[tuple[str, ...]] = (
    "discovery_run_status_lookup",
    "citation_discovery_seed_literature_lookup",
    "discovery_result_meta_lookup",
    "topic_discovery_cause_observation_lookup",
    "citation_discovery_cause_source_lookup",
    "citation_discovery_cause_target_lookup",
)

DISCOVERY_SCHEMA_TRIGGERS: Final[tuple[str, ...]] = (
    "topic_discovery_cause_insert_closure",
    "topic_discovery_cause_update_identity",
    "citation_discovery_cause_insert_closure",
    "citation_discovery_cause_update_identity",
)


__all__ = (
    "DISCOVERY_SCHEMA_INDEXES",
    "DISCOVERY_SCHEMA_MANIFEST",
    "DISCOVERY_SCHEMA_TABLES",
    "DISCOVERY_SCHEMA_TRIGGERS",
)
