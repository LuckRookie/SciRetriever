from __future__ import annotations

import asyncio
import json
import unittest
from collections.abc import Callable
from pathlib import Path
from typing import Literal, cast
from urllib.parse import parse_qs, urlsplit
from uuid import UUID

from metadata_provider_contract import (
    ContractBinding,
    ContractEnvironment,
    ContractExpectedResult,
    ContractPorts,
    ContractScenario,
    ExpectedAffiliation,
    ExpectedAuthor,
    ProviderCapability,
    ProviderContractCase,
    RecordingAccessCoordinator,
)

from sciretriever.metadata.ports import (
    MetadataLookupPort,
    ReferenceQueryPort,
    TopicSearchPort,
)
from sciretriever.metadata.providers.web_of_science import (
    EXPANDED_ACCESS_SCOPE,
    EXPANDED_BASELINE_ACCESS_POLICY,
    STARTER_ACCESS_SCOPE,
    STARTER_BASELINE_ACCESS_POLICY,
    WebOfScienceExpandedAdapter,
    WebOfScienceStarterAdapter,
)
from sciretriever.metadata.rules import (
    MetadataLookupRequest,
    MetadataProviderResult,
    MetadataReferenceQueryRequest,
    ProviderReferenceQuery,
)
from sciretriever.model.discovery import ProviderDiscoveryLimit, TopicDiscoveryInput
from sciretriever.model.literature import Identifier
from sciretriever.model.metadata import ProviderLiteratureKey
from sciretriever.model.primitives import (
    ObservationId,
    ProvenanceId,
    UtcTimestamp,
)
from sciretriever.network.admission import AccessFeedback, AccessPolicy, AccessScope

_FIXTURES = Path(__file__).parent / "fixtures" / "metadata" / "web_of_science"
_STARTER_UID = "WOS:000111111100001"
_EXPANDED_UID = "WOS:000222222200001"
_DEFAULT_API_KEY = object()
_Product = Literal["starter", "expanded"]


class _FeedbackPermitProbe(list[tuple[AccessScope, AccessFeedback]]):
    def __init__(self, coordinator: RecordingAccessCoordinator) -> None:
        super().__init__()
        self._coordinator = coordinator
        self.active_permit_counts: list[int] = []

    def append(self, value: tuple[AccessScope, AccessFeedback], /) -> None:
        self.active_permit_counts.append(len(self._coordinator._active_scope_permits))
        super().append(value)


class _IdFactories:
    def __init__(self, start: int) -> None:
        self._next = start

    def _value(self) -> str:
        value = str(UUID(int=self._next))
        self._next += 1
        return value

    def observation(self) -> ObservationId:
        return ObservationId(self._value())

    def provenance(self) -> ProvenanceId:
        return ProvenanceId(self._value())


def _fixture(name: str) -> bytes:
    return (_FIXTURES / name).read_bytes()


def _starter_lookup_with_citation_counts(
    counts: tuple[tuple[str, int], ...],
) -> bytes:
    document = cast(dict[str, object], json.loads(_fixture("starter-lookup.json")))
    document["citations"] = [{"db": collection, "count": count} for collection, count in counts]
    return json.dumps(document, separators=(",", ":")).encode("utf-8")


def _expanded_lookup_with_citation_counts(
    counts: tuple[tuple[str, int], ...],
) -> bytes:
    root = cast(dict[str, object], json.loads(_fixture("expanded-lookup.json")))
    data = cast(dict[str, object], root["Data"])
    records = cast(dict[str, object], data["Records"])
    container = cast(dict[str, object], records["records"])
    values = cast(list[object], container["REC"])
    record = cast(dict[str, object], values[0])
    dynamic_data = cast(dict[str, object], record["dynamic_data"])
    citation_related = cast(dict[str, object], dynamic_data["citation_related"])
    count_list = cast(dict[str, object], citation_related["tc_list"])
    count_list["silo_tc"] = [
        {"coll_id": collection, "local_count": count} for collection, count in counts
    ]
    return json.dumps(root, separators=(",", ":")).encode("utf-8")


def _wall_timestamp(environment: ContractEnvironment) -> UtcTimestamp:
    return UtcTimestamp(environment.wall_clock().isoformat().replace("+00:00", "Z"))


def _topic_request(
    scan_limit: int,
    *,
    query: str = 'retrieval systems "quoted" (safe)',
    year_from: int | None = 2020,
    year_to: int | None = 2026,
) -> TopicDiscoveryInput:
    return TopicDiscoveryInput(
        kind="topic",
        query=query,
        year_from=year_from,
        year_to=year_to,
        providers=(
            ProviderDiscoveryLimit(
                provider_name="web-of-science",
                scan_limit=scan_limit,
            ),
        ),
    )


def _lookup_request(key: ProviderLiteratureKey, *, scan_limit: int = 4) -> MetadataLookupRequest:
    return MetadataLookupRequest(
        provider_name="web-of-science",
        key=key,
        scan_limit=scan_limit,
    )


def _reference_request(
    direction: Literal["references", "cited-by", "both"],
    *,
    key: ProviderLiteratureKey | None = None,
    scan_limit: int = 10,
) -> MetadataReferenceQueryRequest:
    return MetadataReferenceQueryRequest(
        direction=direction,
        providers=(
            ProviderReferenceQuery(
                provider_name="web-of-science",
                keys=(key or ProviderLiteratureKey(record_id=_EXPANDED_UID),),
                scan_limit=scan_limit,
            ),
        ),
    )


def _environment(
    product: _Product,
    *,
    api_key: str | None | object = _DEFAULT_API_KEY,
    database: str = "WOS",
    edition: str | None = "core",
    access_policy: AccessPolicy | None = None,
    observation_id_factory: Callable[[], ObservationId] | None = None,
    provenance_id_factory: Callable[[], ProvenanceId] | None = None,
    clock: Callable[[], UtcTimestamp] | None = None,
    id_start: int = 10_000,
    page_size: int = 2,
) -> ContractEnvironment:
    ids = _IdFactories(id_start)
    capabilities: frozenset[ProviderCapability] = (
        frozenset({"search", "lookup"})
        if product == "starter"
        else frozenset({"search", "lookup", "references"})
    )
    expected_scope = STARTER_ACCESS_SCOPE if product == "starter" else EXPANDED_ACCESS_SCOPE

    def assemble(environment: ContractEnvironment) -> ContractPorts:
        private_key = environment.secret_sentinel if api_key is _DEFAULT_API_KEY else api_key
        common = {
            "http_client": environment.http_client,
            "access_coordinator": environment.coordinator,
            "access_scope": environment.scope,
            "access_policy": access_policy or environment.policy,
            "observation_id_factory": observation_id_factory or ids.observation,
            "provenance_id_factory": provenance_id_factory or ids.provenance,
            "clock": clock or (lambda: _wall_timestamp(environment)),
            "api_key": private_key,
            "database": database,
            "edition": edition,
            "page_size": page_size,
        }
        if product == "starter":
            adapter = WebOfScienceStarterAdapter(**common)
            return ContractPorts(topic_search=adapter, lookup=adapter)
        adapter = WebOfScienceExpandedAdapter(**common)
        return ContractPorts(
            topic_search=adapter,
            lookup=adapter,
            reference_query=adapter,
        )

    return ContractEnvironment(
        provider_name="web-of-science",
        capabilities=capabilities,
        port_factory=assemble,
        expected_scope=expected_scope,
    )


