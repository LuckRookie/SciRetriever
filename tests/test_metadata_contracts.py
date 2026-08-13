from __future__ import annotations

import asyncio
import json
import unittest
from collections.abc import Callable
from dataclasses import dataclass
from typing import cast

from pydantic import ValidationError

import sciretriever.metadata.ports as metadata_ports
from sciretriever.metadata.api import (
    MetadataApi,
    MetadataProviderInvocation,
)
from sciretriever.metadata.ports import (
    MetadataLookupPort,
    MetadataProviderFailure,
    RawItemSession,
    ReferenceQueryPort,
    TopicSearchPort,
)
from sciretriever.metadata.rules import (
    MetadataBatchResult,
    MetadataLookupRequest,
    MetadataProviderResult,
    MetadataReferenceQueryRequest,
    NeutralMetadataItem,
    ProviderReferenceQuery,
    ReferenceQueryContext,
)
from sciretriever.metadata.service import MetadataService
from sciretriever.model.discovery import ProviderDiscoveryLimit, TopicDiscoveryInput
from sciretriever.model.literature import Identifier
from sciretriever.model.metadata import (
    LiteratureMetadata,
    MetadataObservation,
    ProviderLiteratureKey,
    ProviderRelationObservation,
)
from sciretriever.model.primitives import (
    ObservationId,
    ProvenanceId,
    Sha256,
    SourceKind,
    UtcTimestamp,
)
from sciretriever.model.provenance import Provenance
from sciretriever.model.report import StableFailure

_TIME = UtcTimestamp("2026-08-11T12:00:00Z")
_HASH = Sha256("a" * 64)


def _id(index: int) -> str:
    return f"{index:08x}-e89b-12d3-a456-426614174000"


def _failure(*, code: str = "provider-unavailable") -> StableFailure:
    return StableFailure(
        code=code,
        reason="The metadata provider could not complete the request.",
        action="Retry the metadata request.",
        retryable=True,
    )


def _key(value: str) -> ProviderLiteratureKey:
    return ProviderLiteratureKey(identifiers=(Identifier(namespace="doi", value=value),))


def _observation(
    index: int,
    *,
    title: str | None = "A study",
    doi: str | None = None,
    source_name: str = "fake",
) -> MetadataObservation:
    identifiers = () if doi is None else (Identifier(namespace="doi", value=doi),)
    return MetadataObservation(
        observation_id=ObservationId(_id(index)),
        provenance=Provenance(
            provenance_id=ProvenanceId(_id(index + 1000)),
            source_kind=SourceKind.METADATA_PROVIDER,
            source_name=source_name,
            source_record_id=f"record-{index}",
            observed_at=_TIME,
            input_sha256=_HASH,
            parameters_sha256=None,
        ),
        metadata=LiteratureMetadata(title=title, identifiers=identifiers),
    )


def _relation(
    index: int,
    *,
    citing: ProviderLiteratureKey,
    cited: ProviderLiteratureKey,
    source_name: str = "fake",
) -> ProviderRelationObservation:
    return ProviderRelationObservation(
        observation_id=ObservationId(_id(index)),
        provenance=Provenance(
            provenance_id=ProvenanceId(_id(index + 1000)),
            source_kind=SourceKind.METADATA_PROVIDER,
            source_name=source_name,
            source_record_id=f"relation-{index}",
            observed_at=_TIME,
            input_sha256=_HASH,
            parameters_sha256=None,
        ),
        citing=citing,
        cited=cited,
    )


@dataclass(frozen=True, slots=True)
class _VendorItem:
    index: int
    title: str | None = "A study"
    doi: str | None = None
    secret_response_marker: str = "vendor-response-must-not-leak"
    score: float = 0.99


def _pages(
    pages: dict[str | None, metadata_ports._RawPage[_VendorItem, str]],
    converter: Callable[[_VendorItem], NeutralMetadataItem],
    *,
    fetched: list[str | None] | None = None,
) -> RawItemSession:
    def fetch(cursor: str | None) -> metadata_ports._RawPage[_VendorItem, str]:
        if fetched is not None:
            fetched.append(cursor)
        return pages[cursor]

    return metadata_ports._PagedRawItemSession(fetch, converter)


