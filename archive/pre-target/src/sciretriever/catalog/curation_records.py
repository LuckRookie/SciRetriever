from __future__ import annotations

from dataclasses import dataclass
import hashlib
from typing import assert_never

from sqlalchemy import insert, select
from sqlalchemy.engine import Connection

from sciretriever.catalog.curation_contracts import CurationAuditCorruptError
from sciretriever.catalog.wp6_models import curation_operations
from sciretriever.core.curation import (
    CurationAction,
    CurationOperation,
    CurationOperationId,
    CurationResult,
    CurationSubjectKind,
    ReviewDecision,
)
from sciretriever.core.ids import validate_uuid
from sciretriever.core.snapshots import (
    SafeSnapshot,
    SnapshotBoundaryError,
    SnapshotValue,
    canonical_json_bytes,
    strict_json_object,
)
from sciretriever.core.timestamps import utc_now_rfc3339


@dataclass(frozen=True, slots=True)
class CurationAuditRecord:
    id: CurationOperationId
    operation: CurationOperation
    before_sha256: str
    after_sha256: str
    stale_guard_sha256: str
    evidence: SafeSnapshot
    occurred_at: str
    undo_handler_json: str | None = None


def footprint_sha256(capture: bytes) -> str:
    return hashlib.sha256(capture).hexdigest()


def append_audit(
    connection: Connection,
    record: CurationAuditRecord,
) -> None:
    operation = record.operation
    connection.execute(insert(curation_operations).values(
        id=record.id,
        action=operation.action.value,
        subject_kind=operation.subject_kind.value,
        subject_id=operation.subject_id,
        before_snapshot_json=canonical_json_bytes(operation.before.to_dict()).decode("ascii"),
        before_sha256=record.before_sha256,
        after_snapshot_json=canonical_json_bytes(operation.after.to_dict()).decode("ascii"),
        after_sha256=record.after_sha256,
        stale_guard_sha256=record.stale_guard_sha256,
        evidence_json=canonical_json_bytes(record.evidence.to_dict()).decode("ascii"),
        review_decision=operation.review_decision.value,
        result=operation.result.value,
        operation_sha256=operation.operation_sha256,
        undo_of_operation_id=operation.undo_of,
        undo_handler_json=record.undo_handler_json,
        occurred_at=record.occurred_at,
    ))


def new_audit_record(
    operation_id: str,
    operation: CurationOperation,
    hashes: tuple[str, str, str],
    evidence: SafeSnapshot,
    undo_handler_json: str | None = None,
) -> CurationAuditRecord:
    before_sha256, after_sha256, stale_guard_sha256 = hashes
    return CurationAuditRecord(
        CurationOperationId(validate_uuid(operation_id, "operation_id")), operation,
        before_sha256, after_sha256, stale_guard_sha256, evidence, utc_now_rfc3339(),
        undo_handler_json,
    )


def _load_snapshot(
    stored: str | bytes | int | float | None,
    operation_id: str,
) -> SafeSnapshot:
    match stored:
        case str():
            try:
                decoded = strict_json_object(stored.encode("ascii"))
                values: dict[str, SnapshotValue] = {}
                for name, value in decoded.items():
                    match value:
                        case None | bool() | int() | str():
                            values[name] = value
                        case dict():
                            raise SnapshotBoundaryError("nested_snapshot")
                        case _ as unreachable:
                            assert_never(unreachable)
                return SafeSnapshot.from_dict(values)
            except (UnicodeEncodeError, TypeError, ValueError, SnapshotBoundaryError):
                raise CurationAuditCorruptError(operation_id) from None
        case bytes() | int() | float() | None:
            raise CurationAuditCorruptError(operation_id)
        case _ as unreachable:
            assert_never(unreachable)


def load_audit(connection: Connection, operation_id: str) -> CurationAuditRecord | None:
    operation_key = validate_uuid(operation_id, "operation_id")
    row = connection.execute(
        select(curation_operations).where(curation_operations.c.id == operation_key)
    ).mappings().one_or_none()
    if row is None:
        return None
    try:
        before = _load_snapshot(row["before_snapshot_json"], operation_key)
        after = _load_snapshot(row["after_snapshot_json"], operation_key)
        evidence = _load_snapshot(row["evidence_json"], operation_key)
        undo_raw = row["undo_of_operation_id"]
        undo_of = None if undo_raw is None else CurationOperationId(str(undo_raw))
        operation = CurationOperation(
            action=CurationAction(str(row["action"])),
            subject_kind=CurationSubjectKind(str(row["subject_kind"])),
            subject_id=str(row["subject_id"]), before=before, after=after,
            review_decision=ReviewDecision(str(row["review_decision"])),
            result=CurationResult(str(row["result"])), undo_of=undo_of,
            operation_sha256=str(row["operation_sha256"]),
        )
        if operation.action is CurationAction.UNDO and operation.result is not CurationResult.UNDONE:
            raise CurationAuditCorruptError(operation_key)
        return CurationAuditRecord(
            CurationOperationId(operation_key), operation, str(row["before_sha256"]),
            str(row["after_sha256"]), str(row["stale_guard_sha256"]), evidence,
            str(row["occurred_at"]),
            None if row["undo_handler_json"] is None else str(row["undo_handler_json"]),
        )
    except (KeyError, TypeError, ValueError, SnapshotBoundaryError):
        raise CurationAuditCorruptError(operation_key) from None


__all__ = (
    "CurationAuditRecord", "append_audit", "footprint_sha256", "load_audit",
    "new_audit_record",
)
