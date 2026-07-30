import importlib
import socket
import sys
from dataclasses import FrozenInstanceError, fields
from email.message import Message
from io import BytesIO
from pathlib import Path
from typing import Any, Mapping
from unittest import TestCase
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

discovery = importlib.import_module("sciretriever.discovery")
http_module = importlib.import_module("sciretriever.discovery.providers.http")
errors = importlib.import_module("sciretriever.errors")
contracts = importlib.import_module("sciretriever.core.contracts")

DiscoveryProvider = discovery.DiscoveryProvider
HttpResponse = discovery.HttpResponse
ProviderErrorCategory = discovery.ProviderErrorCategory
ProviderRecord = discovery.ProviderRecord
ProviderSearchError = discovery.ProviderSearchError
CrossrefProvider = discovery.CrossrefProvider
Transport = discovery.Transport
UrllibTransport = discovery.UrllibTransport
ResponseTooLargeError = http_module.ResponseTooLargeError
SearchSpec = contracts.SearchSpec

from sciretriever.cli.discover import _production_transport
from sciretriever.network import NetworkPolicyError, SecureHttpsTransport


class FakeResponse:
    def __init__(
        self,
        body: bytes,
        *,
        status: int = 200,
        url: str = "https://api.example.test/final",
        headers: Message | None = None,
    ) -> None:
        self._body = body
        self.status = status
        self._url = url
        self.headers = headers or Message()
        self.read_amounts: list[int] = []

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *args: object) -> None:
        return None

    def read(self, amount: int = -1) -> bytes:
        self.read_amounts.append(amount)
        return self._body[:amount] if amount >= 0 else self._body

    def geturl(self) -> str:
        return self._url


class FakeOpener:
    def __init__(self, response: FakeResponse | None = None, error: BaseException | None = None):
        self.response = response
        self.error = error
        self.requests: list[Any] = []
        self.timeouts: list[float | None] = []

    def __call__(self, request: Any, *, timeout: float | None = None) -> FakeResponse:
        self.requests.append(request)
        self.timeouts.append(timeout)
        if self.error is not None:
            raise self.error
        if self.response is None:
            raise AssertionError("fake opener requires a response")
        return self.response


class FakeDialResponse:
    status: int

    def __init__(self, status: int, headers: dict[str, str] | list[tuple[str, str]], body: bytes = b"", *, fail_on_read: bool = False, read_error: BaseException | None = None, headers_error: BaseException | None = None) -> None:
        self.status = status
        self._headers = list(headers.items()) if isinstance(headers, dict) else list(headers)
        self._body = BytesIO(body)
        self.closed = False
        self.close_count = 0
        self.read_called = False
        self.fail_on_read = fail_on_read
        self.read_error = read_error
        self.headers_error = headers_error

    def getheaders(self) -> list[tuple[str, str]]:
        if self.headers_error is not None:
            raise self.headers_error
        return list(self._headers)

    def read(self, n: int = -1) -> bytes:
        self.read_called = True
        if self.read_error is not None:
            raise self.read_error
        if self.fail_on_read:
            raise AssertionError("headers-only transport read a response body")
        return self._body.read(n)

    def close(self) -> None:
        self.closed = True
        self.close_count += 1
        self._body.close()


class FakeDialer:
    def __init__(self, responses: list[FakeDialResponse]) -> None:
        self.responses = responses
        self.calls: list[tuple[str, str, str]] = []
        self.headers: list[dict[str, str]] = []

    def get(
        self,
        hostname: str,
        address: str,
        port: int,
        target: str,
        *,
        timeout: float,
        headers: Mapping[str, str],
    ) -> FakeDialResponse:
        self.calls.append((hostname, address, target))
        self.headers.append(dict(headers))
        return self.responses.pop(0)

    def head(
        self,
        hostname: str,
        address: str,
        port: int,
        target: str,
        *,
        timeout: float,
        headers: Mapping[str, str],
    ) -> FakeDialResponse:
        return self.get(hostname, address, port, target, timeout=timeout, headers=headers)


