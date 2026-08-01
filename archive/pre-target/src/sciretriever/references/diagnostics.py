from __future__ import annotations

from sciretriever.catalog.diagnostics import CatalogDiagnosticService
from sciretriever.catalog.engine import CatalogEngine
from sciretriever.diagnostics.history import DiagnosticWriteRequest
from sciretriever.diagnostics.product import (
    DiagnosticSubjectKind,
    ProductFailure,
    ProductFailureAction,
    ProductFailureReason,
    ProductFailureStage,
    RerunGuidance,
)


class ReferenceDiagnosticOwner:
    def __init__(self, catalog: CatalogEngine) -> None:
        self._diagnostics = CatalogDiagnosticService(catalog)

    def append(self, work_version_id: str, conflict: bool) -> None:
        failure = ProductFailure(
            ProductFailureStage.EXPANSION,
            DiagnosticSubjectKind.WORK_VERSION,
            work_version_id,
            ProductFailureReason.IDENTITY,
            ProductFailureAction.REVIEW if conflict else ProductFailureAction.RETRY,
            RerunGuidance.AFTER_REVIEW if conflict else RerunGuidance.RETRY,
        )
        self._diagnostics.append(DiagnosticWriteRequest(
            failure,
            not conflict,
            {"resolution": "conflict" if conflict else "unresolved"},
        ))


__all__ = ("ReferenceDiagnosticOwner",)
