from __future__ import annotations

import sqlite3
from typing import Final
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.engine import Connection
from sqlalchemy.exc import OperationalError

from sciretriever.catalog.curation_contracts import (
    CurationAlreadyUndoneError,
    CurationAuditCorruptError,
    CurationBoundaryError,
    CurationBusyError,
    CurationCapture,
    CurationCompensationError,
    CurationFailpoint,
    CurationHandler,
    CurationMutation,
    CurationNoChangeError,
    CurationRequest,
    CurationStaleError,
    CurationStep,
)
from sciretriever.catalog.curation_records import (
    CurationAuditRecord,
    append_audit,
    footprint_sha256,
    load_audit,
    new_audit_record,
)
from sciretriever.catalog.engine import CatalogEngine
from sciretriever.catalog.curation_handler_codec import decode_handler, encode_handler
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
from sciretriever.core.snapshots import SafeSnapshot


_NO_FAILPOINT: Final[CurationFailpoint] = lambda _point: None


class CurationOperationOwner:
    def __init__(
        self,
        catalog: CatalogEngine,
        *,
        test_failpoint: CurationFailpoint = _NO_FAILPOINT,
    ) -> None:
        self._catalog = catalog
        self._failpoint = test_failpoint

    @staticmethod
    def apply_failpoints(handler: CurationHandler) -> tuple[str, ...]:
        families = tuple(step.family for step in handler.steps())
        return tuple(
            point for family in families for point in
            (f"apply:before:{family}", f"apply:after:{family}")
        ) + ("apply:before:audit", "apply:after:audit")

    @staticmethod
    def undo_failpoints(handler: CurationHandler) -> tuple[str, ...]:
        families = tuple(step.family for step in reversed(handler.steps()))
        return tuple(
            point for family in families for point in
            (f"undo:before:{family}", f"undo:after:{family}")
        ) + ("undo:before:audit", "undo:after:audit")

    def apply(self, request: CurationRequest) -> CurationAuditRecord:
        steps = self._validate_handler(request.handler)
        operation_id = request.operation_id or str(uuid4())
        try:
            with self._catalog.critical_transaction() as connection:
                before = request.handler.capture(connection)
                before_hash = footprint_sha256(before.footprint)
                expected_before_hash = request.expected_before_sha256
                if expected_before_hash is not None and before_hash != expected_before_hash:
                    raise CurationStaleError(operation_id)
                for step in steps:
                    self._run_step("apply", step, step.apply, connection)
                after = request.handler.capture(connection)
                after_hash = footprint_sha256(after.footprint)
                if before_hash == after_hash:
                    raise CurationNoChangeError(request.handler.subject_id)
                operation = CurationOperation.create(
                    action=request.handler.action,
                    subject_kind=request.handler.subject_kind,
                    subject_id=request.handler.subject_id,
                    before=before.snapshot, after=after.snapshot,
                    review_decision=request.review_decision,
                )
                record = new_audit_record(
                    operation_id, operation,
                    (before_hash, after_hash, before_hash),
                    request.evidence,
                    encode_handler(request.handler),
                )
                self._append("apply", connection, record)
                return record
        except OperationalError as error:
            if self._is_busy(error):
                raise CurationBusyError() from None
            raise

    def undo(self, operation_id: str, handler: CurationHandler | None = None) -> CurationAuditRecord:
        operation_key = validate_uuid(operation_id, "operation_id")
        try:
            with self._catalog.critical_transaction() as connection:
                original = load_audit(connection, operation_key)
                if original is None:
                    raise CurationAuditCorruptError(operation_key)
                selected_handler = handler
                if selected_handler is None:
                    if original.undo_handler_json is None:
                        raise CurationAuditCorruptError(operation_key)
                    selected_handler = decode_handler(self._catalog, original.undo_handler_json)
                steps = self._validate_handler(selected_handler)
                self._validate_undo_target(original, selected_handler)
                child = connection.execute(select(curation_operations.c.id).where(
                    curation_operations.c.undo_of_operation_id == operation_key
                )).scalar_one_or_none()
                if child is not None:
                    raise CurationAlreadyUndoneError(operation_key)
                before = selected_handler.capture(connection)
                if footprint_sha256(before.footprint) != original.after_sha256:
                    raise CurationStaleError(operation_key)
                for step in reversed(steps):
                    self._run_step("undo", step, step.compensate, connection)
                after = selected_handler.capture(connection)
                after_hash = footprint_sha256(after.footprint)
                if after_hash != original.before_sha256:
                    raise CurationCompensationError(operation_key)
                operation = CurationOperation.create(
                    action=CurationAction.UNDO,
                    subject_kind=CurationSubjectKind.OPERATION,
                    subject_id=operation_key,
                    before=before.snapshot, after=after.snapshot,
                    review_decision=ReviewDecision.NOT_REQUIRED,
                    result=CurationResult.UNDONE,
                    undo_of=CurationOperationId(operation_key),
                )
                record = new_audit_record(
                    str(uuid4()), operation,
                    (original.after_sha256, after_hash, original.after_sha256),
                    original.evidence,
                )
                self._append("undo", connection, record)
                return record
        except OperationalError as error:
            if self._is_busy(error):
                raise CurationBusyError() from None
            raise

    def _append(self, phase: str, connection: Connection, record: CurationAuditRecord) -> None:
        self._failpoint(f"{phase}:before:audit")
        append_audit(connection, record)
        self._failpoint(f"{phase}:after:audit")

    def _run_step(
        self, phase: str, step: CurationStep,
        mutation: CurationMutation,
        connection: Connection,
    ) -> None:
        self._failpoint(f"{phase}:before:{step.family}")
        mutation(connection)
        self._failpoint(f"{phase}:after:{step.family}")

    @staticmethod
    def _validate_handler(handler: CurationHandler) -> tuple[CurationStep, ...]:
        CurationOperation.create(
            action=handler.action, subject_kind=handler.subject_kind,
            subject_id=handler.subject_id,
            before=SafeSnapshot(()), after=SafeSnapshot(()),
            review_decision=ReviewDecision.NOT_REQUIRED,
        )
        steps = handler.steps()
        if not steps or len({step.family for step in steps}) != len(steps):
            raise CurationBoundaryError("steps")
        return steps

    @staticmethod
    def _validate_undo_target(record: CurationAuditRecord, handler: CurationHandler) -> None:
        operation = record.operation
        if operation.action is CurationAction.UNDO:
            raise CurationAuditCorruptError(record.id)
        if operation.result is not CurationResult.APPLIED or record.stale_guard_sha256 != record.before_sha256:
            raise CurationAuditCorruptError(record.id)
        if (operation.action, operation.subject_kind, operation.subject_id) != (
            handler.action, handler.subject_kind, handler.subject_id,
        ):
            raise CurationBoundaryError("handler_mismatch")

    @staticmethod
    def _is_busy(error: OperationalError) -> bool:
        origin = error.orig
        return isinstance(origin, sqlite3.OperationalError) and origin.sqlite_errorcode in {
            sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED,
        }


__all__ = (
    "CurationAlreadyUndoneError", "CurationAuditCorruptError", "CurationBoundaryError",
    "CurationBusyError", "CurationCapture", "CurationCompensationError", "CurationNoChangeError", "CurationOperationOwner", "CurationRequest",
    "CurationStaleError", "CurationStep",
)
