from __future__ import annotations

import asyncio
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
    ProviderContractCase,
)

from sciretriever.metadata.ports import MetadataLookupPort, TopicSearchPort
from sciretriever.metadata.providers.elsevier import (
    ACCESS_SCOPE as ELSEVIER_ACCESS_SCOPE,
)
from sciretriever.metadata.providers.elsevier import (
    ADAPTER_REVISION as ELSEVIER_ADAPTER_REVISION,
)
from sciretriever.metadata.providers.elsevier import (
    BASELINE_ACCESS_POLICY as ELSEVIER_BASELINE_ACCESS_POLICY,
)
from sciretriever.metadata.providers.elsevier import (
    ElsevierScopusAdapter,
)
from sciretriever.metadata.providers.springer import (
    ACCESS_SCOPE as SPRINGER_ACCESS_SCOPE,
)
from sciretriever.metadata.providers.springer import (
    ADAPTER_REVISION as SPRINGER_ADAPTER_REVISION,
)
from sciretriever.metadata.providers.springer import (
    BASELINE_ACCESS_POLICY as SPRINGER_BASELINE_ACCESS_POLICY,
)
from sciretriever.metadata.providers.springer import (
    SpringerMetaV2Adapter,
)
from sciretriever.metadata.rules import MetadataLookupRequest, MetadataProviderResult
from sciretriever.model.acquisition import AssetHint, AssetHintKind, AssetRole
from sciretriever.model.discovery import (
    DiscoverySourceOutcome,
    ProviderDiscoveryLimit,
    TopicDiscoveryInput,
)
from sciretriever.model.literature import Identifier
from sciretriever.model.metadata import ProviderLiteratureKey
from sciretriever.model.primitives import ObservationId, ProvenanceId, UtcTimestamp, sha256_digest
from sciretriever.network.admission import (
    AccessFeedback,
    AccessPolicy,
    AccessScope,
    AdmissionTimeout,
)

_FIXTURES = Path(__file__).parent / "fixtures" / "metadata"
_DEFAULT_API_KEY = object()
_DEFAULT_INSTITUTION_TOKEN = object()
_SHARED_DOI = Identifier(namespace="doi", value="10.5555/shared.elsevier.springer")
_ELSEVIER_EID = "2-s2.0-85000000001"
_Provider = Literal["elsevier", "springer"]


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


def _fixture(provider: _Provider, name: str) -> bytes:
    return (_FIXTURES / provider / name).read_bytes()


def _wall_timestamp(environment: ContractEnvironment) -> UtcTimestamp:
    return UtcTimestamp(environment.wall_clock().isoformat().replace("+00:00", "Z"))


def _institution_token(environment: ContractEnvironment) -> str:
    return f"{environment.secret_sentinel}-institution-token"


def _topic_request(
    provider: _Provider,
    scan_limit: int,
    *,
    query: str = 'retrieval systems "quoted" evidence',
    year_from: int | None = 2020,
    year_to: int | None = 2026,
) -> TopicDiscoveryInput:
    return TopicDiscoveryInput(
        kind="topic",
        query=query,
        year_from=year_from,
        year_to=year_to,
        providers=(ProviderDiscoveryLimit(provider_name=provider, scan_limit=scan_limit),),
    )


def _lookup_request(
    provider: _Provider,
    key: ProviderLiteratureKey | None = None,
    *,
    scan_limit: int = 4,
) -> MetadataLookupRequest:
    return MetadataLookupRequest(
        provider_name=provider,
        key=key or ProviderLiteratureKey(identifiers=(_SHARED_DOI,)),
        scan_limit=scan_limit,
    )


def _environment(
    provider: _Provider,
    *,
    api_key: str | None | object = _DEFAULT_API_KEY,
    institution_token: str | None | object = _DEFAULT_INSTITUTION_TOKEN,
    access_policy: AccessPolicy | None = None,
    observation_factory: Callable[[], ObservationId] | None = None,
    provenance_factory: Callable[[], ProvenanceId] | None = None,
    clock: Callable[[], UtcTimestamp] | None = None,
    page_size: int = 2,
    id_start: int = 10_000,
) -> ContractEnvironment:
    ids = _IdFactories(id_start)
    expected_scope = ELSEVIER_ACCESS_SCOPE if provider == "elsevier" else SPRINGER_ACCESS_SCOPE

    def assemble(environment: ContractEnvironment) -> ContractPorts:
        private_key = environment.secret_sentinel if api_key is _DEFAULT_API_KEY else api_key
        private_institution_token = (
            _institution_token(environment)
            if institution_token is _DEFAULT_INSTITUTION_TOKEN
            else cast(str | None, institution_token)
        )
        common = {
            "http_client": environment.http_client,
            "access_coordinator": environment.coordinator,
            "access_scope": environment.scope,
            "access_policy": access_policy or environment.policy,
            "observation_id_factory": observation_factory or ids.observation,
            "provenance_id_factory": provenance_factory or ids.provenance,
            "clock": clock or (lambda: _wall_timestamp(environment)),
            "api_key": private_key,
            "page_size": page_size,
        }
        adapter = (
            ElsevierScopusAdapter(
                **common,
                institution_token=private_institution_token,
            )
            if provider == "elsevier"
            else SpringerMetaV2Adapter(**common)
        )
        return ContractPorts(topic_search=adapter, lookup=adapter)

    return ContractEnvironment(
        provider_name=provider,
        capabilities=frozenset({"search", "lookup"}),
        port_factory=assemble,
        expected_scope=expected_scope,
    )


def _queue_redirected_fixture(
    environment: ContractEnvironment,
    provider: _Provider,
    fixture_name: str,
    *,
    cross_origin: bool,
) -> None:
    if provider == "elsevier":
        location = (
            "https://redirect.example/scopus-result"
            if cross_origin
            else "https://api.elsevier.com/content/search/scopus?redirected=1"
        )
    else:
        location = (
            "https://redirect.example/springer-result"
            if cross_origin
            else "https://api.springernature.com/meta/v2/json?redirected=1"
        )
    environment.queue_http_response(
        status=302,
        headers=(("Location", location),),
    )
    environment.queue_http_response(status=200, body=_fixture(provider, fixture_name))