class _TopicFake:
    def __init__(
        self,
        provider_name: str,
        open_session: Callable[[], RawItemSession],
        calls: list[object] | None = None,
    ) -> None:
        self.provider_name = provider_name
        self._open_session = open_session
        self._calls = calls

    def open_topic_search(self, query: object) -> RawItemSession:
        if self._calls is not None:
            self._calls.append(query)
        return self._open_session()


class _LookupFake:
    def __init__(
        self,
        provider_name: str,
        open_session: Callable[[], RawItemSession],
        calls: list[ProviderLiteratureKey] | None = None,
    ) -> None:
        self.provider_name = provider_name
        self._open_session = open_session
        self._calls = calls

    def open_lookup(self, key: ProviderLiteratureKey) -> RawItemSession:
        if self._calls is not None:
            self._calls.append(key)
        return self._open_session()


class _ReferenceFake:
    def __init__(
        self,
        provider_name: str,
        open_session: Callable[[], RawItemSession],
        calls: list[object] | None = None,
    ) -> None:
        self.provider_name = provider_name
        self._open_session = open_session
        self._calls = calls

    def open_reference_query(self, query: object) -> RawItemSession:
        if self._calls is not None:
            self._calls.append(query)
        return self._open_session()


class _Event:
    def __init__(self, value: bool = False) -> None:
        self.value = value

    def is_set(self) -> bool:
        return self.value


def _topic_request(
    *providers: tuple[str, int],
) -> TopicDiscoveryInput:
    return TopicDiscoveryInput(
        kind="topic",
        query="quantum materials",
        providers=tuple(
            ProviderDiscoveryLimit(provider_name=name, scan_limit=limit)
            for name, limit in providers
        ),
    )


def _nested_keys(value: object) -> set[str]:
    if isinstance(value, dict):
        result = {str(key) for key in value}
        for nested in value.values():
            result.update(_nested_keys(nested))
        return result
    if isinstance(value, list):
        result: set[str] = set()
        for nested in value:
            result.update(_nested_keys(nested))
        return result
    return set()


