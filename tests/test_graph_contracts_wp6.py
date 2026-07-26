import sys
from dataclasses import FrozenInstanceError
from pathlib import Path
from unittest import IsolatedAsyncioTestCase, TestCase


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.integrations.graph import (
    CitationEdge,
    ExpansionDepth,
    GraphCapability,
    GraphCursor,
    GraphDirection,
    GraphIdentifier,
    GraphIdentifierNamespace,
    GraphPage,
    GraphQuery,
    GraphQueryUnsupported,
    GraphRequest,
    GraphResult,
    ProviderEdge,
    normalize_provider_page,
)


DOI_A = GraphIdentifier(GraphIdentifierNamespace.DOI, "10.1000/a")
DOI_B = GraphIdentifier(GraphIdentifierNamespace.DOI, "10.1000/b")
S2_C = GraphIdentifier(GraphIdentifierNamespace.S2, "paper-c")
S2_D = GraphIdentifier(GraphIdentifierNamespace.S2, "paper-d")
S2_E = GraphIdentifier(GraphIdentifierNamespace.S2, "paper-e")


class FakeGraphProvider:
    name = "fake-graph"
    graph_directions = frozenset(
        {GraphDirection.REFERENCES, GraphDirection.CITED_BY}
    )

    async def graph_page(self, request: GraphRequest) -> GraphPage:
        return GraphPage(request, (CitationEdge(DOI_A, DOI_B),), None, 1)