def _starter_contract_ports(environment: ContractEnvironment) -> ContractPorts:
    ids = _IdFactories(20_000)
    adapter = WebOfScienceStarterAdapter(
        http_client=environment.http_client,
        access_coordinator=environment.coordinator,
        access_scope=environment.scope,
        access_policy=environment.policy,
        observation_id_factory=ids.observation,
        provenance_id_factory=ids.provenance,
        clock=lambda: _wall_timestamp(environment),
        api_key=environment.secret_sentinel,
        database="WOS",
        edition="core",
        page_size=2,
    )
    return ContractPorts(topic_search=adapter, lookup=adapter)


def _expanded_contract_ports(environment: ContractEnvironment) -> ContractPorts:
    ids = _IdFactories(30_000)
    adapter = WebOfScienceExpandedAdapter(
        http_client=environment.http_client,
        access_coordinator=environment.coordinator,
        access_scope=environment.scope,
        access_policy=environment.policy,
        observation_id_factory=ids.observation,
        provenance_id_factory=ids.provenance,
        clock=lambda: _wall_timestamp(environment),
        api_key=environment.secret_sentinel,
        database="WOS",
        edition="core",
        page_size=2,
    )
    return ContractPorts(
        topic_search=adapter,
        lookup=adapter,
        reference_query=adapter,
    )


def _queue_starter_search(environment: ContractEnvironment) -> None:
    environment.queue_http_response(status=200, body=_fixture("starter-search-page-1.json"))
    environment.queue_http_response(status=200, body=_fixture("starter-search-page-2.json"))


def _queue_starter_lookup(environment: ContractEnvironment) -> None:
    environment.queue_http_response(status=200, body=_fixture("starter-lookup.json"))


def _queue_starter_partial(environment: ContractEnvironment) -> None:
    environment.queue_http_response(status=200, body=_fixture("starter-search-page-1.json"))
    environment.queue_http_response(status=200, body=_fixture("starter-malformed.json"))


def _queue_expanded_search(environment: ContractEnvironment) -> None:
    environment.queue_http_response(status=200, body=_fixture("expanded-search-page-1.json"))
    environment.queue_http_response(status=200, body=_fixture("expanded-search-page-2.json"))


def _queue_expanded_lookup(environment: ContractEnvironment) -> None:
    environment.queue_http_response(status=200, body=_fixture("expanded-lookup.json"))


def _queue_expanded_both(environment: ContractEnvironment) -> None:
    environment.queue_http_response(
        status=200,
        body=_fixture("expanded-references-page-1.json"),
    )
    environment.queue_http_response(
        status=200,
        body=_fixture("expanded-references-page-2.json"),
    )
    environment.queue_http_response(status=200, body=_fixture("expanded-citing.json"))


def _queue_expanded_partial(environment: ContractEnvironment) -> None:
    environment.queue_http_response(status=200, body=_fixture("expanded-search-page-1.json"))
    environment.queue_http_response(status=200, body=_fixture("expanded-malformed.json"))


def _queue_throttled(environment: ContractEnvironment) -> None:
    environment.queue_http_response(
        status=429,
        headers=(
            ("Retry-After", "5"),
            ("X-REC-AmtPerYear-Remaining", "0"),
            ("X-REQ-ReqPerSec-Remaining", "0"),
        ),
    )


def _queue_starter_same_origin_redirect(environment: ContractEnvironment) -> None:
    environment.queue_http_response(
        status=302,
        headers=(("Location", "https://api.clarivate.com/apis/wos-starter/v2/again"),),
    )
    environment.queue_http_response(status=200, body=_fixture("starter-zero.json"))


def _queue_starter_cross_origin_redirect(environment: ContractEnvironment) -> None:
    environment.queue_http_response(
        status=302,
        headers=(("Location", "https://redirect.example.org/wos-starter"),),
    )
    environment.queue_http_response(status=200, body=_fixture("starter-zero.json"))


def _queue_expanded_same_origin_redirect(environment: ContractEnvironment) -> None:
    environment.queue_http_response(
        status=302,
        headers=(("Location", "https://wos-api.clarivate.com/api/wos/again"),),
    )
    environment.queue_http_response(status=200, body=_fixture("expanded-zero.json"))


def _queue_expanded_cross_origin_redirect(environment: ContractEnvironment) -> None:
    environment.queue_http_response(
        status=302,
        headers=(("Location", "https://redirect.example.org/wos-expanded"),),
    )
    environment.queue_http_response(status=200, body=_fixture("expanded-zero.json"))


def _starter_search_evidence(
    contract: ProviderContractCase,
    environment: ContractEnvironment,
    result: MetadataProviderResult,
) -> None:
    case = contract._test_case()
    case.assertEqual(len(environment.transport.calls), 2)
    first = parse_qs(urlsplit(environment.transport.calls[0].request.url).query)
    second = parse_qs(urlsplit(environment.transport.calls[1].request.url).query)
    case.assertEqual(first["page"], ["1"])
    case.assertEqual(second["page"], ["2"])
    case.assertEqual(first["db"], ["WOS"])
    case.assertEqual(result.observations[0].metadata.title, "A Web of Science Starter article")


def _starter_lookup_evidence(
    contract: ProviderContractCase,
    environment: ContractEnvironment,
    result: MetadataProviderResult,
) -> None:
    case = contract._test_case()
    case.assertEqual(len(environment.transport.calls), 1)
    case.assertEqual(
        urlsplit(environment.transport.calls[0].request.url).path,
        "/apis/wos-starter/v2/documents/WOS:000111111100001",
    )
    case.assertEqual(result.observations[0].provenance.source_record_id, _STARTER_UID)


def _expanded_search_evidence(
    contract: ProviderContractCase,
    environment: ContractEnvironment,
    result: MetadataProviderResult,
) -> None:
    case = contract._test_case()
    case.assertEqual(len(environment.transport.calls), 2)
    first = parse_qs(urlsplit(environment.transport.calls[0].request.url).query)
    second = parse_qs(urlsplit(environment.transport.calls[1].request.url).query)
    case.assertEqual(first["firstRecord"], ["1"])
    case.assertEqual(second["firstRecord"], ["3"])
    case.assertEqual(first["optionView"], ["FR"])
    case.assertEqual(
        result.observations[0].metadata.abstract,
        "First abstract paragraph.\n\nSecond abstract paragraph.",
    )


def _expanded_lookup_evidence(
    contract: ProviderContractCase,
    environment: ContractEnvironment,
    result: MetadataProviderResult,
) -> None:
    case = contract._test_case()
    query = parse_qs(urlsplit(environment.transport.calls[0].request.url).query)
    case.assertIn("DO=", query["usrQuery"][0])
    case.assertEqual(result.observations[0].provenance.source_record_id, _EXPANDED_UID)


def _expanded_reference_evidence(
    contract: ProviderContractCase,
    environment: ContractEnvironment,
    result: MetadataProviderResult,
) -> None:
    case = contract._test_case()
    case.assertEqual(len(environment.transport.calls), 3)
    paths = tuple(urlsplit(call.request.url).path for call in environment.transport.calls)
    case.assertEqual(paths, ("/api/wos/references", "/api/wos/references", "/api/wos/citing"))
    case.assertEqual(
        tuple(relation.citing.record_id for relation in result.relations),
        (_EXPANDED_UID, _EXPANDED_UID, "WOS:000444444400001"),
    )
    case.assertEqual(result.relations[-1].cited.record_id, _EXPANDED_UID)


def _feedback_evidence(
    contract: ProviderContractCase,
    environment: ContractEnvironment,
    result: MetadataProviderResult,
) -> None:
    case = contract._test_case()
    case.assertEqual(len(environment.coordinator.feedback_records), 1)
    case.assertEqual(
        result.failure.code if result.failure is not None else None,
        "metadata-provider-throttled",
    )


