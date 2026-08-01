import json
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
from sciretriever.discovery.providers import EuropePMCProvider, build_europe_pmc_provider
from sciretriever.discovery.providers.http import HttpResponse
from sciretriever.errors import ProviderErrorCategory, ProviderSearchError
from sciretriever.integrations import EuropePmcClient


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
    return HttpResponse(status, (), body, "https://www.ebi.ac.uk/europepmc/webservices/rest/search")


class EuropePMCProviderTests(TestCase):
    def test_maps_fields_and_paginates_with_exact_parameters(self) -> None:
        transport = FakeTransport(
            [
                response(fixture("europe_pmc_page_1.json")),
                response(fixture("europe_pmc_page_2.json")),
            ]
        )
        provider = build_europe_pmc_provider(
            transport, user_agent="SciRetriever-EuropePMC-Test/1.0", timeout=5.0
        )
        self.assertIsInstance(provider._client, EuropePmcClient)
        spec = SearchSpec(
            "open access",
            ("europe-pmc",),
            3,
            (("year_from", "2020"), ("year_to", "2024")),
        )

        with patch("sciretriever.discovery.providers.europe_pmc.EUROPE_PMC_MAX_PAGE_SIZE", 2):
            records = provider.search(spec)

        self.assertEqual([record.rank for record in records], [1, 2, 3])
        self.assertEqual(
            records[0].raw_identifiers,
            (("doi", "10.2000/RAW-A"), ("pmid", "123"), ("pmcid", "PMC123")),
        )
        self.assertEqual(records[0].abstract, "<p>Raw <i>markup</i>.</p>")
        self.assertEqual(records[0].authors, ("Ada Lovelace", "Grace Hopper"))
        self.assertEqual(records[0].year, 2024)
        self.assertEqual(records[0].venue, "Journal E")
        self.assertEqual(records[0].keywords, ("Open access", "Indexing"))
        self.assertIsNone(records[1].abstract)
        self.assertEqual(
            transport.calls[0]["params"],
            {
                "query": "(open access) AND FIRST_PDATE:[2020-01-01 TO 2024-12-31]",
                "format": "json",
                "resultType": "core",
                "pageSize": 2,
                "cursorMark": "*",
            },
        )
        self.assertEqual(transport.calls[1]["params"]["cursorMark"], "cursor-2")
        self.assertEqual(transport.calls[1]["params"]["pageSize"], 1)
        self.assertEqual(
            transport.calls[0]["headers"],
            {
                "Accept": "application/json",
                "User-Agent": "SciRetriever-EuropePMC-Test/1.0",
            },
        )
        self.assertEqual(transport.calls[0]["timeout"], 5.0)

    def test_stops_on_no_progress_cursor(self) -> None:
        payload = json.loads(fixture("europe_pmc_page_2.json"))
        payload["nextCursorMark"] = "*"
        transport = FakeTransport([response(json.dumps(payload).encode())])
        with patch("sciretriever.discovery.providers.europe_pmc.EUROPE_PMC_MAX_PAGE_SIZE", 1):
            records = EuropePMCProvider(transport).search(
                SearchSpec("query", ("europe-pmc",), 2)
            )
        self.assertEqual(len(records), 1)
        self.assertEqual(len(transport.calls), 1)

    def test_filters_are_validated_before_transport(self) -> None:
        for filters in ((("unknown", "x"),), (("year_to", "0"),)):
            with self.subTest(filters=filters):
                transport = FakeTransport([])
                with self.assertRaises(ProviderSearchError) as raised:
                    EuropePMCProvider(transport).search(
                        SearchSpec("query", ("europe-pmc",), 1, filters)
                    )
                self.assertIs(raised.exception.category, ProviderErrorCategory.CONFIGURATION)
                self.assertEqual(transport.calls, [])

    def test_malformed_payload_is_chained_invalid_response(self) -> None:
        with self.assertRaises(ProviderSearchError) as raised:
            EuropePMCProvider(FakeTransport([response(fixture("malformed.json"))])).search(
                SearchSpec("query", ("europe-pmc",), 1)
            )
        self.assertIs(raised.exception.category, ProviderErrorCategory.INVALID_RESPONSE)
        self.assertFalse(raised.exception.retryable)
        self.assertIsNotNone(raised.exception.__cause__)

    def test_returned_status_and_network_exception_are_classified(self) -> None:
        cases = (
            (response(b"{}", 429), ProviderErrorCategory.RATE_LIMIT, 429),
            (URLError("offline"), ProviderErrorCategory.TRANSPORT, None),
        )
        for outcome, category, status in cases:
            with self.subTest(category=category):
                with self.assertRaises(ProviderSearchError) as raised:
                    EuropePMCProvider(FakeTransport([outcome])).search(
                        SearchSpec("query", ("europe-pmc",), 1)
                    )
                self.assertIs(raised.exception.category, category)
                self.assertTrue(raised.exception.retryable)
                self.assertEqual(raised.exception.status, status)

    def test_builder_has_no_transport_side_effect(self) -> None:
        transport = FakeTransport([])
        provider = build_europe_pmc_provider(transport)
        self.assertEqual(provider.name, "europe-pmc")
        self.assertEqual(transport.calls, [])

    def test_blank_user_agent_is_rejected(self) -> None:
        transport = FakeTransport([])
        with self.assertRaisesRegex(ValueError, "user_agent must be a non-blank string"):
            EuropePMCProvider(transport, user_agent=" ")
        with self.assertRaisesRegex(ValueError, "user_agent must be a non-blank string"):
            build_europe_pmc_provider(transport, user_agent="")
        self.assertEqual(transport.calls, [])


if __name__ == "__main__":
    import unittest

    unittest.main()
