"""Validated MinerU protocol and archive boundary objects."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from types import MappingProxyType
from typing import Mapping

from sciretriever.core.ids import validate_uuid


class MinerUTaskStatus(str, Enum):
    PENDING = "pending"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"


class MinerUResultState(str, Enum):
    PENDING = "pending"
    EXPIRED = "expired"
    COMPLETED = "completed"


@dataclass(frozen=True, slots=True)
class MinerUHealth:
    status: str
    version: str
    protocol_version: int


@dataclass(frozen=True, slots=True)
class MinerUTask:
    task_id: str
    status: MinerUTaskStatus

    def __post_init__(self) -> None:
        validate_uuid(self.task_id, "task_id")


@dataclass(frozen=True, slots=True)
class MinerUResult:
    state: MinerUResultState
    archive: bytes | None = None

    def __post_init__(self) -> None:
        if (self.state is MinerUResultState.COMPLETED) != (self.archive is not None):
            raise ValueError("completed MinerU results require archive bytes")


@dataclass(frozen=True, slots=True)
class MinerUArchiveEntry:
    path: str
    media_type: str
    sha256: str
    payload: bytes


@dataclass(frozen=True, slots=True)
class ValidatedMinerUArchive:
    middle: MinerUArchiveEntry
    model: MinerUArchiveEntry
    content_list: MinerUArchiveEntry
    supporting: tuple[MinerUArchiveEntry, ...]

    @property
    def entries(self) -> tuple[MinerUArchiveEntry, ...]:
        return (self.middle, self.model, self.content_list, *self.supporting)

    def payloads(self) -> Mapping[str, bytes]:
        return MappingProxyType({entry.path: entry.payload for entry in self.entries})


__all__ = (
    "MinerUArchiveEntry", "MinerUHealth", "MinerUResult", "MinerUResultState", "MinerUTask", "MinerUTaskStatus",
    "ValidatedMinerUArchive",
)
