"""Neutral Metadata capability orchestration and raw-item scan semantics."""

from __future__ import annotations

import unicodedata
from collections.abc import Callable, Iterable

from sciretriever.metadata.ports import (
    MetadataLookupPort,
    MetadataProviderFailure,
    RawItemDelivery,
    RawItemSession,
    ReferenceQueryPort,
    TopicSearchPort,
)
from sciretriever.metadata.rules import (
    CancellationEvent,
    MetadataBatchResult,
    MetadataLookupRequest,
    MetadataProviderInvocation,
    MetadataProviderInvocationOutcome,
    MetadataProviderResult,
    MetadataReferenceQueryRequest,
    NeutralMetadataItem,
    ReferenceQueryContext,
    TopicSearchQuery,
    _reference_direction_failure,
    relation_matches_query,
)
from sciretriever.model.discovery import TopicDiscoveryInput
from sciretriever.model.metadata import MetadataObservation, ProviderRelationObservation
from sciretriever.model.report import StableFailure


class MetadataService:
    """Execute capability-scoped providers without owning Entry or Literature rules."""

    def __init__(
        self,
        *,
        topic_search_ports: Iterable[TopicSearchPort] = (),
        lookup_ports: Iterable[MetadataLookupPort] = (),
        reference_query_ports: Iterable[ReferenceQueryPort] = (),
    ) -> None:
        self._topic_search_ports = _index_topic_ports(topic_search_ports)
        self._lookup_ports = _index_lookup_ports(lookup_ports)
        self._reference_query_ports = _index_reference_ports(reference_query_ports)

    def search_topic(self, request: TopicDiscoveryInput) -> MetadataBatchResult:
        if not isinstance(request, TopicDiscoveryInput):
            raise TypeError("request must be a TopicDiscoveryInput")
        results: list[MetadataProviderResult] = []
        for provider_limit in request.providers:
            results.append(
                _completed_result(
                    self.search_topic_provider(
                        request.model_copy(update={"providers": (provider_limit,)}),
                        cancel_event=None,
                    )
                )
            )
        return MetadataBatchResult(providers=tuple(results))

    def search_topic_provider(
        self,
        request: TopicDiscoveryInput,
        *,
        cancel_event: CancellationEvent | None = None,
    ) -> MetadataProviderInvocation:
        if not isinstance(request, TopicDiscoveryInput):
            raise TypeError("request must be a TopicDiscoveryInput")
        if len(request.providers) != 1:
            raise ValueError("provider invocation requires exactly one provider")
        _validate_cancel_event(cancel_event)
        provider_limit = request.providers[0]
        port = self._topic_search_ports.get(provider_limit.provider_name)
        if port is None:
            raise KeyError("requested topic-search capability is not assembled")
        query = TopicSearchQuery(
            query=request.query,
            year_from=request.year_from,
            year_to=request.year_to,
        )
        return self._scan_provider(
            provider_name=provider_limit.provider_name,
            scan_limit=provider_limit.scan_limit,
            open_session=lambda: port.open_topic_search(query),
            cancel_event=cancel_event,
        )

    def lookup(self, request: MetadataLookupRequest) -> MetadataProviderResult:
        return _completed_result(self.lookup_provider(request))

    def lookup_provider(
        self,
        request: MetadataLookupRequest,
        *,
        cancel_event: CancellationEvent | None = None,
    ) -> MetadataProviderInvocation:
        if not isinstance(request, MetadataLookupRequest):
            raise TypeError("request must be a MetadataLookupRequest")
        _validate_cancel_event(cancel_event)
        port = self._lookup_ports.get(request.provider_name)
        if port is None:
            raise KeyError("requested metadata-lookup capability is not assembled")
        return self._scan_provider(
            provider_name=request.provider_name,
            scan_limit=request.scan_limit,
            open_session=lambda: port.open_lookup(request.key),
            cancel_event=cancel_event,
        )

    def query_references(
        self,
        request: MetadataReferenceQueryRequest,
    ) -> MetadataBatchResult:
        if not isinstance(request, MetadataReferenceQueryRequest):
            raise TypeError("request must be a MetadataReferenceQueryRequest")
        results: list[MetadataProviderResult] = []
        for provider_query in request.providers:
            results.append(
                _completed_result(
                    self.query_references_provider(
                        request.model_copy(update={"providers": (provider_query,)}),
                        cancel_event=None,
                    )
                )
            )
        return MetadataBatchResult(providers=tuple(results))

    def query_references_provider(
        self,
        request: MetadataReferenceQueryRequest,
        *,
        cancel_event: CancellationEvent | None = None,
    ) -> MetadataProviderInvocation:
        if not isinstance(request, MetadataReferenceQueryRequest):
            raise TypeError("request must be a MetadataReferenceQueryRequest")
        if len(request.providers) != 1:
            raise ValueError("provider invocation requires exactly one provider")
        _validate_cancel_event(cancel_event)
        provider_query = request.providers[0]
        port = self._reference_query_ports.get(provider_query.provider_name)
        if port is None:
            raise KeyError("requested reference-query capability is not assembled")
        context = ReferenceQueryContext(
            keys=provider_query.keys,
            direction=request.direction,
        )
        return self._scan_provider(
            provider_name=provider_query.provider_name,
            scan_limit=provider_query.scan_limit,
            open_session=lambda: port.open_reference_query(context),
            reference_query=context,
            cancel_event=cancel_event,
        )

    def _scan_provider(  # noqa: C901
        self,
        *,
        provider_name: str,
        scan_limit: int,
        open_session: Callable[[], RawItemSession],
        reference_query: ReferenceQueryContext | None = None,
        cancel_event: CancellationEvent | None = None,
    ) -> MetadataProviderInvocation:
        raw_item_count = 0
        observations: list[MetadataObservation] = []
        relations: list[ProviderRelationObservation] = []
        try:
            if _cancelled(cancel_event):
                return _provider_invocation(
                    provider_name=provider_name,
                    observations=observations,
                    relations=relations,
                    raw_item_count=raw_item_count,
                    outcome="INTERRUPTED",
                )
            session = open_session()
            if not isinstance(session, RawItemSession):
                raise TypeError("provider capability must return a RawItemSession")
            while True:
                # ``pull_raw_item`` is the lazy boundary that may fetch a new
                # provider page.  Never cross it after cancellation.
                if _cancelled(cancel_event):
                    return _provider_invocation(
                        provider_name=provider_name,
                        observations=observations,
                        relations=relations,
                        raw_item_count=raw_item_count,
                        outcome="INTERRUPTED",
                    )
                delivery = session.pull_raw_item()
                if delivery is None:
                    return _provider_invocation(
                        provider_name=provider_name,
                        observations=observations,
                        relations=relations,
                        raw_item_count=raw_item_count,
                        outcome="EXHAUSTED",
                    )
                if not isinstance(delivery, RawItemDelivery):
                    raise TypeError("raw item session returned an invalid delivery")

                # The raw item consumes its provider-wide budget before any
                # vendor-to-neutral conversion, acceptance, or deduplication.
                raw_item_count += 1
                item = session.convert_raw_item(delivery.raw_item)
                if not isinstance(item, NeutralMetadataItem):
                    raise TypeError("raw item conversion must return NeutralMetadataItem")
                if reference_query is not None and any(
                    not relation_matches_query(relation, reference_query)
                    for relation in item.relations
                ):
                    raise MetadataProviderFailure(_reference_direction_failure())
                observations.extend(item.observations)
                relations.extend(item.relations)

                # Preserve the converted neutral facts while returning control
                # before another item/page is requested.
                if _cancelled(cancel_event):
                    return _provider_invocation(
                        provider_name=provider_name,
                        observations=observations,
                        relations=relations,
                        raw_item_count=raw_item_count,
                        outcome="INTERRUPTED",
                    )

                if delivery.source_exhausted_after:
                    return _provider_invocation(
                        provider_name=provider_name,
                        observations=observations,
                        relations=relations,
                        raw_item_count=raw_item_count,
                        outcome="EXHAUSTED",
                    )
                if raw_item_count == scan_limit:
                    return _provider_invocation(
                        provider_name=provider_name,
                        observations=observations,
                        relations=relations,
                        raw_item_count=raw_item_count,
                        outcome="SCAN_LIMIT_REACHED",
                    )
        except MetadataProviderFailure as error:
            return _provider_invocation(
                provider_name=provider_name,
                observations=observations,
                relations=relations,
                raw_item_count=raw_item_count,
                outcome="FAILED",
                failure=error.failure,
            )


