from __future__ import annotations

import json
from uuid import UUID, uuid5

from sciretriever.bibliography.identity_model import (
    BibliographicObservation,
    InitialMetadata,
    StoredObservation,
    VersionRelationEvidence,
)
from sciretriever.kernel import Identifier, ObservationId, Sha256


IDENTITY_NAMESPACE = UUID("4dcd977a-16c2-4e67-8072-f032c2c73a70")


def prepare_observation(observation: BibliographicObservation) -> StoredObservation:
    relation = observation.version_relation
    payload = json.dumps({
        "identifiers": [[item.namespace, item.value] for item in observation.identifiers],
        "metadata": {
            "abstract": observation.metadata.abstract,
            "authors": list(observation.metadata.authors),
            "item_type": observation.metadata.item_type,
            "keywords": list(observation.metadata.keywords),
            "language": observation.metadata.language,
            "title": observation.metadata.title,
            "venue": observation.metadata.venue,
            "year": observation.metadata.year,
        },
        "source_priority": observation.source_priority,
        "version_relation": None if relation is None else {
            "relation": relation.relation,
            "target": [relation.target_identifier.namespace, relation.target_identifier.value],
        },
        "version_role": observation.version_role,
    }, ensure_ascii=True, separators=(",", ":"), sort_keys=True)
    digest = Sha256.from_bytes(payload.encode("ascii"))
    key = f"observation:{observation.provider}:{observation.provider_record_id}:{digest}"
    return StoredObservation(
        ObservationId(str(uuid5(IDENTITY_NAMESPACE, key))), observation.provider,
        observation.provider_record_id, digest, payload, observation.observed_at,
    )


def metadata_json(value: InitialMetadata) -> str:
    return json.dumps({
        "abstract": value.abstract, "authors": list(value.authors), "item_type": value.item_type,
        "keywords": list(value.keywords), "language": value.language, "title": value.title,
        "venue": value.venue, "year": value.year,
    }, ensure_ascii=True, separators=(",", ":"), sort_keys=True)


def observation_from_stored(value: StoredObservation) -> BibliographicObservation:
    payload = json.loads(value.payload_json)
    metadata = payload["metadata"]
    relation = payload["version_relation"]
    parsed_relation = None
    if relation is not None:
        parsed_relation = VersionRelationEvidence(
            Identifier(relation["target"][0], relation["target"][1]), relation["relation"]
        )
    return BibliographicObservation(
        value.provider, value.provider_record_id, payload["source_priority"], value.observed_at,
        tuple(Identifier(item[0], item[1]) for item in payload["identifiers"]),
        InitialMetadata(
            metadata["title"], tuple(metadata["authors"]), metadata["year"], metadata["item_type"],
            metadata["abstract"], metadata["venue"], metadata["language"], tuple(metadata["keywords"]),
        ),
        payload["version_role"], parsed_relation,
    )


def unified_metadata(
    observations: tuple[BibliographicObservation, ...],
) -> tuple[InitialMetadata, str]:
    ordered = sorted(observations, key=lambda item: (item.source_priority, item.provider, item.provider_record_id))
    fields = ("title", "authors", "year", "item_type", "abstract", "venue", "language", "keywords")
    provenance: dict[str, str] = {}
    for field in fields:
        for item in ordered:
            value = getattr(item.metadata, field)
            if value is not None and value != ():
                provenance[field] = f"{item.provider}:{item.provider_record_id}"
                break
    metadata = InitialMetadata(
        next((item.metadata.title for item in ordered if item.metadata.title is not None), None),
        next((item.metadata.authors for item in ordered if item.metadata.authors), ()),
        next((item.metadata.year for item in ordered if item.metadata.year is not None), None),
        next((item.metadata.item_type for item in ordered if item.metadata.item_type is not None), None),
        next((item.metadata.abstract for item in ordered if item.metadata.abstract is not None), None),
        next((item.metadata.venue for item in ordered if item.metadata.venue is not None), None),
        next((item.metadata.language for item in ordered if item.metadata.language is not None), None),
        next((item.metadata.keywords for item in ordered if item.metadata.keywords), ()),
    )
    return metadata, json.dumps(provenance, ensure_ascii=True, separators=(",", ":"), sort_keys=True)
