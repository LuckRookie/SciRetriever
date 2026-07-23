import argparse
import sys
from tempfile import TemporaryDirectory
from pathlib import Path
from unittest import TestCase, mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from sciretriever.cli.discover import ALL_SOURCES, DEFAULT_SOURCES, _providers
from sciretriever.config import CredentialsConfig, load_config
from sciretriever.core.contracts import SearchSpec
from sciretriever.discovery.providers import (
    HttpResponse, build_elsevier_provider, build_openalex_provider,
    build_semantic_scholar_provider, build_springer_provider,
)
from sciretriever.errors import ProviderErrorCategory, ProviderSearchError
from sciretriever.network import HttpResponse as SharedHttpResponse

FIXTURES = Path(__file__).parent / "fixtures" / "discovery"


class FakeTransport:
    def __init__(self, body: bytes | list[bytes], status: int = 200) -> None:
        self.bodies = [body] if isinstance(body, bytes) else list(body)
        self.status = status
        self.calls = []

    def get(self, url, *, params=None, headers=None, timeout=None):
        self.calls.append((url, params, dict(headers or {}), timeout))
        return HttpResponse(self.status, (), self.bodies.pop(0), url)


def fixture(name: str) -> bytes:
    return (FIXTURES / f"{name}.json").read_bytes()


