"""Immutable records exchanged with the raw filesystem store."""

from __future__ import annotations

from dataclasses import dataclass

from sciretriever.core.ids import validate_uuid
from sciretriever.core.validation import (
    validate_nonnegative_int,
    validate_sha256,
    validate_storage_path,
)


def _positive_size(value: int) -> int:
    validate_nonnegative_int(value, "byte_size")
    if value == 0:
        raise ValueError("byte_size must be positive")
    return value


@dataclass(frozen=True, slots=True)
class StagedAsset:
    intent_id: str
    temporary_path: str
    sha256: str
    byte_size: int

    def __post_init__(self) -> None:
        validate_uuid(self.intent_id, "intent_id")
        validate_storage_path(self.temporary_path)
        if self.temporary_path != f"staging/{self.intent_id}.part":
            raise ValueError("temporary_path must match the deterministic intent path")
        validate_sha256(self.sha256)
        _positive_size(self.byte_size)


@dataclass(frozen=True, slots=True)
class PublicationResult:
    storage_path: str
    sha256: str
    byte_size: int
    created: bool

    def __post_init__(self) -> None:
        validate_storage_path(self.storage_path)
        validate_sha256(self.sha256)
        if self.storage_path != f"raw/{self.sha256[:2]}/{self.sha256}":
            raise ValueError("storage_path must be the deterministic content-addressed path")
        _positive_size(self.byte_size)
        if not isinstance(self.created, bool):
            raise TypeError("created must be a boolean")