class MetadataCapabilityContractTests(unittest.TestCase):
    def test_three_capabilities_are_independent_runtime_protocols(self) -> None:
        empty = lambda: _pages(  # noqa: E731 - compact capability fixture
            {None: metadata_ports._RawPage(items=(), next_cursor=None, exhausted=True)},
            lambda _raw: NeutralMetadataItem(),
        )
        topic = _TopicFake("topic", empty)
        lookup = _LookupFake("lookup", empty)
        reference = _ReferenceFake("reference", empty)

        self.assertIsInstance(topic, TopicSearchPort)
        self.assertNotIsInstance(topic, MetadataLookupPort)
        self.assertNotIsInstance(topic, ReferenceQueryPort)
        self.assertIsInstance(lookup, MetadataLookupPort)
        self.assertNotIsInstance(lookup, TopicSearchPort)
        self.assertNotIsInstance(lookup, ReferenceQueryPort)
        self.assertIsInstance(reference, ReferenceQueryPort)
        self.assertNotIsInstance(reference, TopicSearchPort)
        self.assertNotIsInstance(reference, MetadataLookupPort)

        for forbidden in ("MetadataProvider", "CitationProvider", "PdfProvider"):
            self.assertFalse(hasattr(metadata_ports, forbidden))

    def test_topic_scan_reaches_limit_mid_third_page_without_pulling_or_converting_n_plus_one(
        self,
    ) -> None:
        fetched: list[str | None] = []
        converted: list[int] = []

        def convert(raw: _VendorItem) -> NeutralMetadataItem:
            converted.append(raw.index)
            return NeutralMetadataItem(observations=(_observation(raw.index),))

        pages = {
            None: metadata_ports._RawPage(
                items=(_VendorItem(1), _VendorItem(2)),
                next_cursor="page-2-secret-cursor",
                exhausted=False,
            ),
            "page-2-secret-cursor": metadata_ports._RawPage(
                items=(_VendorItem(3), _VendorItem(4)),
                next_cursor="page-3-secret-cursor",
                exhausted=False,
            ),
            "page-3-secret-cursor": metadata_ports._RawPage(
                items=(_VendorItem(5), _VendorItem(6)),
                next_cursor="page-4-must-not-be-fetched",
                exhausted=False,
            ),
        }
        provider = _TopicFake(
            "fake",
            lambda: _pages(pages, convert, fetched=fetched),
        )
        api = MetadataApi(MetadataService(topic_search_ports=(provider,)))

        batch = api.search_topic(_topic_request(("fake", 5)))

        result = batch.providers[0]
        self.assertEqual(result.outcome, "SCAN_LIMIT_REACHED")
        self.assertEqual(result.raw_item_count, 5)
        self.assertEqual(converted, [1, 2, 3, 4, 5])
        self.assertEqual(
            fetched,
            [None, "page-2-secret-cursor", "page-3-secret-cursor"],
        )
        self.assertEqual(
            tuple(item.observation_id for item in result.observations),
            tuple(ObservationId(_id(index)) for index in range(1, 6)),
        )

    def test_topic_provider_cancellation_after_conversion_keeps_partial_facts_and_page_lazy(
        self,
    ) -> None:
        event = _Event()
        fetched: list[str | None] = []
        converted: list[int] = []

        def convert(raw: _VendorItem) -> NeutralMetadataItem:
            converted.append(raw.index)
            event.value = True
            return NeutralMetadataItem(observations=(_observation(raw.index),))

        provider = _TopicFake(
            "fake",
            lambda: _pages(
                {
                    None: metadata_ports._RawPage(
                        items=(_VendorItem(1),),
                        next_cursor="page-2-must-not-be-fetched",
                        exhausted=False,
                    ),
                    "page-2-must-not-be-fetched": metadata_ports._RawPage(
                        items=(_VendorItem(2),),
                        next_cursor=None,
                        exhausted=True,
                    ),
                },
                convert,
                fetched=fetched,
            ),
        )
        api = MetadataApi(MetadataService(topic_search_ports=(provider,)))

        result = api.search_topic_provider(
            _topic_request(("fake", 10)),
            cancel_event=event,
        )

        self.assertIsInstance(result, MetadataProviderInvocation)
        self.assertEqual(result.outcome, "INTERRUPTED")
        self.assertEqual(result.raw_item_count, 1)
        self.assertEqual(result.observations, (_observation(1),))
        self.assertEqual(converted, [1])
        self.assertEqual(fetched, [None])
        self.assertIsNone(result.failure)
        self.assertFalse(
            set(MetadataProviderInvocation.model_fields)
            & {"cancel_event", "cursor", "page", "state"}
        )

    def test_exact_limit_uses_actual_truncation_not_a_fourth_outcome(self) -> None:
        cases = (
            (
                "known-exhausted",
                metadata_ports._RawPage(
                    items=(_VendorItem(1), _VendorItem(2)),
                    next_cursor=None,
                    exhausted=True,
                ),
                "EXHAUSTED",
            ),
            (
                "unproven-exhaustion",
                metadata_ports._RawPage(
                    items=(_VendorItem(1), _VendorItem(2)),
                    next_cursor="unfetched-next-page",
                    exhausted=False,
                ),
                "SCAN_LIMIT_REACHED",
            ),
        )
        for name, page, expected in cases:
            with self.subTest(name=name):
                fetched: list[str | None] = []
                provider = _TopicFake(
                    "fake",
                    lambda page=page: _pages(
                        {None: page},
                        lambda raw: NeutralMetadataItem(observations=(_observation(raw.index),)),
                        fetched=fetched,
                    ),
                )
                result = (
                    MetadataApi(MetadataService(topic_search_ports=(provider,)))
                    .search_topic(_topic_request(("fake", 2)))
                    .providers[0]
                )
                self.assertEqual(result.raw_item_count, 2)
                self.assertEqual(result.outcome, expected)
                self.assertEqual(fetched, [None])

    def test_budget_is_consumed_before_conversion_failure_and_prior_items_survive(self) -> None:
        events: list[str] = []

        def convert(raw: _VendorItem) -> NeutralMetadataItem:
            events.append(f"convert-{raw.index}")
            if raw.index == 2:
                raise MetadataProviderFailure(_failure(code="item-conversion-failed"))
            return NeutralMetadataItem(observations=(_observation(raw.index),))

        provider = _TopicFake(
            "fake",
            lambda: _pages(
                {
                    None: metadata_ports._RawPage(
                        items=(_VendorItem(1), _VendorItem(2), _VendorItem(3)),
                        next_cursor=None,
                        exhausted=True,
                    )
                },
                convert,
            ),
        )

        result = (
            MetadataApi(MetadataService(topic_search_ports=(provider,)))
            .search_topic(_topic_request(("fake", 10)))
            .providers[0]
        )

        self.assertEqual(events, ["convert-1", "convert-2"])
        self.assertEqual(result.raw_item_count, 2)
        self.assertEqual(result.outcome, "FAILED")
        self.assertEqual(result.failure, _failure(code="item-conversion-failed"))
        self.assertEqual(result.observations, (_observation(1),))

    def test_incomplete_and_duplicate_items_count_and_are_not_admitted_or_deduplicated(
        self,
    ) -> None:
        duplicate = _observation(1, title=None, doi=None)

        def convert(raw: _VendorItem) -> NeutralMetadataItem:
            if raw.index in {1, 2}:
                return NeutralMetadataItem(observations=(duplicate,))
            return NeutralMetadataItem(observations=(_observation(3, title=None, doi=None),))

        provider = _TopicFake(
            "fake",
            lambda: _pages(
                {
                    None: metadata_ports._RawPage(
                        items=(_VendorItem(1), _VendorItem(2), _VendorItem(3)),
                        next_cursor=None,
                        exhausted=True,
                    )
                },
                convert,
            ),
        )
        result = (
            MetadataApi(MetadataService(topic_search_ports=(provider,)))
            .search_topic(_topic_request(("fake", 10)))
            .providers[0]
        )

        self.assertEqual(result.raw_item_count, 3)
        self.assertEqual(result.observations, (duplicate, duplicate, _observation(3, title=None)))
        self.assertEqual(result.outcome, "EXHAUSTED")

    def test_second_page_fetch_failure_preserves_first_page(self) -> None:
        fetched: list[str | None] = []

        def fetch(cursor: str | None) -> metadata_ports._RawPage[_VendorItem, str]:
            fetched.append(cursor)
            if cursor is None:
                return metadata_ports._RawPage(
                    items=(_VendorItem(1),),
                    next_cursor="second-page",
                    exhausted=False,
                )
            raise MetadataProviderFailure(_failure(code="page-fetch-failed"))

        provider = _TopicFake(
            "fake",
            lambda: metadata_ports._PagedRawItemSession(
                fetch,
                lambda raw: NeutralMetadataItem(observations=(_observation(raw.index),)),
            ),
        )
        result = (
            MetadataApi(MetadataService(topic_search_ports=(provider,)))
            .search_topic(_topic_request(("fake", 10)))
            .providers[0]
        )

        self.assertEqual(fetched, [None, "second-page"])
        self.assertEqual(result.raw_item_count, 1)
        self.assertEqual(result.observations, (_observation(1),))
        self.assertEqual(result.outcome, "FAILED")
        self.assertEqual(result.failure, _failure(code="page-fetch-failed"))

    def test_zero_result_provider_is_exhausted(self) -> None:
        provider = _TopicFake(
            "fake",
            lambda: _pages(
                {None: metadata_ports._RawPage(items=(), next_cursor=None, exhausted=True)},
                lambda _raw: NeutralMetadataItem(),
            ),
        )
        result = (
            MetadataApi(MetadataService(topic_search_ports=(provider,)))
            .search_topic(_topic_request(("fake", 3)))
            .providers[0]
        )

        self.assertEqual(result.raw_item_count, 0)
        self.assertEqual(result.observations, ())
        self.assertEqual(result.relations, ())
        self.assertEqual(result.outcome, "EXHAUSTED")
        self.assertIsNone(result.failure)

    def test_multi_provider_partial_success_preserves_input_order_without_run_status(self) -> None:
        failing = _TopicFake(
            "failed-first",
            lambda: (_ for _ in ()).throw(MetadataProviderFailure(_failure())),
        )
        successful = _TopicFake(
            "successful-second",
            lambda: _pages(
                {
                    None: metadata_ports._RawPage(
                        items=(_VendorItem(2),),
                        next_cursor=None,
                        exhausted=True,
                    )
                },
                lambda raw: NeutralMetadataItem(observations=(_observation(raw.index),)),
            ),
        )
        batch = MetadataApi(MetadataService(topic_search_ports=(successful, failing))).search_topic(
            _topic_request(("failed-first", 3), ("successful-second", 3))
        )

        self.assertEqual(
            tuple(result.provider_name for result in batch.providers),
            ("failed-first", "successful-second"),
        )
        self.assertEqual(
            tuple(result.outcome for result in batch.providers),
            ("FAILED", "EXHAUSTED"),
        )
        self.assertEqual(batch.providers[1].observations, (_observation(2),))
        self.assertNotIn("run_status", MetadataBatchResult.model_fields)
        self.assertNotIn("partial", MetadataBatchResult.model_fields)

    def test_expected_failure_is_paired_and_does_not_serialize_raw_cause(self) -> None:
        secret = "Bearer top-secret-provider-token"

        def fail_safely() -> RawItemSession:
            try:
                raise RuntimeError(secret)
            except RuntimeError as cause:
                raise MetadataProviderFailure(_failure(code="provider-protocol-failed")) from cause

        provider = _TopicFake("fake", fail_safely)
        result = (
            MetadataApi(MetadataService(topic_search_ports=(provider,)))
            .search_topic(_topic_request(("fake", 1)))
            .providers[0]
        )

        self.assertEqual(result.outcome, "FAILED")
        self.assertNotIn(secret, result.model_dump_json())
        with self.assertRaises(ValidationError):
            MetadataProviderResult(
                provider_name="fake",
                observations=(),
                relations=(),
                raw_item_count=0,
                outcome="FAILED",
                failure=None,
            )
        with self.assertRaises(ValidationError):
            MetadataProviderResult(
                provider_name="fake",
                observations=(),
                relations=(),
                raw_item_count=0,
                outcome="EXHAUSTED",
                failure=_failure(),
            )

    def test_cursor_response_vendor_object_and_score_never_enter_result(self) -> None:
        raw = _VendorItem(1)
        provider = _TopicFake(
            "fake",
            lambda: _pages(
                {
                    None: metadata_ports._RawPage(
                        items=(raw,),
                        next_cursor="secret-cursor",
                        exhausted=False,
                    )
                },
                lambda item: NeutralMetadataItem(observations=(_observation(item.index),)),
            ),
        )
        result = (
            MetadataApi(MetadataService(topic_search_ports=(provider,)))
            .search_topic(_topic_request(("fake", 1)))
            .providers[0]
        )
        payload = result.model_dump_json()

        for forbidden in ("secret-cursor", raw.secret_response_marker):
            self.assertNotIn(forbidden, payload)
        payload_keys = _nested_keys(json.loads(payload))
        self.assertFalse(payload_keys & {"score", "request", "response", "page", "cursor"})
        self.assertEqual(
            set(MetadataProviderResult.model_fields),
            {
                "provider_name",
                "observations",
                "relations",
                "raw_item_count",
                "outcome",
                "failure",
            },
        )

    def test_repeated_cursor_and_empty_nonterminal_page_are_stable_failures(self) -> None:
        repeated_pages: dict[str | None, metadata_ports._RawPage[_VendorItem, str]] = {
            None: metadata_ports._RawPage(
                items=(_VendorItem(1),),
                next_cursor="same",
                exhausted=False,
            ),
            "same": metadata_ports._RawPage(
                items=(_VendorItem(2),),
                next_cursor="same",
                exhausted=False,
            ),
        }
        empty_pages: dict[str | None, metadata_ports._RawPage[_VendorItem, str]] = {
            None: metadata_ports._RawPage(
                items=(),
                next_cursor="still-more",
                exhausted=False,
            )
        }
        for name, pages, expected_count in (
            ("repeated", repeated_pages, 1),
            ("empty", empty_pages, 0),
        ):
            with self.subTest(name=name):
                provider = _TopicFake(
                    name,
                    lambda pages=pages: _pages(
                        pages,
                        lambda raw: NeutralMetadataItem(observations=(_observation(raw.index),)),
                    ),
                )
                result = (
                    MetadataApi(MetadataService(topic_search_ports=(provider,)))
                    .search_topic(_topic_request((name, 10)))
                    .providers[0]
                )
                self.assertEqual(result.outcome, "FAILED")
                self.assertEqual(result.raw_item_count, expected_count)
                assert result.failure is not None
                self.assertEqual(result.failure.code, "metadata-pagination-loop")

    def test_programming_error_and_controlled_cancellation_propagate(self) -> None:
        def programming_failure(_raw: _VendorItem) -> NeutralMetadataItem:
            raise RuntimeError("consumer bug")

        programming_provider = _TopicFake(
            "programming",
            lambda: _pages(
                {
                    None: metadata_ports._RawPage(
                        items=(_VendorItem(1),),
                        next_cursor=None,
                        exhausted=True,
                    )
                },
                programming_failure,
            ),
        )
        with self.assertRaisesRegex(RuntimeError, "consumer bug"):
            MetadataApi(MetadataService(topic_search_ports=(programming_provider,))).search_topic(
                _topic_request(("programming", 1))
            )

        cancellation_provider = _TopicFake(
            "cancelled",
            lambda: cast(
                RawItemSession,
                (_ for _ in ()).throw(asyncio.CancelledError()),
            ),
        )
        with self.assertRaises(asyncio.CancelledError):
            MetadataApi(MetadataService(topic_search_ports=(cancellation_provider,))).search_topic(
                _topic_request(("cancelled", 1))
            )


