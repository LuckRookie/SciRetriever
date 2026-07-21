import argparse
import asyncio
from importlib import import_module
from io import BytesIO
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import threading
import time
from unittest import TestCase, mock

REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sqlalchemy import select

from sciretriever.acquisition import AcquisitionTarget, AdmissionService, HttpResponse, ProviderContent
from sciretriever.acquisition.attempt_details import CandidateAttemptDetails
from sciretriever.acquisition.controls import CircuitBreaker, CircuitState, HostBudget, HostBudgetManager, ProviderHealth, RetryPolicy
from sciretriever.acquisition.multi_orchestrator import MultiSourceOrchestrator
from sciretriever.acquisition.plan import RoutingMode, SourceEntry, SourcePlan
from sciretriever.acquisition.profiles import PUBLISHER_PROFILES, PublisherProfile
from sciretriever.acquisition.providers import ProviderAcquisitionError
from sciretriever.acquisition.providers_p5 import ElsevierProvider, OpenAlexProvider, SemanticScholarProvider, SpringerProvider, WileyProvider
from sciretriever.acquisition.routing import resume_candidates, tiers
from sciretriever.acquisition.orchestrator import AcquisitionRuntime
from sciretriever.acquisition.transport import UrllibAcquisitionTransport
from sciretriever.acquisition.url_policy import UrlPolicy
from sciretriever.acquisition.validation import validate_content
from sciretriever.catalog import AssetRepository, IdentityResolver, JobRepository, apply_migrations, create_catalog_engine
from sciretriever.catalog.models import acquisition_attempts, acquisition_jobs, events, failures
from sciretriever.catalog.records import AttemptRecord
from sciretriever.cli import acquire as acquire_cli
from sciretriever.core.contracts import Identifier
from sciretriever.core.enums import AssetRole, AttemptOutcome, JobState
from sciretriever.errors import AcquisitionError, ValidationError
from sciretriever.network import url_with_params
from sciretriever.storage import AssetAcceptanceCoordinator, RawAssetStore


def pdf_bytes(pages=2):
    stream = BytesIO()
    writer = import_module("PyPDF2").PdfWriter()
    for _ in range(pages):
        writer.add_blank_page(width=72, height=72)
    writer.add_metadata({"/Subject": "article" * 400})
    writer.write(stream)
    return stream.getvalue()


class FakeTransport:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def resolve_host(self, hostname):
        return ("93.184.216.34",)

    def get(self, url, *, params=None, headers=None, timeout=None):
        self.calls.append((url_with_params(url, params), dict(headers or {})))
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


class FakeDialResponse:
    def __init__(self, status, headers, body):
        self.status = status
        self.headers = headers
        self.body = BytesIO(body)

    def getheaders(self):
        return list(self.headers.items())

    def read(self, n=-1):
        return self.body.read(n)

    def close(self):
        self.body.close()


class FakeDialer:
    def __init__(self, responses):
        self.responses = list(responses)
        self.headers = []
        self.targets = []

    def get(self, hostname, address, port, target, *, timeout, headers):
        self.headers.append(dict(headers))
        self.targets.append(target)
        return self.responses.pop(0)


def response(url, body, media_type="application/pdf", status=200):
    return HttpResponse(status, url, {"content-type": media_type}, body)


def attempt_details(candidate_id, sequence, outcome=None):
    return json.dumps(
        CandidateAttemptDetails(candidate_id, sequence, outcome=outcome).to_dict(),
        sort_keys=True,
        separators=(",", ":"),
    )


class FakeProvider:
    def __init__(self, name, outcomes, *, delay=0.0, role=AssetRole.PRIMARY_PDF, media_type="application/pdf", format="pdf", finished_event=None):
        self.name = name
        self.outcomes = list(outcomes)
        self.delay = delay
        self.role = role
        self.media_type = media_type
        self.format = format
        self.finished_event = finished_event
        self.calls = 0

    def initial_url(self, target):
        return f"https://{self.name}.example/item"

    def acquire(self, target, *, timeout):
        self.calls += 1
        try:
            if self.delay:
                time.sleep(self.delay)
            outcome = self.outcomes.pop(0)
            if isinstance(outcome, Exception):
                raise outcome
            return ProviderContent(target.role, self.media_type, self.format, f"https://{self.name}.example/final", self.name, outcome)
        finally:
            if self.finished_event is not None:
                self.finished_event.set()


