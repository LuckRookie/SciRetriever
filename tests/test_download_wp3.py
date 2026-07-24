import asyncio
from io import BytesIO
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import threading
import time
from unittest import TestCase

from PyPDF2 import PdfWriter

REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.acquisition.backfill import DownloadBackfillService
from sciretriever.acquisition.browser import BrowserRuleResolver
from sciretriever.acquisition.candidate_executor import CandidateExecutor
from sciretriever.acquisition.identity_validation import ContentIdentityValidator
from sciretriever.acquisition.candidates import RuntimeDownloadCandidate, make_download_candidate_id
from sciretriever.acquisition.models import AcquisitionTarget, ProviderContent
from sciretriever.acquisition.service import WorkVersionAcquisitionService
from sciretriever.acquisition.sci_hub import SciHubResolver
from sciretriever.acquisition.translator import TranslatorRuleResolver
from sciretriever.acquisition.providers_p5 import SpringerResolver
from sciretriever.catalog import (
    AssetRepository,
    AuthorRepository,
    LibraryFilters,
    RegistryRepository,
    TagRepository,
    WorkRepository,
    WorkVersionDownloadRepository,
    create_catalog_engine,
    initialize_catalog,
)
from sciretriever.core.enums import AssetRole
from sciretriever.config import BrowserRuleConfig, SciHubConfig, TranslatorRuleConfig
from sciretriever.network import HttpResponse
from sciretriever.storage import AssetAcceptanceCoordinator, RawAssetStore


def pdf_bytes(label: str = "wp3") -> bytes:
    stream = BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=72, height=72)
    writer.add_blank_page(width=72, height=72)
    writer.add_metadata({
        "/Title": "Catalysis Alpha accepted",
        "/Subject": label * 200,
    })
    writer.write(stream)
    return stream.getvalue()


class Transport:
    def __init__(self, responses):
        self.responses = responses
        self.calls = []
        self.lock = threading.Lock()

    def get(self, url, *, params=None, headers=None, timeout=None):
        del params, timeout
        with self.lock:
            self.calls.append((url, dict(headers or {})))
        delay, status, media_type, body = self.responses[url]
        time.sleep(delay)
        return HttpResponse(status, url, {"content-type": media_type}, body)

    def resolve_host(self, hostname):
        del hostname
        return ("192.0.2.1",)


class Resolver:
    def __init__(self, provider, urls_by_role, *, duplicate=False, secret=None):
        self.provider = provider
        self.resolver_id = provider
        self.urls_by_role = urls_by_role
        self.duplicate = duplicate
        self.secret = secret

    def resolve(self, target, role, *, timeout):
        del target, timeout
        candidates = []
        for index, url in enumerate(self.urls_by_role.get(role, ())):
            cursor = f"rc1:item-{index}"
            candidates.append(RuntimeDownloadCandidate(
                make_download_candidate_id(self.provider, self.resolver_id, role, cursor),
                self.provider, self.resolver_id, self.provider, cursor, url, role, index,
                "https", "resolver", f"host:{self.provider}-{index}.test",
                {"provider": self.provider},
                request_headers={} if self.secret is None else {"Authorization": self.secret},
                media_type_hint={
                    AssetRole.PRIMARY_PDF: "application/pdf",
                    AssetRole.XML: "application/xml",
                    AssetRole.HTML: "text/html",
                }[role],
            ))
        if self.duplicate and candidates:
            candidates.insert(1, candidates[0])
        return tuple(candidates)


