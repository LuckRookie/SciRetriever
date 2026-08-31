from __future__ import annotations

import io
import os
import ssl
import subprocess
import tempfile
import threading
import unittest
from collections.abc import Iterable
from contextlib import AbstractContextManager
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import BinaryIO, cast
from urllib.parse import urlsplit

from PyPDF2 import PdfWriter

from sciretriever.acquisition.ports import (
    AcquisitionExpectedFacts,
    AcquisitionSourceFailure,
    CandidateKeyTracker,
    TemporaryPdf,
)
from sciretriever.acquisition.routing import AcquisitionRequest, build_acquisition_evidence
from sciretriever.acquisition.sources.browser import (
    ControlledBrowserPdfSource,
)
from sciretriever.acquisition.sources.browser_rules import (
    PRODUCTION_BROWSER_RULE_CATALOG,
    BrowserRuleCatalog,
)
from sciretriever.acquisition.sources.browser_rules.model import (
    BrowserPageMarker,
    BrowserRuleAction,
    BrowserSiteRule,
)
from sciretriever.configuration import initialize_browser_profile
from sciretriever.configuration.cloak_runtime import CloakRuntimeManager
from sciretriever.literature.content import metadata_sha256
from sciretriever.model.access import (
    BrowserRequest,
    BrowserResult,
)
from sciretriever.model.acquisition import AssetHint, AssetHintKind, AssetRole
from sciretriever.model.literature import (
    Identifier,
    Literature,
    LiteratureStatus,
    VersionRole,
)
from sciretriever.model.metadata import LiteratureMetadata, MetadataObservation
from sciretriever.model.primitives import (
    LiteratureId,
    MetaLiteratureId,
    ObservationId,
    ProvenanceId,
    Sha256,
    SourceKind,
    UtcTimestamp,
)
from sciretriever.model.provenance import Provenance
from sciretriever.network.admission import AccessCoordinator, AccessPolicy, AccessScope
from sciretriever.network.browser import (
    BrowserCaptureGuard,
    BrowserClient,
    BrowserDestinationGuard,
    BrowserFlowController,
    BrowserOperationLimits,
)
from sciretriever.network.browser_sessions import BrowserSessionBroker
from sciretriever.network.cloakbrowser import (
    CloakBrowserFactory,
    cloakbrowser_runtime_availability,
)
from sciretriever.network.policy import AddressClass, DestinationPolicy

_HOSTNAME = "browser-rules.sciretriever.test"
_TIME = UtcTimestamp("2026-08-19T00:00:00Z")
_RUNTIME_HOME_ENV = "SCIRETRIEVER_TEST_CLOAK_HOME"


class _Resolver:
    def __init__(self) -> None:
        self.calls: list[str] = []

    def resolve(self, hostname: str) -> Iterable[str]:
        self.calls.append(hostname)
        if hostname != _HOSTNAME:
            raise RuntimeError("unexpected Browser rule fixture hostname")
        return ("127.0.0.1",)


class _FixtureState:
    def __init__(self, pdf: bytes) -> None:
        self.pdf = pdf
        self.pages: dict[str, bytes] = {}
        self.pdfs: set[str] = set()
        self.redirects: dict[str, str] = {}
        self.paths: list[str] = []
        self.lock = threading.Lock()


