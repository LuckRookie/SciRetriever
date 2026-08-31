"""Opt-in, local-only Cloudflare-shaped CloakBrowser acceptance fixture.

The fixture is deliberately synthetic: a Publisher HTTPS page embeds a
third-party challenge iframe, the iframe loads reviewed resources, and a
small JavaScript message causes a delayed top-frame navigation to the article.
The test never contacts Cloudflare or any other external host.  It is skipped
unless the caller explicitly supplies the already-installed Cloak runtime via
``SCIRETRIEVER_TEST_CLOAK_HOME``.
"""

from __future__ import annotations

import os
import ssl
import tempfile
import threading
import unittest
from collections.abc import Callable, Iterable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from sciretriever.acquisition.sources.browser import (
    BrowserRuleDestinationGuard,
    _BrowserAction,
    _RuleCaptureGuard,
    build_browser_rule_destination_guard,
)
from sciretriever.acquisition.sources.browser_rules import (
    BrowserChallengeResourceProfile,
    BrowserSiteRule,
)
from sciretriever.configuration import initialize_browser_profile
from sciretriever.configuration.cloak_runtime import CloakRuntimeManager
from sciretriever.model.access import (
    AccessFailure,
    BrowserCaptureBatch,
    BrowserCaptureKind,
    BrowserRequest,
    BrowserResult,
)
from sciretriever.network.admission import AccessCoordinator, AccessPolicy, AccessScope
from sciretriever.network.browser import (
    BrowserClient,
)
from sciretriever.network.browser_control import (
    BrowserActionOutcome,
    BrowserActionReceipt,
    BrowserControlSession,
    BrowserObservation,
    BrowserPageState,
    Stop,
    WaitForChange,
)
from sciretriever.network.browser_sessions import BrowserSessionBroker
from sciretriever.network.cloakbrowser import CloakBrowserFactory, cloakbrowser_runtime_availability
from sciretriever.network.policy import AddressClass, DestinationPolicy
from tests.browser_https_fixture import HOSTNAME as _HOSTNAME
from tests.browser_https_fixture import certificate as _certificate

_RUNTIME_HOME_ENV = "SCIRETRIEVER_TEST_CLOAK_HOME"
_CHALLENGE_HOSTNAME = "challenges.cloudflare.com"
_PDF = b"%PDF-1.7\n% cloudflare-shaped fixture\n%%EOF\n"
_CHALLENGE_BODY = b"PRIVATE-CHALLENGE-BODY-SENTINEL"
_CHALLENGE_IMAGE = (
    b"GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff!\xf9\x04\x01\x00\x00\x00\x00"
    b",\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;"
)


class _FlowController:
    """Typed Browser controller fixture for one capability-only flow."""

    def __init__(self, flow: Callable[..., object]) -> None:
        if not callable(flow):
            raise TypeError("flow must be callable")
        self._flow = flow

    def run(self, session: object) -> None:
        result = self._flow(session)
        del result


class _FixtureState:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.requests: list[tuple[str, str, str]] = []
        self.statuses: list[tuple[str, int]] = []
        self.late_navigation = threading.Event()
        self.challenge_origin = ""

    def record(self, host: str, path: str, mode: str, status: int) -> None:
        with self.lock:
            self.requests.append((host, path, mode))
            self.statuses.append((path, status))
            if path == "/article" and mode == "late":
                self.late_navigation.set()


