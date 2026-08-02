from __future__ import annotations

from dataclasses import dataclass

import sciretriever.model.execution as execution_models


@dataclass(frozen=True, slots=True)
class ErrorDescriptorError(Exception):
    field: str
    expectation: str

    def __str__(self) -> str:
        return f"{self.field} {self.expectation}"


@dataclass(frozen=True, slots=True)
class BoundaryError(Exception):
    code: str
    reason: execution_models.Reason
    action: execution_models.Action
    field: str | None = None

    @classmethod
    def for_field(cls, field: str, expectation: str) -> BoundaryError:
        return cls(
            code="invalid-boundary",
            reason=execution_models.Reason(value=f"{field} {expectation}"),
            action=execution_models.Action(value=f"Supply a valid {field}."),
            field=field,
        )

    @classmethod
    def from_evidence(
        cls,
        evidence: execution_models.FailureEvidence,
        *,
        field: str | None = None,
    ) -> BoundaryError:
        return cls(
            code=evidence.code,
            reason=evidence.reason,
            action=evidence.action,
            field=field,
        )

    def __str__(self) -> str:
        return self.reason.value