def _provider_invocation(
    *,
    provider_name: str,
    observations: list[MetadataObservation],
    relations: list[ProviderRelationObservation],
    raw_item_count: int,
    outcome: MetadataProviderInvocationOutcome,
    failure: StableFailure | None = None,
) -> MetadataProviderInvocation:
    return MetadataProviderInvocation(
        provider_name=provider_name,
        observations=tuple(observations),
        relations=tuple(relations),
        raw_item_count=raw_item_count,
        outcome=outcome,
        failure=failure,
    )


def _completed_result(invocation: MetadataProviderInvocation) -> MetadataProviderResult:
    if invocation.outcome == "INTERRUPTED":
        raise RuntimeError("uncancellable metadata call returned an interruption")
    return MetadataProviderResult.model_validate(invocation.model_dump())


def _validate_cancel_event(cancel_event: CancellationEvent | None) -> None:
    if cancel_event is not None and not isinstance(cancel_event, CancellationEvent):
        raise TypeError("cancel_event must expose is_set")


def _cancelled(cancel_event: CancellationEvent | None) -> bool:
    return cancel_event is not None and cancel_event.is_set()


def _port_name(value: object) -> str:
    if not isinstance(value, str):
        raise TypeError("provider_name must be a string")
    normalized = unicodedata.normalize("NFC", value.strip())
    if not normalized:
        raise ValueError("provider_name must be nonblank")
    return normalized


def _index_topic_ports(values: Iterable[TopicSearchPort]) -> dict[str, TopicSearchPort]:
    result: dict[str, TopicSearchPort] = {}
    for value in values:
        if not isinstance(value, TopicSearchPort):
            raise TypeError("topic_search_ports must contain TopicSearchPort values")
        name = _port_name(value.provider_name)
        if name in result:
            raise ValueError("topic_search_ports must have unique provider names")
        result[name] = value
    return result


def _index_lookup_ports(values: Iterable[MetadataLookupPort]) -> dict[str, MetadataLookupPort]:
    result: dict[str, MetadataLookupPort] = {}
    for value in values:
        if not isinstance(value, MetadataLookupPort):
            raise TypeError("lookup_ports must contain MetadataLookupPort values")
        name = _port_name(value.provider_name)
        if name in result:
            raise ValueError("lookup_ports must have unique provider names")
        result[name] = value
    return result


def _index_reference_ports(
    values: Iterable[ReferenceQueryPort],
) -> dict[str, ReferenceQueryPort]:
    result: dict[str, ReferenceQueryPort] = {}
    for value in values:
        if not isinstance(value, ReferenceQueryPort):
            raise TypeError("reference_query_ports must contain ReferenceQueryPort values")
        name = _port_name(value.provider_name)
        if name in result:
            raise ValueError("reference_query_ports must have unique provider names")
        result[name] = value
    return result


__all__ = ("MetadataService",)