class _ChallengeHandler(BaseHTTPRequestHandler):
    """One local server serving both the Publisher and challenge authorities."""

    protocol_version = "HTTP/1.0"
    fixture_state: _FixtureState

    def do_GET(self) -> None:  # noqa: N802
        state = self.fixture_state
        parsed = urlsplit(self.path)
        path = parsed.path
        query = parse_qs(parsed.query, keep_blank_values=True)
        mode = query.get("mode", [""])[0]
        host = self.headers.get("Host", "")
        if path.startswith("/challenge-"):
            mode = path.removeprefix("/challenge-")
        if path == "/article":
            self._article(mode)
            return
        if path == "/article.pdf":
            self._send(_PDF, "application/pdf")
            return
        if path == "/challenge-403":
            self._challenge_status(mode, status=403)
            return
        if path.startswith("/challenge-"):
            self._challenge_page(mode)
            return
        if path == "/cdn-cgi/challenge-platform/frame":
            self._challenge_frame(mode)
            return
        if path in {
            "/cdn-cgi/challenge-platform/challenge.js",
            "/turnstile/v0/api.js",
            "/cdn-cgi/challenge-platform/challenge.gif",
        }:
            self._challenge_resource(path, mode)
            return
        if path == "/cdn-cgi/challenge-platform/challenge.pdf":
            self._send(_CHALLENGE_BODY, "application/pdf")
            return
        if path == "/cdn-cgi/other/unreviewed.js":
            self._send(b"unreviewed", "text/javascript; charset=utf-8")
            return
        self.send_error(404)
        state.record(host, path, mode, 404)

    def _send(self, body: bytes, media_type: str, *, status: int = 200) -> None:
        self.send_response(status)
        self.send_header("Content-Type", media_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except OSError:
            pass
        self.fixture_state.record(
            self.headers.get("Host", ""),
            urlsplit(self.path).path,
            parse_qs(urlsplit(self.path).query, keep_blank_values=True).get("mode", [""])[0],
            status,
        )

    def _article(self, mode: str) -> None:
        body = b"""<!doctype html><html><body>
        <div id='article-ready'>article</div>
        <script>
          fetch('/article.pdf').catch(() => {});
        </script>
        </body></html>"""
        self._send(body, "text/html; charset=utf-8")

    def _challenge_page(self, mode: str) -> None:
        interaction = (
            "<div id='challenge-form' data-captcha='fixture'>Please verify</div>"
            if mode == "interaction"
            else ""
        )
        iframe = (
            f"<iframe src='{self.fixture_state.challenge_origin}"
            f"/cdn-cgi/challenge-platform/frame?mode={mode}'></iframe>"
        )
        body = (
            "<!doctype html><html><head><title>Just a Moment</title></head><body>"
            "<div id='challenge-running'>Checking your browser</div>"
            + interaction
            + iframe
            + "<script>window.addEventListener('message', (event) => {"
            "if (event.data === 'fixture-clear') window.location.href='/article';"
            "});</script></body></html>"
        ).encode()
        self._send(body, "text/html; charset=utf-8")

    def _challenge_status(self, mode: str, *, status: int) -> None:
        body = (
            "<!doctype html><html><head><title>Access denied</title></head><body>"
            "<div id='denied'>Publisher denied this request</div></body></html>"
        ).encode()
        self._send(body, "text/html; charset=utf-8", status=status)

    def _challenge_frame(self, mode: str) -> None:
        script_path = (
            "/turnstile/v0/api.js"
            if mode == "turnstile"
            else "/cdn-cgi/challenge-platform/challenge.js"
        )
        body = (
            "<!doctype html><html><body><img id='challenge-image' "
            "src='/cdn-cgi/challenge-platform/challenge.gif?mode=" + mode + "'><script "
            "src='" + script_path + "?mode=" + mode + "'></script></body></html>"
        ).encode()
        self._send(body, "text/html; charset=utf-8")

    def _challenge_resource(self, path: str, mode: str) -> None:
        if path == "/cdn-cgi/challenge-platform/challenge.gif":
            self._send(_CHALLENGE_IMAGE, "image/gif")
            return
        if mode == "blocked":
            script = "fetch('/cdn-cgi/other/unreviewed.js').catch(() => {});"
        elif mode == "body":
            script = "fetch('/cdn-cgi/challenge-platform/challenge.pdf').catch(() => {});"
        elif mode in {"auto", "late", "turnstile"}:
            delay = 1200
            script = (
                "const image = document.getElementById('challenge-image');"
                "const clear = () => window.setTimeout("
                "() => parent.postMessage('fixture-clear', '*'), " + str(delay) + ");"
                "if (image.complete && image.naturalWidth > 0) clear();"
                "else image.addEventListener('load', clear, {once: true});"
            )
        else:
            script = ""
        self._send((script + "\n").encode(), "text/javascript; charset=utf-8")

    def log_message(self, format: str, *args: object) -> None:
        del format, args


def _handler(state: _FixtureState) -> type[BaseHTTPRequestHandler]:
    class Handler(_ChallengeHandler):
        fixture_state = state

    return Handler


class _LocalChallengeServer:
    def __init__(self, root: Path) -> None:
        certificate, key = _certificate(root)
        self.state = _FixtureState()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _handler(self.state))
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(certificate, key)
        self.server.socket = tls.wrap_socket(self.server.socket, server_side=True)
        port = self.server.server_port
        self.origin = f"https://{_HOSTNAME}:{port}"
        self.challenge_origin = f"https://{_CHALLENGE_HOSTNAME}:{port}"
        self.state.challenge_origin = self.challenge_origin
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> _LocalChallengeServer:
        self.thread.start()
        return self

    def __exit__(self, *unused: object) -> None:
        del unused
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(10)
        if self.thread.is_alive():
            raise AssertionError("local challenge fixture server did not stop")


