from __future__ import annotations

from collections.abc import Mapping, Sequence
import hashlib
from typing import Protocol

from sciretriever.diagnostics.history import DiagnosticProjection, DiagnosticWriteRequest
from sciretriever.diagnostics.product import (
    DiagnosticSubjectKind,
    ProductFailure,
    ProductFailureAction,
    ProductFailureReason,
    ProductFailureStage,
    RerunGuidance,
)


class DiagnosticAppender(Protocol):
    def append(self, request: DiagnosticWriteRequest) -> DiagnosticProjection: ...


def metadata_input_fingerprint(normalized_input: str) -> str:
    if not isinstance(normalized_input, str) or not normalized_input:
        raise ValueError("normalized_input must be a nonempty string")
    return "sha256:" + hashlib.sha256(normalized_input.encode("utf-8")).hexdigest()


class MetadataFailureOwner:
    def __init__(self, diagnostics: DiagnosticAppender) -> None:
        self._diagnostics = diagnostics

    def provider_total_failure(
        self,
        normalized_input: str,
        providers: Sequence[str],
        details: Mapping[str, object],
    ) -> DiagnosticProjection:
        failure = ProductFailure(
            ProductFailureStage.METADATA,
            DiagnosticSubjectKind.INPUT,
            metadata_input_fingerprint(normalized_input),
            ProductFailureReason.PROVIDER,
            ProductFailureAction.RETRY,
            RerunGuidance.RETRY,
        )
        return self._diagnostics.append(DiagnosticWriteRequest(
            failure,
            True,
            {"providers": tuple(providers), **details},
        ))


class AcquisitionFailureOwner:
    def __init__(self, diagnostics: DiagnosticAppender) -> None:
        self._diagnostics = diagnostics

    def exhausted(
        self,
        work_version_id: str,
        asset_role: str,
        sources: Sequence[Mapping[str, object]],
    ) -> DiagnosticProjection:
        failure = acquisition_failure(work_version_id, "sources_exhausted")
        return self._diagnostics.append(DiagnosticWriteRequest(
            failure,
            False,
            {"asset_role": asset_role, "sources": tuple(sources[:50])},
        ))


def acquisition_failure(work_version_id: str, category: str) -> ProductFailure:
    normalized = category.casefold()
    if any(token in normalized for token in (
        "storage", "durability", "corrupt", "publication", "catalog", "staging", "finalization",
    )):
        reason = ProductFailureReason.STORAGE
        action = ProductFailureAction.REPAIR_STORAGE
        rerun = RerunGuidance.AFTER_REVIEW
    elif "config" in normalized or "credential" in normalized:
        reason = ProductFailureReason.CONFIGURATION
        action = ProductFailureAction.CHECK_CONFIGURATION
        rerun = RerunGuidance.AFTER_CONFIGURATION_CHANGE
    elif "identity" in normalized or "validation" in normalized or "content" in normalized:
        reason = ProductFailureReason.CONTENT
        action = ProductFailureAction.REVIEW
        rerun = RerunGuidance.AFTER_REVIEW
    else:
        reason = ProductFailureReason.PROVIDER
        action = ProductFailureAction.TRY_ANOTHER_SOURCE
        rerun = RerunGuidance.AFTER_SOURCE_CHANGE
    return ProductFailure(
        ProductFailureStage.ACQUISITION,
        DiagnosticSubjectKind.WORK_VERSION,
        work_version_id,
        reason,
        action,
        rerun,
    )


def processing_failure(
    processing_run_id: str,
    category: str,
    retryable: bool,
) -> ProductFailure:
    normalized = category.casefold()
    if "interrupt" in normalized or "cancel" in normalized:
        reason = ProductFailureReason.INTERRUPTED
        action = ProductFailureAction.NONE
        rerun = RerunGuidance.RETRY
    elif "config" in normalized or "credential" in normalized:
        reason = ProductFailureReason.CONFIGURATION
        action = ProductFailureAction.CHECK_CONFIGURATION
        rerun = RerunGuidance.AFTER_CONFIGURATION_CHANGE
    elif "storage" in normalized or "publication" in normalized:
        reason = ProductFailureReason.STORAGE
        action = ProductFailureAction.REPAIR_STORAGE
        rerun = RerunGuidance.AFTER_REVIEW
    elif any(token in normalized for token in ("content", "validation", "protocol", "source_map")):
        reason = ProductFailureReason.CONTENT
        action = ProductFailureAction.REVIEW
        rerun = RerunGuidance.AFTER_REVIEW
    else:
        reason = ProductFailureReason.PROVIDER
        action = ProductFailureAction.RETRY
        rerun = RerunGuidance.RETRY
    return ProductFailure(
        ProductFailureStage.ANALYSIS,
        DiagnosticSubjectKind.PROCESSING_RUN,
        processing_run_id,
        reason,
        action,
        rerun,
    )


__all__ = (
    "AcquisitionFailureOwner",
    "MetadataFailureOwner",
    "acquisition_failure",
    "metadata_input_fingerprint",
    "processing_failure",
)