def _queue_elsevier_contract_search(environment: ContractEnvironment) -> None:
    _queue_redirected_fixture(
        environment,
        "elsevier",
        "search-page-1.json",
        cross_origin=False,
    )


def _queue_elsevier_contract_lookup(environment: ContractEnvironment) -> None:
    _queue_redirected_fixture(
        environment,
        "elsevier",
        "lookup.json",
        cross_origin=True,
    )


def _queue_springer_contract_search(environment: ContractEnvironment) -> None:
    _queue_redirected_fixture(
        environment,
        "springer",
        "search-page-1.json",
        cross_origin=False,
    )


def _queue_springer_contract_lookup(environment: ContractEnvironment) -> None:
    _queue_redirected_fixture(
        environment,
        "springer",
        "lookup.json",
        cross_origin=True,
    )


def _queue_throttled(environment: ContractEnvironment) -> None:
    if environment.provider_name == "elsevier":
        provider: _Provider = "elsevier"
    elif environment.provider_name == "springer":
        provider = "springer"
    else:
        raise AssertionError("unexpected M8 contract provider")
    environment.queue_http_response(
        status=429,
        headers=(("Retry-After", "5"),),
        body=_fixture(provider, "access-error.json"),
    )


def _elsevier_contract_evidence(
    case: ProviderContractCase,
    environment: ContractEnvironment,
    result: MetadataProviderResult,
) -> None:
    del environment
    if result.observations:
        observation = result.observations[0]
        case.assert_identifier_record_id_separation(
            observation,
            expected_identifiers=(
                _SHARED_DOI,
                Identifier(namespace="pmid", value="12345"),
            ),
            expected_record_id=_ELSEVIER_EID,
            forbidden_record_ids=(_ELSEVIER_EID, "85000000001"),
        )


def _springer_contract_evidence(
    case: ProviderContractCase,
    environment: ContractEnvironment,
    result: MetadataProviderResult,
) -> None:
    del environment
    if result.observations:
        observation = result.observations[0]
        case.assert_identifier_record_id_separation(
            observation,
            expected_identifiers=(_SHARED_DOI,),
            expected_record_id="doi:10.5555/SHARED.ELSEVIER.SPRINGER",
            forbidden_record_ids=("doi:10.5555/SHARED.ELSEVIER.SPRINGER",),
        )


def _no_evidence(
    case: ProviderContractCase,
    environment: ContractEnvironment,
    result: MetadataProviderResult,
) -> None:
    del case, environment, result


def _elsevier_contract_binding() -> ContractBinding:
    return ContractBinding(
        provider_name="elsevier",
        capabilities=frozenset({"search", "lookup"}),
        expected_scope=ELSEVIER_ACCESS_SCOPE,
        credential_mode="header",
        port_factory=lambda environment: _environment_ports(environment, "elsevier"),
        scenarios=(
            ContractScenario(
                name="search-same-origin-private-header",
                capability="search",
                request=_topic_request("elsevier", 1),
                prepare=_queue_elsevier_contract_search,
                expected=ContractExpectedResult(
                    outcome="SCAN_LIMIT_REACHED",
                    raw_item_count=1,
                    observation_count=1,
                    relation_count=0,
                ),
                evidence=_elsevier_contract_evidence,
                credential_redirect="same-origin",
            ),
            ContractScenario(
                name="lookup-cross-origin-drops-private-header",
                capability="lookup",
                request=_lookup_request("elsevier"),
                prepare=_queue_elsevier_contract_lookup,
                expected=ContractExpectedResult(
                    outcome="EXHAUSTED",
                    raw_item_count=1,
                    observation_count=1,
                    relation_count=2,
                ),
                evidence=_elsevier_contract_evidence,
                credential_redirect="cross-origin",
            ),
            ContractScenario(
                name="throttle-feedback",
                capability="search",
                request=_topic_request("elsevier", 2),
                prepare=_queue_throttled,
                expected=ContractExpectedResult(
                    outcome="FAILED",
                    raw_item_count=0,
                    observation_count=0,
                    relation_count=0,
                    failure_code="metadata-provider-throttled",
                ),
                evidence=_no_evidence,
                expects_feedback=True,
            ),
        ),
    )


def _springer_contract_binding() -> ContractBinding:
    return ContractBinding(
        provider_name="springer",
        capabilities=frozenset({"search", "lookup"}),
        expected_scope=SPRINGER_ACCESS_SCOPE,
        credential_mode="query",
        port_factory=lambda environment: _environment_ports(environment, "springer"),
        scenarios=(
            ContractScenario(
                name="search-same-origin-private-query",
                capability="search",
                request=_topic_request("springer", 1),
                prepare=_queue_springer_contract_search,
                expected=ContractExpectedResult(
                    outcome="SCAN_LIMIT_REACHED",
                    raw_item_count=1,
                    observation_count=1,
                    relation_count=0,
                ),
                evidence=_springer_contract_evidence,
                credential_redirect="same-origin",
            ),
            ContractScenario(
                name="lookup-cross-origin-drops-private-query",
                capability="lookup",
                request=_lookup_request("springer"),
                prepare=_queue_springer_contract_lookup,
                expected=ContractExpectedResult(
                    outcome="EXHAUSTED",
                    raw_item_count=1,
                    observation_count=1,
                    relation_count=0,
                ),
                evidence=_springer_contract_evidence,
                credential_redirect="cross-origin",
            ),
            ContractScenario(
                name="throttle-feedback",
                capability="search",
                request=_topic_request("springer", 2),
                prepare=_queue_throttled,
                expected=ContractExpectedResult(
                    outcome="FAILED",
                    raw_item_count=0,
                    observation_count=0,
                    relation_count=0,
                    failure_code="metadata-provider-throttled",
                ),
                evidence=_no_evidence,
                expects_feedback=True,
            ),
        ),
    )


