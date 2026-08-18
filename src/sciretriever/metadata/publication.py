"""Metadata-to-Literature publication collaboration.

Metadata owns provider calls and neutral conversion, but Literature alone owns
observation admission, identity, current metadata and automatic PDF exhaustion
cleanup.  Provider relation observations are independent source facts and are
therefore published through a narrow, bounded-batch Storage port.  Each edge
remains an independent immutable fact; batching only bounds transaction cost.
"""

from __future__ import annotations

from collections.abc import Iterable

from sciretriever.literature.api import LiteratureApi, ObservationAcceptanceResult
from sciretriever.metadata.ports import (
    MAX_PROVIDER_RELATION_PUBLICATION_BATCH,
    ProviderRelationObservationPublicationPort,
)
from sciretriever.model.metadata import MetadataObservation, ProviderRelationObservation


class MetadataPublication:
    """Publish neutral Metadata output without taking over Literature facts."""

    def __init__(
        self,
        literature_api: LiteratureApi,
        relation_port: ProviderRelationObservationPublicationPort,
    ) -> None:
        if not isinstance(literature_api, LiteratureApi):
            raise TypeError("literature_api must be a LiteratureApi")
        if not isinstance(relation_port, ProviderRelationObservationPublicationPort):
            raise TypeError("relation_port must publish provider relation observations")
        self._literature_api = literature_api
        self._relation_port = relation_port

    def publish_observation(
        self,
        observation: MetadataObservation,
        *,
        provider_precedence: Iterable[str] = (),
    ) -> ObservationAcceptanceResult:
        """Delegate observation admission unchanged to Literature."""

        return self._literature_api.accept_observation(
            observation,
            provider_precedence=provider_precedence,
        )

    def publish_relation_observations(
        self,
        observations: tuple[ProviderRelationObservation, ...],
    ) -> None:
        """Publish one bounded relation batch without resolving endpoints."""

        if not isinstance(observations, tuple) or any(
            not isinstance(observation, ProviderRelationObservation) for observation in observations
        ):
            raise TypeError("observations must be a tuple of ProviderRelationObservation")
        if not observations:
            raise ValueError("observations must not be empty")
        if len(observations) > MAX_PROVIDER_RELATION_PUBLICATION_BATCH:
            raise ValueError("observations exceed the bounded publication batch")
        self._relation_port.publish_provider_relation_observations(observations)


__all__ = (
    "MAX_PROVIDER_RELATION_PUBLICATION_BATCH",
    "MetadataPublication",
    "ProviderRelationObservationPublicationPort",
)