def _redirect_evidence(
    contract: ProviderContractCase,
    environment: ContractEnvironment,
    result: MetadataProviderResult,
) -> None:
    del result
    contract._test_case().assertEqual(len(environment.transport.calls), 2)


def _partial_evidence(
    contract: ProviderContractCase,
    environment: ContractEnvironment,
    result: MetadataProviderResult,
) -> None:
    contract._test_case().assertEqual(len(environment.transport.calls), 2)
    contract._test_case().assertEqual(len(result.observations), 2)


def _starter_contract_binding() -> ContractBinding:
    return ContractBinding(
        provider_name="web-of-science",
        capabilities=frozenset({"search", "lookup"}),
        expected_scope=STARTER_ACCESS_SCOPE,
        credential_mode="header",
        port_factory=_starter_contract_ports,
        scenarios=(
            ContractScenario(
                name="starter-paged-search",
                capability="search",
                request=_topic_request(10),
                prepare=_queue_starter_search,
                expected=ContractExpectedResult(
                    outcome="EXHAUSTED",
                    raw_item_count=3,
                    observation_count=3,
                    relation_count=0,
                ),
                evidence=_starter_search_evidence,
            ),
            ContractScenario(
                name="starter-uid-lookup",
                capability="lookup",
                request=_lookup_request(ProviderLiteratureKey(record_id=_STARTER_UID)),
                prepare=_queue_starter_lookup,
                expected=ContractExpectedResult(
                    outcome="EXHAUSTED",
                    raw_item_count=1,
                    observation_count=1,
                    relation_count=0,
                ),
                evidence=_starter_lookup_evidence,
            ),
            ContractScenario(
                name="starter-throttle-feedback",
                capability="search",
                request=_topic_request(2),
                prepare=_queue_throttled,
                expected=ContractExpectedResult(
                    outcome="FAILED",
                    raw_item_count=0,
                    observation_count=0,
                    relation_count=0,
                    failure_code="metadata-provider-throttled",
                ),
                evidence=_feedback_evidence,
                expects_feedback=True,
            ),
            ContractScenario(
                name="starter-same-origin-redirect",
                capability="search",
                request=_topic_request(2),
                prepare=_queue_starter_same_origin_redirect,
                expected=ContractExpectedResult(
                    outcome="EXHAUSTED",
                    raw_item_count=0,
                    observation_count=0,
                    relation_count=0,
                ),
                evidence=_redirect_evidence,
                credential_redirect="same-origin",
            ),
            ContractScenario(
                name="starter-cross-origin-redirect",
                capability="search",
                request=_topic_request(2),
                prepare=_queue_starter_cross_origin_redirect,
                expected=ContractExpectedResult(
                    outcome="EXHAUSTED",
                    raw_item_count=0,
                    observation_count=0,
                    relation_count=0,
                ),
                evidence=_redirect_evidence,
                credential_redirect="cross-origin",
            ),
            ContractScenario(
                name="starter-malformed-second-page-keeps-partial",
                capability="search",
                request=_topic_request(10),
                prepare=_queue_starter_partial,
                expected=ContractExpectedResult(
                    outcome="FAILED",
                    raw_item_count=2,
                    observation_count=2,
                    relation_count=0,
                    failure_code="metadata-provider-malformed-json",
                ),
                evidence=_partial_evidence,
            ),
        ),
    )


def _expanded_contract_binding() -> ContractBinding:
    return ContractBinding(
        provider_name="web-of-science",
        capabilities=frozenset({"search", "lookup", "references"}),
        expected_scope=EXPANDED_ACCESS_SCOPE,
        credential_mode="header",
        port_factory=_expanded_contract_ports,
        scenarios=(
            ContractScenario(
                name="expanded-paged-search",
                capability="search",
                request=_topic_request(10),
                prepare=_queue_expanded_search,
                expected=ContractExpectedResult(
                    outcome="EXHAUSTED",
                    raw_item_count=3,
                    observation_count=3,
                    relation_count=0,
                ),
                evidence=_expanded_search_evidence,
            ),
            ContractScenario(
                name="expanded-doi-lookup",
                capability="lookup",
                request=_lookup_request(
                    ProviderLiteratureKey(
                        identifiers=(Identifier(namespace="doi", value="10.5555/wos.expanded.one"),)
                    )
                ),
                prepare=_queue_expanded_lookup,
                expected=ContractExpectedResult(
                    outcome="EXHAUSTED",
                    raw_item_count=1,
                    observation_count=1,
                    relation_count=0,
                ),
                evidence=_expanded_lookup_evidence,
            ),
            ContractScenario(
                name="expanded-both-reference-directions",
                capability="references",
                request=_reference_request("both"),
                prepare=_queue_expanded_both,
                expected=ContractExpectedResult(
                    outcome="EXHAUSTED",
                    raw_item_count=4,
                    observation_count=1,
                    relation_count=3,
                ),
                evidence=_expanded_reference_evidence,
            ),
            ContractScenario(
                name="expanded-throttle-feedback",
                capability="search",
                request=_topic_request(2),
                prepare=_queue_throttled,
                expected=ContractExpectedResult(
                    outcome="FAILED",
                    raw_item_count=0,
                    observation_count=0,
                    relation_count=0,
                    failure_code="metadata-provider-throttled",
                ),
                evidence=_feedback_evidence,
                expects_feedback=True,
            ),
            ContractScenario(
                name="expanded-same-origin-redirect",
                capability="search",
                request=_topic_request(2),
                prepare=_queue_expanded_same_origin_redirect,
                expected=ContractExpectedResult(
                    outcome="EXHAUSTED",
                    raw_item_count=0,
                    observation_count=0,
                    relation_count=0,
                ),
                evidence=_redirect_evidence,
                credential_redirect="same-origin",
            ),
            ContractScenario(
                name="expanded-cross-origin-redirect",
                capability="search",
                request=_topic_request(2),
                prepare=_queue_expanded_cross_origin_redirect,
                expected=ContractExpectedResult(
                    outcome="EXHAUSTED",
                    raw_item_count=0,
                    observation_count=0,
                    relation_count=0,
                ),
                evidence=_redirect_evidence,
                credential_redirect="cross-origin",
            ),
            ContractScenario(
                name="expanded-malformed-second-page-keeps-partial",
                capability="search",
                request=_topic_request(10),
                prepare=_queue_expanded_partial,
                expected=ContractExpectedResult(
                    outcome="FAILED",
                    raw_item_count=2,
                    observation_count=2,
                    relation_count=0,
                    failure_code="metadata-provider-malformed-json",
                ),
                evidence=_partial_evidence,
            ),
        ),
    )