def _environment_ports(
    environment: ContractEnvironment,
    provider: _Provider,
) -> ContractPorts:
    ids = _IdFactories(20_000 if provider == "elsevier" else 30_000)
    common = {
        "http_client": environment.http_client,
        "access_coordinator": environment.coordinator,
        "access_scope": environment.scope,
        "access_policy": environment.policy,
        "observation_id_factory": ids.observation,
        "provenance_id_factory": ids.provenance,
        "clock": lambda: _wall_timestamp(environment),
        "api_key": environment.secret_sentinel,
        "page_size": 2,
    }
    adapter = (
        ElsevierScopusAdapter(
            **common,
            institution_token=_institution_token(environment),
        )
        if provider == "elsevier"
        else SpringerMetaV2Adapter(**common)
    )
    return ContractPorts(topic_search=adapter, lookup=adapter)


class ElsevierScopusAdapterTests(ProviderContractCase, unittest.TestCase):
    def provider_contract_binding(self) -> ContractBinding:
        return _elsevier_contract_binding()

    def _elsevier(
        self,
        *,
        api_key: str | None | object = _DEFAULT_API_KEY,
        institution_token: str | None | object = _DEFAULT_INSTITUTION_TOKEN,
        access_policy: AccessPolicy | None = None,
        observation_factory: Callable[[], ObservationId] | None = None,
        id_start: int = 10_000,
    ) -> ContractEnvironment:
        environment = _environment(
            "elsevier",
            api_key=api_key,
            institution_token=institution_token,
            access_policy=access_policy,
            observation_factory=observation_factory,
            id_start=id_start,
        )
        self.addCleanup(environment.close)
        return environment

    def test_search_and_abstract_lookup_form_the_minimum_contract_slice(self) -> None:
        environment = self._elsevier()
        environment.queue_http_response(
            status=200,
            body=_fixture("elsevier", "search-page-1.json"),
        )
        environment.queue_http_response(
            status=200,
            body=_fixture("elsevier", "search-page-2.json"),
        )
        result = self.assert_topic_scan(
            environment,
            _topic_request("elsevier", 10),
            outcome="EXHAUSTED",
            raw_item_count=3,
            observation_count=3,
        )
        first = result.observations[0]
        self.assertEqual(first.metadata.title, "Shared retrieval evidence")
        self.assertEqual(first.cited_by_count, 12)
        self.assertEqual(
            first.declared_keywords,
            ("information retrieval", "evidence synthesis"),
        )
        self.assert_author_mapping(
            first.metadata.authors,
            (
                ExpectedAuthor(
                    kind="person",
                    display_name="Example, Ada",
                    given_name="Ada",
                    family_name="Example",
                    orcid="0000-0002-1825-0097",
                    affiliations=(ExpectedAffiliation("Example Research Institute"),),
                ),
                ExpectedAuthor(kind="unknown", display_name="Consortium Alpha"),
            ),
        )
        self.assertEqual(result.observations[1].metadata.authors, ())
        self.assert_asset_hints(
            first,
            (
                AssetHint(
                    url=("https://www.scopus.com/inward/record.uri?eid=2-s2.0-85000000001"),
                    kind=AssetHintKind.LANDING_PAGE,
                ),
                AssetHint(
                    url=("https://api.elsevier.com/content/article/pii/S000000000000001X"),
                    kind=AssetHintKind.LANDING_PAGE,
                ),
            ),
            runtime_secret=environment.secret_sentinel,
        )
        self.assertTrue(
            all(
                hint.kind is AssetHintKind.LANDING_PAGE
                and hint.media_type is None
                and hint.asset_role is None
                for hint in first.asset_hints
            )
        )

        environment.reset_http()
        environment.queue_http_response(
            status=200,
            body=_fixture("elsevier", "lookup.json"),
        )
        lookup = self.assert_lookup_scan(
            environment,
            _lookup_request("elsevier"),
            outcome="EXHAUSTED",
            raw_item_count=1,
            observation_count=1,
            relation_count=2,
        )
        observation = lookup.observations[0]
        self.assertEqual(
            observation.reference_texts,
            (
                "Ada Target. First explicit reference.",
                "Ben Target. Second explicit reference.",
                "Raw-only reference without a stable target.",
            ),
        )
        self.assertEqual(observation.reference_count, 3)
        self.assertEqual(observation.cited_by_count, 21)
        current = ProviderLiteratureKey(
            record_id=_ELSEVIER_EID,
            identifiers=(
                _SHARED_DOI,
                Identifier(namespace="pmid", value="12345"),
            ),
        )
        self.assert_citing_to_cited(
            lookup.relations[0],
            citing=current,
            cited=ProviderLiteratureKey(
                identifiers=(Identifier(namespace="doi", value="10.5555/target.one"),)
            ),
        )
        self.assert_citing_to_cited(
            lookup.relations[1],
            citing=current,
            cited=ProviderLiteratureKey(identifiers=(Identifier(namespace="pmid", value="24680"),)),
        )

    def test_private_headers_are_bound_to_canonical_origin_and_dropped_cross_origin(
        self,
    ) -> None:
        environment = self._elsevier(id_start=10_500)
        institution_token = _institution_token(environment)
        _queue_redirected_fixture(
            environment,
            "elsevier",
            "search-page-1.json",
            cross_origin=True,
        )
        self.assert_topic_scan(
            environment,
            _topic_request("elsevier", 1),
            outcome="SCAN_LIMIT_REACHED",
            raw_item_count=1,
            observation_count=1,
        )

        self.assertEqual(len(environment.transport.calls), 2)
        initial, redirected = environment.transport.calls
        initial_url = urlsplit(initial.request.url)
        self.assertEqual(
            (initial_url.scheme, initial_url.hostname, initial_url.port or 443),
            ("https", "api.elsevier.com", 443),
        )
        self.assertEqual(initial_url.path, "/content/search/scopus")
        self.assertIn(("X-ELS-APIKey", environment.secret_sentinel), initial.headers)
        self.assertIn(("X-ELS-Insttoken", institution_token), initial.headers)
        self.assertFalse(
            any(
                name.casefold() in {"x-els-apikey", "x-els-insttoken"}
                for name, _value in redirected.headers
            )
        )
        for call in (initial, redirected):
            serialized_request = call.request.model_dump_json()
            self.assertNotIn(environment.secret_sentinel, serialized_request)
            self.assertNotIn(institution_token, serialized_request)
            self.assertNotIn("X-ELS-APIKey", serialized_request)
            self.assertNotIn("X-ELS-Insttoken", serialized_request)
            self.assertNotIn(environment.secret_sentinel, repr(call))
            self.assertNotIn(institution_token, repr(call))

    def test_private_headers_follow_only_same_origin_redirects(self) -> None:
        environment = self._elsevier(id_start=10_550)
        institution_token = _institution_token(environment)
        _queue_redirected_fixture(
            environment,
            "elsevier",
            "search-page-1.json",
            cross_origin=False,
        )
        self.assert_topic_scan(
            environment,
            _topic_request("elsevier", 1),
            outcome="SCAN_LIMIT_REACHED",
            raw_item_count=1,
            observation_count=1,
        )

        self.assertEqual(len(environment.transport.calls), 2)
        for call in environment.transport.calls:
            self.assertIn(("X-ELS-APIKey", environment.secret_sentinel), call.headers)
            self.assertIn(("X-ELS-Insttoken", institution_token), call.headers)
            serialized_request = call.request.model_dump_json()
            for forbidden in (
                environment.secret_sentinel,
                institution_token,
                "X-ELS-APIKey",
                "X-ELS-Insttoken",
            ):
                self.assertNotIn(forbidden, serialized_request)

    def test_optional_institution_token_is_private_and_absence_sends_only_api_key(
        self,
    ) -> None:
        configured = self._elsevier(id_start=10_600)
        institution_token = _institution_token(configured)
        configured.queue_http_response(
            status=200,
            body=_fixture("elsevier", "search-page-1.json"),
        )
        configured_result = self.assert_topic_scan(
            configured,
            _topic_request("elsevier", 1),
            outcome="SCAN_LIMIT_REACHED",
            raw_item_count=1,
            observation_count=1,
        )
        configured_call = configured.transport.calls[0]
        configured_credentials = tuple(
            header
            for header in configured_call.headers
            if header[0].casefold() in {"x-els-apikey", "x-els-insttoken"}
        )
        self.assertEqual(
            configured_credentials,
            (
                ("X-ELS-APIKey", configured.secret_sentinel),
                ("X-ELS-Insttoken", institution_token),
            ),
        )
        self.assertEqual(
            repr(configured.ports.topic_search),
            "<ElsevierScopusAdapter api_key_configured=True institution_token_configured=True>",
        )
        for rendered in (
            configured_call.request.model_dump_json(),
            repr(configured_call),
            configured_result.model_dump_json(),
            repr(configured_result),
            repr(configured.ports.topic_search),
        ):
            self.assertNotIn(configured.secret_sentinel, rendered)
            self.assertNotIn(institution_token, rendered)

        missing = self._elsevier(institution_token=None, id_start=10_700)
        missing.queue_http_response(
            status=200,
            body=_fixture("elsevier", "search-page-1.json"),
        )
        self.assert_topic_scan(
            missing,
            _topic_request("elsevier", 1),
            outcome="SCAN_LIMIT_REACHED",
            raw_item_count=1,
            observation_count=1,
        )
        missing_credentials = tuple(
            header
            for header in missing.transport.calls[0].headers
            if header[0].casefold() in {"x-els-apikey", "x-els-insttoken"}
        )
        self.assertEqual(
            missing_credentials,
            (("X-ELS-APIKey", missing.secret_sentinel),),
        )
        self.assertEqual(
            repr(missing.ports.topic_search),
            "<ElsevierScopusAdapter api_key_configured=True institution_token_configured=False>",
        )

    def test_institution_token_constructor_validation_is_secret_free(self) -> None:
        environment = self._elsevier(institution_token=None, id_start=10_800)
        ids = _IdFactories(10_900)
        invalid_values: tuple[tuple[object, type[Exception]], ...] = (
            (object(), TypeError),
            ("", ValueError),
            ("   ", ValueError),
            (f"{environment.secret_sentinel}\runsafe", ValueError),
            (f"{environment.secret_sentinel}\nunsafe", ValueError),
            (f"{environment.secret_sentinel}\x00unsafe", ValueError),
        )
        for value, error_type in invalid_values:
            with self.subTest(error_type=error_type.__name__):
                with self.assertRaises(error_type) as caught:
                    ElsevierScopusAdapter(
                        http_client=environment.http_client,
                        access_coordinator=environment.coordinator,
                        access_scope=environment.scope,
                        access_policy=environment.policy,
                        observation_id_factory=ids.observation,
                        provenance_id_factory=ids.provenance,
                        clock=lambda: _wall_timestamp(environment),
                        api_key=environment.secret_sentinel,
                        institution_token=cast(str | None, value),
                    )
                self.assertNotIn(environment.secret_sentinel, str(caught.exception))
                self.assertNotIn(environment.secret_sentinel, repr(caught.exception))

    def test_search_scan_limit_has_no_prefetch_and_partial_failure_keeps_page_one(
        self,
    ) -> None:
        environment = self._elsevier()
        environment.queue_http_response(
            status=200,
            body=_fixture("elsevier", "search-page-1.json"),
        )
        limited = self.assert_topic_scan(
            environment,
            _topic_request("elsevier", 1),
            outcome="SCAN_LIMIT_REACHED",
            raw_item_count=1,
            observation_count=1,
        )
        self.assertEqual(len(environment.transport.calls), 1)
        self.assertIsNone(limited.failure)

        partial_environment = self._elsevier(id_start=11_000)
        partial_environment.queue_http_response(
            status=200,
            body=_fixture("elsevier", "search-page-1.json"),
        )
        partial_environment.queue_http_response(
            status=200,
            body=_fixture("elsevier", "malformed.json"),
        )
        partial = self.assert_topic_scan(
            partial_environment,
            _topic_request("elsevier", 10),
            outcome="FAILED",
            raw_item_count=2,
            observation_count=2,
        )
        self.assert_stable_failure(
            partial,
            expected_code="metadata-provider-malformed-json",
            forbidden_values=("cursor-page-2",),
        )

    def test_cursor_zero_and_empty_page_termination_are_stable(self) -> None:
        scenarios: tuple[
            tuple[str, DiscoverySourceOutcome, str | None],
            ...,
        ] = (
            ("zero-results.json", "EXHAUSTED", None),
            ("empty-with-cursor.json", "FAILED", "metadata-provider-protocol"),
            ("repeated-cursor.json", "FAILED", "metadata-provider-protocol"),
        )
        for fixture_name, outcome, failure_code in scenarios:
            with self.subTest(fixture=fixture_name):
                environment = self._elsevier(id_start=12_000)
                environment.queue_http_response(
                    status=200,
                    body=_fixture("elsevier", fixture_name),
                )
                result = self.assert_topic_scan(
                    environment,
                    _topic_request("elsevier", 5),
                    outcome=outcome,
                    raw_item_count=0,
                    observation_count=0,
                )
                if failure_code is None:
                    self.assertIsNone(result.failure)
                else:
                    self.assert_stable_failure(result, expected_code=failure_code)

    def test_lookup_supports_eid_and_doi_without_promoting_provider_ids(self) -> None:
        for key, endpoint in (
            (ProviderLiteratureKey(record_id=_ELSEVIER_EID), "/abstract/eid/"),
            (ProviderLiteratureKey(identifiers=(_SHARED_DOI,)), "/abstract/doi/"),
        ):
            with self.subTest(key=key.model_dump_json()):
                environment = self._elsevier(id_start=13_000)
                environment.queue_http_response(
                    status=200,
                    body=_fixture("elsevier", "lookup.json"),
                )
                result = self.assert_lookup_scan(
                    environment,
                    _lookup_request("elsevier", key),
                    outcome="EXHAUSTED",
                    raw_item_count=1,
                    observation_count=1,
                    relation_count=2,
                )
                self.assertEqual(result.observations[0].metadata.identifiers[0], _SHARED_DOI)
                call = environment.transport.calls[0]
                self.assertIn(endpoint, call.wire_target)
                self.assertNotIn("X-ELS-APIKey", call.request.model_dump_json())

    def test_auth_entitlement_throttle_and_missing_key_never_fall_back(self) -> None:
        missing = self._elsevier(api_key=None, id_start=14_000)
        missing_result = missing.api.search_topic(_topic_request("elsevier", 2)).providers[0]
        self.assert_stable_failure(
            missing_result,
            expected_code="metadata-provider-credentials-missing",
        )
        self.assertFalse(missing.transport.calls)

        for status, expected_code in (
            (401, "metadata-provider-authentication"),
            (403, "metadata-provider-entitlement"),
            (429, "metadata-provider-throttled"),
        ):
            with self.subTest(status=status):
                environment = self._elsevier(id_start=14_100 + status)
                headers = (("Retry-After", "5"),) if status == 429 else ()
                environment.queue_http_response(
                    status=status,
                    headers=headers,
                    body=_fixture("elsevier", "access-error.json"),
                )
                result = self.assert_topic_scan(
                    environment,
                    _topic_request("elsevier", 2),
                    outcome="FAILED",
                    raw_item_count=0,
                    observation_count=0,
                )
                self.assert_stable_failure(
                    result,
                    expected_code=expected_code,
                    forbidden_values=(environment.secret_sentinel, "AUTHORIZATION_ERROR"),
                )
                self.assertEqual(len(environment.transport.calls), 1)

    def test_elsevier_ambiguous_reset_never_becomes_a_deadline(self) -> None:
        environment = self._elsevier(id_start=15_000)
        ambiguous_reset = int(environment.wall_clock().timestamp()) + 86_400
        environment.queue_http_response(
            status=200,
            headers=(
                ("X-RateLimit-Limit", "10000"),
                ("X-RateLimit-Remaining", "0"),
                ("X-RateLimit-Reset", str(ambiguous_reset)),
            ),
            body=_fixture("elsevier", "search-page-1.json"),
        )
        self.assert_topic_scan(
            environment,
            _topic_request("elsevier", 1),
            outcome="SCAN_LIMIT_REACHED",
            raw_item_count=1,
            observation_count=1,
        )
        self.assertEqual(
            environment.coordinator.feedback_records,
            [(environment.scope, AccessFeedback(throttled=True))],
        )
        with self.assertRaises(AdmissionTimeout):
            environment.coordinator.acquire_scope(environment.scope, timeout=0.001)
        environment.monotonic_clock.advance(1.0)
        permit = environment.coordinator.acquire_scope(environment.scope, timeout=0.01)
        permit.release()

        throttled = self._elsevier(id_start=15_100)
        throttled.queue_http_response(
            status=429,
            headers=(("X-RateLimit-Reset", str(ambiguous_reset)),),
            body=_fixture("elsevier", "access-error.json"),
        )
        result = self.assert_topic_scan(
            throttled,
            _topic_request("elsevier", 2),
            outcome="FAILED",
            raw_item_count=0,
            observation_count=0,
        )
        self.assert_stable_failure(result, expected_code="metadata-provider-throttled")
        self.assertEqual(
            throttled.coordinator.feedback_records,
            [(throttled.scope, AccessFeedback(throttled=True))],
        )

    def test_elsevier_wrong_shape_malformed_and_oversize_are_redacted(self) -> None:
        scenarios = (
            (
                _fixture("elsevier", "wrong-shape.json"),
                "metadata-provider-unknown-shape",
            ),
            (
                _fixture("elsevier", "malformed.json"),
                "metadata-provider-malformed-json",
            ),
            (b" " * 4_300_000, "metadata-provider-response-too-large"),
        )
        for body, expected_code in scenarios:
            with self.subTest(code=expected_code):
                environment = self._elsevier(id_start=16_000)
                environment.queue_http_response(status=200, body=body)
                result = self.assert_topic_scan(
                    environment,
                    _topic_request("elsevier", 2),
                    outcome="FAILED",
                    raw_item_count=0,
                    observation_count=0,
                )
                self.assert_stable_failure(
                    result,
                    expected_code=expected_code,
                    forbidden_values=("privateVendorMessage", environment.secret_sentinel),
                )

    def test_elsevier_replay_stabilizes_metadata_relations_and_provenance_ids(self) -> None:
        environment = self._elsevier(id_start=17_000)

        def execute() -> MetadataProviderResult:
            environment.queue_http_response(
                status=200,
                body=_fixture("elsevier", "lookup.json"),
            )
            return environment.api.lookup(_lookup_request("elsevier"))

        first = execute()
        environment.reset_http()
        environment.monotonic_clock.advance(60.0)
        environment.wall_clock.advance(60.0)
        replay = execute()
        self.assertNotEqual(
            first.observations[0].provenance.observed_at,
            replay.observations[0].provenance.observed_at,
        )
        self.assertEqual(
            first.observations[0].observation_id,
            replay.observations[0].observation_id,
        )
        self.assertEqual(
            first.observations[0].provenance.provenance_id,
            replay.observations[0].provenance.provenance_id,
        )
        self.assertEqual(
            tuple(item.observation_id for item in first.relations),
            tuple(item.observation_id for item in replay.relations),
        )
        self.assertEqual(len(set(first.relations)), 2)


