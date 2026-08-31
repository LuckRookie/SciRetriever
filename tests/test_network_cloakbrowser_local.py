"""Opt-in, local-only acceptance tests for the real CloakBrowser runtime.

The ordinary test suite deliberately does not install a vendor binary or start
an external browser.  These tests become active only when
``SCIRETRIEVER_TEST_CLOAK_HOME`` points at a runtime that was installed and
verified by :class:`CloakRuntimeManager` (the value is the manager ``home``,
not a cache directory).  A missing, incomplete, or unavailable runtime is a
safe ``unittest`` skip; it is never repaired by the test and no binary is
downloaded.

All browser pages in this module are synthetic HTTPS pages served from a local
loopback server.  No profile outside a temporary directory is touched.  The
test intentionally keeps the JavaScript observation bounded and reports only
booleans, enums, and short browser surface values; it never logs a profile
path, fingerprint seed, cookie value, or page body.
"""

from __future__ import annotations

import hashlib
import json
import os
import ssl
import tempfile
import threading
import unittest
from collections.abc import Callable, Iterable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, cast
from urllib.parse import urlsplit

from sciretriever.acquisition.browser_control import (
    AgentBrowserController,
    BrowserAgentDisposition,
)
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
from sciretriever.configuration import (
    initialize_browser_profile,
    remove_browser_profile,
)
from sciretriever.configuration.cloak_runtime import CloakRuntimeManager
from sciretriever.configuration.errors import ConfigurationError
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
    BrowserOperationLimits,
    _ConnectionBinding,
)
from sciretriever.network.browser_control import (
    BrowserAction,
    BrowserActionReceipt,
    BrowserControlSession,
    BrowserObservation,
    BrowserPageState,
    ClickElement,
)
from sciretriever.network.browser_sessions import BrowserSessionBroker
from sciretriever.network.cloakbrowser import (
    CloakBrowserFactory,
    cloakbrowser_runtime_availability,
)
from sciretriever.network.policy import AddressClass, DestinationPolicy
from tests.browser_https_fixture import HOSTNAME as _CERTIFICATE_HOSTNAME
from tests.browser_https_fixture import certificate as _certificate
from tests.browser_https_fixture import pdf as _pdf

_RUNTIME_HOME_ENV = "SCIRETRIEVER_TEST_CLOAK_HOME"
_HOSTNAME = _CERTIFICATE_HOSTNAME
_PDF = _pdf()


class _FlowController:
    """Typed Browser controller fixture for one capability-only flow."""

    def __init__(self, flow: Callable[..., object]) -> None:
        if not callable(flow):
            raise TypeError("flow must be callable")
        self._flow = flow

    def run(self, session: object) -> None:
        result = self._flow(session)
        del result


class _FixtureMultimodalBrowserAgent:
    """Offline multimodal Agent fixture for the real Browser Agent loop.

    The fixture receives the same bounded request that a provider adapter would
    receive: one screenshot, the closed Browser tools, and a JSON observation.
    It intentionally derives every action from the current opaque element id
    and revision instead of reaching into the Browser session.
    """

    provider_name = "fixture-multimodal-browser"

    def __init__(self) -> None:
        self.turns = 0
        self.image_turns = 0
        self._scroll_requested = False
        self._wait_requested = False

    def execute(self, call: AgentProviderCall) -> AgentToolCall:  # noqa: C901
        self.turns += 1
        if not call.image_parts or not call.tools:
            raise AssertionError("Browser Agent fixture did not receive multimodal tools")
        self.image_turns += 1
        try:
            summary = json.loads(call.text_parts[1].text)
        except (TypeError, ValueError) as error:
            raise AssertionError(
                "Browser Agent fixture received invalid observation JSON"
            ) from error
        if not isinstance(summary, dict):
            raise AssertionError("Browser Agent observation is not an object")
        revision = summary.get("revision")
        article_token = summary.get("article_token")
        page_id = summary.get("page_id")
        elements = summary.get("elements")
        surfaces = summary.get("surfaces")
        if (
            type(revision) is not int
            or type(article_token) is not str
            or type(page_id) is not str
            or not isinstance(elements, list)
            or not isinstance(surfaces, list)
        ):
            raise AssertionError("Browser Agent observation omitted bounded action facts")

        def find(name: str, *, visible: bool | None = None) -> dict[str, object] | None:
            for item in elements:
                if not isinstance(item, dict) or item.get("name") != name:
                    continue
                state = item.get("state")
                if not isinstance(state, str):
                    continue
                is_visible = state.startswith("visible-")
                is_enabled = state == "visible-enabled"
                if visible is not None and is_visible is not visible:
                    continue
                if visible is True and not is_enabled:
                    continue
                return item
            return None

        consent = find("Accept cookies", visible=True)
        pdf = find("Download PDF", visible=True)
        identity: dict[str, object] = {
            "article_token": article_token,
            "page_id": page_id,
            "revision": revision,
        }
        if consent is not None:
            tool_name = "click_element"
            arguments = {
                **identity,
                "surface_id": consent.get("surface_id"),
                "element_id": consent.get("element_id"),
            }
        elif pdf is not None and not self._wait_requested:
            self._wait_requested = True
            tool_name = "wait_for_change"
            arguments = identity
        elif pdf is not None:
            tool_name = "click_element"
            arguments = {
                **identity,
                "surface_id": pdf.get("surface_id"),
                "element_id": pdf.get("element_id"),
            }
        elif not self._scroll_requested:
            self._scroll_requested = True
            surface = next((value for value in surfaces if isinstance(value, dict)), None)
            if surface is None:
                raise AssertionError("Browser Agent observation omitted its page surface")
            tool_name = "scroll_surface"
            arguments = {
                **identity,
                "surface_id": surface.get("surface_id"),
                "delta_y": 500,
            }
        else:
            # Native wheel dispatch can return before a page's scroll listener
            # has run.  Keep the wait on the same closed Browser action seam;
            # no JavaScript or selector is sent to the Agent.
            self._wait_requested = True
            tool_name = "wait_for_change"
            arguments = identity
        encoded = json.dumps(arguments, ensure_ascii=False, separators=(",", ":"))
        return AgentToolCall(
            tool_name=tool_name,
            arguments=encoded,
            provenance=AgentProvenance(
                provider=self.provider_name,
                model=call.model,
                input_sha256=call.input_sha256,
                parameters_sha256=call.input_sha256,
                usage=AgentUsage(output_tokens=1, response_bytes=len(encoded.encode("utf-8"))),
            ),
        )


