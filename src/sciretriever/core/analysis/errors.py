from __future__ import annotations

from sciretriever.model.execution import Action, Reason


class AnalysisValidationError(Exception):
    """Reject an analysis input or output with a stable, sanitized code."""

    __slots__ = ("action", "code", "reason")

    def __init__(self, code: str) -> None:
        self.code = code
        self.reason = Reason(value="Analysis output failed strict validation.")
        self.action = Action(value="Retry with a supported model and complete source evidence.")
        super().__init__(code)

    def __str__(self) -> str:
        return self.code


__all__ = ("AnalysisValidationError",)
