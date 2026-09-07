"""Opt-in generic Browser Agent integration against a local Cloak runtime."""

from __future__ import annotations

import io
import json
import os
import ssl
import subprocess
import tempfile
import threading
import unittest
from collections.abc import Iterable
from contextlib import AbstractContextManager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import BinaryIO, cast

from PyPDF2 import PdfWriter

from sciretriever.acquisition.ports import AcquisitionExpectedFacts, CandidateKeyTracker
from sciretriever.acquisition.routing import AcquisitionRequest, build_acquisition_evidence
from sciretriever.acquisition.sources.browser import ControlledBrowserPdfSource
from sciretriever.agents.api import (
    AgentCallLimits,
    AgentModelCapabilities,
    AgentProvenance,
    AgentRole,
    AgentRoleBinding,
    AgentRuntime,
    AgentToolCall,
    AgentUsage,
)
from sciretriever.agents.ports import AgentProviderCall
from sciretriever.configuration import initialize_browser_profile
from sciretriever.configuration.cloak_runtime import CloakRuntimeManager
from sciretriever.literature.content import metadata_sha256
from sciretriever.model.access import BrowserRequest, BrowserResult
from sciretriever.model.acquisition import AssetHint, AssetHintKind, AssetRole
from sciretriever.model.literature import Identifier, Literature, LiteratureStatus, VersionRole
from sciretriever.model.metadata import LiteratureMetadata, MetadataObservation
from sciretriever.model.primitives import (
    LiteratureId,
    MetaLiteratureId,
    ObservationId,
    ProvenanceId,
    Sha256,
    SourceKind,
    UtcTimestamp,
    sha256_digest,
)
from sciretriever.model.provenance import Provenance
from sciretriever.network.admission import AccessCoordinator, AccessPolicy, AccessScope
from sciretriever.network.browser import (
    BrowserCapturePolicy,
    BrowserClient,
    BrowserDestinationGuard,
    BrowserFlowController,
    BrowserOperationLimits,
)
from sciretriever.network.browser_control import BROWSER_OBSERVATION_MEDIA_TYPE
from sciretriever.network.browser_sessions import BrowserSessionBroker
from sciretriever.network.cloakbrowser import CloakBrowserFactory, cloakbrowser_runtime_availability
from sciretriever.network.policy import AddressClass, DestinationPolicy

_HOSTNAME = "generic-browser.sciretriever.test"
_RUNTIME_HOME_ENV = "SCIRETRIEVER_TEST_CLOAK_HOME"
_TIME = UtcTimestamp("2026-09-05T00:00:00Z")
_DOI = "10.1000/generic-cloak-fixture"


def _pdf() -> bytes:
    output = io.BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=72, height=72)
    writer.add_metadata({"/Title": "Generic Cloak Browser fixture", "/Subject": _DOI})
    writer.write(output)
    return output.getvalue()


class _State:
    def __init__(self, pdf: bytes) -> None:
        self.pdf = pdf
        self.paths: list[str] = []
        self.lock = threading.Lock()


def _handler(state: _State) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.0"

        def do_GET(self) -> None:  # noqa: N802
            with state.lock:
                state.paths.append(self.path)
            if self.path == "/article":
                body = (
                    "<!doctype html><html><head><title>Generic Cloak Browser fixture</title>"
                    "</head><body><a href='/article.pdf'>Download PDF</a></body></html>"
                ).encode()
                self._send(body, "text/html; charset=utf-8")
                return
            if self.path == "/article.pdf":
                self._send(state.pdf, "application/pdf")
                return
            self.send_error(404)

        def _send(self, body: bytes, media_type: str) -> None:
            self.send_response(200)
            self.send_header("Content-Type", media_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args: object) -> None:
            del format, args

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
        timeout=30,
    )
    if result.returncode != 0:
        raise RuntimeError("local Browser certificate generation failed")
    key.chmod(0o600)
    certificate.chmod(0o600)
    return certificate, key


class _Resolver:
    def __init__(self) -> None:
        self.calls: list[str] = []

    def resolve(self, hostname: str) -> Iterable[str]:
        self.calls.append(hostname)
        if hostname != _HOSTNAME:
            raise RuntimeError("unexpected generic Browser fixture hostname")
        return ("127.0.0.1",)


class _SessionBoundRunner:
    def __init__(self, client: BrowserClient) -> None:
        self._client = client

    def run(
        self,
        scope: AccessScope,
        request: BrowserRequest | str,
        policy: AccessPolicy,
        *,
        controller: BrowserFlowController | None = None,
        destination_guard: BrowserDestinationGuard | None = None,
        capture_policy: BrowserCapturePolicy | None = None,
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
            capture_policy=capture_policy,
            navigation_only=navigation_only,
            discard_unapproved_subresources=discard_unapproved_subresources,
            session_key="generic-browser-fixture",
            limits=limits,
            timeout_seconds=timeout_seconds,
            cancel_event=cancel_event,
        )


