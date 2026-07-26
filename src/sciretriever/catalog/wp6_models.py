from __future__ import annotations

from sqlalchemy import (
    CheckConstraint,
    Column,
    ForeignKey,
    Index,
    Integer,
    String,
    Table,
    Text,
    UniqueConstraint,
)

from sciretriever.catalog.models import (
    _created_at_column,
    _id_column,
    _json_check,
    _sha256_check,
    _timestamp_check,
    _uuid_check,
    _values,
    metadata,
)


DIAGNOSTIC_STAGES = ("metadata", "acquisition", "analysis", "expansion")
DIAGNOSTIC_SUBJECTS = ("input", "work", "work_version", "processing_run", "expansion")
DIAGNOSTIC_REASONS = (
    "configuration", "provider", "identity", "content", "storage", "catalog",
    "interrupted",
)
DIAGNOSTIC_ACTIONS = (
    "check_configuration", "check_credentials", "retry", "try_another_source",
    "review", "repair_storage", "none",
)
CURATION_ACTIONS = (
    "resolve_review", "merge_work", "regroup_work_version", "set_preferred",
    "clear_preferred", "set_metadata", "clear_metadata", "add_tag", "remove_tag",
    "merge_author", "undo",
)
CURATION_SUBJECTS = ("review", "work", "work_version", "author", "operation")
MAX_DIAGNOSTIC_DETAILS_BYTES = 4096
MAX_SNAPSHOT_BYTES = 16384
MAX_EVIDENCE_BYTES = 4096


diagnostic_records = Table(
    "diagnostic_records",
    metadata,
    _id_column(),
    Column("stage", Text, nullable=False),
    Column("subject_kind", Text, nullable=False),
    Column("input_fingerprint", String(64)),
    Column("work_id", String(36), ForeignKey("works.id", ondelete="CASCADE")),
    Column("work_version_id", String(36), ForeignKey("work_versions.id", ondelete="CASCADE")),
    Column("processing_run_id", String(36), ForeignKey("processing_runs.id", ondelete="CASCADE")),
    Column("reason", Text, nullable=False),
    Column("action", Text, nullable=False),
    Column("retryable", Integer, nullable=False),
    Column("summary", Text, nullable=False),
    Column("details_json", Text, nullable=False),
    _created_at_column("occurred_at"),
    CheckConstraint(_uuid_check("id"), name="id_uuid"),
    CheckConstraint(f"stage IN ({_values(DIAGNOSTIC_STAGES)})", name="stage"),
    CheckConstraint(f"subject_kind IN ({_values(DIAGNOSTIC_SUBJECTS)})", name="subject_kind"),
    CheckConstraint(f"reason IN ({_values(DIAGNOSTIC_REASONS)})", name="reason"),
    CheckConstraint(f"action IN ({_values(DIAGNOSTIC_ACTIONS)})", name="action"),
    CheckConstraint("retryable IN (0, 1)", name="retryable_boolean"),
    CheckConstraint("length(trim(summary)) BETWEEN 1 AND 240", name="summary_bounds"),
    CheckConstraint(_json_check("details_json"), name="details_json"),
    CheckConstraint(
        f"length(CAST(details_json AS BLOB)) <= {MAX_DIAGNOSTIC_DETAILS_BYTES}",
        name="details_json_bounds",
    ),
    CheckConstraint(
        "(subject_kind = 'input' AND input_fingerprint IS NOT NULL "
        "AND work_id IS NULL AND work_version_id IS NULL AND processing_run_id IS NULL) OR "
        "(subject_kind IN ('work', 'expansion') AND input_fingerprint IS NULL "
        "AND work_id IS NOT NULL AND work_version_id IS NULL AND processing_run_id IS NULL) OR "
        "(subject_kind = 'work_version' AND input_fingerprint IS NULL "
        "AND work_id IS NULL AND work_version_id IS NOT NULL AND processing_run_id IS NULL) OR "
        "(subject_kind = 'processing_run' AND input_fingerprint IS NULL "
        "AND work_id IS NULL AND work_version_id IS NULL AND processing_run_id IS NOT NULL)",
        name="subject_identity",
    ),
    CheckConstraint(_sha256_check("input_fingerprint", nullable=True), name="input_fingerprint"),
    CheckConstraint(_timestamp_check("occurred_at"), name="occurred_at_rfc3339"),
)

Index(
    "ix_diagnostic_records_stage_occurred_at",
    diagnostic_records.c.stage,
    diagnostic_records.c.occurred_at,
)
Index("ix_diagnostic_records_work_id", diagnostic_records.c.work_id)
Index("ix_diagnostic_records_work_version_id", diagnostic_records.c.work_version_id)