def _agent_runtime(adapter: _FixtureMultimodalBrowserAgent) -> AgentRuntime:
    return AgentRuntime(
        adapter=adapter,
        browser=AgentRoleBinding(
            role=AgentRole.BROWSER,
            model="fixture-browser-model",
            capabilities=AgentModelCapabilities(
                context_window_tokens=32_768,
                max_output_tokens=512,
                image_input=True,
                tool_decision=True,
                supported_image_media_types=frozenset({"image/png", "image/jpeg", "image/webp"}),
                max_image_count=1,
                max_image_bytes=8 * 1024 * 1024,
            ),
            limits=AgentCallLimits(
                max_prompt_bytes=131_072,
                max_input_bytes=8 * 1024 * 1024,
                max_request_bytes=9 * 1024 * 1024,
                max_response_bytes=1 * 1024 * 1024,
                max_result_bytes=1 * 1024 * 1024,
                max_output_tokens=512,
                context_window_tokens=32_768,
            ),
        ),
    )


class _NormalPageAgentControl:
    def __init__(self, inner: BrowserControlSession) -> None:
        self.inner = inner

    def observe(self) -> BrowserObservation:
        return self.inner.observe(page_state=BrowserPageState.NORMAL)

    def execute(
        self,
        action: BrowserAction,
        observation: BrowserObservation,
        *,
        timeout_seconds: float,
    ) -> BrowserActionReceipt:
        return self.inner.execute(
            action,
            observation,
            timeout_seconds=timeout_seconds,
        )


class _NormalPageAgentControlFactory:
    def open(self, session: object) -> _NormalPageAgentControl:
        control_factory = getattr(session, "control_session", None)
        if not callable(control_factory):
            raise AssertionError("Browser flow did not expose its bounded control session")
        inner = control_factory()
        if not isinstance(inner, BrowserControlSession):
            raise AssertionError("Browser control session violated its neutral contract")
        return _NormalPageAgentControl(inner)


class _Resolver:
    def __init__(self, *hostnames: str) -> None:
        self._hostnames = frozenset(hostnames)

    def resolve(self, hostname: str) -> Iterable[str]:
        if hostname not in self._hostnames:
            raise RuntimeError("fixture hostname was not admitted")
        return ("127.0.0.1",)


class _DestinationGuard:
    def __init__(self, *origins: str) -> None:
        self._origins = tuple(origins)

    def check(self, url: str, kind: BrowserDestinationKind) -> None:
        del kind
        parsed = urlsplit(url)
        if not any(parsed.scheme + "://" + parsed.netloc == origin for origin in self._origins):
            raise ValueError("fixture destination escaped its reviewed origin")

    def connection_origins(self) -> tuple[str, ...]:
        return self._origins


class _CaptureGuard:
    def __init__(
        self,
        origin: str,
        kind: BrowserCaptureKind,
        *,
        path: str = "/article.pdf",
    ) -> None:
        self._url = origin + path
        self._kind = kind
        self.calls: list[tuple[str, BrowserCaptureKind, str]] = []

    def allows(self, url: str, kind: BrowserCaptureKind, media_type: str) -> bool:
        self.calls.append((url, kind, media_type))
        return url == self._url and kind is self._kind and media_type == "application/pdf"


class _State:
    def __init__(self) -> None:
        self.paths: list[str] = []
        self.targets: list[str] = []
        self.cookies: list[str] = []
        self.lock = threading.Lock()
        self.popup_seen = threading.Event()
        self.stall_started = threading.Event()
        self.stall_released = threading.Event()

    def record(self, target: str, path: str, cookie: str) -> None:
        with self.lock:
            self.targets.append(target)
            self.paths.append(path)
            if path == "/popup":
                self.popup_seen.set()
            if cookie:
                self.cookies.append(cookie)


