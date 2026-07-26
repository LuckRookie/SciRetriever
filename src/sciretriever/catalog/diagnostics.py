"""Catalog-owned append and query boundary for product diagnostics."""

from __future__ import annotations

import json
from typing import Mapping

from sqlalchemy import Connection, insert, select
from sqlalchemy.engine import RowMapping
from sqlalchemy.exc import IntegrityError, OperationalError

from sciretriever.catalog.engine import CatalogEngine
from sciretriever.catalog.wp6_models import MAX_DIAGNOSTIC_DETAILS_BYTES, diagnostic_records
from sciretriever.core.ids import new_uuid4
from sciretriever.core.timestamps import utc_now_rfc3339
from sciretriever.diagnostics.history import (
    DiagnosticProjection,
    DiagnosticQuery,
    DiagnosticWriteRequest,
    redact_diagnostic_details,
    subject_column,
)
from sciretriever.diagnostics.product import (
    DiagnosticSubjectKind,
    ProductFailure,
    ProductFailureAction,
    ProductFailureBoundaryError,
    ProductFailureReason,
    ProductFailureStage,
    RerunGuidance,
)
from sciretriever.diagnostics.redaction import TRUNCATED
from sciretriever.errors import CatalogError


_SUMMARY = {
    ProductFailureReason.CONFIGURATION: "Configuration prevented the operation",
    ProductFailureReason.PROVIDER: "A provider could not complete the operation",
    ProductFailureReason.IDENTITY: "Identity could not be resolved safely",
    ProductFailureReason.CONTENT: "Content did not satisfy the required checks",
    ProductFailureReason.STORAGE: "Storage could not complete the operation",
    ProductFailureReason.CATALOG: "Catalog diagnostic history is corrupted",
    ProductFailureReason.INTERRUPTED: "The operation was interrupted",
}
_CORRUPTION_INPUT = "sha256:" + "0" * 64


def _canonical(value: Mapping[str, object]) -> str:
    return json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(",", ":"), sort_keys=True)


def _stored_details(request: DiagnosticWriteRequest) -> str:
    sanitized = redact_diagnostic_details(request.details)
    value: dict[str, object] = {"details": dict(sanitized), "rerun": request.failure.rerun.value}
    encoded = _canonical(value)
    if len(encoded.encode("utf-8")) <= MAX_DIAGNOSTIC_DETAILS_BYTES:
        return encoded
    return _canonical({"details": {"content": TRUNCATED}, "rerun": request.failure.rerun.value})


def _projected_details(details_json: str) -> tuple[Mapping[str, object], RerunGuidance]:
    decoded = json.loads(details_json)
    if not isinstance(decoded, Mapping) or set(decoded) != {"details", "rerun"}:
        raise ProductFailureBoundaryError("details")
    details = decoded["details"]
    if not isinstance(details, Mapping):
        raise ProductFailureBoundaryError("details")
    rerun = RerunGuidance(decoded["rerun"])
    sanitized = redact_diagnostic_details(details)
    bounded = _canonical({"details": dict(sanitized), "rerun": rerun.value})
    if (
        len(details_json.encode("utf-8")) > MAX_DIAGNOSTIC_DETAILS_BYTES
        or len(bounded.encode("utf-8")) > MAX_DIAGNOSTIC_DETAILS_BYTES
    ):
        raise ProductFailureBoundaryError("details")
    return sanitized, rerun


def _subject_values(failure: ProductFailure) -> dict[str, str]:
    value = failure.subject_id.removeprefix("sha256:")
    return {subject_column(failure.subject_kind): value}


CatalogDiagnosticRow = Mapping[str, object] | RowMapping


def _subject(row: CatalogDiagnosticRow) -> tuple[DiagnosticSubjectKind, str]:
    kind = DiagnosticSubjectKind(row["subject_kind"])
    value = row[subject_column(kind)]
    if not isinstance(value, str):
        raise ProductFailureBoundaryError("subject_id")
    return kind, "sha256:" + value if kind is DiagnosticSubjectKind.INPUT else value


def _projection(row: CatalogDiagnosticRow) -> DiagnosticProjection:
    try:
        kind, subject_id = _subject(row)
        details_json = row["details_json"]
        if not isinstance(details_json, str):
            raise ProductFailureBoundaryError("details")
        details, rerun = _projected_details(details_json)
        failure = ProductFailure(
            ProductFailureStage(row["stage"]),
            kind,
            subject_id,
            ProductFailureReason(row["reason"]),
            ProductFailureAction(row["action"]),
            rerun,
        )
        row_id = row["id"]
        summary = row["summary"]
        occurred_at = row["occurred_at"]
        if not isinstance(row_id, str) or not isinstance(summary, str) or not isinstance(occurred_at, str):
            raise ProductFailureBoundaryError("row")
        return DiagnosticProjection(row_id, failure, bool(row["retryable"]), summary, details, occurred_at)
    except (KeyError, TypeError, ValueError):
        return _corruption_projection(row)