class _Agent:
    provider_name = "generic-browser-fixture-agent"

    def __init__(self) -> None:
        self.calls: list[AgentProviderCall] = []

    def execute(self, call: AgentProviderCall) -> AgentToolCall:
        self.calls.append(call)
        summary = json.loads(call.text_parts[1].text)
        element = next(
            item
            for item in summary["elements"]
            if item["state"] == "enabled" and "pdf" in item["name"].casefold()
        )
        arguments = json.dumps(
            {
                "article_token": summary["article_token"],
                "page_id": summary["page_id"],
                "revision": summary["revision"],
                "surface_id": element["surface_id"],
                "element_id": element["element_id"],
            },
            sort_keys=True,
            separators=(",", ":"),
        )
        return AgentToolCall(
            tool_name="click_element",
            arguments=arguments,
            provenance=AgentProvenance(
                provider=self.provider_name,
                model=call.model,
                input_sha256=call.input_sha256,
                parameters_sha256=sha256_digest(b"generic-cloak-browser-agent"),
                usage=AgentUsage(output_tokens=1, response_bytes=len(arguments)),
            ),
        )


def _runtime(agent: _Agent) -> AgentRuntime:
    return AgentRuntime(
        adapter=agent,
        browser=AgentRoleBinding(
            role=AgentRole.BROWSER,
            model="generic-browser-fixture-model",
            capabilities=AgentModelCapabilities(
                context_window_tokens=1_000_000,
                max_output_tokens=131_072,
                image_input=True,
                tool_decision=True,
                supported_image_media_types=frozenset(
                    {BROWSER_OBSERVATION_MEDIA_TYPE, "image/png"}
                ),
                max_image_count=1,
                max_image_bytes=2 * 1024 * 1024,
            ),
            limits=AgentCallLimits(
                max_prompt_bytes=131_072,
                max_input_bytes=2 * 1024 * 1024,
                max_request_bytes=3 * 1024 * 1024,
                max_response_bytes=1 * 1024 * 1024,
                max_result_bytes=1 * 1024 * 1024,
                max_output_tokens=131_072,
                context_window_tokens=1_000_000,
            ),
        ),
    )


def _request(origin: str) -> AcquisitionRequest:
    metadata = LiteratureMetadata(
        title="Generic Cloak Browser fixture",
        identifiers=(Identifier(namespace="doi", value=_DOI),),
    )
    literature = Literature(
        literature_id=LiteratureId("00000001-e89b-12d3-a456-426614174000"),
        meta_literature_id=MetaLiteratureId("00000002-e89b-12d3-a456-426614174000"),
        version_role=VersionRole.PUBLISHED,
        metadata=metadata,
        status=LiteratureStatus.UNREVIEWED,
    )
    observation = MetadataObservation(
        observation_id=ObservationId("00000003-e89b-12d3-a456-426614174000"),
        provenance=Provenance(
            provenance_id=ProvenanceId("00000004-e89b-12d3-a456-426614174000"),
            source_kind=SourceKind.METADATA_PROVIDER,
            source_name="generic-browser-fixture",
            source_record_id=_DOI,
            observed_at=_TIME,
            input_sha256=Sha256("a" * 64),
            parameters_sha256=None,
        ),
        metadata=metadata,
        asset_hints=(
            AssetHint(
                url=f"{origin}/article",
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
            metadata_sha256=metadata_sha256(metadata),
            expected_no_primary_pdf=True,
        ),
        observations=(observation,),
    )


class GenericBrowserProviderCloakTests(unittest.TestCase):
    _runtime_manager: CloakRuntimeManager

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
        cls._runtime_manager = manager

    def test_generic_agent_clicks_visible_pdf_without_a_publisher_rule(self) -> None:
        pdf = _pdf()
        with tempfile.TemporaryDirectory(prefix="sciretriever-generic-cloak-") as raw:
            root = Path(raw).resolve(strict=True)
            certificate, key = _certificate(root)
            state = _State(pdf)
            server = ThreadingHTTPServer(("127.0.0.1", 0), _handler(state))
            tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            tls.load_cert_chain(certificate, key)
            server.socket = tls.wrap_socket(server.socket, server_side=True)
            server_thread = threading.Thread(target=server.serve_forever, daemon=True)
            server_thread.start()
            broker = BrowserSessionBroker()
            profile = initialize_browser_profile("generic-browser-fixture", home=root)
            resolver = _Resolver()
            agent = _Agent()
            try:
                port = server.server_port
                origin = f"https://{_HOSTNAME}:{port}"
                client = BrowserClient(
                    factory=CloakBrowserFactory(
                        profile,
                        self._runtime_manager,
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
                source = ControlledBrowserPdfSource(
                    runner=_SessionBoundRunner(client),
                    agent_runtime=_runtime(agent),
                )
                request = _request(origin)
                deliveries = list(
                    source._deliveries(
                        request,
                        build_acquisition_evidence(request),
                        (),
                        CandidateKeyTracker(),
                    )
                )
                self.assertEqual(len(deliveries), 1)
                delivery = deliveries[0]
                context = delivery.content.open()
                self.assertIsInstance(context, AbstractContextManager)
                with context as stream:
                    self.assertEqual(cast(BinaryIO, stream).read(), pdf)
                self.assertEqual(delivery.safe_source_url, f"{origin}/article.pdf")
                self.assertEqual(delivery.provenance.source_record_id, "generic-browser@1")
                self.assertEqual(len(agent.calls), 1)
                self.assertIn("/article", state.paths)
                self.assertIn("/article.pdf", state.paths)
                delivery.content.discard()
            finally:
                try:
                    broker.close()
                finally:
                    server.shutdown()
                    server.server_close()
                    server_thread.join(10)
            self.assertFalse(server_thread.is_alive())
            self.assertEqual(set(resolver.calls), {_HOSTNAME})


if __name__ == "__main__":
    unittest.main()