class FakeProvider:
    name = "fake"

    def search(self, spec: SearchSpec) -> tuple[ProviderRecord, ...]:
        return (
            ProviderRecord(
                provider=self.name,
                rank=1,
                raw_identifiers=(("source-id", spec.query),),
                title="Result",
            ),
        )[: spec.limit]


class DiscoveryModelTests(TestCase):
    def test_provider_record_is_frozen_slotted_hashable_and_neutral(self) -> None:
        record = ProviderRecord(
            provider="crossref",
            rank=1,
            raw_identifiers=(("doi", "10.1000/RAW"), ("crossref", "item-1")),
            title="A title",
            abstract="An abstract",
            authors=("Ada Lovelace",),
            year=2026,
            venue="Journal",
            keywords=("retrieval",),
        )

        self.assertEqual(hash(record), hash(record))
        self.assertFalse(hasattr(record, "__dict__"))
        with self.assertRaises(FrozenInstanceError):
            record.rank = 2
        self.assertEqual(
            tuple(field.name for field in fields(record)),
            (
                "provider",
                "rank",
                "raw_identifiers",
                "title",
                "abstract",
                "authors",
                "year",
                "venue",
                "keywords",
                "publisher",
                "publication_date",
                "open_access_status",
                "provider_record_id",
            ),
        )
        self.assertEqual(record.raw_identifiers[0][1], "10.1000/RAW")

    def test_provider_record_requires_immutable_collections_and_valid_rank(self) -> None:
        with self.assertRaises(TypeError):
            ProviderRecord("provider", 1, [], authors=())
        with self.assertRaises(TypeError):
            ProviderRecord("provider", 1, (), authors=["Author"])
        with self.assertRaises(ValueError):
            ProviderRecord("provider", 0, ())

    def test_provider_protocol_returns_an_immutable_tuple(self) -> None:
        provider: DiscoveryProvider = FakeProvider()
        results = provider.search(SearchSpec("raw-id", ("fake",), 1))
        self.assertIsInstance(results, tuple)
        self.assertEqual(results[0].provider, provider.name)


