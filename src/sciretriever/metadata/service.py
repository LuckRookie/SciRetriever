"""Neutral Metadata capability orchestration and raw-item scan semantics."""

from __future__ import annotations

import time
import unicodedata
from collections.abc import Callable, Iterable

from sciretriever.logging.api import get_logger
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

_LOGGER = get_logger(__name__)


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
        started_ns = time.monotonic_ns()
        raw_item_count = 0
        observations: list[MetadataObservation] = []
        relations: list[ProviderRelationObservation] = []
        first_record_failure: StableFailure | None = None
        accepted_item_count = 0
        empty_item_count = 0
        rejected_record_count = 0
        _LOGGER.info(
            "event=metadata-provider-started provider=%s scan_limit=%d",
            provider_name,
            scan_limit,
        )
        try:
            if _cancelled(cancel_event):
                return _logged_provider_invocation(
                    provider_name=provider_name,
                    observations=observations,
                    relations=relations,
                    raw_item_count=raw_item_count,
                    outcome="INTERRUPTED",
                    accepted_item_count=accepted_item_count,
                    empty_item_count=empty_item_count,
                    rejected_record_count=rejected_record_count,
                    started_ns=started_ns,
                )
            session = open_session()
            if not isinstance(session, RawItemSession):
                raise TypeError("provider capability must return a RawItemSession")
            while True:
                # ``pull_raw_item`` is the lazy boundary that may fetch a new
                # provider page.  Never cross it after cancellation.
                if _cancelled(cancel_event):
                    return _logged_provider_invocation(
                        provider_name=provider_name,
                        observations=observations,
                        relations=relations,
                        raw_item_count=raw_item_count,
                        outcome="INTERRUPTED",
                        accepted_item_count=accepted_item_count,
                        empty_item_count=empty_item_count,
                        rejected_record_count=rejected_record_count,
                        started_ns=started_ns,
                    )
                delivery = session.pull_raw_item()
                if delivery is None:
                    return _completed_scan_invocation(
                        provider_name=provider_name,
                        observations=observations,
                        relations=relations,
                        raw_item_count=raw_item_count,
                        normal_outcome="EXHAUSTED",
                        record_failure=first_record_failure,
                        accepted_item_count=accepted_item_count,
                        empty_item_count=empty_item_count,
                        rejected_record_count=rejected_record_count,
                        started_ns=started_ns,
                    )
                if not isinstance(delivery, RawItemDelivery):
                    raise TypeError("raw item session returned an invalid delivery")

                # The raw item consumes its provider-wide budget before any
                # vendor-to-neutral conversion, acceptance, or deduplication.
                raw_item_count += 1
                try:
                    item = session.convert_raw_item(delivery.raw_item)
                    if not isinstance(item, NeutralMetadataItem):
                        raise TypeError("raw item conversion must return NeutralMetadataItem")
                except MetadataProviderFailure as error:
                    rejected_record_count += 1
                    if first_record_failure is None:
                        first_record_failure = error.failure
                    _LOGGER.debug(
                        "event=metadata-record-rejected provider=%s raw_item_ordinal=%d "
                        "code=%s retryable=%s reason=%s action=%s",
                        provider_name,
                        raw_item_count,
                        error.failure.code,
                        str(error.failure.retryable).lower(),
                        error.failure.reason,
                        error.failure.action,
                    )
                    _log_item_disposition(
                        provider_name=provider_name,
                        raw_item_ordinal=raw_item_count,
                        disposition="rejected",
                        observation_delta=0,
                        relation_delta=0,
                        observation_count=len(observations),
                        relation_count=len(relations),
                        reason=error.failure.code,
                    )
                except Exception:
                    rejected_record_count += 1
                    _log_item_disposition(
                        provider_name=provider_name,
                        raw_item_ordinal=raw_item_count,
                        disposition="rejected",
                        observation_delta=0,
                        relation_delta=0,
                        observation_count=len(observations),
                        relation_count=len(relations),
                        reason="unexpected-conversion-error",
                    )
                    raise
                else:
                    if reference_query is not None and any(
                        not relation_matches_query(relation, reference_query)
                        for relation in item.relations
                    ):
                        rejected_record_count += 1
                        failure = _reference_direction_failure()
                        _log_item_disposition(
                            provider_name=provider_name,
                            raw_item_ordinal=raw_item_count,
                            disposition="rejected",
                            observation_delta=0,
                            relation_delta=0,
                            observation_count=len(observations),
                            relation_count=len(relations),
                            reason=failure.code,
                        )
                        raise MetadataProviderFailure(_reference_direction_failure())
                    observation_delta = len(item.observations)
                    relation_delta = len(item.relations)
                    observations.extend(item.observations)
                    relations.extend(item.relations)
                    nonempty = observation_delta > 0 or relation_delta > 0
                    if nonempty:
                        accepted_item_count += 1
                    else:
                        empty_item_count += 1
                    _log_item_disposition(
                        provider_name=provider_name,
                        raw_item_ordinal=raw_item_count,
                        disposition="accepted" if nonempty else "empty",
                        observation_delta=observation_delta,
                        relation_delta=relation_delta,
                        observation_count=len(observations),
                        relation_count=len(relations),
                        reason=(
                            "neutral-facts-produced"
                            if nonempty
                            else item.empty_reason or "no-neutral-facts"
                        ),
                    )

                # Preserve the converted neutral facts while returning control
                # before another item/page is requested.
                if _cancelled(cancel_event):
                    return _logged_provider_invocation(
                        provider_name=provider_name,
                        observations=observations,
                        relations=relations,
                        raw_item_count=raw_item_count,
                        outcome="INTERRUPTED",
                        accepted_item_count=accepted_item_count,
                        empty_item_count=empty_item_count,
                        rejected_record_count=rejected_record_count,
                        started_ns=started_ns,
                    )

                if delivery.source_exhausted_after:
                    return _completed_scan_invocation(
                        provider_name=provider_name,
                        observations=observations,
                        relations=relations,
                        raw_item_count=raw_item_count,
                        normal_outcome="EXHAUSTED",
                        record_failure=first_record_failure,
                        accepted_item_count=accepted_item_count,
                        empty_item_count=empty_item_count,
                        rejected_record_count=rejected_record_count,
                        started_ns=started_ns,
                    )
                if raw_item_count == scan_limit:
                    return _completed_scan_invocation(
                        provider_name=provider_name,
                        observations=observations,
                        relations=relations,
                        raw_item_count=raw_item_count,
                        normal_outcome="SCAN_LIMIT_REACHED",
                        record_failure=first_record_failure,
                        accepted_item_count=accepted_item_count,
                        empty_item_count=empty_item_count,
                        rejected_record_count=rejected_record_count,
                        started_ns=started_ns,
                    )
        except MetadataProviderFailure as error:
            return _logged_provider_invocation(
                provider_name=provider_name,
                observations=observations,
                relations=relations,
                raw_item_count=raw_item_count,
                outcome="FAILED",
                failure=error.failure,
                accepted_item_count=accepted_item_count,
                empty_item_count=empty_item_count,
                rejected_record_count=rejected_record_count,
                started_ns=started_ns,
            )
        except Exception:
            _LOGGER.error(
                "event=metadata-provider-crashed provider=%s raw_item_count=%d "
                "accepted_item_count=%d empty_item_count=%d rejected_record_count=%d "
                "elapsed_ms=%d code=metadata-provider-unexpected",
                provider_name,
                raw_item_count,
                accepted_item_count,
                empty_item_count,
                rejected_record_count,
                _elapsed_ms(started_ns),
            )
            raise


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