class _Handler(BaseHTTPRequestHandler):
    """Synthetic Publisher page with fetch, popup, iframe, SW, and PDF paths."""

    protocol_version = "HTTP/1.0"
    fixture_state: _State
    fixture_pdf: bytes = _PDF

    def do_GET(self) -> None:  # noqa: N802
        state = self.fixture_state
        target = self.path
        path = urlsplit(target).path
        state.record(target, path, self.headers.get("Cookie", ""))
        routes = {
            "/profile": self._profile,
            "/article": self._article,
            "/agent": self._agent,
            "/agent-replace": self._agent_replace,
            "/article.pdf": self._pdf_response,
            "/redirect": self._redirect,
            "/popup": self._popup,
            "/frame": self._frame,
            "/sw.js": self._service_worker,
            "/sw-resource": self._sw_resource,
            "/data.json": self._data,
            "/stall": self._stall,
        }
        route = routes.get(path)
        if route is None:
            self.send_error(404)
            return
        route()

    def _send(
        self,
        payload: bytes,
        media_type: str,
        *,
        headers: tuple[tuple[str, str], ...] = (),
    ) -> None:
        self.send_response(200)
        self.send_header("Content-Type", media_type)
        self.send_header("Content-Length", str(len(payload)))
        for name, value in headers:
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(payload)

    def _profile(self) -> None:
        # ``__sciretrieverObservation`` is a Promise so the test can await the
        # IndexedDB transaction without an unbounded page wait or page text.
        script = """
        (() => {
          const idb = new Promise((resolve) => {
            try {
              const open = indexedDB.open('sciretriever-local-fixture', 1);
              open.onupgradeneeded = () => {
                open.result.createObjectStore('facts');
              };
              open.onerror = () => resolve(null);
              open.onsuccess = () => {
                const db = open.result;
                const tx = db.transaction('facts', 'readwrite');
                const store = tx.objectStore('facts');
                const get = store.get('seen');
                let prior = null;
                get.onsuccess = () => { prior = get.result ?? null; };
                store.put('ready', 'seen');
                tx.oncomplete = () => { db.close(); resolve(prior); };
                tx.onerror = () => { db.close(); resolve(null); };
              };
            } catch (_) { resolve(null); }
          });
          window.__sciretrieverObservation = (async () => {
            const previous = window.localStorage.getItem('seen');
            const previousCookie = document.cookie.includes('fixture_js=ready');
            window.localStorage.setItem('seen', 'ready');
            const userAgentData = navigator.userAgentData || null;
            const gl = document.createElement('canvas').getContext('webgl');
            let webgl = null;
            if (gl) {
              const debug = gl.getExtension('WEBGL_debug_renderer_info');
              webgl = {
                vendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : null,
                renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null
              };
            }
            const indexeddbPrevious = await idb;
            return {
              webdriver: navigator.webdriver === true,
              userAgent: String(navigator.userAgent).slice(0, 256),
              clientHints: userAgentData ? {
                mobile: userAgentData.mobile === true,
                platform: String(userAgentData.platform || '').slice(0, 64),
                brands: Array.isArray(userAgentData.brands) ?
                  userAgentData.brands.slice(0, 8).map((v) => ({
                    brand: String(v.brand || '').slice(0, 64),
                    version: String(v.version || '').slice(0, 16)
                  })) : []
              } : null,
              platform: String(navigator.platform).slice(0, 64),
              plugins: Array.from(navigator.plugins || []).slice(0, 8).map(
                (plugin) => String(plugin.name || '').slice(0, 64)),
              languages: Array.from(navigator.languages || []).slice(0, 8).map(
                (language) => String(language).slice(0, 32)),
              screen: {
                width: Number(screen.width) || 0,
                height: Number(screen.height) || 0,
                innerWidth: Number(window.innerWidth) || 0,
                innerHeight: Number(window.innerHeight) || 0
              },
              webgl,
              fonts: ['Arial', 'Times New Roman', 'Noto Sans CJK SC', 'Noto Color Emoji']
                .map((font) => [font, document.fonts.check('12px ' + font) === true]),
              locale: String(Intl.DateTimeFormat().resolvedOptions().locale).slice(0, 32),
              timezone: String(Intl.DateTimeFormat().resolvedOptions().timeZone).slice(0, 64),
              cookie: previousCookie,
              localStorage: previous === 'ready',
              indexedDB: indexeddbPrevious === 'ready'
            };
          })();
          // Session cookies are discarded at a full browser shutdown. CBA64
          // verifies persistent Profile storage across cold starts, so this
          // synthetic cookie needs an explicit lifetime.
          document.cookie = 'fixture_js=ready; Max-Age=86400; Secure; SameSite=Lax';
        })();
        """
        body = (
            "<!doctype html><html><body><script>"
            + script
            + "</script><pre id='observation'></pre></body></html>"
        ).encode()
        self._send(
            body,
            "text/html; charset=utf-8",
            headers=(
                (
                    "Set-Cookie",
                    "fixture_session=ready; Max-Age=86400; Secure; HttpOnly; SameSite=Lax",
                ),
            ),
        )

    def _article(self) -> None:
        body = b"""<!doctype html><html><body>
        <div id='ready'>ready</div>
        <iframe src='/frame' title='fixture frame'></iframe>
        <button id='popup' type='button' onclick="window.open('/popup','fixture')">popup</button>
        <button id='pdf' type='button'>pdf</button>
        <button id='attachment' type='button'>attachment</button>
        <script>
          fetch('/data.json').catch(() => {});
          document.querySelector('#pdf').addEventListener('click', () => {
            fetch('/article.pdf?sig=fixture').catch(() => {});
          });
          document.querySelector('#attachment').addEventListener('click', async () => {
            const response = await fetch('/article.pdf');
            const blob = await response.blob();
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = 'article.pdf';
            document.body.append(link);
            link.click();
            window.setTimeout(() => {
              URL.revokeObjectURL(link.href);
              link.remove();
            }, 0);
          });
        </script>
        </body></html>"""
        self._send(
            body,
            "text/html; charset=utf-8",
            headers=(
                ("Set-Cookie", "fixture_session=ready; Secure; HttpOnly; SameSite=Lax"),
                ("Set-Cookie", "fixture_entitlement=ready; Secure; SameSite=Lax"),
            ),
        )

    def _pdf_response(self) -> None:
        self._send(self.fixture_pdf, "application/pdf")

    def _agent(self) -> None:
        # The page starts with a cookie-consent control and a PDF control that
        # is hidden below the fold.  The Browser Agent must use the same
        # request-local observation/action seam to accept cookies, scroll with
        # native wheel input, and click the now-visible PDF button.
        body = b"""<!doctype html><html><body>
        <div id='cookie-banner'>
          <button id='accept-cookies' type='button'>Accept cookies</button>
        </div>
        <div style='height:1800px'></div>
        <button id='agent-pdf' type='button' hidden>Download PDF</button>
        <script>
          const banner = document.querySelector('#cookie-banner');
          document.querySelector('#accept-cookies').addEventListener('click', () => {
            document.cookie = 'agent_cookie=ready; Max-Age=86400; Secure; SameSite=Lax';
            banner.remove();
          });
          window.addEventListener('scroll', () => {
            if (window.scrollY > 200) {
              const pdf = document.querySelector('#agent-pdf');
              pdf.hidden = false;
              // Reordering matching nodes must not retarget the request-local
              // marker/Locator held for this observation.
              document.body.append(pdf);
            }
          });
          document.querySelector('#agent-pdf').addEventListener('click', () => {
            fetch('/article.pdf?agent=fixture').catch(() => {});
          });
        </script>
        </body></html>"""
        self._send(
            body,
            "text/html; charset=utf-8",
            headers=(("Set-Cookie", "fixture_session=ready; Secure; HttpOnly; SameSite=Lax"),),
        )

    def _agent_replace(self) -> None:
        """Page whose control replaces a second observed node in place."""

        body = b"""<!doctype html><html><body>
        <button id='replace-control' type='button'>Replace DOM</button>
        <button id='replace-target' type='button'>Replace target</button>
        <script>
          const control = document.querySelector('#replace-control');
          const original = document.querySelector('#replace-target');
          control.addEventListener('click', () => {
            const replacement = document.createElement('button');
            replacement.type = 'button';
            replacement.textContent = 'Replacement target';
            replacement.id = 'replace-target';
            original.replaceWith(replacement);
          });
        </script>
        </body></html>"""
        self._send(
            body,
            "text/html; charset=utf-8",
            headers=(("Set-Cookie", "fixture_session=ready; Secure; HttpOnly; SameSite=Lax"),),
        )

    def _redirect(self) -> None:
        self.send_response(302)
        self.send_header("Location", "/article")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _popup(self) -> None:
        self._send(b"<!doctype html><html><body>popup</body></html>", "text/html; charset=utf-8")

    def _frame(self) -> None:
        self._send(b"<!doctype html><html><body>frame</body></html>", "text/html; charset=utf-8")

    def _service_worker(self) -> None:
        self._send(
            b"self.addEventListener('fetch', (event) => {"
            b"if (new URL(event.request.url).pathname === '/sw-resource') "
            b"event.respondWith(new Response('service-worker-intercepted', "
            b"{headers:{'Content-Type':'text/plain'}}));"
            b"});",
            "text/javascript; charset=utf-8",
        )

    def _sw_resource(self) -> None:
        self._send(b"service-worker-resource", "text/plain; charset=utf-8")

    def _data(self) -> None:
        self._send(b'{"fixture":true}', "application/json")

    def _stall(self) -> None:
        self.fixture_state.stall_started.set()
        self.fixture_state.stall_released.wait(8)
        try:
            self._send(b"stall-released", "text/plain; charset=utf-8")
        except OSError:
            pass

    def log_message(self, format: str, *args: object) -> None:
        del format, args


