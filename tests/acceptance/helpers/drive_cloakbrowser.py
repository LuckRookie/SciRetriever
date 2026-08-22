"""Drive the installed production CloakBrowser adapter against local HTTPS only."""

from __future__ import annotations

import hashlib
import io
import json
import os
import ssl
import subprocess
import tempfile
import threading
import time
from collections.abc import Callable, Iterable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import cloakbrowser
import playwright
from PyPDF2 import PdfWriter

import sciretriever.acquisition.sources.browser as source_module
import sciretriever.network.browser as browser_module
import sciretriever.network.cloakbrowser as adapter_module
from sciretriever.acquisition.planning import RouteReadiness
from sciretriever.acquisition.sources.browser import CONTROLLED_BROWSER_PRODUCTION_STATUS
from sciretriever.acquisition.sources.browser_rules import PRODUCTION_BROWSER_RULE_CATALOG
from sciretriever.configuration import initialize_browser_profile
from sciretriever.configuration.cloak_runtime import CloakRuntimeManager
from sciretriever.model.access import (
    AccessFailure,
    BrowserCaptureBatch,
    BrowserCaptureKind,
    BrowserRequest,
)
from sciretriever.network.admission import AccessCoordinator, AccessPolicy, AccessScope
from sciretriever.network.browser import (
    BrowserClient,
    BrowserDestinationKind,
)
from sciretriever.network.browser_sessions import BrowserSessionBroker
from sciretriever.network.cloakbrowser import (
    CloakBrowserFactory,
    cloakbrowser_runtime_availability,
)
from sciretriever.network.policy import AddressClass, DestinationPolicy

_HOSTNAME = "publisher.sciretriever.test"
_RUNTIME_HOME_ENV = "SCIRETRIEVER_TEST_CLOAK_HOME"


class _FlowController:
    """Typed Browser controller fixture for the installed adapter journey."""

    def __init__(self, flow: Callable[..., object]) -> None:
        if not callable(flow):
            raise TypeError("flow must be callable")
        self._flow = flow

    def run(self, session: object) -> None:
        result = self._flow(session)
        del result


class _Resolver:
    def __init__(self) -> None:
        self.calls: list[str] = []

    def resolve(self, hostname: str) -> Iterable[str]:
        self.calls.append(hostname)
        if hostname != _HOSTNAME:
            raise RuntimeError("unexpected fixture hostname")
        return ("127.0.0.1",)


class _DestinationGuard:
    def __init__(self, origin: str) -> None:
        self._origin = origin

    def check(self, url: str, kind: BrowserDestinationKind) -> None:
        del kind
        if not url.startswith(f"{self._origin}/"):
            raise ValueError("fixture destination escaped its reviewed origin")


class _CaptureGuard:
    def __init__(self, pdf_url: str, kind: BrowserCaptureKind) -> None:
        self._pdf_url = pdf_url
        self._kind = kind

    def allows(self, url: str, kind: BrowserCaptureKind, media_type: str) -> bool:
        return url == self._pdf_url and kind is self._kind and media_type == "application/pdf"


class _ServerState:
    def __init__(self, page: bytes, pdf: bytes) -> None:
        self.page = page
        self.pdf = pdf
        self.paths: list[str] = []
        self.authorities: list[str] = []
        self.pdf_cookies: list[str] = []
        self.lock = threading.Lock()


def _handler(state: _ServerState) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.0"

        def do_GET(self) -> None:  # noqa: N802
            with state.lock:
                state.paths.append(self.path)
                state.authorities.append(self.headers.get("Host", ""))
            if self.path == "/article":
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header(
                    "Set-Cookie",
                    "fixture_session=ready; Secure; HttpOnly; SameSite=Lax",
                )
                self.send_header(
                    "Set-Cookie",
                    "fixture_entitlement=ready; Secure; HttpOnly; SameSite=Lax",
                )
                self.send_header("Content-Length", str(len(state.page)))
                self.end_headers()
                self.wfile.write(state.page)
                return
            if self.path == "/article.pdf":
                cookie = self.headers.get("Cookie", "")
                with state.lock:
                    state.pdf_cookies.append(cookie)
                if not all(
                    marker in cookie
                    for marker in ("fixture_session=ready", "fixture_entitlement=ready")
                ):
                    self.send_error(401)
                    return
                self.send_response(200)
                self.send_header("Content-Type", "application/pdf")
                self.send_header("Content-Disposition", 'attachment; filename="article.pdf"')
                self.send_header("Content-Length", str(len(state.pdf)))
                self.end_headers()
                self.wfile.write(state.pdf)
                return
            self.send_error(404)

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
    completed = subprocess.run(
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
    if completed.returncode != 0:
        raise RuntimeError("local certificate generation failed")
    key.chmod(0o600)
    certificate.chmod(0o600)
    return certificate, key


def _pdf() -> bytes:
    output = io.BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=72, height=72)
    writer.write(output)
    return output.getvalue()


