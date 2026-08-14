from __future__ import annotations

import asyncio
import json
import threading
import time
import unittest
from collections.abc import Callable, Sequence
from datetime import datetime
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import cast
from unittest.mock import patch
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

from sciretriever.literature.api import LiteratureApi
from sciretriever.literature.metadata import accept_observation
from sciretriever.literature.ports import ProviderRelationObservationReadRequest
from sciretriever.literature.service import LiteratureService
from sciretriever.metadata.ports import (
    MetadataLookupPort,
    ReferenceQueryPort,
    TopicSearchPort,
)
from sciretriever.metadata.providers._shared import (
    retry_after_feedback as interpret_retry_after_feedback,
)
from sciretriever.metadata.providers._shared import (
    stabilize_provider_metadata_observation,
    stabilize_provider_relation_observation,
)
from sciretriever.metadata.providers.arxiv import (
    ACCESS_SCOPE as ARXIV_ACCESS_SCOPE,
)
from sciretriever.metadata.providers.arxiv import (
    BASELINE_ACCESS_POLICY as ARXIV_BASELINE_ACCESS_POLICY,
)
from sciretriever.metadata.providers.arxiv import (
    ArxivAdapter,
)
from sciretriever.metadata.providers.crossref import (
    POLITE_ACCESS_SCOPE,
    POLITE_BASELINE_ACCESS_POLICY,
    PUBLIC_ACCESS_SCOPE,
    PUBLIC_BASELINE_ACCESS_POLICY,
    CrossrefAdapter,
)
from sciretriever.metadata.publication import MetadataPublication
from sciretriever.metadata.rules import MetadataLookupRequest, MetadataProviderResult
from sciretriever.model.access import Header
from sciretriever.model.acquisition import (
    AssetHint,
    AssetHintKind,
    AssetRole,
    AutomaticPdfAcquisitionExhaustion,
)
from sciretriever.model.discovery import ProviderDiscoveryLimit, TopicDiscoveryInput
from sciretriever.model.literature import (
    Identifier,
    Literature,
    LiteratureStatus,
    VersionRole,
)
from sciretriever.model.metadata import (
    LiteratureMetadata,
    MetadataObservation,
    ProviderLiteratureKey,
    ProviderRelationObservation,
)
from sciretriever.model.primitives import (
    LiteratureId,
    MetaLiteratureId,
    ObservationId,
    ProvenanceId,
    ReferenceId,
    Sha256,
    SourceKind,
    UtcTimestamp,
    sha256_digest,
)
from sciretriever.model.provenance import Provenance
from sciretriever.network.admission import (
    AccessFeedback,
    AccessPermit,
    AccessPolicy,
    AccessScope,
    AdmissionTimeout,
)
from sciretriever.storage.files.paths import StorageRoot
from sciretriever.storage.files.reader import VerifiedReader
from sciretriever.storage.files.store import ArtifactStore
from sciretriever.storage.sqlite.content_publication import SqliteContentPublication
from sciretriever.storage.sqlite.engine import CatalogEngine
from sciretriever.storage.sqlite.literature_preconditions import LiteraturePreconditionReader
from sciretriever.storage.sqlite.literature_reader import LiteratureReader
from sciretriever.storage.sqlite.literature_writer import LiteratureWriter
from sciretriever.storage.sqlite.metadata_publication import (
    SqliteProviderRelationObservationPublication,
)

_FIXTURES = Path(__file__).parent / "fixtures" / "metadata"


class _IdFactories:
    def __init__(self, start: int = 100) -> None:
        self._next = start

    def _value(self) -> str:
        value = str(UUID(int=self._next))
        self._next += 1
        return value

    def observation(self) -> ObservationId:
        return ObservationId(self._value())

    def provenance(self) -> ProvenanceId:
        return ProvenanceId(self._value())


class _LiteratureIdFactories:
    def __init__(self) -> None:
        self._next = 20_000

    def _value(self) -> str:
        value = str(UUID(int=self._next))
        self._next += 1
        return value

    def new_literature_id(self) -> LiteratureId:
        return LiteratureId(self._value())

    def new_meta_literature_id(self) -> MetaLiteratureId:
        return MetaLiteratureId(self._value())

    def new_reference_id(self) -> ReferenceId:
        return ReferenceId(self._value())


class ProviderIdentityTests(unittest.TestCase):
    def _provenance(
        self,
        identifier: str,
        *,
        observed_at: str,
        input_character: str = "a",
    ) -> Provenance:
        return Provenance(
            provenance_id=ProvenanceId(identifier),
            source_kind=SourceKind.METADATA_PROVIDER,
            source_name="fixture-provider",
            source_record_id="record-1",
            observed_at=UtcTimestamp(observed_at),
            input_sha256=Sha256(input_character * 64),
            parameters_sha256=Sha256("b" * 64),
        )

    def test_provider_identities_ignore_only_ingestion_ids_and_observed_at(self) -> None:
        first = MetadataObservation(
            observation_id=ObservationId(str(UUID(int=1))),
            provenance=self._provenance(
                str(UUID(int=2)),
                observed_at="2026-08-11T00:00:00Z",
            ),
            metadata=LiteratureMetadata(title="Stable semantics"),
        )
        replay = first.model_copy(
            update={
                "observation_id": ObservationId(str(UUID(int=3))),
                "provenance": self._provenance(
                    str(UUID(int=4)),
                    observed_at="2026-08-12T00:00:00Z",
                ),
            }
        )

        stable_first = stabilize_provider_metadata_observation(first)
        stable_replay = stabilize_provider_metadata_observation(replay)

        self.assertEqual(stable_first.observation_id, stable_replay.observation_id)
        self.assertEqual(
            stable_first.provenance.provenance_id,
            stable_replay.provenance.provenance_id,
        )
        self.assertNotEqual(
            stable_first.provenance.observed_at,
            stable_replay.provenance.observed_at,
        )
        changed_input = replay.model_copy(
            update={
                "provenance": self._provenance(
                    str(UUID(int=5)),
                    observed_at="2026-08-12T00:00:00Z",
                    input_character="c",
                )
            }
        )
        changed_semantics = replay.model_copy(
            update={"metadata": LiteratureMetadata(title="Changed semantics")}
        )
        self.assertNotEqual(
            stable_first.observation_id,
            stabilize_provider_metadata_observation(changed_input).observation_id,
        )
        self.assertNotEqual(
            stable_first.observation_id,
            stabilize_provider_metadata_observation(changed_semantics).observation_id,
        )

    def test_relation_identity_uses_domain_tag_and_normalized_endpoints(self) -> None:
        provenance = self._provenance(
            str(UUID(int=10)),
            observed_at="2026-08-11T00:00:00Z",
        )
        identifiers = (
            Identifier(namespace="doi", value="10.5555/z"),
            Identifier(namespace="arxiv", value="2501.01234"),
        )
        relation = ProviderRelationObservation(
            observation_id=ObservationId(str(UUID(int=11))),
            provenance=provenance,
            citing=ProviderLiteratureKey(record_id="source"),
            cited=ProviderLiteratureKey(identifiers=identifiers),
        )
        replay = relation.model_copy(
            update={
                "observation_id": ObservationId(str(UUID(int=12))),
                "provenance": self._provenance(
                    str(UUID(int=13)),
                    observed_at="2026-08-12T00:00:00Z",
                ),
                "cited": ProviderLiteratureKey(identifiers=tuple(reversed(identifiers))),
            }
        )

        stable_relation = stabilize_provider_relation_observation(relation)
        stable_replay = stabilize_provider_relation_observation(replay)

        self.assertEqual(stable_relation.observation_id, stable_replay.observation_id)
        metadata = MetadataObservation(
            observation_id=ObservationId(str(UUID(int=14))),
            provenance=provenance,
            metadata=LiteratureMetadata(title="Different identity domain"),
        )
        self.assertNotEqual(
            stable_relation.observation_id,
            stabilize_provider_metadata_observation(metadata).observation_id,
        )


def _fixture(provider: str, name: str) -> bytes:
    return (_FIXTURES / provider / name).read_bytes()


def _wall_timestamp(environment: ContractEnvironment) -> UtcTimestamp:
    return UtcTimestamp(environment.wall_clock().isoformat().replace("+00:00", "Z"))


