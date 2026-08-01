"""Validated invocation-local completion targets."""
from __future__ import annotations
from dataclasses import dataclass, field
from enum import StrEnum
import re
from typing import TypeAlias
from sciretriever.core.contracts import Identifier
from sciretriever.core.ids import validate_uuid

JsonValue: TypeAlias = str | int | bool | None | list["JsonValue"] | dict[str, "JsonValue"]
JsonObject: TypeAlias = dict[str, JsonValue]

_DOI_PATTERN = re.compile(r"10\.\d{4,9}/[-._;()/:a-z0-9]+", re.IGNORECASE)

class TargetKind(StrEnum):
    DOI = "doi"
    WORK_VERSION = "work_version"

@dataclass(frozen=True, slots=True)
class DoiTarget:
    doi: str
    kind: TargetKind = field(default=TargetKind.DOI, init=False)

    def __post_init__(self) -> None:
        normalized = Identifier("doi", self.doi).value
        if _DOI_PATTERN.fullmatch(normalized) is None:
            raise ValueError("invalid DOI")
        object.__setattr__(self, "doi", normalized)

    def to_dict(self) -> JsonObject:
        return {"kind": self.kind.value, "doi": self.doi}

@dataclass(frozen=True, slots=True)
class WorkVersionTarget:
    work_version_id: str
    kind: TargetKind = field(default=TargetKind.WORK_VERSION, init=False)

    def __post_init__(self) -> None:
        object.__setattr__(self, "work_version_id", validate_uuid(self.work_version_id, "work_version_id"))

    def to_dict(self) -> JsonObject:
        return {"kind": self.kind.value, "work_version_id": self.work_version_id}

CompletionTarget: TypeAlias = DoiTarget | WorkVersionTarget
__all__ = ("CompletionTarget", "DoiTarget", "TargetKind", "WorkVersionTarget")