class _Resolver:
    def __init__(self, *hostnames: str) -> None:
        self._hostnames = frozenset(hostnames)

    def resolve(self, hostname: str) -> Iterable[str]:
        if hostname not in self._hostnames:
            raise RuntimeError("challenge fixture hostname was not admitted")
        return ("127.0.0.1",)


def _destination_policy(port: int) -> DestinationPolicy:
    return DestinationPolicy(
        allowed_classes=frozenset({AddressClass.LOOPBACK}),
        allowed_addresses=frozenset({"127.0.0.1"}),
        allowed_ports=frozenset({("https", port)}),
    )


def _rule(origin: str, challenge_origin: str) -> BrowserSiteRule:
    return BrowserSiteRule(
        rule_id="cloudflare-local-fixture",
        revision=1,
        landing_origin=origin,
        allowed_origins=(origin,),
        web_scope_provider_name="cloudflare-local-fixture",
        capture_url_prefixes=(origin + "/article.pdf",),
        challenge_resource_profile=BrowserChallengeResourceProfile(
            # This is an explicitly test-only profile.  Production Cloudflare
            # profiles remain the HTTPS/443 origin from cloudflare_challenge_profile().
            origin=challenge_origin,
            path_prefixes=(
                challenge_origin + "/cdn-cgi/challenge-platform/",
                challenge_origin + "/turnstile/v0/",
            ),
            resource_types=("document", "script", "fetch", "xhr", "image"),
            interaction_selectors=("#challenge-form",),
            settling_selectors=("#challenge-running",),
        ),
    )


