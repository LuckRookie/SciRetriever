"""Read-time diagnostic projection for new envelopes and untouched legacy rows."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Mapping

from sciretriever.diagnostics.codec import decode_diagnostic
from sciretriever.diagnostics.contracts import AttemptMetadata, DiagnosticEnvelope
from sciretriever.diagnostics.mapping import map_exception
from sciretriever.errors import CatalogError, ProviderErrorCategory, ProviderSearchError


@dataclass(frozen=True, slots=True)
class AttemptSummary:
    id: str
    provider: str | None
    outcome: str | None
    started_at: str | None
    finished_at: str | None

    def to_dict(self) -> dict[str, object]:
        return {
            "finished_at": self.finished_at,
            "id": self.id,
            "outcome": self.outcome,
            "provider": self.provider,
            "started_at": self.started_at,
        }


@dataclass(frozen=True, slots=True)
class FailureProjection:
    id: str
    occurred_at: str | None
    category: str
    diagnostic: DiagnosticEnvelope

    def to_dict(self) -> dict[str, object]:
        return {
            "category": self.category,
            "diagnostic": self.diagnostic.to_dict(),
            "id": self.id,
            "occurred_at": self.occurred_at,
        }


@dataclass(frozen=True, slots=True)
class JobProjection:
    job_id: str
    work_id: str
    asset_role: str
    state: str
    created_at: str | None
    updated_at: str | None
    attempts: tuple[AttemptSummary, ...]
    failures: tuple[FailureProjection, ...]
    event_count: int

    def to_dict(self) -> dict[str, object]:
        return {
            "asset_role": self.asset_role,
            "attempts": [attempt.to_dict() for attempt in self.attempts],
            "created_at": self.created_at,
            "event_count": self.event_count,
            "failures": [failure.to_dict() for failure in self.failures],
            "job_id": self.job_id,
            "state": self.state,
            "updated_at": self.updated_at,
            "work_id": self.work_id,
        }


def diagnostic_from_details(
    details_json: str | None,
    *,
    category: str,
    retryable: bool,
    provider: str | None = None,
    attempt: AttemptMetadata | None = None,
) -> DiagnosticEnvelope:
    if details_json is not None:
        try:
            value = json.loads(details_json)
        except (TypeError, ValueError):
            value = None
        if isinstance(value, Mapping) and "diagnostic" in value:
            diagnostic = value["diagnostic"]
            if not isinstance(diagnostic, Mapping):
                raise ValueError("diagnostic details must contain an object")
            encoded = json.dumps(diagnostic, ensure_ascii=True, allow_nan=False, separators=(",", ":"), sort_keys=True)
            return decode_diagnostic(encoded)
    error = _legacy_error(category, provider, retryable)
    return map_exception(error, provider=provider, retryable=retryable, attempt=attempt)


def safe_diagnostic_from_details(
    details_json: str | None,
    *,
    category: str,
    retryable: bool,
    provider: str | None = None,
) -> DiagnosticEnvelope:
    """Decode a diagnostic while closing malformed or unknown envelopes."""
    try:
        return diagnostic_from_details(
            details_json,
            category=category,
            retryable=retryable,
            provider=provider,
        )
    except (TypeError, ValueError):
        return map_exception(RuntimeError("invalid historical diagnostic"), retryable=False)


def _legacy_error(category: str, provider: str | None, retryable: bool) -> BaseException:
    normalized = category.lower()
    provider_category = {
        "authentication": ProviderErrorCategory.AUTHENTICATION,
        "rate_limit": ProviderErrorCategory.RATE_LIMIT,
        "transport": ProviderErrorCategory.TRANSPORT,
        "server": ProviderErrorCategory.SERVER,
        "invalid_response": ProviderErrorCategory.INVALID_RESPONSE,
    }.get(normalized)
    if provider_category is not None:
        return ProviderSearchError(provider or "unknown", provider_category, "legacy failure", retryable=retryable)
    if "catalog" in normalized:
        return CatalogError("legacy failure")
    return RuntimeError("legacy failure")


__all__ = (
    "AttemptSummary",
    "FailureProjection",
    "JobProjection",
    "diagnostic_from_details",
    "safe_diagnostic_from_details",
)
