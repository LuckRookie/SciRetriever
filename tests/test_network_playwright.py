from __future__ import annotations

import io
import os
import ssl
import subprocess
import tempfile
import threading
import time
import unittest
from collections.abc import Iterable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from PyPDF2 import PdfWriter

from sciretriever.model.access import (
    AccessFailure,
    BrowserCaptureBatch,
    BrowserCaptureKind,
    BrowserRequest,
)
from sciretriever.network.admission import AccessCoordinator, AccessPolicy, AccessScope
from sciretriever.network.browser import (
    BrowserCaptureGuard,
    BrowserClient,
    BrowserDestinationGuard,
    BrowserDestinationKind,
    BrowserFlowSession,
)
from sciretriever.network.browser_sessions import BrowserSessionBroker
from sciretriever.network.playwright import PlaywrightBrowserFactory
from sciretriever.network.policy import AddressClass, DestinationPolicy

_HOSTNAME = "publisher.sciretriever.test"
_IDP_HOSTNAME = "idp.sciretriever.test"
_STYLESHEET = b"body { color: black; }"


class _Resolver:
    def __init__(self, *hostnames: str) -> None:
        self.calls: list[str] = []
        self._hostnames = frozenset(hostnames or (_HOSTNAME,))

    def resolve(self, hostname: str) -> Iterable[str]:
        self.calls.append(hostname)
        if hostname not in self._hostnames:
            raise RuntimeError("unexpected fixture hostname")
        return ("127.0.0.1",)


class _Profile:
    def __init__(self, path: Path) -> None:
        self._path = path

    def runtime_directory(self) -> Path:
        return self._path


class _DestinationGuard:
    def __init__(self, *origins: str) -> None:
        self._origins = origins
        self.calls: list[tuple[str, BrowserDestinationKind]] = []

    def check(self, url: str, kind: BrowserDestinationKind) -> None:
        self.calls.append((url, kind))
        if not any(url.startswith(f"{origin}/") for origin in self._origins):
            raise ValueError("fixture destination escaped its reviewed origin")


class _CaptureGuard:
    def __init__(self, pdf_url: str) -> None:
        self._pdf_url = pdf_url

    def allows(self, url: str, kind: BrowserCaptureKind, media_type: str) -> bool:
        return (
            url == self._pdf_url
            and kind is BrowserCaptureKind.RESPONSE
            and media_type == "application/pdf"
        )


class _ServerState:
    def __init__(self, page: bytes, pdf: bytes) -> None:
        self.page = page
        self.pdf = pdf
        self.paths: list[str] = []
        self.authorities: list[str] = []
        self.pdf_cookies: list[str] = []
        self.lock = threading.Lock()
        self.stall_started = threading.Event()
        self.stall_released = threading.Event()
        self.stall_finished = threading.Event()


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
            if self.path in {"/style.css", "/authorize"}:
                body = _STYLESHEET if self.path == "/style.css" else state.page
                media_type = (
                    "text/css; charset=utf-8"
                    if self.path == "/style.css"
                    else "text/html; charset=utf-8"
                )
                self.send_response(200)
                self.send_header("Content-Type", media_type)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if self.path == "/redirect":
                port = getattr(self.server, "server_port")
                self.send_response(303)
                self.send_header(
                    "Location",
                    f"https://{_IDP_HOSTNAME}:{port}/authorize",
                )
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            if self.path == "/stall":
                state.stall_started.set()
                state.stall_released.wait(10)
                try:
                    self.send_response(200)
                    self.send_header("Content-Type", "text/html; charset=utf-8")
                    self.send_header("Content-Length", str(len(state.page)))
                    self.end_headers()
                    self.wfile.write(state.page)
                except OSError:
                    pass
                finally:
                    state.stall_finished.set()
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
                f"subjectAltName = DNS:{_HOSTNAME},DNS:{_IDP_HOSTNAME}",
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
        raise RuntimeError("local fixture certificate generation failed")
    key.chmod(0o600)
    certificate.chmod(0o600)
    return certificate, key


def _pdf() -> bytes:
    output = io.BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=72, height=72)
    writer.write(output)
    return output.getvalue()