def _corruption_projection(row: CatalogDiagnosticRow) -> DiagnosticProjection:
    row_id = row.get("id")
    occurred_at = row.get("occurred_at")
    failure = ProductFailure(
        ProductFailureStage.ANALYSIS,
        DiagnosticSubjectKind.INPUT,
        _CORRUPTION_INPUT,
        ProductFailureReason.CATALOG,
        ProductFailureAction.REVIEW,
        RerunGuidance.AFTER_REVIEW,
    )
    return DiagnosticProjection(
        row_id if isinstance(row_id, str) else "00000000-0000-4000-8000-000000000000",
        failure,
        False,
        _SUMMARY[ProductFailureReason.CATALOG],
        {},
        occurred_at if isinstance(occurred_at, str) else "1970-01-01T00:00:00.000Z",
        True,
    )


class CatalogDiagnosticService:
    """Persist and project immutable redacted diagnostic history."""

    def __init__(self, catalog: CatalogEngine) -> None:
        if not isinstance(catalog, CatalogEngine):
            raise TypeError("catalog must be a CatalogEngine")
        self._catalog = catalog

    def append(self, request: DiagnosticWriteRequest) -> DiagnosticProjection:
        if not isinstance(request, DiagnosticWriteRequest):
            raise TypeError("request must be DiagnosticWriteRequest")
        if self._catalog.read_only:
            raise CatalogError("diagnostic history is read-only")
        values = self._values(request)
        try:
            with self._catalog.transaction() as connection:
                connection.execute(insert(diagnostic_records).values(**values))
        except (IntegrityError, OperationalError):
            raise CatalogError("Catalog diagnostic write failed") from None
        return _projection(values)

    def append_in_transaction(
        self,
        connection: Connection,
        request: DiagnosticWriteRequest,
    ) -> DiagnosticProjection:
        if not isinstance(connection, Connection):
            raise TypeError("connection must be a Connection")
        if not isinstance(request, DiagnosticWriteRequest):
            raise TypeError("request must be DiagnosticWriteRequest")
        values = self._values(request)
        connection.execute(insert(diagnostic_records).values(**values))
        return _projection(values)

    @staticmethod
    def _values(request: DiagnosticWriteRequest) -> dict[str, object]:
        return {
            "id": new_uuid4(),
            "stage": request.failure.stage.value,
            "subject_kind": request.failure.subject_kind.value,
            "reason": request.failure.reason.value,
            "action": request.failure.action.value,
            "retryable": int(request.retryable),
            "summary": _SUMMARY[request.failure.reason],
            "details_json": _stored_details(request),
            "occurred_at": utc_now_rfc3339(),
            **_subject_values(request.failure),
        }

    def query(self, query: DiagnosticQuery) -> tuple[DiagnosticProjection, ...]:
        if not isinstance(query, DiagnosticQuery):
            raise TypeError("query must be DiagnosticQuery")
        statement = select(diagnostic_records)
        subject_kind = query.subject.subject_kind if query.subject is not None else query.subject_kind
        subject_id = query.subject.subject_id if query.subject is not None else query.subject_id
        if subject_kind is not None and subject_id is not None:
            statement = statement.where(
                diagnostic_records.c.subject_kind == subject_kind.value,
                diagnostic_records.c[subject_column(subject_kind)]
                == subject_id.removeprefix("sha256:"),
            )
        for column, value in (
            (diagnostic_records.c.stage, query.stage),
            (diagnostic_records.c.reason, query.reason),
            (diagnostic_records.c.action, query.action),
        ):
            if value is not None:
                statement = statement.where(column == value.value)
        if query.retryable is not None:
            statement = statement.where(diagnostic_records.c.retryable == int(query.retryable))
        statement = statement.order_by(diagnostic_records.c.occurred_at.desc(), diagnostic_records.c.id.desc())
        try:
            with self._catalog.connect() as connection:
                rows = connection.execute(statement).mappings().all()
        except (IntegrityError, OperationalError):
            raise CatalogError("Catalog diagnostic query failed") from None
        projected = tuple(
            projection
            for row in rows
            if _matches_details(projection := _projection(row), query)
        )
        return projected[:1] if query.latest else projected


def _matches_details(projection: DiagnosticProjection, query: DiagnosticQuery) -> bool:
    details = projection.details
    if query.role is not None and details.get("asset_role") != query.role:
        return False
    sources = details.get("sources")
    source_rows = (
        tuple(item for item in sources if isinstance(item, Mapping))
        if isinstance(sources, list | tuple)
        else ()
    )
    if query.source is not None and not any(
        item.get("source") == query.source or item.get("provider") == query.source
        for item in source_rows
    ):
        return False
    if query.outcome is not None and details.get("outcome") != query.outcome and not any(
        item.get("outcome") == query.outcome for item in source_rows
    ):
        return False
    return True


__all__ = ("CatalogDiagnosticService",)