class GraphContractTests(TestCase):
    def test_direction_depth_and_stable_identifier_contracts(self) -> None:
        self.assertEqual(
            tuple(direction.value for direction in GraphDirection),
            ("references", "cited-by", "both"),
        )
        self.assertEqual(int(ExpansionDepth(0)), 0)
        self.assertEqual(int(ExpansionDepth(2)), 2)
        self.assertEqual(GraphIdentifier(GraphIdentifierNamespace.DOI, " DOI:10.1000/A "), DOI_A)
        with self.assertRaises(ValueError):
            ExpansionDepth(-1)
        with self.assertRaises(TypeError):
            ExpansionDepth(True)
        with self.assertRaises(ValueError):
            GraphIdentifier(GraphIdentifierNamespace.DOI, "https://example.test/private")

    def test_query_and_request_enforce_provider_bounds_and_cursor_safety(self) -> None:
        query = GraphQuery(DOI_A, GraphDirection.BOTH, ExpansionDepth(2), 3, 100)
        request = GraphRequest(query, GraphDirection.REFERENCES, None, 1)
        self.assertEqual((query.max_provider_calls, query.page_size), (3, 100))
        self.assertEqual(request.call_number, 1)
        with self.assertRaises(ValueError):
            GraphQuery(DOI_A, GraphDirection.BOTH, ExpansionDepth(1), 0, 100)
        with self.assertRaises(ValueError):
            GraphRequest(query, GraphDirection.REFERENCES, None, 4)
        with self.assertRaises(ValueError):
            GraphCursor("bad\ncursor")
        with self.assertRaises(ValueError):
            GraphCursor("x" * 513)

    def test_edge_page_and_result_are_frozen_and_deterministic(self) -> None:
        query = GraphQuery(DOI_A, GraphDirection.BOTH, ExpansionDepth(1), 2, 50)
        request = GraphRequest(query, GraphDirection.REFERENCES, None, 1)
        edges = (
            CitationEdge(DOI_A, S2_C),
            CitationEdge(DOI_A, DOI_B),
            CitationEdge(DOI_A, DOI_B),
        )
        page = GraphPage(request, edges, GraphCursor("next-1"), 3)
        result = GraphResult("openalex", query, (page,))
        self.assertEqual(page.edges, (CitationEdge(DOI_A, DOI_B), CitationEdge(DOI_A, S2_C)))
        self.assertEqual(result.edges, page.edges)
        self.assertEqual(result.provider_returned, 3)
        with self.assertRaises(FrozenInstanceError):
            setattr(page, "provider_returned", 4)

    def test_both_query_paginates_each_direction_independently(self) -> None:
        query = GraphQuery(DOI_A, GraphDirection.BOTH, ExpansionDepth(1), 2, 50)
        references_1 = GraphPage(
            GraphRequest(query, GraphDirection.REFERENCES, None, 1),
            (CitationEdge(DOI_A, DOI_B),), GraphCursor("references-2"), 1,
        )
        references_2 = GraphPage(
            GraphRequest(query, GraphDirection.REFERENCES, GraphCursor("references-2"), 2),
            (CitationEdge(DOI_A, S2_C),), None, 1,
        )
        cited_by_1 = GraphPage(
            GraphRequest(query, GraphDirection.CITED_BY, None, 1),
            (CitationEdge(S2_D, DOI_A),), GraphCursor("cited-by-2"), 1,
        )
        cited_by_2 = GraphPage(
            GraphRequest(query, GraphDirection.CITED_BY, GraphCursor("cited-by-2"), 2),
            (CitationEdge(S2_E, DOI_A),), None, 1,
        )
        expected_pages = (references_1, references_2, cited_by_1, cited_by_2)

        first = GraphResult(
            "openalex", query, (cited_by_2, references_1, cited_by_1, references_2)
        )
        second = GraphResult("openalex", query, tuple(reversed(expected_pages)))

        self.assertEqual(first, second)
        self.assertEqual(first.pages, expected_pages)
        self.assertEqual(first.provider_returned, 4)

    def test_both_query_accepts_call_one_for_each_direction(self) -> None:
        query = GraphQuery(DOI_A, GraphDirection.BOTH, ExpansionDepth(1), 1, 50)
        references = GraphPage(
            GraphRequest(query, GraphDirection.REFERENCES, None, 1),
            (CitationEdge(DOI_A, DOI_B),), None, 1,
        )
        cited_by = GraphPage(
            GraphRequest(query, GraphDirection.CITED_BY, None, 1),
            (CitationEdge(S2_C, DOI_A),), None, 1,
        )

        result = GraphResult("openalex", query, (cited_by, references))

        self.assertEqual(result.pages, (references, cited_by))
        self.assertEqual(
            result.edges,
            (CitationEdge(DOI_A, DOI_B), CitationEdge(S2_C, DOI_A)),
        )

    def test_direction_specific_pagination_rejects_malformed_chains(self) -> None:
        query = GraphQuery(DOI_A, GraphDirection.BOTH, ExpansionDepth(1), 3, 50)
        references_1 = GraphPage(
            GraphRequest(query, GraphDirection.REFERENCES, None, 1),
            (CitationEdge(DOI_A, DOI_B),), GraphCursor("references-2"), 1,
        )
        wrong_cursor = GraphPage(
            GraphRequest(query, GraphDirection.REFERENCES, GraphCursor("wrong"), 2),
            (CitationEdge(DOI_A, S2_C),), None, 1,
        )
        cited_by_2 = GraphPage(
            GraphRequest(query, GraphDirection.CITED_BY, GraphCursor("cited-by-2"), 2),
            (CitationEdge(S2_D, DOI_A),), None, 1,
        )
        terminal_1 = GraphPage(
            GraphRequest(query, GraphDirection.REFERENCES, None, 1),
            (CitationEdge(DOI_A, DOI_B),), None, 1,
        )
        restarted_2 = GraphPage(
            GraphRequest(query, GraphDirection.REFERENCES, None, 2),
            (CitationEdge(DOI_A, S2_C),), None, 1,
        )

        for pages in (
            (references_1, wrong_cursor),
            (cited_by_2,),
            (terminal_1, restarted_2),
        ):
            with self.subTest(pages=pages), self.assertRaises(ValueError):
                GraphResult("openalex", query, pages)
        with self.assertRaises(ValueError):
            GraphRequest(query, GraphDirection.BOTH, None, 1)

    def test_provider_shaped_pages_normalize_to_identical_neutral_edges(self) -> None:
        query = GraphQuery(DOI_A, GraphDirection.REFERENCES, ExpansionDepth(1), 2, 50)
        request = GraphRequest(query, GraphDirection.REFERENCES, None, 1)
        openalex = (
            ProviderEdge(("doi", "10.1000/A"), ("s2", "paper-c")),
            ProviderEdge(("doi", "10.1000/A"), ("doi", "10.1000/B")),
        )
        semantic_scholar = tuple(reversed(openalex))
        expected = (CitationEdge(DOI_A, DOI_B), CitationEdge(DOI_A, S2_C))
        self.assertEqual(normalize_provider_page(request, openalex, None).edges, expected)
        self.assertEqual(
            normalize_provider_page(request, semantic_scholar, None).edges,
            expected,
        )

    def test_invalid_provider_fields_and_identifier_conflicts_reject(self) -> None:
        query = GraphQuery(DOI_A, GraphDirection.REFERENCES, ExpansionDepth(1), 1, 10)
        request = GraphRequest(query, GraphDirection.REFERENCES, None, 1)
        with self.assertRaises(ValueError):
            ProviderEdge(("url", "https://vendor.test/work"), ("doi", "10.1000/b"))
        with self.assertRaises(ValueError):
            normalize_provider_page(
                request,
                (ProviderEdge(("doi", "10.1000/other"), ("doi", "10.1000/b")),),
                None,
            )
        with self.assertRaises(ValueError):
            normalize_provider_page(
                request,
                tuple(
                    ProviderEdge(("doi", "10.1000/a"), ("s2", f"paper-{index}"))
                    for index in range(11)
                ),
                GraphCursor("next"),
            )
        with self.assertRaises(ValueError):
            GraphQueryUnsupported("hostile\nprovider", GraphDirection.REFERENCES)

    def test_unsupported_capability_is_explicit(self) -> None:
        query = GraphQuery(DOI_A, GraphDirection.CITED_BY, ExpansionDepth(1), 1, 10)
        unsupported = GraphQueryUnsupported("crossref", GraphDirection.CITED_BY)
        self.assertEqual(unsupported.provider, "crossref")
        self.assertEqual(unsupported.direction, GraphDirection.CITED_BY)
        self.assertNotIsInstance(unsupported, GraphResult)
        self.assertEqual(query.direction, GraphDirection.CITED_BY)


class GraphCapabilityProtocolTests(IsolatedAsyncioTestCase):
    async def test_graph_capability_is_separate_from_metadata_search(self) -> None:
        provider: GraphCapability = FakeGraphProvider()
        query = GraphQuery(DOI_A, GraphDirection.REFERENCES, ExpansionDepth(1), 1, 10)
        page = await provider.graph_page(
            GraphRequest(query, GraphDirection.REFERENCES, None, 1)
        )
        self.assertEqual(page.edges, (CitationEdge(DOI_A, DOI_B),))
        self.assertFalse(hasattr(provider, "search"))


if __name__ == "__main__":
    import unittest

    unittest.main()
