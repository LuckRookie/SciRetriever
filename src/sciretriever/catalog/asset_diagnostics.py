"""Asset-intent diagnostic and abandonment catalog operations."""

from __future__ import annotations

from typing import Any, Mapping

from sqlalchemy import select, update

from sciretriever.catalog.catalog_owner import CatalogOwner
from sciretriever.catalog.diagnostics import CatalogDiagnosticService
from sciretriever.catalog.models import asset_intents
from sciretriever.catalog.records import AssetIntentRecord
from sciretriever.catalog.repository import _required_text, catalog_operation
from sciretriever.core.enums import AssetIntentState
from sciretriever.core.ids import validate_uuid
from sciretriever.core.timestamps import utc_now_rfc3339
from sciretriever.diagnostics.history import DiagnosticProjection, DiagnosticWriteRequest
from sciretriever.diagnostics.owners import acquisition_failure
from sciretriever.errors import CatalogError


def _intent_record(row: Mapping[Any, Any]) -> AssetIntentRecord:
    return AssetIntentRecord.from_row(row)


class AssetDiagnosticRepository(CatalogOwner):
    def append_intent_diagnostic(
        self,
        intent_id: str,
        category: str,
        message: str,
        *,
        retryable: bool = False,
        details: object | None = None,
    ) -> DiagnosticProjection:
        intent_id = validate_uuid(intent_id, "intent_id")
        category = _required_text(category, "category")
        _required_text(message, "message")
        if not isinstance(retryable, bool):
            raise TypeError("retryable must be a boolean")
        diagnostics = CatalogDiagnosticService(self._catalog)
        with catalog_operation("asset intent failure recording"):
            with self._catalog.critical_transaction() as connection:
                row = (
                    connection.execute(select(asset_intents).where(asset_intents.c.id == intent_id))
                    .mappings()
                    .one_or_none()
                )
                if row is None:
                    raise CatalogError(f"asset intent does not exist: {intent_id}")
                return diagnostics.append_in_transaction(
                    connection,
                    DiagnosticWriteRequest(
                        acquisition_failure(row["work_version_id"], category),
                        retryable,
                        {"intent_id": intent_id, "category": category, "details": details},
                    ),
                )

    def abandon_pending_intent(
        self,
        intent_id: str,
        category: str,
        message: str,
        *,
        retryable: bool = False,
        details: object | None = None,
    ) -> AssetIntentRecord:
        return self.abandon_pending_intent_with_diagnostic(
            intent_id, category, message, retryable=retryable, details=details
        )[0]

    def abandon_pending_intent_with_diagnostic(
        self,
        intent_id: str,
        category: str,
        message: str,
        *,
        retryable: bool = False,
        details: object | None = None,
    ) -> tuple[AssetIntentRecord, DiagnosticProjection | None]:
        intent_id = validate_uuid(intent_id, "intent_id")
        category = _required_text(category, "category")
        _required_text(message, "message")
        if not isinstance(retryable, bool):
            raise TypeError("retryable must be a boolean")
        diagnostics = CatalogDiagnosticService(self._catalog)
        with catalog_operation("asset intent abandonment"):
            with self._catalog.critical_transaction() as connection:
                row = (
                    connection.execute(select(asset_intents).where(asset_intents.c.id == intent_id))
                    .mappings()
                    .one_or_none()
                )
                if row is None:
                    raise CatalogError(f"asset intent does not exist: {intent_id}")
                state = AssetIntentState(row["state"])
                if state is AssetIntentState.ABANDONED:
                    return _intent_record(row), None
                if state is not AssetIntentState.PENDING:
                    raise CatalogError(f"cannot abandon an asset intent in state {state.value}")
                changes = {
                    "state": AssetIntentState.ABANDONED.value,
                    "updated_at": utc_now_rfc3339(),
                }
                connection.execute(
                    update(asset_intents).where(asset_intents.c.id == intent_id).values(**changes)
                )
                diagnostic = diagnostics.append_in_transaction(
                    connection,
                    DiagnosticWriteRequest(
                        acquisition_failure(row["work_version_id"], category),
                        retryable,
                        {"intent_id": intent_id, "category": category, "details": details},
                    ),
                )
                return _intent_record({**dict(row), **changes}), diagnostic


__all__ = ("AssetDiagnosticRepository",)