class _FixtureHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"
    fixture_state: _FixtureState

    def do_GET(self) -> None:  # noqa: N802
        state = self.fixture_state
        with state.lock:
            state.paths.append(self.path)
        page = state.pages.get(self.path)
        if page is not None:
            self._send_bytes(page, "text/html; charset=utf-8")
            return
        redirect = state.redirects.get(self.path)
        if redirect is not None:
            self.send_response(302)
            self.send_header("Location", redirect)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if self.path in state.pdfs:
            self._send_bytes(state.pdf, "application/pdf")
            return
        self.send_error(404)

    def _send_bytes(self, body: bytes, media_type: str) -> None:
        self.send_response(200)
        self.send_header("Content-Type", media_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:
        del format, args


def _handler(state: _FixtureState) -> type[BaseHTTPRequestHandler]:
    class Handler(_FixtureHandler):
        fixture_state = state

    return Handler


def _certificate(root: Path) -> tuple[Path, Path]:
    key = root / "fixture-key.pem"
    certificate = root / "fixture-cert.pem"
    config = root / "openssl.cnf"
    config.write_text(
        "\n".join(
            (
                "[req]",
                "distinguished_name = subject",
                "x509_extensions = extensions",
                "prompt = no",
                "[subject]",
                f"CN = {_HOSTNAME}",
                "[extensions]",
                f"subjectAltName = DNS:{_HOSTNAME}",
                "basicConstraints = critical,CA:TRUE",
                "keyUsage = critical,digitalSignature,keyEncipherment,keyCertSign",
                "extendedKeyUsage = serverAuth",
                "",
            )
        ),
        encoding="utf-8",
    )
    result = subprocess.run(
        (
            "openssl",
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-sha256",
            "-days",
            "1",
            "-keyout",
            os.fspath(key),
            "-out",
            os.fspath(certificate),
            "-config",
            os.fspath(config),
        ),
        cwd=root,
        check=False,
        capture_output=True,
        text=False,
        timeout=30,
    )
    if result.returncode != 0:
        raise RuntimeError("local Browser rule certificate generation failed")
    key.chmod(0o600)
    certificate.chmod(0o600)
    return certificate, key


def _pdf() -> bytes:
    output = io.BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=72, height=72)
    writer.write(output)
    return output.getvalue()


def _mapped_url(value: str, fixture_origin: str) -> str:
    parsed = urlsplit(value)
    query = "" if not parsed.query else f"?{parsed.query}"
    return f"{fixture_origin}{parsed.path}{query}"


def _mapped_urls(values: tuple[str, ...], fixture_origin: str) -> tuple[str, ...]:
    return tuple(dict.fromkeys(_mapped_url(value, fixture_origin) for value in values))


def _mapped_rule(rule: BrowserSiteRule, fixture_origin: str) -> BrowserSiteRule:
    actions = tuple(
        BrowserRuleAction(
            kind=action.kind,
            selector=action.selector,
            locator=(
                None if action.locator is None else _mapped_url(action.locator, fixture_origin)
            ),
            capture_kind=action.capture_kind,
        )
        for action in rule.actions
    )
    page_markers = tuple(
        BrowserPageMarker(
            marker_id=marker.marker_id,
            kind=marker.kind,
            css_selectors=marker.css_selectors,
            url_prefixes=_mapped_urls(marker.url_prefixes, fixture_origin),
            response_statuses=marker.response_statuses,
        )
        for marker in rule.page_markers
    )
    return BrowserSiteRule(
        rule_id=rule.rule_id,
        revision=rule.revision,
        landing_origin=fixture_origin,
        allowed_origins=(fixture_origin,),
        web_scope_provider_name=rule.web_scope_provider_name,
        actions=actions,
        actions_require_entitlement=rule.actions_require_entitlement,
        doi_pdf_url_template=(
            None
            if rule.doi_pdf_url_template is None
            else _mapped_url(rule.doi_pdf_url_template, fixture_origin)
        ),
        page_markers=page_markers,
        capture_url_prefixes=_mapped_urls(rule.capture_url_prefixes, fixture_origin),
        capture_origin_roots=((fixture_origin,) if rule.capture_origin_roots else ()),
        capture_root_filename_markers=rule.capture_root_filename_markers,
        article_identity_kinds=rule.article_identity_kinds,
        article_id_namespaces=rule.article_id_namespaces,
        supplement_url_prefixes=_mapped_urls(
            rule.supplement_url_prefixes,
            fixture_origin,
        ),
        supplement_selectors=rule.supplement_selectors,
        supplement_filename_markers=rule.supplement_filename_markers,
        excluded_url_prefixes=_mapped_urls(rule.excluded_url_prefixes, fixture_origin),
        excluded_filename_markers=rule.excluded_filename_markers,
        capture_priority=rule.capture_priority,
    )


