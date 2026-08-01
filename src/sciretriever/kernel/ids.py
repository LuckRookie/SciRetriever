from __future__ import annotations

import re
from dataclasses import dataclass
from uuid import UUID, uuid4

from sciretriever.kernel.errors import BoundaryError

_CANONICAL_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def _field_name(class_name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", class_name).lower()


@dataclass(frozen=True, slots=True)
class UuidValue:
    value: str

    def __post_init__(self) -> None:
        field = _field_name(type(self).__name__)
        if not isinstance(self.value, str):
            raise BoundaryError.for_field(field, f"must be {type(self).__name__}")
        if _CANONICAL_UUID.fullmatch(self.value) is None:
            raise BoundaryError.for_field(field, "must be a canonical lowercase UUID")
        try:
            parsed = UUID(self.value)
        except ValueError as error:
            raise BoundaryError.for_field(field, "must be a valid UUID") from error
        if str(parsed) != self.value:
            raise BoundaryError.for_field(field, "must be a canonical lowercase UUID")

    @classmethod
    def new(cls) -> UuidValue:
        return cls(str(uuid4()))

    @classmethod
    def from_value(cls, value: str | UuidValue) -> UuidValue:
        if isinstance(value, str):
            return cls(value)
        field = _field_name(cls.__name__)
        raise BoundaryError.for_field(field, f"must be {cls.__name__}")

    def __str__(self) -> str:
        return self.value


@dataclass(frozen=True, slots=True)
class WorkId(UuidValue):
    pass


@dataclass(frozen=True, slots=True)
class WorkVersionId(UuidValue):
    pass


@dataclass(frozen=True, slots=True)
class CollectionId(UuidValue):
    pass


@dataclass(frozen=True, slots=True)
class CollectionRunId(UuidValue):
    pass


@dataclass(frozen=True, slots=True)
class BatchRunId(UuidValue):
    pass


@dataclass(frozen=True, slots=True)
class AssetId(UuidValue):
    pass


@dataclass(frozen=True, slots=True)
class LightDocumentId(UuidValue):
    pass


@dataclass(frozen=True, slots=True)
class AnalysisArtifactId(UuidValue):
    pass


@dataclass(frozen=True, slots=True)
class MetadataSnapshotId(UuidValue):
    pass


@dataclass(frozen=True, slots=True)
class ProvenanceId(UuidValue):
    pass


@dataclass(frozen=True, slots=True)
class ExtensionRecordId(UuidValue):
    pass


@dataclass(frozen=True, slots=True)
class AdmissionBindingId(UuidValue):
    pass


@dataclass(frozen=True, slots=True)
class CurationPlanId(UuidValue):
    pass


@dataclass(frozen=True, slots=True)
class VersionRelationId(UuidValue):
    pass


@dataclass(frozen=True, slots=True)
class WorkVersionAssetId(UuidValue):
    pass


@dataclass(frozen=True, slots=True)
class ObservationId(UuidValue):
    pass


@dataclass(frozen=True, slots=True)
class StableIdentifierId(UuidValue):
    pass


@dataclass(frozen=True, slots=True)
class MembershipId(UuidValue):
    pass


@dataclass(frozen=True, slots=True)
class ReferenceFactId(UuidValue):
    pass