def _handler(state: _State) -> type[BaseHTTPRequestHandler]:
    class Handler(_Handler):
        fixture_state = state

    return Handler


def _binding(port: int) -> _ConnectionBinding:
    return _ConnectionBinding(
        scheme="https",
        hostname=_HOSTNAME,
        port=port,
        address="127.0.0.1",
        verified_addresses=("127.0.0.1",),
        # The binding carries the port separately; ``authority`` is the
        # canonical admitted hostname used by BrowserConnectProxy.
        authority=_HOSTNAME,
        tls_server_name=_HOSTNAME,
    )


def _destination_policy(port: int) -> DestinationPolicy:
    return DestinationPolicy(
        allowed_classes=frozenset({AddressClass.LOOPBACK}),
        allowed_addresses=frozenset({"127.0.0.1"}),
        allowed_ports=frozenset({("https", port)}),
    )


def _ensure_home(path: Path) -> Path:
    """Create one temporary Configuration home with owner-only permissions."""

    path.mkdir(parents=True, exist_ok=True)
    path.chmod(0o700)
    return path


def _route_allows(route: object, binding: _ConnectionBinding) -> None:
    cast(Any, route).bind_connection(binding)
    cast(Any, route).continue_()


def _surface_hash(observation: dict[str, object]) -> str:
    """Hash only bounded, non-secret browser surfaces for Profile comparison."""

    selected = {
        field: observation.get(field)
        for field in ("userAgent", "clientHints", "platform", "plugins", "webgl", "fonts")
    }
    payload = json.dumps(selected, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _browser_process_snapshot() -> dict[int, tuple[int, str]]:  # noqa: C901
    """Read a bounded, command-line-free snapshot of this process' Browser descendants."""

    if os.name != "posix":
        return {}
    proc = Path("/proc")
    if not proc.is_dir():
        return {}
    result: dict[int, tuple[int, str]] = {}
    for entry in proc.iterdir():
        if not entry.name.isdigit():
            continue
        try:
            raw = (entry / "stat").read_text(encoding="utf-8", errors="replace")
        except (OSError, UnicodeError):
            continue
        closing = raw.rfind(")")
        if closing <= 0 or closing + 2 >= len(raw):
            continue
        comm = raw[raw.find("(") + 1 : closing]
        fields = raw[closing + 2 :].split()
        if len(fields) < 2:
            continue
        try:
            pid = int(entry.name)
            parent = int(fields[1])
        except ValueError:
            continue
        lowered = comm.casefold()
        if "chrome" in lowered or "chromium" in lowered or "xvfb" in lowered:
            result[pid] = (parent, comm[:64])
    descendants: dict[int, tuple[int, str]] = {}
    pending = [os.getpid()]
    while pending:
        parent = pending.pop()
        for pid, (ppid, comm) in result.items():
            if ppid == parent and pid not in descendants:
                descendants[pid] = (ppid, comm)
                pending.append(pid)
    return descendants


def _assert_no_new_browser_processes(
    testcase: unittest.TestCase,
    baseline: dict[int, tuple[int, str]],
) -> None:
    """Ensure processes created by this test's current process all exited."""

    current = _browser_process_snapshot()
    new = {pid: details for pid, details in current.items() if pid not in baseline}
    testcase.assertFalse(
        new,
        "a Browser/Xvfb descendant remained after fixture cleanup",
    )


class _LocalServer:
    def __init__(self, root: Path) -> None:
        certificate, key = _certificate(root)
        self.state = _State()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _handler(self.state))
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(certificate, key)
        self.server.socket = tls.wrap_socket(self.server.socket, server_side=True)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def origin(self) -> str:
        return f"https://{_HOSTNAME}:{self.server.server_port}"

    def __enter__(self) -> _LocalServer:
        self.thread.start()
        return self

    def __exit__(self, *unused: object) -> None:
        del unused
        self.state.stall_released.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(10)
        if self.thread.is_alive():
            raise AssertionError("local fixture server did not stop")