def _topic_request(
    provider_name: str,
    scan_limit: int,
    *,
    year_from: int | None = 2020,
    year_to: int | None = 2025,
) -> TopicDiscoveryInput:
    return TopicDiscoveryInput(
        kind="topic",
        query="retrieval systems",
        year_from=year_from,
        year_to=year_to,
        providers=(
            ProviderDiscoveryLimit(
                provider_name=provider_name,
                scan_limit=scan_limit,
            ),
        ),
    )


def _crossref_environment(
    *,
    observation_id_factory: Callable[[], ObservationId] | None = None,
    mailto: str | None = "fixture-contact@example.invalid",
    operator_policy: AccessPolicy | None = None,
) -> ContractEnvironment:
    ids = _IdFactories()

    def assemble(environment: ContractEnvironment) -> ContractPorts:
        adapter = CrossrefAdapter(
            http_client=environment.http_client,
            access_coordinator=environment.coordinator,
            access_scope=environment.scope,
            access_policy=operator_policy or environment.policy,
            observation_id_factory=observation_id_factory or ids.observation,
            provenance_id_factory=ids.provenance,
            clock=lambda: _wall_timestamp(environment),
            mailto=mailto,
            page_size=2,
        )
        return ContractPorts(topic_search=adapter, lookup=adapter)

    return ContractEnvironment(
        provider_name="crossref",
        capabilities=frozenset({"search", "lookup"}),
        port_factory=assemble,
        expected_scope=AccessScope(
            provider_name="crossref",
            channel="api",
            service_name="polite" if mailto is not None else "public",
        ),
    )


def _arxiv_environment(
    *,
    observation_id_factory: Callable[[], ObservationId] | None = None,
    operator_policy: AccessPolicy | None = None,
) -> ContractEnvironment:
    ids = _IdFactories(start=1_000)

    def assemble(environment: ContractEnvironment) -> ContractPorts:
        adapter = ArxivAdapter(
            http_client=environment.http_client,
            access_coordinator=environment.coordinator,
            access_scope=environment.scope,
            access_policy=operator_policy or environment.policy,
            observation_id_factory=observation_id_factory or ids.observation,
            provenance_id_factory=ids.provenance,
            clock=lambda: _wall_timestamp(environment),
            page_size=2,
        )
        return ContractPorts(topic_search=adapter, lookup=adapter)

    return ContractEnvironment(
        provider_name="arxiv",
        capabilities=frozenset({"search", "lookup"}),
        port_factory=assemble,
        expected_scope=AccessScope(provider_name="arxiv", channel="api"),
    )


def _crossref_contract_ports(environment: ContractEnvironment) -> ContractPorts:
    ids = _IdFactories()
    adapter = CrossrefAdapter(
        http_client=environment.http_client,
        access_coordinator=environment.coordinator,
        access_scope=environment.scope,
        access_policy=environment.policy,
        observation_id_factory=ids.observation,
        provenance_id_factory=ids.provenance,
        clock=lambda: _wall_timestamp(environment),
        mailto="fixture-contact@example.invalid",
        page_size=2,
    )
    return ContractPorts(topic_search=adapter, lookup=adapter)


def _arxiv_contract_ports(environment: ContractEnvironment) -> ContractPorts:
    ids = _IdFactories(start=1_000)
    adapter = ArxivAdapter(
        http_client=environment.http_client,
        access_coordinator=environment.coordinator,
        access_scope=environment.scope,
        access_policy=environment.policy,
        observation_id_factory=ids.observation,
        provenance_id_factory=ids.provenance,
        clock=lambda: _wall_timestamp(environment),
        page_size=2,
    )
    return ContractPorts(topic_search=adapter, lookup=adapter)


def _queue_crossref_search(environment: ContractEnvironment) -> None:
    environment.queue_http_response(
        status=200,
        body=_fixture("crossref", "search-page-1.json"),
    )
    environment.queue_http_response(
        status=200,
        body=_fixture("crossref", "search-page-2.json"),
    )


def _crossref_search_evidence(
    contract: ProviderContractCase,
    environment: ContractEnvironment,
    result: MetadataProviderResult,
) -> None:
    case = contract._test_case()
    case.assertEqual(len(environment.transport.calls), 2)
    first_query = parse_qs(urlsplit(environment.transport.calls[0].request.url).query)
    second_query = parse_qs(urlsplit(environment.transport.calls[1].request.url).query)
    case.assertEqual(first_query["cursor"], ["*"])
    case.assertEqual(second_query["cursor"], ["cursor+/two=="])
    case.assertEqual(result.observations[0].metadata.title, "A Crossref record")
    case.assertEqual(
        tuple(relation.citing.record_id for relation in result.relations),
        ("10.5555/cr.arxiv", "10.5555/cr.arxiv"),
    )
    case.assertEqual(
        tuple(relation.cited.record_id for relation in result.relations),
        ("10.5555/cited.one", "10.5555/cited.two"),
    )


def _queue_crossref_lookup(environment: ContractEnvironment) -> None:
    environment.queue_http_response(
        status=200,
        body=_fixture("crossref", "lookup.json"),
    )


def _crossref_lookup_evidence(
    contract: ProviderContractCase,
    environment: ContractEnvironment,
    result: MetadataProviderResult,
) -> None:
    case = contract._test_case()
    case.assertEqual(len(environment.transport.calls), 1)
    case.assertEqual(result.observations[0].provenance.source_record_id, "10.5555/lookup.value")
    case.assertEqual(result.observations[0].metadata.publication_date, "2021-06")


def _queue_throttled(environment: ContractEnvironment) -> None:
    environment.queue_http_response(
        status=429,
        headers=(("Retry-After", "5"),),
    )


def _feedback_evidence(
    contract: ProviderContractCase,
    environment: ContractEnvironment,
    result: MetadataProviderResult,
) -> None:
    case = contract._test_case()
    case.assertEqual(len(environment.transport.calls), 1)
    case.assertEqual(len(environment.coordinator.feedback_records), 1)
    case.assertEqual(
        result.failure.code if result.failure is not None else None, "metadata-provider-throttled"
    )


def _queue_crossref_partial_failure(environment: ContractEnvironment) -> None:
    environment.queue_http_response(
        status=200,
        body=_fixture("crossref", "search-page-1.json"),
    )
    environment.queue_http_response(
        status=200,
        body=_fixture("crossref", "malformed.json"),
    )


def _partial_crossref_evidence(
    contract: ProviderContractCase,
    environment: ContractEnvironment,
    result: MetadataProviderResult,
) -> None:
    case = contract._test_case()
    case.assertEqual(len(environment.transport.calls), 2)
    case.assertEqual(
        tuple(observation.metadata.title for observation in result.observations),
        ("A Crossref record", None),
    )


def _queue_arxiv_search(environment: ContractEnvironment) -> None:
    environment.queue_http_response(
        status=200,
        body=_fixture("arxiv", "search-page-1.xml"),
    )
    environment.queue_http_response(
        status=200,
        body=_fixture("arxiv", "search-page-2.xml"),
    )


def _arxiv_search_evidence(
    contract: ProviderContractCase,
    environment: ContractEnvironment,
    result: MetadataProviderResult,
) -> None:
    case = contract._test_case()
    case.assertEqual(len(environment.transport.calls), 2)
    first_query = parse_qs(urlsplit(environment.transport.calls[0].request.url).query)
    second_query = parse_qs(urlsplit(environment.transport.calls[1].request.url).query)
    case.assertEqual(first_query["start"], ["0"])
    case.assertEqual(second_query["start"], ["2"])
    case.assertEqual(result.observations[0].provenance.source_record_id, "2501.01234v2")
    case.assertEqual(result.observations[1].provenance.source_record_id, "hep-th/9901001v3")


def _queue_arxiv_lookup(environment: ContractEnvironment) -> None:
    environment.queue_http_response(
        status=200,
        body=_fixture("arxiv", "lookup.xml"),
    )


def _arxiv_lookup_evidence(
    contract: ProviderContractCase,
    environment: ContractEnvironment,
    result: MetadataProviderResult,
) -> None:
    case = contract._test_case()
    case.assertEqual(len(environment.transport.calls), 1)
    query = parse_qs(urlsplit(environment.transport.calls[0].request.url).query)
    case.assertEqual(query["id_list"], ["2106.14834v1"])
    case.assertEqual(result.observations[0].provenance.source_record_id, "2106.14834v1")