class TransportTests(TestCase):
    def test_production_discovery_uses_bounded_secure_transport(self) -> None:
        transport = _production_transport()
        self.assertIsInstance(transport, SecureHttpsTransport)
        self.assertEqual(transport.max_bytes, 10 * 1024 * 1024)

    def test_secure_discovery_redirect_revalidates_dns_and_strips_vendor_keys(self) -> None:
        dialer = FakeDialer(
            [
                FakeDialResponse(302, {"location": "https://cdn.example/final"}),
                FakeDialResponse(200, {"content-type": "application/json"}, b"{}"),
            ]
        )
        resolved: list[str] = []

        def resolver(hostname: str) -> tuple[str, ...]:
            resolved.append(hostname)
            return ("93.184.216.34",)

        transport = SecureHttpsTransport(resolver=resolver, dialer=dialer)
        response = transport.get(
            "https://api.example/search",
            headers={
                "Accept": "application/json",
                "x-api-key": "semantic-secret",
                "X-ELS-APIKey": "elsevier-secret",
            },
            timeout=1,
        )
        self.assertEqual(response.url, "https://cdn.example/final")
        self.assertEqual(resolved, ["api.example", "cdn.example"])
        self.assertIn("x-api-key", dialer.headers[0])
        self.assertIn("X-ELS-APIKey", dialer.headers[0])
        self.assertEqual(
            dialer.headers[1],
            {"User-Agent": "SciRetriever/2", "Accept": "application/json"},
        )

    def test_secure_transport_requires_exact_declared_body_length(self) -> None:
        cases = (
            (b"", "0"),
            (b"exact", "5"),
            (b"x" * (64 * 1024 + 3), str(64 * 1024 + 3)),
        )
        for body, declared in cases:
            with self.subTest(length=len(body)):
                response = FakeDialResponse(200, {"content-length": declared}, body)
                result = SecureHttpsTransport(
                    resolver=lambda _hostname: ("93.184.216.34",),
                    dialer=FakeDialer([response]),
                ).get("https://example.test/body", timeout=1)
                self.assertEqual(result.body, body)
                self.assertEqual(response.close_count, 1)

    def test_secure_transport_rejects_declared_length_mismatches_and_closes(self) -> None:
        for body, declared in ((b"short", "6"), (b"longer", "4")):
            with self.subTest(body=body, declared=declared):
                response = FakeDialResponse(200, {"content-length": declared}, body)
                transport = SecureHttpsTransport(
                    resolver=lambda _hostname: ("93.184.216.34",),
                    dialer=FakeDialer([response]),
                )
                with self.assertRaisesRegex(NetworkPolicyError, "Content-Length does not match"):
                    transport.get("https://example.test/body", timeout=1)
                self.assertEqual(response.close_count, 1)

        error_response = FakeDialResponse(
            503, {"content-length": "8"}, b"short"
        )
        with self.assertRaisesRegex(
            NetworkPolicyError, "Content-Length does not match"
        ):
            SecureHttpsTransport(
                resolver=lambda _hostname: ("93.184.216.34",),
                dialer=FakeDialer([error_response]),
            ).get("https://example.test/body", timeout=1)
        self.assertEqual(error_response.close_count, 1)

        for declared in ("invalid", "-1", "+4", "1_0", "４", "4, 4", "4, 5"):
            with self.subTest(declared=declared):
                response = FakeDialResponse(200, {"content-length": declared}, b"body")
                with self.assertRaisesRegex(NetworkPolicyError, "invalid HTTP Content-Length"):
                    SecureHttpsTransport(
                        resolver=lambda _hostname: ("93.184.216.34",),
                        dialer=FakeDialer([response]),
                    ).get("https://example.test/body", timeout=1)
                self.assertEqual(response.close_count, 1)

        conflicting = FakeDialResponse(
            200,
            [("Content-Length", "4"), ("content-length", "5")],
            b"body",
        )
        with self.assertRaisesRegex(NetworkPolicyError, "conflicting HTTP Content-Length"):
            SecureHttpsTransport(
                resolver=lambda _hostname: ("93.184.216.34",),
                dialer=FakeDialer([conflicting]),
            ).get("https://example.test/body", timeout=1)
        self.assertEqual(conflicting.close_count, 1)

    def test_secure_transport_closes_response_on_read_base_exception(self) -> None:
        failure = KeyboardInterrupt("injected read interruption")
        response = FakeDialResponse(200, {}, read_error=failure)
        with self.assertRaises(KeyboardInterrupt) as raised:
            SecureHttpsTransport(
                resolver=lambda _hostname: ("93.184.216.34",),
                dialer=FakeDialer([response]),
            ).get("https://example.test/body", timeout=1)
        self.assertIs(raised.exception, failure)
        self.assertEqual(response.close_count, 1)

    def test_headers_transport_closes_response_on_base_exception(self) -> None:
        failure = KeyboardInterrupt("injected headers interruption")
        response = FakeDialResponse(200, {}, headers_error=failure)
        with self.assertRaises(KeyboardInterrupt) as raised:
            SecureHttpsTransport(
                resolver=lambda _hostname: ("93.184.216.34",),
                dialer=FakeDialer([response]),
            ).head("https://example.test/body", timeout=1)
        self.assertIs(raised.exception, failure)
        self.assertEqual(response.close_count, 1)

    def test_secure_discovery_rejects_http_and_private_redirect_destinations(self) -> None:
        cases = (
            ("http://cdn.example/final", "93.184.216.34"),
            ("https://private.example/final", "127.0.0.1"),
        )
        for location, redirected_address in cases:
            with self.subTest(location=location):
                redirect = FakeDialResponse(302, {"location": location})
                dialer = FakeDialer([redirect])

                def resolver(hostname: str) -> tuple[str, ...]:
                    if hostname == "api.example":
                        return ("93.184.216.34",)
                    return (redirected_address,)

                transport = SecureHttpsTransport(resolver=resolver, dialer=dialer)
                with self.assertRaises(NetworkPolicyError):
                    transport.get("https://api.example/start", timeout=1)
                self.assertEqual(len(dialer.calls), 1)
                self.assertEqual(redirect.close_count, 1)

    def test_headers_only_transport_redirects_closes_and_never_reads(self) -> None:
        redirect = FakeDialResponse(302, {"location": "https://cdn.example/final"}, fail_on_read=True)
        final = FakeDialResponse(200, {"content-length": "10", "content-type": "application/pdf"}, fail_on_read=True)
        dialer = FakeDialer([redirect, final])
        resolved: list[str] = []

        def resolver(hostname: str) -> tuple[str, ...]:
            resolved.append(hostname)
            return ("93.184.216.34",)

        response = SecureHttpsTransport(
            resolver=resolver, dialer=dialer, max_bytes=10
        ).head(
            "https://api.example/start",
            headers={"Authorization": "secret", "Accept": "application/pdf"},
            timeout=1,
        )
        self.assertEqual(response.url, "https://cdn.example/final")
        self.assertEqual(response.header("content-length"), "10")
        self.assertEqual(resolved, ["api.example", "cdn.example"])
        self.assertNotIn("Authorization", dialer.headers[1])
        self.assertTrue(redirect.closed)
        self.assertTrue(final.closed)
        self.assertEqual((redirect.close_count, final.close_count), (1, 1))
        self.assertFalse(redirect.read_called)
        self.assertFalse(final.read_called)

    def test_headers_only_transport_rejects_oversized_declaration_without_read(self) -> None:
        response = FakeDialResponse(200, {"content-length": "11"}, fail_on_read=True)
        transport = SecureHttpsTransport(
            resolver=lambda _hostname: ("93.184.216.34",),
            dialer=FakeDialer([response]),
            max_bytes=10,
        )
        with self.assertRaisesRegex(NetworkPolicyError, "exceeds 10"):
            transport.head("https://example.test/paper", timeout=1)
        self.assertTrue(response.closed)
        self.assertFalse(response.read_called)

    def test_get_encodes_params_existing_query_headers_and_timeout(self) -> None:
        response_headers = Message()
        response_headers.add_header("Content-Type", "application/json")
        response_headers.add_header("Set-Cookie", "first=1")
        response_headers.add_header("Set-Cookie", "second=2")
        response = FakeResponse(b'{"ok":true}', status=206, headers=response_headers)
        opener = FakeOpener(response)
        transport: Transport = UrllibTransport(opener=opener, max_response_bytes=100)

        result = transport.get(
            "https://api.example.test/search?fixed=yes#fragment",
            params={"query": "C++ & retrieval", "page": 2, "tag": ("a", "b")},
            headers={"Accept": "application/json", "X-Agent": "Sci Retriever"},
            timeout=3.5,
        )

        request = opener.requests[0]
        parsed = urlsplit(request.full_url)
        self.assertEqual(parsed.fragment, "fragment")
        self.assertEqual(
            parse_qs(parsed.query),
            {
                "fixed": ["yes"],
                "query": ["C++ & retrieval"],
                "page": ["2"],
                "tag": ["a", "b"],
            },
        )
        self.assertEqual(request.get_method(), "GET")
        self.assertEqual(request.get_header("Accept"), "application/json")
        self.assertEqual(request.get_header("X-agent"), "Sci Retriever")
        self.assertEqual(opener.timeouts, [3.5])
        self.assertEqual(result.status, 206)
        self.assertEqual(result.body, b'{"ok":true}')
        self.assertEqual(result.url, "https://api.example.test/final")
        self.assertEqual(result.header("content-type"), "application/json")
        self.assertEqual(result.header("SET-COOKIE"), "first=1, second=2")
        self.assertEqual(response.read_amounts, [101])

    def test_sequence_params_preserve_order_and_duplicates(self) -> None:
        opener = FakeOpener(FakeResponse(b"ok"))
        transport = UrllibTransport(opener=opener)
        transport.get(
            "https://api.example.test/search",
            params=(("author", "Ada Lovelace"), ("author", "Grace Hopper")),
        )
        self.assertEqual(
            urlsplit(opener.requests[0].full_url).query,
            "author=Ada+Lovelace&author=Grace+Hopper",
        )
        self.assertEqual(opener.timeouts, [None])

    def test_response_is_frozen_and_missing_header_is_none(self) -> None:
        response = HttpResponse(200, (("X-Test", "value"),), b"body", "https://example.test")
        self.assertEqual(response.header("x-test"), "value")
        self.assertIsNone(response.header("missing"))
        with self.assertRaises(FrozenInstanceError):
            response.status = 500

    def test_response_read_is_bounded(self) -> None:
        response = FakeResponse(b"123456")
        transport = UrllibTransport(opener=FakeOpener(response), max_response_bytes=5)
        with self.assertRaisesRegex(ResponseTooLargeError, "exceeds 5 byte limit") as raised:
            transport.get("https://api.example.test/search")
        self.assertEqual(raised.exception.max_response_bytes, 5)
        self.assertEqual(response.read_amounts, [6])

    def test_oversized_response_maps_through_provider_with_chained_cause(self) -> None:
        response = FakeResponse(b"123456")
        transport = UrllibTransport(opener=FakeOpener(response), max_response_bytes=5)

        with self.assertRaises(ProviderSearchError) as raised:
            CrossrefProvider(transport).search(SearchSpec("query", ("crossref",), 1))

        error = raised.exception
        self.assertIsInstance(error, errors.SearchError)
        self.assertIs(error.category, ProviderErrorCategory.INVALID_RESPONSE)
        self.assertFalse(error.retryable)
        self.assertIsNone(error.status)
        self.assertIsInstance(error.__cause__, ResponseTooLargeError)
        self.assertEqual(error.__cause__.max_response_bytes, 5)

    def test_arbitrary_value_error_is_not_classified_as_oversized_response(self) -> None:
        failure = ValueError("injected transport bug")
        transport = UrllibTransport(opener=FakeOpener(error=failure))

        with self.assertRaises(ValueError) as raised:
            CrossrefProvider(transport).search(SearchSpec("query", ("crossref",), 1))

        self.assertIs(raised.exception, failure)

    def test_injected_transport_exception_is_not_swallowed(self) -> None:
        failure = URLError("offline")
        transport = UrllibTransport(opener=FakeOpener(error=failure))
        with self.assertRaises(URLError) as raised:
            transport.get("https://api.example.test/search", timeout=1.0)
        self.assertIs(raised.exception, failure)


