"""Deterministic typed-error to stable diagnostic mapping."""

from __future__ import annotations

import asyncio
import hashlib
import json
import re

from sciretriever.diagnostics.contracts import ActionCode, AttemptMetadata, DiagnosticEnvelope, FailureStage, ReasonCode
from sciretriever.diagnostics.redaction import redact_text
from sciretriever.errors import (
    CatalogError,
    ConfigError,
    DurabilityError,
    ProviderErrorCategory,
    StorageCorruptionError,
    StorageError,
    ValidationError,
)


_PROVIDER_TOKEN = re.compile(r"^[a-z][a-z0-9-]{0,63}$")


_PROVIDER_MAPPING = {
    ProviderErrorCategory.AUTHENTICATION: (ReasonCode.AUTHENTICATION_REQUIRED, ActionCode.CHECK_CREDENTIALS),
    ProviderErrorCategory.CONFIGURATION: (ReasonCode.CONFIGURATION_INVALID, ActionCode.CHECK_CONFIGURATION),
    ProviderErrorCategory.RATE_LIMIT: (ReasonCode.RATE_LIMITED, ActionCode.RETRY_LATER),
    ProviderErrorCategory.TRANSPORT: (ReasonCode.PROVIDER_UNAVAILABLE, ActionCode.RETRY_LATER),
    ProviderErrorCategory.SERVER: (ReasonCode.PROVIDER_UNAVAILABLE, ActionCode.RETRY_LATER),
    ProviderErrorCategory.CLIENT: (ReasonCode.RESOURCE_NOT_FOUND, ActionCode.TRY_ANOTHER_SOURCE),
    ProviderErrorCategory.INVALID_RESPONSE: (ReasonCode.RESPONSE_INVALID, ActionCode.TRY_ANOTHER_SOURCE),
}


def map_exception(
    error: BaseException,
    *,
    provider: str | None = None,
    retryable: bool | None = None,
    attempt: AttemptMetadata | None = None,
) -> DiagnosticEnvelope:
    typed_provider = getattr(error, "provider", None)
    category = getattr(error, "category", None)
    effective_provider = _provider(typed_provider if isinstance(typed_provider, str) else provider)
    effective_retryable = getattr(error, "retryable", retryable)
    if not isinstance(effective_retryable, bool):
        effective_retryable = isinstance(error, (TimeoutError, OSError, DurabilityError))

    if isinstance(error, asyncio.CancelledError):
        reason, action, stage = ReasonCode.CANCELLED, ActionCode.NONE, FailureStage.ORCHESTRATION
        effective_retryable = False
    elif isinstance(category, ProviderErrorCategory):
        reason, action = _PROVIDER_MAPPING[category]
        stage = FailureStage.PROVIDER
        status = getattr(error, "status", None)
        if category is ProviderErrorCategory.CLIENT and status not in {404, 410}:
            reason, action = ReasonCode.RESPONSE_INVALID, ActionCode.TRY_ANOTHER_SOURCE
    elif isinstance(error, ValidationError):
        reason, action, stage = ReasonCode.CONTENT_INVALID, ActionCode.REVIEW_CONTENT, FailureStage.VALIDATION
    elif isinstance(error, StorageCorruptionError):
        reason, action, stage = ReasonCode.STORAGE_CORRUPTION, ActionCode.REPAIR_STORAGE, FailureStage.STORAGE
    elif isinstance(error, StorageError):
        reason, action, stage = ReasonCode.STORAGE_UNAVAILABLE, ActionCode.CHECK_STORAGE, FailureStage.STORAGE
    elif isinstance(error, CatalogError):
        reason, action, stage = ReasonCode.CATALOG_FAILURE, ActionCode.CONTACT_MAINTAINER, FailureStage.CATALOG
    elif isinstance(error, ConfigError):
        reason, action, stage = ReasonCode.CONFIGURATION_INVALID, ActionCode.CHECK_CONFIGURATION, FailureStage.ORCHESTRATION
    elif isinstance(error, (TimeoutError, OSError)):
        reason, action, stage = ReasonCode.PROVIDER_UNAVAILABLE, ActionCode.RETRY_LATER, FailureStage.PROVIDER
    else:
        reason, action, stage = ReasonCode.UNKNOWN_FAILURE, ActionCode.CONTACT_MAINTAINER, FailureStage.ORCHESTRATION

    summary = _summary(reason, effective_provider)
    identity = {
        "action_code": action.value,
        "provider": effective_provider,
        "reason_code": reason.value,
        "retryable": effective_retryable,
        "schema_version": 1,
        "stage": stage.value,
        "summary": summary,
    }
    if attempt is not None:
        identity["attempt"] = attempt.to_dict()
    encoded = json.dumps(identity, ensure_ascii=True, allow_nan=False, separators=(",", ":"), sort_keys=True)
    diagnostic_id = hashlib.sha256(encoded.encode("ascii")).hexdigest()[:24]
    return DiagnosticEnvelope(1, diagnostic_id, reason, action, stage, effective_provider, effective_retryable, summary, attempt)


def _provider(value: str | None) -> str | None:
    if value is None:
        return None
    return value if _PROVIDER_TOKEN.fullmatch(value) else None


def _summary(reason: ReasonCode, provider: str | None) -> str:
    labels = {
        ReasonCode.AUTHENTICATION_REQUIRED: "Provider credentials were rejected",
        ReasonCode.CONFIGURATION_INVALID: "Provider configuration is invalid",
        ReasonCode.RATE_LIMITED: "Provider rate limit was reached",
        ReasonCode.PROVIDER_UNAVAILABLE: "Provider is temporarily unavailable",
        ReasonCode.RESOURCE_NOT_FOUND: "Requested content was not found",
        ReasonCode.RESPONSE_INVALID: "Provider returned an invalid response",
        ReasonCode.CONTENT_INVALID: "Downloaded content failed validation",
        ReasonCode.STORAGE_UNAVAILABLE: "Durable storage could not complete the operation",
        ReasonCode.STORAGE_CORRUPTION: "Stored content failed integrity verification",
        ReasonCode.CATALOG_FAILURE: "Catalog operation could not complete",
        ReasonCode.CANCELLED: "Acquisition was cancelled",
        ReasonCode.UNKNOWN_FAILURE: "Acquisition failed for an internal reason",
    }
    suffix = "" if provider is None else f" ({redact_text(provider, limit=80)})"
    return redact_text(labels[reason] + suffix, limit=240)


__all__ = ("map_exception",)
