from __future__ import annotations

from collections.abc import Iterable
import hashlib
import re
import unicodedata
from uuid import uuid5

from sciretriever.bibliography.identity_model import (
    BibliographicObservation,
    ExpectedIdentityRevision,
    IdentityRecord,
    IdentityReviewRelation,
    InitialMetadata,
    PreparedBibliographyAcceptance,
    PreparedIdentifier,
    PreparedMetadataSnapshot, PreparedRoleUpdate,
    PreparedVersionRelation, SupersededIdentity,
)
from .identity_metadata import (
    IDENTITY_NAMESPACE, metadata_json, observation_from_stored, prepare_observation,
    unified_metadata,
)
from sciretriever.bibliography.ports import BibliographyRepository
from sciretriever.bibliography.publisher_contracts import metadata_snapshot_sha256
from sciretriever.kernel import (
    CanonicalJsonObject, Identifier,
    MetadataSnapshotId,
    Sha256,
    StableIdentifierId,
    VersionRelationId,
    WorkId,
    WorkVersionId,
    parse_canonical_json,
)


_SPACE = re.compile(r"\s+")
_ROLE_ORDER = {"formal": 0, "accepted-manuscript": 1, "preprint": 2, "other": 3}
_IDENTIFIER_ORDER = {"doi": 0, "pmid": 1, "pmcid": 2, "arxiv": 3, "isbn": 4, "issn": 5}


def _normalized_text(value: str) -> str:
    return _SPACE.sub(" ", unicodedata.normalize("NFKC", value).casefold()).strip()


def _identifier(value: Identifier) -> Identifier:
    namespace = _normalized_text(value.namespace)
    normalized = _normalized_text(value.value)
    if namespace == "doi":
        normalized = re.sub(r"^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)", "", normalized)
    if namespace == "arxiv":
        normalized = re.sub(r"^(?:https?://(?:www\.)?arxiv\.org/(?:abs|pdf)/|arxiv:\s*)", "", normalized)
        normalized = re.sub(r"\.pdf$", "", normalized)
    return Identifier(namespace, normalized)


def _metadata_signature(value: InitialMetadata) -> tuple[str, tuple[str, ...], int, str] | None:
    if value.title is None or not value.authors or value.year is None or value.item_type is None:
        return None
    return (
        _normalized_text(value.title),
        tuple(_normalized_text(author) for author in value.authors),
        value.year,
        _normalized_text(value.item_type),
    )


def _conflicts(left: InitialMetadata, right: InitialMetadata) -> tuple[str, ...]:
    reasons: list[str] = []
    title_conflict = bool(
        left.title and right.title
        and _normalized_text(left.title) != _normalized_text(right.title)
    )
    author_conflict = bool(
        left.authors and right.authors
        and tuple(map(_normalized_text, left.authors)) != tuple(map(_normalized_text, right.authors))
    )
    if title_conflict and author_conflict:
        reasons.append("title-author-conflict")
    if left.year is not None and right.year is not None and left.year != right.year:
        reasons.append("year-conflict")
    if left.item_type and right.item_type and _normalized_text(left.item_type) != _normalized_text(right.item_type):
        reasons.append("type-conflict")
    return tuple(reasons)


def _identifier_conflicts(left: Iterable[Identifier], right: Iterable[Identifier]) -> tuple[str, ...]:
    left_map = {item.namespace: item.value for item in left}
    right_map = {item.namespace: item.value for item in right}
    return tuple(
        f"{namespace}-conflict"
        for namespace in sorted(left_map.keys() & right_map.keys())
        if left_map[namespace] != right_map[namespace]
    )


def _anchor(identifiers: tuple[Identifier, ...], metadata: InitialMetadata) -> str:
    if identifiers:
        selected = min(identifiers, key=lambda item: (_IDENTIFIER_ORDER.get(item.namespace, 99), item.namespace, item.value))
        return f"identifier:{selected.namespace}:{selected.value}"
    signature = _metadata_signature(metadata)
    if signature is not None:
        return f"metadata:{signature!r}"
    return f"metadata:{hashlib.sha256(metadata_json(metadata).encode('ascii')).hexdigest()}"


