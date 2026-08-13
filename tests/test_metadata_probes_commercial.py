from __future__ import annotations

import json
import unittest
from collections.abc import Callable
from typing import cast
from urllib.parse import parse_qs, urlsplit

from sciretriever.metadata.ports import ReferenceQueryPort
from sciretriever.metadata.probe import MetadataProbeEvidence, MetadataProbeFailure
from sciretriever.metadata.providers.elsevier import (
    ACCESS_SCOPE as ELSEVIER_SCOPE,
)
from sciretriever.metadata.providers.elsevier import (
    ElsevierScopusAdapter,
)
from sciretriever.metadata.providers.springer import (
    ACCESS_SCOPE as SPRINGER_SCOPE,
)
from sciretriever.metadata.providers.springer import (
    SpringerMetaV2Adapter,
)
from sciretriever.metadata.providers.web_of_science import (
    EXPANDED_ACCESS_SCOPE,
    STARTER_ACCESS_SCOPE,
    WebOfScienceExpandedAdapter,
    WebOfScienceStarterAdapter,
)
from sciretriever.model.primitives import ObservationId, ProvenanceId, UtcTimestamp
from tests.metadata_provider_contract import ContractEnvironment, ContractPorts
from tests.metadata_provider_contract import ProviderCapability as ContractCapability


class _ForbiddenFactory:
    def __init__(self, name: str) -> None:
        self.name = name
        self.calls = 0

    def __call__(self) -> object:
        self.calls += 1
        raise AssertionError(f"probe called forbidden {self.name} factory")


def _environment(
    kind: str,
    observation: _ForbiddenFactory,
    provenance: _ForbiddenFactory,
    clock: _ForbiddenFactory,
) -> ContractEnvironment:
    expected_scope = {
        "elsevier": ELSEVIER_SCOPE,
        "springer": SPRINGER_SCOPE,
        "starter": STARTER_ACCESS_SCOPE,
        "expanded": EXPANDED_ACCESS_SCOPE,
    }[kind]

    def direct_assemble(environment: ContractEnvironment) -> ContractPorts:
        observation_factory = cast(Callable[[], ObservationId], observation)
        provenance_factory = cast(Callable[[], ProvenanceId], provenance)
        clock_factory = cast(Callable[[], UtcTimestamp], clock)
        if kind == "elsevier":
            adapter = ElsevierScopusAdapter(
                http_client=environment.http_client,
                access_coordinator=environment.coordinator,
                access_scope=environment.scope,
                access_policy=environment.policy,
                observation_id_factory=observation_factory,
                provenance_id_factory=provenance_factory,
                clock=clock_factory,
                api_key=environment.secret_sentinel,
                institution_token=f"{environment.secret_sentinel}-institution",
            )
        elif kind == "springer":
            adapter = SpringerMetaV2Adapter(
                http_client=environment.http_client,
                access_coordinator=environment.coordinator,
                access_scope=environment.scope,
                access_policy=environment.policy,
                observation_id_factory=observation_factory,
                provenance_id_factory=provenance_factory,
                clock=clock_factory,
                api_key=environment.secret_sentinel,
            )
        elif kind == "starter":
            adapter = WebOfScienceStarterAdapter(
                http_client=environment.http_client,
                access_coordinator=environment.coordinator,
                access_scope=environment.scope,
                access_policy=environment.policy,
                observation_id_factory=observation_factory,
                provenance_id_factory=provenance_factory,
                clock=clock_factory,
                api_key=environment.secret_sentinel,
                database="WOS",
                edition="core",
            )
        else:
            adapter = WebOfScienceExpandedAdapter(
                http_client=environment.http_client,
                access_coordinator=environment.coordinator,
                access_scope=environment.scope,
                access_policy=environment.policy,
                observation_id_factory=observation_factory,
                provenance_id_factory=provenance_factory,
                clock=clock_factory,
                api_key=environment.secret_sentinel,
                database="WOS",
                edition="core",
            )
        return ContractPorts(
            topic_search=adapter,
            lookup=adapter,
            reference_query=(cast(ReferenceQueryPort, adapter) if kind == "expanded" else None),
        )

    capabilities: frozenset[ContractCapability] = (
        frozenset(("search", "lookup", "references"))
        if kind == "expanded"
        else frozenset(("search", "lookup"))
    )
    return ContractEnvironment(
        provider_name="web-of-science" if kind in {"starter", "expanded"} else kind,
        capabilities=capabilities,
        port_factory=direct_assemble,
        expected_scope=expected_scope,
    )