class WebOfScienceStarterAdapterTests(ProviderContractCase, unittest.TestCase):
    def provider_contract_binding(self) -> ContractBinding:
        return _starter_contract_binding()

    def _starter(self) -> ContractEnvironment:
        environment = _environment("starter")
        self.addCleanup(environment.close)
        return environment

    def test_starter_maps_only_supported_document_semantics(self) -> None:
        environment = self._starter()
        _queue_starter_search(environment)
        result = self.assert_topic_scan(
            environment,
            _topic_request(10),
            outcome="EXHAUSTED",
            raw_item_count=3,
            observation_count=3,
        )
        observation = result.observations[0]
        metadata = observation.metadata
        self.assertEqual(metadata.title, "A Web of Science Starter article")
        self.assertEqual(metadata.abstract, None)
        self.assertEqual(metadata.publication_year, 2024)
        self.assertEqual(metadata.document_type, "Article")
        self.assertIsNone(metadata.language)
        self.assertEqual(metadata.venue, "Journal of Retrieval Evidence")
        self.assertIsNone(metadata.publisher)
        self.assertEqual(metadata.volume, "12")
        self.assertEqual(metadata.issue, "3")
        self.assertEqual(metadata.pages, "101-119")
        self.assertEqual(metadata.keywords, ())
        self.assertEqual(
            metadata.identifiers,
            (
                Identifier(namespace="doi", value="10.5555/wos.starter.one"),
                Identifier(namespace="pmid", value="12345678"),
            ),
        )
        self.assert_author_mapping(
            metadata.authors,
            (
                ExpectedAuthor(kind="unknown", display_name="Example, Ada"),
                ExpectedAuthor(kind="unknown", display_name="Retrieval Consortium"),
            ),
        )
        self.assertEqual(
            observation.declared_keywords,
            ("source-declared retrieval", "source-declared metadata"),
        )
        self.assertIsNone(observation.cited_by_count)
        self.assertIsNone(observation.reference_count)
        self.assertEqual(observation.reference_texts, ())
        self.assertEqual(observation.asset_hints, ())
        self.assert_identifier_record_id_separation(
            observation,
            expected_identifiers=metadata.identifiers,
            expected_record_id=_STARTER_UID,
            forbidden_record_ids=(_STARTER_UID,),
        )
        serialized = observation.model_dump_json()
        for excluded in (
            "RID-PRIVATE-NOT-AN-ORCID",
            "Excluded Contributor",
            "Excluded Editor",
            "excluded generated term",
            "1234-5678",
            "www.webofscience.com",
            "must-not-cross-the-adapter",
        ):
            self.assertNotIn(excluded, serialized)
        self.assertEqual(result.observations[1].metadata.pages, "ARTN-22")

    def test_starter_query_is_quoted_and_scan_limit_does_not_prefetch(self) -> None:
        environment = self._starter()
        environment.queue_http_response(
            status=200,
            body=_fixture("starter-search-page-1.json"),
        )
        query = 'alpha") OR UT=(WOS:injected) OR TS=("omega\\tail'
        self.assert_topic_scan(
            environment,
            _topic_request(1, query=query),
            outcome="SCAN_LIMIT_REACHED",
            raw_item_count=1,
            observation_count=1,
        )
        self.assertEqual(len(environment.transport.calls), 1)
        request_query = parse_qs(urlsplit(environment.transport.calls[0].request.url).query)
        vendor_query = request_query["q"][0]
        self.assertTrue(vendor_query.startswith('TS=("'))
        self.assertIn(r"\"", vendor_query)
        self.assertIn(r"\\", vendor_query)
        self.assertIn("PY=(2020-2026)", vendor_query)
        self.assertEqual(request_query["limit"], ["2"])
        self.assertEqual(request_query["page"], ["1"])

    def test_starter_uid_doi_and_pmid_lookups_use_distinct_official_operations(self) -> None:
        cases = (
            (
                ProviderLiteratureKey(
                    record_id=_STARTER_UID,
                    identifiers=(Identifier(namespace="doi", value="10.5555/not-the-response"),),
                ),
                "starter-lookup.json",
                None,
            ),
            (
                ProviderLiteratureKey(
                    identifiers=(
                        Identifier(namespace="doi", value="10.5555/wos.starter.one"),
                        Identifier(namespace="pmid", value="99999990"),
                    )
                ),
                "starter-lookup-search.json",
                'DO="10.5555/wos.starter.one"',
            ),
            (
                ProviderLiteratureKey(
                    identifiers=(
                        Identifier(namespace="pmid", value="12345678"),
                        Identifier(namespace="pmid", value="99999990"),
                    )
                ),
                "starter-lookup-search.json",
                "PMID=12345678",
            ),
        )
        for key, fixture_name, expected_query in cases:
            with self.subTest(key=key.model_dump_json()):
                environment = self._starter()
                environment.queue_http_response(status=200, body=_fixture(fixture_name))
                result = self.assert_lookup_scan(
                    environment,
                    _lookup_request(key),
                    outcome="EXHAUSTED",
                    raw_item_count=1,
                    observation_count=1,
                )
                call = environment.transport.calls[0]
                if expected_query is None:
                    self.assertEqual(
                        urlsplit(call.request.url).path,
                        "/apis/wos-starter/v2/documents/WOS:000111111100001",
                    )
                else:
                    parameters = parse_qs(urlsplit(call.request.url).query)
                    self.assertEqual(parameters["q"], [expected_query])
                    self.assertEqual(
                        urlsplit(call.request.url).path, "/apis/wos-starter/v2/documents"
                    )
                self.assertEqual(result.observations[0].provenance.source_record_id, _STARTER_UID)

    def test_starter_lookup_rejects_selected_locator_mismatch_despite_other_overlap(
        self,
    ) -> None:
        cases = (
            (
                "uid",
                ProviderLiteratureKey(
                    record_id="WOS:999999999999999",
                    identifiers=(Identifier(namespace="doi", value="10.5555/wos.starter.one"),),
                ),
                "starter-lookup.json",
            ),
            (
                "doi",
                ProviderLiteratureKey(
                    identifiers=(
                        Identifier(namespace="doi", value="10.5555/wos.starter.other"),
                        Identifier(namespace="pmid", value="12345678"),
                    )
                ),
                "starter-lookup-search.json",
            ),
            (
                "pmid",
                ProviderLiteratureKey(
                    identifiers=(
                        Identifier(namespace="pmid", value="99999999"),
                        Identifier(namespace="pmid", value="12345678"),
                    )
                ),
                "starter-lookup-search.json",
            ),
        )
        for locator, key, fixture_name in cases:
            with self.subTest(locator=locator):
                environment = self._starter()
                environment.queue_http_response(status=200, body=_fixture(fixture_name))
                result = self.assert_lookup_scan(
                    environment,
                    _lookup_request(key),
                    outcome="FAILED",
                    raw_item_count=1,
                    observation_count=0,
                )
                self.assert_stable_failure(
                    result,
                    expected_code="metadata-provider-invalid-record",
                    forbidden_values=(environment.secret_sentinel,),
                )

    def test_starter_cited_count_uses_only_configured_collection(self) -> None:
        cases = (
            ("core", (("WOS", 70), ("core", 7)), 7),
            ("missing", (("WOS", 70), ("core", 7)), None),
            (None, (("WOS", 70), ("core", 7)), 70),
        )
        for edition, counts, expected in cases:
            with self.subTest(edition=edition):
                environment = _environment("starter", edition=edition)
                self.addCleanup(environment.close)
                environment.queue_http_response(
                    status=200,
                    body=_starter_lookup_with_citation_counts(counts),
                )
                result = self.assert_lookup_scan(
                    environment,
                    _lookup_request(ProviderLiteratureKey(record_id=_STARTER_UID)),
                    outcome="EXHAUSTED",
                    raw_item_count=1,
                    observation_count=1,
                )
                self.assertEqual(result.observations[0].cited_by_count, expected)

    def test_starter_lookup_rejects_identity_mismatch_without_leaking_key(self) -> None:
        environment = self._starter()
        body = _fixture("starter-lookup-search.json").replace(
            b"10.5555/wos.starter.one",
            b"10.5555/wos.starter.other",
        )
        environment.queue_http_response(status=200, body=body)
        requested = "10.5555/wos.starter.one"
        result = self.assert_lookup_scan(
            environment,
            _lookup_request(
                ProviderLiteratureKey(identifiers=(Identifier(namespace="doi", value=requested),))
            ),
            outcome="FAILED",
            raw_item_count=1,
            observation_count=0,
        )
        self.assert_stable_failure(
            result,
            expected_code="metadata-provider-invalid-record",
            forbidden_values=(requested, environment.secret_sentinel),
        )

    def test_starter_rejects_lite_and_invalid_shapes(self) -> None:
        bodies = (
            _fixture("starter-malformed.json"),
            b'{"Data":[{"UT":"WOS:LITE-IS-NOT-STARTER"}]}',
            b'{"metadata":{"total":1,"page":1,"limit":2},"hits":{}}',
        )
        expected_codes = (
            "metadata-provider-malformed-json",
            "metadata-provider-unknown-shape",
            "metadata-provider-unknown-shape",
        )
        for body, expected_code in zip(bodies, expected_codes, strict=True):
            with self.subTest(expected_code=expected_code):
                environment = self._starter()
                environment.queue_http_response(status=200, body=body)
                result = self.assert_topic_scan(
                    environment,
                    _topic_request(2),
                    outcome="FAILED",
                    raw_item_count=0,
                    observation_count=0,
                )
                self.assert_stable_failure(result, expected_code=expected_code)
                self.assertIn("/wos-starter/v2/", environment.transport.calls[0].request.url)
                self.assertNotIn("woslite", environment.transport.calls[0].request.url.casefold())


