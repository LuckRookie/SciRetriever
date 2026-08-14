"""Runtime-only outcomes shared by acquisition route adapters and cohorts."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum, unique

from sciretriever.acquisition.planning import AccessRouteHint
from sciretriever.acquisition.ports import TemporaryPdf
from sciretriever.model.report import StableFailure


@unique
class RouteOutcome(str, Enum):
    """Closed result vocabulary for one applicable route execution."""

    PDF_DELIVERED = "pdf-delivered"
    HINTS = "hints"
    NORMAL_MISS = "normal-miss"
    DEFERRED = "deferred"
    ACTION_REQUIRED = "action-required"
    FAILURE = "failure"


@dataclass(frozen=True, slots=True)
class RouteExecutionResult:
    """One route result without database, HTTP, Browser, or vendor objects."""

    outcome: RouteOutcome
    temporary_pdf: TemporaryPdf | None = field(default=None, repr=False)
    hints: tuple[AccessRouteHint, ...] = ()
    failure: StableFailure | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.outcome, RouteOutcome):
            raise TypeError("outcome must be RouteOutcome")
        if self.temporary_pdf is not None and not isinstance(self.temporary_pdf, TemporaryPdf):
            raise TypeError("temporary_pdf must be TemporaryPdf or None")
        if not isinstance(self.hints, tuple) or any(
            not isinstance(hint, AccessRouteHint) for hint in self.hints
        ):
            raise TypeError("hints must contain AccessRouteHint values")
        if len(self.hints) != len(set(self.hints)):
            raise ValueError("route hints must be unique")
        if self.failure is not None and not isinstance(self.failure, StableFailure):
            raise TypeError("failure must be StableFailure or None")
        self._validate_shape()

    def _validate_shape(self) -> None:
        if self.outcome is RouteOutcome.PDF_DELIVERED:
            if self.temporary_pdf is None or self.failure is not None:
                raise ValueError("PDF delivery requires only a TemporaryPdf")
            return
        if self.temporary_pdf is not None:
            raise ValueError("only PDF delivery accepts a TemporaryPdf")
        if self.outcome is RouteOutcome.HINTS:
            if not self.hints or self.failure is not None:
                raise ValueError("a hint outcome requires hints and no failure")
            return
        if self.outcome is RouteOutcome.NORMAL_MISS:
            if self.hints or self.failure is not None:
                raise ValueError("a normal miss carries no hints or failure")
            return
        if self.failure is None or self.hints:
            raise ValueError("deferred, action-required, and failure need one failure only")

    @classmethod
    def delivered(
        cls,
        temporary_pdf: TemporaryPdf,
        *,
        hints: tuple[AccessRouteHint, ...] = (),
    ) -> "RouteExecutionResult":
        return cls(
            outcome=RouteOutcome.PDF_DELIVERED,
            temporary_pdf=temporary_pdf,
            hints=hints,
        )

    @classmethod
    def hints_only(cls, *hints: AccessRouteHint) -> "RouteExecutionResult":
        return cls(outcome=RouteOutcome.HINTS, hints=tuple(hints))

    @classmethod
    def normal_miss(cls) -> "RouteExecutionResult":
        return cls(outcome=RouteOutcome.NORMAL_MISS)

    @classmethod
    def deferred(cls, failure: StableFailure) -> "RouteExecutionResult":
        return cls(outcome=RouteOutcome.DEFERRED, failure=failure)

    @classmethod
    def action_required(cls, failure: StableFailure) -> "RouteExecutionResult":
        return cls(outcome=RouteOutcome.ACTION_REQUIRED, failure=failure)

    @classmethod
    def failed(cls, failure: StableFailure) -> "RouteExecutionResult":
        return cls(outcome=RouteOutcome.FAILURE, failure=failure)

    def __reduce__(self) -> str | tuple[object, ...]:
        raise TypeError("RouteExecutionResult cannot be serialized")


__all__ = ("RouteExecutionResult", "RouteOutcome")
