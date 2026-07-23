import argparse
import asyncio
import contextlib
from importlib import import_module
from io import BytesIO, StringIO
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import threading
import time
from unittest import TestCase, mock

REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
ACQUISITION_FIXTURES = REPOSITORY / "tests" / "fixtures" / "acquisition"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.acquisition import (
    AcquisitionOrchestrator,
    AcquisitionResult,
    AcquisitionTarget,
    AdmissionService,
    ArxivProvider,
    CrossrefProvider,
    DirectHttpsProvider,
    EuropePmcProvider,
    HttpResponse,
    ProviderContent,
    UnpaywallProvider,
    UrlPolicy,
    read_manifest,
    validate_primary_pdf,
)
from sciretriever.acquisition.providers import ProviderAcquisitionError
from sciretriever.acquisition.transport import UrllibAcquisitionTransport, _read_bounded
from sciretriever.catalog.jobs import attach_or_create_job
from sciretriever.catalog import AssetRepository, IdentityResolver, JobRepository, initialize_catalog, create_catalog_engine
from sciretriever.cli import acquire as acquire_cli
from sciretriever.cli.main import main
from sciretriever.core.contracts import CandidateMetadata, DownloadManifestEntry, Identifier, Provenance
from sciretriever.core.enums import AssetRole, JobState
from sciretriever.core.validation import normalize_media_type
from sciretriever.errors import AcquisitionError, CatalogError, ProviderErrorCategory, ValidationError
from sciretriever.integrations import ArxivClient, CrossrefClient, EuropePmcClient
from sciretriever.network import url_with_params
from sciretriever.storage import AssetAcceptanceCoordinator, RawAssetStore


def pdf_bytes(*, pages=2) -> bytes:
    stream = BytesIO()
    writer = import_module("PyPDF2").PdfWriter()
    for _ in range(pages):
        writer.add_blank_page(width=72, height=72)
    writer.add_metadata({"/Subject": "x" * 2_000})
    writer.write(stream)
    return stream.getvalue()


class FakeTransport:
    def __init__(self, responses, resolver=None):
        self.responses = list(responses)
        self.urls = []
        self.resolver = resolver

    def resolve_host(self, hostname):
        if self.resolver is not None:
            return self.resolver(hostname)
        return ("93.184.216.34",)

    def get(self, url, *, params=None, headers=None, timeout=None):
        self.urls.append((url_with_params(url, params), timeout))
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


class CountingReader:
    def __init__(self, size):
        self.remaining = size
        self.read_bytes = 0

    def read(self, n=-1):
        amount = self.remaining if n < 0 else min(n, self.remaining)
        self.remaining -= amount
        self.read_bytes += amount
        return b"x" * amount


class NamedDirectProvider(DirectHttpsProvider):
    def __init__(self, name, transport):
        super().__init__(transport)
        self.name = name


def response(url, body=None, content_type="application/pdf", status=200):
    return HttpResponse(status, url, {"content-type": content_type}, pdf_bytes() if body is None else body)


class FakeDialResponse:
    def __init__(self, status, headers, body):
        self.status = status
        self._headers = headers
        self._stream = BytesIO(body)

    def getheaders(self):
        return list(self._headers.items())

    def read(self, n=-1):
        return self._stream.read(n)

    def close(self):
        self._stream.close()


class FakeDialer:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []
        self.headers = []

    def get(self, hostname, address, port, target, *, timeout, headers):
        self.calls.append((hostname, address, port, target, timeout))
        self.headers.append(dict(headers))
        return self.responses.pop(0)