class P5Tests(TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.storage = self.base / "storage"
        self.storage.mkdir()
        self.catalog = create_catalog_engine(self.base / "catalog.sqlite")
        self.addCleanup(self.catalog.dispose)
        apply_migrations(self.catalog)
        self.assets = AssetRepository(self.catalog)
        self.jobs = JobRepository(self.catalog)
        self.identity = IdentityResolver(self.catalog)
        self.admission = AdmissionService(self.identity, self.jobs, self.assets)
        self.coordinator = AssetAcceptanceCoordinator(self.assets, RawAssetStore(self.storage))

    @staticmethod
    def plan(mode=RoutingMode.SERIAL, role=AssetRole.PRIMARY_PDF, names=("first", "second")):
        return SourcePlan(role, mode, tuple(SourceEntry(f"candidate_{index}", name, index) for index, name in enumerate(names)))

    def admit(self, identifiers, plan):
        return self.admission.admit(identifiers, provider="multi-source", asset_role=plan.role, source_plan=plan)

    def test_source_plan_is_strict_canonical_and_credential_free(self):
        plan = self.plan()
        self.assertEqual(SourcePlan.from_json(plan.to_json()), plan)
        self.assertEqual(plan.entries, tuple(sorted(plan.entries, key=lambda item: (item.tier, item.priority, item.candidate_id))))
        with self.assertRaises(ValueError):
            SourceEntry("bad", "provider", 0, config_refs=("api_key",))
        with self.assertRaises(ValueError):
            SourcePlan.from_json(json.dumps(plan.to_dict()))
        with self.assertRaises(ValueError):
            SourcePlan(AssetRole.PRIMARY_PDF, RoutingMode.SERIAL, tuple(reversed(plan.entries)))

    def test_repository_sets_plan_once_and_lists_due_resume_state(self):
        identifiers = (Identifier("doi", "10.1/plan"),)
        plan = self.plan(names=("first",))
        admission = self.admit(identifiers, plan)
        job = self.jobs.set_source_plan_if_absent(admission.job_id, plan.to_json())
        self.assertEqual(job.source_plan_json, plan.to_json())
        self.assertEqual(self.jobs.get_resume_state(job.id).job, job)
        self.assertEqual(self.jobs.list_due_retryable_jobs("2026-07-20T00:00:00.000Z"), ())
        with self.assertRaises(Exception):
            self.jobs.set_source_plan_if_absent(job.id, self.plan(names=("other",)).to_json())

    def test_pure_resume_skips_terminal_candidates_and_waits_for_retry(self):
        plan = self.plan(names=("first", "second", "third"))
        stamp = "2026-07-20T00:00:00.000Z"
        attempts = (
            AttemptRecord("00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000010", "first", AttemptOutcome.FAILED, None, attempt_details("candidate_0", 1, AttemptOutcome.FAILED), stamp, stamp),
            AttemptRecord("00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000010", "second", AttemptOutcome.RETRYABLE, None, attempt_details("candidate_1", 2, AttemptOutcome.RETRYABLE), stamp, stamp),
        )
        waiting = resume_candidates(plan, attempts, retry_due=False)
        self.assertEqual(tuple(item.provider for item in waiting.runnable), ("third",))
        self.assertTrue(waiting.waiting_for_retry)
        due = resume_candidates(plan, attempts, retry_due=True)
        self.assertEqual(tuple(item.provider for item in due.runnable), ("second", "third"))
        self.assertEqual(len(tiers(due.runnable)), 1)

    def test_resume_uses_attempt_sequence_not_timestamp_or_uuid_order(self):
        plan = self.plan(names=("first", "second"))
        stamp = "2026-07-20T00:00:00.000Z"
        attempts = (
            AttemptRecord("00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000010", "first", AttemptOutcome.RETRYABLE, None, attempt_details("candidate_0", 4, AttemptOutcome.RETRYABLE), stamp, stamp),
            AttemptRecord("ffffffff-ffff-4fff-8fff-ffffffffffff", "00000000-0000-4000-8000-000000000010", "first", AttemptOutcome.FAILED, None, attempt_details("candidate_0", 3, AttemptOutcome.FAILED), stamp, stamp),
            AttemptRecord("00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000010", "second", AttemptOutcome.SUCCEEDED, None, attempt_details("candidate_1", 2, AttemptOutcome.SUCCEEDED), stamp, stamp),
        )
        forward = resume_candidates(plan, attempts, retry_due=True)
        reverse = resume_candidates(plan, tuple(reversed(attempts)), retry_due=True)
        self.assertEqual(forward, reverse)
        self.assertEqual(tuple(entry.provider for entry in forward.runnable), ("first",))
        self.assertEqual(tuple(entry.provider for entry in forward.skipped), ("second",))

    def test_host_budget_health_circuit_and_retry_are_deterministic(self):
        clock = [0.0]
        sleeps = []

        async def sleep(delay):
            sleeps.append(delay)
            clock[0] += delay

        manager = HostBudgetManager(HostBudget(1, 2.0), monotonic=lambda: clock[0], sleep=sleep)

        async def budget_run():
            async with manager.acquire("example.test"):
                pass
            async with manager.acquire("example.test"):
                pass

        asyncio.run(budget_run())
        self.assertEqual(sleeps, [2.0])

        health = ProviderHealth(alpha=1.0)
        entries = self.plan().entries
        health.record("first", succeeded=False, latency=1.0)
        health.record("second", succeeded=True, latency=2.0)
        self.assertEqual(health.order(entries)[0].provider, "second")

        breaker = CircuitBreaker(2, 5.0, clock=lambda: clock[0])
        breaker.record_failure("host")
        breaker.record_failure("host")
        self.assertEqual(breaker.state("host"), CircuitState.OPEN)
        self.assertFalse(breaker.allow("host"))
        clock[0] += 5.0
        self.assertTrue(breaker.allow("host"))
        self.assertEqual(breaker.state("host"), CircuitState.HALF_OPEN)
        breaker.record_success("host")
        self.assertEqual(breaker.state("host"), CircuitState.CLOSED)

        retry = RetryPolicy(2.0, 5.0, jitter=0)
        self.assertEqual([retry.delay(index) for index in (1, 2, 3)], [2.0, 4.0, 5.0])
        self.assertEqual(retry.next_retry_at("2026-07-20T00:00:00.000Z", 2), "2026-07-20T00:00:04.000Z")

    def test_profiles_are_declarative_and_match(self):
        self.assertEqual({profile.provider for profile in PUBLISHER_PROFILES}, {"elsevier", "wiley", "springer"})
        self.assertTrue(next(profile for profile in PUBLISHER_PROFILES if profile.provider == "elsevier").matches(doi="10.1016/example"))
        for profile in PUBLISHER_PROFILES:
            encoded = repr(profile)
            self.assertNotIn("password=", encoded.lower())
            self.assertTrue(all(template.startswith("https://") for template in profile.endpoint_templates))

    def test_cli_parses_provider_plans_roles_budgets_and_resume_controls(self):
        parser = argparse.ArgumentParser()
        acquire_cli.configure_parser(parser)
        args = parser.parse_args([
            "--doi", "10.1/cli", "--providers", "openalex", "--providers", "semantic-scholar",
            "--routing", "race", "--asset-role", "primary_pdf", "--host-concurrency", "3",
            "--host-min-interval", "0.5", "--catalog", str(self.base / "catalog.sqlite"),
            "--storage-root", str(self.storage),
        ])
        acquire_cli.validate_arguments(parser, args)
        plan = acquire_cli._load_source_plan(args)
        self.assertIsNotNone(plan)
        self.assertEqual(plan.mode, RoutingMode.RACE)
        self.assertEqual(tuple(entry.provider for entry in plan.entries), ("openalex", "semantic-scholar"))
        self.assertEqual((args.host_concurrency, args.host_min_interval), (3, 0.5))

        plan_path = self.base / "source-plan.json"
        expected = self.plan(role=AssetRole.XML, names=("springer",))
        plan_path.write_text(expected.to_json(), encoding="utf-8")
        plan_args = parser.parse_args([
            "--doi", "10.1007/cli", "--source-plan", str(plan_path), "--asset-role", "xml",
            "--catalog", str(self.base / "catalog.sqlite"), "--storage-root", str(self.storage),
        ])
        acquire_cli.validate_arguments(parser, plan_args)
        self.assertEqual(acquire_cli._load_source_plan(plan_args), expected)

        resume_args = parser.parse_args([
            "--resume-job", "00000000-0000-4000-8000-000000000001",
            "--catalog", str(self.base / "catalog.sqlite"), "--storage-root", str(self.storage),
        ])
        acquire_cli.validate_arguments(parser, resume_args)

        p4_admission = self.admission.admit((Identifier("doi", "10.1/p4-resume"),), provider="crossref")
        self.assertIsNotNone(p4_admission.job_id)
        p4_job_id = p4_admission.job_id
        assert p4_job_id is not None
        p4_resume_args = parser.parse_args([
            "--resume-job", p4_job_id, "--catalog", str(self.base / "catalog.sqlite"),
            "--storage-root", str(self.storage),
        ])
        self.assertEqual(asyncio.run(acquire_cli._execute_async(p4_resume_args)), (0, 1))

    def test_role_validators_keep_pdf_si_xml_html_independent(self):
        validate_content(ProviderContent(AssetRole.SUPPLEMENTARY_PDF, "application/pdf", "pdf", "https://x", "fake", pdf_bytes(1)), AssetRole.SUPPLEMENTARY_PDF)
        xml = ProviderContent(AssetRole.XML, "application/xml", "xml", "https://x", "fake", b"<article><body>evidence</body></article>")
        html = ProviderContent(AssetRole.HTML, "text/html", "html", "https://x", "fake", b"<html><body><article>evidence content for a complete scientific article page</article></body></html>")
        validate_content(xml, AssetRole.XML)
        validate_content(html, AssetRole.HTML)
        with self.assertRaises(ValidationError):
            validate_content(xml, AssetRole.PRIMARY_PDF)
        with self.assertRaises(ValidationError):
            validate_content(ProviderContent(AssetRole.XML, "text/html", "xml", "https://x", "fake", b"<html><body>x</body></html>"), AssetRole.XML)

    def test_openalex_and_semantic_scholar_resolve_public_pdf_fields(self):
        pdf = pdf_bytes()
        openalex_transport = FakeTransport([
            response(
                "https://api.openalex.org/work",
                b'{"open_access":{"oa_url":"https://landing.example/article"},"best_oa_location":{"landing_page_url":"https://landing.example/best"},"locations":[{"pdf_url":"https://files.example/openalex.pdf"}]}',
                "application/json",
            ),
            response("https://files.example/openalex.pdf", pdf),
        ])
        target = AcquisitionTarget((Identifier("doi", "10.1/oa"),))
        openalex_provider = OpenAlexProvider(openalex_transport)
        default_timeout = openalex_provider._client._default_timeout
        self.assertEqual(openalex_provider.acquire(target, timeout=1).data, pdf)
        self.assertEqual(
            openalex_transport.calls[1][0], "https://files.example/openalex.pdf"
        )
        self.assertEqual(openalex_provider._client._default_timeout, default_timeout)
        self.assertFalse(hasattr(openalex_provider._client, "timeout"))
        semantic_transport = FakeTransport([
            response("https://api.semanticscholar.org/paper", b'{"openAccessPdf":{"url":"https://files.example/s2.pdf"}}', "application/json"),
            response("https://files.example/s2.pdf", pdf),
        ])
        self.assertEqual(SemanticScholarProvider(semantic_transport, "optional-key").acquire(target, timeout=1).data, pdf)
        self.assertEqual(semantic_transport.calls[0][1], {"x-api-key": "optional-key"})

    def test_publisher_adapters_are_credential_gated_and_role_specific(self):
        target = AcquisitionTarget((Identifier("doi", "10.1016/test"),))
        with self.assertRaises(AcquisitionError):
            ElsevierProvider(FakeTransport([]), None)
        xml = b'<article xmlns:x="urn:elsevier"><object attachment-type="supplementary mmc"><x:attachment-eid>1-s2.0-SUPP-mmc1.pdf</x:attachment-eid></object><object attachment-type="main full-text" page-count="12"><x:object-eid>1-s2.0-MAIN-main.pdf</x:object-eid></object></article>'
        transport = FakeTransport([response("https://api.elsevier.com/article", xml, "application/xml"), response("https://api.elsevier.com/object", pdf_bytes())])
        content = ElsevierProvider(transport, "elsevier-secret").acquire(target, timeout=1)
        self.assertEqual(content.role, AssetRole.PRIMARY_PDF)
        self.assertEqual(transport.calls[0][1]["X-ELS-APIKey"], "elsevier-secret")
        self.assertIn("1-s2.0-MAIN-main.pdf", transport.calls[1][0])

        si_transport = FakeTransport([response("https://api.elsevier.com/article", xml, "application/xml"), response("https://api.elsevier.com/object", pdf_bytes(1))])
        si = ElsevierProvider(si_transport, "key").acquire(AcquisitionTarget(target.identifiers, role=AssetRole.SUPPLEMENTARY_PDF), timeout=1)
        self.assertEqual(si.role, AssetRole.SUPPLEMENTARY_PDF)
        self.assertIn("1-s2.0-SUPP-mmc1.pdf", si_transport.calls[1][0])

        converted_xml = b'<article xmlns:dc="urn:dc"><dc:identifier>eid:1-s2.0-S123456789</dc:identifier></article>'
        converted_transport = FakeTransport([response("https://api.elsevier.com/article", converted_xml, "application/xml"), response("https://api.elsevier.com/object", pdf_bytes())])
        ElsevierProvider(converted_transport, "key").acquire(target, timeout=1)
        self.assertIn("1-s2.0-S123456789-main.pdf", converted_transport.calls[1][0])

        wiley_transport = FakeTransport([response("https://api.wiley.com/article", pdf_bytes())])
        WileyProvider(wiley_transport, "wiley-secret").acquire(AcquisitionTarget((Identifier("doi", "10.1002/test"),)), timeout=1)
        self.assertIn("Wiley-TDM-Client-Token", wiley_transport.calls[0][1])

        springer_transport = FakeTransport([response("https://api.springernature.com/xmldata/jats?q=doi%3A10.1007%2Ftest&api_key=springer-secret", b"<article><body>content</body></article>", "application/jats+xml")])
        springer_provider = SpringerProvider(springer_transport, "springer-secret")
        springer_target = AcquisitionTarget((Identifier("doi", "10.1007/test"),), role=AssetRole.XML)
        springer = springer_provider.acquire(springer_target, timeout=1)
        self.assertEqual(springer.role, AssetRole.XML)
        self.assertIn("/xmldata/jats?", springer_transport.calls[0][0])
        self.assertIn("api_key=springer-secret", springer_transport.calls[0][0])
        self.assertNotIn("springer-secret", springer_provider.initial_url(springer_target))
        self.assertNotIn("springer-secret", springer.source_url)

    def test_multi_provider_registry_fails_on_missing_publisher_credentials(self):
        policy = UrlPolicy()
        for provider_name in ("elsevier", "wiley", "springer"):
            with self.subTest(provider=provider_name):
                transport = FakeTransport([])
                with (
                    mock.patch(
                        "sciretriever.cli.acquire._credential", return_value=None
                    ),
                    self.assertRaises(AcquisitionError) as raised,
                ):
                    acquire_cli._provider_registry(
                        (provider_name, "crossref"), transport, policy
                    )
                self.assertIn("requires configured credentials", str(raised.exception))
                self.assertEqual(transport.calls, [])

    def test_cli_maps_missing_multi_provider_credential_without_fallback_network(self):
        parser = argparse.ArgumentParser()
        acquire_cli.configure_parser(parser)
        args = parser.parse_args(
            [
                "--doi",
                "10.1016/missing-key",
                "--providers",
                "crossref",
                "--providers",
                "elsevier",
                "--catalog",
                str(self.base / "catalog.sqlite"),
                "--storage-root",
                str(self.storage),
            ]
        )
        acquire_cli.validate_arguments(parser, args)
        transport = FakeTransport([])
        with (
            mock.patch("sciretriever.cli.acquire._credential", return_value=None),
            mock.patch(
                "sciretriever.cli.acquire.UrllibAcquisitionTransport",
                return_value=transport,
            ),
            mock.patch("builtins.print") as printer,
        ):
            code = acquire_cli.run(args)
        self.assertEqual(code, 1)
        self.assertIn("requires configured credentials", printer.call_args.args[0])
        self.assertEqual(transport.calls, [])

    def test_injected_publisher_profiles_drive_endpoints_roles_media_and_credentials(self):
        credential_env = "SCIRETRIEVER_CUSTOM_API_KEY"
        wiley_profile = PublisherProfile(
            name="Custom Wiley",
            provider="wiley",
            hosts=("wiley-profile.example",),
            doi_prefixes=("10.5555/",),
            supported_roles=(AssetRole.XML,),
            endpoint_templates=("https://wiley-profile.example/content/{doi}",),
            media_types=("application/custom+xml",),
            budget=HostBudget(7, 0.75),
            credential_env=credential_env,
        )
        wiley_transport = FakeTransport([
            response(
                "https://wiley-profile.example/content/10.5555%2Fprofile",
                b"<article><body>profile content</body></article>",
                "application/custom+xml",
            )
        ])
        wiley = WileyProvider(wiley_transport, "secret", profile=wiley_profile)
        xml_target = AcquisitionTarget(
            (Identifier("doi", "10.5555/profile"),),
            role=AssetRole.XML,
        )
        self.assertEqual(wiley.acquire(xml_target, timeout=1).role, AssetRole.XML)
        self.assertEqual(wiley_transport.calls[0][0], "https://wiley-profile.example/content/10.5555%2Fprofile")
        self.assertEqual(wiley.profile.budget, HostBudget(7, 0.75))
        with self.assertRaisesRegex(AcquisitionError, "does not support primary_pdf"):
            wiley.initial_url(AcquisitionTarget(xml_target.identifiers))

        rejected_media = WileyProvider(
            FakeTransport([response("https://wiley-profile.example/content/x", pdf_bytes())]),
            "secret",
            profile=wiley_profile,
        )
        with self.assertRaisesRegex(ProviderAcquisitionError, "rejects media type"):
            rejected_media.acquire(xml_target, timeout=1)

        elsevier_profile = PublisherProfile(
            name="Custom Elsevier",
            provider="elsevier",
            hosts=("elsevier-profile.example",),
            doi_prefixes=("10.5556/",),
            supported_roles=(AssetRole.XML,),
            endpoint_templates=(
                "https://elsevier-profile.example/article/{doi}",
                "https://elsevier-profile.example/object/{eid}",
            ),
            media_types=("application/custom+xml",),
            budget=HostBudget(3, 0.5),
            credential_env=credential_env,
        )
        elsevier_transport = FakeTransport([
            response(
                "https://elsevier-profile.example/article/10.5556%2Fprofile",
                b"<article><body>profile content</body></article>",
                "application/custom+xml",
            )
        ])
        elsevier = ElsevierProvider(elsevier_transport, "secret", profile=elsevier_profile)
        elsevier.acquire(
            AcquisitionTarget((Identifier("doi", "10.5556/profile"),), role=AssetRole.XML),
            timeout=1,
        )
        self.assertEqual(elsevier_transport.calls[0][0], "https://elsevier-profile.example/article/10.5556%2Fprofile")

        springer_profile = PublisherProfile(
            name="Custom Springer",
            provider="springer",
            hosts=("springer-profile.example",),
            doi_prefixes=("10.5557/",),
            supported_roles=(AssetRole.XML,),
            endpoint_templates=(
                "https://springer-profile.example/meta?{query}",
                "https://springer-profile.example/xml?{query}",
            ),
            media_types=("application/custom+xml",),
            budget=HostBudget(4, 0.25),
            credential_env=credential_env,
        )
        springer_transport = FakeTransport([
            response(
                "https://springer-profile.example/xml?q=doi%3A10.5557%2Fprofile&api_key=secret",
                b"<article><body>profile content</body></article>",
                "application/custom+xml",
            )
        ])
        springer = SpringerProvider(springer_transport, "secret", profile=springer_profile)
        springer.acquire(
            AcquisitionTarget((Identifier("doi", "10.5557/profile"),), role=AssetRole.XML),
            timeout=1,
        )
        self.assertIn("springer-profile.example/xml?", springer_transport.calls[0][0])

        with (
            mock.patch("sciretriever.cli.acquire.profile_for_provider", return_value=wiley_profile),
            mock.patch("sciretriever.cli.acquire.get_credential", return_value="secret") as credential,
        ):
            constructed = acquire_cli._provider(
                "wiley",
                UrllibAcquisitionTransport(UrlPolicy()),
                UrlPolicy(),
            )
        credential.assert_called_once_with(credential_env)
        if not isinstance(constructed, WileyProvider):
            self.fail("CLI did not construct the profile-backed Wiley provider")
        self.assertIs(constructed.profile, wiley_profile)
        provider_source = (SRC / "sciretriever" / "acquisition" / "providers_p5.py").read_text(encoding="utf-8")
        for duplicated_host in ("api.wiley.com", "api.elsevier.com", "api.springernature.com"):
            self.assertNotIn(duplicated_host, provider_source)

    def test_cross_origin_redirect_strips_sensitive_headers_only(self):
        dialer = FakeDialer([
            FakeDialResponse(302, {"location": "https://cdn.example/final"}, b""),
            FakeDialResponse(200, {"content-type": "application/pdf"}, pdf_bytes()),
        ])
        transport = UrllibAcquisitionTransport(resolver=lambda hostname: ("93.184.216.34",), dialer=dialer)
        transport.get(
            "https://api.example/start",
            params={"query": "a value", "limit": 2},
            timeout=1,
            headers={
                "Accept": "application/pdf",
                "Authorization": "Bearer secret",
                "Cookie": "session=secret",
                "X-ELS-APIKey": "elsevier-secret",
                "X-Api-Key": "springer-secret",
                "Wiley-TDM-Client-Token": "wiley-secret",
            },
        )
        self.assertIn("Authorization", dialer.headers[0])
        self.assertEqual(dialer.targets[0], "/start?query=a+value&limit=2")
        self.assertEqual(dialer.targets[1], "/final")
        self.assertEqual(dialer.headers[1], {"User-Agent": "SciRetriever/2", "Accept": "application/pdf"})

    def test_serial_fallback_records_every_attempt_and_accepts_second(self):
        identifiers = (Identifier("doi", "10.1/serial"),)
        plan = self.plan(RoutingMode.SERIAL)
        admission = self.admit(identifiers, plan)
        first = FakeProvider("first", [ProviderAcquisitionError.for_status("first", 404)])
        second = FakeProvider("second", [pdf_bytes()])
        result = asyncio.run(MultiSourceOrchestrator(self.jobs, self.coordinator, {"first": first, "second": second}).acquire(admission, AcquisitionTarget(identifiers), plan, timeout=1))
        self.assertEqual(result.status, "succeeded")
        attempts = self.jobs.list_attempts(admission.job_id)
        self.assertEqual(tuple(attempt.outcome for attempt in attempts), (AttemptOutcome.FAILED, AttemptOutcome.SUCCEEDED))
        self.assertEqual(self.jobs.get_job(admission.job_id).state, JobState.SUCCEEDED)

    def test_race_first_valid_wins_and_loser_drains_cancelled(self):
        identifiers = (Identifier("doi", "10.1/race"),)
        plan = self.plan(RoutingMode.RACE, names=("slow", "fast"))
        admission = self.admit(identifiers, plan)
        slow_finished = threading.Event()
        slow = FakeProvider("slow", [pdf_bytes()], delay=0.2, finished_event=slow_finished)
        fast = FakeProvider("fast", [pdf_bytes()], delay=0.005)
        async def run_race():
            started = time.monotonic()
            result = await MultiSourceOrchestrator(self.jobs, self.coordinator, {"slow": slow, "fast": fast}).acquire(admission, AcquisitionTarget(identifiers), plan, timeout=1)
            return result, time.monotonic() - started

        result, elapsed = asyncio.run(run_race())
        self.assertEqual(result.status, "succeeded")
        outcomes = {attempt.provider: attempt.outcome for attempt in self.jobs.list_attempts(admission.job_id)}
        self.assertEqual(outcomes["fast"], AttemptOutcome.SUCCEEDED)
        self.assertEqual(outcomes["slow"], AttemptOutcome.CANCELLED)
        self.assertEqual((slow.calls, fast.calls), (1, 1))
        self.assertEqual(len(self.assets.get_work_assets(admission.work_id)), 1)
        self.assertTrue(slow_finished.is_set())
        self.assertGreaterEqual(elapsed, 0.18)

    def test_race_drains_timed_out_thread_worker_before_return(self):
        identifiers = (Identifier("doi", "10.1/race-timeout-drain"),)
        plan = self.plan(RoutingMode.RACE, names=("slow", "fast"))
        admission = self.admit(identifiers, plan)
        slow_finished = threading.Event()
        slow = FakeProvider("slow", [pdf_bytes()], delay=0.1, finished_event=slow_finished)
        fast = FakeProvider("fast", [pdf_bytes()], delay=0.005)
        result = asyncio.run(MultiSourceOrchestrator(self.jobs, self.coordinator, {"slow": slow, "fast": fast}).acquire(admission, AcquisitionTarget(identifiers), plan, timeout=0.02))
        self.assertEqual(result.status, "succeeded")
        self.assertTrue(slow_finished.is_set())
        outcomes = {attempt.provider: attempt.outcome for attempt in self.jobs.list_attempts(admission.job_id)}
        self.assertEqual(outcomes, {"slow": AttemptOutcome.RETRYABLE, "fast": AttemptOutcome.SUCCEEDED})

    def test_mixed_serial_exhaustion_uses_state_compatible_closer_in_both_orders(self):
        for index, names in enumerate((("temporary", "definitive"), ("definitive", "temporary"))):
            identifiers = (Identifier("doi", f"10.1/mixed-exhaustion-{index}"),)
            plan = self.plan(RoutingMode.SERIAL, names=names)
            admission = self.admit(identifiers, plan)
            providers = {
                "temporary": FakeProvider("temporary", [TimeoutError("temporary")]),
                "definitive": FakeProvider(
                    "definitive",
                    [ProviderAcquisitionError.for_status("definitive", 404)],
                ),
            }
            with mock.patch.object(
                self.jobs,
                "finish_attempt_and_job",
                wraps=self.jobs.finish_attempt_and_job,
            ) as finish:
                result = asyncio.run(
                    MultiSourceOrchestrator(self.jobs, self.coordinator, providers).acquire(
                        admission,
                        AcquisitionTarget(identifiers),
                        plan,
                        timeout=1,
                    )
                )
            self.assertEqual(result.status, JobState.RETRYABLE.value)
            attempts = self.jobs.list_attempts(admission.job_id)
            outcomes = {attempt.provider: attempt.outcome for attempt in attempts}
            self.assertEqual(outcomes, {"temporary": AttemptOutcome.RETRYABLE, "definitive": AttemptOutcome.FAILED})
            closures = [call for call in finish.call_args_list if call.args[2] is not None]
            self.assertEqual(len(closures), 1)
            self.assertEqual(closures[0].args[1:3], (AttemptOutcome.RETRYABLE, JobState.RETRYABLE))
            self.assertEqual(closures[0].args[0], next(attempt.id for attempt in attempts if attempt.provider == "temporary"))
            self.assertEqual(self.jobs.get_job(admission.job_id).state, JobState.RETRYABLE)

    def test_failed_exhaustion_uses_highest_sequence_failed_closer(self):
        identifiers = (Identifier("doi", "10.1/failed-closer"),)
        plan = self.plan(RoutingMode.SERIAL, names=("first", "second"))
        admission = self.admit(identifiers, plan)
        providers = {
            name: FakeProvider(name, [ProviderAcquisitionError.for_status(name, 404)])
            for name in ("first", "second")
        }
        with mock.patch.object(
            self.jobs,
            "finish_attempt_and_job",
            wraps=self.jobs.finish_attempt_and_job,
        ) as finish:
            result = asyncio.run(
                MultiSourceOrchestrator(self.jobs, self.coordinator, providers).acquire(
                    admission,
                    AcquisitionTarget(identifiers),
                    plan,
                    timeout=1,
                )
            )
        attempts = self.jobs.list_attempts(admission.job_id)
        closures = [call for call in finish.call_args_list if call.args[2] is not None]
        self.assertEqual(result.status, JobState.FAILED.value)
        self.assertEqual(len(closures), 1)
        self.assertEqual(closures[0].args[1:3], (AttemptOutcome.FAILED, JobState.FAILED))
        self.assertEqual(closures[0].args[0], attempts[-1].id)

    def test_candidate_metadata_is_strict_and_legacy_details_are_ignored(self):
        plan = self.plan(names=("first",))
        stamp = "2026-07-20T00:00:00.000Z"
        legacy = AttemptRecord(
            "00000000-0000-4000-8000-000000000001",
            "00000000-0000-4000-8000-000000000010",
            "first",
            AttemptOutcome.FAILED,
            None,
            '{"reason":"legacy repair"}',
            stamp,
            stamp,
        )
        self.assertEqual(resume_candidates(plan, (legacy,)).runnable, plan.entries)
        malformed = AttemptRecord(
            "00000000-0000-4000-8000-000000000002",
            "00000000-0000-4000-8000-000000000010",
            "first",
            AttemptOutcome.FAILED,
            None,
            '{"candidate_id":"candidate_0","attempt_sequence":1}',
            stamp,
            stamp,
        )
        with self.assertRaisesRegex(ValueError, "kind marker"):
            resume_candidates(plan, (malformed,))

    def test_catalog_has_no_acquisition_import_and_runtime_reuses_collaborators(self):
        catalog_jobs = (SRC / "sciretriever" / "catalog" / "jobs.py").read_text(encoding="utf-8")
        self.assertNotIn("sciretriever.acquisition", catalog_jobs)
        loaded = []
        provider = FakeProvider("shared", [pdf_bytes()])

        def load(names):
            loaded.append(names)
            return {"shared": provider}

        runtime = AcquisitionRuntime(self.jobs, self.coordinator, load)
        self.assertIs(runtime.provider("shared"), provider)
        self.assertIs(runtime.provider("shared"), provider)
        self.assertIs(runtime.multi(("shared",)), runtime.multi(("shared",)))
        self.assertIs(runtime.single(), runtime.single())
        self.assertEqual(loaded, [("shared",)])

    def test_race_exhaustion_is_independent_of_completion_order(self):
        for index, delays in enumerate(((0.0, 0.03), (0.03, 0.0))):
            identifiers = (Identifier("doi", f"10.1/race-exhaustion-{index}"),)
            plan = self.plan(RoutingMode.RACE, names=("temporary", "definitive"))
            admission = self.admit(identifiers, plan)
            temporary = FakeProvider("temporary", [TimeoutError("temporary")], delay=delays[0])
            definitive = FakeProvider(
                "definitive",
                [ProviderAcquisitionError.for_status("definitive", 404)],
                delay=delays[1],
            )
            with mock.patch.object(
                self.jobs,
                "finish_attempt_and_job",
                wraps=self.jobs.finish_attempt_and_job,
            ) as finish:
                result = asyncio.run(
                    MultiSourceOrchestrator(
                        self.jobs,
                        self.coordinator,
                        {"temporary": temporary, "definitive": definitive},
                    ).acquire(admission, AcquisitionTarget(identifiers), plan, timeout=1)
                )
            self.assertEqual(result.status, JobState.RETRYABLE.value)
            attempts = self.jobs.list_attempts(admission.job_id)
            closures = [call for call in finish.call_args_list if call.args[2] is not None]
            self.assertEqual(len(closures), 1)
            self.assertEqual(closures[0].args[1:3], (AttemptOutcome.RETRYABLE, JobState.RETRYABLE))
            self.assertEqual(closures[0].args[0], next(attempt.id for attempt in attempts if attempt.provider == "temporary"))

    def test_explicit_resume_atomically_claims_paused_job(self):
        identifiers = (Identifier("doi", "10.1/paused-resume"),)
        plan = self.plan(names=("resume-source",))
        admission = self.admit(identifiers, plan)
        self.assertIsNotNone(admission.job_id)
        job_id = admission.job_id
        assert job_id is not None
        self.assertTrue(self.jobs.claim_job(job_id))
        self.jobs.transition_job(job_id, JobState.PAUSED)
        self.assertFalse(self.jobs.claim_job(job_id))

        parser = argparse.ArgumentParser()
        acquire_cli.configure_parser(parser)
        args = parser.parse_args([
            "--resume-job", job_id, "--catalog", str(self.base / "catalog.sqlite"),
            "--storage-root", str(self.storage),
        ])
        provider = FakeProvider("resume-source", [pdf_bytes()])
        with mock.patch("sciretriever.cli.acquire._provider_registry", return_value={"resume-source": provider}):
            self.assertEqual(asyncio.run(acquire_cli._execute_async(args)), (1, 0))
        self.assertEqual(self.jobs.get_job(job_id).state, JobState.SUCCEEDED)

    def test_retryable_exhaustion_sets_due_time_and_restart_resumes(self):
        identifiers = (Identifier("doi", "10.1/resume"),)
        plan = self.plan(names=("retrying",))
        admission = self.admit(identifiers, plan)
        retrying = FakeProvider("retrying", [TimeoutError("temporary"), pdf_bytes()])
        retry_policy = RetryPolicy(0.001, 0.001, jitter=0)
        first = asyncio.run(MultiSourceOrchestrator(self.jobs, self.coordinator, {"retrying": retrying}, retry_policy=retry_policy).acquire(admission, AcquisitionTarget(identifiers), plan, timeout=1))
        self.assertEqual(first.status, "retryable")
        self.assertIsNotNone(self.jobs.get_job(admission.job_id).next_retry_at)
        time.sleep(0.01)
        second = asyncio.run(MultiSourceOrchestrator(self.jobs, self.coordinator, {"retrying": retrying}, retry_policy=retry_policy).acquire(admission, AcquisitionTarget(identifiers), plan, timeout=1))
        self.assertEqual(second.status, "succeeded")
        self.assertEqual(tuple(attempt.outcome for attempt in self.jobs.list_attempts(admission.job_id)), (AttemptOutcome.RETRYABLE, AttemptOutcome.SUCCEEDED))

    def test_storage_failure_closes_winner_attempt_and_job_for_retry(self):
        identifiers = (Identifier("doi", "10.1/storage-failure"),)
        plan = self.plan(names=("source",))
        admission = self.admit(identifiers, plan)
        provider = FakeProvider("source", [pdf_bytes()])
        with mock.patch.object(self.coordinator, "accept", side_effect=OSError("storage unavailable")):
            result = asyncio.run(MultiSourceOrchestrator(self.jobs, self.coordinator, {"source": provider}).acquire(admission, AcquisitionTarget(identifiers), plan, timeout=1))
        self.assertEqual(result.status, AttemptOutcome.RETRYABLE.value)
        attempt = self.jobs.list_attempts(admission.job_id)[0]
        job = self.jobs.get_job(admission.job_id)
        self.assertEqual(attempt.outcome, AttemptOutcome.RETRYABLE)
        self.assertEqual(job.state, JobState.RETRYABLE)
        self.assertIsNotNone(job.next_retry_at)

    def test_independent_roles_create_independent_jobs_and_assets(self):
        identifiers = (Identifier("doi", "10.1/roles"),)
        pdf_plan = self.plan(names=("pdf-source",))
        xml_plan = self.plan(role=AssetRole.XML, names=("xml-source",))
        pdf_admission = self.admit(identifiers, pdf_plan)
        xml_admission = self.admit(identifiers, xml_plan)
        pdf_provider = FakeProvider("pdf-source", [pdf_bytes()])
        xml_provider = FakeProvider("xml-source", [b"<article><body>full text</body></article>"], role=AssetRole.XML, media_type="application/xml", format="xml")
        asyncio.run(MultiSourceOrchestrator(self.jobs, self.coordinator, {"pdf-source": pdf_provider}).acquire(pdf_admission, AcquisitionTarget(identifiers), pdf_plan, timeout=1))
        asyncio.run(MultiSourceOrchestrator(self.jobs, self.coordinator, {"xml-source": xml_provider}).acquire(xml_admission, AcquisitionTarget(identifiers, role=AssetRole.XML), xml_plan, timeout=1))
        links = self.assets.get_work_assets(pdf_admission.work_id)
        self.assertEqual({link.asset_role for link in links}, {AssetRole.PRIMARY_PDF, AssetRole.XML})
        self.assertNotEqual(pdf_admission.job_id, xml_admission.job_id)

    def test_credentials_never_enter_durable_catalog_and_integrity_is_clean(self):
        identifiers = (Identifier("doi", "10.1002/redaction"),)
        plan = self.plan(names=("wiley",))
        admission = self.admit(identifiers, plan)
        transport = FakeTransport([response("https://api.wiley.com/article", pdf_bytes())])
        provider = WileyProvider(transport, "TOP-SECRET-VALUE")
        result = asyncio.run(MultiSourceOrchestrator(self.jobs, self.coordinator, {"wiley": provider}).acquire(admission, AcquisitionTarget(identifiers), plan, timeout=1))
        self.assertEqual(result.status, "succeeded")

        springer_identifiers = (Identifier("doi", "10.1007/redaction"),)
        springer_plan = self.plan(role=AssetRole.XML, names=("springer",))
        springer_admission = self.admit(springer_identifiers, springer_plan)
        springer_transport = FakeTransport([response("https://api.springernature.com/xmldata/jats?api_key=SPRINGER-SECRET", b"<article><body>full text</body></article>", "application/jats+xml")])
        springer_provider = SpringerProvider(springer_transport, "SPRINGER-SECRET")
        springer_result = asyncio.run(MultiSourceOrchestrator(self.jobs, self.coordinator, {"springer": springer_provider}).acquire(springer_admission, AcquisitionTarget(springer_identifiers, role=AssetRole.XML), springer_plan, timeout=1))
        self.assertEqual(springer_result.status, "succeeded")
        with self.catalog.connect() as connection:
            durable = []
            for table, columns in (
                (acquisition_jobs, (acquisition_jobs.c.source_plan_json,)),
                (acquisition_attempts, (acquisition_attempts.c.source_url, acquisition_attempts.c.details_json)),
                (events, (events.c.details_json,)),
                (failures, (failures.c.message, failures.c.details_json)),
            ):
                durable.extend(str(value) for row in connection.execute(select(*columns)).all() for value in row if value is not None)
            self.assertNotIn("TOP-SECRET-VALUE", "\n".join(durable))
            self.assertNotIn("SPRINGER-SECRET", "\n".join(durable))
            self.assertEqual(connection.exec_driver_sql("PRAGMA integrity_check").scalar_one(), "ok")
            self.assertEqual(connection.exec_driver_sql("PRAGMA foreign_key_check").all(), [])


if __name__ == "__main__":
    import unittest
    unittest.main()
