"""Final redacted acquisition attempt diagnostics."""

from __future__ import annotations

from dataclasses import dataclass
import math
import re
from typing import Mapping

from sciretriever.core.enums import AttemptOutcome


SCHEMA_VERSION = 1
_KIND = "candidate_attempt"
_MAX_DEPTH = 6
_MAX_ITEMS = 64
_MAX_STRING_BYTES = 1024
_MAX_ATTEMPT_SEQUENCE = 2_147_483_647
_SOURCE_TOKEN = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")
_PROHIBITED_KEYS = (
    "authorization", "auth_context", "cookie", "credential", "execution_url",
    "page_url", "password", "referrer", "request_header", "secret", "session",
    "signature", "token",
)
_SENSITIVE_ASSIGNMENT = re.compile(
    r"(?i)\b(?:authorization|cookie|api[-_]?key|token|signature|password|secret|session)\s*[:=]"
)


@dataclass(frozen=True, slots=True)
class CandidateAttemptDetails:
    candidate_id: str
    attempt_sequence: int
    outcome: AttemptOutcome | None = None
    error: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.candidate_id, str) or _SOURCE_TOKEN.fullmatch(self.candidate_id) is None:
            raise ValueError("candidate_id must be a lowercase token")
        if (
            not isinstance(self.attempt_sequence, int)
            or isinstance(self.attempt_sequence, bool)
            or not 0 < self.attempt_sequence <= _MAX_ATTEMPT_SEQUENCE
        ):
            raise ValueError("attempt_sequence must be a bounded positive integer")
        if self.outcome is not None and not isinstance(self.outcome, AttemptOutcome):
            raise TypeError("outcome must be an AttemptOutcome")
        if self.error is not None:
            _validate_text(self.error, "error")

    def to_dict(self, **metadata: object) -> dict[str, object]:
        _validate_metadata(metadata)
        value: dict[str, object] = {
            "kind": _KIND,
            "schema_version": SCHEMA_VERSION,
            "candidate_id": self.candidate_id,
            "attempt_sequence": self.attempt_sequence,
        }
        if self.outcome is not None:
            value["outcome"] = self.outcome.value
        if self.error is not None:
            value["error"] = self.error
        if metadata:
            value["metadata"] = metadata
        return value


def _validate_text(value: str, field_name: str) -> None:
    if len(value.encode("utf-8")) > _MAX_STRING_BYTES:
        raise ValueError(f"{field_name} is too long")
    if "://" in value or _SENSITIVE_ASSIGNMENT.search(value) or "bearer " in value.casefold():
        raise ValueError(f"{field_name} contains prohibited runtime material")


def _validate_metadata(value: object, *, depth: int = 0) -> None:
    if depth > _MAX_DEPTH:
        raise ValueError("attempt metadata is too deeply nested")
    if value is None or isinstance(value, (bool, int)):
        return
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("attempt metadata must contain finite numbers")
        return
    if isinstance(value, str):
        _validate_text(value, "metadata string")
        return
    if isinstance(value, Mapping):
        if len(value) > _MAX_ITEMS:
            raise ValueError("attempt metadata has too many entries")
        for key, item in value.items():
            if not isinstance(key, str) or not key or len(key.encode("utf-8")) > 80:
                raise ValueError("attempt metadata keys must be bounded strings")
            compact = key.casefold().replace("-", "_")
            if any(marker in compact for marker in _PROHIBITED_KEYS):
                raise ValueError("attempt metadata contains a prohibited field")
            _validate_metadata(item, depth=depth + 1)
        return
    if isinstance(value, (list, tuple)):
        if len(value) > _MAX_ITEMS:
            raise ValueError("attempt metadata has too many items")
        for item in value:
            _validate_metadata(item, depth=depth + 1)
        return
    raise ValueError("attempt metadata must contain JSON-compatible values")


__all__ = ("CandidateAttemptDetails", "SCHEMA_VERSION")