def _logged_provider_invocation(
    *,
    provider_name: str,
    observations: list[MetadataObservation],
    relations: list[ProviderRelationObservation],
    raw_item_count: int,
    outcome: MetadataProviderInvocationOutcome,
    failure: StableFailure | None = None,
    accepted_item_count: int = 0,
    empty_item_count: int = 0,
    rejected_record_count: int = 0,
    started_ns: int,
) -> MetadataProviderInvocation:
    result = _provider_invocation(
        provider_name=provider_name,
        observations=observations,
        relations=relations,
        raw_item_count=raw_item_count,
        outcome=outcome,
        failure=failure,
    )
    if failure is not None:
        _LOGGER.warning(
            "event=metadata-provider-failed provider=%s raw_item_count=%d "
            "accepted_item_count=%d empty_item_count=%d rejected_record_count=%d "
            "observation_count=%d relation_count=%d elapsed_ms=%d code=%s retryable=%s "
            "reason=%s action=%s",
            provider_name,
            raw_item_count,
            accepted_item_count,
            empty_item_count,
            rejected_record_count,
            len(observations),
            len(relations),
            _elapsed_ms(started_ns),
            failure.code,
            str(failure.retryable).lower(),
            failure.reason,
            failure.action,
        )
    else:
        _LOGGER.info(
            "event=metadata-provider-finished provider=%s outcome=%s "
            "raw_item_count=%d accepted_item_count=%d empty_item_count=%d "
            "rejected_record_count=%d observation_count=%d relation_count=%d elapsed_ms=%d",
            provider_name,
            outcome,
            raw_item_count,
            accepted_item_count,
            empty_item_count,
            rejected_record_count,
            len(observations),
            len(relations),
            _elapsed_ms(started_ns),
        )
    return result


def _completed_scan_invocation(
    *,
    provider_name: str,
    observations: list[MetadataObservation],
    relations: list[ProviderRelationObservation],
    raw_item_count: int,
    normal_outcome: MetadataProviderInvocationOutcome,
    record_failure: StableFailure | None,
    accepted_item_count: int,
    empty_item_count: int,
    rejected_record_count: int,
    started_ns: int,
) -> MetadataProviderInvocation:
    """Finish a complete scan without erasing isolated record failures."""

    return _logged_provider_invocation(
        provider_name=provider_name,
        observations=observations,
        relations=relations,
        raw_item_count=raw_item_count,
        outcome="FAILED" if record_failure is not None else normal_outcome,
        failure=record_failure,
        accepted_item_count=accepted_item_count,
        empty_item_count=empty_item_count,
        rejected_record_count=rejected_record_count,
        started_ns=started_ns,
    )


def _log_item_disposition(
    *,
    provider_name: str,
    raw_item_ordinal: int,
    disposition: str,
    observation_delta: int,
    relation_delta: int,
    observation_count: int,
    relation_count: int,
    reason: str,
) -> None:
    _LOGGER.debug(
        "event=metadata-item-disposition provider=%s raw_item_ordinal=%d "
        "disposition=%s observation_delta=%d relation_delta=%d "
        "observation_count=%d relation_count=%d reason=%s",
        provider_name,
        raw_item_ordinal,
        disposition,
        observation_delta,
        relation_delta,
        observation_count,
        relation_count,
        reason,
    )


def _elapsed_ms(started_ns: int) -> int:
    return max(0, (time.monotonic_ns() - started_ns) // 1_000_000)


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
