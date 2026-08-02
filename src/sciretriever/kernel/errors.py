from __future__ import annotations

from dataclasses import dataclass

from sciretriever.model.execution import Action, FailureEvidence, Reason


@dataclass(frozen=True, slots=True)
class ErrorDescriptorError(Exception):
    field: str
    expectation: str

    def __str__(self) -> str:
        return f"{self.field} {self.expectation}"


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
            reason=Reason(value=f"{field} {expectation}"),
            action=Action(value=f"Supply a valid {field}."),
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