class SpringerMetaV2AdapterTests(ProviderContractCase, unittest.TestCase):
    def provider_contract_binding(self) -> ContractBinding:
        return _springer_contract_binding()

    def _springer(
        self,
        *,
        api_key: str | None | object = _DEFAULT_API_KEY,
        access_policy: AccessPolicy | None = None,
        observation_factory: Callable[[], ObservationId] | None = None,
        id_start: int = 10_000,
    ) -> ContractEnvironment:
        environment = _environment(
            "springer",
            api_key=api_key,
            access_policy=access_policy,
            observation_factory=observation_factory,
            id_start=id_start,
        )
        self.addCleanup(environment.close)
        return environment

    def test_search_and_doi_lookup_form_the_minimum_contract_slice(self) -> None:
        environment = self._springer()
        environment.queue_http_response(
            status=200,
            body=_fixture("springer", "search-page-1.json"),
        )
        environment.queue_http_response(
            status=200,
            body=_fixture("springer", "search-page-2.json"),
        )
        result = self.assert_topic_scan(
            environment,
            _topic_request("springer", 10),
            outcome="EXHAUSTED",
            raw_item_count=3,
            observation_count=3,
        )
        initial_url = urlsplit(environment.transport.calls[0].request.url)
        self.assertEqual(
            (
                initial_url.scheme,
                initial_url.hostname,
                initial_url.port or 443,
                initial_url.path,
            ),
            ("https", "api.springernature.com", 443, "/meta/v2/json"),
        )
        first = result.observations[0]
        self.assertEqual(first.metadata.identifiers, (_SHARED_DOI,))
        self.assertEqual(first.declared_keywords, ())
        self.assertEqual(first.metadata.keywords, ())
        self.assert_author_mapping(
            first.metadata.authors,
            (
                ExpectedAuthor(kind="unknown", display_name="Ada Example"),
                ExpectedAuthor(kind="unknown", display_name="Consortium Alpha"),
            ),
        )
        self.assert_asset_hints(
            first,
            (
                AssetHint(
                    url="https://link.springer.com/article/10.5555/shared.elsevier.springer",
                    kind=AssetHintKind.LANDING_PAGE,
                    media_type="text/html",
                ),
                AssetHint(
                    url=(
                        "https://link.springer.com/content/pdf/10.5555/shared.elsevier.springer.pdf"
                    ),
                    kind=AssetHintKind.DIRECT_FILE,
                    media_type="application/pdf",
                    asset_role=AssetRole.PRIMARY_PDF,
                ),
                AssetHint(
                    url=(
                        "https://api.springernature.com/openaccess/jats/"
                        "10.5555/shared.elsevier.springer.xml"
                    ),
                    kind=AssetHintKind.DIRECT_FILE,
                    media_type="application/xml",
                    asset_role=AssetRole.XML,
                ),
            ),
            runtime_secret=environment.secret_sentinel,
        )
        xml_hint = first.asset_hints[-1]
        self.assertEqual(xml_hint.asset_role, AssetRole.XML)
        self.assertEqual(xml_hint.media_type, "application/xml")
        self.assertNotEqual(xml_hint.asset_role, AssetRole.PRIMARY_PDF)

        environment.reset_http()
        environment.queue_http_response(
            status=200,
            body=_fixture("springer", "lookup.json"),
        )
        lookup = self.assert_lookup_scan(
            environment,
            _lookup_request("springer"),
            outcome="EXHAUSTED",
            raw_item_count=1,
            observation_count=1,
        )
        self.assertFalse(lookup.relations)

    def test_meta_v2_pagination_is_lazy_and_partial_failure_keeps_page_one(self) -> None:
        environment = self._springer(id_start=21_000)
        environment.queue_http_response(
            status=200,
            body=_fixture("springer", "search-page-1.json"),
        )
        self.assert_topic_scan(
            environment,
            _topic_request("springer", 1),
            outcome="SCAN_LIMIT_REACHED",
            raw_item_count=1,
            observation_count=1,
        )
        self.assertEqual(len(environment.transport.calls), 1)

        partial_environment = self._springer(id_start=21_100)
        partial_environment.queue_http_response(
            status=200,
            body=_fixture("springer", "search-page-1.json"),
        )
        partial_environment.queue_http_response(
            status=200,
            body=_fixture("springer", "malformed.json"),
        )
        partial = self.assert_topic_scan(
            partial_environment,
            _topic_request("springer", 10),
            outcome="FAILED",
            raw_item_count=2,
            observation_count=2,
        )
        self.assert_stable_failure(
            partial,
            expected_code="metadata-provider-malformed-json",
        )

    def test_zero_and_nonprogressing_empty_page_are_distinct(self) -> None:
        scenarios: tuple[
            tuple[str, DiscoverySourceOutcome, str | None],
            ...,
        ] = (
            ("zero-results.json", "EXHAUSTED", None),
            ("empty-page.json", "FAILED", "metadata-provider-protocol"),
        )
        for fixture_name, outcome, failure_code in scenarios:
            with self.subTest(fixture=fixture_name):
                environment = self._springer(id_start=22_000)
                environment.queue_http_response(
                    status=200,
                    body=_fixture("springer", fixture_name),
                )
                result = self.assert_topic_scan(
                    environment,
                    _topic_request("springer", 5),
                    outcome=outcome,
                    raw_item_count=0,
                    observation_count=0,
                )
                if failure_code is None:
                    self.assertIsNone(result.failure)
                else:
                    self.assert_stable_failure(result, expected_code=failure_code)

    def test_private_api_key_is_only_on_the_wire_and_query_echo_is_not_model_data(
        self,
    ) -> None:
        environment = self._springer(id_start=23_000)
        environment.queue_http_response(
            status=200,
            body=_fixture("springer", "search-page-1.json"),
        )
        result = self.assert_topic_scan(
            environment,
            _topic_request("springer", 1),
            outcome="SCAN_LIMIT_REACHED",
            raw_item_count=1,
            observation_count=1,
        )
        call = environment.transport.calls[0]
        safe_query = parse_qs(urlsplit(call.request.url).query)
        wire_query = parse_qs(urlsplit(call.wire_target).query)
        self.assertNotIn("api_key", safe_query)
        self.assertEqual(wire_query["api_key"], [environment.secret_sentinel])
        self.assertIn("q", safe_query)
        self.assertNotIn(environment.secret_sentinel, result.model_dump_json())
        self.assertNotIn("redacted fixture query", result.model_dump_json())
        self.assertEqual(
            result.observations[0].provenance.parameters_sha256,
            sha256_digest(SPRINGER_ADAPTER_REVISION.encode("utf-8")),
        )

    def test_auth_entitlement_throttle_and_missing_key_never_become_zero_results(
        self,
    ) -> None:
        missing = self._springer(api_key=None, id_start=24_000)
        missing_result = missing.api.search_topic(_topic_request("springer", 2)).providers[0]
        self.assert_stable_failure(
            missing_result,
            expected_code="metadata-provider-credentials-missing",
        )
        self.assertFalse(missing.transport.calls)

        for status, expected_code in (
            (401, "metadata-provider-authentication"),
            (403, "metadata-provider-entitlement"),
            (429, "metadata-provider-throttled"),
        ):
            with self.subTest(status=status):
                environment = self._springer(id_start=24_100 + status)
                headers = (("Retry-After", "5"),) if status == 429 else ()
                environment.queue_http_response(
                    status=status,
                    headers=headers,
                    body=_fixture("springer", "access-error.json"),
                )
                result = self.assert_topic_scan(
                    environment,
                    _topic_request("springer", 2),
                    outcome="FAILED",
                    raw_item_count=0,
                    observation_count=0,
                )
                self.assert_stable_failure(
                    result,
                    expected_code=expected_code,
                    forbidden_values=(environment.secret_sentinel, "not enabled"),
                )

    def test_springer_ambiguous_reset_never_becomes_a_deadline(self) -> None:
        ambiguous_reset = str(int(1_900_000_000))
        header_pairs = (
            ("X-RateLimit-Remaining", "X-RateLimit-Reset"),
            ("RateLimit-Remaining", "RateLimit-Reset"),
        )
        for index, (remaining_name, reset_name) in enumerate(header_pairs):
            with self.subTest(reset_header=reset_name):
                environment = self._springer(id_start=25_000 + index * 100)
                environment.queue_http_response(
                    status=200,
                    headers=(
                        (remaining_name, "0"),
                        (reset_name, ambiguous_reset),
                    ),
                    body=_fixture("springer", "search-page-1.json"),
                )
                self.assert_topic_scan(
                    environment,
                    _topic_request("springer", 1),
                    outcome="SCAN_LIMIT_REACHED",
                    raw_item_count=1,
                    observation_count=1,
                )
                self.assertEqual(
                    environment.coordinator.feedback_records,
                    [(environment.scope, AccessFeedback(throttled=True))],
                )
                with self.assertRaises(AdmissionTimeout):
                    environment.coordinator.acquire_scope(environment.scope, timeout=0.001)
                environment.monotonic_clock.advance(1.0)
                permit = environment.coordinator.acquire_scope(
                    environment.scope,
                    timeout=0.01,
                )
                permit.release()

        throttled = self._springer(id_start=25_300)
        throttled.queue_http_response(
            status=429,
            headers=(("RateLimit-Reset", ambiguous_reset),),
            body=_fixture("springer", "access-error.json"),
        )
        result = self.assert_topic_scan(
            throttled,
            _topic_request("springer", 2),
            outcome="FAILED",
            raw_item_count=0,
            observation_count=0,
        )
        self.assert_stable_failure(result, expected_code="metadata-provider-throttled")
        self.assertEqual(
            throttled.coordinator.feedback_records,
            [(throttled.scope, AccessFeedback(throttled=True))],
        )

    def test_wrong_shape_malformed_and_oversize_fail_without_payload(self) -> None:
        scenarios = (
            (
                _fixture("springer", "wrong-shape.json"),
                "metadata-provider-unknown-shape",
            ),
            (
                _fixture("springer", "malformed.json"),
                "metadata-provider-malformed-json",
            ),
            (b" " * 4_300_000, "metadata-provider-response-too-large"),
        )
        for body, expected_code in scenarios:
            with self.subTest(code=expected_code):
                environment = self._springer(id_start=26_000)
                environment.queue_http_response(status=200, body=body)
                result = self.assert_topic_scan(
                    environment,
                    _topic_request("springer", 2),
                    outcome="FAILED",
                    raw_item_count=0,
                    observation_count=0,
                )
                self.assert_stable_failure(
                    result,
                    expected_code=expected_code,
                    forbidden_values=("unsupported private shape", environment.secret_sentinel),
                )

    def test_springer_replay_is_stable_and_never_emits_citation_edges(self) -> None:
        environment = self._springer(id_start=27_000)

        def execute() -> MetadataProviderResult:
            environment.queue_http_response(
                status=200,
                body=_fixture("springer", "lookup.json"),
            )
            return environment.api.lookup(_lookup_request("springer"))

        first = execute()
        environment.reset_http()
        environment.monotonic_clock.advance(60.0)
        environment.wall_clock.advance(60.0)
        replay = execute()
        self.assertFalse(first.relations)
        self.assertEqual(
            first.observations[0].observation_id,
            replay.observations[0].observation_id,
        )
        self.assertEqual(
            first.observations[0].provenance.provenance_id,
            replay.observations[0].provenance.provenance_id,
        )
        self.assertNotEqual(
            first.observations[0].provenance.observed_at,
            replay.observations[0].provenance.observed_at,
        )


