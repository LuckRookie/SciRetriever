"""Stable diagnostic contracts persisted in existing catalog JSON fields."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
import re
from typing import Mapping


_SOURCE_TOKEN = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")
_PROVIDER_TOKEN = re.compile(r"^[a-z][a-z0-9-]{0,63}$")
_MAX_INTEGER = 2_147_483_647


class ReasonCode(str, Enum):
    AUTHENTICATION_REQUIRED = "authentication_required"
    CONFIGURATION_INVALID = "configuration_invalid"
    RATE_LIMITED = "rate_limited"
    PROVIDER_UNAVAILABLE = "provider_unavailable"
    RESOURCE_NOT_FOUND = "resource_not_found"
    RESPONSE_INVALID = "response_invalid"
    CONTENT_INVALID = "content_invalid"
    STORAGE_UNAVAILABLE = "storage_unavailable"
    STORAGE_CORRUPTION = "storage_corruption"
    CATALOG_FAILURE = "catalog_failure"
    CANCELLED = "cancelled"
    UNKNOWN_FAILURE = "unknown_failure"


class ActionCode(str, Enum):
    CHECK_CREDENTIALS = "check_credentials"
    CHECK_CONFIGURATION = "check_configuration"
    RETRY_LATER = "retry_later"
    TRY_ANOTHER_SOURCE = "try_another_source"
    REVIEW_CONTENT = "review_content"
    CHECK_STORAGE = "check_storage"
    REPAIR_STORAGE = "repair_storage"
    CONTACT_MAINTAINER = "contact_maintainer"
    NONE = "none"


class FailureStage(str, Enum):
    PROVIDER = "provider"
    VALIDATION = "validation"
    STORAGE = "storage"
    CATALOG = "catalog"
    ORCHESTRATION = "orchestration"


@dataclass(frozen=True, slots=True)
class AttemptMetadata:
    candidate_id: str | None = None
    attempt_sequence: int | None = None
    latency_ms: int | None = None

    def __post_init__(self) -> None:
        if self.candidate_id is not None and (
            not isinstance(self.candidate_id, str) or not _SOURCE_TOKEN.fullmatch(self.candidate_id)
        ):
            raise ValueError("candidate_id must be a bounded lowercase token or None")
        for name, value in (("attempt_sequence", self.attempt_sequence), ("latency_ms", self.latency_ms)):
            if value is not None and (
                not isinstance(value, int) or isinstance(value, bool) or value < 0 or value > _MAX_INTEGER
            ):
                raise ValueError(f"{name} must be a bounded non-negative integer or None")

    def to_dict(self) -> dict[str, object]:
        return {
            key: value
            for key, value in (
                ("attempt_sequence", self.attempt_sequence),
                ("candidate_id", self.candidate_id),
                ("latency_ms", self.latency_ms),
            )
            if value is not None
        }


@dataclass(frozen=True, slots=True)
class DiagnosticEnvelope:
    schema_version: int
    diagnostic_id: str
    reason_code: ReasonCode
    action_code: ActionCode
    stage: FailureStage
    provider: str | None
    retryable: bool
    summary: str
    attempt: AttemptMetadata | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.schema_version, int) or isinstance(self.schema_version, bool) or self.schema_version != 1:
            raise ValueError("unsupported diagnostic schema_version")
        if not isinstance(self.diagnostic_id, str) or len(self.diagnostic_id) != 24 or any(
            char not in "0123456789abcdef" for char in self.diagnostic_id
        ):
            raise ValueError("diagnostic_id must be 24 lowercase hexadecimal characters")
        if not isinstance(self.reason_code, ReasonCode):
            raise TypeError("reason_code must be ReasonCode")
        if not isinstance(self.action_code, ActionCode):
            raise TypeError("action_code must be ActionCode")
        if not isinstance(self.stage, FailureStage):
            raise TypeError("stage must be FailureStage")
        if self.provider is not None and (
            not isinstance(self.provider, str) or not _PROVIDER_TOKEN.fullmatch(self.provider)
        ):
            raise ValueError("provider must be a bounded lowercase name or None")
        if not isinstance(self.retryable, bool):
            raise TypeError("retryable must be boolean")
        if not isinstance(self.summary, str) or not self.summary.strip() or len(self.summary) > 240:
            raise ValueError("summary must be a bounded non-blank string")
        if self.attempt is not None and not isinstance(self.attempt, AttemptMetadata):
            raise TypeError("attempt must be AttemptMetadata or None")

    def to_dict(self) -> dict[str, object]:
        value: dict[str, object] = {
            "action_code": self.action_code.value,
            "diagnostic_id": self.diagnostic_id,
            "provider": self.provider,
            "reason_code": self.reason_code.value,
            "retryable": self.retryable,
            "schema_version": self.schema_version,
            "stage": self.stage.value,
            "summary": self.summary,
        }
        if self.attempt is not None:
            value["attempt"] = self.attempt.to_dict()
        return value


def attempt_metadata_from_mapping(value: Mapping[str, object]) -> AttemptMetadata:
    allowed = {"attempt_sequence", "candidate_id", "latency_ms"}
    if set(value) - allowed:
        raise ValueError("diagnostic attempt fields are not exact")
    candidate_id = value.get("candidate_id")
    attempt_sequence = value.get("attempt_sequence")
    latency_ms = value.get("latency_ms")
    if candidate_id is not None and not isinstance(candidate_id, str):
        raise ValueError("candidate_id must be a string")
    if attempt_sequence is not None and (not isinstance(attempt_sequence, int) or isinstance(attempt_sequence, bool)):
        raise ValueError("attempt_sequence must be an integer")
    if latency_ms is not None and (not isinstance(latency_ms, int) or isinstance(latency_ms, bool)):
        raise ValueError("latency_ms must be an integer")
    return AttemptMetadata(candidate_id, attempt_sequence, latency_ms)


__all__ = ("ActionCode", "AttemptMetadata", "DiagnosticEnvelope", "FailureStage", "ReasonCode")
