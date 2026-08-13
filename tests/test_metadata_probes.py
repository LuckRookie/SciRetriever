from __future__ import annotations

import json
import unittest
from collections.abc import Callable
from typing import TypeAlias, cast
from urllib.parse import parse_qs, urlsplit
from uuid import UUID

from sciretriever.metadata.ports import MetadataLookupPort, ReferenceQueryPort, TopicSearchPort
from sciretriever.metadata.probe import (
    MetadataProbeEvidence,
    MetadataProbeFailure,
    MetadataProbePort,
)
from sciretriever.metadata.providers.arxiv import (
    ACCESS_SCOPE as ARXIV_SCOPE,
)
from sciretriever.metadata.providers.arxiv import (
    ArxivAdapter,
)
from sciretriever.metadata.providers.core import ACCESS_SCOPE as CORE_SCOPE
from sciretriever.metadata.providers.core import CoreAdapter
from sciretriever.metadata.providers.crossref import (
    POLITE_ACCESS_SCOPE as CROSSREF_SCOPE,
)
from sciretriever.metadata.providers.crossref import CrossrefAdapter
from sciretriever.metadata.providers.datacite import ACCESS_SCOPE as DATACITE_SCOPE
from sciretriever.metadata.providers.datacite import DataCiteAdapter
from sciretriever.metadata.providers.europe_pmc import ACCESS_SCOPE as EUROPE_PMC_SCOPE
from sciretriever.metadata.providers.europe_pmc import EuropePmcAdapter
from sciretriever.metadata.providers.openalex import ACCESS_SCOPE as OPENALEX_SCOPE
from sciretriever.metadata.providers.openalex import OpenAlexAdapter
from sciretriever.metadata.providers.opencitations import (
    ACCESS_SCOPE as OPENCITATIONS_SCOPE,
)
from sciretriever.metadata.providers.opencitations import OpenCitationsAdapter
from sciretriever.metadata.providers.semantic_scholar import (
    ACCESS_SCOPE as SEMANTIC_SCOPE,
)
from sciretriever.metadata.providers.semantic_scholar import SemanticScholarAdapter
from sciretriever.model.primitives import ObservationId, ProvenanceId, UtcTimestamp
from sciretriever.network.admission import AccessCoordinator, AccessScope
from tests.metadata_provider_contract import ContractEnvironment, ContractPorts

_Builder = Callable[
    [
        ContractEnvironment,
        Callable[[], ObservationId],
        Callable[[], ProvenanceId],
        Callable[[], UtcTimestamp],
    ],
    object,
]
_Adapter: TypeAlias = TopicSearchPort | MetadataLookupPort | ReferenceQueryPort


class _ForbiddenFactFactory:
    def __init__(self, name: str) -> None:
        self.name = name
        self.calls = 0

    def __call__(self) -> object:
        self.calls += 1
        raise AssertionError(f"probe called forbidden {self.name} factory")


def _clock() -> UtcTimestamp:
    return UtcTimestamp("2026-08-12T00:00:00Z")


def _id_factory(value: int, kind: type[ObservationId] | type[ProvenanceId]) -> Callable[[], object]:
    return lambda: kind(str(UUID(int=value)))


def _environment(
    provider_name: str,
    scope: AccessScope,
    builder: _Builder,
    *,
    observation_factory: Callable[[], ObservationId],
    provenance_factory: Callable[[], ProvenanceId],
    clock_factory: Callable[[], UtcTimestamp] = _clock,
) -> ContractEnvironment:
    def assemble(environment: ContractEnvironment) -> ContractPorts:
        adapter = builder(
            environment,
            observation_factory,
            provenance_factory,
            clock_factory,
        )
        topic = cast(TopicSearchPort, adapter)
        lookup = cast(MetadataLookupPort, adapter)
        return ContractPorts(
            topic_search=topic,
            lookup=lookup,
            reference_query=(
                cast(ReferenceQueryPort, adapter)
                if provider_name
                in {"semantic-scholar", "openalex", "europe-pmc", "datacite", "core"}
                else None
            ),
        )

    capabilities = {"search", "lookup"}
    if provider_name in {"semantic-scholar", "openalex", "europe-pmc", "datacite", "core"}:
        capabilities.add("references")
    if provider_name == "opencitations":
        capabilities = {"lookup", "references"}

        # OpenCitations deliberately has no topic-search capability.
        def assemble(environment: ContractEnvironment) -> ContractPorts:
            adapter = builder(
                environment,
                observation_factory,
                provenance_factory,
                clock_factory,
            )
            return ContractPorts(
                lookup=cast(MetadataLookupPort, adapter),
                reference_query=cast(ReferenceQueryPort, adapter),
            )

    return ContractEnvironment(
        provider_name=provider_name,
        capabilities=cast(object, frozenset(capabilities)),  # type: ignore[arg-type]
        port_factory=assemble,
        expected_scope=scope,
    )