class MetadataLookupAndReferenceTests(unittest.TestCase):
    def test_lookup_calls_only_the_explicit_provider(self) -> None:
        first_calls: list[ProviderLiteratureKey] = []
        second_calls: list[ProviderLiteratureKey] = []
        key = _key("10.1000/lookup")

        def empty() -> RawItemSession:
            return _pages(
                {None: metadata_ports._RawPage(items=(), next_cursor=None, exhausted=True)},
                lambda _raw: NeutralMetadataItem(),
            )

        first = _LookupFake("first", empty, first_calls)
        second = _LookupFake("second", empty, second_calls)
        api = MetadataApi(MetadataService(lookup_ports=(first, second)))

        result = api.lookup(MetadataLookupRequest(provider_name="second", key=key, scan_limit=2))

        self.assertEqual(result.provider_name, "second")
        self.assertEqual(first_calls, [])
        self.assertEqual(second_calls, [key])

    def test_lookup_provider_cancellation_returns_converted_partial_observation(self) -> None:
        event = _Event()

        def convert(raw: _VendorItem) -> NeutralMetadataItem:
            event.value = True
            return NeutralMetadataItem(observations=(_observation(raw.index),))

        provider = _LookupFake(
            "fake",
            lambda: _pages(
                {
                    None: metadata_ports._RawPage(
                        items=(_VendorItem(1), _VendorItem(2)),
                        next_cursor=None,
                        exhausted=True,
                    )
                },
                convert,
            ),
        )
        api = MetadataApi(MetadataService(lookup_ports=(provider,)))

        result = api.lookup_provider(
            MetadataLookupRequest(provider_name="fake", key=_key("10.1000/lookup"), scan_limit=2),
            cancel_event=event,
        )

        self.assertEqual(result.outcome, "INTERRUPTED")
        self.assertEqual(result.raw_item_count, 1)
        self.assertEqual(result.observations, (_observation(1),))

    def test_reference_keys_and_both_directions_share_one_provider_scan_budget(self) -> None:
        first = _key("10.1000/first")
        second = _key("10.1000/second")
        calls: list[object] = []
        converted: list[int] = []

        def convert(raw: _VendorItem) -> NeutralMetadataItem:
            converted.append(raw.index)
            return NeutralMetadataItem()

        provider = _ReferenceFake(
            "fake",
            lambda: _pages(
                {
                    None: metadata_ports._RawPage(
                        items=(_VendorItem(1), _VendorItem(2), _VendorItem(3)),
                        next_cursor="must-not-be-fetched",
                        exhausted=False,
                    )
                },
                convert,
            ),
            calls,
        )
        result = (
            MetadataApi(MetadataService(reference_query_ports=(provider,)))
            .query_references(
                MetadataReferenceQueryRequest(
                    direction="both",
                    providers=(
                        ProviderReferenceQuery(
                            provider_name="fake",
                            keys=(first, second),
                            scan_limit=2,
                        ),
                    ),
                )
            )
            .providers[0]
        )

        self.assertEqual(result.outcome, "SCAN_LIMIT_REACHED")
        self.assertEqual(result.raw_item_count, 2)
        self.assertEqual(converted, [1, 2])
        self.assertEqual(len(calls), 1)
        context = cast(ReferenceQueryContext, calls[0])
        self.assertEqual(context.keys, (first, second))
        self.assertEqual(context.direction, "both")
        self.assertFalse(
            set(ReferenceQueryContext.model_fields)
            & {"max_depth", "result_limit", "cursor", "page"}
        )

    def test_reference_provider_cancellation_returns_converted_partial_relation(self) -> None:
        anchor = _key("10.1000/anchor")
        related = _key("10.1000/related")
        relation = _relation(10, citing=anchor, cited=related)
        event = _Event()

        def convert(_raw: _VendorItem) -> NeutralMetadataItem:
            event.value = True
            return NeutralMetadataItem(relations=(relation,))

        provider = _ReferenceFake(
            "fake",
            lambda: _pages(
                {
                    None: metadata_ports._RawPage(
                        items=(_VendorItem(1), _VendorItem(2)),
                        next_cursor=None,
                        exhausted=True,
                    )
                },
                convert,
            ),
        )
        api = MetadataApi(MetadataService(reference_query_ports=(provider,)))

        result = api.query_references_provider(
            MetadataReferenceQueryRequest(
                direction="references",
                providers=(
                    ProviderReferenceQuery(
                        provider_name="fake",
                        keys=(anchor,),
                        scan_limit=2,
                    ),
                ),
            ),
            cancel_event=event,
        )

        self.assertEqual(result.outcome, "INTERRUPTED")
        self.assertEqual(result.raw_item_count, 1)
        self.assertEqual(result.relations, (relation,))

    def test_reference_queries_normalize_both_endpoint_directions_to_citing_then_cited(
        self,
    ) -> None:
        anchor = _key("10.1000/anchor")
        related = _key("10.1000/related")
        calls: list[object] = []

        def provider_for(
            provider_name: str,
            relation: ProviderRelationObservation,
        ) -> _ReferenceFake:
            return _ReferenceFake(
                provider_name,
                lambda: _pages(
                    {
                        None: metadata_ports._RawPage(
                            items=(_VendorItem(1),),
                            next_cursor=None,
                            exhausted=True,
                        )
                    },
                    lambda _raw: NeutralMetadataItem(relations=(relation,)),
                ),
                calls,
            )

        references = provider_for(
            "references-provider",
            _relation(11, citing=anchor, cited=related),
        )
        cited_by = provider_for(
            "cited-by-provider",
            _relation(12, citing=related, cited=anchor),
        )
        api = MetadataApi(MetadataService(reference_query_ports=(references, cited_by)))

        references_result = api.query_references(
            MetadataReferenceQueryRequest(
                direction="references",
                providers=(
                    ProviderReferenceQuery(
                        provider_name="references-provider",
                        keys=(anchor,),
                        scan_limit=3,
                    ),
                ),
            )
        ).providers[0]
        cited_by_result = api.query_references(
            MetadataReferenceQueryRequest(
                direction="cited-by",
                providers=(
                    ProviderReferenceQuery(
                        provider_name="cited-by-provider",
                        keys=(anchor,),
                        scan_limit=3,
                    ),
                ),
            )
        ).providers[0]

        self.assertEqual(references_result.relations[0].citing, anchor)
        self.assertEqual(references_result.relations[0].cited, related)
        self.assertEqual(cited_by_result.relations[0].citing, related)
        self.assertEqual(cited_by_result.relations[0].cited, anchor)
        self.assertEqual(len(calls), 2)

    def test_inverted_reference_direction_is_a_stable_protocol_failure(self) -> None:
        anchor = _key("10.1000/anchor")
        related = _key("10.1000/related")
        inverted = _relation(21, citing=related, cited=anchor)
        provider = _ReferenceFake(
            "fake",
            lambda: _pages(
                {
                    None: metadata_ports._RawPage(
                        items=(_VendorItem(1),),
                        next_cursor=None,
                        exhausted=True,
                    )
                },
                lambda _raw: NeutralMetadataItem(relations=(inverted,)),
            ),
        )
        result = (
            MetadataApi(MetadataService(reference_query_ports=(provider,)))
            .query_references(
                MetadataReferenceQueryRequest(
                    direction="references",
                    providers=(
                        ProviderReferenceQuery(
                            provider_name="fake",
                            keys=(anchor,),
                            scan_limit=3,
                        ),
                    ),
                )
            )
            .providers[0]
        )

        self.assertEqual(result.raw_item_count, 1)
        self.assertEqual(result.relations, ())
        self.assertEqual(result.outcome, "FAILED")
        assert result.failure is not None
        self.assertEqual(result.failure.code, "metadata-reference-direction")

    def test_reference_provider_failure_does_not_rollback_other_provider(self) -> None:
        anchor = _key("10.1000/anchor")
        related = _key("10.1000/related")
        successful = _ReferenceFake(
            "successful",
            lambda: _pages(
                {
                    None: metadata_ports._RawPage(
                        items=(_VendorItem(1),),
                        next_cursor=None,
                        exhausted=True,
                    )
                },
                lambda _raw: NeutralMetadataItem(
                    relations=(_relation(31, citing=anchor, cited=related),)
                ),
            ),
        )
        failed = _ReferenceFake(
            "failed",
            lambda: cast(
                RawItemSession,
                (_ for _ in ()).throw(MetadataProviderFailure(_failure())),
            ),
        )
        request = MetadataReferenceQueryRequest(
            direction="references",
            providers=(
                ProviderReferenceQuery(
                    provider_name="failed",
                    keys=(anchor,),
                    scan_limit=2,
                ),
                ProviderReferenceQuery(
                    provider_name="successful",
                    keys=(anchor,),
                    scan_limit=2,
                ),
            ),
        )
        batch = MetadataApi(
            MetadataService(reference_query_ports=(successful, failed))
        ).query_references(request)

        self.assertEqual(
            tuple(result.provider_name for result in batch.providers),
            ("failed", "successful"),
        )
        self.assertEqual(batch.providers[0].outcome, "FAILED")
        self.assertEqual(
            batch.providers[1].relations, (_relation(31, citing=anchor, cited=related),)
        )

    def test_search_contract_has_no_publisher_llm_pdf_or_post_scan_decisions(self) -> None:
        request_fields = set(TopicDiscoveryInput.model_fields)
        self.assertFalse(
            request_fields
            & {
                "publisher",
                "llm",
                "pdf",
                "parser",
                "score_threshold",
                "accepted",
                "deduplicate",
            }
        )
        forbidden_result_fields = {
            "discovery_run_id",
            "run_status",
            "accepted",
            "rejected",
            "deduplicated",
            "cursor",
            "page",
            "request",
            "response",
            "score",
        }
        self.assertFalse(set(MetadataProviderResult.model_fields) & forbidden_result_fields)
        self.assertFalse(set(MetadataBatchResult.model_fields) & forbidden_result_fields)

        with self.assertRaises(ValidationError):
            MetadataProviderResult.model_validate(
                {
                    "provider_name": "fake",
                    "observations": [],
                    "relations": [],
                    "raw_item_count": 0,
                    "outcome": "EXHAUSTED",
                    "failure": None,
                    "accepted": 0,
                }
            )


if __name__ == "__main__":
    unittest.main()
