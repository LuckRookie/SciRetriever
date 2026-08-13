"""Deterministic identities for immutable metadata-provider source facts.

Provider adapters still construct complete neutral Models before identity is
assigned.  This helper replaces the temporary ingestion IDs with domain-tagged
UUIDv5 values derived from every retained provider semantic field except the
observation timestamp.  Re-observing byte-identical input can therefore point
at the first durable fact while a changed input or changed neutral conversion
receives a different identity.
"""

from __future__ import annotations

import json
from uuid import UUID, uuid5

from sciretriever.model.metadata import (
    MetadataObservation,
    ProviderLiteratureKey,
    ProviderRelationObservation,
)
from sciretriever.model.primitives import ObservationId, ProvenanceId, SourceKind
from sciretriever.model.provenance import Provenance

_IDENTITY_NAMESPACE = UUID("73e0aa2f-ef6d-5b30-a214-1c55bbf7b768")
_PROVENANCE_DOMAIN = "sciretriever-provider-provenance-v1"
_METADATA_DOMAIN = "sciretriever-provider-metadata-observation-v1"
_RELATION_DOMAIN = "sciretriever-provider-relation-observation-v1"


def stabilize_provider_metadata_observation(
    observation: MetadataObservation,
) -> MetadataObservation:
    """Replace temporary provider metadata IDs with deterministic identities."""

    if not isinstance(observation, MetadataObservation):
        raise TypeError("observation must be a MetadataObservation")
    provenance_value = _provider_provenance_value(observation.provenance)
    provenance = observation.provenance.model_copy(
        update={"provenance_id": _provenance_id(provenance_value)}
    )
    semantic_value: dict[str, object] = {
        "provenance": provenance_value,
        "metadata": observation.metadata.model_dump(mode="json"),
        "version_role": (
            None if observation.version_role is None else observation.version_role.value
        ),
        "version_links": [item.model_dump(mode="json") for item in observation.version_links],
        "declared_keywords": list(observation.declared_keywords),
        "reference_texts": list(observation.reference_texts),
        "reference_count": observation.reference_count,
        "cited_by_count": observation.cited_by_count,
        "asset_hints": [item.model_dump(mode="json") for item in observation.asset_hints],
    }
    return observation.model_copy(
        update={
            "observation_id": _observation_id(_METADATA_DOMAIN, semantic_value),
            "provenance": provenance,
        }
    )


def stabilize_provider_relation_observation(
    observation: ProviderRelationObservation,
) -> ProviderRelationObservation:
    """Replace temporary provider relation IDs with deterministic identities."""

    if not isinstance(observation, ProviderRelationObservation):
        raise TypeError("observation must be a ProviderRelationObservation")
    provenance_value = _provider_provenance_value(observation.provenance)
    provenance = observation.provenance.model_copy(
        update={"provenance_id": _provenance_id(provenance_value)}
    )
    semantic_value: dict[str, object] = {
        "provenance": provenance_value,
        "citing": _provider_key_value(observation.citing),
        "cited": _provider_key_value(observation.cited),
    }
    return observation.model_copy(
        update={
            "observation_id": _observation_id(_RELATION_DOMAIN, semantic_value),
            "provenance": provenance,
        }
    )


def _provider_provenance_value(provenance: Provenance) -> dict[str, object]:
    if not isinstance(provenance, Provenance):
        raise TypeError("provenance must be a Provenance")
    if provenance.source_kind is not SourceKind.METADATA_PROVIDER:
        raise ValueError("provider identity requires metadata-provider provenance")
    if provenance.source_record_id is None or provenance.input_sha256 is None:
        raise ValueError("provider identity requires record and input identities")
    return {
        "source_kind": provenance.source_kind.value,
        "source_name": provenance.source_name,
        "source_record_id": provenance.source_record_id,
        "input_sha256": str(provenance.input_sha256),
        "parameters_sha256": (
            None if provenance.parameters_sha256 is None else str(provenance.parameters_sha256)
        ),
    }


def _provider_key_value(key: ProviderLiteratureKey) -> dict[str, object]:
    if not isinstance(key, ProviderLiteratureKey):
        raise TypeError("provider relation endpoint must be a ProviderLiteratureKey")
    return {
        "record_id": key.record_id,
        "identifiers": sorted(
            (
                {"namespace": identifier.namespace, "value": identifier.value}
                for identifier in key.identifiers
            ),
            key=lambda item: (item["namespace"], item["value"]),
        ),
    }


def _provenance_id(value: dict[str, object]) -> ProvenanceId:
    return ProvenanceId(str(_tagged_uuid(_PROVENANCE_DOMAIN, value)))


def _observation_id(domain: str, value: dict[str, object]) -> ObservationId:
    return ObservationId(str(_tagged_uuid(domain, value)))


def _tagged_uuid(domain: str, value: dict[str, object]) -> UUID:
    encoded = json.dumps(
        {"domain": domain, "value": value},
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    return uuid5(_IDENTITY_NAMESPACE, encoded)


__all__ = (
    "stabilize_provider_metadata_observation",
    "stabilize_provider_relation_observation",
)