class WebOfScienceExpandedAdapterTests(ProviderContractCase, unittest.TestCase):
    def provider_contract_binding(self) -> ContractBinding:
        return _expanded_contract_binding()

    def _expanded(
        self,
        *,
        database: str = "WOS",
        edition: str | None = "core",
    ) -> ContractEnvironment:
        environment = _environment("expanded", database=database, edition=edition)
        self.addCleanup(environment.close)
        return environment

    def test_expanded_maps_full_record_without_vendor_extensions(self) -> None:
        environment = self._expanded()
        _queue_expanded_search(environment)
        result = self.assert_topic_scan(
            environment,
            _topic_request(10),
            outcome="EXHAUSTED",
            raw_item_count=3,
            observation_count=3,
        )
        observation = result.observations[0]
        metadata = observation.metadata
        self.assertEqual(metadata.title, "A Web of Science Expanded article")
        self.assertEqual(
            metadata.abstract,
            "First abstract paragraph.\n\nSecond abstract paragraph.",
        )
        self.assertEqual(metadata.publication_date, "2025-03-14")
        self.assertEqual(metadata.publication_year, 2025)
        self.assertEqual(metadata.document_type, "Article")
        self.assertEqual(metadata.language, "English")
        self.assertEqual(metadata.venue, "Journal of Expanded Evidence")
        self.assertEqual(metadata.publisher, "Evidence Publishing")
        self.assertEqual(metadata.volume, "19")
        self.assertEqual(metadata.issue, "2")
        self.assertEqual(metadata.pages, "201-220")
        self.assertEqual(metadata.keywords, ())
        self.assertEqual(
            metadata.identifiers,
            (
                Identifier(namespace="doi", value="10.5555/wos.expanded.one"),
                Identifier(namespace="pmid", value="87654321"),
            ),
        )
        self.assert_author_mapping(
            metadata.authors,
            (
                ExpectedAuthor(
                    kind="person",
                    display_name="Lovelace, Ada",
                    given_name="Ada",
                    family_name="Lovelace",
                    affiliations=(
                        ExpectedAffiliation(name="Analytical Engine Institute, London, England"),
                        ExpectedAffiliation(name="Computing Laboratory, Manchester, England"),
                    ),
                ),
                ExpectedAuthor(
                    kind="person",
                    display_name="Turing, Alan",
                    given_name="Alan M",
                    family_name="Turing",
                    orcid="0000-0002-1825-0097",
                    affiliations=(
                        ExpectedAffiliation(name="Computing Laboratory, Manchester, England"),
                    ),
                ),
            ),
        )
        self.assertEqual(
            observation.declared_keywords,
            ("expanded retrieval", "author metadata"),
        )
        self.assertEqual(observation.reference_count, 42)
        self.assertIsNone(observation.cited_by_count)
        self.assertEqual(observation.reference_texts, ())
        self.assertEqual(observation.asset_hints, ())
        self.assertIsNotNone(observation.provenance.parameters_sha256)
        self.assert_identifier_record_id_separation(
            observation,
            expected_identifiers=metadata.identifiers,
            expected_record_id=_EXPANDED_UID,
            forbidden_record_ids=(_EXPANDED_UID,),
        )
        serialized = observation.model_dump_json()
        for excluded in (
            "Excluded, Editor",
            "RID-EXCLUDED",
            "excluded generated topic",
            "excluded item keyword",
            "9999-8888",
            "funding",
            "must-not-cross-the-adapter",
            "QueryID",
        ):
            self.assertNotIn(excluded, serialized)

    def test_expanded_search_uses_safe_literal_full_record_view_and_lazy_scan(self) -> None:
        environment = self._expanded()
        environment.queue_http_response(
            status=200,
            body=_fixture("expanded-search-page-1.json"),
        )
        query = 'alpha") OR UID=(WOS:injected) OR TS=("omega\\tail'
        self.assert_topic_scan(
            environment,
            _topic_request(1, query=query),
            outcome="SCAN_LIMIT_REACHED",
            raw_item_count=1,
            observation_count=1,
        )
        self.assertEqual(len(environment.transport.calls), 1)
        parameters = parse_qs(urlsplit(environment.transport.calls[0].request.url).query)
        self.assertTrue(parameters["usrQuery"][0].startswith('TS=("'))
        self.assertIn(r"\"", parameters["usrQuery"][0])
        self.assertIn(r"\\", parameters["usrQuery"][0])
        self.assertIn("PY=(2020-2026)", parameters["usrQuery"][0])
        self.assertEqual(parameters["databaseId"], ["WOS"])
        self.assertEqual(parameters["optionView"], ["FR"])
        self.assertEqual(parameters["count"], ["2"])
        self.assertEqual(parameters["firstRecord"], ["1"])

    def test_expanded_uid_doi_and_pmid_lookup_operations_are_exact(self) -> None:
        cases = (
            (
                ProviderLiteratureKey(
                    record_id=_EXPANDED_UID,
                    identifiers=(Identifier(namespace="doi", value="10.5555/not-the-response"),),
                ),
                None,
            ),
            (
                ProviderLiteratureKey(
                    identifiers=(
                        Identifier(namespace="doi", value="10.5555/wos.expanded.one"),
                        Identifier(namespace="pmid", value="99999990"),
                    )
                ),
                "DO=",
            ),
            (
                ProviderLiteratureKey(
                    identifiers=(
                        Identifier(namespace="pmid", value="87654321"),
                        Identifier(namespace="pmid", value="99999990"),
                    )
                ),
                "PMID=",
            ),
        )
        for key, query_prefix in cases:
            with self.subTest(key=key.model_dump_json()):
                environment = self._expanded()
                environment.queue_http_response(status=200, body=_fixture("expanded-lookup.json"))
                result = self.assert_lookup_scan(
                    environment,
                    _lookup_request(key),
                    outcome="EXHAUSTED",
                    raw_item_count=1,
                    observation_count=1,
                )
                call = environment.transport.calls[0]
                parameters = parse_qs(urlsplit(call.request.url).query)
                if query_prefix is None:
                    self.assertEqual(
                        urlsplit(call.request.url).path,
                        "/api/wos/id/WOS:000222222200001",
                    )
                    self.assertNotIn("usrQuery", parameters)
                else:
                    self.assertTrue(parameters["usrQuery"][0].startswith(query_prefix))
                    self.assertEqual(urlsplit(call.request.url).path, "/api/wos/")
                self.assertEqual(parameters["databaseId"], ["WOS"])
                self.assertEqual(parameters["optionView"], ["FR"])
                self.assertEqual(result.observations[0].provenance.source_record_id, _EXPANDED_UID)

    def test_expanded_lookup_rejects_selected_locator_mismatch_despite_other_overlap(
        self,
    ) -> None:
        cases = (
            (
                "uid",
                ProviderLiteratureKey(
                    record_id="WOS:999999999999999",
                    identifiers=(Identifier(namespace="doi", value="10.5555/wos.expanded.one"),),
                ),
            ),
            (
                "doi",
                ProviderLiteratureKey(
                    identifiers=(
                        Identifier(namespace="doi", value="10.5555/wos.expanded.other"),
                        Identifier(namespace="pmid", value="87654321"),
                    )
                ),
            ),
            (
                "pmid",
                ProviderLiteratureKey(
                    identifiers=(
                        Identifier(namespace="pmid", value="99999999"),
                        Identifier(namespace="pmid", value="87654321"),
                    )
                ),
            ),
        )
        for locator, key in cases:
            with self.subTest(locator=locator):
                environment = self._expanded()
                environment.queue_http_response(status=200, body=_fixture("expanded-lookup.json"))
                result = self.assert_lookup_scan(
                    environment,
                    _lookup_request(key),
                    outcome="FAILED",
                    raw_item_count=1,
                    observation_count=0,
                )
                self.assert_stable_failure(
                    result,
                    expected_code="metadata-provider-invalid-record",
                    forbidden_values=(environment.secret_sentinel,),
                )

    def test_expanded_cited_count_uses_only_configured_collection(self) -> None:
        cases = (
            ("core", (("WOS", 110), ("core", 11)), 11),
            ("missing", (("WOS", 110), ("core", 11)), None),
            (None, (("WOS", 110), ("core", 11)), 110),
        )
        for edition, counts, expected in cases:
            with self.subTest(edition=edition):
                environment = self._expanded(edition=edition)
                environment.queue_http_response(
                    status=200,
                    body=_expanded_lookup_with_citation_counts(counts),
                )
                result = self.assert_lookup_scan(
                    environment,
                    _lookup_request(ProviderLiteratureKey(record_id=_EXPANDED_UID)),
                    outcome="EXHAUSTED",
                    raw_item_count=1,
                    observation_count=1,
                )
                self.assertEqual(result.observations[0].cited_by_count, expected)

    def test_expanded_references_and_citing_normalize_direction_and_partial_failure(self) -> None:
        environment = self._expanded()
        _queue_expanded_both(environment)
        result = self.assert_reference_scan(
            environment,
            _reference_request("both"),
            outcome="EXHAUSTED",
            raw_item_count=4,
            observation_count=1,
            relation_count=3,
        )
        self.assertEqual(
            tuple(relation.citing.record_id for relation in result.relations),
            (_EXPANDED_UID, _EXPANDED_UID, "WOS:000444444400001"),
        )
        self.assertEqual(
            tuple(relation.cited.record_id for relation in result.relations),
            ("WOS:000333333300001", None, _EXPANDED_UID),
        )
        self.assertEqual(
            result.relations[1].cited.identifiers,
            (Identifier(namespace="doi", value="10.5555/wos.reference.two"),),
        )
        self.assertEqual(result.observations[0].metadata.title, "A work citing the expanded anchor")
        self.assertTrue(
            all(observation.reference_texts == () for observation in result.observations)
        )
        self.assertEqual(
            len({relation.observation_id for relation in result.relations}),
            len(result.relations),
        )

        environment.reset_http()
        environment.queue_http_response(
            status=200,
            body=_fixture("expanded-references-page-1.json"),
        )
        environment.queue_http_response(
            status=200,
            body=_fixture("expanded-references-page-2.json"),
        )
        environment.queue_http_response(status=403)
        partial = self.assert_reference_scan(
            environment,
            _reference_request("both"),
            outcome="FAILED",
            raw_item_count=3,
            observation_count=0,
            relation_count=2,
        )
        self.assert_stable_failure(
            partial,
            expected_code="metadata-provider-entitlement-denied",
        )

    def test_expanded_non_wos_database_rejects_citing_without_http(self) -> None:
        for database, edition in (("BIOSIS", "BIOSIS"), ("WOS", "MEDLINE")):
            with self.subTest(database=database, edition=edition):
                environment = self._expanded(database=database, edition=edition)
                result = self.assert_reference_scan(
                    environment,
                    _reference_request("cited-by"),
                    outcome="FAILED",
                    raw_item_count=0,
                    observation_count=0,
                    relation_count=0,
                )
                self.assert_stable_failure(
                    result,
                    expected_code="metadata-provider-unsupported-reference-direction",
                )
                self.assertEqual(environment.transport.calls, [])

    def test_expanded_lookup_mismatch_and_wrong_shapes_fail_closed(self) -> None:
        environment = self._expanded()
        mismatched = _fixture("expanded-lookup.json").replace(
            b"10.5555/wos.expanded.one",
            b"10.5555/wos.expanded.other",
        )
        environment.queue_http_response(status=200, body=mismatched)
        result = self.assert_lookup_scan(
            environment,
            _lookup_request(
                ProviderLiteratureKey(
                    identifiers=(Identifier(namespace="doi", value="10.5555/wos.expanded.one"),)
                )
            ),
            outcome="FAILED",
            raw_item_count=1,
            observation_count=0,
        )
        self.assert_stable_failure(result, expected_code="metadata-provider-invalid-record")

        for body, expected_code in (
            (_fixture("expanded-malformed.json"), "metadata-provider-malformed-json"),
            (b'{"Data":[],"QueryResult":{"RecordsFound":0}}', "metadata-provider-unknown-shape"),
            (
                b'{"metadata":{"total":0,"page":1,"limit":2},"hits":[]}',
                "metadata-provider-unknown-shape",
            ),
        ):
            environment = self._expanded()
            environment.queue_http_response(status=200, body=body)
            failed = self.assert_topic_scan(
                environment,
                _topic_request(2),
                outcome="FAILED",
                raw_item_count=0,
                observation_count=0,
            )
            self.assert_stable_failure(failed, expected_code=expected_code)

    def test_expanded_zero_remaining_quota_header_blocks_shared_scope(self) -> None:
        environment = self._expanded()
        environment.queue_http_response(
            status=200,
            headers=(("X-REC-AmtPerYear-Remaining", "0"),),
            body=_fixture("expanded-zero.json"),
        )
        result = self.assert_topic_scan(
            environment,
            _topic_request(2),
            outcome="EXHAUSTED",
            raw_item_count=0,
            observation_count=0,
        )
        self.assertIsNone(result.failure)
        self.assertEqual(len(environment.coordinator.feedback_records), 1)
        feedback = environment.coordinator.feedback_records[0][1]
        self.assertTrue(feedback.throttled)

    def test_expanded_conflicting_quota_headers_fail_after_conservative_feedback(
        self,
    ) -> None:
        environment = self._expanded()
        environment.queue_http_response(
            status=429,
            headers=(
                ("X-REC-AmtPerYear-Remaining", "0"),
                ("x-rec-amtperyear-remaining", "1"),
            ),
        )
        result = self.assert_topic_scan(
            environment,
            _topic_request(2),
            outcome="FAILED",
            raw_item_count=0,
            observation_count=0,
        )
        self.assert_stable_failure(
            result,
            expected_code="metadata-provider-conflicting-header",
            forbidden_values=(environment.secret_sentinel,),
        )
        self.assertEqual(len(environment.coordinator.feedback_records), 1)
        self.assertTrue(environment.coordinator.feedback_records[0][1].throttled)


