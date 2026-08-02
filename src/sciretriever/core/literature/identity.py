from __future__ import annotations

import hashlib
from uuid import uuid5

from sciretriever.core.literature.identity_matching import (
    _IDENTIFIER_ORDER,
    _ROLE_ORDER,
    _anchor,
    _conflicts,
    _deduplicate_identifiers,
    _identifier,
    _identifier_conflicts,
    _identifier_key,
    _identifier_keys,
    _matches,
    _metadata_signature,
    _normalize_observation,
    _observation_anchor,
    _record_key,
)
from sciretriever.core.literature.identity_metadata import (
    IDENTITY_NAMESPACE,
    metadata_json,
    unified_metadata,
)
from sciretriever.model.literature import (
    BibliographicObservation,
    IdentityRecord,
    IdentityResolution,
    InitialMetadata,
)
from sciretriever.model.primitives import WorkId, WorkVersionId


def resolve_identity(
    records: tuple[IdentityRecord, ...],
    observations: tuple[BibliographicObservation, ...],
) -> IdentityResolution:
    normalized = tuple(
        sorted(
            (_normalize_observation(item) for item in observations),
            key=lambda item: (
                item.source_priority,
                item.provider,
                item.provider_record_id,
                str(item.observed_at),
            ),
        )
    )
    metadata, provenance_json = unified_metadata(normalized)
    identifiers = _deduplicate_identifiers(
        tuple(value for item in normalized for value in item.identifiers)
    )
    ordered_records = tuple(sorted(records, key=lambda item: str(item.work_version_id)))
    relation_targets = {
        _identifier_key(_identifier(item.version_relation.target_identifier))
        for item in normalized
        if item.version_relation is not None
    }
    related = tuple(
        record
        for record in ordered_records
        if _identifier_keys(record.identifiers) & relation_targets
    )
    candidates = tuple(
        record
        for record in ordered_records
        if _matches(record, identifiers, metadata) and record not in related
    )
    compatible = tuple(
        record
        for record in candidates
        if not _identifier_conflicts(record.identifiers, identifiers)
        and not _conflicts(record.current_metadata or InitialMetadata(), metadata)
    )
    selected = min(compatible, key=_record_key) if compatible else None
    anchor = _anchor(identifiers, metadata)
    if not identifiers and _metadata_signature(metadata) is None:
        anchor = _observation_anchor(normalized)
    blocked_reasons = tuple(
        sorted(
            {
                reason
                for record in candidates
                for reason in _conflicts(record.current_metadata or InitialMetadata(), metadata)
            }
        )
    )
    if selected is None and blocked_reasons:
        evidence = "|".join(
            (
                metadata_json(metadata),
                *(f"{item.namespace}:{item.value}" for item in identifiers),
                *blocked_reasons,
            )
        )
        anchor = f"conflict:{hashlib.sha256(evidence.encode('ascii')).hexdigest()}"
        conflict_version_id = WorkVersionId(str(uuid5(IDENTITY_NAMESPACE, f"version:{anchor}")))
        selected = next(
            (record for record in ordered_records if record.work_version_id == conflict_version_id),
            None,
        )
    incoming_priority = min(
        (_IDENTIFIER_ORDER.get(item.namespace, 99) for item in identifiers), default=100
    )
    if (
        selected is not None
        and not selected.completed
        and _record_key(selected)[0] > incoming_priority
    ):
        selected = None
    work_id = (
        selected.work_id
        if selected is not None
        else (
            related[0].work_id
            if related
            else WorkId(str(uuid5(IDENTITY_NAMESPACE, f"work:{anchor}")))
        )
    )
    version_id = (
        selected.work_version_id
        if selected is not None
        else WorkVersionId(str(uuid5(IDENTITY_NAMESPACE, f"version:{anchor}")))
    )
    roles = tuple(item.version_role for item in normalized) + (
        () if selected is None else (selected.version_role,)
    )
    role = min(roles, key=lambda value: _ROLE_ORDER[value])
    return IdentityResolution(
        observations=normalized,
        metadata=metadata,
        provenance_json=provenance_json,
        identifiers=identifiers,
        records=ordered_records,
        related_records=related,
        candidate_records=candidates,
        compatible_records=compatible,
        selected_record=selected,
        work_id=work_id,
        work_version_id=version_id,
        version_role=role,
        anchor=anchor,
    )


__all__ = ("resolve_identity",)
