import { createHash } from "node:crypto";

/** Explicit extension. Never included in the frozen v1 manifest. */
export const EXECUTION_SCHEMA_VERSION = 1;
export const EXECUTION_SCHEMA = [
  "CREATE TABLE execution_schema_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, fingerprint TEXT NOT NULL) STRICT",
  "CREATE TABLE execution_candidates(transfer_id TEXT PRIMARY KEY, record_json TEXT NOT NULL CHECK(json_valid(record_json))) STRICT",
  "CREATE TABLE execution_receipts(receipt_id TEXT PRIMARY KEY, transfer_id TEXT NOT NULL REFERENCES execution_candidates(transfer_id), intent_json TEXT NOT NULL CHECK(json_valid(intent_json)), result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json))) STRICT",
] as const;
export const EXECUTION_SCHEMA_FINGERPRINT = createHash("sha256")
  .update(JSON.stringify(EXECUTION_SCHEMA))
  .digest("hex");

/**
 * Durable execution records introduced after the v1 literature catalog.
 *
 * These tables deliberately live in a separate manifest so opening an
 * existing v1 catalog never changes its frozen schema identity.  The
 * migration is explicit (`upgradeExecutionSchema`) and creates an empty
 * runtime surface alongside the candidate/receipt extension.
 */
export const EXECUTION_RUNTIME_SCHEMA_VERSION = 1;
export const EXECUTION_RUNTIME_SCHEMA = [
  "CREATE TABLE execution_runtime_schema_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64)) STRICT",
  "CREATE TABLE execution_schema_migrations(migration_id TEXT PRIMARY KEY CHECK(length(trim(migration_id))>0), from_version INTEGER, to_version INTEGER NOT NULL, manifest_fingerprint TEXT NOT NULL CHECK(length(manifest_fingerprint)=64 AND manifest_fingerprint=lower(manifest_fingerprint) AND manifest_fingerprint NOT GLOB '*[^0-9a-f]*'), action TEXT NOT NULL CHECK(action IN ('migrate','dry-run')), applied_at TEXT NOT NULL) STRICT",
  "CREATE TABLE execution_jobs(job_id TEXT PRIMARY KEY CHECK(length(trim(job_id))>0), target_kind TEXT NOT NULL CHECK(target_kind IN ('literature','selector','discovery')), selector_json TEXT NOT NULL CHECK(json_valid(selector_json)), policy_version TEXT NOT NULL CHECK(length(trim(policy_version))>0), status TEXT NOT NULL CHECK(status IN ('queued','running','paused','cancelled','completed','failed','interrupted')), idempotency_key TEXT NOT NULL UNIQUE CHECK(length(trim(idempotency_key))>0), created_at TEXT NOT NULL, finished_at TEXT) STRICT",
  "CREATE TABLE execution_budgets(job_id TEXT PRIMARY KEY, max_attempts INTEGER NOT NULL CHECK(typeof(max_attempts)='integer' AND max_attempts BETWEEN 1 AND 100000), max_network_bytes INTEGER NOT NULL CHECK(typeof(max_network_bytes)='integer' AND max_network_bytes BETWEEN 1 AND 1099511627776), max_model_calls INTEGER NOT NULL CHECK(typeof(max_model_calls)='integer' AND max_model_calls BETWEEN 0 AND 100000), used_attempts INTEGER NOT NULL CHECK(typeof(used_attempts)='integer' AND used_attempts>=0 AND used_attempts<=max_attempts), used_network_bytes INTEGER NOT NULL CHECK(typeof(used_network_bytes)='integer' AND used_network_bytes>=0 AND used_network_bytes<=max_network_bytes), used_model_calls INTEGER NOT NULL CHECK(typeof(used_model_calls)='integer' AND used_model_calls>=0 AND used_model_calls<=max_model_calls), updated_at TEXT NOT NULL, FOREIGN KEY(job_id) REFERENCES execution_jobs(job_id) ON DELETE CASCADE) STRICT",
  "CREATE TABLE execution_targets(target_id TEXT PRIMARY KEY CHECK(length(trim(target_id))>0), job_id TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK(typeof(ordinal)='integer' AND ordinal>=0), literature_id TEXT, version_role TEXT CHECK(version_role IS NULL OR version_role IN ('published','accepted-manuscript','preprint','other')), stage TEXT NOT NULL CHECK(stage IN ('queued','acquisition','parsing','analysis','literature','completed','failed','skipped','interrupted')), disposition TEXT CHECK(disposition IS NULL OR disposition IN ('pending','completed','failed','skipped','interrupted')), next_eligible_at TEXT, UNIQUE(job_id,ordinal), FOREIGN KEY(job_id) REFERENCES execution_jobs(job_id) ON DELETE CASCADE, FOREIGN KEY(literature_id) REFERENCES literatures(literature_id) ON DELETE RESTRICT) STRICT",
  "CREATE TABLE execution_policy_snapshots(policy_version TEXT PRIMARY KEY CHECK(length(trim(policy_version))>0), policy_sha256 TEXT NOT NULL CHECK(length(policy_sha256)=64 AND policy_sha256=lower(policy_sha256) AND policy_sha256 NOT GLOB '*[^0-9a-f]*'), policy_json TEXT NOT NULL CHECK(json_valid(policy_json)), frozen_at TEXT NOT NULL) STRICT",
  "CREATE TABLE execution_attempts(attempt_id TEXT PRIMARY KEY CHECK(length(trim(attempt_id))>0), target_id TEXT NOT NULL, stage TEXT NOT NULL CHECK(stage IN ('acquisition','parsing','analysis','literature')), status TEXT NOT NULL CHECK(status IN ('running','completed','failed','interrupted','unknown')), started_at TEXT NOT NULL, finished_at TEXT, failure_code TEXT, failure_reason TEXT, failure_action TEXT, failure_retryable INTEGER CHECK(failure_retryable IS NULL OR failure_retryable IN (0,1)), usage_json TEXT CHECK(usage_json IS NULL OR json_valid(usage_json)), FOREIGN KEY(target_id) REFERENCES execution_targets(target_id) ON DELETE CASCADE) STRICT",
  "CREATE TABLE execution_events(event_id TEXT PRIMARY KEY CHECK(length(trim(event_id))>0), job_id TEXT NOT NULL, sequence INTEGER NOT NULL CHECK(typeof(sequence)='integer' AND sequence>=0), kind TEXT NOT NULL CHECK(length(trim(kind))>0), payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), created_at TEXT NOT NULL, UNIQUE(job_id,sequence), FOREIGN KEY(job_id) REFERENCES execution_jobs(job_id) ON DELETE CASCADE) STRICT",
  "CREATE TABLE execution_interventions(intervention_id TEXT PRIMARY KEY CHECK(length(trim(intervention_id))>0), job_id TEXT NOT NULL, target_id TEXT, mode TEXT NOT NULL CHECK(mode IN ('never','notify','pause')), status TEXT NOT NULL CHECK(status IN ('open','resolved','expired','declined')), failure_json TEXT NOT NULL CHECK(json_valid(failure_json) AND length(failure_json)<=16384), created_at TEXT NOT NULL, expires_at TEXT NOT NULL, resolved_at TEXT, resolution_json TEXT CHECK(resolution_json IS NULL OR (json_valid(resolution_json) AND length(resolution_json)<=16384)), FOREIGN KEY(job_id) REFERENCES execution_jobs(job_id) ON DELETE CASCADE, FOREIGN KEY(target_id) REFERENCES execution_targets(target_id) ON DELETE CASCADE) STRICT",
  "CREATE TABLE execution_leases(lease_id TEXT PRIMARY KEY CHECK(length(trim(lease_id))>0), job_id TEXT NOT NULL, workspace_id TEXT, boot_id TEXT NOT NULL, control_epoch INTEGER NOT NULL CHECK(typeof(control_epoch)='integer' AND control_epoch>=0), acquired_at TEXT NOT NULL, released_at TEXT, FOREIGN KEY(job_id) REFERENCES execution_jobs(job_id) ON DELETE CASCADE) STRICT",
  "CREATE UNIQUE INDEX execution_workspace_active_lease ON execution_leases(workspace_id) WHERE workspace_id IS NOT NULL AND released_at IS NULL",
] as const;
export const EXECUTION_RUNTIME_SCHEMA_FINGERPRINT = createHash("sha256")
  .update(JSON.stringify(EXECUTION_RUNTIME_SCHEMA))
  .digest("hex");
