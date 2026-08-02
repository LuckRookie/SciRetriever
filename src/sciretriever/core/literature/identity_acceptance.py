from __future__ import annotations

from uuid import uuid5

from sciretriever.core.literature.completion import metadata_snapshot_sha256
from sciretriever.core.literature.identity_matching import (
    _ROLE_ORDER,
    _conflicts,
    _fuzzy,
    _identifier_conflicts,
    _identifier_key,
    _identifier_keys,
)
from sciretriever.core.literature.identity_metadata import (
    IDENTITY_NAMESPACE,
    metadata_json,
    observation_from_stored,
    prepare_observation,
    unified_metadata,
)
from sciretriever.model.canonical_json import CanonicalJsonObject, parse_canonical_json
from sciretriever.model.literature import (
    ExpectedIdentityRevision,
    IdentityResolution,
    IdentityReviewRelation,
    InitialMetadata,
    PreparedBibliographyAcceptance,
    PreparedIdentifier,
    PreparedMetadataSnapshot,
    PreparedRoleUpdate,
    PreparedVersionRelation,
    StoredObservation,
    SupersededIdentity,
)
from sciretriever.model.primitives import (
    MetadataSnapshotId,
    StableIdentifierId,
    VersionRelationId,
)


def _canonical_object(value: str) -> CanonicalJsonObject:
    parsed = parse_canonical_json(value)
    assert isinstance(parsed, CanonicalJsonObject)
    return parsed


def prepare_identity_acceptance(
    resolution: IdentityResolution,
    candidate_observations: tuple[StoredObservation, ...],
    existing_observations: tuple[StoredObservation, ...],
) -> PreparedBibliographyAcceptance:
    metadata = resolution.metadata
    provenance_json = resolution.provenance_json
    if candidate_observations:
        metadata, provenance_json = unified_metadata(
            tuple(observation_from_stored(item) for item in candidate_observations)
            + resolution.observations
        )
    prepared_observations = tuple(
        sorted(
            {
                item.observation_id: item
                for item in (
                    *existing_observations,
                    *(prepare_observation(value) for value in resolution.observations),
                )
            }.values(),
            key=lambda item: str(item.observation_id),
        )
    )
    values_json = metadata_json(metadata)
    revision = (
        1
        if resolution.selected_record is None
        or resolution.selected_record.metadata_revision is None
        else resolution.selected_record.metadata_revision + 1
    )
    values = _canonical_object(values_json)
    provenance = _canonical_object(provenance_json)
    snapshot_sha = metadata_snapshot_sha256(revision, values, provenance)
    snapshot = None
    if (
        resolution.selected_record is None
        or resolution.selected_record.current_metadata != metadata
    ) and not (resolution.selected_record is not None and resolution.selected_record.completed):
        snapshot = PreparedMetadataSnapshot(
            snapshot_id=MetadataSnapshotId(
                str(
                    uuid5(
                        IDENTITY_NAMESPACE,
                        f"snapshot:{resolution.work_version_id}:{snapshot_sha}",
                    )
                )
            ),
            revision=revision,
            sha256=snapshot_sha,
            values_json=values_json,
            provenance_json=provenance_json,
        )
    blocked_identifiers = {
        identifier
        for record in resolution.candidate_records
        if _conflicts(record.current_metadata or InitialMetadata(), metadata)
        for identifier in _identifier_keys(record.identifiers)
        & _identifier_keys(resolution.identifiers)
    }
    prepared_identifiers = tuple(
        PreparedIdentifier(
            identifier_id=StableIdentifierId(
                str(uuid5(IDENTITY_NAMESPACE, f"identifier:{item.namespace}:{item.value}"))
            ),
            value=item,
        )
        for item in resolution.identifiers
        if _identifier_key(item) not in blocked_identifiers
    )
    relations = tuple(
        PreparedVersionRelation(
            relation_id=VersionRelationId(
                str(
                    uuid5(
                        IDENTITY_NAMESPACE,
                        f"relation:{resolution.work_version_id}:{target.work_version_id}:"
                        f"{evidence.relation}",
                    )
                )
            ),
            left_version_id=resolution.work_version_id,
            right_version_id=target.work_version_id,
            relation=evidence.relation,
        )
        for evidence in (
            item.version_relation
            for item in resolution.observations
            if item.version_relation is not None
        )
        for target in resolution.related_records
    )
    representative = resolution.work_version_id
    if (
        resolution.related_records
        and _ROLE_ORDER[resolution.related_records[0].version_role]
        < _ROLE_ORDER[resolution.version_role]
    ):
        representative = (
            resolution.related_records[0].representative_version_id
            or resolution.related_records[0].work_version_id
        )
    reviews: list[IdentityReviewRelation] = []
    for record in resolution.records:
        reasons = _identifier_conflicts(record.identifiers, resolution.identifiers) + _conflicts(
            record.current_metadata or InitialMetadata(), metadata
        )
        if record.work_version_id != resolution.work_version_id and (
            reasons or _fuzzy(record.current_metadata or InitialMetadata(), metadata)
        ):
            reviews.append(
                IdentityReviewRelation(
                    left_version_id=resolution.work_version_id,
                    right_version_id=record.work_version_id,
                    relation="identity-conflict" if reasons else "possible-duplicate",
                    evidence=",".join(reasons) if reasons else "title-token-overlap",
                )
            )
    expected_records = {
        record.work_version_id: record
        for record in (
            *resolution.candidate_records,
            *resolution.related_records,
            *(() if resolution.selected_record is None else (resolution.selected_record,)),
        )
    }
    expected = tuple(
        ExpectedIdentityRevision(
            work_version_id=record.work_version_id,
            revision=record.identity_revision,
        )
        for record in expected_records.values()
    )
    superseded = tuple(
        SupersededIdentity(work_id=record.work_id, work_version_id=record.work_version_id)
        for record in resolution.compatible_records
        if record.work_version_id != resolution.work_version_id
    )
    role_update = None
    if (
        resolution.selected_record is not None
        and resolution.selected_record.version_role != resolution.version_role
    ):
        role_update = PreparedRoleUpdate(
            work_version_id=resolution.work_version_id,
            expected_role=resolution.selected_record.version_role,
            role=resolution.version_role,
        )
    return PreparedBibliographyAcceptance(
        work_id=resolution.work_id,
        work_version_id=resolution.work_version_id,
        version_role=resolution.version_role,
        representative_version_id=representative,
        identifiers=prepared_identifiers,
        observations=tuple(
            item for item in prepared_observations if item not in existing_observations
        ),
        metadata_snapshot=snapshot,
        version_relations=relations,
        review_relations=tuple(reviews),
        expected_revisions=expected,
        superseded_identities=superseded,
        role_update=role_update,
    )


__all__ = ("prepare_identity_acceptance",)
