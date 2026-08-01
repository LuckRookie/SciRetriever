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
from sciretriever.discovery.providers import ArxivProvider, build_arxiv_provider
from sciretriever.discovery.providers.http import HttpResponse
from sciretriever.errors import ProviderErrorCategory, ProviderSearchError
from sciretriever.integrations import ArxivClient


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
    return HttpResponse(status, (), body, "https://export.arxiv.org/api/query")


class ArxivProviderTests(TestCase):
    def test_maps_fields_paginates_and_paces_between_pages(self) -> None:
        transport = FakeTransport(
            [response(fixture("arxiv_page_1.xml")), response(fixture("arxiv_page_2.xml"))]
        )
        sleeps: list[float] = []
        provider = build_arxiv_provider(
            transport,
            sleeper=sleeps.append,
            user_agent="SciRetriever-arXiv-Test/1.0",
            timeout=6.0,
        )
        self.assertIsInstance(provider._client, ArxivClient)
        spec = SearchSpec(
            "all:retrieval",
            ("arxiv",),
            3,
            (("year_from", "2020"), ("year_to", "2024")),
        )

        with patch("sciretriever.discovery.providers.arxiv.ARXIV_MAX_PAGE_SIZE", 2):
            records = provider.search(spec)

        self.assertEqual([record.rank for record in records], [1, 2, 3])
        self.assertEqual(
            records[0].raw_identifiers,
            (("arxiv", "2401.00001v2"), ("doi", "10.3000/RAW-A")),
        )
        self.assertEqual(records[0].title, "arXiv first")
        self.assertEqual(records[0].abstract, "<p>Raw <b>markup</b>.</p>")
        self.assertEqual(records[0].authors, ("Ada Lovelace", "Grace Hopper"))
        self.assertEqual(records[0].year, 2024)
        self.assertEqual(records[0].venue, "Journal X 12 (2024)")
        self.assertEqual(records[0].keywords, ("cs.IR", "cs.DL"))
        self.assertEqual(records[0].open_access_status, "open")
        self.assertIsNone(records[1].abstract)
        self.assertEqual(sleeps, [3.0])
        self.assertEqual(
            transport.calls[0]["params"],
            {
                "search_query": "(all:retrieval) AND submittedDate:[202001010000 TO 202412312359]",
                "start": 0,
                "max_results": 2,
            },
        )
        self.assertEqual(transport.calls[1]["params"]["start"], 2)
        self.assertEqual(transport.calls[1]["params"]["max_results"], 1)
        self.assertEqual(
            transport.calls[0]["headers"],
            {
                "Accept": "application/atom+xml",
                "User-Agent": "SciRetriever-arXiv-Test/1.0",
            },
        )
        self.assertEqual(transport.calls[0]["timeout"], 6.0)

    def test_short_page_does_not_sleep_or_request_again(self) -> None:
        transport = FakeTransport([response(fixture("arxiv_page_2.xml"))])
        sleeps: list[float] = []
        records = ArxivProvider(transport, sleeper=sleeps.append).search(
            SearchSpec("query", ("arxiv",), 2)
        )
        self.assertEqual(len(records), 1)
        self.assertEqual(sleeps, [])
        self.assertEqual(len(transport.calls), 1)

    def test_filters_and_total_limit_are_rejected_before_transport(self) -> None:
        specs = (
            SearchSpec("query", ("arxiv",), 1, (("language", "en"),)),
            SearchSpec("query", ("arxiv",), 1, (("year_from", "-1"),)),
            SearchSpec("query", ("arxiv",), 30001),
        )
        for spec in specs:
            with self.subTest(spec=spec):
                transport = FakeTransport([])
                with self.assertRaises(ProviderSearchError) as raised:
                    ArxivProvider(transport, sleeper=lambda _: None).search(spec)
                self.assertIs(raised.exception.category, ProviderErrorCategory.CONFIGURATION)
                self.assertFalse(raised.exception.retryable)
                self.assertEqual(transport.calls, [])

    def test_malformed_payload_is_chained_invalid_response(self) -> None:
        with self.assertRaises(ProviderSearchError) as raised:
            ArxivProvider(FakeTransport([response(fixture("malformed.xml"))])).search(
                SearchSpec("query", ("arxiv",), 1)
            )
        self.assertIs(raised.exception.category, ProviderErrorCategory.INVALID_RESPONSE)
        self.assertFalse(raised.exception.retryable)
        self.assertIsNotNone(raised.exception.__cause__)

    def test_returned_status_and_network_exception_are_classified(self) -> None:
        cases = (
            (response(b"", 400), ProviderErrorCategory.CLIENT, False, 400),
            (URLError("offline"), ProviderErrorCategory.TRANSPORT, True, None),
        )
        for outcome, category, retryable, status in cases:
            with self.subTest(category=category):
                with self.assertRaises(ProviderSearchError) as raised:
                    ArxivProvider(FakeTransport([outcome]), sleeper=lambda _: None).search(
                        SearchSpec("query", ("arxiv",), 1)
                    )
                self.assertIs(raised.exception.category, category)
                self.assertIs(raised.exception.retryable, retryable)
                self.assertEqual(raised.exception.status, status)

    def test_builder_has_no_transport_or_sleep_side_effect(self) -> None:
        transport = FakeTransport([])
        sleeps: list[float] = []
        provider = build_arxiv_provider(transport, sleeper=sleeps.append)
        self.assertEqual(provider.name, "arxiv")
        self.assertEqual(transport.calls, [])
        self.assertEqual(sleeps, [])

    def test_blank_user_agent_is_rejected(self) -> None:
        transport = FakeTransport([])
        with self.assertRaisesRegex(ValueError, "user_agent must be a non-blank string"):
            ArxivProvider(transport, user_agent=" ")
        with self.assertRaisesRegex(ValueError, "user_agent must be a non-blank string"):
            build_arxiv_provider(transport, user_agent="")
        self.assertEqual(transport.calls, [])


if __name__ == "__main__":
    import unittest

    unittest.main()