curation_operations = Table(
    "curation_operations",
    metadata,
    _id_column(),
    Column("action", Text, nullable=False),
    Column("subject_kind", Text, nullable=False),
    Column("subject_id", String(36), nullable=False),
    Column("before_snapshot_json", Text, nullable=False),
    Column("before_sha256", String(64), nullable=False),
    Column("after_snapshot_json", Text, nullable=False),
    Column("after_sha256", String(64), nullable=False),
    Column("stale_guard_sha256", String(64), nullable=False),
    Column("evidence_json", Text, nullable=False),
    Column("undo_handler_json", Text),
    Column("review_decision", Text, nullable=False),
    Column("result", Text, nullable=False),
    Column("operation_sha256", String(64), nullable=False),
    Column(
        "undo_of_operation_id",
        String(36),
        ForeignKey("curation_operations.id", ondelete="RESTRICT"),
    ),
    _created_at_column("occurred_at"),
    UniqueConstraint("undo_of_operation_id", name="single_undo"),
    CheckConstraint(_uuid_check("id"), name="id_uuid"),
    CheckConstraint(_uuid_check("subject_id"), name="subject_id_uuid"),
    CheckConstraint(f"action IN ({_values(CURATION_ACTIONS)})", name="action"),
    CheckConstraint(f"subject_kind IN ({_values(CURATION_SUBJECTS)})", name="subject_kind"),
    CheckConstraint(
        "(action = 'resolve_review' AND subject_kind = 'review') OR "
        "(action IN ('merge_work', 'set_preferred', 'clear_preferred', 'add_tag', 'remove_tag') "
        "AND subject_kind = 'work') OR "
        "(action IN ('regroup_work_version', 'set_metadata', 'clear_metadata') "
        "AND subject_kind = 'work_version') OR "
        "(action = 'merge_author' AND subject_kind = 'author') OR "
        "(action = 'undo' AND subject_kind = 'operation')",
        name="action_subject",
    ),
    CheckConstraint(
        "(action = 'undo' AND subject_kind = 'operation' "
        "AND subject_id = undo_of_operation_id) "
        "OR (action <> 'undo' AND subject_kind <> 'operation' AND undo_of_operation_id IS NULL)",
        name="undo_state",
    ),
    CheckConstraint(_json_check("before_snapshot_json"), name="before_snapshot_json"),
    CheckConstraint(_json_check("after_snapshot_json"), name="after_snapshot_json"),
    CheckConstraint(_json_check("evidence_json"), name="evidence_json"),
    CheckConstraint("undo_handler_json IS NULL OR json_valid(undo_handler_json)", name="undo_handler_json"),
    CheckConstraint(
        "review_decision IN ('confirmed', 'rejected', 'deferred', 'not_required')",
        name="review_decision",
    ),
    CheckConstraint("result IN ('applied', 'undone')", name="result"),
    CheckConstraint(
        "(action = 'undo' AND result = 'undone') OR (action <> 'undo' AND result = 'applied')",
        name="action_result",
    ),
    CheckConstraint(_sha256_check("operation_sha256"), name="operation_sha256"),
    CheckConstraint(
        f"length(CAST(before_snapshot_json AS BLOB)) <= {MAX_SNAPSHOT_BYTES}",
        name="before_snapshot_bounds",
    ),
    CheckConstraint(
        f"length(CAST(after_snapshot_json AS BLOB)) <= {MAX_SNAPSHOT_BYTES}",
        name="after_snapshot_bounds",
    ),
    CheckConstraint(
        f"length(CAST(evidence_json AS BLOB)) <= {MAX_EVIDENCE_BYTES}",
        name="evidence_bounds",
    ),
    CheckConstraint(
        "undo_handler_json IS NULL OR length(CAST(undo_handler_json AS BLOB)) <= 65536",
        name="undo_handler_bounds",
    ),
    CheckConstraint(_sha256_check("before_sha256"), name="before_sha256"),
    CheckConstraint(_sha256_check("after_sha256"), name="after_sha256"),
    CheckConstraint(_sha256_check("stale_guard_sha256"), name="stale_guard_sha256"),
    CheckConstraint(_timestamp_check("occurred_at"), name="occurred_at_rfc3339"),
)

Index(
    "ix_curation_operations_subject_occurred_at",
    curation_operations.c.subject_kind,
    curation_operations.c.subject_id,
    curation_operations.c.occurred_at,
)
Index("ix_curation_operations_action", curation_operations.c.action)
Index("ix_curation_operations_undo_of_operation_id", curation_operations.c.undo_of_operation_id)


work_merge_lineage = Table(
    "work_merge_lineage",
    metadata,
    Column("source_work_id", String(36), ForeignKey("works.id", ondelete="RESTRICT"), primary_key=True),
    Column("target_work_id", String(36), ForeignKey("works.id", ondelete="RESTRICT"), nullable=False),
    Column("operation_id", String(36), ForeignKey("curation_operations.id", ondelete="RESTRICT"), nullable=False, unique=True),
    _created_at_column("merged_at"),
    CheckConstraint("source_work_id <> target_work_id", name="not_self_merge"),
    CheckConstraint(_timestamp_check("merged_at"), name="merged_at_rfc3339"),
)
Index("ix_work_merge_lineage_target_work_id", work_merge_lineage.c.target_work_id)


author_merge_lineage = Table(
    "author_merge_lineage",
    metadata,
    Column("source_author_id", String(36), ForeignKey("authors.id", ondelete="RESTRICT"), primary_key=True),
    Column("target_author_id", String(36), ForeignKey("authors.id", ondelete="RESTRICT"), nullable=False),
    Column("operation_id", String(36), ForeignKey("curation_operations.id", ondelete="RESTRICT"), nullable=False, unique=True),
    _created_at_column("merged_at"),
    CheckConstraint("source_author_id <> target_author_id", name="not_self_merge"),
    CheckConstraint(_timestamp_check("merged_at"), name="merged_at_rfc3339"),
)
Index("ix_author_merge_lineage_target_author_id", author_merge_lineage.c.target_author_id)


__all__ = (
    "author_merge_lineage", "curation_operations", "diagnostic_records",
    "work_merge_lineage",
)