class WebOfScienceAdapterBoundaryTests(ProviderContractCase, unittest.TestCase):
    def provider_contract_binding(self) -> ContractBinding:
        return _starter_contract_binding()

    def test_products_export_exact_scopes_policies_and_capabilities(self) -> None:
        self.assertEqual(
            STARTER_ACCESS_SCOPE,
            AccessScope(
                provider_name="web-of-science",
                channel="api",
                service_name="starter",
            ),
        )
        self.assertEqual(
            EXPANDED_ACCESS_SCOPE,
            AccessScope(
                provider_name="web-of-science",
                channel="api",
                service_name="expanded",
            ),
        )
        self.assertEqual(
            STARTER_BASELINE_ACCESS_POLICY,
            AccessPolicy(max_concurrency=1, min_start_interval=1.0),
        )
        self.assertEqual(
            EXPANDED_BASELINE_ACCESS_POLICY,
            AccessPolicy(max_concurrency=1, min_start_interval=0.5),
        )
        starter = _environment("starter")
        expanded = _environment("expanded")
        self.addCleanup(starter.close)
        self.addCleanup(expanded.close)
        self.assertIs(starter.ports.topic_search, starter.ports.lookup)
        self.assertIsNone(starter.ports.reference_query)
        self.assertIsInstance(starter.ports.topic_search, TopicSearchPort)
        self.assertIsInstance(starter.ports.lookup, MetadataLookupPort)
        self.assertIs(expanded.ports.topic_search, expanded.ports.lookup)
        self.assertIs(expanded.ports.lookup, expanded.ports.reference_query)
        self.assertIsInstance(expanded.ports.reference_query, ReferenceQueryPort)
        self.assert_scope_is_neutral(STARTER_ACCESS_SCOPE)
        self.assert_scope_is_neutral(EXPANDED_ACCESS_SCOPE)

    def test_wrong_product_scopes_are_rejected_and_operator_policy_only_tightens(self) -> None:
        cases: tuple[tuple[_Product, AccessScope], ...] = (
            ("starter", EXPANDED_ACCESS_SCOPE),
            ("expanded", STARTER_ACCESS_SCOPE),
        )
        for product, wrong_scope in cases:
            with self.subTest(product=product):
                environment = _environment(product)
                self.addCleanup(environment.close)
                ids = _IdFactories(80_000)
                constructor = (
                    WebOfScienceStarterAdapter
                    if product == "starter"
                    else WebOfScienceExpandedAdapter
                )
                with self.assertRaises(ValueError):
                    constructor(
                        http_client=environment.http_client,
                        access_coordinator=environment.coordinator,
                        access_scope=wrong_scope,
                        access_policy=AccessPolicy(max_concurrency=1),
                        observation_id_factory=ids.observation,
                        provenance_id_factory=ids.provenance,
                        clock=lambda: _wall_timestamp(environment),
                        api_key="private",
                        database="WOS",
                        edition="core",
                        page_size=2,
                    )

        operator = AccessPolicy(max_concurrency=1, min_start_interval=3.0)
        starter = _environment("starter", access_policy=operator)
        expanded = _environment("expanded", access_policy=operator)
        self.addCleanup(starter.close)
        self.addCleanup(expanded.close)
        starter.queue_http_response(status=200, body=_fixture("starter-zero.json"))
        expanded.queue_http_response(status=200, body=_fixture("expanded-zero.json"))
        starter.api.search_topic(_topic_request(1))
        expanded.api.search_topic(_topic_request(1))
        self.assertEqual(
            starter.coordinator.policy_for(STARTER_ACCESS_SCOPE),
            AccessPolicy.strictest(STARTER_BASELINE_ACCESS_POLICY, operator),
        )
        self.assertEqual(
            expanded.coordinator.policy_for(EXPANDED_ACCESS_SCOPE),
            AccessPolicy.strictest(EXPANDED_BASELINE_ACCESS_POLICY, operator),
        )

    def test_required_key_fails_stably_before_any_network_call(self) -> None:
        products: tuple[_Product, ...] = ("starter", "expanded")
        for product in products:
            for api_key in (None, "", "   "):
                with self.subTest(product=product, api_key=repr(api_key)):
                    environment = _environment(product, api_key=api_key)
                    self.addCleanup(environment.close)
                    result = environment.api.search_topic(_topic_request(1)).providers[0]
                    self.assert_stable_failure(
                        result,
                        expected_code="metadata-provider-credentials-missing",
                    )
                    self.assertEqual(environment.transport.calls, [])
                    self.assertEqual(environment.coordinator.scope_acquisitions, [])

    def test_http_auth_entitlement_and_throttle_failures_are_distinct_and_redacted(self) -> None:
        products: tuple[_Product, ...] = ("starter", "expanded")
        for product in products:
            for status, expected_code in (
                (401, "metadata-provider-authentication-failed"),
                (403, "metadata-provider-entitlement-denied"),
                (429, "metadata-provider-throttled"),
            ):
                with self.subTest(product=product, status=status):
                    environment = _environment(product)
                    self.addCleanup(environment.close)
                    headers = (("Retry-After", "7"),) if status == 429 else ()
                    environment.queue_http_response(status=status, headers=headers)
                    result = environment.api.search_topic(_topic_request(1)).providers[0]
                    self.assert_stable_failure(
                        result,
                        expected_code=expected_code,
                        forbidden_values=(environment.secret_sentinel,),
                    )
                    self.assertEqual(len(environment.transport.calls), 1)
                    if status == 429:
                        self.assertTrue(environment.coordinator.feedback_records)

    def test_throttle_feedback_is_applied_before_scope_permit_release(self) -> None:
        cases: tuple[
            tuple[
                _Product,
                int,
                tuple[tuple[str, str], ...],
                bytes,
                str | None,
            ],
            ...,
        ] = (
            (
                "starter",
                429,
                (("Retry-After", "7"),),
                b"",
                "metadata-provider-throttled",
            ),
            (
                "expanded",
                200,
                (("X-REQ-ReqPerSec-Remaining", "0"),),
                _fixture("expanded-zero.json"),
                None,
            ),
        )
        for product, status, headers, body, expected_failure in cases:
            with self.subTest(product=product):
                environment = _environment(product)
                self.addCleanup(environment.close)
                probe = _FeedbackPermitProbe(environment.coordinator)
                environment.coordinator.feedback_records = probe
                environment.queue_http_response(
                    status=status,
                    headers=headers,
                    body=body,
                )

                result = environment.api.search_topic(_topic_request(1)).providers[0]

                self.assertEqual(
                    result.failure.code if result.failure is not None else None,
                    expected_failure,
                )
                self.assertEqual(len(probe), 1)
                self.assertEqual(probe.active_permit_counts, [1])
                self.assertTrue(probe[0][1].throttled)

    def test_product_credentials_bind_official_origin_and_strip_cross_origin_redirect(
        self,
    ) -> None:
        cases: tuple[tuple[_Product, str, str, str], ...] = (
            (
                "starter",
                "api.clarivate.com",
                "https://redirect.example.org/wos-starter",
                "starter-zero.json",
            ),
            (
                "expanded",
                "wos-api.clarivate.com",
                "https://redirect.example.org/wos-expanded",
                "expanded-zero.json",
            ),
        )
        for product, official_host, redirect_url, fixture_name in cases:
            with self.subTest(product=product):
                environment = _environment(product)
                self.addCleanup(environment.close)
                environment.queue_http_response(
                    status=302,
                    headers=(("Location", redirect_url),),
                )
                environment.queue_http_response(status=200, body=_fixture(fixture_name))

                result = environment.api.search_topic(_topic_request(1)).providers[0]

                self.assertIsNone(result.failure)
                self.assertEqual(len(environment.transport.calls), 2)
                self.assertEqual(
                    urlsplit(environment.transport.calls[0].request.url).hostname,
                    official_host,
                )
                self.assertIn(
                    ("X-ApiKey", environment.secret_sentinel),
                    environment.transport.calls[0].headers,
                )
                self.assertNotIn(
                    ("X-ApiKey", environment.secret_sentinel),
                    environment.transport.calls[1].headers,
                )

    def test_api_key_is_private_header_only_and_repr_is_secret_free(self) -> None:
        cases: tuple[tuple[_Product, str], ...] = (
            ("starter", "starter-zero.json"),
            ("expanded", "expanded-zero.json"),
        )
        for product, fixture_name in cases:
            with self.subTest(product=product):
                seed = _environment(product)
                secret = seed.secret_sentinel
                seed.close()
                environment = _environment(product, api_key=secret)
                self.addCleanup(environment.close)
                environment.queue_http_response(status=200, body=_fixture(fixture_name))
                result = environment.api.search_topic(_topic_request(1)).providers[0]
                call = environment.transport.calls[0]
                self.assertIn(("X-ApiKey", secret), call.headers)
                self.assertNotIn(secret, call.request.url)
                self.assertNotIn(secret, call.wire_target)
                self.assertNotIn(secret, call.request.model_dump_json())
                self.assertNotIn(secret, repr(environment.ports.topic_search))
                self.assertNotIn(secret, result.model_dump_json())
                self.assert_no_private_payload(result, runtime_secret=secret)

    def test_same_fixture_replay_stabilizes_metadata_provenance_and_relation_ids(self) -> None:
        first = _environment("expanded", id_start=100_000)
        second = _environment("expanded", id_start=200_000)
        self.addCleanup(first.close)
        self.addCleanup(second.close)
        second.wall_clock.advance(86_400)
        for environment in (first, second):
            environment.queue_http_response(
                status=200,
                body=_fixture("expanded-references-page-1.json"),
            )
            environment.queue_http_response(
                status=200,
                body=_fixture("expanded-references-page-2.json"),
            )
        left = first.api.query_references(_reference_request("references")).providers[0]
        right = second.api.query_references(_reference_request("references")).providers[0]
        self.assertEqual(
            tuple(relation.observation_id for relation in left.relations),
            tuple(relation.observation_id for relation in right.relations),
        )
        self.assertEqual(
            tuple(relation.provenance.provenance_id for relation in left.relations),
            tuple(relation.provenance.provenance_id for relation in right.relations),
        )
        self.assertNotEqual(
            left.relations[0].provenance.observed_at,
            right.relations[0].provenance.observed_at,
        )
        self.assertNotEqual(left.relations[0].observation_id, left.relations[1].observation_id)

        starter_one = _environment("starter", id_start=300_000)
        starter_two = _environment("starter", id_start=400_000)
        self.addCleanup(starter_one.close)
        self.addCleanup(starter_two.close)
        starter_two.wall_clock.advance(3600)
        for environment in (starter_one, starter_two):
            environment.queue_http_response(status=200, body=_fixture("starter-lookup.json"))
        first_observation = starter_one.api.lookup(
            _lookup_request(ProviderLiteratureKey(record_id=_STARTER_UID))
        ).observations[0]
        second_observation = starter_two.api.lookup(
            _lookup_request(ProviderLiteratureKey(record_id=_STARTER_UID))
        ).observations[0]
        self.assertEqual(first_observation.observation_id, second_observation.observation_id)
        self.assertEqual(
            first_observation.provenance.provenance_id,
            second_observation.provenance.provenance_id,
        )
        self.assertNotEqual(
            first_observation.provenance.observed_at,
            second_observation.provenance.observed_at,
        )

    def test_factory_programming_errors_and_cancellation_propagate(self) -> None:
        def runtime_error() -> ObservationId:
            raise RuntimeError("temporary ID factory bug")

        def cancelled() -> ObservationId:
            raise asyncio.CancelledError

        for factory, expected in (
            (runtime_error, RuntimeError),
            (cancelled, asyncio.CancelledError),
        ):
            with self.subTest(expected=expected.__name__):
                environment = _environment(
                    "starter",
                    observation_id_factory=factory,
                )
                self.addCleanup(environment.close)
                environment.queue_http_response(status=200, body=_fixture("starter-lookup.json"))
                with self.assertRaises(expected):
                    environment.api.lookup(
                        _lookup_request(ProviderLiteratureKey(record_id=_STARTER_UID))
                    )

    def test_product_database_and_edition_change_provenance_parameter_identity(self) -> None:
        starter = _environment("starter", database="WOS", edition="core")
        expanded = _environment("expanded", database="WOS", edition="core")
        alternate = _environment("expanded", database="WOS", edition="alternate")
        self.addCleanup(starter.close)
        self.addCleanup(expanded.close)
        self.addCleanup(alternate.close)
        starter.queue_http_response(status=200, body=_fixture("starter-lookup.json"))
        expanded.queue_http_response(status=200, body=_fixture("expanded-lookup.json"))
        alternate.queue_http_response(status=200, body=_fixture("expanded-lookup.json"))
        starter_hash = (
            starter.api.lookup(_lookup_request(ProviderLiteratureKey(record_id=_STARTER_UID)))
            .observations[0]
            .provenance.parameters_sha256
        )
        expanded_hash = (
            expanded.api.lookup(_lookup_request(ProviderLiteratureKey(record_id=_EXPANDED_UID)))
            .observations[0]
            .provenance.parameters_sha256
        )
        alternate_hash = (
            alternate.api.lookup(_lookup_request(ProviderLiteratureKey(record_id=_EXPANDED_UID)))
            .observations[0]
            .provenance.parameters_sha256
        )
        self.assertIsNotNone(starter_hash)
        self.assertIsNotNone(expanded_hash)
        self.assertIsNotNone(alternate_hash)
        self.assertNotEqual(starter_hash, expanded_hash)
        self.assertNotEqual(expanded_hash, alternate_hash)

    def test_lookup_404_is_empty_while_oversize_response_is_bounded(self) -> None:
        cases: tuple[tuple[_Product, str], ...] = (
            ("starter", _STARTER_UID),
            ("expanded", _EXPANDED_UID),
        )
        for product, uid in cases:
            environment = _environment(product)
            self.addCleanup(environment.close)
            environment.queue_http_response(status=404)
            missing = environment.api.lookup(_lookup_request(ProviderLiteratureKey(record_id=uid)))
            self.assertEqual(missing.outcome, "EXHAUSTED")
            self.assertEqual(missing.raw_item_count, 0)
            self.assertEqual(missing.observations, ())
            self.assertIsNone(missing.failure)

            environment.reset_http()
            environment.queue_http_response(status=200, body=b" " * 4_300_000)
            oversized = environment.api.search_topic(_topic_request(2)).providers[0]
            self.assert_stable_failure(
                oversized,
                expected_code="metadata-provider-response-too-large",
            )

    def test_fixtures_are_parseable_redacted_and_contain_no_lite_contract(self) -> None:
        fixture_paths = tuple(_FIXTURES.glob("*.json"))
        self.assertTrue(fixture_paths)
        for path in fixture_paths:
            raw = path.read_bytes()
            self.assertNotIn(b"X-ApiKey", raw)
            self.assertNotIn(b"woslite", raw.lower())
            if "malformed" not in path.name:
                json.loads(raw)
