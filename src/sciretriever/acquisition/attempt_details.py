"""Versioned acquisition metadata stored in generic attempt details JSON."""

from __future__ import annotations

from dataclasses import dataclass
import json
from typing import Mapping

from sciretriever.core.enums import AttemptOutcome


SCHEMA_VERSION = 1
_KIND = "candidate_attempt"


@dataclass(frozen=True, slots=True)
class CandidateAttemptDetails:
    candidate_id: str
    attempt_sequence: int
    outcome: AttemptOutcome | None = None
    error: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.candidate_id, str) or not self.candidate_id.strip():
            raise ValueError("candidate_id must be nonempty")
        if not isinstance(self.attempt_sequence, int) or isinstance(self.attempt_sequence, bool) or self.attempt_sequence <= 0:
            raise ValueError("attempt_sequence must be a positive integer")
        if self.outcome is not None and not isinstance(self.outcome, AttemptOutcome):
            raise TypeError("outcome must be an AttemptOutcome")
        if self.error is not None and not isinstance(self.error, str):
            raise TypeError("error must be a string")

    def to_dict(self, **metadata: object) -> dict[str, object]:
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


def decode_candidate_attempt(details_json: str | None) -> CandidateAttemptDetails | None:
    """Decode candidate metadata, ignoring only unrelated legacy details."""

    if details_json is None:
        return None
    try:
        value = json.loads(details_json)
    except (TypeError, ValueError) as error:
        raise ValueError("attempt details must contain valid JSON") from error
    if not isinstance(value, Mapping):
        return None
    if value.get("kind") != _KIND:
        if "candidate_id" in value or "attempt_sequence" in value:
            raise ValueError("candidate attempt metadata is missing its kind marker")
        return None
    canonical = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    if canonical != details_json:
        raise ValueError("candidate attempt metadata must be canonical JSON")
    required = {"schema_version", "candidate_id", "attempt_sequence"}
    missing = required.difference(value)
    if missing:
        raise ValueError(f"candidate attempt metadata is missing {sorted(missing)[0]}")
    if value["schema_version"] != SCHEMA_VERSION:
        raise ValueError("unsupported candidate attempt schema_version")
    allowed = required | {"kind", "outcome", "error", "metadata"}
    if set(value).difference(allowed):
        raise ValueError("candidate attempt metadata fields are not exact")
    if "metadata" in value and not isinstance(value["metadata"], Mapping):
        raise ValueError("candidate attempt metadata payload must be an object")
    try:
        outcome = None if "outcome" not in value else AttemptOutcome(value["outcome"])
        return CandidateAttemptDetails(
            candidate_id=value["candidate_id"],
            attempt_sequence=value["attempt_sequence"],
            outcome=outcome,
            error=value.get("error"),
        )
    except (TypeError, ValueError) as error:
        raise ValueError("invalid candidate attempt metadata") from error


__all__ = ("CandidateAttemptDetails", "SCHEMA_VERSION", "decode_candidate_attempt")