class VendorDiscoveryTests(TestCase):
    def test_shared_response_is_the_compatibility_response(self):
        self.assertIs(HttpResponse, SharedHttpResponse)
        acquisition_form = SharedHttpResponse(200, "https://example.org", {"Content-Type": "x"}, b"ok")
        self.assertEqual(acquisition_form.header("content-type"), "x")

    def test_all_vendor_success_fixtures_and_request_contracts(self):
        transports = {name: FakeTransport(fixture(name)) for name in ("openalex", "semantic-scholar", "elsevier", "springer")}
        cases = (
            ("openalex", build_openalex_provider(transports["openalex"]), "10.1/open", "search"),
            ("semantic-scholar", build_semantic_scholar_provider(transports["semantic-scholar"], api_key="s2-key"), "10.1/s2", "query"),
            ("elsevier", build_elsevier_provider(transports["elsevier"], api_key="els-key"), "10.1/scopus", "query"),
            ("springer", build_springer_provider(transports["springer"], api_key="spring-key"), "10.1/springer", "q"),
        )
        for name, provider, doi, query_name in cases:
            with self.subTest(name=name):
                transport = transports[name]
                records = provider.search(
                    SearchSpec("battery", (name,), 1, (("year_from", "2020"), ("year_to", "2025")))
                )
                self.assertEqual(records[0].provider, name)
                self.assertIn(("doi", doi), records[0].raw_identifiers)
                self.assertIn(query_name, transport.calls[0][1])
                if name in {"openalex", "semantic-scholar"}:
                    self.assertEqual(records[0].open_access_status, "open")
                if name == "semantic-scholar":
                    self.assertEqual(transport.calls[0][2]["x-api-key"], "s2-key")
                if name == "elsevier":
                    self.assertEqual(transport.calls[0][2]["X-ELS-APIKey"], "els-key")
                if name == "springer":
                    self.assertEqual(transport.calls[0][1]["api_key"], "spring-key")
                    self.assertNotIn("spring-key", records[0].raw_identifiers)

    def test_malformed_and_auth_failures_map_consistently(self):
        for provider in (
            build_openalex_provider(FakeTransport(b"{}")),
            build_semantic_scholar_provider(FakeTransport(b"{}")),
            build_elsevier_provider(FakeTransport(b"{}"), api_key="key"),
            build_springer_provider(FakeTransport(b"{}"), api_key="key"),
        ):
            with self.subTest(provider=provider.name), self.assertRaises(ProviderSearchError) as raised:
                provider.search(SearchSpec("q", (provider.name,), 1))
            self.assertIs(raised.exception.category, ProviderErrorCategory.INVALID_RESPONSE)
        transport = FakeTransport(b"{}", 401)
        with self.assertRaises(ProviderSearchError) as raised:
            build_openalex_provider(transport).search(SearchSpec("q", ("openalex",), 1))
        self.assertIs(raised.exception.category, ProviderErrorCategory.AUTHENTICATION)

    def test_required_credentials_fail_before_network(self):
        transport = FakeTransport(b"{}")
        for builder in (build_elsevier_provider, build_springer_provider):
            with self.assertRaises(ProviderSearchError):
                builder(transport, api_key=None)
        self.assertEqual(transport.calls, [])

    def test_cli_choices_defaults_and_environment_precedence(self):
        self.assertEqual(DEFAULT_SOURCES, ("crossref", "europe-pmc", "arxiv"))
        self.assertEqual(set(ALL_SOURCES), {"crossref", "europe-pmc", "arxiv", "openalex", "semantic-scholar", "elsevier", "springer"})
        args = argparse.Namespace(source=["semantic-scholar"], timeout=3.0,
                                  crossref_mailto=None,
                                  _config_credentials=CredentialsConfig(semantic_scholar_api_key="toml"))
        with mock.patch.dict("os.environ", {"SCIRETRIEVER_SEMANTIC_SCHOLAR_API_KEY": "env"}, clear=True), \
             mock.patch("sciretriever.cli.discover.build_semantic_scholar_provider", return_value=mock.sentinel.provider) as build:
            result = _providers(args, mock.sentinel.transport)
        self.assertIs(result["semantic-scholar"], mock.sentinel.provider)
        self.assertEqual(build.call_args.kwargs["api_key"], "env")

    def test_config_accepts_all_sources(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "config.toml"
            path.write_text('schema_version=1\n[discovery]\nsources=["openalex","semantic-scholar","elsevier","springer"]\n', encoding="ascii")
            self.assertEqual(load_config(path).discovery.sources,
                             ("openalex", "semantic-scholar", "elsevier", "springer"))

    def test_vendor_searches_paginate_deterministically(self):
        cases = (
            (
                "openalex",
                "sciretriever.integrations.openalex.OPENALEX_MAX_PAGE_SIZE",
                "cursor",
                "cursor-2",
            ),
            (
                "semantic_scholar",
                "sciretriever.integrations.semantic_scholar.SEMANTIC_SCHOLAR_MAX_PAGE_SIZE",
                "offset",
                2,
            ),
            (
                "elsevier",
                "sciretriever.integrations.elsevier.ELSEVIER_SCOPUS_MAX_PAGE_SIZE",
                "start",
                2,
            ),
            (
                "springer",
                "sciretriever.integrations.springer.SPRINGER_MAX_PAGE_SIZE",
                "s",
                3,
            ),
        )
        for fixture_name, page_bound, parameter, expected in cases:
            with self.subTest(provider=fixture_name):
                transport = FakeTransport(
                    [
                        fixture(f"{fixture_name}_page_1"),
                        fixture(f"{fixture_name}_page_2"),
                    ]
                )
                with mock.patch(page_bound, 2):
                    if fixture_name == "openalex":
                        provider = build_openalex_provider(transport)
                    elif fixture_name == "semantic_scholar":
                        provider = build_semantic_scholar_provider(
                            transport, api_key="key"
                        )
                    elif fixture_name == "elsevier":
                        provider = build_elsevier_provider(transport, api_key="key")
                    else:
                        provider = build_springer_provider(transport, api_key="key")
                    records = provider.search(
                        SearchSpec("query", (provider.name,), 3)
                    )
                self.assertEqual(len(records), 3)
                self.assertEqual([record.rank for record in records], [1, 2, 3])
                expected_ids = {
                    "openalex": (
                        "https://openalex.org/W1",
                        "https://openalex.org/W2",
                        "https://openalex.org/W3",
                    ),
                    "semantic_scholar": ("S1", "S2", "S3"),
                    "elsevier": (
                        "SCOPUS_ID:1",
                        "SCOPUS_ID:2",
                        "SCOPUS_ID:3",
                    ),
                    "springer": (
                        "10.1/springer-1",
                        "10.1/springer-2",
                        "10.1/springer-3",
                    ),
                }
                self.assertEqual(
                    tuple(record.provider_record_id for record in records),
                    expected_ids[fixture_name],
                )
                self.assertEqual(len(transport.calls), 2)
                self.assertEqual(transport.calls[1][1][parameter], expected)


if __name__ == "__main__":
    import unittest
    unittest.main()
