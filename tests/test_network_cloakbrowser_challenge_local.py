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
from unittest import mock
from urllib.parse import parse_qs, urlsplit

from sciretriever.acquisition.browser_state import BrowserRunState
from sciretriever.acquisition.sources.browser import (
    ControlledBrowserPdfSource,
    _BrowserAction,
    _RuleCaptureGuard,
    build_browser_rule_destination_guard,
)
from sciretriever.acquisition.sources.browser_rules import (
    BrowserActionKind,
    BrowserChallengeResourceProfile,
    BrowserPageMarker,
    BrowserPageMarkerKind,
    BrowserRuleAction,
    BrowserRuleCatalog,
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
    BrowserBudget,
    BrowserCaptureGuard,
    BrowserClient,
    BrowserDestinationGuard,
    BrowserFlowController,
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
            delay = 1200 if mode == "late" else 350
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


class _BrokerRunner:
    """Give the Acquisition Source a stable Broker lane without widening it."""

    def __init__(self, client: BrowserClient, session_key: str = "challenge-fixture") -> None:
        self._client = client
        self._session_key = session_key

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
        budget: BrowserBudget | None = None,
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
            budget=budget,
            timeout_seconds=timeout_seconds,
            cancel_event=cancel_event,
        )


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
        actions=(BrowserRuleAction(kind=BrowserActionKind.WAIT_FOR_ANY_CAPTURE),),
        max_actions=1,
        page_markers=(
            BrowserPageMarker(
                marker_id="challenge",
                kind=BrowserPageMarkerKind.CHALLENGE_REQUIRED,
                css_selectors=("#challenge-running",),
                text_markers=(("title", "just a moment"),),
            ),
            BrowserPageMarker(
                marker_id="access-denied",
                kind=BrowserPageMarkerKind.ACCESS_DENIED,
                css_selectors=("#denied",),
                response_statuses=(403,),
            ),
            BrowserPageMarker(
                marker_id="article-ready",
                kind=BrowserPageMarkerKind.ENTITLED,
                css_selectors=("#article-ready",),
            ),
        ),
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

    def test_real_cloudflare_shaped_lifecycle(self) -> None:
        """Exercise CONNECT, route, iframe, JS navigation and Acquisition states."""

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
                runner = _BrokerRunner(client)
                rule = _rule(fixture.origin, fixture.challenge_origin)
                source = ControlledBrowserPdfSource(
                    runner=runner,
                    rule_catalog=BrowserRuleCatalog((rule,)),
                )

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

                try:
                    with (
                        self.assertLogs(
                            "sciretriever.acquisition.sources.browser",
                            level="DEBUG",
                        ) as captured,
                    ):
                        result, state, failure, _capture_guard = source._run_action(
                            action("/challenge-auto")
                        )
                    self.assertIsInstance(
                        result,
                        BrowserCaptureBatch,
                        f"result={result!r} state={state.state!r} "
                        f"failure={None if failure is None else failure.code!r}",
                    )
                    assert isinstance(result, BrowserCaptureBatch)
                    self.assertEqual(state.state, BrowserRunState.PDF_CAPTURED)
                    self.assertIsNone(failure)
                    self.assertEqual(b"".join(result.captures[0].stream.chunks), _PDF)
                    self.assertEqual(result.captures[0].kind, BrowserCaptureKind.RESPONSE)
                    output = "\n".join(captured.output)
                    self.assertIn("outcome=cleared", output)
                    self.assertIn("resource_admitted=", output)
                    self.assertNotIn(_CHALLENGE_BODY.decode(), output)
                    self.assertNotIn("Just a Moment", output)

                    turnstile_result, turnstile_state, turnstile_failure, _ = source._run_action(
                        action("/challenge-turnstile")
                    )
                    self.assertIsInstance(turnstile_result, BrowserCaptureBatch)
                    assert isinstance(turnstile_result, BrowserCaptureBatch)
                    self.assertEqual(turnstile_state.state, BrowserRunState.PDF_CAPTURED)
                    self.assertIsNone(turnstile_failure)
                    self.assertEqual(b"".join(turnstile_result.captures[0].stream.chunks), _PDF)

                    with self.assertLogs(
                        "sciretriever.acquisition.sources.browser",
                        level="INFO",
                    ) as interaction_logs:
                        (
                            interaction_result,
                            interaction_state,
                            interaction_failure,
                            _,
                        ) = source._run_action(action("/challenge-interaction"))
                    self.assertIsInstance(interaction_result, AccessFailure)
                    assert isinstance(interaction_result, AccessFailure)
                    self.assertEqual(interaction_result.code, "no-download")
                    self.assertEqual(interaction_state.state, BrowserRunState.CHALLENGE_REQUIRED)
                    self.assertIsNotNone(interaction_failure)
                    assert interaction_failure is not None
                    self.assertEqual(
                        interaction_failure.code,
                        "acquisition-browser-challenge-interaction-required",
                    )
                    interaction_output = "\n".join(interaction_logs.output)
                    self.assertIn("outcome=interaction-required", interaction_output)
                    self.assertIn("evidence_kind=interaction-control", interaction_output)
                    self.assertIn("manual verification control", interaction_output)

                    with (
                        mock.patch(
                            "sciretriever.acquisition.sources.browser._CHALLENGE_SETTLE_SECONDS",
                            0.5,
                        ),
                        self.assertLogs(
                            "sciretriever.acquisition.sources.browser",
                            level="INFO",
                        ) as timeout_logs,
                    ):
                        timeout_result, timeout_state, timeout_failure, _ = source._run_action(
                            action("/challenge-timeout")
                        )
                    self.assertIsInstance(timeout_result, AccessFailure)
                    assert isinstance(timeout_result, AccessFailure)
                    self.assertEqual(timeout_result.code, "no-download")
                    self.assertEqual(timeout_state.state, BrowserRunState.ACCESS_DENIED)
                    self.assertIsNotNone(timeout_failure)
                    assert timeout_failure is not None
                    self.assertEqual(
                        timeout_failure.code,
                        "acquisition-browser-challenge-settle-timeout",
                    )
                    timeout_output = "\n".join(timeout_logs.output)
                    self.assertIn("outcome=settle-timeout", timeout_output)
                    self.assertIn("bounded wait", timeout_output)

                    with self.assertLogs(
                        "sciretriever.acquisition.sources.browser",
                        level="INFO",
                    ) as blocked_logs:
                        blocked_result, blocked_state, blocked_failure, _ = source._run_action(
                            action("/challenge-blocked")
                        )
                    self.assertIsInstance(blocked_result, AccessFailure)
                    assert isinstance(blocked_result, AccessFailure)
                    self.assertEqual(blocked_result.code, "no-download")
                    self.assertEqual(blocked_state.state, BrowserRunState.ACCESS_DENIED)
                    self.assertIsNotNone(blocked_failure)
                    assert blocked_failure is not None
                    self.assertEqual(
                        blocked_failure.code,
                        "acquisition-browser-challenge-resource-blocked",
                    )
                    blocked_output = "\n".join(blocked_logs.output)
                    self.assertIn("outcome=resource-blocked", blocked_output)
                    self.assertIn("local safety rules", blocked_output)

                    with self.assertLogs(
                        "sciretriever.acquisition.sources.browser",
                        level="INFO",
                    ) as body_logs:
                        body_result, body_state, body_failure, _ = source._run_action(
                            action("/challenge-body")
                        )
                    self.assertIsInstance(body_result, AccessFailure)
                    assert isinstance(body_result, AccessFailure)
                    self.assertEqual(body_result.code, "policy")
                    self.assertEqual(body_state.state, BrowserRunState.ACCESS_DENIED)
                    self.assertIsNotNone(body_failure)
                    assert body_failure is not None
                    self.assertEqual(
                        body_failure.code,
                        "acquisition-browser-challenge-resource-blocked",
                    )
                    self.assertFalse(
                        isinstance(body_result, BrowserCaptureBatch),
                        "challenge PDF body must never cross the capture boundary",
                    )
                    self.assertIn("outcome=resource-blocked", "\n".join(body_logs.output))

                    with self.assertLogs(
                        "sciretriever.acquisition.sources.browser",
                        level="DEBUG",
                    ) as denied_logs:
                        denied_result, denied_state, denied_failure, _ = source._run_action(
                            action("/challenge-403")
                        )
                    self.assertIsInstance(denied_result, AccessFailure)
                    assert isinstance(denied_result, AccessFailure)
                    self.assertEqual(denied_result.code, "no-download")
                    self.assertEqual(denied_state.state, BrowserRunState.ACCESS_DENIED)
                    self.assertIsNone(denied_failure)
                    denied_output = "\n".join(denied_logs.output)
                    self.assertIn("event=browser-flow-finished", denied_output)
                    self.assertIn("outcome=access-denied", denied_output)
                    self.assertIn("Publisher denied", denied_output)
                    self.assertIn("http_status=403", denied_output)

                    escape_guard = build_browser_rule_destination_guard(
                        rule,
                        fixture.origin + "/article",
                    )
                    escape = client.run(
                        AccessScope("cloudflare-local-fixture", "web"),
                        BrowserRequest(
                            url=fixture.origin + "/article",
                            timeout_seconds=10.0,
                            max_response_bytes=1024 * 1024,
                        ),
                        AccessPolicy(max_concurrency=1),
                        controller=_FlowController(
                            lambda session: session.open_verified_locator(
                                f"https://unknown-origin.invalid:{port}/escape"
                            )
                        ),
                        destination_guard=escape_guard,
                        capture_guard=_RuleCaptureGuard(action("/article")),
                        session_key="challenge-escape",
                    )
                    self.assertIsInstance(escape, AccessFailure)
                    assert isinstance(escape, AccessFailure)
                    self.assertEqual(escape.code, "policy")

                    cancel = threading.Event()
                    cancelled_source = ControlledBrowserPdfSource(
                        runner=runner,
                        rule_catalog=BrowserRuleCatalog((rule,)),
                        cancel_event=cancel,
                    )
                    timer = threading.Timer(0.2, cancel.set)
                    timer.start()
                    try:
                        cancelled, _cancelled_state, _cancelled_failure, _ = (
                            cancelled_source._run_action(action("/challenge-late"))
                        )
                    finally:
                        timer.cancel()
                        timer.join(2)
                    self.assertIsInstance(cancelled, AccessFailure)
                    assert isinstance(cancelled, AccessFailure)
                    self.assertEqual(cancelled.code, "cancelled")
                    self.assertIsNone(_cancelled_failure)
                    self.assertFalse(fixture.state.late_navigation.wait(0.2))

                    with fixture.state.lock:
                        paths = tuple(path for _host, path, _mode in fixture.state.requests)
                        statuses = tuple(fixture.state.statuses)
                    self.assertIn("/cdn-cgi/challenge-platform/frame", paths)
                    self.assertIn("/cdn-cgi/challenge-platform/challenge.js", paths)
                    self.assertIn("/cdn-cgi/challenge-platform/challenge.gif", paths)
                    self.assertIn("/turnstile/v0/api.js", paths)
                    # The unreviewed challenge dependency is rejected at the
                    # route admission boundary, before transport I/O.  Its
                    # absence from the fixture server is therefore expected;
                    # the stable resource-blocked failure above proves this
                    # was an intentional policy decision rather than a
                    # missing browser request.
                    self.assertNotIn("/cdn-cgi/other/unreviewed.js", paths)
                    self.assertIn("/cdn-cgi/challenge-platform/challenge.pdf", paths)
                    self.assertIn(("/challenge-403", 403), statuses)
                    self.assertIn(("/article", 200), statuses)
                finally:
                    broker.close()


if __name__ == "__main__":
    unittest.main()