def _success_body(kind: str) -> bytes:
    values = {
        "elsevier": {
            "search-results": {
                "opensearch:totalResults": "0",
                "opensearch:startIndex": "0",
                "opensearch:itemsPerPage": "0",
                "cursor": {"@current": "*"},
                "entry": [],
            }
        },
        "springer": {
            "result": [{"total": "0", "start": "1", "pageLength": "1", "recordsDisplayed": "0"}],
            "records": [],
        },
        "starter": {"metadata": {"total": 0, "page": 1, "limit": 1}, "hits": []},
        "expanded": {
            "Data": {"Records": {"records": {"REC": []}}},
            "QueryResult": {"RecordsFound": 0},
        },
    }
    return json.dumps(values[kind]).encode()


class CommercialMetadataProbeTests(unittest.TestCase):
    def test_minimal_zero_result_probes_use_selected_product_and_no_fact_factories(self) -> None:
        for kind in ("starter", "expanded", "elsevier", "springer"):
            with self.subTest(kind=kind):
                observation = _ForbiddenFactory("observation")
                provenance = _ForbiddenFactory("provenance")
                clock = _ForbiddenFactory("clock")
                with _environment(kind, observation, provenance, clock) as environment:
                    adapter = environment.ports.topic_search
                    if adapter is None:
                        raise AssertionError("probe test requires an adapter")
                    environment.queue_http_response(status=200, body=_success_body(kind))

                    evidence = cast(object, adapter).probe_metadata()  # type: ignore[attr-defined]

                    expected_provider = (
                        "web-of-science" if kind in {"starter", "expanded"} else kind
                    )
                    self.assertEqual(
                        evidence,
                        MetadataProbeEvidence(provider_name=expected_provider),
                    )
                    self.assertEqual(
                        (observation.calls, provenance.calls, clock.calls),
                        (0, 0, 0),
                    )
                    self.assertEqual(len(environment.transport.calls), 1)
                    call = environment.transport.calls[0]
                    self.assertNotIn(environment.secret_sentinel, call.request.url)
                    self.assertNotIn(environment.secret_sentinel, repr(evidence))
                    self._assert_request(kind, call.request.url, call.wire_target)

    def test_commercial_status_failures_keep_later_checks_unknown(self) -> None:
        cases = (
            (401, "metadata-probe-authentication", (True, False, None, None)),
            (403, "metadata-probe-product", (True, True, False, None)),
            (429, "metadata-probe-provider", (True, None, None, None)),
        )
        for kind in ("starter", "expanded", "elsevier", "springer"):
            for status, code, checks in cases:
                with self.subTest(kind=kind, status=status):
                    with _environment(
                        kind,
                        _ForbiddenFactory("observation"),
                        _ForbiddenFactory("provenance"),
                        _ForbiddenFactory("clock"),
                    ) as environment:
                        adapter = environment.ports.topic_search
                        if adapter is None:
                            raise AssertionError("probe test requires an adapter")
                        environment.queue_http_response(status=status)
                        with self.assertRaises(MetadataProbeFailure) as caught:
                            cast(object, adapter).probe_metadata()  # type: ignore[attr-defined]
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
                        self.assertIsNone(failure.__cause__)
                        self.assertIsNone(failure.__context__)

    def _assert_request(self, kind: str, safe_url: str, wire_target: str) -> None:
        query = parse_qs(urlsplit(safe_url).query)
        self.assertNotIn("api_key", query)
        if kind == "starter":
            self.assertIn("wos-starter/v2/documents", safe_url)
            self.assertEqual(query["limit"], ["1"])
            self.assertEqual(query["page"], ["1"])
            self.assertEqual(query["db"], ["WOS"])
        elif kind == "expanded":
            self.assertIn("wos-api.clarivate.com/api/wos", safe_url)
            self.assertEqual(query["count"], ["1"])
            self.assertEqual(query["firstRecord"], ["1"])
            self.assertEqual(query["databaseId"], ["WOS"])
            self.assertEqual(query["optionView"], ["FR"])
        elif kind == "elsevier":
            self.assertIn("content/search/scopus", safe_url)
            self.assertEqual(query["count"], ["1"])
            self.assertEqual(query["cursor"], ["*"])
            self.assertEqual(query["view"], ["COMPLETE"])
        else:
            self.assertIn("meta/v2/json", safe_url)
            self.assertEqual(query["p"], ["1"])
            self.assertEqual(query["s"], ["1"])
            self.assertIn("api_key=", wire_target)


if __name__ == "__main__":
    unittest.main()