def _builders() -> dict[str, tuple[AccessScope, _Builder]]:
    return {
        "crossref": (
            CROSSREF_SCOPE,
            lambda environment, observation, provenance, clock: CrossrefAdapter(
                http_client=environment.http_client,
                access_coordinator=environment.coordinator,
                access_scope=environment.scope,
                access_policy=environment.policy,
                observation_id_factory=observation,
                provenance_id_factory=provenance,
                clock=clock,
                mailto="probe@example.invalid",
            ),
        ),
        "semantic-scholar": (
            SEMANTIC_SCOPE,
            lambda environment, observation, provenance, clock: SemanticScholarAdapter(
                http_client=environment.http_client,
                access_coordinator=environment.coordinator,
                access_scope=environment.scope,
                access_policy=environment.policy,
                observation_id_factory=observation,
                provenance_id_factory=provenance,
                clock=clock,
                api_key=environment.secret_sentinel,
            ),
        ),
        "arxiv": (
            ARXIV_SCOPE,
            lambda environment, observation, provenance, clock: ArxivAdapter(
                http_client=environment.http_client,
                access_coordinator=environment.coordinator,
                access_scope=environment.scope,
                access_policy=environment.policy,
                observation_id_factory=observation,
                provenance_id_factory=provenance,
                clock=clock,
            ),
        ),
        "openalex": (
            OPENALEX_SCOPE,
            lambda environment, observation, provenance, clock: OpenAlexAdapter(
                http_client=environment.http_client,
                access_coordinator=environment.coordinator,
                access_scope=environment.scope,
                access_policy=environment.policy,
                observation_id_factory=observation,
                provenance_id_factory=provenance,
                clock=clock,
                api_key=environment.secret_sentinel,
            ),
        ),
        "europe-pmc": (
            EUROPE_PMC_SCOPE,
            lambda environment, observation, provenance, clock: EuropePmcAdapter(
                http_client=environment.http_client,
                access_coordinator=environment.coordinator,
                access_scope=environment.scope,
                access_policy=environment.policy,
                observation_id_factory=observation,
                provenance_id_factory=provenance,
                clock=clock,
            ),
        ),
        "datacite": (
            DATACITE_SCOPE,
            lambda environment, observation, provenance, clock: DataCiteAdapter(
                http_client=environment.http_client,
                access_coordinator=environment.coordinator,
                access_scope=environment.scope,
                access_policy=environment.policy,
                observation_id_factory=observation,
                provenance_id_factory=provenance,
                clock=clock,
            ),
        ),
        "core": (
            CORE_SCOPE,
            lambda environment, observation, provenance, clock: CoreAdapter(
                http_client=environment.http_client,
                access_coordinator=environment.coordinator,
                access_scope=environment.scope,
                access_policy=environment.policy,
                observation_id_factory=observation,
                provenance_id_factory=provenance,
                clock=clock,
                api_key=environment.secret_sentinel,
            ),
        ),
        "opencitations": (
            OPENCITATIONS_SCOPE,
            lambda environment, observation, provenance, clock: OpenCitationsAdapter(
                http_client=environment.http_client,
                access_coordinator=environment.coordinator,
                access_scope=environment.scope,
                access_policy=environment.policy,
                observation_id_factory=observation,
                provenance_id_factory=provenance,
                clock=clock,
                token=environment.secret_sentinel,
            ),
        ),
    }