def _queue_arxiv_partial_failure(environment: ContractEnvironment) -> None:
    environment.queue_http_response(
        status=200,
        body=_fixture("arxiv", "search-page-1.xml"),
    )
    environment.queue_http_response(
        status=200,
        body=_fixture("arxiv", "truncated.xml"),
    )


def _partial_arxiv_evidence(
    contract: ProviderContractCase,
    environment: ContractEnvironment,
    result: MetadataProviderResult,
) -> None:
    case = contract._test_case()
    case.assertEqual(len(environment.transport.calls), 2)
    case.assertEqual(
        tuple(observation.provenance.source_record_id for observation in result.observations),
        ("2501.01234v2", "hep-th/9901001v3"),
    )


def _crossref_contract_binding() -> ContractBinding:
    return ContractBinding(
        provider_name="crossref",
        capabilities=frozenset({"search", "lookup"}),
        expected_scope=AccessScope(
            provider_name="crossref",
            channel="api",
            service_name="polite",
        ),
        credential_mode="none",
        port_factory=_crossref_contract_ports,
        scenarios=(
            ContractScenario(
                name="paged-search-with-relations",
                capability="search",
                request=_topic_request("crossref", 10),
                prepare=_queue_crossref_search,
                expected=ContractExpectedResult(
                    outcome="EXHAUSTED",
                    raw_item_count=3,
                    observation_count=3,
                    relation_count=2,
                ),
                evidence=_crossref_search_evidence,
            ),
            ContractScenario(
                name="exact-doi-lookup",
                capability="lookup",
                request=MetadataLookupRequest(
                    provider_name="crossref",
                    key=ProviderLiteratureKey(record_id="10.5555/LOOKUP.VALUE"),
                    scan_limit=2,
                ),
                prepare=_queue_crossref_lookup,
                expected=ContractExpectedResult(
                    outcome="EXHAUSTED",
                    raw_item_count=1,
                    observation_count=1,
                    relation_count=0,
                ),
                evidence=_crossref_lookup_evidence,
            ),
            ContractScenario(
                name="retry-after-feedback",
                capability="search",
                request=_topic_request("crossref", 2),
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
                name="malformed-second-page-keeps-partial-result",
                capability="search",
                request=_topic_request("crossref", 10),
                prepare=_queue_crossref_partial_failure,
                expected=ContractExpectedResult(
                    outcome="FAILED",
                    raw_item_count=2,
                    observation_count=2,
                    relation_count=2,
                    failure_code="metadata-provider-malformed-json",
                ),
                evidence=_partial_crossref_evidence,
            ),
        ),
    )


def _arxiv_contract_binding() -> ContractBinding:
    return ContractBinding(
        provider_name="arxiv",
        capabilities=frozenset({"search", "lookup"}),
        expected_scope=AccessScope(
            provider_name="arxiv",
            channel="api",
        ),
        credential_mode="none",
        port_factory=_arxiv_contract_ports,
        scenarios=(
            ContractScenario(
                name="paged-atom-search",
                capability="search",
                request=_topic_request("arxiv", 10),
                prepare=_queue_arxiv_search,
                expected=ContractExpectedResult(
                    outcome="EXHAUSTED",
                    raw_item_count=3,
                    observation_count=3,
                    relation_count=0,
                ),
                evidence=_arxiv_search_evidence,
            ),
            ContractScenario(
                name="exact-revision-lookup",
                capability="lookup",
                request=MetadataLookupRequest(
                    provider_name="arxiv",
                    key=ProviderLiteratureKey(record_id="arXiv:2106.14834v1"),
                    scan_limit=2,
                ),
                prepare=_queue_arxiv_lookup,
                expected=ContractExpectedResult(
                    outcome="EXHAUSTED",
                    raw_item_count=1,
                    observation_count=1,
                    relation_count=0,
                ),
                evidence=_arxiv_lookup_evidence,
            ),
            ContractScenario(
                name="retry-after-feedback",
                capability="search",
                request=_topic_request("arxiv", 2),
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
                name="truncated-second-page-keeps-partial-result",
                capability="search",
                request=_topic_request("arxiv", 5),
                prepare=_queue_arxiv_partial_failure,
                expected=ContractExpectedResult(
                    outcome="FAILED",
                    raw_item_count=2,
                    observation_count=2,
                    relation_count=0,
                    failure_code="metadata-provider-malformed-xml",
                ),
                evidence=_partial_arxiv_evidence,
            ),
        ),
    )


