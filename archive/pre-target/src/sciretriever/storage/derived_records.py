"""Immutable records exchanged with the derived artifact store."""

from __future__ import annotations

from dataclasses import dataclass

from sciretriever.core.ids import validate_uuid
from sciretriever.core.validation import validate_nonnegative_int, validate_sha256, validate_storage_path, validate_token


def _positive_size(value: int) -> int:
    validate_nonnegative_int(value, "byte_size")
    if value == 0:
        raise ValueError("byte_size must be positive")
    return value


@dataclass(frozen=True, slots=True)
class DerivedPublication:
    kind: str
    owner_id: str
    storage_path: str
    sha256: str
    byte_size: int
    created: bool

    def __post_init__(self) -> None:
        kind = validate_token(self.kind, "kind")
        owner_id = validate_uuid(self.owner_id, "owner_id")
        validate_storage_path(self.storage_path)
        expected = f"derived/{kind}/{owner_id[:2]}/{owner_id}"
        if self.storage_path != expected:
            raise ValueError("storage_path must match the deterministic derived owner path")
        validate_sha256(self.sha256)
        _positive_size(self.byte_size)
        if not isinstance(self.created, bool):
            raise TypeError("created must be a boolean")


@dataclass(frozen=True, slots=True)
class DerivedStagedArtifact:
    kind: str
    owner_id: str
    attempt_id: str
    temporary_path: str
    sha256: str
    byte_size: int

    def __post_init__(self) -> None:
        kind = validate_token(self.kind, "kind")
        owner_id = validate_uuid(self.owner_id, "owner_id")
        attempt_id = validate_uuid(self.attempt_id, "attempt_id")
        validate_storage_path(self.temporary_path)
        validate_sha256(self.sha256)
        expected = f"derived_staging/{kind}.{owner_id}.{self.sha256}.{attempt_id}.part"
        if self.temporary_path != expected:
            raise ValueError("temporary_path must match the derived staging identity")
        _positive_size(self.byte_size)


@dataclass(frozen=True, slots=True)
class DerivedReconciliationReport:
    published: tuple[DerivedPublication, ...]
    retained: tuple[str, ...]
    unknown: tuple[str, ...]


__all__ = (
    "DerivedPublication",
    "DerivedReconciliationReport",
    "DerivedStagedArtifact",
)
