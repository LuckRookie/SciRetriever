from __future__ import annotations

import asyncio
import json
import unittest
from collections.abc import Callable
from pathlib import Path
from typing import cast
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
    ProviderContractCase,
)

from sciretriever.literature.metadata import accept_observation
from sciretriever.metadata.ports import (
    MetadataLookupPort,
    ReferenceQueryPort,
    TopicSearchPort,
)
from sciretriever.metadata.providers.core import ACCESS_SCOPE as CORE_ACCESS_SCOPE
from sciretriever.metadata.providers.core import (
    BASELINE_ACCESS_POLICY as CORE_BASELINE_ACCESS_POLICY,
)
from sciretriever.metadata.providers.core import CoreAdapter
from sciretriever.metadata.providers.datacite import ACCESS_SCOPE as DATACITE_ACCESS_SCOPE
from sciretriever.metadata.providers.datacite import (
    BASELINE_ACCESS_POLICY as DATACITE_BASELINE_ACCESS_POLICY,
)
from sciretriever.metadata.providers.datacite import DataCiteAdapter
from sciretriever.metadata.providers.europe_pmc import ACCESS_SCOPE as EPMC_ACCESS_SCOPE
from sciretriever.metadata.providers.europe_pmc import (
    BASELINE_ACCESS_POLICY as EPMC_BASELINE_ACCESS_POLICY,
)
from sciretriever.metadata.providers.europe_pmc import EuropePmcAdapter
from sciretriever.metadata.rules import (
    MetadataLookupRequest,
    MetadataProviderResult,
    MetadataReferenceQueryRequest,
    ProviderReferenceQuery,
    ReferenceQueryDirection,
)
from sciretriever.model.acquisition import AssetHint, AssetHintKind, AssetRole
from sciretriever.model.discovery import ProviderDiscoveryLimit, TopicDiscoveryInput
from sciretriever.model.literature import (
    Identifier,
    Literature,
    LiteratureStatus,
    VersionRole,
)
from sciretriever.model.metadata import ProviderLiteratureKey
from sciretriever.model.primitives import (
    LiteratureId,
    MetaLiteratureId,
    ObservationId,
    ProvenanceId,
    UtcTimestamp,
    sha256_digest,
)
from sciretriever.network.admission import (
    AccessPermit,
    AccessPolicy,
    AccessScope,
    AdmissionTimeout,
)

_FIXTURES = Path(__file__).parent / "fixtures" / "metadata"


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


def _fixture(provider: str, name: str) -> bytes:
    return (_FIXTURES / provider / name).read_bytes()


def _wall_timestamp(environment: ContractEnvironment) -> UtcTimestamp:
    return UtcTimestamp(environment.wall_clock().isoformat().replace("+00:00", "Z"))


def _topic_request(provider_name: str, scan_limit: int) -> TopicDiscoveryInput:
    return TopicDiscoveryInput(
        kind="topic",
        query="retrieval systems",
        year_from=2020,
        year_to=2025,
        providers=(
            ProviderDiscoveryLimit(
                provider_name=provider_name,
                scan_limit=scan_limit,
            ),
        ),
    )


def _reference_request(
    provider_name: str,
    key: ProviderLiteratureKey,
    *,
    direction: ReferenceQueryDirection,
    scan_limit: int = 20,
) -> MetadataReferenceQueryRequest:
    return MetadataReferenceQueryRequest(
        direction=direction,
        providers=(
            ProviderReferenceQuery(
                provider_name=provider_name,
                keys=(key,),
                scan_limit=scan_limit,
            ),
        ),
    )


_EPMC_KEY = ProviderLiteratureKey(
    record_id="MED:32939066",
    identifiers=(
        Identifier(namespace="pmid", value="32939066"),
        Identifier(namespace="pmcid", value="PMC7759461"),
        Identifier(namespace="doi", value="10.5555/epmc.article"),
    ),
)
_DATACITE_KEY = ProviderLiteratureKey(
    record_id="10.5555/datacite.article",
    identifiers=(Identifier(namespace="doi", value="10.5555/datacite.article"),),
)
_CORE_KEY = ProviderLiteratureKey(
    record_id="work:143262545",
    identifiers=(Identifier(namespace="doi", value="10.5555/shared.epmc.core"),),
)


def _europe_pmc_ports(
    environment: ContractEnvironment,
    *,
    observation_factory: Callable[[], ObservationId] | None = None,
) -> ContractPorts:
    ids = _IdFactories(100)
    adapter = EuropePmcAdapter(
        http_client=environment.http_client,
        access_coordinator=environment.coordinator,
        access_scope=environment.scope,
        access_policy=environment.policy,
        observation_id_factory=observation_factory or ids.observation,
        provenance_id_factory=ids.provenance,
        clock=lambda: _wall_timestamp(environment),
        page_size=2,
    )
    return ContractPorts(topic_search=adapter, lookup=adapter, reference_query=adapter)


def _datacite_ports(
    environment: ContractEnvironment,
    *,
    observation_factory: Callable[[], ObservationId] | None = None,
) -> ContractPorts:
    ids = _IdFactories(1_000)
    adapter = DataCiteAdapter(
        http_client=environment.http_client,
        access_coordinator=environment.coordinator,
        access_scope=environment.scope,
        access_policy=environment.policy,
        observation_id_factory=observation_factory or ids.observation,
        provenance_id_factory=ids.provenance,
        clock=lambda: _wall_timestamp(environment),
        page_size=3,
    )
    return ContractPorts(topic_search=adapter, lookup=adapter, reference_query=adapter)


def _core_ports(
    environment: ContractEnvironment,
    *,
    observation_factory: Callable[[], ObservationId] | None = None,
    api_key: str | None = None,
) -> ContractPorts:
    ids = _IdFactories(2_000)
    adapter = CoreAdapter(
        http_client=environment.http_client,
        access_coordinator=environment.coordinator,
        access_scope=environment.scope,
        access_policy=environment.policy,
        observation_id_factory=observation_factory or ids.observation,
        provenance_id_factory=ids.provenance,
        clock=lambda: _wall_timestamp(environment),
        page_size=2,
        api_key=api_key,
    )
    return ContractPorts(topic_search=adapter, lookup=adapter, reference_query=adapter)


def _environment(
    provider_name: str,
    *,
    observation_factory: Callable[[], ObservationId] | None = None,
    core_api_key: str | None = None,
) -> ContractEnvironment:
    def assemble(environment: ContractEnvironment) -> ContractPorts:
        if provider_name == "europe-pmc":
            return _europe_pmc_ports(environment, observation_factory=observation_factory)
        if provider_name == "datacite":
            return _datacite_ports(environment, observation_factory=observation_factory)
        if provider_name == "core":
            return _core_ports(
                environment,
                observation_factory=observation_factory,
                api_key=core_api_key,
            )
        raise AssertionError("unsupported test provider")

    return ContractEnvironment(
        provider_name=provider_name,
        capabilities=frozenset({"search", "lookup", "references"}),
        port_factory=assemble,
        expected_scope={
            "europe-pmc": EPMC_ACCESS_SCOPE,
            "datacite": DATACITE_ACCESS_SCOPE,
            "core": CORE_ACCESS_SCOPE,
        }[provider_name],
    )