def _record_key(record: IdentityRecord) -> tuple[int, str]:
    if not record.identifiers:
        return 100, str(record.work_version_id)
    selected = min(record.identifiers, key=lambda item: (_IDENTIFIER_ORDER.get(item.namespace, 99), item.namespace, item.value))
    return _IDENTIFIER_ORDER.get(selected.namespace, 99), str(record.work_version_id)


def _matches(record: IdentityRecord, identifiers: tuple[Identifier, ...], metadata: InitialMetadata) -> bool:
    shared = set(record.identifiers) & set(identifiers)
    record_signature = None if record.current_metadata is None else _metadata_signature(record.current_metadata)
    incoming_signature = _metadata_signature(metadata)
    exact_metadata = (
        record_signature is not None
        and incoming_signature is not None
        and record_signature == incoming_signature
    )
    return bool(shared) or (not identifiers and not record.identifiers and exact_metadata)


def _fuzzy(left: InitialMetadata, right: InitialMetadata) -> bool:
    if not left.title or not right.title:
        return False
    left_words = set(_normalized_text(left.title).split())
    right_words = set(_normalized_text(right.title).split())
    return len(left_words & right_words) >= 2


def prepare_initial_ingest(
    repository: BibliographyRepository,
    observations: tuple[BibliographicObservation, ...],
) -> PreparedBibliographyAcceptance:
    normalized = tuple(
        BibliographicObservation(
            item.provider, item.provider_record_id, item.source_priority, item.observed_at,
            tuple(sorted({_identifier(value) for value in item.identifiers}, key=lambda value: (value.namespace, value.value))),
            item.metadata, item.version_role, item.version_relation,
        )
        for item in observations
    )
    metadata, provenance_json = unified_metadata(normalized)
    identifiers = tuple(sorted({value for item in normalized for value in item.identifiers}, key=lambda value: (value.namespace, value.value)))
    records = repository.list_identity_records()
    relation_targets = {
        _identifier(item.version_relation.target_identifier)
        for item in normalized if item.version_relation is not None
    }
    related = tuple(record for record in records if set(record.identifiers) & relation_targets)
    candidates = tuple(record for record in records if _matches(record, identifiers, metadata) and record not in related)
    compatible = tuple(record for record in candidates if not _identifier_conflicts(record.identifiers, identifiers) and not _conflicts(record.current_metadata or InitialMetadata(), metadata))
    selected = min(compatible, key=_record_key) if compatible else None
    anchor = _anchor(identifiers, metadata)
    if not identifiers and _metadata_signature(metadata) is None:
        evidence = "|".join(sorted(str(prepare_observation(item).observation_id) for item in normalized))
        anchor = f"observation:{hashlib.sha256(evidence.encode('ascii')).hexdigest()}"
    blocked_reasons = tuple(sorted({
        reason
        for record in candidates
        for reason in _conflicts(record.current_metadata or InitialMetadata(), metadata)
    }))
    if selected is None and blocked_reasons:
        evidence = "|".join((metadata_json(metadata), *(f"{item.namespace}:{item.value}" for item in identifiers), *blocked_reasons))
        anchor = f"conflict:{hashlib.sha256(evidence.encode('ascii')).hexdigest()}"
        conflict_version_id = WorkVersionId(str(uuid5(IDENTITY_NAMESPACE, f"version:{anchor}")))
        selected = next((record for record in records if record.work_version_id == conflict_version_id), None)
    incoming_priority = min((_IDENTIFIER_ORDER.get(item.namespace, 99) for item in identifiers), default=100)
    if selected is not None and not selected.completed and _record_key(selected)[0] > incoming_priority:
        selected = None
    work_id = selected.work_id if selected is not None else (related[0].work_id if related else WorkId(str(uuid5(IDENTITY_NAMESPACE, f"work:{anchor}"))))
    version_id = selected.work_version_id if selected is not None else WorkVersionId(str(uuid5(IDENTITY_NAMESPACE, f"version:{anchor}")))
    roles = tuple(item.version_role for item in normalized) + (() if selected is None else (selected.version_role,))
    role = min(roles, key=lambda value: _ROLE_ORDER[value])
    candidate_observations = tuple(
        item for record in compatible for item in repository.list_observations(record.work_version_id)
    )
    existing_observations = repository.list_observations(version_id) if selected is not None else ()
    if candidate_observations:
        metadata, provenance_json = unified_metadata(
            tuple(observation_from_stored(item) for item in candidate_observations) + normalized
        )
    prepared_observations = tuple(sorted({prepare_observation(item) for item in normalized} | set(existing_observations), key=lambda item: str(item.observation_id)))
    values_json = metadata_json(metadata)
    revision = 1 if selected is None or selected.metadata_revision is None else selected.metadata_revision + 1
    values = parse_canonical_json(values_json)
    provenance = parse_canonical_json(provenance_json)
    assert isinstance(values, CanonicalJsonObject)
    assert isinstance(provenance, CanonicalJsonObject)
    snapshot_sha = metadata_snapshot_sha256(revision, values, provenance)
    snapshot = None
    if (selected is None or selected.current_metadata != metadata) and not (selected is not None and selected.completed):
        snapshot = PreparedMetadataSnapshot(
            MetadataSnapshotId(str(uuid5(IDENTITY_NAMESPACE, f"snapshot:{version_id}:{snapshot_sha}"))),
            revision, snapshot_sha, values_json, provenance_json,
        )
    blocked_identifiers = {
        identifier
        for record in candidates if _conflicts(record.current_metadata or InitialMetadata(), metadata)
        for identifier in set(record.identifiers) & set(identifiers)
    }
    prepared_identifiers = tuple(
        PreparedIdentifier(StableIdentifierId(str(uuid5(IDENTITY_NAMESPACE, f"identifier:{item.namespace}:{item.value}"))), item)
        for item in identifiers if item not in blocked_identifiers
    )
    relations = tuple(
        PreparedVersionRelation(
            VersionRelationId(str(uuid5(IDENTITY_NAMESPACE, f"relation:{version_id}:{target.work_version_id}:{evidence.relation}"))),
            version_id, target.work_version_id, evidence.relation,
        )
        for evidence in (item.version_relation for item in normalized if item.version_relation is not None)
        for target in related
    )
    representative = version_id
    if related and _ROLE_ORDER[related[0].version_role] < _ROLE_ORDER[role]:
        representative = related[0].representative_version_id or related[0].work_version_id
    reviews: list[IdentityReviewRelation] = []
    for record in records:
        reasons = _identifier_conflicts(record.identifiers, identifiers) + _conflicts(record.current_metadata or InitialMetadata(), metadata)
        if record.work_version_id != version_id and (reasons or _fuzzy(record.current_metadata or InitialMetadata(), metadata)):
            reviews.append(IdentityReviewRelation(
                version_id, record.work_version_id,
                "identity-conflict" if reasons else "possible-duplicate",
                ",".join(reasons) if reasons else "title-token-overlap",
            ))
    expected_records = {record.work_version_id: record for record in candidates + related + (() if selected is None else (selected,))}
    expected = tuple(ExpectedIdentityRevision(record.work_version_id, record.identity_revision) for record in expected_records.values())
    superseded = tuple(
        SupersededIdentity(record.work_id, record.work_version_id)
        for record in compatible if record.work_version_id != version_id
    )
    return PreparedBibliographyAcceptance(
        work_id, version_id, role, representative, prepared_identifiers,
        tuple(item for item in prepared_observations if item not in existing_observations),
        snapshot, relations, tuple(reviews), expected, superseded,
        None if selected is None or selected.version_role == role else PreparedRoleUpdate(version_id, selected.version_role, role),
    )