class CloakBrowserLocalAcceptanceTests(unittest.TestCase):
    """Acceptance gates CBA64/CBA65 against a real, explicitly supplied runtime."""

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
        # Verify the same shared lease used by production launch, then close it
        # before the test starts.  The factory obtains its own lease per cold
        # launch; keeping this probe open would deliberately self-conflict.
        lease = manager.acquire_runtime()
        lease.close()
        cls._runtime = manager

    def _start_factory(
        self,
        profile_home: Path,
        profile_name: str,
        downloads_path: Path,
    ) -> tuple[object, object, object]:
        downloads_path.mkdir(parents=True, exist_ok=True)
        downloads_path.chmod(0o700)
        profile = initialize_browser_profile(profile_name, home=_ensure_home(profile_home))
        factory = CloakBrowserFactory(profile, self._runtime, ignore_https_errors=True)
        process = factory(downloads_path=os.fspath(downloads_path), connection_binding=object())
        context = cast(
            Any,
            process,
        ).new_context(
            downloads_path=os.fspath(downloads_path),
            accept_downloads=True,
            connection_binding=object(),
        )
        return profile, process, context

    def _assert_no_browser_threads(self) -> None:
        names = {
            "sciretriever-cloakbrowser-engine",
            "sciretriever-playwright-events",
            "sciretriever-playwright-engine",
        }
        self.assertFalse(
            any(thread.is_alive() and thread.name in names for thread in threading.enumerate()),
            "a Browser runtime thread remained after fixture cleanup",
        )

    def _fingerprint_observation(
        self,
        profile_home: Path,
        profile_name: str,
        origin: str,
        downloads_path: Path,
    ) -> dict[str, object]:
        profile, process, raw_context = self._start_factory(
            profile_home,
            profile_name,
            downloads_path,
        )
        del profile
        context = cast(Any, raw_context)
        runtime_process = cast(Any, process)
        port = int(urlsplit(origin).port or 443)
        article = context.begin_article(
            lane_key="fingerprint",
            downloads_path=os.fspath(downloads_path),
            connection_binding=_binding(port),
        )
        page = article.new_page()
        try:
            article.route("**/*", lambda route: _route_allows(route, _binding(port)))
            page.goto(origin + "/profile", timeout=30_000)
            script = "() => window.__sciretrieverObservation"
            value = page.engine.call(lambda: cast(Any, page.raw).evaluate(script))
            if not isinstance(value, dict):
                raise AssertionError("fingerprint fixture did not return a bounded object")
            # Force JSON validation so a vendor-specific object never crosses
            # the test boundary, and retain only primitive JSON values.
            encoded = json.dumps(value, ensure_ascii=True, separators=(",", ":"))
            if len(encoded.encode("utf-8")) > 32 * 1024:
                raise AssertionError("fingerprint fixture observation exceeded its bound")
            return cast(dict[str, object], json.loads(encoded))
        finally:
            try:
                article.close()
            finally:
                runtime_process.close()

    def _service_worker_observation(
        self,
        profile_home: Path,
        origin: str,
        downloads_path: Path,
    ) -> dict[str, object]:
        """Prove the controlled context has no active Service Workers."""

        _profile, process, raw_context = self._start_factory(
            profile_home,
            "service-worker-profile",
            downloads_path,
        )
        context = cast(Any, raw_context)
        runtime_process = cast(Any, process)
        port = int(urlsplit(origin).port or 443)
        binding = _binding(port)
        first = context.begin_article(
            lane_key="service-worker-blocked",
            downloads_path=os.fspath(downloads_path),
            connection_binding=binding,
        )
        try:
            try:
                first.route("**/*", lambda route: _route_allows(route, binding))
                first_page = first.new_page()
                first_page.goto(origin + "/article", timeout=30_000)
                worker_count = first_page.engine.call(
                    lambda: len(cast(Any, context.raw).service_workers)
                )
                if type(worker_count) is not int or worker_count < 0:
                    raise AssertionError("service-worker fixture returned an invalid count")
                return {"count": worker_count}
            finally:
                first.close()
        finally:
            runtime_process.close()

    def test_real_profile_has_stable_surfaces_and_persistent_storage(self) -> None:
        """CBA64: same Profile survives three complete process cold starts."""

        with tempfile.TemporaryDirectory(prefix="sciretriever-cloak-local-profile-") as raw:
            root = Path(raw)
            profile_home = _ensure_home(root / "profile-home")
            server_root = root / "server"
            server_root.mkdir()
            locked = initialize_browser_profile("exclusive-profile", home=profile_home)
            first_lease = locked.acquire_runtime()
            try:
                with self.assertRaises(ConfigurationError):
                    locked.acquire_runtime()
            finally:
                first_lease.close()
            disposable = initialize_browser_profile("disposable-profile", home=profile_home)
            disposable_path = disposable.runtime_directory()
            remove_browser_profile("disposable-profile", home=profile_home)
            self.assertFalse(disposable_path.exists())
            process_baseline = _browser_process_snapshot()
            with _LocalServer(server_root) as fixture:
                observations: list[dict[str, object]] = []
                for index in range(3):
                    observations.append(
                        self._fingerprint_observation(
                            profile_home,
                            "stable-profile",
                            fixture.origin,
                            root / f"downloads-{index}",
                        )
                    )
                static_fields = (
                    "webdriver",
                    "userAgent",
                    "clientHints",
                    "platform",
                    "plugins",
                    "languages",
                    "screen",
                    "webgl",
                    "fonts",
                    "locale",
                    "timezone",
                )
                for field in static_fields:
                    self.assertEqual(
                        observations[0].get(field),
                        observations[1].get(field),
                        f"Profile surface changed across cold starts: {field}",
                    )
                    self.assertEqual(
                        observations[1].get(field),
                        observations[2].get(field),
                        f"Profile surface changed across cold starts: {field}",
                    )
                first = observations[0]
                self.assertFalse(cast(bool, first.get("webdriver")))
                platform = cast(str, first.get("platform"))
                user_agent = cast(str, first.get("userAgent"))
                client_hints = cast(dict[str, object], first.get("clientHints"))
                self.assertIn("linux", platform.casefold())
                self.assertIn("linux", user_agent.casefold())
                self.assertIn("linux", cast(str, client_hints.get("platform")).casefold())
                self.assertEqual(
                    first.get("languages"),
                    ["en-US", "en", "zh-CN", "zh", "ja", "ko"],
                )
                screen = cast(dict[str, object], first.get("screen"))
                self.assertEqual(screen.get("width"), 1920)
                self.assertEqual(screen.get("height"), 1080)
                self.assertEqual(first.get("locale"), "en-US")
                self.assertEqual(first.get("timezone"), "UTC")
                fonts = cast(list[list[object]], first.get("fonts"))
                self.assertTrue(fonts and all(item[1] is True for item in fonts))
                plugins = cast(list[object], first.get("plugins"))
                self.assertEqual(
                    len(plugins),
                    5,
                    "the persistent Profile exposed an anomalous PDF plugin surface",
                )
                self.assertFalse(cast(bool, observations[0].get("cookie")))
                self.assertFalse(cast(bool, observations[0].get("localStorage")))
                self.assertFalse(cast(bool, observations[0].get("indexedDB")))
                self.assertTrue(cast(bool, observations[1].get("cookie")))
                self.assertTrue(cast(bool, observations[2].get("cookie")))
                self.assertTrue(cast(bool, observations[1].get("localStorage")))
                self.assertTrue(cast(bool, observations[1].get("indexedDB")))
                self.assertTrue(cast(bool, observations[2].get("localStorage")))
                self.assertTrue(cast(bool, observations[2].get("indexedDB")))

                other = self._fingerprint_observation(
                    root / "other-profile-home",
                    "derived-profile",
                    fixture.origin,
                    root / "downloads-other",
                )
                self.assertNotEqual(
                    _surface_hash(observations[0]),
                    _surface_hash(other),
                    "different generated Profiles did not produce a distinct observed surface",
                )
            self._assert_no_browser_threads()
            _assert_no_new_browser_processes(self, process_baseline)

    def test_real_browserclient_runs_local_https_events_and_budgets(self) -> None:
        """CBA65: exercise the complete BrowserClient/CONNECT/session path locally."""

        with tempfile.TemporaryDirectory(prefix="sciretriever-cloak-local-events-") as raw:
            root = Path(raw)
            profile_home = root / "profile-home"
            server_root = root / "server"
            server_root.mkdir()
            process_baseline = _browser_process_snapshot()
            with _LocalServer(server_root) as fixture:
                worker = self._service_worker_observation(
                    root / "service-worker-home",
                    fixture.origin,
                    root / "service-worker-downloads",
                )
                self.assertEqual(worker.get("count"), 0)
                self.assertNotIn("/sw.js", fixture.state.paths)
                profile = initialize_browser_profile(
                    "events-profile",
                    home=_ensure_home(profile_home),
                )
                factory = CloakBrowserFactory(profile, self._runtime, ignore_https_errors=True)
                broker = BrowserSessionBroker()
                origin = fixture.origin
                port = int(urlsplit(origin).port or 443)
                client = BrowserClient(
                    factory=factory,
                    resolver=_Resolver(_HOSTNAME),
                    coordinator=AccessCoordinator(),
                    destination_policy=_destination_policy(port),
                    session_broker=broker,
                )
                guard = _DestinationGuard(origin)
                try:

                    def event_flow(session: Any) -> None:
                        marker = session.text("#ready")
                        self.assertEqual(marker, "ready")
                        self.assertTrue(session.click("#popup"))
                        self.assertTrue(
                            fixture.state.popup_seen.wait(5),
                            "the native popup did not reach the local fixture",
                        )
                        self.assertTrue(session.click("#pdf"))
                        session.wait_for_capture(BrowserCaptureKind.RESPONSE)

                    event_capture_guard = _CaptureGuard(origin, BrowserCaptureKind.RESPONSE)
                    result = client.run(
                        AccessScope("cloak-local-publisher", "web"),
                        BrowserRequest(
                            url=origin + "/redirect?entry=fixture",
                            timeout_seconds=30.0,
                            max_response_bytes=8 * 1024 * 1024,
                        ),
                        AccessPolicy(max_concurrency=1),
                        controller=_FlowController(event_flow),
                        destination_guard=guard,
                        capture_guard=event_capture_guard,
                        session_key="cloak-local-publisher",
                        discard_unapproved_subresources=False,
                    )
                    self.assertIsInstance(result, BrowserCaptureBatch)
                    assert isinstance(result, BrowserCaptureBatch)
                    self.assertEqual(len(result.captures), 1)
                    self.assertEqual(result.captures[0].kind, BrowserCaptureKind.RESPONSE)
                    self.assertEqual(b"".join(result.captures[0].stream.chunks), _PDF)
                    self.assertEqual(
                        result.captures[0].stream.final_locator,
                        origin + "/article.pdf",
                    )
                    with fixture.state.lock:
                        pdf_cookies = tuple(fixture.state.cookies)
                    self.assertTrue(
                        any("fixture_session=ready" in value for value in pdf_cookies),
                        "the Browser session did not retain the Publisher cookie",
                    )
                    self.assertIn("/redirect", fixture.state.paths)
                    self.assertIn("/article", fixture.state.paths)
                    self.assertIn("/data.json", fixture.state.paths)
                    self.assertIn("/frame", fixture.state.paths)
                    self.assertNotIn("/sw.js", fixture.state.paths)
                    self.assertIn("/popup", fixture.state.paths)
                    self.assertIn("/article.pdf", fixture.state.paths)
                    self.assertTrue(event_capture_guard.calls)
                    self.assertTrue(
                        all(
                            not urlsplit(url).query
                            for url, _kind, _media in event_capture_guard.calls
                        )
                    )

                    native_capture_guard = _CaptureGuard(origin, BrowserCaptureKind.RESPONSE)
                    native = client.run(
                        AccessScope("cloak-local-publisher", "web"),
                        BrowserRequest(
                            url=origin + "/article.pdf?native=fixture",
                            timeout_seconds=30.0,
                            max_response_bytes=8 * 1024 * 1024,
                        ),
                        AccessPolicy(max_concurrency=1),
                        destination_guard=guard,
                        capture_guard=native_capture_guard,
                        navigation_only=True,
                        session_key="cloak-local-publisher",
                    )
                    self.assertIsInstance(native, BrowserCaptureBatch)
                    assert isinstance(native, BrowserCaptureBatch)
                    self.assertEqual(b"".join(native.captures[0].stream.chunks), _PDF)
                    self.assertEqual(
                        native.captures[0].stream.final_locator,
                        origin + "/article.pdf",
                    )
                    self.assertIn("/article.pdf?native=fixture", fixture.state.targets)
                    self.assertTrue(native_capture_guard.calls)
                    self.assertTrue(
                        all(
                            not urlsplit(url).query
                            for url, _kind, _media in native_capture_guard.calls
                        )
                    )

                    attachment = client.run(
                        AccessScope("cloak-local-publisher", "web"),
                        BrowserRequest(
                            url=origin + "/article",
                            timeout_seconds=30.0,
                            max_response_bytes=8 * 1024 * 1024,
                        ),
                        AccessPolicy(max_concurrency=1),
                        controller=_FlowController(
                            lambda session: (
                                session.click("#attachment"),
                                session.wait_for_capture(BrowserCaptureKind.DOWNLOAD),
                            )
                        ),
                        destination_guard=guard,
                        capture_guard=_CaptureGuard(origin, BrowserCaptureKind.DOWNLOAD),
                        session_key="cloak-local-publisher",
                    )
                    self.assertIsInstance(attachment, BrowserCaptureBatch)
                    assert isinstance(attachment, BrowserCaptureBatch)
                    self.assertEqual(attachment.captures[0].kind, BrowserCaptureKind.DOWNLOAD)
                    self.assertEqual(b"".join(attachment.captures[0].stream.chunks), _PDF)

                    limited = client.run(
                        AccessScope("cloak-local-publisher", "web"),
                        BrowserRequest(
                            url=origin + "/article.pdf?budget=fixture",
                            timeout_seconds=30.0,
                            max_response_bytes=8 * 1024 * 1024,
                        ),
                        AccessPolicy(max_concurrency=1),
                        destination_guard=guard,
                        capture_guard=_CaptureGuard(origin, BrowserCaptureKind.RESPONSE),
                        navigation_only=True,
                        session_key="cloak-local-publisher",
                        limits=BrowserOperationLimits(
                            max_capture_bytes=max(1, len(_PDF) - 1),
                        ),
                    )
                    self.assertIsInstance(limited, AccessFailure)
                    assert isinstance(limited, AccessFailure)
                    self.assertEqual(limited.code, "oversize")

                    escape = client.run(
                        AccessScope("cloak-local-publisher", "web"),
                        BrowserRequest(
                            url="https://outside-cloak-fixture.invalid/article",
                            timeout_seconds=5.0,
                            max_response_bytes=1024,
                        ),
                        AccessPolicy(max_concurrency=1),
                        destination_guard=guard,
                        session_key="cloak-local-publisher",
                    )
                    self.assertIsInstance(escape, AccessFailure)
                    assert isinstance(escape, AccessFailure)
                    self.assertEqual(escape.code, "policy")

                    request_count_unbounded = client.run(
                        AccessScope("cloak-local-publisher", "web"),
                        BrowserRequest(
                            url=origin + "/article?request-count=fixture",
                            timeout_seconds=15.0,
                            max_response_bytes=8 * 1024 * 1024,
                        ),
                        AccessPolicy(max_concurrency=1),
                        controller=_FlowController(lambda session: session.text("#ready")),
                        destination_guard=guard,
                        session_key="cloak-local-publisher",
                    )
                    self.assertIsInstance(request_count_unbounded, AccessFailure)
                    assert isinstance(request_count_unbounded, AccessFailure)
                    self.assertEqual(request_count_unbounded.code, "no-download")

                    fixture.state.stall_released.clear()
                    timeout_result = client.run(
                        AccessScope("cloak-local-publisher", "web"),
                        BrowserRequest(
                            url=origin + "/stall",
                            timeout_seconds=2.0,
                            max_response_bytes=1024,
                        ),
                        AccessPolicy(max_concurrency=1),
                        destination_guard=guard,
                        session_key="cloak-local-publisher",
                    )
                    self.assertIsInstance(timeout_result, AccessFailure)
                    assert isinstance(timeout_result, AccessFailure)
                    self.assertEqual(timeout_result.code, "timeout")

                    fixture.state.stall_started.clear()
                    fixture.state.stall_released.clear()
                    cancellation = threading.Event()

                    def cancel_stall() -> None:
                        if fixture.state.stall_started.wait(5):
                            cancellation.set()
                            fixture.state.stall_released.set()

                    canceller = threading.Thread(target=cancel_stall, daemon=True)
                    canceller.start()
                    cancelled = client.run(
                        AccessScope("cloak-local-publisher", "web"),
                        BrowserRequest(
                            url=origin + "/stall",
                            timeout_seconds=15.0,
                            max_response_bytes=1024,
                        ),
                        AccessPolicy(max_concurrency=1),
                        destination_guard=guard,
                        session_key="cloak-local-publisher",
                        cancel_event=cancellation,
                    )
                    fixture.state.stall_released.set()
                    canceller.join(5)
                    self.assertIsInstance(cancelled, AccessFailure)
                    assert isinstance(cancelled, AccessFailure)
                    self.assertEqual(cancelled.code, "cancelled")
                finally:
                    fixture.state.stall_released.set()
                    broker.close()
                self._assert_no_browser_threads()
                _assert_no_new_browser_processes(self, process_baseline)

    def test_real_cloakbrowser_agent_cookie_scroll_and_pdf_path(self) -> None:
        """Exercise the request-local Agent seam on the real Cloak runtime."""

        with tempfile.TemporaryDirectory(prefix="sciretriever-cloak-local-agent-") as raw:
            root = Path(raw)
            server_root = root / "server"
            server_root.mkdir()
            process_baseline = _browser_process_snapshot()
            with _LocalServer(server_root) as fixture:
                profile = initialize_browser_profile(
                    "agent-profile",
                    home=_ensure_home(root / "profile-home"),
                )
                factory = CloakBrowserFactory(profile, self._runtime, ignore_https_errors=True)
                broker = BrowserSessionBroker()
                origin = fixture.origin
                port = int(urlsplit(origin).port or 443)
                client = BrowserClient(
                    factory=factory,
                    resolver=_Resolver(_HOSTNAME),
                    coordinator=AccessCoordinator(),
                    destination_policy=_destination_policy(port),
                    session_broker=broker,
                )

                fixture_agent = _FixtureMultimodalBrowserAgent()
                controller = AgentBrowserController(
                    runtime=_agent_runtime(fixture_agent),
                    control_factory=_NormalPageAgentControlFactory(),
                )

                guard = _DestinationGuard(origin)
                capture_guard = _CaptureGuard(origin, BrowserCaptureKind.RESPONSE)
                try:
                    result = client.run(
                        AccessScope("cloak-local-agent", "web"),
                        BrowserRequest(
                            url=origin + "/agent",
                            timeout_seconds=30.0,
                            max_response_bytes=8 * 1024 * 1024,
                        ),
                        AccessPolicy(max_concurrency=1),
                        controller=controller,
                        destination_guard=guard,
                        capture_guard=capture_guard,
                        session_key="cloak-local-agent",
                    )
                    controller_result = controller.result
                    if controller_result is None:
                        self.fail("Browser Agent controller did not retain a result")
                    self.assertEqual(
                        controller_result.disposition,
                        BrowserAgentDisposition.CAPTURE_AVAILABLE,
                    )
                    self.assertGreaterEqual(fixture_agent.turns, 4)
                    self.assertEqual(fixture_agent.turns, fixture_agent.image_turns)
                    self.assertIsInstance(result, BrowserCaptureBatch)
                    assert isinstance(result, BrowserCaptureBatch)
                    self.assertEqual(len(result.captures), 1)
                    self.assertEqual(
                        b"".join(result.captures[0].stream.chunks),
                        _PDF,
                    )
                    self.assertEqual(
                        result.captures[0].stream.final_locator,
                        origin + "/article.pdf",
                    )
                    with fixture.state.lock:
                        paths = tuple(fixture.state.paths)
                        cookies = tuple(fixture.state.cookies)
                    self.assertIn("/agent", paths)
                    self.assertIn("/article.pdf", paths)
                    self.assertTrue(
                        any("agent_cookie=ready" in value for value in cookies),
                        "the Agent cookie-consent action did not persist in the Browser context",
                    )
                finally:
                    broker.close()
                self._assert_no_browser_threads()
                _assert_no_new_browser_processes(self, process_baseline)

    def test_real_cloakbrowser_agent_replacement_fails_closed(self) -> None:
        """A replaced DOM node cannot inherit an old Agent element id."""

        with tempfile.TemporaryDirectory(prefix="sciretriever-cloak-local-agent-replace-") as raw:
            root = Path(raw)
            server_root = root / "server"
            server_root.mkdir()
            process_baseline = _browser_process_snapshot()
            with _LocalServer(server_root) as fixture:
                profile = initialize_browser_profile(
                    "agent-replace-profile",
                    home=_ensure_home(root / "profile-home"),
                )
                factory = CloakBrowserFactory(profile, self._runtime, ignore_https_errors=True)
                broker = BrowserSessionBroker()
                origin = fixture.origin
                port = int(urlsplit(origin).port or 443)
                client = BrowserClient(
                    factory=factory,
                    resolver=_Resolver(_HOSTNAME),
                    coordinator=AccessCoordinator(),
                    destination_policy=_destination_policy(port),
                    session_broker=broker,
                )
                fail_closed = False

                def replacement_flow(session: Any) -> None:
                    nonlocal fail_closed
                    action_port = session.control_session()
                    first = action_port.observe(page_state=BrowserPageState.NORMAL)
                    control = next(
                        element for element in first.elements if element.name == "Replace DOM"
                    )
                    target = next(
                        element for element in first.elements if element.name == "Replace target"
                    )
                    control_surface = next(
                        surface
                        for surface in first.surfaces
                        if surface.surface_id == control.surface_id
                    )
                    action_port.execute(
                        ClickElement(
                            first.article_token,
                            control_surface.page_id,
                            control_surface.surface_id,
                            first.revision,
                            control.element_id,
                        ),
                        first,
                        timeout_seconds=5.0,
                    )
                    changed = action_port.observe(page_state=BrowserPageState.NORMAL)
                    self.assertNotEqual(changed.revision, first.revision)
                    replacement = next(
                        element
                        for element in changed.elements
                        if element.name == "Replacement target"
                    )
                    self.assertNotEqual(replacement.element_id, target.element_id)
                    with self.assertRaises(Exception):
                        action_port.execute(
                            ClickElement(
                                first.article_token,
                                control_surface.page_id,
                                target.surface_id,
                                first.revision,
                                target.element_id,
                            ),
                            first,
                            timeout_seconds=5.0,
                        )
                    fail_closed = True

                guard = _DestinationGuard(origin)
                try:
                    result = client.run(
                        AccessScope("cloak-local-agent-replace", "web"),
                        BrowserRequest(
                            url=origin + "/agent-replace",
                            timeout_seconds=30.0,
                            max_response_bytes=8 * 1024 * 1024,
                        ),
                        AccessPolicy(max_concurrency=1),
                        controller=_FlowController(replacement_flow),
                        destination_guard=guard,
                        session_key="cloak-local-agent-replace",
                    )
                    self.assertIsInstance(result, AccessFailure)
                    assert isinstance(result, AccessFailure)
                    self.assertEqual(result.code, "no-download")
                    self.assertTrue(fail_closed)
                finally:
                    broker.close()
                self._assert_no_browser_threads()
                _assert_no_new_browser_processes(self, process_baseline)


if __name__ == "__main__":
    unittest.main()
