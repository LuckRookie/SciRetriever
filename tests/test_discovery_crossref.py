import json
import importlib
import sys
from pathlib import Path
from typing import Any
from unittest import TestCase
from unittest.mock import patch
from urllib.error import URLError


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
FIXTURES = Path(__file__).parent / "fixtures" / "discovery"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.core.contracts import SearchSpec
from sciretriever.discovery.providers import CrossrefProvider, build_crossref_provider
from sciretriever.discovery.providers.http import HttpResponse
from sciretriever.errors import ProviderErrorCategory, ProviderSearchError
from sciretriever.integrations import CrossrefClient


def fixture(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


class FakeTransport:
    def __init__(self, outcomes: list[HttpResponse | BaseException]) -> None:
        self.outcomes = outcomes
        self.calls: list[dict[str, Any]] = []

    def get(
        self,
        url: str,
        *,
        params: Any = None,
        headers: Any = None,
        timeout: float | None = None,
    ) -> HttpResponse:
        self.calls.append({"url": url, "params": params, "headers": headers, "timeout": timeout})
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome


def response(body: bytes, status: int = 200) -> HttpResponse:
    return HttpResponse(status, (), body, "https://api.crossref.org/works")


class CrossrefProviderTests(TestCase):
    def test_maps_fields_and_paginates_with_exact_parameters(self) -> None:
        transport = FakeTransport(
            [response(fixture("crossref_page_1.json")), response(fixture("crossref_page_2.json"))]
        )
        provider = build_crossref_provider(
            transport, mailto="owner@example.test", user_agent="SciRetriever-Test/1.0", timeout=4.0
        )
        self.assertIsInstance(provider._client, CrossrefClient)
        spec = SearchSpec(
            "quantum retrieval",
            ("crossref",),
            3,
            (("year_to", "2024"), ("year_from", "2020")),
        )

        with patch("sciretriever.discovery.providers.crossref.CROSSREF_MAX_ROWS", 2):
            records = provider.search(spec)

        self.assertIsInstance(records, tuple)
        self.assertEqual([record.rank for record in records], [1, 2, 3])
        self.assertEqual(records[0].raw_identifiers, (("doi", "10.1000/RAW-A"),))
        self.assertEqual(records[0].title, "Crossref first")
        self.assertEqual(records[0].abstract, "<jats:p>Raw <b>markup</b>.</jats:p>")
        self.assertEqual(records[0].authors, ("Ada Lovelace", "Research Group"))
        self.assertEqual(records[0].year, 2024)
        self.assertEqual(records[0].venue, "Journal A")
        self.assertEqual(records[0].publisher, "Known Press")
        self.assertEqual(records[0].publication_date, "2024-03-02")
        self.assertEqual(records[0].keywords, ("Retrieval", "Science"))
        self.assertIsNone(records[1].abstract)
        self.assertEqual(records[2].year, 2022)
        self.assertEqual(
            transport.calls[0]["params"],
            {
                "query": "quantum retrieval",
                "rows": 2,
                "cursor": "*",
                "filter": "from-pub-date:2020-01-01,until-pub-date:2024-12-31",
                "mailto": "owner@example.test",
            },
        )
        self.assertEqual(transport.calls[1]["params"]["cursor"], "cursor-2")
        self.assertEqual(transport.calls[1]["params"]["rows"], 1)
        self.assertEqual(transport.calls[0]["headers"]["User-Agent"], "SciRetriever-Test/1.0")
        self.assertEqual(transport.calls[0]["timeout"], 4.0)

    def test_stops_on_no_progress_cursor(self) -> None:
        payload = json.loads(fixture("crossref_page_2.json"))
        payload["message"]["next-cursor"] = "*"
        transport = FakeTransport([response(json.dumps(payload).encode())])
        with patch("sciretriever.discovery.providers.crossref.CROSSREF_MAX_ROWS", 1):
            records = CrossrefProvider(transport).search(SearchSpec("query", ("crossref",), 2))
        self.assertEqual(len(records), 1)
        self.assertEqual(len(transport.calls), 1)

    def test_unknown_issued_year_does_not_reject_crossref_page(self) -> None:
        payload = {
            "message": {
                "items": [
                    {
                        "DOI": "10.1021/example.s001",
                        "title": ["Supplement"],
                        "issued": {"date-parts": [[None]]},
                    }
                ]
            }
        }
        transport = FakeTransport([response(json.dumps(payload).encode())])

        records = CrossrefProvider(transport).search(
            SearchSpec("machine learning interatomic potentials", ("crossref",), 1)
        )

        self.assertEqual(len(records), 1)
        self.assertIsNone(records[0].year)

    def test_rejects_unknown_invalid_and_reversed_filters_before_transport(self) -> None:
        cases = (
            (("language", "en"),),
            (("year_from", "twenty"),),
            (("year_from", "2025"), ("year_to", "2024")),
        )
        for filters in cases:
            with self.subTest(filters=filters):
                transport = FakeTransport([])
                with self.assertRaises(ProviderSearchError) as raised:
                    CrossrefProvider(transport).search(SearchSpec("query", ("crossref",), 1, filters))
                self.assertIs(raised.exception.category, ProviderErrorCategory.CONFIGURATION)
                self.assertFalse(raised.exception.retryable)
                self.assertEqual(transport.calls, [])

    def test_malformed_payload_is_chained_invalid_response(self) -> None:
        transport = FakeTransport([response(fixture("malformed.json"))])
        with self.assertRaises(ProviderSearchError) as raised:
            CrossrefProvider(transport).search(SearchSpec("query", ("crossref",), 1))
        self.assertIs(raised.exception.category, ProviderErrorCategory.INVALID_RESPONSE)
        self.assertFalse(raised.exception.retryable)
        self.assertIsNotNone(raised.exception.__cause__)

    def test_returned_status_and_network_exception_are_classified(self) -> None:
        cases = (
            (response(b"{}", 503), ProviderErrorCategory.SERVER, True, 503),
            (URLError("offline"), ProviderErrorCategory.TRANSPORT, True, None),
        )
        for outcome, category, retryable, status in cases:
            with self.subTest(category=category):
                with self.assertRaises(ProviderSearchError) as raised:
                    CrossrefProvider(FakeTransport([outcome])).search(
                        SearchSpec("query", ("crossref",), 1)
                    )
                self.assertIs(raised.exception.category, category)
                self.assertIs(raised.exception.retryable, retryable)
                self.assertEqual(raised.exception.status, status)

    def test_builder_has_no_transport_side_effect(self) -> None:
        transport = FakeTransport([])
        provider = build_crossref_provider(transport)
        self.assertEqual(provider.name, "crossref")
        self.assertEqual(transport.calls, [])

    def test_provider_module_imports_have_no_network_side_effect(self) -> None:
        module_names = (
            "sciretriever.discovery.providers.crossref",
            "sciretriever.discovery.providers.europe_pmc",
            "sciretriever.discovery.providers.arxiv",
        )
        with patch("urllib.request.urlopen", side_effect=AssertionError("network access")) as opener:
            for module_name in module_names:
                importlib.reload(importlib.import_module(module_name))
        opener.assert_not_called()


if __name__ == "__main__":
    import unittest

    unittest.main()