class _SessionBoundRunner:
    def __init__(self, client: BrowserClient, session_key: str) -> None:
        self._client = client
        self._session_key = BrowserSessionBroker.validate_session_key(session_key)

    def run(
        self,
        scope: AccessScope,
        request: BrowserRequest | str,
        policy: AccessPolicy,
        *,
        controller: BrowserFlowController | None = None,
        destination_guard: BrowserDestinationGuard | None = None,
        capture_guard: BrowserCaptureGuard | None = None,
        navigation_only: bool = False,
        discard_unapproved_subresources: bool = False,
        limits: BrowserOperationLimits | None = None,
        timeout_seconds: float | None = None,
        cancel_event: threading.Event | None = None,
    ) -> BrowserResult:
        return self._client.run(
            scope,
            request,
            policy,
            controller=controller,
            destination_guard=destination_guard,
            capture_guard=capture_guard,
            navigation_only=navigation_only,
            discard_unapproved_subresources=discard_unapproved_subresources,
            session_key=self._session_key,
            limits=limits,
            timeout_seconds=timeout_seconds,
            cancel_event=cancel_event,
        )


@dataclass(frozen=True, slots=True)
class _PositiveCase:
    rule_id: str
    identifiers: tuple[Identifier, ...]
    landing_path: str
    start_path: str
    click_path: str
    final_pdf_path: str
    anchor: str
    uses_redirect: bool = False