class CloakBrowserCloudflareChallengeAcceptanceTests(unittest.TestCase):
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

    def test_real_cloudflare_shaped_unified_control(self) -> None:  # noqa: C901
        """Exercise guarded resources through the ordinary control session."""

        with tempfile.TemporaryDirectory(prefix="sciretriever-cloak-challenge-") as raw:
            root = Path(raw)
            profile_home = root / "profile-home"
            profile_home.mkdir(mode=0o700)
            profile = initialize_browser_profile("challenge-profile", home=profile_home)
            factory = CloakBrowserFactory(profile, self._runtime, ignore_https_errors=True)
            broker = BrowserSessionBroker()
            server_root = root / "server"
            server_root.mkdir(mode=0o700)
            with _LocalChallengeServer(server_root) as fixture:
                port = int(urlsplit(fixture.origin).port or 443)
                client = BrowserClient(
                    factory=factory,
                    resolver=_Resolver(_HOSTNAME, _CHALLENGE_HOSTNAME),
                    coordinator=AccessCoordinator(),
                    destination_policy=_destination_policy(port),
                    session_broker=broker,
                )
                rule = _rule(fixture.origin, fixture.challenge_origin)

                def action(path: str) -> _BrowserAction:
                    locator = fixture.origin + path
                    return _BrowserAction(
                        rule=rule,
                        start_url=locator,
                        evidence_kind="cloudflare-fixture",
                        landing_url=locator,
                        identifiers=(),
                        identity=locator,
                    )

                def control_session(session: object) -> BrowserControlSession:
                    factory_method = getattr(session, "control_session", None)
                    if not callable(factory_method):
                        raise AssertionError("fixture session lost its control capability")
                    value = factory_method()
                    if not isinstance(value, BrowserControlSession):
                        raise AssertionError("fixture control session violated its contract")
                    return value

                def run(
                    path: str,
                    flow: Callable[[object], object],
                    *,
                    cancel_event: threading.Event | None = None,
                ) -> tuple[BrowserResult, BrowserRuleDestinationGuard]:
                    current_action = action(path)
                    capture_guard = _RuleCaptureGuard(current_action)
                    destination_guard = build_browser_rule_destination_guard(
                        rule,
                        current_action.start_url,
                        capture_guard.rebind_landing,
                    )
                    result = client.run(
                        AccessScope("cloudflare-local-fixture", "web"),
                        BrowserRequest(
                            url=current_action.start_url,
                            timeout_seconds=10.0,
                            max_response_bytes=1024 * 1024,
                        ),
                        AccessPolicy(max_concurrency=1),
                        controller=_FlowController(flow),
                        destination_guard=destination_guard,
                        capture_guard=capture_guard,
                        session_key=f"challenge-{path.removeprefix('/')}",
                        cancel_event=cancel_event,
                    )
                    return result, destination_guard

                def wait_for_clear(
                    observations: list[BrowserObservation],
                    receipts: list[BrowserActionReceipt],
                ) -> Callable[[object], None]:
                    def flow(session: object) -> None:
                        control = control_session(session)
                        first = control.observe(page_state=BrowserPageState.CHALLENGE)
                        observations.append(first)
                        receipt = control.execute(
                            WaitForChange(
                                article_token=first.article_token,
                                page_id=first.page_id,
                                revision=first.revision,
                            ),
                            first,
                            timeout_seconds=5.0,
                        )
                        receipts.append(receipt)
                        observations.append(control.observe(page_state=BrowserPageState.NORMAL))

                    return flow

                def stop_on(page_state: BrowserPageState) -> Callable[[object], None]:
                    def flow(session: object) -> None:
                        control = control_session(session)
                        observation = control.observe(page_state=page_state)
                        control.execute(
                            Stop(
                                article_token=observation.article_token,
                                page_id=observation.page_id,
                                revision=observation.revision,
                                reason="fixture-stop",
                            ),
                            observation,
                            timeout_seconds=1.0,
                        )

                    return flow

                try:
                    auto_observations: list[BrowserObservation] = []
                    auto_receipts: list[BrowserActionReceipt] = []
                    auto, auto_guard = run(
                        "/challenge-auto",
                        wait_for_clear(auto_observations, auto_receipts),
                    )
                    self.assertIsInstance(auto, BrowserCaptureBatch)
                    assert isinstance(auto, BrowserCaptureBatch)
                    self.assertEqual(b"".join(auto.captures[0].stream.chunks), _PDF)
                    self.assertEqual(auto.captures[0].kind, BrowserCaptureKind.RESPONSE)
                    self.assertEqual(
                        [value.page_state for value in auto_observations],
                        [BrowserPageState.CHALLENGE, BrowserPageState.NORMAL],
                    )
                    self.assertIn(
                        auto_receipts[0].outcome,
                        {BrowserActionOutcome.APPLIED, BrowserActionOutcome.CAPTURE},
                    )
                    admitted, blocked = auto_guard.challenge_resource_counts()
                    self.assertGreater(admitted, 0)
                    self.assertEqual(blocked, 0)

                    turnstile, turnstile_guard = run(
                        "/challenge-turnstile",
                        wait_for_clear([], []),
                    )
                    self.assertIsInstance(turnstile, BrowserCaptureBatch)
                    assert isinstance(turnstile, BrowserCaptureBatch)
                    self.assertEqual(b"".join(turnstile.captures[0].stream.chunks), _PDF)
                    self.assertGreater(turnstile_guard.challenge_resource_counts()[0], 0)

                    interaction, interaction_guard = run(
                        "/challenge-interaction",
                        stop_on(BrowserPageState.CHALLENGE),
                    )
                    self.assertIsInstance(interaction, AccessFailure)
                    assert isinstance(interaction, AccessFailure)
                    self.assertEqual(interaction.code, "no-download")
                    self.assertGreater(interaction_guard.challenge_resource_counts()[0], 0)

                    blocked_result, blocked_guard = run(
                        "/challenge-blocked",
                        stop_on(BrowserPageState.CHALLENGE),
                    )
                    self.assertIsInstance(blocked_result, AccessFailure)
                    self.assertGreater(blocked_guard.challenge_resource_counts()[1], 0)

                    body_result, body_guard = run(
                        "/challenge-body",
                        stop_on(BrowserPageState.CHALLENGE),
                    )
                    self.assertIsInstance(body_result, AccessFailure)
                    self.assertFalse(isinstance(body_result, BrowserCaptureBatch))
                    self.assertGreater(body_guard.challenge_resource_counts()[1], 0)

                    denied, denied_guard = run(
                        "/challenge-403",
                        stop_on(BrowserPageState.ACCESS_DENIED),
                    )
                    self.assertIsInstance(denied, AccessFailure)
                    assert isinstance(denied, AccessFailure)
                    self.assertEqual(denied.code, "no-download")
                    self.assertEqual(denied_guard.challenge_resource_counts(), (0, 0))

                    escape_guard = build_browser_rule_destination_guard(
                        rule,
                        fixture.origin + "/article",
                    )

                    def escape_flow(session: object) -> None:
                        operation = getattr(session, "open_verified_locator", None)
                        if not callable(operation):
                            raise AssertionError("fixture session lost its locator capability")
                        operation(f"https://unknown-origin.invalid:{port}/escape")

                    escape = client.run(
                        AccessScope("cloudflare-local-fixture", "web"),
                        BrowserRequest(
                            url=fixture.origin + "/article",
                            timeout_seconds=10.0,
                            max_response_bytes=1024 * 1024,
                        ),
                        AccessPolicy(max_concurrency=1),
                        controller=_FlowController(escape_flow),
                        destination_guard=escape_guard,
                        capture_guard=_RuleCaptureGuard(action("/article")),
                        session_key="challenge-escape",
                    )
                    self.assertIsInstance(escape, AccessFailure)
                    assert isinstance(escape, AccessFailure)
                    self.assertEqual(escape.code, "policy")

                    cancel = threading.Event()
                    timer = threading.Timer(0.2, cancel.set)
                    timer.start()
                    try:
                        cancelled, _cancelled_guard = run(
                            "/challenge-late",
                            wait_for_clear([], []),
                            cancel_event=cancel,
                        )
                    finally:
                        timer.cancel()
                        timer.join(2)
                    self.assertIsInstance(cancelled, AccessFailure)
                    assert isinstance(cancelled, AccessFailure)
                    self.assertEqual(cancelled.code, "cancelled")
                    self.assertFalse(fixture.state.late_navigation.wait(0.2))

                    with fixture.state.lock:
                        paths = tuple(path for _host, path, _mode in fixture.state.requests)
                        statuses = tuple(fixture.state.statuses)
                    self.assertIn("/cdn-cgi/challenge-platform/frame", paths)
                    self.assertIn("/cdn-cgi/challenge-platform/challenge.js", paths)
                    self.assertIn("/cdn-cgi/challenge-platform/challenge.gif", paths)
                    self.assertIn("/turnstile/v0/api.js", paths)
                    self.assertNotIn("/cdn-cgi/other/unreviewed.js", paths)
                    self.assertIn("/cdn-cgi/challenge-platform/challenge.pdf", paths)
                    self.assertIn(("/challenge-403", 403), statuses)
                    self.assertIn(("/article", 200), statuses)
                finally:
                    broker.close()


if __name__ == "__main__":
    unittest.main()
