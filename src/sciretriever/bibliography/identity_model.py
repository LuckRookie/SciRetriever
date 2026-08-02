from __future__ import annotations

import json
from dataclasses import dataclass

from sciretriever.model.literature import Identifier
from sciretriever.model.primitives import (
    MetadataSnapshotId,
    ObservationId,
    Sha256,
    StableIdentifierId,
    UtcTimestamp,
    VersionRelationId,
    WorkId,
    WorkVersionId,
)


@dataclass(frozen=True, slots=True)
class InitialMetadata:
    title: str | None = None
    authors: tuple[str, ...] = ()
    year: int | None = None
    item_type: str | None = None
    abstract: str | None = None
    venue: str | None = None
    language: str | None = None
    keywords: tuple[str, ...] = ()


def initial_metadata_from_json(payload: str) -> InitialMetadata:
    value = json.loads(payload)
    return InitialMetadata(
        value.get("title"),
        tuple(value.get("authors", ())),
        value.get("year"),
        value.get("item_type"),
        value.get("abstract"),
        value.get("venue"),
        value.get("language"),
        tuple(value.get("keywords", ())),
    )


@dataclass(frozen=True, slots=True)
class VersionRelationEvidence:
    target_identifier: Identifier
    relation: str


@dataclass(frozen=True, slots=True)
class BibliographicObservation:
    provider: str
    provider_record_id: str
    source_priority: int
    observed_at: UtcTimestamp
    identifiers: tuple[Identifier, ...]
    metadata: InitialMetadata
    version_role: str
    version_relation: VersionRelationEvidence | None = None


@dataclass(frozen=True, slots=True)
class StoredObservation:
    observation_id: ObservationId
    provider: str
    provider_record_id: str
    payload_sha256: Sha256
    payload_json: str
    observed_at: UtcTimestamp


@dataclass(frozen=True, slots=True)
class IdentityRecord:
    work_id: WorkId
    work_version_id: WorkVersionId
    representative_version_id: WorkVersionId | None
    version_role: str
    identifiers: tuple[Identifier, ...]
    current_metadata: InitialMetadata | None
    metadata_revision: int | None
    completed: bool
    identity_revision: Sha256


@dataclass(frozen=True, slots=True)
class PreparedIdentifier:
    identifier_id: StableIdentifierId
    value: Identifier


@dataclass(frozen=True, slots=True)
class PreparedMetadataSnapshot:
    snapshot_id: MetadataSnapshotId
    revision: int
    sha256: Sha256
    values_json: str
    provenance_json: str


@dataclass(frozen=True, slots=True)
class PreparedVersionRelation:
    relation_id: VersionRelationId
    left_version_id: WorkVersionId
    right_version_id: WorkVersionId
    relation: str


@dataclass(frozen=True, slots=True)
class IdentityReviewRelation:
    left_version_id: WorkVersionId
    right_version_id: WorkVersionId
    relation: str
    evidence: str


@dataclass(frozen=True, slots=True)
class ExpectedIdentityRevision:
    work_version_id: WorkVersionId
    revision: Sha256


@dataclass(frozen=True, slots=True)
class SupersededIdentity:
    work_id: WorkId
    work_version_id: WorkVersionId


@dataclass(frozen=True, slots=True)
class PreparedRoleUpdate:
    work_version_id: WorkVersionId
    expected_role: str
    role: str


@dataclass(frozen=True, slots=True)
class PreparedBibliographyAcceptance:
    work_id: WorkId
    work_version_id: WorkVersionId
    version_role: str
    representative_version_id: WorkVersionId
    identifiers: tuple[PreparedIdentifier, ...]
    observations: tuple[StoredObservation, ...]
    metadata_snapshot: PreparedMetadataSnapshot | None
    version_relations: tuple[PreparedVersionRelation, ...]
    review_relations: tuple[IdentityReviewRelation, ...]
    expected_revisions: tuple[ExpectedIdentityRevision, ...]
    superseded_identities: tuple[SupersededIdentity, ...]
    role_update: PreparedRoleUpdate | None
