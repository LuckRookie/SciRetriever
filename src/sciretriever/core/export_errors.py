"""Typed failures for export contract admission."""

from __future__ import annotations

class ExportContractError(ValueError):
    def __init__(self, reason: str) -> None:
        self.reason = reason
        super().__init__(reason)

    def __str__(self) -> str:
        return self.reason


__all__ = ("ExportContractError",)