class CrossrefAdapterTests(ProviderContractCase, unittest.TestCase):
    def provider_contract_binding(self) -> ContractBinding:
        return _crossref_contract_binding()

    def _crossref(self) -> ContractEnvironment:
        environment = _crossref_environment()
        self.addCleanup(environment.close)
        return environment

    def _arxiv(self) -> ContractEnvironment:
        environment = _arxiv_environment()
        self.addCleanup(environment.close)
        return environment

    def test_adapters_expose_only_search_and_lookup_and_validate_api_scope(self) -> None:
        for environment in (self._crossref(), self._arxiv()):
            with self.subTest(provider=environment.provider_name):
                adapter = environment.ports.topic_search
                self.assertIs(adapter, environment.ports.lookup)
                self.assertIsInstance(adapter, TopicSearchPort)
                self.assertIsInstance(adapter, MetadataLookupPort)
                self.assertNotIsInstance(adapter, ReferenceQueryPort)
                self.assert_scope_is_neutral(environment.scope)

                assert adapter is not None
                constructor = (
                    CrossrefAdapter if environment.provider_name == "crossref" else ArxivAdapter
                )
                ids = _IdFactories(start=5_000)
                with self.assertRaises(ValueError):
                    constructor(
                        http_client=environment.http_client,
                        access_coordinator=environment.coordinator,
                        access_scope=AccessScope(
                            provider_name="wrong-provider",
                            channel="api",
                            service_name="metadata",
                        ),
                        access_policy=AccessPolicy(max_concurrency=1),
                        observation_id_factory=ids.observation,
                        provenance_id_factory=ids.provenance,
                        clock=lambda: _wall_timestamp(environment),
                        page_size=2,
                    )

                wrong_service_scope = AccessScope(
                    provider_name=environment.provider_name,
                    channel="api",
                    service_name="metadata",
                )
                with self.assertRaises(ValueError):
                    if environment.provider_name == "crossref":
                        CrossrefAdapter(
                            http_client=environment.http_client,
                            access_coordinator=environment.coordinator,
                            access_scope=wrong_service_scope,
                            access_policy=AccessPolicy(max_concurrency=1),
                            observation_id_factory=ids.observation,
                            provenance_id_factory=ids.provenance,
                            clock=lambda: _wall_timestamp(environment),
                            mailto="fixture-contact@example.invalid",
                            page_size=2,
                        )
                    else:
                        ArxivAdapter(
                            http_client=environment.http_client,
                            access_coordinator=environment.coordinator,
                            access_scope=wrong_service_scope,
                            access_policy=AccessPolicy(max_concurrency=1),
                            observation_id_factory=ids.observation,
                            provenance_id_factory=ids.provenance,
                            clock=lambda: _wall_timestamp(environment),
                            page_size=2,
                        )
                with self.assertRaises(ValueError):
                    constructor(
                        http_client=environment.http_client,
                        access_coordinator=environment.coordinator,
                        access_scope=AccessScope(
                            provider_name=environment.provider_name,
                            channel="web",
                        ),
                        access_policy=AccessPolicy(max_concurrency=1),
                        observation_id_factory=ids.observation,
                        provenance_id_factory=ids.provenance,
                        clock=lambda: _wall_timestamp(environment),
                        page_size=2,
                    )

    def test_official_baselines_and_operator_policy_only_tighten(self) -> None:
        self.assertEqual(
            ARXIV_ACCESS_SCOPE,
            AccessScope(provider_name="arxiv", channel="api"),
        )
        self.assertEqual(
            ARXIV_BASELINE_ACCESS_POLICY,
            AccessPolicy(max_concurrency=1, min_start_interval=3.0),
        )
        self.assertEqual(
            PUBLIC_ACCESS_SCOPE,
            AccessScope(provider_name="crossref", channel="api", service_name="public"),
        )
        self.assertEqual(
            PUBLIC_BASELINE_ACCESS_POLICY,
            AccessPolicy(max_concurrency=1, min_start_interval=0.2),
        )
        self.assertEqual(
            POLITE_ACCESS_SCOPE,
            AccessScope(provider_name="crossref", channel="api", service_name="polite"),
        )
        self.assertEqual(
            POLITE_BASELINE_ACCESS_POLICY,
            AccessPolicy(max_concurrency=3, min_start_interval=0.1),
        )
        scenarios = (
            (
                _crossref_environment(
                    operator_policy=AccessPolicy(max_concurrency=99),
                ),
                AccessPolicy(max_concurrency=3, min_start_interval=0.1),
            ),
            (
                _crossref_environment(
                    mailto=None,
                    operator_policy=AccessPolicy(max_concurrency=99),
                ),
                AccessPolicy(max_concurrency=1, min_start_interval=0.2),
            ),
            (
                _crossref_environment(
                    operator_policy=AccessPolicy(
                        max_concurrency=2,
                        min_start_interval=0.5,
                    ),
                ),
                AccessPolicy(max_concurrency=2, min_start_interval=0.5),
            ),
            (
                _arxiv_environment(
                    operator_policy=AccessPolicy(max_concurrency=99),
                ),
                AccessPolicy(max_concurrency=1, min_start_interval=3.0),
            ),
        )
        for environment, expected_policy in scenarios:
            self.addCleanup(environment.close)
            with self.subTest(scope=environment.scope, policy=expected_policy):
                if environment.provider_name == "crossref":
                    environment.queue_http_response(
                        status=200,
                        body=_fixture("crossref", "search-page-1.json"),
                    )
                else:
                    environment.queue_http_response(
                        status=200,
                        body=_fixture("arxiv", "search-page-1.xml"),
                    )
                self.assert_topic_scan(
                    environment,
                    _topic_request(environment.provider_name, 1),
                    outcome="SCAN_LIMIT_REACHED",
                    raw_item_count=1,
                    observation_count=1,
                    relation_count=2 if environment.provider_name == "crossref" else 0,
                )
                self.assertEqual(
                    environment.coordinator.policy_for(environment.scope),
                    expected_policy,
                )

        public_environment = scenarios[1][0]
        public_query = parse_qs(urlsplit(public_environment.transport.calls[0].request.url).query)
        self.assertNotIn("mailto", public_query)

    def test_crossref_search_maps_fields_relations_assets_and_pages_lazily(self) -> None:
        environment = self._crossref()
        page_one = _fixture("crossref", "search-page-1.json")
        environment.queue_http_response(status=200, body=page_one)
        environment.queue_http_response(
            status=200,
            body=_fixture("crossref", "search-page-2.json"),
        )

        result = self.assert_topic_scan(
            environment,
            _topic_request("crossref", 10),
            outcome="EXHAUSTED",
            raw_item_count=3,
            observation_count=3,
            relation_count=2,
        )
        self.assertEqual(len(environment.transport.calls), 2)
        acquisition_times = tuple(
            timestamp
            for scope, timestamp in environment.coordinator.scope_acquisition_times
            if scope == environment.scope
        )
        self.assertGreaterEqual(
            acquisition_times[1] - acquisition_times[0],
            0.1 - 1e-9,
        )
        first_url = urlsplit(environment.transport.calls[0].request.url)
        second_url = urlsplit(environment.transport.calls[1].request.url)
        self.assertEqual(
            (first_url.scheme, first_url.netloc, first_url.path),
            (
                "https",
                "api.crossref.org",
                "/works",
            ),
        )
        first_query = parse_qs(first_url.query)
        second_query = parse_qs(second_url.query)
        self.assertEqual(first_query["query"], ["retrieval systems"])
        self.assertEqual(first_query["rows"], ["2"])
        self.assertEqual(first_query["cursor"], ["*"])
        self.assertEqual(
            first_query["filter"],
            ["from-pub-date:2020-01-01,until-pub-date:2025-12-31"],
        )
        self.assertEqual(first_query["mailto"], ["fixture-contact@example.invalid"])
        self.assertEqual(second_query["cursor"], ["cursor+/two=="])

        observation = result.observations[0]
        metadata = observation.metadata
        self.assertEqual(metadata.title, "A Crossref record")
        self.assertEqual(metadata.abstract, "A safe abstract.")
        self.assertEqual(metadata.publication_date, "2024-03-02")
        self.assertEqual(metadata.publication_year, 2024)
        self.assertEqual(metadata.document_type, "journal-article")
        self.assertEqual(metadata.venue, "Journal of Provider Contracts")
        self.assertEqual(metadata.publisher, "Example Scholarly Press")
        self.assertEqual(metadata.language, "en")
        self.assertEqual(metadata.volume, "12")
        self.assertEqual(metadata.issue, "3")
        self.assertEqual(metadata.pages, "10-20")
        self.assertEqual(metadata.keywords, ())
        self.assertEqual(observation.declared_keywords, ())
        self.assertEqual(observation.version_links, ())
        self.assertEqual(observation.reference_count, 4)
        self.assertEqual(observation.cited_by_count, 9)
        self.assertEqual(
            observation.reference_texts,
            (
                "First cited source, in provider order.",
                "Second source has text but no stable identifier.",
                "Malformed target still leaves its raw reference text.",
            ),
        )
        self.assert_author_mapping(
            metadata.authors,
            (
                ExpectedAuthor(
                    kind="person",
                    display_name="Ada Lovelace",
                    given_name="Ada",
                    family_name="Lovelace",
                    orcid="0000-0002-1825-0097",
                    affiliations=(ExpectedAffiliation(name="Analytical Engine Institute"),),
                ),
                ExpectedAuthor(
                    kind="organization",
                    display_name="Crossref Research Consortium",
                    affiliations=(ExpectedAffiliation(name="Consortium Office"),),
                ),
            ),
        )
        self.assert_identifier_record_id_separation(
            observation,
            expected_identifiers=(Identifier(namespace="doi", value="10.5555/cr.arxiv"),),
            expected_record_id="10.5555/cr.arxiv",
        )
        expected_hints = (
            AssetHint(
                url="https://assets.example.org/article.pdf",
                kind=AssetHintKind.DIRECT_FILE,
                media_type="application/pdf",
                asset_role=AssetRole.PRIMARY_PDF,
                version_role=VersionRole.PUBLISHED,
                license="https://creativecommons.org/licenses/by/4.0/",
            ),
            AssetHint(
                url="https://assets.example.org/article.html",
                kind=AssetHintKind.LANDING_PAGE,
                media_type="text/html",
                asset_role=AssetRole.HTML,
                version_role=VersionRole.ACCEPTED_MANUSCRIPT,
                license="https://example.org/licenses/accepted-manuscript",
            ),
            AssetHint(
                url="https://doi.org/10.5555/CR.ARXIV",
                kind=AssetHintKind.LANDING_PAGE,
            ),
            AssetHint(
                url="https://publisher.example.org/articles/cr-arxiv",
                kind=AssetHintKind.LANDING_PAGE,
            ),
        )
        self.assert_asset_hints(
            observation,
            expected_hints,
            runtime_secret=environment.secret_sentinel,
        )
        self.assertEqual(observation.provenance.input_sha256, sha256_digest(page_one))
        self.assertEqual(observation.provenance.observed_at, _wall_timestamp(environment))

        citing = ProviderLiteratureKey(
            record_id="10.5555/cr.arxiv",
            identifiers=(Identifier(namespace="doi", value="10.5555/cr.arxiv"),),
        )
        self.assert_citing_to_cited(
            result.relations[0],
            citing=citing,
            cited=ProviderLiteratureKey(
                record_id="10.5555/cited.one",
                identifiers=(Identifier(namespace="doi", value="10.5555/cited.one"),),
            ),
        )
        self.assert_citing_to_cited(
            result.relations[1],
            citing=citing,
            cited=ProviderLiteratureKey(
                record_id="10.5555/cited.two",
                identifiers=(Identifier(namespace="doi", value="10.5555/cited.two"),),
            ),
        )
        self.assertNotEqual(result.relations[0].observation_id, result.relations[1].observation_id)
        self.assertEqual(result.relations[0].provenance, observation.provenance)

        sparse = result.observations[1]
        self.assertIsNone(sparse.metadata.title)
        self.assertEqual(sparse.metadata.identifiers, ())
        self.assertEqual(
            sparse.provenance.source_record_id,
            "https://api.crossref.org/works/provider-record-without-doi",
        )
        rejection = accept_observation(sparse)
        self.assertEqual(rejection.outcome, "rejected")
        self.assertEqual(rejection.reason, "missing-title-or-doi")
        self.assertEqual(rejection.observations, ())

        self.assert_no_private_payload(
            result,
            runtime_secret=environment.secret_sentinel,
            forbidden_values=(
                "cursor+/two==",
                "unused-final-cursor",
                "adapter-whitelist-must-ignore-this-key",
                "fixture-member",
                "not-a-version",
                "Provider classification must not become keywords",
                "fixture-secret",
            ),
        )

    def test_crossref_scan_limit_has_no_prefetch_and_partial_failure_keeps_prior_items(
        self,
    ) -> None:
        environment = self._crossref()
        environment.queue_http_response(
            status=200,
            body=_fixture("crossref", "search-page-1.json"),
        )
        limited = self.assert_topic_scan(
            environment,
            _topic_request("crossref", 1),
            outcome="SCAN_LIMIT_REACHED",
            raw_item_count=1,
            observation_count=1,
            relation_count=2,
        )
        self.assertEqual(len(environment.transport.calls), 1)
        self.assertEqual(limited.observations[0].metadata.title, "A Crossref record")

        environment.reset_http()
        environment.queue_http_response(
            status=200,
            body=_fixture("crossref", "search-page-1.json"),
        )
        environment.queue_http_response(
            status=200,
            body=_fixture("crossref", "malformed.json"),
        )
        partial = self.assert_topic_scan(
            environment,
            _topic_request("crossref", 10),
            outcome="FAILED",
            raw_item_count=2,
            observation_count=2,
            relation_count=2,
        )
        self.assert_stable_failure(
            partial,
            expected_code="metadata-provider-malformed-json",
            forbidden_values=("cursor+/two==", environment.secret_sentinel),
        )

    def test_crossref_lookup_encodes_doi_path_and_uses_provider_key(self) -> None:
        environment = self._crossref()
        environment.queue_http_response(
            status=200,
            body=_fixture("crossref", "lookup.json"),
        )
        result = self.assert_lookup_scan(
            environment,
            MetadataLookupRequest(
                provider_name="crossref",
                key=ProviderLiteratureKey(record_id="10.5555/LOOKUP.VALUE"),
                scan_limit=2,
            ),
            outcome="EXHAUSTED",
            raw_item_count=1,
            observation_count=1,
        )
        self.assertEqual(result.observations[0].metadata.publication_date, "2021-06")
        request_url = urlsplit(environment.transport.calls[0].request.url)
        self.assertEqual(request_url.scheme, "https")
        self.assertEqual(request_url.netloc, "api.crossref.org")
        self.assertEqual(request_url.path, "/works/10.5555%2Flookup.value")
        self.assertEqual(
            parse_qs(request_url.query)["mailto"],
            ["fixture-contact@example.invalid"],
        )

    def test_crossref_lookup_accepts_equivalent_doi_keys(self) -> None:
        cases = (
            (
                "record-id",
                ProviderLiteratureKey(record_id=" doi:10.5555/LOOKUP.VALUE "),
            ),
            (
                "identifier",
                ProviderLiteratureKey(
                    identifiers=(
                        Identifier(
                            namespace=" DOI ",
                            value=" https://doi.org/10.5555/LOOKUP.VALUE ",
                        ),
                    )
                ),
            ),
        )
        for source, key in cases:
            with self.subTest(source=source):
                environment = self._crossref()
                environment.queue_http_response(
                    status=200,
                    body=_fixture("crossref", "lookup.json"),
                )

                result = self.assert_lookup_scan(
                    environment,
                    MetadataLookupRequest(
                        provider_name="crossref",
                        key=key,
                        scan_limit=1,
                    ),
                    outcome="EXHAUSTED",
                    raw_item_count=1,
                    observation_count=1,
                )

                request_url = urlsplit(environment.transport.calls[0].request.url)
                self.assertEqual(request_url.path, "/works/10.5555%2Flookup.value")
                self.assertEqual(
                    result.observations[0].metadata.identifiers,
                    (Identifier(namespace="doi", value="10.5555/lookup.value"),),
                )

    def test_crossref_lookup_rejects_unexpected_missing_or_invalid_response_doi(
        self,
    ) -> None:
        cases: tuple[tuple[str, object], ...] = (
            ("unexpected", "10.5555/not-the-requested-work"),
            ("missing", None),
            ("invalid", "fixture-private-invalid-doi"),
        )
        for response_kind, response_doi in cases:
            with self.subTest(response_kind=response_kind):
                environment = self._crossref()
                payload = cast(
                    dict[str, object],
                    json.loads(_fixture("crossref", "lookup.json")),
                )
                message = cast(dict[str, object], payload["message"])
                if response_doi is None:
                    message.pop("DOI")
                else:
                    message["DOI"] = response_doi
                raw_payload = json.dumps(payload, separators=(",", ":")).encode("utf-8")
                environment.queue_http_response(status=200, body=raw_payload)

                result = self.assert_lookup_scan(
                    environment,
                    MetadataLookupRequest(
                        provider_name="crossref",
                        key=ProviderLiteratureKey(
                            identifiers=(
                                Identifier(
                                    namespace="doi",
                                    value="doi:10.5555/lookup.value",
                                ),
                            )
                        ),
                        scan_limit=1,
                    ),
                    outcome="FAILED",
                    raw_item_count=1,
                    observation_count=0,
                    relation_count=0,
                )
                self.assert_stable_failure(
                    result,
                    expected_code="metadata-provider-invalid-record",
                    forbidden_values=(
                        raw_payload.decode("utf-8"),
                        environment.secret_sentinel,
                        "fixture-private-invalid-doi",
                        "10.5555/not-the-requested-work",
                    ),
                )
                self.assert_no_private_payload(
                    result,
                    runtime_secret=environment.secret_sentinel,
                    forbidden_values=(
                        "fixture-private-invalid-doi",
                        "10.5555/not-the-requested-work",
                    ),
                )

    def test_crossref_preserves_unenumerated_nonblank_document_type(self) -> None:
        environment = self._crossref()
        payload = cast(dict[str, object], json.loads(_fixture("crossref", "lookup.json")))
        message = cast(dict[str, object], payload["message"])
        message["type"] = "Future-Research-Object"
        environment.queue_http_response(
            status=200,
            body=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
        )

        result = self.assert_lookup_scan(
            environment,
            MetadataLookupRequest(
                provider_name="crossref",
                key=ProviderLiteratureKey(record_id="10.5555/lookup.value"),
                scan_limit=1,
            ),
            outcome="EXHAUSTED",
            raw_item_count=1,
            observation_count=1,
        )

        self.assertEqual(
            result.observations[0].metadata.document_type,
            "future-research-object",
        )

    def test_crossref_throttle_feedback_blocks_the_injected_shared_scope(self) -> None:
        environment = self._crossref()
        environment.queue_http_response(
            status=429,
            headers=(
                ("Retry-After", "5"),
                ("X-Rate-Limit-Limit", "10"),
                ("X-Rate-Limit-Interval", "1s"),
            ),
        )
        result = self.assert_topic_scan(
            environment,
            _topic_request("crossref", 2),
            outcome="FAILED",
            raw_item_count=0,
            observation_count=0,
        )
        self.assert_stable_failure(
            result,
            expected_code="metadata-provider-throttled",
            forbidden_values=(environment.secret_sentinel,),
        )
        with self.assertRaises(AdmissionTimeout):
            environment.coordinator.acquire_scope(environment.scope, timeout=0.005)
        environment.monotonic_clock.advance(5)
        permit = environment.coordinator.acquire_scope(environment.scope, timeout=0.01)
        permit.release()

    def test_crossref_conflicting_vendor_interval_still_blocks_shared_scope(self) -> None:
        environment = self._crossref()
        environment.queue_http_response(
            status=429,
            headers=(
                ("X-Rate-Limit-Interval", "1s"),
                ("x-rate-limit-interval", "2s"),
            ),
        )

        result = self.assert_topic_scan(
            environment,
            _topic_request("crossref", 1),
            outcome="FAILED",
            raw_item_count=0,
            observation_count=0,
        )

        self.assert_stable_failure(
            result,
            expected_code="metadata-provider-conflicting-header",
        )
        self.assertEqual(len(environment.coordinator.feedback_records), 1)
        self.assertTrue(environment.coordinator.feedback_records[0][1].throttled)
        with self.assertRaises(AdmissionTimeout):
            environment.coordinator.acquire_scope(environment.scope, timeout=0.005)
        policy = environment.coordinator.policy_for(environment.scope)
        environment.monotonic_clock.advance(policy.backoff_seconds)
        permit = environment.coordinator.acquire_scope(environment.scope, timeout=0.01)
        permit.release()

    def test_crossref_conflicting_feedback_is_atomic_with_scope_release(self) -> None:
        environment = self._crossref()
        environment.queue_http_response(
            status=429,
            headers=(
                ("X-Rate-Limit-Interval", "1s"),
                ("x-rate-limit-interval", "2s"),
            ),
        )
        environment.queue_http_response(
            status=200,
            body=_fixture("crossref", "search-page-1.json"),
        )
        feedback_interpretation_entered = threading.Event()
        continue_feedback_interpretation = threading.Event()
        first_finished = threading.Event()
        second_finished = threading.Event()
        worker_errors: list[BaseException] = []
        from sciretriever.metadata.providers.crossref.adapter import (
            _crossref_rate_interval as parse_crossref_rate_interval,
        )

        def blocking_rate_interval(headers: tuple[Header, ...]) -> float | None:
            feedback_interpretation_entered.set()
            if not continue_feedback_interpretation.wait(5.0):
                raise AssertionError("feedback interpretation barrier timed out")
            return parse_crossref_rate_interval(headers)

        def invoke(finished: threading.Event) -> None:
            try:
                environment.api.search_topic(_topic_request("crossref", 1))
            except BaseException as error:
                worker_errors.append(error)
            finally:
                finished.set()

        original_rate_interval = (
            "sciretriever.metadata.providers.crossref.adapter._crossref_rate_interval"
        )
        with patch(original_rate_interval, side_effect=blocking_rate_interval):
            first = threading.Thread(target=invoke, args=(first_finished,))
            second = threading.Thread(target=invoke, args=(second_finished,))
            second_started = False
            first.start()
            try:
                self.assertTrue(feedback_interpretation_entered.wait(1.0))
                second.start()
                second_started = True
                deadline = time.monotonic() + 1.0
                while True:
                    with environment.coordinator._condition:
                        waiter_is_queued = any(
                            ticket.scope == environment.scope
                            for ticket in environment.coordinator._scope_waiters
                        )
                    if waiter_is_queued:
                        break
                    if second_finished.is_set():
                        self.fail(
                            "a same-scope request escaped while 429 feedback was being interpreted"
                        )
                    if time.monotonic() >= deadline:
                        self.fail("same-scope request did not reach the admission waiter queue")
                    second_finished.wait(0.001)

                self.assertEqual(len(environment.transport.calls), 1)
                continue_feedback_interpretation.set()
                self.assertTrue(first_finished.wait(1.0))
                self.assertFalse(second_finished.is_set())
                self.assertEqual(len(environment.transport.calls), 1)

                policy = environment.coordinator.policy_for(environment.scope)
                environment.monotonic_clock.advance(policy.backoff_seconds)
                environment.coordinator.wake()
                self.assertTrue(second_finished.wait(1.0))
                self.assertEqual(len(environment.transport.calls), 2)
                self.assertEqual(worker_errors, [])
            finally:
                continue_feedback_interpretation.set()
                environment.monotonic_clock.advance(60.0)
                environment.coordinator.wake()
                first.join(1.0)
                if second_started:
                    second.join(1.0)
                self.assertFalse(first.is_alive())
                self.assertFalse(second.is_alive())

    def test_crossref_exact_input_replay_reuses_literature_and_relation_facts(self) -> None:
        environment = self._crossref()
        page = _fixture("crossref", "search-page-1.json")
        environment.queue_http_response(status=200, body=page)
        first = self.assert_topic_scan(
            environment,
            _topic_request("crossref", 1),
            outcome="SCAN_LIMIT_REACHED",
            raw_item_count=1,
            observation_count=1,
            relation_count=2,
        )
        environment.wall_clock.advance(60)
        environment.queue_http_response(status=200, body=page)
        replay = self.assert_topic_scan(
            environment,
            _topic_request("crossref", 1),
            outcome="SCAN_LIMIT_REACHED",
            raw_item_count=1,
            observation_count=1,
            relation_count=2,
        )

        self.assertEqual(
            first.observations[0].observation_id, replay.observations[0].observation_id
        )
        self.assertEqual(
            first.observations[0].provenance.provenance_id,
            replay.observations[0].provenance.provenance_id,
        )
        self.assertNotEqual(
            first.observations[0].provenance.observed_at,
            replay.observations[0].provenance.observed_at,
        )
        self.assertEqual(
            tuple(item.observation_id for item in first.relations),
            tuple(item.observation_id for item in replay.relations),
        )

        with TemporaryDirectory(prefix="sciretriever-crossref-replay-") as temporary:
            temporary_path = Path(temporary)
            engine = CatalogEngine(temporary_path / "catalog.sqlite")
            writer = LiteratureWriter(engine)
            storage_root = StorageRoot(temporary_path / "artifacts")
            artifact_store = ArtifactStore(storage_root)
            verified_reader = VerifiedReader(storage_root)
            literature_api = LiteratureApi(
                LiteratureService(
                    read_port=LiteraturePreconditionReader(engine, verified_reader),
                    identity_port=writer,
                    content_port=SqliteContentPublication(
                        engine,
                        artifact_store,
                        verified_reader,
                    ),
                    reference_port=writer,
                    maintenance_port=writer,
                    id_factory=_LiteratureIdFactories(),
                )
            )
            publication = MetadataPublication(
                literature_api,
                SqliteProviderRelationObservationPublication(writer),
            )

            accepted = publication.publish_observation(first.observations[0])
            self.assertEqual(accepted.decision, "created")
            assert accepted.literature is not None
            writer.publish_exhaustion(
                AutomaticPdfAcquisitionExhaustion(literature_id=accepted.literature.literature_id)
            )
            for relation in first.relations:
                publication.publish_relation_observation(relation)

            replayed = publication.publish_observation(replay.observations[0])
            for relation in replay.relations:
                publication.publish_relation_observation(relation)

            self.assertEqual(replayed.decision, "matched")
            self.assertTrue(replayed.deduplicated)
            self.assertEqual(replayed.observation, first.observations[0])
            with engine.read_snapshot() as connection:
                self.assertEqual(
                    connection.execute("SELECT count(*) FROM metadata_observations").fetchone(),
                    (1,),
                )
                self.assertEqual(
                    connection.execute(
                        "SELECT count(*) FROM provider_relation_observations"
                    ).fetchone(),
                    (2,),
                )
                self.assertEqual(
                    connection.execute(
                        "SELECT count(*) FROM automatic_pdf_acquisition_exhaustions"
                    ).fetchone(),
                    (1,),
                )
                self.assertEqual(
                    connection.execute("SELECT count(*) FROM provenances").fetchone(),
                    (1,),
                )

            relation_ids = tuple(item.observation_id for item in replay.relations)
            stored = LiteratureReader(
                engine,
                verified_reader,
            ).read_provider_relation_observations(
                ProviderRelationObservationReadRequest(observation_ids=relation_ids)
            )
            self.assertEqual(
                {item.observation_id for item in stored.observations},
                set(relation_ids),
            )


