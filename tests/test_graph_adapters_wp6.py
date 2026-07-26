import json
import sys
from pathlib import Path
from typing import Mapping, TypeAlias
from unittest import IsolatedAsyncioTestCase, TestCase


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.errors import ProviderErrorCategory
from sciretriever.integrations.graph import (
    CitationEdge,
    ExpansionDepth,
    GraphCursor,
    GraphDirection,
    GraphIdentifier,
    GraphIdentifierNamespace,
    GraphQuery,
    GraphRequest,
)
from sciretriever.integrations.graph_adapters import (
    OpenAlexGraphAdapter,
    SemanticScholarGraphAdapter,
    graph_capability_registry,
    query_graph_providers,
)
from sciretriever.integrations.openalex import OpenAlexClient
from sciretriever.integrations.semantic_scholar import SemanticScholarClient
from sciretriever.network import HttpResponse, QueryParams


DOI_A = GraphIdentifier(GraphIdentifierNamespace.DOI, "10.1000/a")
DOI_B = GraphIdentifier(GraphIdentifierNamespace.DOI, "10.1000/b")
OPENALEX_C = GraphIdentifier(GraphIdentifierNamespace.OPENALEX, "W3")
S2_C = GraphIdentifier(GraphIdentifierNamespace.S2, "paper-c")
SECRET = "TASK22-SENTINEL-SECRET"
JsonValue: TypeAlias = str | int | float | bool | None | list["JsonValue"] | dict[str, "JsonValue"]


class FakeTransport:
    def __init__(self, responses: tuple[HttpResponse | BaseException, ...]) -> None:
        self.responses = list(responses)
        self.calls: list[
            tuple[str, QueryParams | None, Mapping[str, str] | None, float | None]
        ] = []

    def get(self, url, *, params=None, headers=None, timeout=None):
        self.calls.append((url, params, headers, timeout))
        response = self.responses.pop(0)
        if isinstance(response, BaseException):
            raise response
        return response


def response(payload: JsonValue, status: int = 200) -> HttpResponse:
    return HttpResponse(status, (), json.dumps(payload).encode("ascii"), "https://provider.test/redacted")


def openalex_references(*values: str) -> JsonValue:
    references: list[JsonValue] = list(values)
    return {"referenced_works": references}


def query(direction: GraphDirection, *, calls: int = 2, size: int = 2) -> GraphQuery:
    return GraphQuery(DOI_A, direction, ExpansionDepth(1), calls, size)


class GraphAdapterRegistrationTests(TestCase):
    def test_graph_capabilities_register_separately_from_metadata_clients(self) -> None:
        openalex = OpenAlexClient(FakeTransport(()))
        semantic = SemanticScholarClient(FakeTransport(()), api_key=SECRET)

        registry = graph_capability_registry(openalex, semantic)

        self.assertEqual(tuple(registry), ("openalex", "semantic-scholar"))
        self.assertFalse(hasattr(registry["openalex"], "search"))
        self.assertEqual(
            registry["semantic-scholar"].graph_directions,
            frozenset({GraphDirection.REFERENCES, GraphDirection.CITED_BY}),
        )


class OpenAlexGraphAdapterTests(IsolatedAsyncioTestCase):
    async def test_references_and_cited_by_preserve_exact_seed_orientation(self) -> None:
        transport = FakeTransport((
            response({"referenced_works": ["https://openalex.org/W3", "https://openalex.org/W2"]}),
            response({"results": [
                {"id": "https://openalex.org/W3"},
                {"id": "https://openalex.org/W2", "doi": "https://doi.org/10.1000/B"},
            ], "meta": {"next_cursor": "next-cited"}}),
        ))
        adapter = OpenAlexGraphAdapter(OpenAlexClient(transport), timeout=1.25)

        references = await adapter.graph_page(GraphRequest(query(GraphDirection.REFERENCES), GraphDirection.REFERENCES, None, 1))
        cited_by = await adapter.graph_page(GraphRequest(query(GraphDirection.CITED_BY), GraphDirection.CITED_BY, None, 1))

        self.assertEqual(references.edges, (
            CitationEdge(DOI_A, GraphIdentifier(GraphIdentifierNamespace.OPENALEX, "W2")),
            CitationEdge(DOI_A, OPENALEX_C),
        ))
        self.assertEqual(cited_by.edges, (CitationEdge(DOI_B, DOI_A), CitationEdge(OPENALEX_C, DOI_A)))
        self.assertEqual([call[3] for call in transport.calls], [1.25, 1.25])

    async def test_reference_offset_cursor_is_bounded_and_cycle_safe(self) -> None:
        payload = openalex_references("W1", "W2", "W3")
        transport = FakeTransport((response(payload), response(payload)))
        adapter = OpenAlexGraphAdapter(OpenAlexClient(transport))
        graph_query = query(GraphDirection.REFERENCES, calls=2, size=2)

        first = await adapter.graph_page(GraphRequest(graph_query, GraphDirection.REFERENCES, None, 1))
        second = await adapter.graph_page(GraphRequest(graph_query, GraphDirection.REFERENCES, first.next_cursor, 2))

        self.assertEqual(first.next_cursor, GraphCursor("offset:2"))
        self.assertIsNone(second.next_cursor)
        self.assertEqual(len(transport.calls), 2)