class ProductionPlaywrightAdapterTests(unittest.TestCase):
    def test_real_chromium_follows_a_cross_origin_redirect_through_policy(self) -> None:
        page = (
            b"<!doctype html><html><head><link rel='stylesheet' href='/style.css'>"
            b"<title>authorize</title></head><body>login</body></html>"
        )
        with tempfile.TemporaryDirectory(prefix="sciretriever-playwright-redirect-") as raw_root:
            root = Path(raw_root).resolve(strict=True)
            profile = root / "profile"
            profile.mkdir(mode=0o700)
            certificate, key = _certificate(root)
            state = _ServerState(page, _pdf())
            server = ThreadingHTTPServer(("127.0.0.1", 0), _handler(state))
            tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            tls.load_cert_chain(certificate, key)
            server.socket = tls.wrap_socket(server.socket, server_side=True)
            server_thread = threading.Thread(target=server.serve_forever, daemon=True)
            server_thread.start()
            broker = BrowserSessionBroker()
            previous_certificate = os.environ.get("SSL_CERT_FILE")
            os.environ["SSL_CERT_FILE"] = os.fspath(certificate)
            try:
                port = server.server_port
                publisher_origin = f"https://{_HOSTNAME}:{port}"
                idp_origin = f"https://{_IDP_HOSTNAME}:{port}"
                observations: list[tuple[str, int | None]] = []
                resolver = _Resolver(_HOSTNAME, _IDP_HOSTNAME)
                destination_guard = _DestinationGuard(publisher_origin, idp_origin)
                client = BrowserClient(
                    factory=PlaywrightBrowserFactory(),
                    resolver=resolver,
                    coordinator=AccessCoordinator(),
                    destination_policy=DestinationPolicy(
                        allowed_classes=frozenset({AddressClass.LOOPBACK}),
                        allowed_addresses=frozenset({"127.0.0.1"}),
                        allowed_ports=frozenset({("https", port)}),
                    ),
                    operator_profile=_Profile(profile),
                    session_broker=broker,
                )

                def observe(session: BrowserFlowSession) -> None:
                    observation = session.observe()
                    observations.append((observation.locator, observation.status_code))

                result = client.run(
                    AccessScope("publisher-fixture", "web"),
                    BrowserRequest(
                        url=f"{publisher_origin}/redirect",
                        timeout_seconds=30.0,
                        max_response_bytes=8 * 1024 * 1024,
                    ),
                    AccessPolicy(max_concurrency=1),
                    flow=observe,
                    destination_guard=destination_guard,
                    navigation_only=True,
                    session_key="publisher-fixture",
                )

                self.assertIsInstance(result, AccessFailure)
                assert isinstance(result, AccessFailure)
                self.assertEqual(
                    result.code,
                    "no-download",
                    (
                        tuple(state.paths),
                        tuple(state.authorities),
                        tuple(resolver.calls),
                        tuple(destination_guard.calls),
                    ),
                )
                self.assertEqual(observations, [(f"{idp_origin}/authorize", 200)])
                self.assertEqual(state.paths, ["/redirect", "/authorize"])
                self.assertEqual(
                    state.authorities,
                    [f"{_HOSTNAME}:{port}", f"{_IDP_HOSTNAME}:{port}"],
                )
                self.assertEqual(set(resolver.calls), {_HOSTNAME, _IDP_HOSTNAME})
                self.assertEqual(len(broker._entries), 1)
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

    def test_real_chromium_uses_bound_https_and_reuses_one_persistent_session(self) -> None:
        pdf = _pdf()
        page = (
            "<!doctype html><html><head><link rel='stylesheet' href='/style.css'></head><body>"
            "<button data-action='pdf' type='button'>PDF</button>"
            "<a data-action='pdf-link' href='/article.pdf'>PDF link</a>"
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
        with tempfile.TemporaryDirectory(prefix="sciretriever-playwright-test-") as raw_root:
            root = Path(raw_root).resolve(strict=True)
            profile = root / "profile"
            profile.mkdir(mode=0o700)
            certificate, key = _certificate(root)
            state = _ServerState(page, pdf)
            server = ThreadingHTTPServer(("127.0.0.1", 0), _handler(state))
            tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            tls.load_cert_chain(certificate, key)
            server.socket = tls.wrap_socket(server.socket, server_side=True)
            server_thread = threading.Thread(target=server.serve_forever, daemon=True)
            server_thread.start()
            broker = BrowserSessionBroker()
            previous_certificate = os.environ.get("SSL_CERT_FILE")
            os.environ["SSL_CERT_FILE"] = os.fspath(certificate)
            try:
                port = server.server_port
                origin = f"https://{_HOSTNAME}:{port}"
                article_url = f"{origin}/article"
                pdf_url = f"{origin}/article.pdf"
                resolver = _Resolver()
                client = BrowserClient(
                    factory=PlaywrightBrowserFactory(),
                    resolver=resolver,
                    coordinator=AccessCoordinator(),
                    destination_policy=DestinationPolicy(
                        allowed_classes=frozenset({AddressClass.LOOPBACK}),
                        allowed_addresses=frozenset({"127.0.0.1"}),
                        allowed_ports=frozenset({("https", port)}),
                    ),
                    operator_profile=_Profile(profile),
                    session_broker=broker,
                )
                capture_guard = _CaptureGuard(pdf_url)
                destination_guard = _DestinationGuard(origin)
                self.assertIsInstance(capture_guard, BrowserCaptureGuard)
                self.assertIsInstance(destination_guard, BrowserDestinationGuard)

                delivered: list[bytes] = []
                flows = (
                    (
                        article_url,
                        lambda session: (
                            session.click("button[data-action='pdf']"),
                            session.wait_for_capture(BrowserCaptureKind.RESPONSE),
                        ),
                        False,
                    ),
                    (
                        pdf_url,
                        lambda session: (
                            session.text("[data-test='missing-entitlement']"),
                            session.text("[data-test='missing-paywall']"),
                            session.text("#missing-challenge"),
                            session.text("[data-test='missing-account-warning']"),
                            session.wait_for_capture(BrowserCaptureKind.RESPONSE),
                        ),
                        False,
                    ),
                    (
                        article_url,
                        lambda session: (
                            self.assertTrue(session.has_selector("a[data-action='pdf-link']")),
                            session.click("a[data-action='pdf-link']"),
                            session.wait_for_capture(BrowserCaptureKind.RESPONSE),
                        ),
                        True,
                    ),
                )
                direct_started = 0.0
                direct_elapsed = 0.0
                for index, (target, flow, navigation_only) in enumerate(flows):
                    if index == 1:
                        direct_started = time.monotonic()
                    result = client.run(
                        AccessScope("publisher-fixture", "web"),
                        BrowserRequest(
                            url=target,
                            timeout_seconds=30.0,
                            max_response_bytes=8 * 1024 * 1024,
                        ),
                        AccessPolicy(max_concurrency=1),
                        flow=flow,
                        destination_guard=destination_guard,
                        capture_guard=capture_guard,
                        navigation_only=navigation_only,
                        session_key="publisher-fixture",
                    )
                    self.assertNotIsInstance(
                        result,
                        AccessFailure,
                        (
                            getattr(result, "code", type(result).__name__),
                            tuple(state.paths),
                            tuple(state.pdf_cookies),
                            tuple(resolver.calls),
                            tuple(broker._entries),
                        ),
                    )
                    self.assertIsInstance(result, BrowserCaptureBatch)
                    assert isinstance(result, BrowserCaptureBatch)
                    self.assertEqual(len(result.captures), 1)
                    delivered.append(b"".join(result.captures[0].stream.chunks))
                    if index == 1:
                        direct_elapsed = time.monotonic() - direct_started

                self.assertEqual(delivered, [pdf, pdf, pdf])
                self.assertEqual(
                    state.paths,
                    [
                        "/article",
                        "/style.css",
                        "/article.pdf",
                        "/article.pdf",
                        "/article",
                        "/article.pdf",
                    ],
                )
                self.assertEqual(state.authorities, [f"{_HOSTNAME}:{port}"] * 6)
                self.assertEqual(len(state.pdf_cookies), 3)
                self.assertTrue(
                    all(
                        "fixture_session=ready" in value and "fixture_entitlement=ready" in value
                        for value in state.pdf_cookies
                    )
                )
                self.assertLess(direct_elapsed, 5.0)
                self.assertEqual(set(resolver.calls), {_HOSTNAME})
                self.assertEqual(len(broker._entries), 1)
                entry = next(iter(broker._entries.values()))
                context = entry.context
                self.assertIsNotNone(context)
                self.assertEqual(getattr(context, "pages", None), ())
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
            self.assertFalse(
                any(
                    thread.is_alive()
                    and thread.name
                    in {"sciretriever-playwright-engine", "sciretriever-playwright-events"}
                    for thread in threading.enumerate()
                )
            )

    def test_stalled_https_is_cancelled_or_timed_out_and_cleans_every_runtime(self) -> None:
        page = b"<!doctype html><html><body>stalled fixture</body></html>"
        with tempfile.TemporaryDirectory(prefix="sciretriever-playwright-stall-") as raw_root:
            root = Path(raw_root).resolve(strict=True)
            profile = root / "profile"
            profile.mkdir(mode=0o700)
            certificate, key = _certificate(root)
            state = _ServerState(page, _pdf())
            server = ThreadingHTTPServer(("127.0.0.1", 0), _handler(state))
            tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            tls.load_cert_chain(certificate, key)
            server.socket = tls.wrap_socket(server.socket, server_side=True)
            server_thread = threading.Thread(target=server.serve_forever, daemon=True)
            server_thread.start()
            previous_certificate = os.environ.get("SSL_CERT_FILE")
            os.environ["SSL_CERT_FILE"] = os.fspath(certificate)
            try:
                port = server.server_port
                origin = f"https://{_HOSTNAME}:{port}"
                target = f"{origin}/stall"
                for expected_code in ("cancelled", "timeout"):
                    with self.subTest(expected_code=expected_code):
                        state.stall_started.clear()
                        state.stall_released.clear()
                        state.stall_finished.clear()
                        cancellation = threading.Event()
                        broker = BrowserSessionBroker()
                        client = BrowserClient(
                            factory=PlaywrightBrowserFactory(),
                            resolver=_Resolver(),
                            coordinator=AccessCoordinator(),
                            destination_policy=DestinationPolicy(
                                allowed_classes=frozenset({AddressClass.LOOPBACK}),
                                allowed_addresses=frozenset({"127.0.0.1"}),
                                allowed_ports=frozenset({("https", port)}),
                            ),
                            operator_profile=_Profile(profile),
                            session_broker=broker,
                        )

                        def release_fixture() -> None:
                            if not state.stall_started.wait(8):
                                state.stall_released.set()
                                return
                            if expected_code == "cancelled":
                                cancellation.set()
                                time.sleep(0.05)
                            else:
                                time.sleep(3.25)
                            state.stall_released.set()

                        releaser = threading.Thread(target=release_fixture, daemon=True)
                        releaser.start()
                        started = time.monotonic()
                        try:
                            result = client.run(
                                AccessScope("publisher-fixture", "web"),
                                BrowserRequest(
                                    url=target,
                                    timeout_seconds=3.0 if expected_code == "timeout" else 15.0,
                                    max_response_bytes=8 * 1024 * 1024,
                                ),
                                AccessPolicy(max_concurrency=1),
                                destination_guard=_DestinationGuard(origin),
                                session_key="publisher-fixture",
                                cancel_event=cancellation,
                            )
                        finally:
                            state.stall_released.set()
                            releaser.join(10)
                            broker.close()
                        self.assertIsInstance(result, AccessFailure)
                        assert isinstance(result, AccessFailure)
                        self.assertEqual(result.code, expected_code)
                        self.assertLess(time.monotonic() - started, 8.0)
                        self.assertTrue(state.stall_finished.wait(5))
                        self.assertEqual(broker._entries, {})
            finally:
                if previous_certificate is None:
                    os.environ.pop("SSL_CERT_FILE", None)
                else:
                    os.environ["SSL_CERT_FILE"] = previous_certificate
                server.shutdown()
                server.server_close()
                server_thread.join(10)
            self.assertFalse(server_thread.is_alive())
            self.assertFalse(
                any(
                    thread.is_alive()
                    and thread.name
                    in {"sciretriever-playwright-engine", "sciretriever-playwright-events"}
                    for thread in threading.enumerate()
                )
            )


if __name__ == "__main__":
    unittest.main()
