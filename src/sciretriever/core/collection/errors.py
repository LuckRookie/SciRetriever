from __future__ import annotations


class CollectionRuleError(Exception):
    """Reject a Collection business rule with field-specific meaning."""

    __slots__ = ("field", "expectation")

    def __init__(self, field: str, expectation: str) -> None:
        self.field = field
        self.expectation = expectation
        super().__init__(f"{field} {expectation}")

    @classmethod
    def for_field(cls, field: str, expectation: str) -> CollectionRuleError:
        return cls(field, expectation)

    def __str__(self) -> str:
        return f"{self.field} {self.expectation}"


__all__ = ("CollectionRuleError",)