_POSITIVE_CASES = (
    _PositiveCase(
        rule_id="acs-publications-pdf",
        identifiers=(Identifier(namespace="doi", value="10.1021/acs.fixture01"),),
        landing_path="/doi/10.1021/acs.fixture01",
        start_path="/doi/pdf/10.1021/acs.fixture01",
        click_path="/doi/pdf/10.1021/acs.fixture01?download=1",
        final_pdf_path="/doi/pdf/10.1021/acs.fixture01?download=1",
        anchor=("<a href='/doi/pdf/10.1021/acs.fixture01?download=1'>PDF</a>"),
    ),
    _PositiveCase(
        rule_id="aip-publishing-pdf",
        identifiers=(Identifier(namespace="doi", value="10.1063/aip.fixture01"),),
        landing_path="/doi/10.1063/aip.fixture01",
        start_path="/doi/epdf/10.1063/aip.fixture01",
        click_path="/doi/epdf/10.1063/aip.fixture01?download=1",
        final_pdf_path="/doi/epdf/10.1063/aip.fixture01?download=1",
        anchor=("<a href='/doi/epdf/10.1063/aip.fixture01?download=1'>PDF</a>"),
    ),
    _PositiveCase(
        rule_id="sciencedirect-pdf",
        identifiers=(Identifier(namespace="pii", value="S0013468626000012"),),
        landing_path="/science/article/pii/S0013468626000012",
        start_path="/science/article/pii/S0013468626000012",
        click_path="/science/article/pii/S0013468626000012/pdfft?download=1",
        final_pdf_path=("/271074/1-s2.0-S0013468626000012-main.pdf?download=true"),
        anchor=(
            "<a class='pdf-download-btn-link' "
            "href='/science/article/pii/S0013468626000012/pdfft?download=1'>PDF</a>"
        ),
        uses_redirect=True,
    ),
    _PositiveCase(
        rule_id="iopscience-pdf",
        identifiers=(Identifier(namespace="doi", value="10.1088/iop.fixture01"),),
        landing_path="/article/10.1088/iop.fixture01",
        start_path="/article/10.1088/iop.fixture01/pdf",
        click_path="/article/10.1088/iop.fixture01/pdf?download=1",
        final_pdf_path="/article/10.1088/iop.fixture01/pdf?download=1",
        anchor=("<a href='/article/10.1088/iop.fixture01/pdf?download=1'>PDF</a>"),
    ),
    _PositiveCase(
        rule_id="oxford-academic-pdf",
        identifiers=(Identifier(namespace="doi", value="10.1093/oxford.fixture01"),),
        landing_path="/example/article/1/1/fixture/1234567",
        start_path="/doi/pdf/10.1093/oxford.fixture01",
        click_path="/doi/pdf/10.1093/oxford.fixture01?download=1",
        final_pdf_path="/doi/pdf/10.1093/oxford.fixture01?download=1",
        anchor=("<a href='/doi/pdf/10.1093/oxford.fixture01?download=1'>PDF</a>"),
    ),
    _PositiveCase(
        rule_id="rsc-publishing-pdf",
        identifiers=(Identifier(namespace="doi", value="10.1039/rsc.fixture01"),),
        landing_path="/en/content/articlelanding/2026/xx/d6xx00001a",
        start_path="/en/content/articlelanding/2026/xx/d6xx00001a",
        click_path="/en/content/articlepdf/2026/xx/d6xx00001a?download=1",
        final_pdf_path="/en/content/articlepdf/2026/xx/d6xx00001a?download=1",
        anchor=("<a href='/en/content/articlepdf/2026/xx/d6xx00001a?download=1'>PDF</a>"),
    ),
    _PositiveCase(
        rule_id="science-aaas-pdf",
        identifiers=(Identifier(namespace="doi", value="10.1126/science.ad12345"),),
        landing_path="/doi/10.1126/science.ad12345",
        start_path="/doi/epdf/10.1126/science.ad12345",
        click_path="/doi/epdf/10.1126/science.ad12345?download=1",
        final_pdf_path="/doi/epdf/10.1126/science.ad12345?download=1",
        anchor=("<a href='/doi/epdf/10.1126/science.ad12345?download=1'>PDF</a>"),
    ),
    _PositiveCase(
        rule_id="springerlink-pdf",
        identifiers=(Identifier(namespace="doi", value="10.1007/s10853-026-12345-6"),),
        landing_path="/article/10.1007/s10853-026-12345-6",
        start_path="/content/pdf/10.1007/s10853-026-12345-6.pdf",
        click_path="/content/pdf/10.1007/s10853-026-12345-6.pdf?download=1",
        final_pdf_path=("/content/pdf/10.1007/s10853-026-12345-6.pdf?download=1"),
        anchor=(
            "<a class='c-pdf-download__link' "
            "href='/content/pdf/10.1007/s10853-026-12345-6.pdf?download=1'>PDF</a>"
        ),
    ),
    _PositiveCase(
        rule_id="wiley-online-library-pdf",
        identifiers=(Identifier(namespace="doi", value="10.1002/aenm.202601234"),),
        landing_path="/doi/10.1002/aenm.202601234",
        start_path="/doi/pdfdirect/10.1002/aenm.202601234",
        click_path="/doi/pdfdirect/10.1002/aenm.202601234?download=1",
        final_pdf_path="/doi/pdfdirect/10.1002/aenm.202601234?download=1",
        anchor=("<a href='/doi/pdfdirect/10.1002/aenm.202601234?download=1'>PDF</a>"),
    ),
)


def _production_rule(rule_id: str) -> BrowserSiteRule:
    return next(rule for rule in PRODUCTION_BROWSER_RULE_CATALOG.rules if rule.rule_id == rule_id)


def _request(case: _PositiveCase, fixture_origin: str) -> AcquisitionRequest:
    literature = Literature(
        literature_id=LiteratureId("00000001-e89b-12d3-a456-426614174000"),
        meta_literature_id=MetaLiteratureId("00000002-e89b-12d3-a456-426614174000"),
        version_role=VersionRole.PUBLISHED,
        metadata=LiteratureMetadata(
            title=f"Local Browser fixture for {case.rule_id}",
            identifiers=case.identifiers,
        ),
        status=LiteratureStatus.UNREVIEWED,
    )
    observation = MetadataObservation(
        observation_id=ObservationId("00000003-e89b-12d3-a456-426614174000"),
        provenance=Provenance(
            provenance_id=ProvenanceId("00000004-e89b-12d3-a456-426614174000"),
            source_kind=SourceKind.METADATA_PROVIDER,
            source_name="browser-rule-fixture",
            source_record_id=case.rule_id,
            observed_at=_TIME,
            input_sha256=Sha256("a" * 64),
            parameters_sha256=None,
        ),
        metadata=LiteratureMetadata(title="Local Browser fixture observation"),
        asset_hints=(
            AssetHint(
                url=f"{fixture_origin}{case.landing_path}",
                kind=AssetHintKind.LANDING_PAGE,
                asset_role=AssetRole.PRIMARY_PDF,
            ),
        ),
    )
    return AcquisitionRequest(
        literature=literature,
        expected_facts=AcquisitionExpectedFacts(
            literature_id=literature.literature_id,
            meta_literature_id=literature.meta_literature_id,
            metadata_revision=1,
            metadata_sha256=metadata_sha256(literature.metadata),
            expected_no_primary_pdf=True,
        ),
        observations=(observation,),
    )


