from __future__ import annotations

from dataclasses import dataclass
import unicodedata


@dataclass(frozen=True, slots=True)
class ErrorDescriptorError(Exception):
    field: str
    expectation: str

    def __str__(self) -> str:
        return f"{self.field} {self.expectation}"


@dataclass(frozen=True, slots=True)
class Reason:
    value: str

    def __post_init__(self) -> None:
        if not isinstance(self.value, str) or not self.value.strip():
            raise ErrorDescriptorError("reason", "must be a nonblank string")
        object.__setattr__(self, "value", unicodedata.normalize("NFC", self.value))

    def __str__(self) -> str:
        return self.value


@dataclass(frozen=True, slots=True)
class Action:
    value: str

    def __post_init__(self) -> None:
        if not isinstance(self.value, str) or not self.value.strip():
            raise ErrorDescriptorError("action", "must be a nonblank string")
        object.__setattr__(self, "value", unicodedata.normalize("NFC", self.value))

    def __str__(self) -> str:
        return self.value


@dataclass(frozen=True, slots=True)
class FailureEvidence:
    code: str
    reason: Reason
    action: Action
    retryable: bool

    def __post_init__(self) -> None:
        if not isinstance(self.code, str) or not self.code.strip():
            raise ErrorDescriptorError("code", "must be a nonblank string")
        if not isinstance(self.action, Action):
            raise ErrorDescriptorError("action", "must be Action")
        if not isinstance(self.reason, Reason):
            raise ErrorDescriptorError("reason", "must be Reason")
        if not isinstance(self.retryable, bool):
            raise ErrorDescriptorError("retryable", "must be a boolean")


@dataclass(frozen=True, slots=True)
class BoundaryError(Exception):
    code: str
    reason: Reason
    action: Action
    field: str | None = None

    @classmethod
    def for_field(cls, field: str, expectation: str) -> BoundaryError:
        return cls(
            code="invalid-boundary",
            reason=Reason(f"{field} {expectation}"),
            action=Action(f"Supply a valid {field}."),
            field=field,
        )

    @classmethod
    def from_evidence(cls, evidence: FailureEvidence, *, field: str | None = None) -> BoundaryError:
        return cls(
            code=evidence.code,
            reason=evidence.reason,
            action=evidence.action,
            field=field,
        )

    def __str__(self) -> str:
        return str(self.reason)