def _queue_throttled(environment: ContractEnvironment) -> None:
    headers: tuple[tuple[str, str], ...]
    if environment.provider_name == "core":
        headers = (
            ("X-RateLimit-Remaining", "0"),
            ("X-RateLimit-Retry-After", "6"),
        )
    else:
        headers = (("Retry-After", "6"),)
    environment.queue_http_response(status=429, headers=headers)


def _feedback_evidence(
    contract: ProviderContractCase,
    environment: ContractEnvironment,
    result: MetadataProviderResult,
) -> None:
    case = contract._test_case()
    case.assertEqual(len(environment.transport.calls), 1)
    case.assertEqual(len(environment.coordinator.feedback_records), 1)
    case.assertEqual(
        result.failure.code if result.failure is not None else None,
        "metadata-provider-throttled",
    )


def _queue_epmc_search(environment: ContractEnvironment) -> None:
    environment.queue_http_response(
        status=200,
        body=_fixture("europe_pmc", "search-page-1.json"),
    )
    environment.queue_http_response(
        status=200,
        body=_fixture("europe_pmc", "search-page-2.json"),
    )


def _queue_epmc_lookup(environment: ContractEnvironment) -> None:
    environment.queue_http_response(status=200, body=_fixture("europe_pmc", "lookup.json"))


def _queue_epmc_references(environment: ContractEnvironment) -> None:
    environment.queue_http_response(
        status=200,
        body=_fixture("europe_pmc", "references-page-1.json"),
    )
    environment.queue_http_response(
        status=200,
        body=_fixture("europe_pmc", "references-page-2.json"),
    )
    environment.queue_http_response(
        status=200,
        body=_fixture("europe_pmc", "citations.json"),
    )


def _epmc_search_evidence(
    contract: ProviderContractCase,
    environment: ContractEnvironment,
    result: MetadataProviderResult,
) -> None:
    case = contract._test_case()
    case.assertEqual(len(environment.transport.calls), 2)
    first = parse_qs(urlsplit(environment.transport.calls[0].request.url).query)
    second = parse_qs(urlsplit(environment.transport.calls[1].request.url).query)
    case.assertEqual(first["cursorMark"], ["*"])
    case.assertEqual(second["cursorMark"], ["AoIIPMC+/two=="])
    case.assertEqual(result.observations[0].metadata.title, "A Europe PMC article")


def _epmc_lookup_evidence(
    contract: ProviderContractCase,
    environment: ContractEnvironment,
    result: MetadataProviderResult,
) -> None:
    case = contract._test_case()
    query = parse_qs(urlsplit(environment.transport.calls[0].request.url).query)
    case.assertEqual(query["query"], ["PMCID:PMC7759461"])
    case.assertEqual(result.observations[0].provenance.source_record_id, "MED:32939066")


def _epmc_reference_evidence(
    contract: ProviderContractCase,
    environment: ContractEnvironment,
    result: MetadataProviderResult,
) -> None:
    case = contract._test_case()
    case.assertEqual(len(environment.transport.calls), 3)
    case.assertEqual(
        tuple(relation.citing.record_id for relation in result.relations),
        ("MED:32939066", "MED:32939066", "MED:22222222"),
    )
    case.assertEqual(
        tuple(relation.cited.record_id for relation in result.relations),
        ("MED:11111111", None, "MED:32939066"),
    )


def _queue_epmc_partial(environment: ContractEnvironment) -> None:
    environment.queue_http_response(
        status=200,
        body=_fixture("europe_pmc", "search-page-1.json"),
    )
    environment.queue_http_response(
        status=200,
        body=_fixture("europe_pmc", "malformed.json"),
    )


def _partial_evidence(
    contract: ProviderContractCase,
    environment: ContractEnvironment,
    result: MetadataProviderResult,
) -> None:
    contract._test_case().assertEqual(len(environment.transport.calls), 2)
    contract._test_case().assertGreater(len(result.observations), 0)


def _queue_datacite_search(environment: ContractEnvironment) -> None:
    environment.queue_http_response(
        status=200,
        body=_fixture("datacite", "search-page-1.json"),
    )
    environment.queue_http_response(
        status=200,
        body=_fixture("datacite", "search-page-2.json"),
    )


def _queue_datacite_lookup(environment: ContractEnvironment) -> None:
    environment.queue_http_response(status=200, body=_fixture("datacite", "lookup.json"))


def _datacite_search_evidence(
    contract: ProviderContractCase,
    environment: ContractEnvironment,
    result: MetadataProviderResult,
) -> None:
    case = contract._test_case()
    case.assertEqual(len(environment.transport.calls), 2)
    first = parse_qs(urlsplit(environment.transport.calls[0].request.url).query)
    case.assertEqual(first["page[cursor]"], ["1"])
    case.assertIn("opaque%2Btwo%3D%3D", environment.transport.calls[1].request.url)
    case.assertEqual(len(result.observations), 3)


def _datacite_lookup_evidence(
    contract: ProviderContractCase,
    environment: ContractEnvironment,
    result: MetadataProviderResult,
) -> None:
    case = contract._test_case()
    case.assertEqual(
        urlsplit(environment.transport.calls[0].request.url).path,
        "/dois/10.5555%2Fdatacite.article",
    )
    case.assertEqual(len(result.observations[0].version_links), 1)


def _datacite_reference_evidence(
    contract: ProviderContractCase,
    environment: ContractEnvironment,
    result: MetadataProviderResult,
) -> None:
    case = contract._test_case()
    case.assertEqual(len(environment.transport.calls), 1)
    case.assertEqual(
        tuple(relation.citing.record_id for relation in result.relations),
        ("10.5555/datacite.article", "10.5555/datacite.citing.one"),
    )
    case.assertEqual(
        tuple(relation.cited.record_id for relation in result.relations),
        ("10.5555/datacite.ref.one", "10.5555/datacite.article"),
    )


def _queue_datacite_partial(environment: ContractEnvironment) -> None:
    environment.queue_http_response(
        status=200,
        body=_fixture("datacite", "search-page-1.json"),
    )
    environment.queue_http_response(
        status=200,
        body=_fixture("datacite", "malformed.json"),
    )


def _queue_core_search(environment: ContractEnvironment) -> None:
    environment.queue_http_response(status=200, body=_fixture("core", "search-page-1.json"))
    environment.queue_http_response(status=200, body=_fixture("core", "search-page-2.json"))


def _queue_core_lookup(environment: ContractEnvironment) -> None:
    environment.queue_http_response(status=200, body=_fixture("core", "lookup-work.json"))


def _core_search_evidence(
    contract: ProviderContractCase,
    environment: ContractEnvironment,
    result: MetadataProviderResult,
) -> None:
    case = contract._test_case()
    case.assertEqual(len(environment.transport.calls), 2)
    first = parse_qs(urlsplit(environment.transport.calls[0].request.url).query)
    second = parse_qs(urlsplit(environment.transport.calls[1].request.url).query)
    case.assertEqual(first["offset"], ["0"])
    case.assertEqual(second["offset"], ["2"])
    case.assertNotIn("scroll", first)
    case.assertNotIn("cursor", first)
    case.assertEqual(result.observations[0].provenance.source_record_id, "work:143262545")


def _core_lookup_evidence(
    contract: ProviderContractCase,
    environment: ContractEnvironment,
    result: MetadataProviderResult,
) -> None:
    case = contract._test_case()
    case.assertEqual(
        urlsplit(environment.transport.calls[0].request.url).path,
        "/v3/works/143262545",
    )
    case.assertEqual(result.observations[0].provenance.source_record_id, "work:143262545")