class ProviderSearchErrorTests(TestCase):
    def test_http_status_mapping_and_fields(self) -> None:
        cases = (
            (401, ProviderErrorCategory.AUTHENTICATION, False),
            (403, ProviderErrorCategory.AUTHENTICATION, False),
            (429, ProviderErrorCategory.RATE_LIMIT, True),
            (408, ProviderErrorCategory.TRANSPORT, True),
            (425, ProviderErrorCategory.TRANSPORT, True),
            (400, ProviderErrorCategory.CLIENT, False),
            (404, ProviderErrorCategory.CLIENT, False),
            (500, ProviderErrorCategory.SERVER, True),
            (503, ProviderErrorCategory.SERVER, True),
        )
        for status, category, retryable in cases:
            with self.subTest(status=status):
                error = ProviderSearchError.for_http_status("crossref", status)
                self.assertIsInstance(error, errors.SearchError)
                self.assertEqual(error.provider, "crossref")
                self.assertIs(error.category, category)
                self.assertIs(error.retryable, retryable)
                self.assertEqual(error.status, status)

    def test_network_timeout_and_http_exceptions_are_mapped(self) -> None:
        network_errors = (URLError("offline"), TimeoutError("timed out"), socket.timeout())
        for cause in network_errors:
            with self.subTest(cause=type(cause).__name__):
                error = ProviderSearchError.for_exception("europe-pmc", cause)
                self.assertIs(error.category, ProviderErrorCategory.TRANSPORT)
                self.assertTrue(error.retryable)
                self.assertIsNone(error.status)

        http_error = HTTPError(
            "https://api.example.test",
            429,
            "Too Many Requests",
            Message(),
            BytesIO(b""),
        )
        mapped = ProviderSearchError.for_exception("crossref", http_error)
        self.assertIs(mapped.category, ProviderErrorCategory.RATE_LIMIT)
        self.assertEqual(mapped.status, 429)

    def test_invalid_response_is_nonretryable_and_cause_can_be_chained(self) -> None:
        cause = ValueError("payload is not JSON")
        try:
            raise ProviderSearchError.for_invalid_response(
                "arxiv", "arxiv returned malformed payload"
            ) from cause
        except ProviderSearchError as error:
            self.assertIs(error.category, ProviderErrorCategory.INVALID_RESPONSE)
            self.assertFalse(error.retryable)
            self.assertIsNone(error.status)
            self.assertIs(error.__cause__, cause)
        else:
            self.fail("ProviderSearchError was not raised")

    def test_non_error_status_and_unknown_exception_are_rejected(self) -> None:
        with self.assertRaises(ValueError):
            ProviderSearchError.for_http_status("crossref", 200)
        with self.assertRaises(TypeError):
            ProviderSearchError.for_exception("crossref", ValueError("bad payload"))

    def test_discovery_exports_only_stable_api(self) -> None:
        self.assertEqual(
            discovery.__all__,
            (
                "DEFAULT_MAX_RESPONSE_BYTES",
                "DEFAULT_MAX_CONCURRENCY",
                "DEFAULT_PROVIDER_TIMEOUT_SECONDS",
                "DEFAULT_SEARCH_LIMIT",
                "ArxivProvider",
                "Candidate",
                "CandidateObservation",
                "CandidatePreparer",
                "CandidateRetrievalRequest",
                "CandidateRetrievalResult",
                "CrossrefProvider",
                "DiscoveryProvider",
                "DiscoveryOutput",
                "DownloadManifestEntry",
                "EuropePMCProvider",
                "ElsevierProvider",
                "HttpResponse",
                "OpenAlexProvider",
                "SemanticScholarProvider",
                "SpringerProvider",
                "KeywordRuleLabeler",
                "LabelInput",
                "LabelResult",
                "LabeledCandidate",
                "Labeler",
                "MergedCandidate",
                "MetadataSearchFailure",
                "MetadataSearchOutput",
                "MetadataSearchRequest",
                "MetadataSearchResult",
                "MetadataSearchService",
                "ProviderErrorCategory",
                "ProviderFailure",
                "ProviderRecord",
                "ProviderSearchError",
                "SearchSpec",
                "RetrievedCandidate",
                "Transport",
                "UrllibTransport",
                "build_arxiv_provider",
                "build_crossref_provider",
                "build_europe_pmc_provider",
                "build_elsevier_provider",
                "build_openalex_provider",
                "build_semantic_scholar_provider",
                "build_springer_provider",
                "clean_text",
                "discover",
                "discover_to_jsonl",
                "identifier_sort_key",
                "label_candidate",
                "label_input_sha256",
                "normalize_record",
                "normalize_records",
                "write_manifest",
            ),
        )


if __name__ == "__main__":
    import unittest

    unittest.main()
