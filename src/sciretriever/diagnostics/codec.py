"""Strict canonical JSON codec for diagnostic envelopes."""

from __future__ import annotations

import hashlib
import json
from typing import Mapping

from sciretriever.diagnostics.contracts import (
    ActionCode,
    DiagnosticEnvelope,
    FailureStage,
    ReasonCode,
    attempt_metadata_from_mapping,
)


SCHEMA_VERSION = 1
_REQUIRED = {
    "action_code", "diagnostic_id", "provider", "reason_code", "retryable",
    "schema_version", "stage", "summary",
}


def encode_diagnostic(value: DiagnosticEnvelope) -> str:
    if not isinstance(value, DiagnosticEnvelope):
        raise TypeError("value must be DiagnosticEnvelope")
    return json.dumps(value.to_dict(), ensure_ascii=True, allow_nan=False, separators=(",", ":"), sort_keys=True)


def decode_diagnostic(value: str) -> DiagnosticEnvelope:
    if not isinstance(value, str):
        raise TypeError("diagnostic JSON must be a string")
    try:
        decoded = json.loads(value)
    except (TypeError, ValueError) as error:
        raise ValueError("diagnostic must contain valid JSON") from error
    if not isinstance(decoded, Mapping):
        raise ValueError("diagnostic must be a JSON object")
    canonical = json.dumps(decoded, ensure_ascii=True, allow_nan=False, separators=(",", ":"), sort_keys=True)
    if canonical != value:
        raise ValueError("diagnostic must be canonical JSON")
    missing = _REQUIRED - set(decoded)
    if missing:
        raise ValueError(f"diagnostic is missing {sorted(missing)[0]}")
    if set(decoded) - (_REQUIRED | {"attempt"}):
        raise ValueError("diagnostic fields are not exact")
    if decoded["schema_version"] != SCHEMA_VERSION:
        raise ValueError("unsupported diagnostic schema_version")
    identity = {key: item for key, item in decoded.items() if key != "diagnostic_id"}
    identity_json = json.dumps(identity, ensure_ascii=True, allow_nan=False, separators=(",", ":"), sort_keys=True)
    expected_id = hashlib.sha256(identity_json.encode("ascii")).hexdigest()[:24]
    if decoded["diagnostic_id"] != expected_id:
        raise ValueError("diagnostic_id does not match the envelope")
    attempt_value = decoded.get("attempt")
    if attempt_value is not None and not isinstance(attempt_value, Mapping):
        raise ValueError("diagnostic attempt must be an object")
    try:
        return DiagnosticEnvelope(
            schema_version=decoded["schema_version"],
            diagnostic_id=decoded["diagnostic_id"],
            reason_code=ReasonCode(decoded["reason_code"]),
            action_code=ActionCode(decoded["action_code"]),
            stage=FailureStage(decoded["stage"]),
            provider=decoded["provider"],
            retryable=decoded["retryable"],
            summary=decoded["summary"],
            attempt=None if attempt_value is None else attempt_metadata_from_mapping(attempt_value),
        )
    except (TypeError, ValueError) as error:
        raise ValueError("invalid diagnostic envelope") from error


__all__ = ("SCHEMA_VERSION", "decode_diagnostic", "encode_diagnostic")