class ArxivAdapterTests(ProviderContractCase, unittest.TestCase):
    def provider_contract_binding(self) -> ContractBinding:
        return _arxiv_contract_binding()

    def _crossref(self) -> ContractEnvironment:
        environment = _crossref_environment()
        self.addCleanup(environment.close)
        return environment

    def _arxiv(self) -> ContractEnvironment:
        environment = _arxiv_environment()
        self.addCleanup(environment.close)
        return environment

    def _assert_arxiv_atomic_feedback(
        self,
        environment: ContractEnvironment,
    ) -> AccessFeedback:
        self.assertEqual(len(environment.coordinator.feedback_records), 1)
        self.assertEqual(len(environment.coordinator.feedback_sources), 1)
        source = environment.coordinator.feedback_sources[0]
        self.assertIsInstance(source, AccessPermit)
        assert isinstance(source, AccessPermit)
        feedback_index = next(
            index
            for index, event in enumerate(environment.coordinator.permit_release_events)
            if event[0] == "feedback" and event[1] is source
        )
        release_index = next(
            index
            for index, event in enumerate(environment.coordinator.permit_release_events)
            if event[0] == "release" and event[1] is source
        )
        self.assertLess(feedback_index, release_index)
        return environment.coordinator.feedback_records[0][1]

    def test_arxiv_search_maps_atom_semantics_and_opensearch_pagination(self) -> None:
        environment = self._arxiv()
        page_one = _fixture("arxiv", "search-page-1.xml")
        environment.queue_http_response(status=200, body=page_one)
        environment.queue_http_response(
            status=200,
            body=_fixture("arxiv", "search-page-2.xml"),
        )
        result = self.assert_topic_scan(
            environment,
            _topic_request("arxiv", 10),
            outcome="EXHAUSTED",
            raw_item_count=3,
            observation_count=3,
        )
        self.assertEqual(result.relations, ())
        self.assertEqual(len(environment.transport.calls), 2)
        acquisition_times = tuple(
            timestamp
            for scope, timestamp in environment.coordinator.scope_acquisition_times
            if scope == environment.scope
        )
        self.assertGreaterEqual(
            acquisition_times[1] - acquisition_times[0],
            3.0 - 1e-9,
        )
        first_url = urlsplit(environment.transport.calls[0].request.url)
        second_url = urlsplit(environment.transport.calls[1].request.url)
        self.assertEqual(
            (first_url.scheme, first_url.netloc, first_url.path),
            (
                "https",
                "export.arxiv.org",
                "/api/query",
            ),
        )
        first_query = parse_qs(first_url.query)
        second_query = parse_qs(second_url.query)
        self.assertIn("all:(retrieval systems)", first_query["search_query"][0])
        self.assertIn(
            "submittedDate:[202001010000 TO 202512312359]",
            first_query["search_query"][0],
        )
        self.assertEqual(first_query["start"], ["0"])
        self.assertEqual(first_query["max_results"], ["2"])
        self.assertEqual(second_query["start"], ["2"])

        observation = result.observations[0]
        metadata = observation.metadata
        self.assertEqual(metadata.title, "A deliberately wrapped arXiv title")
        self.assertEqual(
            metadata.abstract,
            "A summary with provider whitespace normalized safely.",
        )
        self.assertEqual(metadata.publication_date, "2025-01-03")
        self.assertEqual(metadata.publication_year, 2025)
        self.assertEqual(metadata.document_type, "preprint")
        self.assertEqual(metadata.keywords, ())
        self.assertEqual(observation.version_role, VersionRole.PREPRINT)
        self.assertEqual(observation.version_links, ())
        self.assertEqual(observation.declared_keywords, ())
        self.assertEqual(observation.reference_texts, ())
        self.assertIsNone(observation.reference_count)
        self.assertIsNone(observation.cited_by_count)
        self.assert_author_mapping(
            metadata.authors,
            (
                ExpectedAuthor(
                    kind="unknown",
                    display_name="Ada Example",
                    affiliations=(
                        ExpectedAffiliation(name="Institute One"),
                        ExpectedAffiliation(name="Institute Two"),
                    ),
                ),
                ExpectedAuthor(kind="unknown", display_name="Research Collaboration"),
            ),
        )
        self.assert_identifier_record_id_separation(
            observation,
            expected_identifiers=(
                Identifier(namespace="arxiv", value="2501.01234"),
                Identifier(namespace="doi", value="10.5555/shared.record"),
            ),
            expected_record_id="2501.01234v2",
        )
        expected_hints = (
            AssetHint(
                url="https://arxiv.org/abs/2501.01234v2",
                kind=AssetHintKind.LANDING_PAGE,
                media_type="text/html",
                asset_role=AssetRole.HTML,
                version_role=VersionRole.PREPRINT,
            ),
            AssetHint(
                url="https://arxiv.org/pdf/2501.01234v2",
                kind=AssetHintKind.DIRECT_FILE,
                media_type="application/pdf",
                asset_role=AssetRole.PRIMARY_PDF,
                version_role=VersionRole.PREPRINT,
            ),
        )
        self.assert_asset_hints(
            observation,
            expected_hints,
            runtime_secret=environment.secret_sentinel,
        )
        self.assertEqual(observation.provenance.input_sha256, sha256_digest(page_one))
        self.assertEqual(result.observations[1].provenance.source_record_id, "hep-th/9901001v3")
        self.assertEqual(
            result.observations[1].metadata.identifiers,
            (Identifier(namespace="arxiv", value="hep-th/9901001"),),
        )
        self.assert_no_private_payload(
            result,
            runtime_secret=environment.secret_sentinel,
            forbidden_values=(
                "fixture-secret",
                "Must not create a version link or relation.",
                "private",
            ),
        )

    def test_arxiv_malformed_retry_after_still_throttles_atomically(self) -> None:
        environment = self._arxiv()
        environment.queue_http_response(
            status=429,
            headers=(("Retry-After", "not-a-delay"),),
        )

        result = self.assert_topic_scan(
            environment,
            _topic_request("arxiv", 1),
            outcome="FAILED",
            raw_item_count=0,
            observation_count=0,
        )

        self.assert_stable_failure(
            result,
            expected_code="metadata-provider-throttled",
        )
        feedback = self._assert_arxiv_atomic_feedback(environment)
        self.assertTrue(feedback.throttled)
        self.assertIsNone(feedback.retry_after)
        with self.assertRaises(AdmissionTimeout):
            environment.coordinator.acquire_scope(environment.scope, timeout=0.005)
        policy = environment.coordinator.policy_for(environment.scope)
        environment.monotonic_clock.advance(max(policy.backoff_seconds, policy.min_start_interval))
        permit = environment.coordinator.acquire_scope(environment.scope, timeout=0.01)
        permit.release()

    def test_arxiv_service_failure_uses_bounded_shared_backoff(self) -> None:
        environment = self._arxiv()
        environment.queue_http_response(status=503)

        result = self.assert_topic_scan(
            environment,
            _topic_request("arxiv", 1),
            outcome="FAILED",
            raw_item_count=0,
            observation_count=0,
        )

        self.assert_stable_failure(
            result,
            expected_code="metadata-provider-http-status",
        )
        feedback = self._assert_arxiv_atomic_feedback(environment)
        self.assertTrue(feedback.throttled)
        self.assertIsNone(feedback.retry_after)
        with self.assertRaises(AdmissionTimeout):
            environment.coordinator.acquire_scope(environment.scope, timeout=0.005)

    def test_arxiv_conflicting_feedback_blocks_same_scope_until_backoff(self) -> None:
        environment = self._arxiv()
        environment.queue_http_response(
            status=429,
            headers=(
                ("Retry-After", "1"),
                ("retry-after", "2"),
            ),
        )
        environment.queue_http_response(
            status=200,
            body=_fixture("arxiv", "zero-results.xml"),
        )
        feedback_interpretation_entered = threading.Event()
        continue_feedback_interpretation = threading.Event()
        first_finished = threading.Event()
        second_finished = threading.Event()
        worker_errors: list[BaseException] = []

        def blocking_feedback(
            status_code: int,
            headers: Sequence[Header],
            *,
            wall_now: datetime,
        ) -> AccessFeedback | None:
            feedback_interpretation_entered.set()
            if not continue_feedback_interpretation.wait(5.0):
                raise AssertionError("feedback interpretation barrier timed out")
            return interpret_retry_after_feedback(
                status_code,
                headers,
                wall_now=wall_now,
            )

        def invoke(finished: threading.Event) -> None:
            try:
                environment.api.search_topic(_topic_request("arxiv", 1))
            except BaseException as error:
                worker_errors.append(error)
            finally:
                finished.set()

        feedback_interpreter = "sciretriever.metadata.providers.arxiv.adapter.retry_after_feedback"
        with patch(feedback_interpreter, side_effect=blocking_feedback):
            first = threading.Thread(target=invoke, args=(first_finished,))
            second = threading.Thread(target=invoke, args=(second_finished,))
            second_started = False
            first.start()
            try:
                self.assertTrue(feedback_interpretation_entered.wait(1.0))
                second.start()
                second_started = True
                deadline = time.monotonic() + 1.0
                while True:
                    with environment.coordinator._condition:
                        waiter_is_queued = any(
                            ticket.scope == environment.scope
                            for ticket in environment.coordinator._scope_waiters
                        )
                    if waiter_is_queued:
                        break
                    if second_finished.is_set():
                        self.fail("a same-scope request escaped while feedback was interpreted")
                    if time.monotonic() >= deadline:
                        self.fail("same-scope request did not reach the admission queue")
                    second_finished.wait(0.001)

                self.assertEqual(len(environment.transport.calls), 1)
                continue_feedback_interpretation.set()
                self.assertTrue(first_finished.wait(1.0))
                self.assertFalse(second_finished.is_set())
                self.assertEqual(len(environment.transport.calls), 1)

                feedback = self._assert_arxiv_atomic_feedback(environment)
                self.assertTrue(feedback.throttled)
                self.assertIsNone(feedback.retry_after)
                policy = environment.coordinator.policy_for(environment.scope)
                environment.monotonic_clock.advance(policy.backoff_seconds - 0.001)
                environment.coordinator.wake()
                self.assertFalse(second_finished.wait(0.05))
                self.assertEqual(len(environment.transport.calls), 1)

                environment.monotonic_clock.advance(0.001)
                environment.coordinator.wake()
                self.assertTrue(second_finished.wait(1.0))
                self.assertEqual(len(environment.transport.calls), 2)
                self.assertEqual(worker_errors, [])
            finally:
                continue_feedback_interpretation.set()
                environment.monotonic_clock.advance(60.0)
                environment.coordinator.wake()
                first.join(1.0)
                if second_started:
                    second.join(1.0)
                self.assertFalse(first.is_alive())
                self.assertFalse(second.is_alive())

    def test_arxiv_lookup_uses_id_list_and_preserves_the_requested_revision(self) -> None:
        environment = self._arxiv()
        environment.queue_http_response(
            status=200,
            body=_fixture("arxiv", "lookup.xml"),
        )
        result = self.assert_lookup_scan(
            environment,
            MetadataLookupRequest(
                provider_name="arxiv",
                key=ProviderLiteratureKey(record_id="arXiv:2106.14834v1"),
                scan_limit=2,
            ),
            outcome="EXHAUSTED",
            raw_item_count=1,
            observation_count=1,
        )
        observation = result.observations[0]
        self.assertEqual(observation.provenance.source_record_id, "2106.14834v1")
        self.assertEqual(
            observation.metadata.identifiers,
            (Identifier(namespace="arxiv", value="2106.14834"),),
        )
        query = parse_qs(urlsplit(environment.transport.calls[0].request.url).query)
        self.assertEqual(query["id_list"], ["2106.14834v1"])
        self.assertNotIn("search_query", query)

    def test_arxiv_zero_results_and_truncation_are_stable_without_half_observations(
        self,
    ) -> None:
        environment = self._arxiv()
        environment.queue_http_response(
            status=200,
            body=_fixture("arxiv", "zero-results.xml"),
        )
        empty = self.assert_topic_scan(
            environment,
            _topic_request("arxiv", 5, year_from=None, year_to=None),
            outcome="EXHAUSTED",
            raw_item_count=0,
            observation_count=0,
        )
        self.assertEqual(empty.observations, ())

        environment.reset_http()
        environment.queue_http_response(
            status=200,
            body=_fixture("arxiv", "truncated.xml"),
        )
        truncated = self.assert_topic_scan(
            environment,
            _topic_request("arxiv", 5),
            outcome="FAILED",
            raw_item_count=0,
            observation_count=0,
        )
        self.assert_stable_failure(
            truncated,
            expected_code="metadata-provider-malformed-xml",
            forbidden_values=(environment.secret_sentinel,),
        )

        environment.reset_http()
        environment.queue_http_response(
            status=200,
            body=_fixture("arxiv", "search-page-1.xml"),
        )
        environment.queue_http_response(
            status=200,
            body=_fixture("arxiv", "truncated.xml"),
        )
        partial = self.assert_topic_scan(
            environment,
            _topic_request("arxiv", 5),
            outcome="FAILED",
            raw_item_count=2,
            observation_count=2,
        )
        self.assert_stable_failure(
            partial,
            expected_code="metadata-provider-malformed-xml",
        )

    def test_arxiv_rejects_wrong_namespace_shape_and_oversize_is_bounded(self) -> None:
        environment = self._arxiv()
        wrong_entry = b"""\
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <opensearch:totalResults>1</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
  <opensearch:itemsPerPage>1</opensearch:itemsPerPage>
  <entry xmlns=""><id>http://arxiv.org/abs/2501.01234v1</id></entry>
</feed>"""
        environment.queue_http_response(status=200, body=wrong_entry)
        wrong = self.assert_topic_scan(
            environment,
            _topic_request("arxiv", 5),
            outcome="FAILED",
            raw_item_count=0,
            observation_count=0,
        )
        self.assert_stable_failure(
            wrong,
            expected_code="metadata-provider-unknown-shape",
        )

        environment.reset_http()
        environment.queue_http_response(status=200, body=b" " * 1_100_000)
        oversized = self.assert_topic_scan(
            environment,
            _topic_request("arxiv", 5),
            outcome="FAILED",
            raw_item_count=0,
            observation_count=0,
        )
        self.assert_stable_failure(
            oversized,
            expected_code="metadata-provider-response-too-large",
        )

    def test_same_doi_observations_remain_distinct_and_literature_matches_them(self) -> None:
        crossref = self._crossref()
        crossref.queue_http_response(
            status=200,
            body=_fixture("crossref", "search-page-1.json"),
        )
        crossref.queue_http_response(
            status=200,
            body=_fixture("crossref", "search-page-2.json"),
        )
        crossref_result = self.assert_topic_scan(
            crossref,
            _topic_request("crossref", 10),
            outcome="EXHAUSTED",
            raw_item_count=3,
            observation_count=3,
            relation_count=2,
        )
        crossref_observation = crossref_result.observations[2]

        arxiv = self._arxiv()
        arxiv.queue_http_response(
            status=200,
            body=_fixture("arxiv", "search-page-1.xml"),
        )
        arxiv_observation = self.assert_topic_scan(
            arxiv,
            _topic_request("arxiv", 1),
            outcome="SCAN_LIMIT_REACHED",
            raw_item_count=1,
            observation_count=1,
        ).observations[0]

        self.assertNotEqual(crossref_observation.observation_id, arxiv_observation.observation_id)
        self.assertEqual(
            crossref_observation.metadata.identifiers[0],
            arxiv_observation.metadata.identifiers[1],
        )
        existing = Literature(
            literature_id=LiteratureId("00000000-0000-0000-0000-000000009001"),
            meta_literature_id=MetaLiteratureId("00000000-0000-0000-0000-000000009002"),
            version_role=VersionRole.PUBLISHED,
            metadata=crossref_observation.metadata,
            status=LiteratureStatus.UNREVIEWED,
        )
        decision = accept_observation(
            arxiv_observation,
            existing_literature=(existing,),
            existing_observations=(crossref_observation,),
        )
        self.assertEqual(decision.outcome, "matched")
        self.assertEqual(decision.literature, existing)
        self.assertEqual(decision.observations, (crossref_observation, arxiv_observation))

    def test_programming_errors_and_controlled_cancellation_propagate(self) -> None:
        def programming_error() -> ObservationId:
            raise RuntimeError("programming sentinel")

        environment = _crossref_environment(observation_id_factory=programming_error)
        self.addCleanup(environment.close)
        environment.queue_http_response(
            status=200,
            body=_fixture("crossref", "search-page-1.json"),
        )
        with self.assertRaisesRegex(RuntimeError, "programming sentinel"):
            environment.api.search_topic(_topic_request("crossref", 1))

        def cancelled() -> ObservationId:
            raise asyncio.CancelledError

        cancelled_environment = _arxiv_environment(observation_id_factory=cancelled)
        self.addCleanup(cancelled_environment.close)
        cancelled_environment.queue_http_response(
            status=200,
            body=_fixture("arxiv", "search-page-1.xml"),
        )
        with self.assertRaises(asyncio.CancelledError):
            cancelled_environment.api.search_topic(_topic_request("arxiv", 1))


if __name__ == "__main__":
    unittest.main()
