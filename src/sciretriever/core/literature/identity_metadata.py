from __future__ import annotations

from collections.abc import Iterable
from typing import TypeAlias
from uuid import UUID, uuid5

from sciretriever.model.canonical_json import (
    CanonicalJsonObject,
    CanonicalJsonValue,
    canonical_json_bytes,
    parse_canonical_json,
)
from sciretriever.model.literature import (
    BibliographicObservation,
    Identifier,
    InitialMetadata,
    StoredObservation,
    VersionRelationEvidence,
)
from sciretriever.model.primitives import ObservationId, sha256_digest

IDENTITY_NAMESPACE = UUID("4dcd977a-16c2-4e67-8072-f032c2c73a70")
CanonicalJsonEntries: TypeAlias = dict[str, CanonicalJsonValue]


def _metadata_payload(value: InitialMetadata) -> CanonicalJsonObject:
    return CanonicalJsonObject(
        (
            ("abstract", value.abstract),
            ("authors", value.authors),
            ("item_type", value.item_type),
            ("keywords", value.keywords),
            ("language", value.language),
            ("title", value.title),
            ("venue", value.venue),
            ("year", value.year),
        )
    )


def _observation_payload(observation: BibliographicObservation) -> CanonicalJsonObject:
    relation = observation.version_relation
    return CanonicalJsonObject(
        (
            (
                "identifiers",
                tuple((item.namespace, item.value) for item in observation.identifiers),
            ),
            ("metadata", _metadata_payload(observation.metadata)),
            ("source_priority", observation.source_priority),
            (
                "version_relation",
                None
                if relation is None
                else CanonicalJsonObject(
                    (
                        ("relation", relation.relation),
                        (
                            "target",
                            (
                                relation.target_identifier.namespace,
                                relation.target_identifier.value,
                            ),
                        ),
                    )
                ),
            ),
            ("version_role", observation.version_role),
        )
    )


def prepare_observation(observation: BibliographicObservation) -> StoredObservation:
    payload = canonical_json_bytes(_observation_payload(observation))
    digest = sha256_digest(payload)
    key = f"observation:{observation.provider}:{observation.provider_record_id}:{digest}"
    return StoredObservation(
        observation_id=ObservationId(str(uuid5(IDENTITY_NAMESPACE, key))),
        provider=observation.provider,
        provider_record_id=observation.provider_record_id,
        payload_sha256=digest,
        payload_json=payload.decode("ascii"),
        observed_at=observation.observed_at,
    )


def metadata_json(value: InitialMetadata) -> str:
    return canonical_json_bytes(_metadata_payload(value)).decode("ascii")


def _entries(value: CanonicalJsonValue) -> CanonicalJsonEntries:
    assert isinstance(value, CanonicalJsonObject)
    return dict(value.entries)


def _tuple(value: CanonicalJsonValue) -> tuple[CanonicalJsonValue, ...]:
    assert isinstance(value, tuple)
    return value


def _string(value: CanonicalJsonValue) -> str:
    assert isinstance(value, str)
    return value


def _integer(value: CanonicalJsonValue) -> int:
    assert isinstance(value, int)
    return value


def _optional_string(value: CanonicalJsonValue) -> str | None:
    if value is None:
        return None
    return _string(value)


def _optional_integer(value: CanonicalJsonValue) -> int | None:
    if value is None:
        return None
    return _integer(value)


def _strings(value: CanonicalJsonValue) -> tuple[str, ...]:
    return tuple(_string(item) for item in _tuple(value))


def _identifier(value: CanonicalJsonValue) -> Identifier:
    pair = _tuple(value)
    return Identifier(namespace=_string(pair[0]), value=_string(pair[1]))


def observation_from_stored(value: StoredObservation) -> BibliographicObservation:
    payload = _entries(parse_canonical_json(value.payload_json))
    metadata = _entries(payload["metadata"])
    relation_value = payload["version_relation"]
    relation = None
    if relation_value is not None:
        relation_entries = _entries(relation_value)
        relation = VersionRelationEvidence(
            target_identifier=_identifier(relation_entries["target"]),
            relation=_string(relation_entries["relation"]),
        )
    return BibliographicObservation(
        provider=value.provider,
        provider_record_id=value.provider_record_id,
        source_priority=_integer(payload["source_priority"]),
        observed_at=value.observed_at,
        identifiers=tuple(_identifier(item) for item in _tuple(payload["identifiers"])),
        metadata=InitialMetadata(
            title=_optional_string(metadata["title"]),
            authors=_strings(metadata["authors"]),
            year=_optional_integer(metadata["year"]),
            item_type=_optional_string(metadata["item_type"]),
            abstract=_optional_string(metadata["abstract"]),
            venue=_optional_string(metadata["venue"]),
            language=_optional_string(metadata["language"]),
            keywords=_strings(metadata["keywords"]),
        ),
        version_role=_string(payload["version_role"]),
        version_relation=relation,
    )


def unified_metadata(
    observations: tuple[BibliographicObservation, ...],
) -> tuple[InitialMetadata, str]:
    ordered = sorted(
        observations,
        key=lambda item: (item.source_priority, item.provider, item.provider_record_id),
    )
    fields = (
        "title",
        "authors",
        "year",
        "item_type",
        "abstract",
        "venue",
        "language",
        "keywords",
    )
    provenance: dict[str, str] = {}
    for field in fields:
        for item in ordered:
            value = getattr(item.metadata, field)
            if value is not None and value != ():
                provenance[field] = f"{item.provider}:{item.provider_record_id}"
                break
    metadata = InitialMetadata(
        title=next(
            (item.metadata.title for item in ordered if item.metadata.title is not None), None
        ),
        authors=next((item.metadata.authors for item in ordered if item.metadata.authors), ()),
        year=next((item.metadata.year for item in ordered if item.metadata.year is not None), None),
        item_type=next(
            (item.metadata.item_type for item in ordered if item.metadata.item_type is not None),
            None,
        ),
        abstract=next(
            (item.metadata.abstract for item in ordered if item.metadata.abstract is not None), None
        ),
        venue=next(
            (item.metadata.venue for item in ordered if item.metadata.venue is not None), None
        ),
        language=next(
            (item.metadata.language for item in ordered if item.metadata.language is not None), None
        ),
        keywords=next((item.metadata.keywords for item in ordered if item.metadata.keywords), ()),
    )
    provenance_value = CanonicalJsonObject(tuple(provenance.items()))
    return metadata, canonical_json_bytes(provenance_value).decode("ascii")


def observations_from_stored(
    values: Iterable[StoredObservation],
) -> tuple[BibliographicObservation, ...]:
    return tuple(observation_from_stored(value) for value in values)


__all__ = (
    "IDENTITY_NAMESPACE",
    "metadata_json",
    "observation_from_stored",
    "observations_from_stored",
    "prepare_observation",
    "unified_metadata",
)