def _module_file(module: object) -> str:
    value = getattr(module, "__file__", None)
    if type(value) is not str:
        raise RuntimeError("installed module has no file")
    return os.fspath(Path(value).resolve(strict=True))


def _restore_ssl_certificate(previous_certificate: str | None) -> None:
    if previous_certificate is None:
        os.environ.pop("SSL_CERT_FILE", None)
    else:
        os.environ["SSL_CERT_FILE"] = previous_certificate


def _runtime_manager() -> tuple[CloakRuntimeManager, str]:
    runtime_home = os.environ.get(_RUNTIME_HOME_ENV, "").strip()
    if not runtime_home:
        raise RuntimeError("an explicit installed Cloak runtime home is required")
    manager = CloakRuntimeManager(home=runtime_home)
    status = manager.status()
    if not status.ready or status.version is None:
        raise RuntimeError("the explicit Cloak runtime is not ready")
    return manager, status.version


def main() -> None:
    runtime_manager, runtime_version = _runtime_manager()
    pdf = _pdf()
    page = (
        "<!doctype html><html><body>"
        "<button data-action='pdf' type='button'>PDF</button>"
        "<script>"
        "document.querySelector(\"button[data-action='pdf']\").addEventListener('click',async()=>{"
        "const response=await fetch('/article.pdf');"
        "const blob=await response.blob();"
        "const link=document.createElement('a');"
        "link.href=URL.createObjectURL(blob);link.download='article.pdf';"
        "document.body.append(link);link.click();"
        "setTimeout(()=>{URL.revokeObjectURL(link.href);link.remove();},0);"
        "});"
        "</script></body></html>"
    ).encode()
    temporary = tempfile.TemporaryDirectory(prefix="sciretriever-installed-cloakbrowser-")
    root = Path(temporary.name).resolve(strict=True)
    certificate, key = _certificate(root)
    state = _ServerState(page, pdf)
    server = ThreadingHTTPServer(("127.0.0.1", 0), _handler(state))
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.load_cert_chain(certificate, key)
    server.socket = tls.wrap_socket(server.socket, server_side=True)
    server_thread = threading.Thread(
        target=server.serve_forever,
        name="sciretriever-installed-https",
        daemon=True,
    )
    server_thread.start()
    broker = BrowserSessionBroker()
    previous_certificate = os.environ.get("SSL_CERT_FILE")
    os.environ["SSL_CERT_FILE"] = os.fspath(certificate)
    session_ids: list[tuple[int, int]] = []
    session_pages_empty: list[bool] = []
    delivered: list[bytes] = []
    direct_elapsed = 0.0
    runtime_directory: Path | None = None
    profile_directory: Path | None = None
    profile_survived_broker_close = False
    resolver = _Resolver()
    try:
        port = server.server_port
        origin = f"https://{_HOSTNAME}:{port}"
        article_url = f"{origin}/article"
        pdf_url = f"{origin}/article.pdf"
        profile = initialize_browser_profile("installed-fixture", home=root)
        profile_directory = profile.runtime_directory()
        factory = CloakBrowserFactory(
            profile,
            runtime_manager,
            ignore_https_errors=True,
        )
        client = BrowserClient(
            factory=factory,
            resolver=resolver,
            coordinator=AccessCoordinator(),
            destination_policy=DestinationPolicy(
                allowed_classes=frozenset({AddressClass.LOOPBACK}),
                allowed_addresses=frozenset({"127.0.0.1"}),
                allowed_ports=frozenset({("https", port)}),
            ),
            session_broker=broker,
        )
        destination_guard = _DestinationGuard(origin)
        flows = (
            (
                article_url,
                lambda session: (
                    session.click("button[data-action='pdf']"),
                    session.wait_for_capture(BrowserCaptureKind.RESPONSE),
                ),
                BrowserCaptureKind.RESPONSE,
            ),
            (
                pdf_url,
                lambda session: (
                    session.text("[data-test='missing-entitlement']"),
                    session.text("[data-test='missing-paywall']"),
                    session.text("#missing-challenge"),
                    session.text("[data-test='missing-account-warning']"),
                    session.wait_for_capture(BrowserCaptureKind.DOWNLOAD),
                ),
                BrowserCaptureKind.DOWNLOAD,
            ),
        )
        for index, (target, flow, capture_kind) in enumerate(flows):
            started = time.monotonic()
            result = client.run(
                AccessScope("publisher-fixture", "web"),
                BrowserRequest(
                    url=target,
                    timeout_seconds=30.0,
                    max_response_bytes=8 * 1024 * 1024,
                ),
                AccessPolicy(max_concurrency=1),
                controller=_FlowController(flow),
                destination_guard=destination_guard,
                capture_guard=_CaptureGuard(pdf_url, capture_kind),
                session_key="publisher-fixture",
            )
            if index == 1:
                direct_elapsed = time.monotonic() - started
            if isinstance(result, AccessFailure):
                raise RuntimeError(f"installed Browser flow failed: {result.code}")
            if not isinstance(result, BrowserCaptureBatch) or len(result.captures) != 1:
                raise RuntimeError("installed Browser flow returned an invalid capture batch")
            delivered.append(b"".join(result.captures[0].stream.chunks))
            shared = broker._shared
            if shared is None:
                raise RuntimeError("shared Browser runtime was not retained")
            context = shared.context
            if context is None:
                raise RuntimeError("persistent Browser context was not retained")
            session_ids.append((id(shared.process_runtime), id(context)))
            session_pages_empty.append(getattr(context, "pages", None) == ())
            if shared.runtime_directory is None:
                raise RuntimeError("temporary Browser download workspace was not retained")
            runtime_directory = Path(shared.runtime_directory.name)
            if not runtime_directory.is_dir():
                raise RuntimeError("temporary Browser download workspace was not created")
            if profile_directory is None or not profile_directory.is_dir():
                raise RuntimeError("persistent Browser profile was not retained")
        runtime = cloakbrowser_runtime_availability(
            browser_version=runtime_version,
            cache_directory=runtime_manager.cache_directory,
        )
        payload = {
            "product_module_files": {
                "acquisition_browser": _module_file(source_module),
                "network_browser": _module_file(browser_module),
                "network_cloakbrowser": _module_file(adapter_module),
            },
            "cloakbrowser_module_file": _module_file(cloakbrowser),
            "playwright_module_file": _module_file(playwright),
            "runtime": {
                "cloak_wrapper_available": runtime.cloak_wrapper_available,
                "playwright_api_available": runtime.playwright_api_available,
                "binary_executable_available": runtime.binary_executable_available,
                "headed_display_available": runtime.headed_display_available,
                "browser_version": runtime.browser_version,
            },
            "network": {
                "hostname": _HOSTNAME,
                "authority": f"{_HOSTNAME}:{port}",
                "paths": state.paths,
                "authorities": state.authorities,
                "resolver_only_returned_loopback": bool(resolver.calls),
                "cookie_pair_preserved": all(
                    "fixture_session=ready" in value and "fixture_entitlement=ready" in value
                    for value in state.pdf_cookies
                ),
            },
            "verification": {
                "expected_pdf_sha256": hashlib.sha256(pdf).hexdigest(),
                "delivered_pdf_sha256": [hashlib.sha256(value).hexdigest() for value in delivered],
                "direct_pdf_elapsed_seconds": direct_elapsed,
            },
            "session": {
                "article_count": len(delivered),
                "one_process_and_context_reused": len(set(session_ids)) == 1,
                "article_pages_closed": all(session_pages_empty),
                "persistent_profile_created": (
                    profile_directory is not None and profile_directory.is_dir()
                ),
            },
            "production_boundary": {
                "catalog_rule_count": len(PRODUCTION_BROWSER_RULE_CATALOG.rules),
                "ready": (CONTROLLED_BROWSER_PRODUCTION_STATUS.readiness is RouteReadiness.READY),
                "readiness_code": (
                    None
                    if CONTROLLED_BROWSER_PRODUCTION_STATUS.failure is None
                    else CONTROLLED_BROWSER_PRODUCTION_STATUS.failure.code
                ),
            },
        }
    finally:
        try:
            broker.close()
            profile_survived_broker_close = (
                profile_directory is not None and profile_directory.is_dir()
            )
        finally:
            _restore_ssl_certificate(previous_certificate)
            server.shutdown()
            server.server_close()
            server_thread.join(10)
            temporary.cleanup()
    payload["cleanup"] = {
        "temporary_root_exists": root.exists(),
        "runtime_directory_exists": (
            None if runtime_directory is None else runtime_directory.exists()
        ),
        "profile_survived_broker_close": profile_survived_broker_close,
        "server_thread_alive": server_thread.is_alive(),
        "browser_threads_alive": sorted(
            thread.name
            for thread in threading.enumerate()
            if thread.is_alive()
            and thread.name
            in {"sciretriever-cloakbrowser-engine", "sciretriever-playwright-events"}
        ),
    }
    print(json.dumps(payload, separators=(",", ":"), sort_keys=True))


if __name__ == "__main__":
    main()