def _success_body(provider: str) -> bytes:
    values: dict[str, bytes] = {
        "crossref": json.dumps(
            {
                "status": "ok",
                "message-type": "work-list",
                "message": {"total-results": 1, "items": []},
            }
        ).encode(),
        "semantic-scholar": b'{"paperId":"024a2c"}',
        "arxiv": (
            b'<feed xmlns="http://www.w3.org/2005/Atom" '
            b'xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">'
            b"<opensearch:totalResults>1</opensearch:totalResults>"
            b"<opensearch:startIndex>0</opensearch:startIndex>"
            b"<opensearch:itemsPerPage>1</opensearch:itemsPerPage></feed>"
        ),
        "openalex": b'{"id":"https://openalex.org/W3035965352"}',
        "europe-pmc": b'{"hitCount":1,"resultList":{"result":[]}}',
        "datacite": b'{"data":{"type":"dois","id":"10.5281/zenodo.3727209"}}',
        "core": b'{"totalHits":1,"limit":1,"offset":0,"results":[]}',
        "opencitations": b'[{"id":"doi:10.1007/978-1-4020-9632-7"}]',
    }
    return values[provider]


class MetadataProbeTests(unittest.TestCase):
    def test_all_provider_probes_use_one_injected_network_seam_without_facts(self) -> None:
        for provider, (scope, builder) in _builders().items():
            with self.subTest(provider=provider):
                observation = _ForbiddenFactFactory("observation")
                provenance = _ForbiddenFactFactory("provenance")
                clock = _ForbiddenFactFactory("clock")
                with _environment(
                    provider,
                    scope,
                    builder,
                    observation_factory=cast(Callable[[], ObservationId], observation),
                    provenance_factory=cast(Callable[[], ProvenanceId], provenance),
                    clock_factory=cast(Callable[[], UtcTimestamp], clock),
                ) as environment:
                    adapter = cast(MetadataProbePort, environment.ports.lookup)
                    self.assertIs(adapter._http_client, environment.http_client)  # type: ignore[attr-defined]
                    self.assertIs(adapter._access_coordinator, environment.coordinator)  # type: ignore[attr-defined]
                    environment.queue_http_response(status=200, body=_success_body(provider))

                    evidence = adapter.probe_metadata()

                    self.assertEqual(evidence, MetadataProbeEvidence(provider_name=provider))
                    self.assertEqual(observation.calls, 0)
                    self.assertEqual(provenance.calls, 0)
                    self.assertEqual(clock.calls, 0)
                    self.assertEqual(environment.coordinator.scope_acquisitions, [scope])
                    self.assertEqual(len(environment.transport.calls), 1)
                    call = environment.transport.calls[0]
                    self.assertNotIn(environment.secret_sentinel, call.request.url)
                    self.assertNotIn(environment.secret_sentinel, repr(evidence))
                    self._assert_minimal_request(provider, call.request.url, call.wire_target)

    def test_malformed_oversize_and_status_failures_are_stable_and_redacted(self) -> None:
        provider = "semantic-scholar"
        scope, builder = _builders()[provider]
        observation = cast(Callable[[], ObservationId], _id_factory(1, ObservationId))
        provenance = cast(Callable[[], ProvenanceId], _id_factory(2, ProvenanceId))
        cases = (
            (401, b"", "metadata-probe-authentication", (True, False, None, None)),
            (403, b"", "metadata-probe-authentication", (True, False, None, None)),
            (429, b"", "metadata-probe-provider", (True, None, None, None)),
            (200, b"{", "metadata-probe-response", (True, True, True, False)),
            (200, b"{}", "metadata-probe-response", (True, True, True, False)),
        )
        for status, body, code, checks in cases:
            with self.subTest(status=status, code=code):
                with _environment(
                    provider,
                    scope,
                    builder,
                    observation_factory=observation,
                    provenance_factory=provenance,
                ) as environment:
                    environment.queue_http_response(status=status, body=body)
                    adapter = cast(MetadataProbePort, environment.ports.lookup)
                    with self.assertRaises(MetadataProbeFailure) as caught:
                        adapter.probe_metadata()
                    failure = caught.exception
                    self.assertEqual(failure.code, code)
                    self.assertEqual(
                        (
                            failure.network_reachable,
                            failure.authentication_accepted,
                            failure.api_product_usable,
                            failure.minimal_response_parseable,
                        ),
                        checks,
                    )
                    rendered = f"{failure!s} {failure!r}"
                    self.assertNotIn(environment.secret_sentinel, rendered)
                    self.assertNotIn("api.semanticscholar.org", rendered)
                    self.assertIsNone(failure.__cause__)
                    self.assertIsNone(failure.__context__)

        scope, builder = _builders()["europe-pmc"]
        with _environment(
            "europe-pmc",
            scope,
            builder,
            observation_factory=observation,
            provenance_factory=provenance,
        ) as environment:
            environment.queue_http_response(status=200, body=b" " * 1_048_577)
            adapter = cast(MetadataProbePort, environment.ports.lookup)
            with self.assertRaises(MetadataProbeFailure) as caught:
                adapter.probe_metadata()
            self.assertEqual(
                caught.exception.code,
                "metadata-probe-response-too-large",
            )
            self.assertEqual(
                (
                    caught.exception.network_reachable,
                    caught.exception.authentication_accepted,
                    caught.exception.api_product_usable,
                    caught.exception.minimal_response_parseable,
                ),
                (True, None, None, None),
            )
            self.assertIsNone(caught.exception.__cause__)
            self.assertIsNone(caught.exception.__context__)

        with _environment(
            "europe-pmc",
            scope,
            builder,
            observation_factory=observation,
            provenance_factory=provenance,
        ) as environment:
            environment.transport.actions.append(TimeoutError("private sentinel"))
            adapter = cast(MetadataProbePort, environment.ports.lookup)
            with self.assertRaises(MetadataProbeFailure) as caught:
                adapter.probe_metadata()
            self.assertEqual(caught.exception.code, "metadata-probe-network")
            self.assertEqual(
                (
                    caught.exception.network_reachable,
                    caught.exception.authentication_accepted,
                    caught.exception.api_product_usable,
                    caught.exception.minimal_response_parseable,
                ),
                (False, None, None, None),
            )
            self.assertNotIn("private sentinel", repr(caught.exception))
            self.assertIsNone(caught.exception.__cause__)
            self.assertIsNone(caught.exception.__context__)

    def test_adapter_rejects_a_coordinator_different_from_its_http_client(self) -> None:
        scope, builder = _builders()["crossref"]
        observation = cast(Callable[[], ObservationId], _id_factory(3, ObservationId))
        provenance = cast(Callable[[], ProvenanceId], _id_factory(4, ProvenanceId))

        def mismatched_builder(
            environment: ContractEnvironment,
            observation_factory: Callable[[], ObservationId],
            provenance_factory: Callable[[], ProvenanceId],
            clock_factory: Callable[[], UtcTimestamp],
        ) -> object:
            adapter = builder(
                environment,
                observation_factory,
                provenance_factory,
                clock_factory,
            )
            kwargs = {
                "http_client": environment.http_client,
                "access_coordinator": AccessCoordinator(),
                "access_scope": environment.scope,
                "access_policy": environment.policy,
                "observation_id_factory": observation_factory,
                "provenance_id_factory": provenance_factory,
                "clock": _clock,
                "mailto": "probe@example.invalid",
            }
            del adapter
            return CrossrefAdapter(**kwargs)

        with self.assertRaisesRegex(ValueError, "share the HttpClient AccessCoordinator"):
            _environment(
                "crossref",
                scope,
                mismatched_builder,
                observation_factory=observation,
                provenance_factory=provenance,
            )

    def _assert_minimal_request(self, provider: str, safe_url: str, wire_target: str) -> None:
        query = parse_qs(urlsplit(safe_url).query)
        if provider == "crossref":
            self.assertEqual(query["rows"], ["0"])
            self.assertEqual(query["query"], ["metadata"])
        elif provider == "semantic-scholar":
            self.assertEqual(query, {"fields": ["paperId"]})
            self.assertIn("/DOI:10.1038", wire_target)
        elif provider == "arxiv":
            self.assertEqual(query["id_list"], ["2106.14834"])
            self.assertEqual(query["max_results"], ["1"])
        elif provider == "openalex":
            self.assertEqual(query, {"select": ["id"]})
            self.assertIn("/W3035965352", wire_target)
        elif provider == "europe-pmc":
            self.assertEqual(query["pageSize"], ["1"])
            self.assertEqual(query["query"], ["PMCID:PMC7759461"])
        elif provider == "datacite":
            self.assertFalse(query)
            self.assertIn("10.5281%2Fzenodo.3727209", wire_target)
        elif provider == "core":
            self.assertEqual(query["limit"], ["1"])
            self.assertEqual(query["offset"], ["0"])
        elif provider == "opencitations":
            self.assertFalse(query)
            self.assertIn("doi:10.1007%2F978-1-4020-9632-7", wire_target)
            self.assertNotIn("/index/", wire_target)
        self.assertNotIn("api_key", query)


if __name__ == "__main__":
    unittest.main()
