"""Metadata-to-Literature publication collaboration.

Metadata owns provider calls and neutral conversion, but Literature alone owns
observation admission, identity, current metadata and automatic PDF exhaustion
cleanup.  Provider relation observations are independent source facts and are
therefore published one edge at a time through a narrow Storage port.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Protocol, runtime_checkable

from sciretriever.literature.api import LiteratureApi, ObservationAcceptanceResult
from sciretriever.model.metadata import MetadataObservation, ProviderRelationObservation


@runtime_checkable
class ProviderRelationObservationPublicationPort(Protocol):
    """Persist one already validated provider relation source fact."""

    def publish_provider_relation_observation(
        self,
        observation: ProviderRelationObservation,
    ) -> None: ...


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

    def publish_relation_observation(
        self,
        observation: ProviderRelationObservation,
    ) -> None:
        """Publish one relation fact without resolving either endpoint."""

        self._relation_port.publish_provider_relation_observation(observation)


__all__ = (
    "MetadataPublication",
    "ProviderRelationObservationPublicationPort",
)
