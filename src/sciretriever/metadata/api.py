"""Public neutral Metadata operations used by Entry.

Provider implementations are injected into :class:`MetadataService` during
composition.  No vendor client, raw item, pagination object, cursor, HTTP
request/response, PDF, Parser, LLM, Literature acceptance, or DiscoveryRun
lifecycle value crosses this API boundary.
"""

from __future__ import annotations

from sciretriever.metadata.ports import (
    MAX_PROVIDER_RELATION_PUBLICATION_BATCH,
    ProviderRelationObservationPublicationPort,
)
from sciretriever.metadata.publication import MetadataPublication
from sciretriever.metadata.rules import (
    CancellationEvent,
    MetadataBatchResult,
    MetadataLookupRequest,
    MetadataProviderInvocation,
    MetadataProviderInvocationOutcome,
    MetadataProviderResult,
    MetadataReferenceQueryRequest,
    ProviderReferenceQuery,
)
from sciretriever.metadata.service import MetadataService
from sciretriever.model.discovery import TopicDiscoveryInput


class MetadataApi:
    """Thin public boundary over one injected Metadata service."""

    def __init__(self, service: MetadataService) -> None:
        if not isinstance(service, MetadataService):
            raise TypeError("service must be a MetadataService")
        self._service = service

    def search_topic(self, request: TopicDiscoveryInput) -> MetadataBatchResult:
        return self._service.search_topic(request)

    def search_topic_provider(
        self,
        request: TopicDiscoveryInput,
        *,
        cancel_event: CancellationEvent | None = None,
    ) -> MetadataProviderInvocation:
        return self._service.search_topic_provider(request, cancel_event=cancel_event)

    def lookup(self, request: MetadataLookupRequest) -> MetadataProviderResult:
        return self._service.lookup(request)

    def lookup_provider(
        self,
        request: MetadataLookupRequest,
        *,
        cancel_event: CancellationEvent | None = None,
    ) -> MetadataProviderInvocation:
        return self._service.lookup_provider(request, cancel_event=cancel_event)

    def query_references(
        self,
        request: MetadataReferenceQueryRequest,
    ) -> MetadataBatchResult:
        return self._service.query_references(request)

    def query_references_provider(
        self,
        request: MetadataReferenceQueryRequest,
        *,
        cancel_event: CancellationEvent | None = None,
    ) -> MetadataProviderInvocation:
        return self._service.query_references_provider(request, cancel_event=cancel_event)


__all__ = (
    "CancellationEvent",
    "MAX_PROVIDER_RELATION_PUBLICATION_BATCH",
    "MetadataApi",
    "MetadataBatchResult",
    "MetadataLookupRequest",
    "MetadataProviderInvocation",
    "MetadataProviderInvocationOutcome",
    "MetadataProviderResult",
    "MetadataPublication",
    "MetadataReferenceQueryRequest",
    "ProviderReferenceQuery",
    "ProviderRelationObservationPublicationPort",
)
