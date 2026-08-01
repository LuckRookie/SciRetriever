"""Typed requests and safe projections for product diagnostic history."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
import re
from typing import Mapping

from sciretriever.diagnostics.product import (
    DiagnosticSubjectKind,
    ProductFailure,
    ProductFailureAction,
    ProductFailureReason,
    ProductFailureStage,
)
from sciretriever.diagnostics.redaction import REDACTED, redact


_DURABLE_SENSITIVE_KEY = re.compile(
    r"(?:credential|headers?|cookies?|path|payload|response|request|body|exception|error|traceback)",
    re.IGNORECASE,
)
_ABSOLUTE_PATH = re.compile(r"(?<![\w.])(?:/[\w.@%+=:,~-]+){2,}|\b[A-Za-z]:\\(?:[^\\\s]+\\)+[^\\\s]*")


@dataclass(frozen=True, slots=True)
class DiagnosticWriteRequest:
    failure: ProductFailure
    retryable: bool
    details: Mapping[str, object]

    def __post_init__(self) -> None:
        if not isinstance(self.failure, ProductFailure):
            raise TypeError("failure must be ProductFailure")
        if not isinstance(self.retryable, bool):
            raise TypeError("retryable must be boolean")
        if not isinstance(self.details, Mapping):
            raise TypeError("details must be a mapping")


@dataclass(frozen=True, slots=True)
class DiagnosticQuery:
    subject: ProductFailure | None = None
    subject_kind: DiagnosticSubjectKind | None = None
    subject_id: str | None = None
    stage: ProductFailureStage | None = None
    reason: ProductFailureReason | None = None
    action: ProductFailureAction | None = None
    retryable: bool | None = None
    role: str | None = None
    source: str | None = None
    outcome: str | None = None
    latest: bool = False

    def __post_init__(self) -> None:
        if self.subject is not None and not isinstance(self.subject, ProductFailure):
            raise TypeError("subject must be ProductFailure or None")
        if self.subject_kind is not None and not isinstance(self.subject_kind, DiagnosticSubjectKind):
            raise TypeError("subject_kind must be DiagnosticSubjectKind or None")
        if (self.subject_kind is None) != (self.subject_id is None):
            raise ValueError("subject_kind and subject_id must be provided together")
        if self.subject is not None and self.subject_kind is not None:
            raise ValueError("subject and explicit subject fields cannot be combined")
        for value, expected, name in (
            (self.stage, ProductFailureStage, "stage"),
            (self.reason, ProductFailureReason, "reason"),
            (self.action, ProductFailureAction, "action"),
        ):
            if value is not None and not isinstance(value, expected):
                raise TypeError(f"{name} has an invalid type")
        if self.retryable is not None and not isinstance(self.retryable, bool):
            raise TypeError("retryable must be boolean or None")
        if not isinstance(self.latest, bool):
            raise TypeError("latest must be boolean")
        for name, value in (("role", self.role), ("source", self.source), ("outcome", self.outcome)):
            if value is not None and (not isinstance(value, str) or not value or len(value) > 100):
                raise ValueError(f"{name} must be a bounded nonempty string or None")


@dataclass(frozen=True, slots=True)
class DiagnosticProjection:
    id: str
    failure: ProductFailure
    retryable: bool
    summary: str
    details: Mapping[str, object]
    occurred_at: str
    corrupted: bool = False

    def to_dict(self) -> dict[str, object]:
        return {
            "corrupted": self.corrupted,
            "details": dict(self.details),
            "failure": {
                "action": self.failure.action.value,
                "reason": self.failure.reason.value,
                "rerun": self.failure.rerun.value,
                "stage": self.failure.stage.value,
                "subject_id": self.failure.subject_id,
                "subject_kind": self.failure.subject_kind.value,
            },
            "id": self.id,
            "occurred_at": self.occurred_at,
            "retryable": self.retryable,
            "summary": self.summary,
        }


def subject_column(kind: DiagnosticSubjectKind) -> str:
    match kind:
        case DiagnosticSubjectKind.INPUT:
            return "input_fingerprint"
        case DiagnosticSubjectKind.WORK | DiagnosticSubjectKind.EXPANSION:
            return "work_id"
        case DiagnosticSubjectKind.WORK_VERSION:
            return "work_version_id"
        case DiagnosticSubjectKind.PROCESSING_RUN:
            return "processing_run_id"
        case _:
            raise AssertionError("unreachable diagnostic subject kind")


def redact_diagnostic_details(value: Mapping[str, object]) -> Mapping[str, object]:
    sanitized = redact(value)
    if not isinstance(sanitized, Mapping):
        raise TypeError("redacted diagnostic details must be a mapping")
    return _scrub_mapping(sanitized)


def _scrub_mapping(value: Mapping[object, object]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, item in value.items():
        text_key = str(key)
        result[text_key] = REDACTED if _DURABLE_SENSITIVE_KEY.search(text_key) else _scrub(item)
    return result


def _scrub(value: object) -> object:
    if isinstance(value, str):
        return _ABSOLUTE_PATH.sub(REDACTED, value)
    if isinstance(value, Mapping):
        return _scrub_mapping(value)
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [_scrub(item) for item in value]
    return value


__all__ = (
    "DiagnosticProjection",
    "DiagnosticQuery",
    "DiagnosticWriteRequest",
    "redact_diagnostic_details",
    "subject_column",
)