class DownloadWp3Tests(TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.engine = create_catalog_engine(self.root / "catalog.sqlite")
        initialize_catalog(self.engine)
        self.addCleanup(self.engine.dispose)
        self.works = WorkRepository(self.engine)
        publisher = RegistryRepository(self.engine).add("publisher", "Example Press")
        venue = RegistryRepository(self.engine).add("venue", "Journal of Tests")
        self.first = self.works.ingest_version(
            provider="fixture", provider_record_id="one", title="Catalysis Alpha",
            doi="10.1000/alpha", publication_date="2024-01-02",
            publisher_id=publisher.id, venue_id=venue.id,
            metadata={"publication_year": 2024, "direct_url": "https://direct.test/alpha.pdf"},
        )
        self.second = self.works.ingest_version(
            provider="fixture", provider_record_id="two", title="Catalysis Alpha accepted",
            version_class="accepted_manuscript", publication_date="2023-01-02",
            publisher_id=publisher.id, venue_id=venue.id,
            related_work_version_id=self.first.id,
            relation_evidence={"provider": "fixture"},
        )
        self.works.set_preferred(self.first.work_id, self.second.id)
        AuthorRepository(self.engine).add_authorship(self.second.id, "Ada Lovelace", 0)
        tag = TagRepository(self.engine).add("kinetics")
        TagRepository(self.engine).add_manual(self.first.work_id, tag.id)
        self.repository = WorkVersionDownloadRepository(self.engine)
        self.assets = AssetRepository(self.engine)
        asset_root = self.root / "assets"
        asset_root.mkdir()
        self.coordinator = AssetAcceptanceCoordinator(self.assets, RawAssetStore(asset_root))

    def service(self, transport, resolvers, *, concurrency=4, translators=(), browsers=(), browser_runner=None):
        return WorkVersionAcquisitionService(
            self.assets, self.coordinator, resolvers, CandidateExecutor(
                transport, browser_runner=browser_runner,
                identity_validator=ContentIdentityValidator(),
            ),
            translator_resolvers=translators,
            browser_resolvers=browsers,
            provider_concurrency=concurrency,
        )

    def target(self, work_version_id, role=AssetRole.PRIMARY_PDF):
        record = self.repository.get(work_version_id)
        return AcquisitionTarget(record.identifiers, role=role, title=record.title)

    @staticmethod
    def translator(transport, name, host):
        return TranslatorRuleResolver(transport, TranslatorRuleConfig(
            name, f"https://{host}/article/{{doi}}", (), (),
        ))

    def test_exact_preferred_query_filters_tag_and_target(self):
        self.assertEqual(
            self.repository.select_exact(work_version_id=self.first.id).work_version_ids,
            (self.first.id,),
        )
        self.assertEqual(
            self.repository.select_exact(work_id=self.first.work_id).work_version_ids,
            (self.second.id,),
        )
        selected = self.repository.select_library(
            "accepted",
            filters=LibraryFilters(
                author="Ada Lovelace", publication_year=2023,
                publisher="Example Press", venue="Journal of Tests", tag="kinetics",
            ),
            limit=5,
        )
        self.assertEqual(selected.work_version_ids, (self.second.id,))
        record = self.repository.get(self.first.id)
        self.assertEqual(record.direct_url, "https://direct.test/alpha.pdf")
        self.assertEqual(record.identifiers[0].value, "10.1000/alpha")

    def test_provider_race_sequential_fallback_duplicate_and_cap(self):
        invalid = "https://one.test/invalid"
        valid = "https://one.test/valid"
        slow = "https://two.test/slow"
        extras = tuple(f"https://one.test/extra-{index}" for index in range(10))
        responses = {
            invalid: (0, 200, "application/pdf", b"bad"),
            valid: (0, 200, "application/pdf", pdf_bytes("winner")),
            slow: (0.2, 200, "application/pdf", pdf_bytes("slow")),
            **{url: (0, 200, "application/pdf", pdf_bytes("extra")) for url in extras},
        }
        transport = Transport(responses)
        one = Resolver("one", {AssetRole.PRIMARY_PDF: (invalid, valid, *extras)}, duplicate=True)
        two = Resolver("two", {AssetRole.PRIMARY_PDF: (slow,)})
        result = asyncio.run(self.service(transport, {"one": one, "two": two}).acquire(
            self.first.id, AssetRole.PRIMARY_PDF,
            self.target(self.first.id),
            ("one", "two"), timeout=1,
        ))
        self.assertEqual(result.status, "succeeded")
        called_urls = [url for url, _ in transport.calls]
        self.assertLess(called_urls.index(invalid), called_urls.index(valid))
        self.assertNotIn(extras[-1], called_urls)

    def test_wrong_article_falls_through_within_provider(self):
        wrong = "https://one.test/wrong"
        valid = "https://one.test/valid-identity"
        transport = Transport({
            wrong: (0, 200, "application/pdf", self._identity_pdf("Unrelated geological survey", "10.9999/wrong")),
            valid: (0, 200, "application/pdf", pdf_bytes("right")),
        })
        result = asyncio.run(self.service(
            transport, {"one": Resolver("one", {AssetRole.PRIMARY_PDF: (wrong, valid)})}
        ).acquire(self.first.id, AssetRole.PRIMARY_PDF, self.target(self.first.id), ("one",), timeout=1))
        self.assertEqual(result.status, "succeeded")
        self.assertEqual([url for url, _ in transport.calls], [wrong, valid])
        with self.engine.connect() as connection:
            details = connection.exec_driver_sql(
                "SELECT details_json FROM acquisition_diagnostics ORDER BY occurred_at DESC LIMIT 1"
            ).scalar_one()
        self.assertIn('"reason_code":"content_invalid"', details)
        self.assertNotIn("10.9999", details)
        self.assertNotIn("geological", details.casefold())

    def test_wrong_first_tier_falls_through_to_translator(self):
        wrong = "https://first.test/wrong.pdf"
        landing = "https://translator.test/article/10.1000%2Falpha"
        valid = "https://translator.test/right.pdf"
        transport = Transport({
            wrong: (0, 200, "application/pdf", self._identity_pdf("Unrelated geological survey", "10.9999/wrong")),
            landing: (0, 200, "text/html", f'<a href="{valid}">paper</a>'.encode()),
            valid: (0, 200, "application/pdf", pdf_bytes("translated")),
        })
        result = asyncio.run(self.service(
            transport,
            {"first": Resolver("first", {AssetRole.PRIMARY_PDF: (wrong,)})},
            translators=(self.translator(transport, "fallback", "translator.test"),),
        ).acquire(self.first.id, AssetRole.PRIMARY_PDF, self.target(self.first.id), ("first",), timeout=1))
        self.assertEqual(result.status, "succeeded")
        self.assertEqual([url for url, _ in transport.calls], [wrong, landing, valid])

    def test_unconfirmed_identity_never_reaches_acceptance(self):
        scanned = "https://one.test/scanned"
        transport = Transport({scanned: (0, 200, "application/pdf", self._identity_pdf(None, None))})
        result = asyncio.run(self.service(
            transport, {"one": Resolver("one", {AssetRole.PRIMARY_PDF: (scanned,)})}
        ).acquire(self.first.id, AssetRole.PRIMARY_PDF, self.target(self.first.id), ("one",), timeout=1))
        self.assertEqual(result.status, "failed")
        with self.engine.connect() as connection:
            self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM raw_assets").scalar_one(), 0)
            details = connection.exec_driver_sql("SELECT details_json FROM acquisition_diagnostics").scalar_one()
        self.assertIn('"reason_code":"content_invalid"', details)
        self.assertNotIn(scanned, details)

    @staticmethod
    def _identity_pdf(title, doi):
        stream = BytesIO()
        writer = PdfWriter()
        writer.add_blank_page(width=72, height=72)
        writer.add_blank_page(width=72, height=72)
        metadata = {"/Subject": "fixture" * 200}
        if title is not None:
            metadata["/Title"] = title
        if doi is not None:
            metadata["/Subject"] += f" doi: {doi}"
        writer.add_metadata(metadata)
        writer.write(stream)
        return stream.getvalue()

    def test_sci_hub_participates_in_provider_race_with_candidate_fallback(self):
        landing = "https://authorized.test/base/10.1000/alpha"
        invalid = "https://authorized.test/invalid.pdf"
        valid = "https://authorized.test/valid.pdf"
        slow = "https://other.test/slow.pdf"
        transport = Transport({
            landing: (0, 200, "text/html", (
                f'<meta name="citation_pdf_url" content="{invalid}">'
                f'<iframe src="{valid}"></iframe>'
            ).encode()),
            invalid: (0, 200, "application/pdf", b"bad"),
            valid: (0, 200, "application/pdf", pdf_bytes("sci-hub")),
            slow: (0.2, 200, "application/pdf", pdf_bytes("slow")),
        })
        sci_hub = SciHubResolver(
            transport, SciHubConfig(True, "https://authorized.test/base", ())
        )
        other = Resolver("other", {AssetRole.PRIMARY_PDF: (slow,)})
        result = asyncio.run(self.service(
            transport, {"sci-hub": sci_hub, "other": other}
        ).acquire(
            self.first.id,
            AssetRole.PRIMARY_PDF,
            self.target(self.first.id),
            ("sci-hub", "other"),
            timeout=1,
        ))
        self.assertEqual(result.status, "succeeded")
        called_urls = [url for url, _ in transport.calls]
        self.assertLess(called_urls.index(landing), called_urls.index(invalid))
        self.assertLess(called_urls.index(invalid), called_urls.index(valid))

    def test_first_tier_success_skips_translator(self):
        direct = "https://first.test/article.pdf"
        landing = "https://translator.test/article/10.1000%2Falpha"
        transport = Transport({
            direct: (0, 200, "application/pdf", pdf_bytes("first")),
            landing: (0, 200, "text/html", b'<a href="/translated.pdf">x</a>'),
        })
        translator = self.translator(transport, "one", "translator.test")
        result = asyncio.run(self.service(
            transport,
            {"first": Resolver("first", {AssetRole.PRIMARY_PDF: (direct,)})},
            translators=(translator,),
        ).acquire(
            self.first.id, AssetRole.PRIMARY_PDF,
            self.target(self.first.id),
            ("first",), timeout=1,
        ))
        self.assertEqual(result.status, "succeeded")
        self.assertNotIn(landing, [url for url, _ in transport.calls])

    def test_first_tier_exhaustion_runs_ordered_translators_with_executor_fallback(self):
        first_landing = "https://translator-one.test/article/10.1000%2Falpha"
        second_landing = "https://translator-two.test/article/10.1000%2Falpha"
        invalid = "https://translator-two.test/invalid.pdf"
        valid = "https://translator-two.test/valid.pdf"
        transport = Transport({
            first_landing: (0, 200, "text/html", b"<html>article not found</html>"),
            second_landing: (0, 200, "text/html", (
                f'<a href="{invalid}">bad</a><a href="{valid}">good</a>'
            ).encode()),
            invalid: (0, 200, "application/pdf", b"bad"),
            valid: (0, 200, "application/pdf", pdf_bytes("translated")),
        })
        translators = (
            self.translator(transport, "one", "translator-one.test"),
            self.translator(transport, "two", "translator-two.test"),
        )
        result = asyncio.run(self.service(
            transport, {"empty": Resolver("empty", {})}, translators=translators,
        ).acquire(
            self.first.id, AssetRole.PRIMARY_PDF,
            self.target(self.first.id),
            ("empty",), timeout=1,
        ))
        self.assertEqual(result.status, "succeeded")
        calls = [url for url, _ in transport.calls]
        self.assertLess(calls.index(first_landing), calls.index(second_landing))
        self.assertLess(calls.index(invalid), calls.index(valid))
        with self.engine.connect() as connection:
            details = connection.exec_driver_sql(
                "SELECT details_json FROM acquisition_diagnostics ORDER BY occurred_at DESC LIMIT 1"
            ).scalar_one()
        self.assertIn('"tier":"first"', details)
        self.assertIn('"tier":"translator"', details)
        self.assertNotIn(first_landing, details)

    def test_browser_is_third_tier_and_prior_success_short_circuits_it(self):
        browser = BrowserRuleResolver(BrowserRuleConfig(
            "publisher", "https://browser.test/article/{doi}",
            ("browser.test",), ("pdf.test",), ("browser.test", "pdf.test"),
        ))
        class Runner:
            def __init__(self):
                self.calls = 0
            def run(self, candidate, timeout, target):
                del timeout, target
                self.calls += 1
                return ProviderContent(
                    AssetRole.PRIMARY_PDF, "application/pdf", "pdf", "candidate://unsafe",
                    candidate.provider, pdf_bytes("browser"), {"secret_url": "https://secret.test/x"},
                )
        runner = Runner()
        target = self.target(self.first.id)
        result = asyncio.run(self.service(
            Transport({}), {"empty": Resolver("empty", {})},
            browsers=(browser,), browser_runner=runner,
        ).acquire(self.first.id, AssetRole.PRIMARY_PDF, target, ("empty",), timeout=1))
        self.assertEqual(result.status, "succeeded")
        self.assertEqual(runner.calls, 1)
        with self.engine.connect() as connection:
            details = connection.exec_driver_sql(
                "SELECT details_json FROM acquisition_diagnostics ORDER BY occurred_at DESC LIMIT 1"
            ).scalar_one()
        self.assertIn('"tier":"browser"', details)
        self.assertNotIn("secret.test", details)

        second_runner = Runner()
        direct = "https://first.test/second.pdf"
        result = asyncio.run(self.service(
            Transport({direct: (0, 200, "application/pdf", pdf_bytes("first"))}),
            {"first": Resolver("first", {AssetRole.PRIMARY_PDF: (direct,)})},
            browsers=(browser,), browser_runner=second_runner,
        ).acquire(self.second.id, AssetRole.PRIMARY_PDF,
                  self.target(self.second.id),
                  ("first",), timeout=1))
        self.assertEqual(result.status, "succeeded")
        self.assertEqual(second_runner.calls, 0)

    def test_all_tier_failure_is_missing_with_sanitized_diagnostics(self):
        landing = "https://translator-fail.test/article/10.1000%2Falpha"
        secret = "secret-query-value"
        transport = Transport({
            landing: (0, 200, "text/html", f'<a href="/paper.pdf?token={secret}">x</a>'.encode()),
            f"https://translator-fail.test/paper.pdf?token={secret}": (0, 200, "application/pdf", b"bad"),
        })
        result = asyncio.run(self.service(
            transport, {"empty": Resolver("empty", {})},
            translators=(self.translator(transport, "fail", "translator-fail.test"),),
        ).acquire(
            self.first.id, AssetRole.PRIMARY_PDF,
            self.target(self.first.id),
            ("empty",), timeout=1,
        ))
        self.assertEqual(result.status, "failed")
        self.assertEqual([item["tier"] for item in result.source_failures], ["first", "translator"])
        self.assertNotIn(secret, repr(result.source_failures))

    def test_all_missing_rerun_and_optional_roles(self):
        pdf = "https://roles.test/article.pdf"
        xml = "https://roles.test/article.xml"
        html = "https://roles.test/article.html"
        transport = Transport({
            pdf: (0, 200, "application/pdf", pdf_bytes()),
            xml: (0, 200, "application/xml", b"<article><article-title>Catalysis Alpha accepted</article-title><body>ok</body></article>"),
            html: (0, 200, "text/html", b"not html"),
        })
        resolver = Resolver("roles", {
            AssetRole.PRIMARY_PDF: (pdf,), AssetRole.XML: (xml,), AssetRole.HTML: (html,),
        })
        backfill = DownloadBackfillService(
            self.repository, self.service(transport, {"roles": resolver}), ("roles",),
            timeout=1, include_xml=True, include_html=True,
        )
        selected = self.repository.select_all_missing_primary_pdf().work_version_ids
        first = asyncio.run(backfill.run(selected))
        self.assertEqual((first.selected, first.accepted, first.reused, first.missing), (2, 2, 0, 0))
        self.assertTrue(any(item.failures for item in first.outcomes))
        for outcome in first.outcomes:
            self.assertEqual(dict(outcome.roles)["xml"], "succeeded")
            self.assertEqual(dict(outcome.roles)["html"], "failed")
        self.assertEqual(self.repository.select_all_missing_primary_pdf().work_version_ids, ())
        rerun = asyncio.run(backfill.run((self.first.id, self.second.id)))
        self.assertEqual((rerun.accepted, rerun.reused, rerun.missing), (0, 2, 0))

    def test_failure_diagnostics_redact_runtime_credentials(self):
        url = "https://secret.test/file"
        secret = "Bearer DO-NOT-EMIT"
        transport = Transport({url: (0, 200, "application/pdf", b"bad")})
        resolver = Resolver("secret", {AssetRole.PRIMARY_PDF: (url,)}, secret=secret)
        result = asyncio.run(self.service(transport, {"secret": resolver}).acquire(
            self.first.id, AssetRole.PRIMARY_PDF,
            AcquisitionTarget((), role=AssetRole.PRIMARY_PDF), ("secret",), timeout=1,
        ))
        self.assertEqual(result.status, "failed")
        with self.engine.connect() as connection:
            details = connection.exec_driver_sql(
                "SELECT details_json FROM acquisition_diagnostics ORDER BY occurred_at DESC LIMIT 1"
            ).scalar_one()
        self.assertNotIn(secret, details)
        self.assertNotIn(url, details)

    def test_springer_xml_keeps_api_key_out_of_candidate_url_and_repr(self):
        secret = "SPRINGER-DO-NOT-EMIT"
        candidate = SpringerResolver(Transport({}), secret).resolve(
            AcquisitionTarget(self.repository.get(self.first.id).identifiers),
            AssetRole.XML,
            timeout=1,
        )[0]
        self.assertNotIn(secret, candidate.execution_url)
        self.assertNotIn(secret, repr(candidate))
        self.assertEqual(candidate.request_params, {"api_key": secret})

    def test_cancellation_retains_completed_and_counts_interrupted(self):
        fast = "https://stop.test/fast"
        slow = "https://stop.test/slow"
        transport = Transport({
            fast: (0, 200, "application/pdf", pdf_bytes("fast")),
            slow: (1, 200, "application/pdf", pdf_bytes("slow")),
        })

        class PerTargetResolver(Resolver):
            def resolve(self, target, role, *, timeout):
                self.urls_by_role = {AssetRole.PRIMARY_PDF: (
                    fast if any(item.value == "10.1000/alpha" for item in target.identifiers) else slow,
                )}
                return super().resolve(target, role, timeout=timeout)

        resolver = PerTargetResolver("stop", {})
        backfill = DownloadBackfillService(
            self.repository, self.service(transport, {"stop": resolver}), ("stop",), timeout=2,
        )

        async def cancel():
            task = asyncio.create_task(backfill.run((self.first.id, self.second.id)))
            await asyncio.sleep(0.1)
            task.cancel()
            return await task

        result = asyncio.run(cancel())
        self.assertEqual(result.selected, 2)
        self.assertEqual(result.accepted, 1)
        self.assertEqual(result.interrupted, 1)


if __name__ == "__main__":
    import unittest
    unittest.main()