class AcquisitionTests(TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.storage = self.base / "storage"
        self.storage.mkdir()
        self.catalog = create_catalog_engine(self.base / "catalog.sqlite")
        self.addCleanup(self.catalog.dispose)
        initialize_catalog(self.catalog)
        self.assets = AssetRepository(self.catalog)
        self.jobs = JobRepository(self.catalog)
        self.admission = AdmissionService(IdentityResolver(self.catalog), self.jobs, self.assets)
        self.coordinator = AssetAcceptanceCoordinator(self.assets, RawAssetStore(self.storage))

    def test_streaming_manifest_reports_line_number(self):
        path = self.base / "manifest.jsonl"
        entry = DownloadManifestEntry(
            (Identifier("doi", "10.1/test"),), CandidateMetadata(title="Title"), (), True, False, None,
            Provenance(("crossref",), "2026-07-20T00:00:00Z", "run"),
        )
        path.write_text(entry.to_json_line() + "\n{bad}\n", encoding="utf-8")
        reader = read_manifest(path)
        self.assertEqual(next(reader), entry)
        with self.assertRaisesRegex(ValidationError, "line 2"):
            next(reader)

        blank = self.base / "blank.jsonl"
        blank.write_text("\n", encoding="utf-8")
        with self.assertRaisesRegex(ValidationError, "line 1"):
            next(read_manifest(blank))

    def test_bounded_body_stops_before_full_response(self):
        declared = CountingReader(1000)
        with self.assertRaises(AcquisitionError):
            _read_bounded(declared, {"content-length": "1000"}, 100)
        self.assertEqual(declared.read_bytes, 0)
        streamed = CountingReader(1000)
        with self.assertRaises(AcquisitionError):
            _read_bounded(streamed, {}, 100)
        self.assertEqual(streamed.read_bytes, 101)

    def test_pdf_validation_accepts_valid_and_rejects_bad_payloads(self):
        good = pdf_bytes()
        self.assertGreaterEqual(len(good), 1_000)
        validate_primary_pdf(ProviderContent(AssetRole.PRIMARY_PDF, "application/pdf", "pdf", "https://example.test/a", "fake", good))
        cases = (
            (good[:-5], "application/pdf"),
            (b"<html>not a pdf</html>" * 4, "text/html"),
            (b"%PDF-preview\n%%EOF" + b"x" * 30, "application/pdf"),
        )
        for data, media_type in cases:
            with self.subTest(data=data[:12]):
                with self.assertRaises(ValidationError):
                    validate_primary_pdf(ProviderContent(AssetRole.PRIMARY_PDF, media_type, "pdf", "https://example.test/a", "fake", data))
        with self.assertRaisesRegex(ValidationError, "preview"):
            validate_primary_pdf(ProviderContent(AssetRole.PRIMARY_PDF, "application/pdf", "pdf", "https://example.test/a", "fake", pdf_bytes(pages=1)))
        with self.assertRaisesRegex(ValidationError, "format"):
            validate_primary_pdf(ProviderContent(AssetRole.PRIMARY_PDF, "application/pdf", "PDF", "https://example.test/a", "fake", good))

    def test_media_type_normalization_is_strict(self):
        accepted = {
            "Application/PDF; charset=utf-8": "application/pdf",
            ' text/HTML ; charset="utf-8" ': "text/html",
            'application/xml; profile="a\\\"b"': "application/xml",
        }
        for value, expected in accepted.items():
            with self.subTest(value=value):
                self.assertEqual(normalize_media_type(value), expected)

        rejected = (
            "application/",
            "/pdf",
            "application//pdf",
            "!application/pdf",
            "application/!pdf",
            "application/pdf; charset",
            "application/pdf; charset=",
            'application/pdf; charset=""',
            'application/pdf; charset="unterminated',
            "application/pdf, text/html",
            "application/pdf\r\nX-Test: injected",
        )
        for value in rejected:
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    normalize_media_type(value)
                with self.assertRaises(ValueError):
                    ProviderContent(
                        AssetRole.PRIMARY_PDF,
                        value,
                        "pdf",
                        "https://example.test/a",
                        "fake",
                        b"not staged",
                    )

    def test_url_policy_rejects_unsafe_urls_and_redirect_targets(self):
        policy = UrlPolicy(forbidden_urls=("https://blocked.example/",))
        for url, addresses in (
            ("http://example.test/a", ("93.184.216.34",)),
            ("https://user:pass@example.test/a", ("93.184.216.34",)),
            ("https://example.test/a", ("127.0.0.1",)),
            ("https://blocked.example/a", ("93.184.216.34",)),
        ):
            with self.subTest(url=url), self.assertRaises(AcquisitionError):
                policy.validate(url, addresses)
        dialer = FakeDialer(
            [FakeDialResponse(302, {"location": "https://127.0.0.1/final"}, b"")]
        )
        transport = UrllibAcquisitionTransport(
            resolver=lambda hostname: ("127.0.0.1",) if hostname == "127.0.0.1" else ("93.184.216.34",),
            dialer=dialer,
        )
        with self.assertRaises(AcquisitionError):
            transport.get("https://example.test/a", timeout=1)
        self.assertEqual(len(dialer.calls), 1)

    def test_transport_pins_validated_ip_and_limits_redirects(self):
        dialer = FakeDialer([FakeDialResponse(200, {"content-type": "application/pdf"}, pdf_bytes())])
        transport = UrllibAcquisitionTransport(
            resolver=lambda hostname: ("93.184.216.34", "93.184.216.35"),
            dialer=dialer,
        )
        transport.get("https://example.test/paper?q=1", timeout=2)
        hostname, address, port, target, remaining = dialer.calls[0]
        self.assertEqual(
            (hostname, address, port, target),
            ("example.test", "93.184.216.34", 443, "/paper?q=1"),
        )
        self.assertGreater(remaining, 0)
        self.assertLessEqual(remaining, 2)
        looping = FakeDialer([FakeDialResponse(302, {"location": "/again"}, b"") for _ in range(2)])
        limited = UrllibAcquisitionTransport(
            max_redirects=1,
            resolver=lambda hostname: ("93.184.216.34",),
            dialer=looping,
        )
        with self.assertRaisesRegex(AcquisitionError, "redirect limit"):
            limited.get("https://example.test/start", timeout=1)

    def test_native_provider_resolution(self):
        pdf = response("https://files.example/paper.pdf")
        transports = (
            FakeTransport([pdf]),
            FakeTransport([response("https://api.crossref.org/x", json.dumps({"message":{"link":[{"content-type":"application/pdf","URL":"https://files.example/paper.pdf"}]}}).encode(), "application/json"), pdf]),
            FakeTransport([response("https://api.unpaywall.org/x", json.dumps({"best_oa_location":{"url_for_pdf":"https://files.example/paper.pdf"},"oa_locations":[]}).encode(), "application/json"), pdf]),
            FakeTransport([response("https://ebi.example/search", json.dumps({"resultList":{"result":[{"fullTextUrlList":{"fullTextUrl":[{"documentStyle":"pdf","url":"https://files.example/paper.pdf"}]}}]}}).encode(), "application/json"), pdf]),
        )
        cases = (
            (ArxivProvider(transports[0]), AcquisitionTarget((Identifier("arxiv", "2401.00001"),)), "arxiv.org/pdf/2401.00001.pdf", transports[0]),
            (CrossrefProvider(transports[1]), AcquisitionTarget((Identifier("doi", "10.1/test"),)), "api.crossref.org/works/10.1%2Ftest", transports[1]),
            (UnpaywallProvider(transports[2], "reader@example.org"), AcquisitionTarget((Identifier("doi", "10.1/test"),)), "api.unpaywall.org/v2/10.1%2Ftest", transports[2]),
            (EuropePmcProvider(transports[3]), AcquisitionTarget((Identifier("pmid", "123"),)), "europepmc/webservices/rest/search", transports[3]),
        )
        for provider, target, expected, transport in cases:
            with self.subTest(provider=provider.name):
                content = provider.acquire(target, timeout=2)
                self.assertEqual(content.data, pdf.body)
                self.assertIn(expected, transport.urls[0][0])

    def test_dual_capability_providers_compose_shared_clients(self):
        pdf = response("https://files.example/shared.pdf")
        crossref_transport = FakeTransport(
            [
                response(
                    "https://api.crossref.org/works/10.1%2Fshared",
                    (ACQUISITION_FIXTURES / "crossref_lookup.json").read_bytes(),
                    "application/json",
                ),
                pdf,
            ]
        )
        crossref = CrossrefProvider(crossref_transport)
        self.assertIsInstance(crossref._client, CrossrefClient)
        self.assertEqual(
            crossref.acquire(
                AcquisitionTarget((Identifier("doi", "10.1/shared"),)),
                timeout=1,
            ).data,
            pdf.body,
        )

        europe_transport = FakeTransport(
            [
                response(
                    "https://www.ebi.ac.uk/europepmc/webservices/rest/search",
                    (ACQUISITION_FIXTURES / "europe_pmc_lookup.json").read_bytes(),
                    "application/json",
                ),
                pdf,
            ]
        )
        europe_pmc = EuropePmcProvider(europe_transport)
        self.assertIsInstance(europe_pmc._client, EuropePmcClient)
        self.assertEqual(
            europe_pmc.acquire(
                AcquisitionTarget((Identifier("pmid", "123"),)), timeout=1
            ).data,
            pdf.body,
        )

        arxiv_transport = FakeTransport([pdf])
        arxiv = ArxivProvider(arxiv_transport)
        self.assertIsInstance(arxiv._client, ArxivClient)
        arxiv.acquire(
            AcquisitionTarget((Identifier("arxiv", "2401.00001"),)), timeout=1
        )
        self.assertIn("/pdf/2401.00001.pdf", arxiv_transport.urls[0][0])

    def test_europe_pmc_uses_later_result_with_pdf(self):
        resolver = response(
            "https://ebi.example/search",
            json.dumps({"resultList": {"result": [{"title": "no route"}, {"fullTextUrlList": {"fullTextUrl": [{"documentStyle": "pdf", "url": "https://files.example/later.pdf"}]}}]}}).encode(),
            "application/json",
        )
        transport = FakeTransport([resolver, response("https://files.example/later.pdf")])
        content = EuropePmcProvider(transport).acquire(AcquisitionTarget((Identifier("pmid", "123"),)), timeout=1)
        self.assertEqual(content.source_url, "https://files.example/later.pdf")

        fallback_transport = FakeTransport([
            response("https://ebi.example/search", b'{"resultList":{"result":[{"pmcid":"PMC123"}]}}', "application/json"),
            response("https://www.ebi.ac.uk/europepmc/webservices/rest/PMC123/fullTextPDF"),
        ])
        fallback = EuropePmcProvider(fallback_transport).acquire(AcquisitionTarget((Identifier("pmid", "123"),)), timeout=1)
        self.assertTrue(fallback.source_url.endswith("/PMC123/fullTextPDF"))

    def test_article_pdf_resolvers_reject_supplementary_role_before_network(self):
        identifiers = (Identifier("doi", "10.1/primary-only"),)
        transports = (FakeTransport([]), FakeTransport([]), FakeTransport([]))
        cases = (
            (CrossrefProvider(transports[0]), transports[0]),
            (
                UnpaywallProvider(transports[1], "reader@example.test"),
                transports[1],
            ),
            (EuropePmcProvider(transports[2]), transports[2]),
        )
        target = AcquisitionTarget(
            identifiers, role=AssetRole.SUPPLEMENTARY_PDF
        )
        for provider, transport in cases:
            with self.subTest(provider=provider.name):
                with self.assertRaisesRegex(AcquisitionError, "primary PDF"):
                    provider.acquire(target, timeout=1)
                self.assertEqual(transport.urls, [])

        crossref_transport = FakeTransport([])
        crossref = CrossrefProvider(crossref_transport)
        admission = self.admission.admit(
            identifiers,
            provider="crossref",
            asset_role=AssetRole.SUPPLEMENTARY_PDF,
        )
        result = asyncio.run(
            AcquisitionOrchestrator(self.jobs, self.coordinator).acquire(
                admission,
                target,
                crossref,
                timeout=1,
            )
        )
        self.assertNotEqual(result.status, "succeeded")
        self.assertEqual(self.assets.get_work_version_assets(admission.work_version_id), ())
        self.assertEqual(crossref_transport.urls, [])

    def test_provider_malformed_shapes_are_classified(self):
        malformed = (
            CrossrefProvider(FakeTransport([response("https://api.crossref.org/x", b'{"message":{"link":{}}}', "application/json")])),
            UnpaywallProvider(FakeTransport([response("https://api.unpaywall.org/x", b'{"best_oa_location":null,"oa_locations":{}}', "application/json")]), "a@b.test"),
            EuropePmcProvider(FakeTransport([response("https://ebi.example/x", b'{"resultList":{"result":[{"fullTextUrlList":{"fullTextUrl":{}}}]}}', "application/json")])),
        )
        targets = (
            AcquisitionTarget((Identifier("doi", "10.1/x"),)),
            AcquisitionTarget((Identifier("doi", "10.1/x"),)),
            AcquisitionTarget((Identifier("pmid", "1"),)),
        )
        for provider, target in zip(malformed, targets):
            with self.subTest(provider=provider.name), self.assertRaises(ProviderAcquisitionError) as raised:
                provider.acquire(target, timeout=1)
            self.assertEqual(raised.exception.category, ProviderErrorCategory.INVALID_RESPONSE)
            self.assertFalse(raised.exception.retryable)

    def test_forbidden_resolver_target_is_rejected_before_dial(self):
        resolver_body = json.dumps({"message": {"link": [{"content-type": "application/pdf", "URL": "https://blocked.example/paper.pdf"}]}}).encode()
        dialer = FakeDialer([FakeDialResponse(200, {"content-type": "application/json"}, resolver_body)])
        policy = UrlPolicy(forbidden_urls=("https://blocked.example/",))
        transport = UrllibAcquisitionTransport(
            policy,
            resolver=lambda hostname: ("93.184.216.34",),
            dialer=dialer,
        )
        provider = CrossrefProvider(transport, policy)
        with self.assertRaisesRegex(AcquisitionError, "forbidden"):
            provider.acquire(AcquisitionTarget((Identifier("doi", "10.1/x"),)), timeout=1)
        self.assertEqual(len(dialer.calls), 1)

    def test_provider_status_classification(self):
        expected = {
            401: (ProviderErrorCategory.AUTHENTICATION, False),
            403: (ProviderErrorCategory.AUTHENTICATION, False),
            429: (ProviderErrorCategory.RATE_LIMIT, True),
            503: (ProviderErrorCategory.SERVER, True),
        }
        for status, result in expected.items():
            with self.subTest(status=status):
                error = ProviderAcquisitionError.for_status("test", status)
                self.assertEqual((error.category, error.retryable), result)

    def test_end_to_end_success_and_no_network_replay(self):
        identifiers = (Identifier("doi", "10.1/acquire"),)
        first = self.admission.admit(identifiers, provider="direct", direct_url="https://example.test/paper.pdf")
        provider = DirectHttpsProvider(
            FakeTransport(
                [
                    response(
                        "https://example.test/paper.pdf",
                        content_type="Application/PDF; charset=utf-8",
                    )
                ]
            )
        )
        target = AcquisitionTarget(identifiers, "https://example.test/paper.pdf")
        result = asyncio.run(AcquisitionOrchestrator(self.jobs, self.coordinator).acquire(first, target, provider, timeout=2))
        self.assertEqual(result.status, "succeeded")
        self.assertEqual(self.jobs.get_job(first.job_id).state, JobState.SUCCEEDED)
        self.assertEqual(self.jobs.list_requests(first.job_id)[0].status, "succeeded")
        self.assertIsNotNone(self.jobs.list_attempts(first.job_id)[0].finished_at)
        attempt = self.jobs.list_attempts(first.job_id)[0]
        self.assertIsNone(attempt.source_url)
        self.assertNotIn("https://example.test/paper.pdf", attempt.details_json)
        self.assertEqual(json.loads(attempt.details_json)["schema_version"], 1)
        self.assertNotIn("candidates", json.loads(attempt.details_json))
        work_asset = self.assets.get_work_version_assets(first.work_version_id)[0]
        raw_asset = self.assets.get_raw_asset(work_asset.raw_asset_id)
        self.assertEqual(raw_asset.media_type, "application/pdf")
        replay = self.admission.admit(identifiers, provider="direct", direct_url="https://example.test/paper.pdf")
        self.assertEqual(replay.reused_asset_id, result.raw_asset_id)
        replay_transport = FakeTransport([AssertionError("network called")])
        no_network = DirectHttpsProvider(replay_transport)
        replay_result = asyncio.run(AcquisitionOrchestrator(self.jobs, self.coordinator).acquire(replay, target, no_network, timeout=2))
        self.assertEqual(replay_result.status, "reused")
        self.assertEqual(replay_transport.urls, [])

    def test_resolver_attempt_and_asset_provenance_exclude_runtime_urls(self):
        identifiers = (Identifier("doi", "10.1/provenance"),)
        admission = self.admission.admit(identifiers, provider="crossref")
        resolver = response(
            "https://api.crossref.org/works/10.1%2Fprovenance",
            b'{"message":{"link":[{"content-type":"application/pdf","URL":"https://files.example/final.pdf"}]}}',
            "application/json",
        )
        provider = CrossrefProvider(FakeTransport([resolver, response("https://files.example/final.pdf")]))
        result = asyncio.run(AcquisitionOrchestrator(self.jobs, self.coordinator).acquire(admission, AcquisitionTarget(identifiers), provider, timeout=1))
        self.assertEqual(result.status, "succeeded")
        attempt = self.jobs.list_attempts(admission.job_id)[0]
        self.assertIsNone(attempt.source_url)
        self.assertNotIn("https://api.crossref.org/works/10.1%2Fprovenance", attempt.details_json)
        self.assertNotIn("https://files.example/final.pdf", attempt.details_json)
        raw = self.assets.get_work_version_assets(admission.work_version_id)[0]
        raw_asset = self.assets.get_raw_asset(raw.raw_asset_id)
        self.assertNotIn("https://files.example/final.pdf", raw_asset.provenance_json)
        self.assertIn('"candidate_id":"p4"', raw_asset.provenance_json)
        self.assertIn('"resolver":"legacy_single"', raw_asset.provenance_json)

    def test_provider_failures_close_or_retry_job(self):
        for status, expected in ((404, JobState.FAILED), (503, JobState.FAILED)):
            identifiers = (Identifier("doi", f"10.1/fail-{status}"),)
            admission = self.admission.admit(identifiers, provider="direct", direct_url="https://example.test/a")
            provider = DirectHttpsProvider(FakeTransport([response("https://example.test/a", status=status)]))
            result = asyncio.run(AcquisitionOrchestrator(self.jobs, self.coordinator).acquire(admission, AcquisitionTarget(identifiers, "https://example.test/a"), provider, timeout=2))
            self.assertNotEqual(result.status, "succeeded")
            self.assertEqual(self.jobs.get_job(admission.job_id).state, expected)

    def test_provider_specific_request_keys_allow_new_job_after_terminal_failure(self):
        identifiers = (Identifier("doi", "10.1/provider-key"),)
        crossref = self.admission.admit(identifiers, provider="crossref")
        failed = NamedDirectProvider("crossref", FakeTransport([response("https://example.test/a", status=404)]))
        asyncio.run(AcquisitionOrchestrator(self.jobs, self.coordinator).acquire(crossref, AcquisitionTarget(identifiers, "https://example.test/a"), failed, timeout=1))
        unpaywall = self.admission.admit(identifiers, provider="unpaywall")
        self.assertNotEqual(crossref.request_key, unpaywall.request_key)
        self.assertNotEqual(crossref.job_id, unpaywall.job_id)

    def test_orchestrator_rejects_provider_mismatch_before_claim(self):
        identifiers = (Identifier("doi", "10.1/provider-mismatch"),)
        admission = self.admission.admit(identifiers, provider="crossref")
        provider = NamedDirectProvider("unpaywall", FakeTransport([AssertionError("network called")]))
        with self.assertRaisesRegex(AcquisitionError, "does not match"):
            asyncio.run(AcquisitionOrchestrator(self.jobs, self.coordinator).acquire(admission, AcquisitionTarget(identifiers), provider, timeout=1))
        self.assertEqual(self.jobs.get_job(admission.job_id).state, JobState.PENDING)
        self.assertEqual(self.jobs.list_attempts(admission.job_id), ())

    def test_atomic_claim_allows_only_one_concurrent_provider_call(self):
        identifiers = (Identifier("doi", "10.1/concurrent-provider"),)
        admission = self.admission.admit(identifiers, provider="direct", direct_url="https://example.test/a")
        started = threading.Event()
        release = threading.Event()

        class BlockingProvider:
            name = "direct"
            calls = 0

            def initial_url(self, target):
                return "https://example.test/a"

            def acquire(self, target, *, timeout):
                self.calls += 1
                started.set()
                release.wait(2)
                return ProviderContent(AssetRole.PRIMARY_PDF, "application/pdf", "pdf", "https://example.test/a", self.name, pdf_bytes())

        provider = BlockingProvider()

        async def run_both():
            first_orchestrator = AcquisitionOrchestrator(self.jobs, self.coordinator)
            second_orchestrator = AcquisitionOrchestrator(self.jobs, self.coordinator)
            first = asyncio.create_task(first_orchestrator.acquire(admission, AcquisitionTarget(identifiers, "https://example.test/a"), provider, timeout=2))
            await asyncio.to_thread(started.wait, 1)
            async def unblock():
                await asyncio.sleep(0.02)
                release.set()
            asyncio.create_task(unblock())
            second = await second_orchestrator.acquire(admission, AcquisitionTarget(identifiers, "https://example.test/a"), provider, timeout=2)
            return await first, second

        first, second = asyncio.run(run_both())
        self.assertEqual(first.status, "succeeded")
        self.assertEqual(second.status, "reused")
        self.assertEqual(provider.calls, 1)
        self.assertEqual(len(self.jobs.list_attempts(admission.job_id)), 1)

    def test_stale_active_attachment_is_reentered(self):
        identifiers = (Identifier("doi", "10.1/active"),)
        admission = self.admission.admit(identifiers, provider="direct", direct_url="https://example.test/a")
        self.jobs.restart_foreground_job(admission.job_id)
        transport = FakeTransport([response("https://example.test/a")])
        result = asyncio.run(AcquisitionOrchestrator(self.jobs, self.coordinator).acquire(admission, AcquisitionTarget(identifiers, "https://example.test/a"), DirectHttpsProvider(transport), timeout=1))
        self.assertEqual(result.status, "succeeded")
        self.assertEqual(len(transport.urls), 1)

    def test_timeout_and_cancellation_close_attempts_coherently(self):
        drained = threading.Event()

        class SlowProvider:
            name = "slow"

            def initial_url(self, target):
                return "https://example.test/a"

            def acquire(self, target, *, timeout):
                time.sleep(0.1)
                drained.set()
                return ProviderContent(AssetRole.PRIMARY_PDF, "application/pdf", "pdf", "https://example.test/a", self.name, pdf_bytes())

        timed = self.admission.admit((Identifier("doi", "10.1/timeout"),), provider="slow")
        result = asyncio.run(AcquisitionOrchestrator(self.jobs, self.coordinator).acquire(timed, AcquisitionTarget((Identifier("doi", "10.1/timeout"),)), SlowProvider(), timeout=0.01))
        self.assertEqual(result.status, "failed")
        self.assertEqual(self.jobs.get_job(timed.job_id).state, JobState.FAILED)
        self.assertFalse(drained.is_set())
        self.assertEqual(self.assets.get_work_version_assets(timed.work_version_id), ())
        self.assertTrue(drained.wait(0.2))
        self.assertEqual(self.assets.get_work_version_assets(timed.work_version_id), ())

        cancelled = self.admission.admit((Identifier("doi", "10.1/cancel"),), provider="slow")

        async def cancel():
            task = asyncio.create_task(AcquisitionOrchestrator(self.jobs, self.coordinator).acquire(cancelled, AcquisitionTarget((Identifier("doi", "10.1/cancel"),)), SlowProvider(), timeout=1))
            await asyncio.sleep(0.01)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task

        asyncio.run(cancel())
        self.assertEqual(self.jobs.get_job(cancelled.job_id).state, JobState.CANCELLED)
        self.assertEqual(self.jobs.list_attempts(cancelled.job_id)[0].outcome.value, "cancelled")

    def test_no_network_replay_repairs_dangling_job_and_requests(self):
        identifiers = (Identifier("doi", "10.1/repair"),)
        initial = self.admission.admit(identifiers, provider="direct", direct_url="https://example.test/a")
        provider = DirectHttpsProvider(FakeTransport([response("https://example.test/a")]))
        asyncio.run(AcquisitionOrchestrator(self.jobs, self.coordinator).acquire(initial, AcquisitionTarget(identifiers, "https://example.test/a"), provider, timeout=1))
        dangling = attach_or_create_job(self.catalog, initial.work_version_id, AssetRole.PRIMARY_PDF, "manual-dangling")
        replay = self.admission.admit(identifiers, provider="crossref")
        self.assertIsNotNone(replay.reused_asset_id)
        self.assertEqual(self.jobs.get_job(dangling.id).state, JobState.SUCCEEDED)
        self.assertEqual(self.jobs.list_requests(dangling.id)[0].status, "succeeded")

    def test_post_acceptance_closure_fault_is_repaired_without_double_finish(self):
        identifiers = (Identifier("doi", "10.1/closure-fault"),)
        admission = self.admission.admit(identifiers, provider="direct", direct_url="https://example.test/a")
        provider = DirectHttpsProvider(FakeTransport([response("https://example.test/a")]))
        with mock.patch.object(
            self.jobs,
            "finish_attempt_and_job",
            side_effect=CatalogError("injected closure failure"),
        ) as close:
            result = asyncio.run(
                AcquisitionOrchestrator(self.jobs, self.coordinator).acquire(
                    admission,
                    AcquisitionTarget(identifiers, "https://example.test/a"),
                    provider,
                    timeout=1,
                )
            )
        close.assert_called_once()
        self.assertEqual(result.status, JobState.SUCCEEDED.value)
        attempt = self.jobs.list_attempts(admission.job_id)[0]
        self.assertEqual(attempt.outcome.value, "succeeded")
        self.assertIsNotNone(attempt.finished_at)
        self.assertEqual(self.jobs.get_job(admission.job_id).state, JobState.SUCCEEDED)
        self.assertEqual(self.jobs.list_requests(admission.job_id)[0].status, "succeeded")
        self.assertEqual(len(self.assets.get_work_version_assets(admission.work_version_id)), 1)

        replay = self.admission.admit(identifiers, provider="direct", direct_url="https://example.test/a")
        self.assertIsNotNone(replay.reused_asset_id)
        self.assertEqual(len(self.assets.get_work_version_assets(admission.work_version_id)), 1)

    def test_terminal_completion_is_idempotent_but_not_rewritable(self):
        identifiers = (Identifier("doi", "10.1/terminal"),)
        admission = self.admission.admit(identifiers, provider="direct", direct_url="https://example.test/a")
        self.jobs.restart_foreground_job(admission.job_id)
        first = self.jobs.complete_job_and_requests(admission.job_id, JobState.FAILED)
        second = self.jobs.complete_job_and_requests(admission.job_id, JobState.FAILED)
        self.assertEqual(first, second)
        with self.assertRaises(Exception):
            self.jobs.complete_job_and_requests(admission.job_id, JobState.SUCCEEDED)

    def test_cli_argument_and_runtime_exit_codes(self):
        with contextlib.redirect_stderr(StringIO()), self.assertRaises(SystemExit) as raised:
            main(["acquire", "--doi", "10.1/x"])
        self.assertEqual(raised.exception.code, 2)
        with mock.patch("sciretriever.cli.acquire._execute_async", return_value=(1, 0)):
            output = StringIO()
            with contextlib.redirect_stdout(output):
                code = main(["acquire", "--doi", "10.1/x", "--catalog", str(self.base / "catalog.sqlite"), "--storage-root", str(self.storage), "--provider", "crossref"])
        self.assertEqual(code, 0)
        self.assertIn("1 succeeded", output.getvalue())
        with mock.patch("sciretriever.cli.acquire._execute_async", return_value=(1, 1)):
            code = main(["acquire", "--doi", "10.1/x", "--catalog", str(self.base / "catalog.sqlite"), "--storage-root", str(self.storage), "--provider", "crossref"])
        self.assertEqual(code, 1)
        help_output = StringIO()
        with contextlib.redirect_stdout(help_output), self.assertRaises(SystemExit) as raised:
            main(["acquire", "--help"])
        self.assertEqual(raised.exception.code, 0)
        self.assertIn("--forbidden-urls", help_output.getvalue())

    def test_cli_inputs_support_manifest_and_direct_doi(self):
        entry = DownloadManifestEntry(
            (Identifier("doi", "10.1/manifest"),), CandidateMetadata(title="Title"), (), True, False, None,
            Provenance(("crossref",), "2026-07-20T00:00:00Z", "run"),
        )
        path = self.base / "manifest-input.jsonl"
        path.write_text(entry.to_json_line() + "\n", encoding="utf-8")
        manifest_args = mock.Mock(manifest=path, doi=None, url=None)
        direct_args = mock.Mock(manifest=None, doi="10.1/direct", url=None)
        self.assertEqual(tuple(acquire_cli._inputs(manifest_args))[0][0], entry.identifiers)
        self.assertEqual(tuple(acquire_cli._inputs(direct_args))[0][0], (Identifier("doi", "10.1/direct"),))

    def test_cli_forbidden_file_and_partial_manifest_continue(self):
        forbidden = self.base / "forbidden.txt"
        forbidden.write_text("# comment\n\nhttps://blocked.example/\n", encoding="utf-8")
        self.assertEqual(acquire_cli.read_forbidden_urls(forbidden), ("https://blocked.example/",))

        entries = (
            DownloadManifestEntry((Identifier("doi", "10.1/first"),), CandidateMetadata(title="First"), (), True, False, None, Provenance(("crossref",), "2026-07-20T00:00:00Z", "run")),
            DownloadManifestEntry((Identifier("doi", "10.1/second"),), CandidateMetadata(title="Second"), (), True, False, None, Provenance(("crossref",), "2026-07-20T00:00:00Z", "run")),
        )
        manifest = self.base / "batch.jsonl"
        manifest.write_text("\n".join(entry.to_json_line() for entry in entries) + "\n", encoding="utf-8")

        class StubProvider:
            name = "crossref"

        args = mock.Mock(
            manifest=manifest,
            doi=None,
            url=None,
            catalog=self.base / "catalog.sqlite",
            storage_root=self.storage,
            provider="crossref",
            timeout=1.0,
            forbidden_urls=forbidden,
            source_plan=None,
            providers=None,
            resume_job=None,
            due_jobs=False,
            asset_role="primary_pdf",
            routing="serial",
            host_concurrency=2,
            host_min_interval=0.0,
        )
        success = AcquisitionResult("00000000-0000-4000-8000-000000000001", None, "succeeded")
        with (
            mock.patch("sciretriever.cli.acquire._provider", return_value=StubProvider()),
            mock.patch.object(AcquisitionOrchestrator, "acquire", new=mock.AsyncMock(side_effect=[AcquisitionError("incompatible input"), success])) as acquire,
        ):
            result = asyncio.run(acquire_cli._execute_async(args))
        self.assertEqual(result, (1, 1))
        self.assertEqual(acquire.await_count, 2)

        malformed = self.base / "malformed-batch.jsonl"
        malformed.write_text("{bad}\n" + entries[1].to_json_line() + "\n", encoding="utf-8")
        args.manifest = malformed
        with (
            mock.patch("sciretriever.cli.acquire._provider", return_value=StubProvider()),
            mock.patch.object(AcquisitionOrchestrator, "acquire", new=mock.AsyncMock(return_value=success)) as acquire,
        ):
            result = asyncio.run(acquire_cli._execute_async(args))
        self.assertEqual(result, (1, 1))
        acquire.assert_awaited_once()


if __name__ == "__main__":
    import unittest
    unittest.main()