class SemanticScholarGraphAdapterTests(IsolatedAsyncioTestCase):
    async def test_paginated_pages_map_external_ids_and_unknown_cited_by_ids(self) -> None:
        transport = FakeTransport((
            response({"data": [{"citedPaper": {"paperId": "paper-c", "externalIds": {}}}], "next": 1}),
            response({"data": [{"citingPaper": {"paperId": "paper-b", "externalIds": {"DOI": "10.1000/B"}}}], "next": None}),
        ))
        adapter = SemanticScholarGraphAdapter(SemanticScholarClient(transport, api_key=SECRET), timeout=0.75)

        references = await adapter.graph_page(GraphRequest(query(GraphDirection.REFERENCES), GraphDirection.REFERENCES, None, 1))
        cited_by = await adapter.graph_page(GraphRequest(query(GraphDirection.CITED_BY), GraphDirection.CITED_BY, None, 1))

        self.assertEqual(references.edges, (CitationEdge(DOI_A, S2_C),))
        self.assertEqual(cited_by.edges, (CitationEdge(DOI_B, DOI_A),))
        first_params = transport.calls[0][1]
        second_headers = transport.calls[1][2]
        self.assertIsInstance(first_params, dict)
        self.assertIsInstance(second_headers, dict)
        assert isinstance(first_params, dict)
        assert isinstance(second_headers, dict)
        self.assertEqual(first_params["offset"], 0)
        self.assertEqual(second_headers["x-api-key"], SECRET)
        self.assertEqual([call[3] for call in transport.calls], [0.75, 0.75])


class GraphSiblingIsolationTests(IsolatedAsyncioTestCase):
    async def test_varied_provider_order_yields_identical_results(self) -> None:
        openalex_payload = openalex_references("https://openalex.org/W2")
        semantic_payload = {"data": [{"citedPaper": {"paperId": "p", "externalIds": {"DOI": "10.1000/B"}}}], "next": None}
        first = (
            OpenAlexGraphAdapter(OpenAlexClient(FakeTransport((response(openalex_payload),)))),
            SemanticScholarGraphAdapter(SemanticScholarClient(FakeTransport((response(semantic_payload),)))),
        )
        second = tuple(reversed((
            OpenAlexGraphAdapter(OpenAlexClient(FakeTransport((response(openalex_payload),)))),
            SemanticScholarGraphAdapter(SemanticScholarClient(FakeTransport((response(semantic_payload),)))),
        )))

        left = await query_graph_providers(first, query(GraphDirection.REFERENCES, calls=1))
        right = await query_graph_providers(second, query(GraphDirection.REFERENCES, calls=1))

        self.assertEqual(left, right)
        self.assertEqual(tuple(result.provider for result in left.results), ("openalex", "semantic-scholar"))

    async def test_rate_limit_timeout_and_secret_failure_do_not_cancel_sibling(self) -> None:
        healthy = OpenAlexGraphAdapter(OpenAlexClient(FakeTransport((response({"referenced_works": ["W2"]}),))))
        failures = (
            SemanticScholarGraphAdapter(SemanticScholarClient(FakeTransport((response({"error": SECRET}, 429),)), api_key=SECRET)),
            SemanticScholarGraphAdapter(SemanticScholarClient(FakeTransport((TimeoutError(SECRET),)), api_key=SECRET), name="semantic-timeout"),
        )

        batch = await query_graph_providers((failures[1], healthy, failures[0]), query(GraphDirection.REFERENCES, calls=1))

        self.assertEqual(tuple(result.provider for result in batch.results), ("openalex",))
        self.assertEqual(
            tuple(failure.category for failure in batch.failures),
            (ProviderErrorCategory.RATE_LIMIT, ProviderErrorCategory.TRANSPORT),
        )
        self.assertTrue(all(failure.retryable for failure in batch.failures))
        self.assertNotIn(SECRET, repr(batch))

    async def test_malformed_edge_and_pagination_cycle_are_typed_failures(self) -> None:
        malformed = OpenAlexGraphAdapter(OpenAlexClient(FakeTransport((response({"referenced_works": ["not-an-id"]}),))))
        cycling = SemanticScholarGraphAdapter(SemanticScholarClient(FakeTransport((
            response({"data": [{"citedPaper": {"paperId": "p", "externalIds": {"DOI": "10.1000/B"}}}], "next": 0}),
            response({"data": [{"citedPaper": {"paperId": "p", "externalIds": {"DOI": "10.1000/B"}}}], "next": 0}),
        ))), name="semantic-cycle")

        batch = await query_graph_providers((cycling, malformed), query(GraphDirection.REFERENCES, calls=2, size=1))

        self.assertEqual(batch.results, ())
        self.assertEqual(
            tuple(failure.category for failure in batch.failures),
            (ProviderErrorCategory.INVALID_RESPONSE, ProviderErrorCategory.INVALID_RESPONSE),
        )

    async def test_partial_capability_is_explicit_and_sibling_continues(self) -> None:
        class ReferencesOnly:
            name = "references-only"
            graph_directions = frozenset({GraphDirection.REFERENCES})

            async def graph_page(self, request: GraphRequest):
                raise AssertionError("unsupported direction must not be requested")

        healthy = SemanticScholarGraphAdapter(SemanticScholarClient(FakeTransport((
            response({"data": [{"citingPaper": {"paperId": "paper-c", "externalIds": {}}}], "next": None}),
        ))))

        batch = await query_graph_providers((ReferencesOnly(), healthy), query(GraphDirection.CITED_BY, calls=1))

        self.assertEqual(tuple(result.provider for result in batch.results), ("semantic-scholar",))
        self.assertEqual(batch.failures[0].category, ProviderErrorCategory.CONFIGURATION)
        self.assertFalse(batch.failures[0].retryable)


if __name__ == "__main__":
    import unittest

    unittest.main()