def _core_reference_evidence(
    contract: ProviderContractCase,
    environment: ContractEnvironment,
    result: MetadataProviderResult,
) -> None:
    case = contract._test_case()
    case.assertEqual(len(environment.transport.calls), 1)
    case.assertEqual(
        tuple(relation.citing.record_id for relation in result.relations),
        ("work:143262545", "work:143262545"),
    )


def _queue_core_partial(environment: ContractEnvironment) -> None:
    environment.queue_http_response(status=200, body=_fixture("core", "search-page-1.json"))
    environment.queue_http_response(status=200, body=_fixture("core", "malformed.json"))


def _epmc_binding() -> ContractBinding:
    return ContractBinding(
        provider_name="europe-pmc",
        capabilities=frozenset({"search", "lookup", "references"}),
        expected_scope=EPMC_ACCESS_SCOPE,
        credential_mode="none",
        port_factory=_europe_pmc_ports,
        scenarios=(
            ContractScenario(
                name="cursor-search",
                capability="search",
                request=_topic_request("europe-pmc", 10),
                prepare=_queue_epmc_search,
                expected=ContractExpectedResult(
                    outcome="EXHAUSTED",
                    raw_item_count=3,
                    observation_count=3,
                    relation_count=0,
                ),
                evidence=_epmc_search_evidence,
            ),
            ContractScenario(
                name="pmcid-lookup",
                capability="lookup",
                request=MetadataLookupRequest(
                    provider_name="europe-pmc",
                    key=ProviderLiteratureKey(
                        identifiers=(Identifier(namespace="pmcid", value="PMC7759461"),)
                    ),
                    scan_limit=2,
                ),
                prepare=_queue_epmc_lookup,
                expected=ContractExpectedResult(
                    outcome="EXHAUSTED",
                    raw_item_count=1,
                    observation_count=1,
                    relation_count=0,
                ),
                evidence=_epmc_lookup_evidence,
            ),
            ContractScenario(
                name="references-and-citations",
                capability="references",
                request=_reference_request("europe-pmc", _EPMC_KEY, direction="both"),
                prepare=_queue_epmc_references,
                expected=ContractExpectedResult(
                    outcome="EXHAUSTED",
                    raw_item_count=4,
                    observation_count=6,
                    relation_count=3,
                ),
                evidence=_epmc_reference_evidence,
            ),
            ContractScenario(
                name="retry-after-feedback",
                capability="search",
                request=_topic_request("europe-pmc", 2),
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
                name="malformed-second-page-keeps-partial",
                capability="search",
                request=_topic_request("europe-pmc", 10),
                prepare=_queue_epmc_partial,
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


def _datacite_binding() -> ContractBinding:
    return ContractBinding(
        provider_name="datacite",
        capabilities=frozenset({"search", "lookup", "references"}),
        expected_scope=DATACITE_ACCESS_SCOPE,
        credential_mode="none",
        port_factory=_datacite_ports,
        scenarios=(
            ContractScenario(
                name="jsonapi-cursor-search",
                capability="search",
                request=_topic_request("datacite", 10),
                prepare=_queue_datacite_search,
                expected=ContractExpectedResult(
                    outcome="EXHAUSTED",
                    raw_item_count=4,
                    observation_count=3,
                    relation_count=2,
                ),
                evidence=_datacite_search_evidence,
            ),
            ContractScenario(
                name="doi-path-lookup",
                capability="lookup",
                request=MetadataLookupRequest(
                    provider_name="datacite",
                    key=_DATACITE_KEY,
                    scan_limit=2,
                ),
                prepare=_queue_datacite_lookup,
                expected=ContractExpectedResult(
                    outcome="EXHAUSTED",
                    raw_item_count=1,
                    observation_count=1,
                    relation_count=2,
                ),
                evidence=_datacite_lookup_evidence,
            ),
            ContractScenario(
                name="metadata-embedded-reference-query",
                capability="references",
                request=_reference_request("datacite", _DATACITE_KEY, direction="both"),
                prepare=_queue_datacite_lookup,
                expected=ContractExpectedResult(
                    outcome="EXHAUSTED",
                    raw_item_count=1,
                    observation_count=1,
                    relation_count=2,
                ),
                evidence=_datacite_reference_evidence,
            ),
            ContractScenario(
                name="retry-after-feedback",
                capability="search",
                request=_topic_request("datacite", 2),
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
                name="malformed-second-page-keeps-partial",
                capability="search",
                request=_topic_request("datacite", 10),
                prepare=_queue_datacite_partial,
                expected=ContractExpectedResult(
                    outcome="FAILED",
                    raw_item_count=3,
                    observation_count=2,
                    relation_count=2,
                    failure_code="metadata-provider-malformed-json",
                ),
                evidence=_partial_evidence,
            ),
        ),
    )


def _core_binding() -> ContractBinding:
    return ContractBinding(
        provider_name="core",
        capabilities=frozenset({"search", "lookup", "references"}),
        expected_scope=CORE_ACCESS_SCOPE,
        credential_mode="none",
        port_factory=_core_ports,
        scenarios=(
            ContractScenario(
                name="offset-search",
                capability="search",
                request=_topic_request("core", 10),
                prepare=_queue_core_search,
                expected=ContractExpectedResult(
                    outcome="EXHAUSTED",
                    raw_item_count=3,
                    observation_count=3,
                    relation_count=2,
                ),
                evidence=_core_search_evidence,
            ),
            ContractScenario(
                name="work-lookup",
                capability="lookup",
                request=MetadataLookupRequest(
                    provider_name="core",
                    key=_CORE_KEY,
                    scan_limit=2,
                ),
                prepare=_queue_core_lookup,
                expected=ContractExpectedResult(
                    outcome="EXHAUSTED",
                    raw_item_count=1,
                    observation_count=1,
                    relation_count=2,
                ),
                evidence=_core_lookup_evidence,
            ),
            ContractScenario(
                name="outgoing-references",
                capability="references",
                request=_reference_request("core", _CORE_KEY, direction="references"),
                prepare=_queue_core_lookup,
                expected=ContractExpectedResult(
                    outcome="EXHAUSTED",
                    raw_item_count=1,
                    observation_count=1,
                    relation_count=2,
                ),
                evidence=_core_reference_evidence,
            ),
            ContractScenario(
                name="token-quota-feedback",
                capability="search",
                request=_topic_request("core", 2),
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
                name="malformed-second-page-keeps-partial",
                capability="search",
                request=_topic_request("core", 10),
                prepare=_queue_core_partial,
                expected=ContractExpectedResult(
                    outcome="FAILED",
                    raw_item_count=2,
                    observation_count=2,
                    relation_count=2,
                    failure_code="metadata-provider-malformed-json",
                ),
                evidence=_partial_evidence,
            ),
        ),
    )


class EuropePmcAdapterTests(ProviderContractCase, unittest.TestCase):
    def provider_contract_binding(self) -> ContractBinding:
        return _epmc_binding()

    def _environment(self) -> ContractEnvironment:
        environment = _environment("europe-pmc")
        self.addCleanup(environment.close)
        return environment

    def test_search_maps_bibliographic_author_identifier_and_locator_semantics(self) -> None:
        environment = self._environment()
        page_one = _fixture("europe_pmc", "search-page-1.json")
        _queue_epmc_search(environment)
        result = self.assert_topic_scan(
            environment,
            _topic_request("europe-pmc", 10),
            outcome="EXHAUSTED",
            raw_item_count=3,
            observation_count=3,
        )
        observation = result.observations[0]
        metadata = observation.metadata
        self.assertEqual(metadata.title, "A Europe PMC article")
        self.assertEqual(metadata.abstract, "A biomedical abstract.")
        self.assertEqual(metadata.publication_date, "2024-04-03")
        self.assertEqual(metadata.publication_year, 2024)
        self.assertEqual(metadata.document_type, "journal-article")
        self.assertEqual(metadata.language, "eng")
        self.assertEqual(metadata.venue, "Journal of Biomedical Retrieval")
        self.assertEqual(metadata.volume, "12")
        self.assertEqual(metadata.issue, "4")
        self.assertEqual(metadata.pages, "101-119")
        self.assertEqual(metadata.keywords, ())
        self.assertEqual(
            observation.declared_keywords,
            ("source-declared one", "source-declared two"),
        )
        self.assertEqual(observation.cited_by_count, 8)
        self.assertIsNone(observation.reference_count)
        self.assert_author_mapping(
            metadata.authors,
            (
                ExpectedAuthor(
                    kind="person",
                    display_name="Ada Example",
                    given_name="Ada",
                    family_name="Example",
                    orcid="0000-0002-1825-0097",
                    affiliations=(ExpectedAffiliation(name="Biomedical Retrieval Institute"),),
                ),
                ExpectedAuthor(
                    kind="organization",
                    display_name="Europe PMC Research Consortium",
                    affiliations=(ExpectedAffiliation(name="Consortium Office"),),
                ),
                ExpectedAuthor(
                    kind="unknown",
                    display_name="Noorcid Example",
                    given_name="Noorcid",
                    family_name="Example",
                ),
            ),
        )
        self.assert_identifier_record_id_separation(
            observation,
            expected_identifiers=(
                Identifier(namespace="pmid", value="32939066"),
                Identifier(namespace="pmcid", value="PMC7759461"),
                Identifier(namespace="doi", value="10.5555/epmc.article"),
            ),
            expected_record_id="MED:32939066",
            forbidden_record_ids=("MED:32939066",),
        )
        self.assert_asset_hints(
            observation,
            (
                AssetHint(
                    url="https://europepmc.org/articles/PMC7759461",
                    kind=AssetHintKind.LANDING_PAGE,
                    media_type="text/html",
                    asset_role=AssetRole.HTML,
                    access_status="Open access",
                ),
                AssetHint(
                    url="https://europepmc.org/articles/PMC7759461?pdf=render",
                    kind=AssetHintKind.DIRECT_FILE,
                    media_type="application/pdf",
                    asset_role=AssetRole.PRIMARY_PDF,
                    access_status="Open access",
                ),
                AssetHint(
                    url="https://doi.org/10.5555/EPMC.ARTICLE",
                    kind=AssetHintKind.LANDING_PAGE,
                    access_status="Subscription required",
                ),
            ),
            runtime_secret=environment.secret_sentinel,
        )
        self.assertEqual(observation.provenance.input_sha256, sha256_digest(page_one))
        self.assert_no_private_payload(
            result,
            runtime_secret=environment.secret_sentinel,
            forbidden_values=(
                "AoIIPMC+/two==",
                "private-script",
                "provider-index-topic-must-not-leak",
                "fixture-secret-must-not-leak",
                "fixture-nlmid",
            ),
        )

    def test_search_is_lazy_and_reference_directions_are_canonical(self) -> None:
        environment = self._environment()
        environment.queue_http_response(
            status=200,
            body=_fixture("europe_pmc", "search-page-1.json"),
        )
        limited = self.assert_topic_scan(
            environment,
            _topic_request("europe-pmc", 1),
            outcome="SCAN_LIMIT_REACHED",
            raw_item_count=1,
            observation_count=1,
        )
        self.assertEqual(len(environment.transport.calls), 1)
        self.assertEqual(limited.observations[0].metadata.title, "A Europe PMC article")

        environment.reset_http()
        _queue_epmc_references(environment)
        relations = self.assert_reference_scan(
            environment,
            _reference_request("europe-pmc", _EPMC_KEY, direction="both"),
            outcome="EXHAUSTED",
            raw_item_count=4,
            observation_count=6,
            relation_count=3,
        )
        self.assertEqual(
            tuple(
                text
                for observation in relations.observations
                for text in observation.reference_texts
            ),
            (
                "First reference text, in cited order.",
                "Second reference text, in cited order.",
                "Third reference text without a stable target.",
            ),
        )
        self.assert_citing_to_cited(
            relations.relations[0],
            citing=_EPMC_KEY,
            cited=ProviderLiteratureKey(
                record_id="MED:11111111",
                identifiers=(Identifier(namespace="doi", value="10.5555/epmc.ref.one"),),
            ),
        )
        self.assert_citing_to_cited(
            relations.relations[1],
            citing=_EPMC_KEY,
            cited=ProviderLiteratureKey(
                identifiers=(Identifier(namespace="doi", value="10.5555/epmc.ref.two"),)
            ),
        )
        self.assert_citing_to_cited(
            relations.relations[2],
            citing=ProviderLiteratureKey(
                record_id="MED:22222222",
                identifiers=(Identifier(namespace="doi", value="10.5555/epmc.citing.one"),),
            ),
            cited=_EPMC_KEY,
        )
        paths = tuple(urlsplit(call.request.url).path for call in environment.transport.calls)
        self.assertEqual(
            paths,
            (
                "/europepmc/webservices/rest/MED/32939066/references",
                "/europepmc/webservices/rest/MED/32939066/references",
                "/europepmc/webservices/rest/MED/32939066/citations",
            ),
        )


class DataCiteAdapterTests(ProviderContractCase, unittest.TestCase):
    def provider_contract_binding(self) -> ContractBinding:
        return _datacite_binding()

    def _environment(self) -> ContractEnvironment:
        environment = _environment("datacite")
        self.addCleanup(environment.close)
        return environment

    def test_search_filters_non_literature_and_delivers_incomplete_literature_observation(
        self,
    ) -> None:
        environment = self._environment()
        page_one = _fixture("datacite", "search-page-1.json")
        _queue_datacite_search(environment)
        result = self.assert_topic_scan(
            environment,
            _topic_request("datacite", 10),
            outcome="EXHAUSTED",
            raw_item_count=4,
            observation_count=3,
            relation_count=2,
        )
        article, incomplete, preprint = result.observations
        metadata = article.metadata
        self.assertEqual(metadata.title, "A DataCite journal article")
        self.assertEqual(metadata.abstract, "A DataCite abstract.")
        self.assertEqual(metadata.publication_date, "2024-05-06")
        self.assertEqual(metadata.publication_year, 2024)
        self.assertEqual(metadata.document_type, "journal-article")
        self.assertEqual(metadata.venue, "Journal of DOI Contracts")
        self.assertEqual(metadata.publisher, "Example DOI Publisher")
        self.assertEqual(metadata.volume, "7")
        self.assertEqual(metadata.issue, "2")
        self.assertEqual(metadata.pages, "15-29")
        self.assertEqual(article.reference_count, 2)
        self.assertEqual(article.cited_by_count, 3)
        self.assertEqual(article.declared_keywords, ())
        self.assert_author_mapping(
            metadata.authors,
            (
                ExpectedAuthor(
                    kind="person",
                    display_name="Example, Ada",
                    given_name="Ada",
                    family_name="Example",
                    orcid="0000-0002-1825-0097",
                    affiliations=(
                        ExpectedAffiliation(
                            name="DataCite Research Institute",
                            ror="03yrm5c26",
                        ),
                    ),
                ),
                ExpectedAuthor(
                    kind="organization",
                    display_name="DataCite Literature Consortium",
                    affiliations=(ExpectedAffiliation(name="Consortium Office"),),
                ),
                ExpectedAuthor(
                    kind="person",
                    display_name="No Type Orcid",
                    orcid="0000-0001-5109-3700",
                ),
            ),
        )
        self.assert_identifier_record_id_separation(
            article,
            expected_identifiers=(Identifier(namespace="doi", value="10.5555/datacite.article"),),
            expected_record_id="10.5555/datacite.article",
        )
        self.assert_version_links(
            article,
            (
                ProviderLiteratureKey(
                    record_id="10.5555/datacite.version.one",
                    identifiers=(
                        Identifier(namespace="doi", value="10.5555/datacite.version.one"),
                    ),
                ),
            ),
        )
        self.assert_asset_hints(
            article,
            (
                AssetHint(
                    url="https://repository.example.org/articles/datacite-article",
                    kind=AssetHintKind.LANDING_PAGE,
                ),
                AssetHint(
                    url="https://repository.example.org/files/datacite-article.pdf",
                    kind=AssetHintKind.DIRECT_FILE,
                ),
                AssetHint(
                    url="https://repository.example.org/files/datacite-data.zip",
                    kind=AssetHintKind.DIRECT_FILE,
                ),
            ),
            runtime_secret=environment.secret_sentinel,
        )
        self.assertEqual(incomplete.provenance.source_record_id, "fixture-text-source-record")
        self.assertIsNone(incomplete.metadata.title)
        self.assertEqual(incomplete.metadata.identifiers, ())
        rejection = accept_observation(incomplete)
        self.assertEqual(rejection.outcome, "rejected")
        self.assertEqual(rejection.reason, "missing-title-or-doi")
        self.assertEqual(preprint.version_role, VersionRole.PREPRINT)
        self.assertNotIn("10.5555/datacite.dataset", result.model_dump_json())
        self.assertEqual(article.provenance.input_sha256, sha256_digest(page_one))
        self.assert_no_private_payload(
            result,
            runtime_secret=environment.secret_sentinel,
            forbidden_values=(
                "opaque+two==",
                "classification-must-not-be-keyword",
                "Editor Must Not Become Author",
                "private-dataset.zip",
                "fixture-secret-must-not-leak",
                "privateIncompleteCandidate",
                "not-a-doi-private-container",
            ),
        )

    def test_100_raw_items_have_complete_auditable_dispositions(self) -> None:
        environment = self._environment()
        records: list[dict[str, object]] = []
        for index in range(1, 101):
            is_literature = index <= 51
            doi = f"10.5555/disposition-{index:03d}"
            records.append(
                {
                    "type": "dois",
                    "id": doi,
                    "attributes": {
                        "doi": doi,
                        "titles": [
                            {
                                "title": (
                                    f"Auditable article {index}"
                                    if is_literature
                                    else "vendor-body-sentinel-must-not-leak"
                                )
                            }
                        ],
                        "types": {
                            "resourceTypeGeneral": (
                                "JournalArticle" if is_literature else "Dataset"
                            )
                        },
                        "privateFixtureField": "vendor-body-sentinel-must-not-leak",
                    },
                }
            )
        environment.queue_http_response(
            status=200,
            body=json.dumps(
                {
                    "data": records,
                    "links": {"self": "https://api.datacite.org/dois?page[cursor]=1"},
                },
                separators=(",", ":"),
            ).encode("utf-8"),
        )

        with self.assertLogs("sciretriever.metadata.service", level="DEBUG") as captured:
            result = environment.api.search_topic(_topic_request("datacite", 100)).providers[0]

        output = "\n".join(captured.output)
        self.assertEqual(result.outcome, "EXHAUSTED")
        self.assertEqual(result.raw_item_count, 100)
        self.assertEqual(len(result.observations), 51)
        self.assertEqual(len(result.relations), 0)
        self.assertEqual(output.count(" disposition=accepted "), 51)
        self.assertEqual(output.count(" disposition=empty "), 49)
        self.assertEqual(output.count(" disposition=rejected "), 0)
        self.assertEqual(
            output.count("reason=datacite-resource-type-not-supported-as-literature"),
            49,
        )
        self.assertIn("raw_item_count=100", output)
        self.assertIn("accepted_item_count=51", output)
        self.assertIn("empty_item_count=49", output)
        self.assertIn("rejected_record_count=0", output)
        self.assertNotIn("vendor-body-sentinel-must-not-leak", output)
        self.assertNotIn("vendor-body-sentinel-must-not-leak", result.model_dump_json())

    def test_lookup_uses_network_path_parameter_and_relation_types_are_separated(self) -> None:
        environment = self._environment()
        _queue_datacite_lookup(environment)
        result = self.assert_lookup_scan(
            environment,
            MetadataLookupRequest(
                provider_name="datacite",
                key=ProviderLiteratureKey(
                    identifiers=(Identifier(namespace="doi", value="10.5555/DATACITE.ARTICLE"),)
                ),
                scan_limit=2,
            ),
            outcome="EXHAUSTED",
            raw_item_count=1,
            observation_count=1,
            relation_count=2,
        )
        self.assertEqual(
            urlsplit(environment.transport.calls[0].request.url).path,
            "/dois/10.5555%2Fdatacite.article",
        )
        self.assertEqual(len(result.relations), 2)
        self.assertEqual(len(result.observations[0].version_links), 1)
        serialized = result.model_dump_json()
        self.assertNotIn("datacite.container", serialized)

        environment.reset_http()
        environment.queue_http_response(
            status=200,
            body=_fixture("datacite", "dataset-lookup.json"),
        )
        dataset = self.assert_lookup_scan(
            environment,
            MetadataLookupRequest(
                provider_name="datacite",
                key=ProviderLiteratureKey(
                    identifiers=(Identifier(namespace="doi", value="10.5555/datacite.dataset"),)
                ),
                scan_limit=2,
            ),
            outcome="EXHAUSTED",
            raw_item_count=1,
            observation_count=0,
            relation_count=0,
        )
        self.assertEqual(dataset.observations, ())

    def test_scan_limit_does_not_prefetch_jsonapi_next_link(self) -> None:
        environment = self._environment()
        environment.queue_http_response(
            status=200,
            body=_fixture("datacite", "search-page-1.json"),
        )
        result = self.assert_topic_scan(
            environment,
            _topic_request("datacite", 1),
            outcome="SCAN_LIMIT_REACHED",
            raw_item_count=1,
            observation_count=1,
            relation_count=2,
        )
        self.assertEqual(len(environment.transport.calls), 1)
        self.assertEqual(result.observations[0].metadata.title, "A DataCite journal article")

    def test_repeated_jsonapi_cursor_fails_after_preserving_the_completed_page(self) -> None:
        environment = self._environment()
        payload = cast(
            dict[str, object],
            json.loads(_fixture("datacite", "search-page-1.json")),
        )
        links = cast(dict[str, object], payload["links"])
        links["next"] = links["self"]
        environment.queue_http_response(
            status=200,
            body=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
        )
        result = self.assert_topic_scan(
            environment,
            _topic_request("datacite", 10),
            outcome="FAILED",
            raw_item_count=3,
            observation_count=2,
            relation_count=2,
        )
        self.assert_stable_failure(result, expected_code="metadata-provider-protocol")
        self.assertEqual(len(environment.transport.calls), 1)


class CoreAdapterTests(ProviderContractCase, unittest.TestCase):
    def provider_contract_binding(self) -> ContractBinding:
        return _core_binding()

    def _environment(self, *, api_key: str | None = None) -> ContractEnvironment:
        environment = _environment("core", core_api_key=api_key)
        self.addCleanup(environment.close)
        return environment

    def test_work_search_preserves_aggregate_identity_and_ignores_full_text_and_outputs(
        self,
    ) -> None:
        environment = self._environment()
        page_one = _fixture("core", "search-page-1.json")
        _queue_core_search(environment)
        result = self.assert_topic_scan(
            environment,
            _topic_request("core", 10),
            outcome="EXHAUSTED",
            raw_item_count=3,
            observation_count=3,
            relation_count=2,
        )
        observation = result.observations[0]
        metadata = observation.metadata
        self.assertEqual(metadata.title, "A CORE work shared with Europe PMC")
        self.assertEqual(metadata.abstract, "A CORE aggregate abstract.")
        self.assertEqual(metadata.publication_date, "2025-01-02")
        self.assertEqual(metadata.publication_year, 2025)
        self.assertEqual(metadata.document_type, "journal-article")
        self.assertEqual(metadata.venue, "Journal of Open Retrieval")
        self.assertEqual(metadata.publisher, "CORE Fixture Press")
        self.assertEqual(metadata.keywords, ())
        self.assertEqual(observation.declared_keywords, ())
        self.assertEqual(observation.version_links, ())
        self.assertEqual(observation.reference_count, None)
        self.assertEqual(observation.cited_by_count, None)
        self.assertEqual(
            observation.reference_texts,
            (
                "First CORE reference text.",
                "Second CORE reference text.",
                "Third CORE reference text without a stable target.",
            ),
        )
        self.assert_author_mapping(
            metadata.authors,
            (
                ExpectedAuthor(kind="unknown", display_name="Example, Ada"),
                ExpectedAuthor(kind="unknown", display_name="Ada Example"),
                ExpectedAuthor(kind="unknown", display_name="Example, Ada"),
            ),
        )
        self.assert_identifier_record_id_separation(
            observation,
            expected_identifiers=(
                Identifier(namespace="doi", value="10.5555/shared.epmc.core"),
                Identifier(namespace="arxiv", value="2401.01234"),
                Identifier(namespace="pmid", value="40000001"),
            ),
            expected_record_id="work:143262545",
            forbidden_record_ids=("143262545", "571215426", "571215427"),
        )
        self.assert_asset_hints(
            observation,
            (
                AssetHint(
                    url="https://core.ac.uk/download/571215426.pdf",
                    kind=AssetHintKind.DIRECT_FILE,
                    media_type="application/pdf",
                    asset_role=AssetRole.PRIMARY_PDF,
                ),
                AssetHint(
                    url="https://repository.example.org/records/143262545/article.pdf",
                    kind=AssetHintKind.DIRECT_FILE,
                ),
                AssetHint(
                    url="https://core.ac.uk/works/143262545",
                    kind=AssetHintKind.LANDING_PAGE,
                ),
                AssetHint(
                    url="https://core.ac.uk/reader/143262545",
                    kind=AssetHintKind.LANDING_PAGE,
                ),
            ),
            runtime_secret=environment.secret_sentinel,
        )
        self.assertEqual(observation.provenance.input_sha256, sha256_digest(page_one))
        self.assert_no_private_payload(
            result,
            runtime_secret=environment.secret_sentinel,
            forbidden_values=(
                "private-search-token-one",
                "private-search-token-two",
                "private extracted full text",
                "fixture-secret-must-not-leak",
                "provider-topic-must-not-leak",
                "ambiguous-cites-value",
                "571215427",
            ),
        )

    def test_topic_search_quotes_user_text_before_entering_core_query_language(self) -> None:
        environment = self._environment()
        environment.queue_http_response(
            status=200,
            body=_fixture("core", "search-page-1.json"),
        )
        request = _topic_request("core", 1).model_copy(
            update={"query": 'retrieval" OR _exists_:fullText OR title:"private'}
        )
        self.assert_topic_scan(
            environment,
            request,
            outcome="SCAN_LIMIT_REACHED",
            raw_item_count=1,
            observation_count=1,
            relation_count=2,
        )
        query = parse_qs(urlsplit(environment.transport.calls[0].request.url).query)["q"]
        self.assertEqual(
            query,
            [
                '"retrieval\\" OR _exists_:fullText OR title:\\"private" '
                "AND yearPublished:[2020 TO 2025]"
            ],
        )

    def test_output_lookup_keeps_output_identity_and_locator_license(self) -> None:
        environment = self._environment()
        environment.queue_http_response(
            status=200,
            body=_fixture("core", "lookup-output.json"),
        )
        result = self.assert_lookup_scan(
            environment,
            MetadataLookupRequest(
                provider_name="core",
                key=ProviderLiteratureKey(record_id="output:571215426"),
                scan_limit=2,
            ),
            outcome="EXHAUSTED",
            raw_item_count=1,
            observation_count=1,
        )
        observation = result.observations[0]
        self.assertEqual(observation.provenance.source_record_id, "output:571215426")
        self.assertEqual(
            urlsplit(environment.transport.calls[0].request.url).path,
            "/v3/outputs/571215426",
        )
        self.assertTrue(observation.asset_hints)
        self.assertTrue(all(hint.license == "CC BY 4.0" for hint in observation.asset_hints))
        self.assert_no_private_payload(
            result,
            runtime_secret=environment.secret_sentinel,
            forbidden_values=("rawRecordXml", "private output full text", "<private>"),
        )

    def test_core_exposes_only_outgoing_reference_direction(self) -> None:
        environment = self._environment()
        environment.queue_http_response(status=200, body=_fixture("core", "lookup-work.json"))
        result = self.assert_reference_scan(
            environment,
            _reference_request("core", _CORE_KEY, direction="references"),
            outcome="EXHAUSTED",
            raw_item_count=1,
            observation_count=1,
            relation_count=2,
        )
        self.assertTrue(
            all(relation.citing.record_id == "work:143262545" for relation in result.relations)
        )

        environment.reset_http()
        unsupported = self.assert_reference_scan(
            environment,
            _reference_request("core", _CORE_KEY, direction="cited-by"),
            outcome="FAILED",
            raw_item_count=0,
            observation_count=0,
            relation_count=0,
        )
        self.assert_stable_failure(
            unsupported,
            expected_code="metadata-provider-unsupported-reference-direction",
        )
        self.assertEqual(environment.transport.calls, [])

    def test_optional_api_key_uses_bearer_credential_header_only(self) -> None:
        seed = _environment("core")
        secret = seed.secret_sentinel
        seed.close()
        environment = self._environment(api_key=secret)
        environment.queue_http_response(status=200, body=_fixture("core", "lookup-work.json"))
        self.assert_lookup_scan(
            environment,
            MetadataLookupRequest(provider_name="core", key=_CORE_KEY, scan_limit=2),
            outcome="EXHAUSTED",
            raw_item_count=1,
            observation_count=1,
            relation_count=2,
        )
        call = environment.transport.calls[0]
        self.assertIn(("Authorization", f"Bearer {secret}"), call.headers)
        self.assertNotIn(secret, call.request.url)
        self.assertNotIn("api_key", call.wire_target)
        self.assertNotIn(secret, call.request.model_dump_json())
        self.assertEqual(
            environment.coordinator.policy_for(environment.scope),
            AccessPolicy.strictest(CORE_BASELINE_ACCESS_POLICY, environment.policy),
        )

    def test_optional_api_key_redirects_keep_bearer_only_on_official_origin(self) -> None:
        seed = _environment("core")
        secret = seed.secret_sentinel
        seed.close()
        cases = (
            ("same-origin", "https://api.core.ac.uk/v3/works/redirected", True),
            ("cross-origin", "https://redirect.example.org/core", False),
        )
        for name, redirect_url, forwards_credential in cases:
            with self.subTest(name=name):
                environment = self._environment(api_key=secret)
                environment.queue_http_response(
                    status=302,
                    headers=(("Location", redirect_url),),
                )
                environment.queue_http_response(
                    status=200,
                    body=_fixture("core", "lookup-work.json"),
                )

                result = self.assert_lookup_scan(
                    environment,
                    MetadataLookupRequest(
                        provider_name="core",
                        key=_CORE_KEY,
                        scan_limit=2,
                    ),
                    outcome="EXHAUSTED",
                    raw_item_count=1,
                    observation_count=1,
                    relation_count=2,
                )

                self.assertIsNone(result.failure)
                self.assertEqual(len(environment.transport.calls), 2)
                authorization = ("Authorization", f"Bearer {secret}")
                self.assertIn(authorization, environment.transport.calls[0].headers)
                if forwards_credential:
                    self.assertIn(authorization, environment.transport.calls[1].headers)
                else:
                    self.assertNotIn(authorization, environment.transport.calls[1].headers)
                for call in environment.transport.calls:
                    self.assertNotIn(secret, call.request.url)
                    self.assertNotIn(secret, call.request.model_dump_json())
                    self.assertNotIn(secret, repr(call.request))

    def test_conflicting_quota_header_on_429_records_conservative_feedback_first(
        self,
    ) -> None:
        environment = self._environment()
        environment.queue_http_response(
            status=429,
            headers=(
                ("X-RateLimit-Remaining", "0"),
                ("x-ratelimit-remaining", "1"),
            ),
        )

        result = environment.api.search_topic(_topic_request("core", 2)).providers[0]

        self.assert_stable_failure(
            result,
            expected_code="metadata-provider-conflicting-header",
            forbidden_values=(environment.secret_sentinel,),
        )
        self.assertEqual(len(environment.coordinator.feedback_records), 1)
        self.assertTrue(environment.coordinator.feedback_records[0][1].throttled)
        source = environment.coordinator.feedback_sources[0]
        self.assertIsInstance(source, AccessPermit)
        self.assertEqual(
            [
                event
                for event, permit in environment.coordinator.permit_release_events
                if permit is source
            ],
            ["feedback", "release"],
        )

    def test_zero_quota_success_response_applies_feedback_before_release(self) -> None:
        environment = self._environment()
        environment.queue_http_response(
            status=200,
            headers=(("X-RateLimit-Remaining", "0"),),
            body=_fixture("core", "search-page-1.json"),
        )

        result = environment.api.search_topic(_topic_request("core", 1)).providers[0]

        self.assertIsNone(result.failure)
        self.assertEqual(len(environment.coordinator.feedback_records), 1)
        self.assertTrue(environment.coordinator.feedback_records[0][1].throttled)
        source = environment.coordinator.feedback_sources[0]
        self.assertIsInstance(source, AccessPermit)
        self.assertEqual(
            [
                event
                for event, permit in environment.coordinator.permit_release_events
                if permit is source
            ],
            ["feedback", "release"],
        )


class M5AdapterBoundaryTests(unittest.TestCase):
    def _environment(self, provider_name: str) -> ContractEnvironment:
        environment = _environment(provider_name)
        self.addCleanup(environment.close)
        return environment

    def test_all_three_adapters_expose_exact_capabilities_and_reject_wrong_scopes(self) -> None:
        self.assertEqual(
            EPMC_ACCESS_SCOPE,
            AccessScope(provider_name="europe-pmc", channel="api"),
        )
        self.assertEqual(
            EPMC_BASELINE_ACCESS_POLICY,
            AccessPolicy(max_concurrency=1, min_start_interval=1.0),
        )
        self.assertEqual(
            DATACITE_ACCESS_SCOPE,
            AccessScope(provider_name="datacite", channel="api"),
        )
        self.assertEqual(
            DATACITE_BASELINE_ACCESS_POLICY,
            AccessPolicy(
                max_concurrency=1,
                min_start_interval=0.6,
                burst_limit=500,
                window_seconds=300.0,
            ),
        )
        self.assertEqual(
            CORE_ACCESS_SCOPE,
            AccessScope(provider_name="core", channel="api"),
        )
        self.assertEqual(
            CORE_BASELINE_ACCESS_POLICY,
            AccessPolicy(
                max_concurrency=1,
                min_start_interval=6.0,
                burst_limit=10,
                window_seconds=60.0,
            ),
        )
        constructors = (
            ("europe-pmc", EuropePmcAdapter, 2),
            ("datacite", DataCiteAdapter, 3),
            ("core", CoreAdapter, 2),
        )
        for provider_name, constructor, page_size in constructors:
            with self.subTest(provider=provider_name):
                environment = self._environment(provider_name)
                adapter = environment.ports.topic_search
                self.assertIs(adapter, environment.ports.lookup)
                self.assertIs(adapter, environment.ports.reference_query)
                self.assertIsInstance(adapter, TopicSearchPort)
                self.assertIsInstance(adapter, MetadataLookupPort)
                self.assertIsInstance(adapter, ReferenceQueryPort)
                ids = _IdFactories(8_000)
                with self.assertRaises(ValueError):
                    constructor(
                        http_client=environment.http_client,
                        access_coordinator=environment.coordinator,
                        access_scope=AccessScope(
                            provider_name="wrong-provider",
                            channel="api",
                        ),
                        access_policy=AccessPolicy(max_concurrency=1),
                        observation_id_factory=ids.observation,
                        provenance_id_factory=ids.provenance,
                        clock=lambda: _wall_timestamp(environment),
                        page_size=page_size,
                    )

    def test_replaying_same_fixture_with_different_clocks_keeps_stable_ids(self) -> None:
        for provider_name in ("europe-pmc", "datacite", "core"):
            with self.subTest(provider=provider_name):
                environment = self._environment(provider_name)

                def execute() -> MetadataProviderResult:
                    if provider_name == "europe-pmc":
                        environment.queue_http_response(
                            status=200,
                            body=_fixture("europe_pmc", "references-page-1.json"),
                        )
                        return environment.api.query_references(
                            _reference_request(
                                "europe-pmc",
                                _EPMC_KEY,
                                direction="references",
                                scan_limit=1,
                            )
                        ).providers[0]
                    environment.queue_http_response(
                        status=200,
                        body=_fixture(provider_name, "search-page-1.json"),
                    )
                    return environment.api.search_topic(_topic_request(provider_name, 1)).providers[
                        0
                    ]

                first = execute()
                baseline = {
                    "europe-pmc": EPMC_BASELINE_ACCESS_POLICY,
                    "datacite": DATACITE_BASELINE_ACCESS_POLICY,
                    "core": CORE_BASELINE_ACCESS_POLICY,
                }[provider_name]
                self.assertEqual(
                    environment.coordinator.policy_for(environment.scope),
                    AccessPolicy.strictest(baseline, environment.policy),
                )
                environment.reset_http()
                environment.monotonic_clock.advance(60.0)
                environment.wall_clock.advance(60.0)
                replay = execute()

                self.assertNotEqual(
                    first.observations[0].provenance.observed_at,
                    replay.observations[0].provenance.observed_at,
                )
                self.assertEqual(
                    tuple(item.observation_id for item in first.observations),
                    tuple(item.observation_id for item in replay.observations),
                )
                self.assertEqual(
                    tuple(item.provenance.provenance_id for item in first.observations),
                    tuple(item.provenance.provenance_id for item in replay.observations),
                )
                self.assertTrue(first.relations)
                self.assertEqual(
                    tuple(item.observation_id for item in first.relations),
                    tuple(item.observation_id for item in replay.relations),
                )
                self.assertEqual(
                    tuple(item.provenance.provenance_id for item in first.relations),
                    tuple(item.provenance.provenance_id for item in replay.relations),
                )
                self.assertEqual(
                    len({item.observation_id for item in first.relations}),
                    len(first.relations),
                )
                self.assertTrue(
                    {item.observation_id for item in first.observations}.isdisjoint(
                        {item.observation_id for item in first.relations}
                    )
                )

    def test_same_doi_keeps_europe_pmc_and_core_observations_and_matches_literature(self) -> None:
        epmc = self._environment("europe-pmc")
        _queue_epmc_search(epmc)
        epmc_observation = (
            epmc.api.search_topic(_topic_request("europe-pmc", 10)).providers[0].observations[2]
        )
        core = self._environment("core")
        core.queue_http_response(status=200, body=_fixture("core", "search-page-1.json"))
        core_observation = (
            core.api.search_topic(_topic_request("core", 1)).providers[0].observations[0]
        )
        self.assertNotEqual(epmc_observation.observation_id, core_observation.observation_id)
        self.assertIn(
            Identifier(namespace="pmcid", value="PMC9990001"),
            epmc_observation.metadata.identifiers,
        )
        shared = Identifier(namespace="doi", value="10.5555/shared.epmc.core")
        self.assertIn(shared, epmc_observation.metadata.identifiers)
        self.assertIn(shared, core_observation.metadata.identifiers)
        existing = Literature(
            literature_id=LiteratureId("00000000-0000-0000-0000-000000009101"),
            meta_literature_id=MetaLiteratureId("00000000-0000-0000-0000-000000009102"),
            version_role=VersionRole.PUBLISHED,
            metadata=epmc_observation.metadata,
            status=LiteratureStatus.UNREVIEWED,
        )
        decision = accept_observation(
            core_observation,
            existing_literature=(existing,),
            existing_observations=(epmc_observation,),
        )
        self.assertEqual(decision.outcome, "matched")
        self.assertEqual(decision.literature, existing)
        self.assertEqual(decision.observations, (epmc_observation, core_observation))

    def test_malformed_unknown_oversize_and_partial_failures_are_stable(self) -> None:
        for provider_name in ("europe-pmc", "datacite", "core"):
            with self.subTest(provider=provider_name):
                environment = self._environment(provider_name)
                environment.queue_http_response(status=200, body=b'{"wrong": []}')
                unknown = environment.api.search_topic(_topic_request(provider_name, 5)).providers[
                    0
                ]
                self.assertEqual(unknown.outcome, "FAILED")
                self.assertEqual(
                    unknown.failure.code if unknown.failure is not None else None,
                    "metadata-provider-unknown-shape",
                )

                environment.reset_http()
                malformed_name = "malformed.json"
                environment.queue_http_response(
                    status=200,
                    body=_fixture(provider_name.replace("-", "_"), malformed_name),
                )
                malformed = environment.api.search_topic(
                    _topic_request(provider_name, 5)
                ).providers[0]
                self.assertEqual(malformed.outcome, "FAILED")
                self.assertEqual(
                    malformed.failure.code if malformed.failure is not None else None,
                    "metadata-provider-malformed-json",
                )

                environment.reset_http()
                environment.queue_http_response(status=200, body=b" " * 1_100_000)
                oversized = environment.api.search_topic(
                    _topic_request(provider_name, 5)
                ).providers[0]
                self.assertEqual(oversized.outcome, "FAILED")
                self.assertEqual(
                    oversized.failure.code if oversized.failure is not None else None,
                    "metadata-provider-response-too-large",
                )

    def test_shared_429_feedback_blocks_until_monotonic_deadline_then_recovers(self) -> None:
        for provider_name in ("europe-pmc", "datacite", "core"):
            with self.subTest(provider=provider_name):
                environment = self._environment(provider_name)
                _queue_throttled(environment)
                result = environment.api.search_topic(_topic_request(provider_name, 2)).providers[0]
                self.assertEqual(result.outcome, "FAILED")
                with self.assertRaises(AdmissionTimeout):
                    environment.coordinator.acquire_scope(environment.scope, timeout=0.005)
                environment.monotonic_clock.advance(6)
                permit = environment.coordinator.acquire_scope(environment.scope, timeout=0.01)
                permit.release()

    def test_all_feedback_is_applied_by_permit_before_release(self) -> None:
        for provider_name in ("europe-pmc", "datacite", "core"):
            with self.subTest(provider=provider_name):
                environment = self._environment(provider_name)
                _queue_throttled(environment)

                result = environment.api.search_topic(_topic_request(provider_name, 2)).providers[0]

                self.assertEqual(result.outcome, "FAILED")
                self.assertEqual(len(environment.coordinator.feedback_sources), 1)
                source = environment.coordinator.feedback_sources[0]
                self.assertIsInstance(source, AccessPermit)
                self.assertEqual(
                    [
                        event
                        for event, permit in environment.coordinator.permit_release_events
                        if permit is source
                    ],
                    ["feedback", "release"],
                )

    def test_programming_errors_and_controlled_cancellation_propagate(self) -> None:
        def programming_error() -> ObservationId:
            raise RuntimeError("programming sentinel")

        environment = _environment("datacite", observation_factory=programming_error)
        self.addCleanup(environment.close)
        environment.queue_http_response(status=200, body=_fixture("datacite", "search-page-1.json"))
        with self.assertRaisesRegex(RuntimeError, "programming sentinel"):
            environment.api.search_topic(_topic_request("datacite", 1))

        def cancelled() -> ObservationId:
            raise asyncio.CancelledError

        cancelled_environment = _environment("core", observation_factory=cancelled)
        self.addCleanup(cancelled_environment.close)
        cancelled_environment.queue_http_response(
            status=200,
            body=_fixture("core", "search-page-1.json"),
        )
        with self.assertRaises(asyncio.CancelledError):
            cancelled_environment.api.search_topic(_topic_request("core", 1))


if __name__ == "__main__":
    unittest.main()
