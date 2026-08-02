from __future__ import annotations

from enum import Enum, unique


@unique
class AssetValidationCode(str, Enum):
    SIZE_INVALID = "size-invalid"
    MEDIA_TYPE_INVALID = "media-type-invalid"
    FORMAT_INVALID = "format-invalid"
    PARSE_INVALID = "parse-invalid"
    NOT_PRIMARY = "not-primary"
    IDENTITY_MISMATCH = "identity-mismatch"
    IDENTITY_UNCONFIRMED = "identity-unconfirmed"


class AssetRuleError(Exception):
    """Reject an Assets business rule with field-specific meaning."""

    __slots__ = ("field", "expectation")

    def __init__(self, field: str, expectation: str) -> None:
        self.field = field
        self.expectation = expectation
        super().__init__(f"{field} {expectation}")

    @classmethod
    def for_field(cls, field: str, expectation: str) -> AssetRuleError:
        return cls(field, expectation)

    def __str__(self) -> str:
        return f"{self.field} {self.expectation}"


__all__ = ("AssetRuleError", "AssetValidationCode")