class M8AdapterBoundaryTests(unittest.TestCase):
    def test_scopes_policies_revisions_and_capabilities_are_explicit(self) -> None:
        self.assertEqual(
            ELSEVIER_ACCESS_SCOPE,
            AccessScope(provider_name="elsevier", channel="api", service_name="scopus"),
        )
        self.assertEqual(
            ELSEVIER_BASELINE_ACCESS_POLICY,
            AccessPolicy(
                max_concurrency=1,
                min_start_interval=0.125,
                burst_limit=10_000,
                window_seconds=604_800.0,
            ),
        )
        self.assertEqual(
            SPRINGER_ACCESS_SCOPE,
            AccessScope(provider_name="springer", channel="api", service_name="meta-v2"),
        )
        self.assertEqual(
            SPRINGER_BASELINE_ACCESS_POLICY,
            AccessPolicy(
                max_concurrency=1,
                min_start_interval=0.6,
                burst_limit=500,
                window_seconds=86_400.0,
            ),
        )
        self.assertEqual(ELSEVIER_ADAPTER_REVISION, "scopus-json-2026-08-07")
        self.assertEqual(SPRINGER_ADAPTER_REVISION, "meta-v2-json-2026-08-07")

        providers: tuple[_Provider, ...] = ("elsevier", "springer")
        for provider in providers:
            with self.subTest(provider=provider):
                environment = _environment(provider)
                self.addCleanup(environment.close)
                adapter = environment.ports.topic_search
                self.assertIs(adapter, environment.ports.lookup)
                self.assertIsNone(environment.ports.reference_query)
                self.assertIsInstance(adapter, TopicSearchPort)
                self.assertIsInstance(adapter, MetadataLookupPort)

    def test_operator_policy_only_tightens_and_wrong_scopes_are_rejected(self) -> None:
        cases = (
            ("elsevier", ELSEVIER_BASELINE_ACCESS_POLICY, ElsevierScopusAdapter),
            ("springer", SPRINGER_BASELINE_ACCESS_POLICY, SpringerMetaV2Adapter),
        )
        for raw_provider, baseline, constructor in cases:
            provider: _Provider = "elsevier" if raw_provider == "elsevier" else "springer"
            with self.subTest(provider=provider):
                operator = AccessPolicy(
                    max_concurrency=1,
                    min_start_interval=10.0,
                    burst_limit=1,
                    window_seconds=100.0,
                )
                environment = _environment(provider, access_policy=operator, id_start=40_000)
                self.addCleanup(environment.close)
                environment.queue_http_response(
                    status=200,
                    body=_fixture(provider, "zero-results.json"),
                )
                environment.api.search_topic(_topic_request(provider, 1))
                self.assertEqual(
                    environment.coordinator.policy_for(environment.scope),
                    AccessPolicy.strictest(baseline, operator),
                )

                ids = _IdFactories(41_000)
                with self.assertRaises(ValueError):
                    constructor(
                        http_client=environment.http_client,
                        access_coordinator=environment.coordinator,
                        access_scope=AccessScope(
                            provider_name="wrong-provider",
                            channel="api",
                        ),
                        access_policy=environment.policy,
                        observation_id_factory=ids.observation,
                        provenance_id_factory=ids.provenance,
                        clock=lambda: _wall_timestamp(environment),
                        api_key="offline-sentinel",
                        page_size=2,
                    )

    def test_same_discovery_input_keeps_provider_coverage_and_identity_separate(self) -> None:
        elsevier = _environment("elsevier", id_start=42_000)
        springer = _environment("springer", id_start=43_000)
        self.addCleanup(elsevier.close)
        self.addCleanup(springer.close)
        elsevier.queue_http_response(
            status=200,
            body=_fixture("elsevier", "search-page-1.json"),
        )
        springer.queue_http_response(
            status=200,
            body=_fixture("springer", "search-page-1.json"),
        )
        elsevier_result = elsevier.api.search_topic(_topic_request("elsevier", 1)).providers[0]
        springer_result = springer.api.search_topic(_topic_request("springer", 1)).providers[0]
        elsevier_observation = elsevier_result.observations[0]
        springer_observation = springer_result.observations[0]
        self.assertIn(_SHARED_DOI, elsevier_observation.metadata.identifiers)
        self.assertIn(_SHARED_DOI, springer_observation.metadata.identifiers)
        self.assertEqual(elsevier_observation.provenance.source_name, "elsevier")
        self.assertEqual(springer_observation.provenance.source_name, "springer")
        self.assertNotEqual(
            elsevier_observation.observation_id,
            springer_observation.observation_id,
        )

    def test_programming_errors_and_controlled_cancellation_propagate(self) -> None:
        def programming_error() -> ObservationId:
            raise RuntimeError("programming sentinel")

        environment = _environment(
            "springer",
            observation_factory=programming_error,
            id_start=44_000,
        )
        self.addCleanup(environment.close)
        environment.queue_http_response(
            status=200,
            body=_fixture("springer", "search-page-1.json"),
        )
        with self.assertRaisesRegex(RuntimeError, "programming sentinel"):
            environment.api.search_topic(_topic_request("springer", 1))

        def cancelled() -> ObservationId:
            raise asyncio.CancelledError

        cancelled_environment = _environment(
            "elsevier",
            observation_factory=cancelled,
            id_start=45_000,
        )
        self.addCleanup(cancelled_environment.close)
        cancelled_environment.queue_http_response(
            status=200,
            body=_fixture("elsevier", "search-page-1.json"),
        )
        with self.assertRaises(asyncio.CancelledError):
            cancelled_environment.api.search_topic(_topic_request("elsevier", 1))


if __name__ == "__main__":
    unittest.main()