def _payload(temporary_pdf: TemporaryPdf) -> bytes:
    context = temporary_pdf.content.open()
    if not isinstance(context, AbstractContextManager):
        raise AssertionError("temporary Browser content did not return a context manager")
    with context as stream:
        return cast(BinaryIO, stream).read()


class ProductionBrowserProviderCloakTests(unittest.TestCase):
    """Run the nine production rules on an explicitly supplied Cloak runtime."""

    _runtime: CloakRuntimeManager

    @classmethod
    def setUpClass(cls) -> None:
        raw_home = os.environ.get(_RUNTIME_HOME_ENV, "").strip()
        if not raw_home:
            raise unittest.SkipTest(f"set {_RUNTIME_HOME_ENV} to an installed Cloak runtime home")
        manager = CloakRuntimeManager(home=raw_home)
        status = manager.status()
        if not status.ready or status.version is None:
            raise unittest.SkipTest("explicit Cloak runtime is not ready")
        availability = cloakbrowser_runtime_availability(
            browser_version=status.version,
            cache_directory=manager.cache_directory,
        )
        if not (
            availability.cloak_wrapper_available
            and availability.playwright_api_available
            and availability.binary_executable_available
            and availability.headed_display_available
        ):
            raise unittest.SkipTest("explicit Cloak runtime lacks wrapper, binary, or Xvfb")
        lease = manager.acquire_runtime()
        lease.close()
        cls._runtime = manager

    def test_production_rules_run_real_selectors_and_fail_closed(self) -> None:
        pdf = _pdf()
        with tempfile.TemporaryDirectory(prefix="sciretriever-provider-rules-cloak-") as raw_root:
            root = Path(raw_root).resolve(strict=True)
            certificate, key = _certificate(root)
            state = _FixtureState(pdf)
            server = ThreadingHTTPServer(("127.0.0.1", 0), _handler(state))
            tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            tls.load_cert_chain(certificate, key)
            server.socket = tls.wrap_socket(server.socket, server_side=True)
            server_thread = threading.Thread(target=server.serve_forever, daemon=True)
            server_thread.start()
            broker = BrowserSessionBroker()
            profile = initialize_browser_profile("provider-rules-fixture", home=root)
            profile_directory = profile.runtime_directory()
            previous_certificate = os.environ.get("SSL_CERT_FILE")
            os.environ["SSL_CERT_FILE"] = os.fspath(certificate)
            runtime_directory: Path | None = None
            try:
                port = server.server_port
                fixture_origin = f"https://{_HOSTNAME}:{port}"
                resolver = _Resolver()
                client = BrowserClient(
                    factory=CloakBrowserFactory(
                        profile,
                        self._runtime,
                        ignore_https_errors=True,
                    ),
                    resolver=resolver,
                    coordinator=AccessCoordinator(),
                    destination_policy=DestinationPolicy(
                        allowed_classes=frozenset({AddressClass.LOOPBACK}),
                        allowed_addresses=frozenset({"127.0.0.1"}),
                        allowed_ports=frozenset({("https", port)}),
                    ),
                    session_broker=broker,
                )

                for case in _POSITIVE_CASES:
                    with self.subTest(rule_id=case.rule_id):
                        production_rule = _production_rule(case.rule_id)
                        rule = _mapped_rule(production_rule, fixture_origin)
                        self._assert_transport_only_mapping(production_rule, rule)
                        state.pages[case.start_path] = (
                            f"<!doctype html><html><body>{case.anchor}</body></html>"
                        ).encode()
                        if case.uses_redirect:
                            state.redirects[case.click_path] = (
                                f"{fixture_origin}{case.final_pdf_path}"
                            )
                        state.pdfs.add(case.final_pdf_path)
                        source = ControlledBrowserPdfSource(
                            runner=_SessionBoundRunner(
                                client,
                                production_rule.web_scope_provider_name,
                            ),
                            rule_catalog=BrowserRuleCatalog((rule,)),
                        )
                        request = _request(case, fixture_origin)

                        deliveries = list(
                            source._deliveries(
                                request,
                                build_acquisition_evidence(request),
                                CandidateKeyTracker(),
                            )
                        )

                        self.assertEqual(len(deliveries), 1)
                        delivery = deliveries[0]
                        self.assertEqual(_payload(delivery), pdf)
                        self.assertEqual(
                            delivery.safe_source_url,
                            f"{fixture_origin}{case.final_pdf_path.partition('?')[0]}",
                        )
                        self.assertEqual(
                            delivery.provenance.source_record_id,
                            f"{production_rule.rule_id}@{production_rule.revision}",
                        )
                        self.assertEqual(delivery.provenance.parameters_sha256, rule.fingerprint)
                        delivery.content.discard()
                        self.assertIn(case.start_path, state.paths)
                        self.assertIn(case.click_path, state.paths)
                        self.assertIn(case.final_pdf_path, state.paths)

                springer_production = _production_rule("springerlink-pdf")
                springer_rule = _mapped_rule(springer_production, fixture_origin)
                springer_source = ControlledBrowserPdfSource(
                    runner=_SessionBoundRunner(
                        client,
                        springer_production.web_scope_provider_name,
                    ),
                    rule_catalog=BrowserRuleCatalog((springer_rule,)),
                )

                paywall_case = self._springer_case("10.1007/s10853-026-20001-1")
                state.pages[paywall_case.start_path] = (
                    b"<!doctype html><html><body>"
                    b"<div data-test='access-options'>Purchase access</div>"
                    b"</body></html>"
                )
                paywall_request = _request(paywall_case, fixture_origin)
                self.assertEqual(
                    list(
                        springer_source._deliveries(
                            paywall_request,
                            build_acquisition_evidence(paywall_request),
                            CandidateKeyTracker(),
                        )
                    ),
                    [],
                )

                challenge_case = self._springer_case("10.1007/s10853-026-20002-2")
                state.pages[challenge_case.start_path] = (
                    b"<!doctype html><html><body>"
                    b"<div id='challenge-running'>Please wait</div>"
                    b"</body></html>"
                )
                challenge_request = _request(challenge_case, fixture_origin)
                with self.assertRaises(AcquisitionSourceFailure) as challenge_error:
                    list(
                        springer_source._deliveries(
                            challenge_request,
                            build_acquisition_evidence(challenge_request),
                            CandidateKeyTracker(),
                        )
                    )
                self.assertEqual(
                    challenge_error.exception.failure.code,
                    "acquisition-browser-challenge-unresolved",
                )

                outside_hostname = "outside.sciretriever.test"
                outside_case = self._springer_case("10.1007/s10853-026-20003-3")
                outside_pdf = (
                    f"https://{outside_hostname}:{port}{outside_case.start_path}?download=1"
                )
                state.pages[outside_case.start_path] = (
                    "<!doctype html><html><body>"
                    f"<a class='c-pdf-download__link' href='{outside_pdf}'>PDF</a>"
                    "<script>"
                    "document.querySelector('a').addEventListener('click',event=>{"
                    "event.preventDefault();const href=event.currentTarget.href;"
                    "document.body.innerHTML=\"<div data-test='access-options'>"
                    'Unavailable</div>";fetch(href);'
                    "});"
                    "</script></body></html>"
                ).encode()
                outside_request = _request(outside_case, fixture_origin)
                self.assertEqual(
                    list(
                        springer_source._deliveries(
                            outside_request,
                            build_acquisition_evidence(outside_request),
                            CandidateKeyTracker(),
                        )
                    ),
                    [],
                )
                self.assertNotIn(outside_hostname, resolver.calls)

                self.assertEqual(set(resolver.calls), {_HOSTNAME})
                self.assertEqual(len(broker._lanes), len(_POSITIVE_CASES))
                shared = broker._shared
                self.assertIsNotNone(shared)
                assert shared is not None
                self.assertIsNotNone(shared.context)
                self.assertEqual(getattr(shared.context, "pages", None), ())
                self.assertIsNotNone(shared.runtime_directory)
                assert shared.runtime_directory is not None
                runtime_directory = Path(shared.runtime_directory.name)
                self.assertTrue(runtime_directory.is_dir())
                self.assertTrue(profile_directory.is_dir())
            finally:
                try:
                    broker.close()
                finally:
                    if previous_certificate is None:
                        os.environ.pop("SSL_CERT_FILE", None)
                    else:
                        os.environ["SSL_CERT_FILE"] = previous_certificate
                    server.shutdown()
                    server.server_close()
                    server_thread.join(10)
            self.assertFalse(server_thread.is_alive())
            self.assertIsNotNone(runtime_directory)
            assert runtime_directory is not None
            self.assertFalse(runtime_directory.exists())
            self.assertTrue(profile_directory.is_dir())
            self.assertFalse(
                any(
                    thread.is_alive()
                    and thread.name
                    in {
                        "sciretriever-cloakbrowser-engine",
                        "sciretriever-playwright-events",
                    }
                    for thread in threading.enumerate()
                )
            )

    @staticmethod
    def _springer_case(doi: str) -> _PositiveCase:
        return _PositiveCase(
            rule_id="springerlink-pdf",
            identifiers=(Identifier(namespace="doi", value=doi),),
            landing_path=f"/article/{doi}",
            start_path=f"/content/pdf/{doi}.pdf",
            click_path=f"/content/pdf/{doi}.pdf?download=1",
            final_pdf_path=f"/content/pdf/{doi}.pdf?download=1",
            anchor="",
        )

    def _assert_transport_only_mapping(
        self,
        production_rule: BrowserSiteRule,
        mapped_rule: BrowserSiteRule,
    ) -> None:
        self.assertEqual(mapped_rule.rule_id, production_rule.rule_id)
        self.assertEqual(mapped_rule.revision, production_rule.revision)
        self.assertEqual(
            mapped_rule.web_scope_provider_name,
            production_rule.web_scope_provider_name,
        )
        self.assertEqual(mapped_rule.actions, production_rule.actions)
        self.assertEqual(
            tuple(
                (
                    marker.marker_id,
                    marker.kind,
                    marker.css_selectors,
                    marker.response_statuses,
                )
                for marker in mapped_rule.page_markers
            ),
            tuple(
                (
                    marker.marker_id,
                    marker.kind,
                    marker.css_selectors,
                    marker.response_statuses,
                )
                for marker in production_rule.page_markers
            ),
        )
        self.assertEqual(
            mapped_rule.article_identity_kinds,
            production_rule.article_identity_kinds,
        )
        self.assertEqual(
            mapped_rule.article_id_namespaces,
            production_rule.article_id_namespaces,
        )
        self.assertEqual(
            mapped_rule.capture_root_filename_markers,
            production_rule.capture_root_filename_markers,
        )
        self.assertEqual(
            mapped_rule.supplement_selectors,
            production_rule.supplement_selectors,
        )
        self.assertEqual(
            mapped_rule.supplement_filename_markers,
            production_rule.supplement_filename_markers,
        )
        self.assertEqual(
            mapped_rule.excluded_filename_markers,
            production_rule.excluded_filename_markers,
        )
        self.assertEqual(mapped_rule.capture_priority, production_rule.capture_priority)


if __name__ == "__main__":
    unittest.main()
