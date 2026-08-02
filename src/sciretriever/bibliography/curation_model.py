from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from sciretriever.model.literature import Identifier
from sciretriever.model.primitives import (
    AssetId,
    CollectionId,
    MembershipId,
    ObservationId,
    ReferenceFactId,
    StableIdentifierId,
    VersionRelationId,
    WorkId,
    WorkVersionId,
)

from .model import CurationSnapshot


class CurationDecision(str, Enum):
    SAME_VERSION = "same-version"
    RELATED_VERSIONS = "related-versions"
    DISTINCT = "distinct"
    DELETE_VERSION = "delete-version"
    DELETE_WORK = "delete-work"


@dataclass(frozen=True, slots=True)
class IdentifierFact:
    identifier_id: StableIdentifierId
    version_id: WorkVersionId
    value: Identifier


@dataclass(frozen=True, slots=True)
class ObservationFact:
    observation_id: ObservationId
    version_id: WorkVersionId


@dataclass(frozen=True, slots=True)
class MembershipFact:
    membership_id: MembershipId
    collection_id: CollectionId
    work_id: WorkId


@dataclass(frozen=True, slots=True)
class ReferenceFact:
    reference_id: ReferenceFactId
    source_version_id: WorkVersionId
    target_work_id: WorkId | None
    target_version_id: WorkVersionId | None
    raw_text: str
    reference_json: str


@dataclass(frozen=True, slots=True)
class RelationFact:
    relation_id: VersionRelationId
    left_version_id: WorkVersionId
    right_version_id: WorkVersionId
    relation: str


@dataclass(frozen=True, slots=True)
class ArtifactRegistrationFact:
    artifact_id: AssetId
    version_id: WorkVersionId


@dataclass(frozen=True, slots=True)
class CurationTopology:
    snapshot: CurationSnapshot
    identifiers: tuple[IdentifierFact, ...]
    observations: tuple[ObservationFact, ...]
    memberships: tuple[MembershipFact, ...]
    references: tuple[ReferenceFact, ...]
    relations: tuple[RelationFact, ...]
    artifact_registrations: tuple[ArtifactRegistrationFact, ...]
