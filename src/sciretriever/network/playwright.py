"""Production Playwright adapter for the controlled Browser boundary.

The synchronous Playwright API is thread-affine, while :mod:`network.browser`
executes every potentially blocking vendor operation in a cancellable worker.
This adapter therefore owns one engine thread per persistent Browser session
and marshals vendor calls onto it.  Every HTTP(S) request is intercepted and
fulfilled through a socket bound to the exact DNS result already approved by
``BrowserClient``; Chromium never performs an unreviewed network connection.

Only opaque vendor wrappers cross into ``network.browser``.  Cookies and the
operator-managed profile remain private to Playwright, response bodies remain
bounded, and no URL, header, Cookie, profile path, or vendor exception is
included in adapter errors or representations.
"""

from __future__ import annotations

import http.client
import importlib.util
import json
import os
import queue
import socket
import ssl
import sys
import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Final, TypeVar, cast
from urllib.parse import urljoin, urlsplit

_T = TypeVar("_T")
_COMMAND_TIMEOUT_SECONDS: Final[float] = 65.0
_CONNECT_TIMEOUT_SECONDS: Final[float] = 15.0
_EVENT_PUMP_INTERVAL_SECONDS: Final[float] = 0.01
_MAX_RESPONSE_BYTES: Final[int] = 64 * 1024 * 1024
_MAX_ARTICLE_BYTES: Final[int] = 128 * 1024 * 1024
_MAX_NAVIGATION_REDIRECTS: Final[int] = 16
_REDIRECT_STATUSES: Final[frozenset[int]] = frozenset({301, 302, 303, 307, 308})
_HOP_BY_HOP_HEADERS: Final[frozenset[str]] = frozenset(
    {
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
    }
)


class PlaywrightRuntimeError(RuntimeError):
    """Path-free, payload-free failure from the concrete Browser runtime."""


def _runtime_error() -> PlaywrightRuntimeError:
    return PlaywrightRuntimeError("controlled Playwright runtime failed")


@dataclass(frozen=True, slots=True)
class PlaywrightRuntimeAvailability:
    """Static package/binary presence without starting Playwright or Chromium."""

    python_dependency_available: bool
    chromium_executable_available: bool

    def __post_init__(self) -> None:
        if type(self.python_dependency_available) is not bool:
            raise TypeError("python_dependency_available must be a bool")
        if type(self.chromium_executable_available) is not bool:
            raise TypeError("chromium_executable_available must be a bool")
        if self.chromium_executable_available and not self.python_dependency_available:
            raise ValueError("a Chromium executable requires the Playwright dependency")


def _playwright_package_directory() -> Path | None:
    try:
        specification = importlib.util.find_spec("playwright")
    except (AttributeError, ImportError, ModuleNotFoundError, ValueError):
        return None
    if specification is None or specification.submodule_search_locations is None:
        return None
    locations = tuple(specification.submodule_search_locations)
    if len(locations) != 1:
        return None
    package = Path(locations[0])
    return package if package.is_dir() else None


def _chromium_revision(package: Path) -> str | None:
    manifest = package / "driver" / "package" / "browsers.json"
    try:
        if manifest.stat().st_size > 1024 * 1024:
            return None
        payload = json.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError, TypeError):
        return None
    browsers = payload.get("browsers") if isinstance(payload, dict) else None
    if not isinstance(browsers, list):
        return None
    for browser in browsers:
        if not isinstance(browser, dict) or browser.get("name") != "chromium":
            continue
        revision = browser.get("revision")
        if type(revision) is str and revision.isascii() and revision.isdigit():
            return revision
    return None


def _browser_cache_roots(package: Path) -> tuple[Path, ...]:
    configured = os.environ.get("PLAYWRIGHT_BROWSERS_PATH")
    if configured == "0":
        return (package / "driver" / "package" / ".local-browsers",)
    if configured:
        return (Path(configured).expanduser(),)
    if sys.platform == "darwin":
        return (Path.home() / "Library" / "Caches" / "ms-playwright",)
    if os.name == "nt":
        local_app_data = os.environ.get("LOCALAPPDATA")
        return () if not local_app_data else (Path(local_app_data) / "ms-playwright",)
    return (Path.home() / ".cache" / "ms-playwright",)


def _chromium_executable_candidates(package: Path, revision: str) -> tuple[Path, ...]:
    relative = (
        ("chromium", "chrome-linux", "chrome"),
        ("chromium", "chrome-linux64", "chrome"),
        ("chromium", "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
        (
            "chromium",
            "chrome-mac-arm64",
            "Chromium.app",
            "Contents",
            "MacOS",
            "Chromium",
        ),
        ("chromium", "chrome-win", "chrome.exe"),
        ("chromium", "chrome-win64", "chrome.exe"),
        ("chromium_headless_shell", "chrome-linux", "headless_shell"),
        ("chromium_headless_shell", "chrome-linux64", "headless_shell"),
        ("chromium_headless_shell", "chrome-win", "headless_shell.exe"),
        ("chromium_headless_shell", "chrome-win64", "headless_shell.exe"),
    )
    result: list[Path] = []
    for root in _browser_cache_roots(package):
        for product, *parts in relative:
            result.append(root / f"{product}-{revision}" / Path(*parts))
    return tuple(result)


def playwright_runtime_availability() -> PlaywrightRuntimeAvailability:
    """Assess only installed files; do not import, start, or launch Playwright."""

    package = _playwright_package_directory()
    if package is None:
        return PlaywrightRuntimeAvailability(False, False)
    revision = _chromium_revision(package)
    if revision is None:
        return PlaywrightRuntimeAvailability(True, False)
    available = any(
        candidate.is_file() and (os.name == "nt" or os.access(candidate, os.X_OK))
        for candidate in _chromium_executable_candidates(package, revision)
    )
    return PlaywrightRuntimeAvailability(True, available)


def _required_callable(value: object, name: str) -> Callable[..., object]:
    candidate = getattr(value, name, None)
    if not callable(candidate):
        raise _runtime_error()
    return candidate


def _optional_value(value: object, name: str) -> object | None:
    try:
        candidate = getattr(value, name)
    except Exception:
        return None
    if callable(candidate):
        try:
            return candidate()
        except Exception:
            return None
    return candidate


def _string_value(value: object, name: str) -> str:
    candidate = _optional_value(value, name)
    if type(candidate) is not str:
        raise _runtime_error()
    return candidate


def _is_playwright_timeout(error: BaseException) -> bool:
    """Recognize only Playwright's bounded operation timeout lazily.

    Importing :mod:`playwright` at module import time would turn the optional
    production runtime into a hard dependency for static configuration and
    readiness checks.  This helper runs only after the concrete runtime has
    already been started.
    """

    try:
        from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
    except (ImportError, ModuleNotFoundError):
        return False
    return isinstance(error, PlaywrightTimeoutError)


@dataclass(slots=True)
class _Command:
    operation: Callable[[], object]
    completed: threading.Event = field(default_factory=threading.Event)
    result: list[object] = field(default_factory=list)
    failure: list[BaseException] = field(default_factory=list)


@dataclass(slots=True)
class _Event:
    operation: Callable[[], object]


@dataclass(slots=True)
class _Barrier:
    completed: threading.Event = field(default_factory=threading.Event)


class _EventDispatcher:
    """Run non-route callbacks off the Playwright engine thread in order."""

    __slots__ = ("_queue", "_thread", "_closed", "_failed")

    def __init__(self) -> None:
        self._queue: queue.Queue[_Event | _Barrier | None] = queue.Queue()
        self._closed = False
        self._failed = False
        self._thread = threading.Thread(
            target=self._run,
            name="sciretriever-playwright-events",
            daemon=True,
        )
        self._thread.start()

    def submit(self, operation: Callable[[], object]) -> None:
        if self._closed or not callable(operation):
            self._failed = True
            return
        self._queue.put(_Event(operation))

    def drain(self) -> bool:
        if self._closed:
            return not self._failed
        barrier = _Barrier()
        self._queue.put(barrier)
        if not barrier.completed.wait(_COMMAND_TIMEOUT_SECONDS):
            self._failed = True
        return not self._failed

    def close(self) -> bool:
        if self._closed:
            return not self._failed
        self.drain()
        self._closed = True
        self._queue.put(None)
        self._thread.join(_COMMAND_TIMEOUT_SECONDS)
        if self._thread.is_alive():
            self._failed = True
        return not self._failed

    def _run(self) -> None:
        while True:
            item = self._queue.get()
            if item is None:
                return
            if isinstance(item, _Barrier):
                item.completed.set()
                continue
            try:
                item.operation()
            except BaseException:
                self._failed = True


class _BoundHttpConnection(http.client.HTTPConnection):
    """HTTP connection that cannot resolve or select another endpoint."""

    def __init__(self, *, address: str, port: int, authority: str) -> None:
        super().__init__(authority, port, timeout=_CONNECT_TIMEOUT_SECONDS)
        self._address = address

    def connect(self) -> None:
        self.sock = socket.create_connection(
            (self._address, self.port),
            timeout=self.timeout,
        )


class _BoundHttpsConnection(http.client.HTTPSConnection):
    """HTTPS connection pinned to an IP while preserving authority and SNI."""

    def __init__(
        self,
        *,
        address: str,
        port: int,
        authority: str,
        server_name: str,
    ) -> None:
        super().__init__(
            authority,
            port,
            context=(tls_context := ssl.create_default_context()),
            timeout=_CONNECT_TIMEOUT_SECONDS,
        )
        self._address = address
        self._server_name = server_name
        self._tls_context = tls_context

    def connect(self) -> None:
        raw = socket.create_connection(
            (self._address, self.port),
            timeout=self.timeout,
        )
        try:
            self.sock = self._tls_context.wrap_socket(raw, server_hostname=self._server_name)
        except BaseException:
            raw.close()
            raise


@dataclass(frozen=True, slots=True)
class _NavigationResponse:
    url: str
    status: int
    redirect_url: str | None = None


def _redirect_url(response: _Response) -> str | None:
    if response.status not in _REDIRECT_STATUSES:
        return None
    location = next(
        (value for name, value in response.headers if name == "location"),
        None,
    )
    if type(location) is not str or not location.strip():
        return None
    target = urljoin(response.url, location)
    parsed = urlsplit(target)
    if (
        parsed.scheme.casefold() not in {"http", "https"}
        or parsed.hostname is None
        or parsed.username is not None
        or parsed.password is not None
    ):
        raise _runtime_error()
    return target


class _Request:
    """Thread-neutral snapshot of one intercepted Playwright request."""

    __slots__ = (
        "raw",
        "page",
        "url",
        "resource_type",
        "method",
        "headers",
        "body",
        "_navigation",
    )

    def __init__(self, raw: object, page: _Page | None) -> None:
        self.raw = raw
        self.page = page
        self.url = _string_value(raw, "url")
        self.resource_type = _string_value(raw, "resource_type")
        self.method = _string_value(raw, "method")
        self.headers = _request_headers(raw)
        body = _optional_value(raw, "post_data_buffer")
        if body is not None and not isinstance(body, bytes):
            raise _runtime_error()
        self.body = body
        navigation = _optional_value(raw, "is_navigation_request")
        self._navigation = navigation is True

    def is_navigation_request(self) -> bool:
        return self._navigation


def _request_headers(raw: object) -> tuple[tuple[str, str], ...]:
    value = _optional_value(raw, "all_headers")
    if value is None:
        value = _optional_value(raw, "headers")
    if not isinstance(value, Mapping):
        raise _runtime_error()
    headers = []
    for name, item in value.items():
        if not isinstance(name, str) or not isinstance(item, str):
            raise _runtime_error()
        folded = name.strip().casefold()
        if (
            not folded
            or folded in _HOP_BY_HOP_HEADERS
            or folded in {"host", "content-length"}
            or "\r" in item
            or "\n" in item
        ):
            continue
        headers.append((folded, item))
    return tuple(headers)


class _Response:
    """Bounded response body retained only for BrowserClient capture."""

    __slots__ = ("request", "url", "status", "headers", "media_type", "size", "_body")

    def __init__(
        self,
        request: _Request,
        *,
        status: int,
        headers: tuple[tuple[str, str], ...],
        body: bytes,
    ) -> None:
        self.request = request
        self.url = request.url
        self.status = status
        self.headers = headers
        self.media_type = _media_type(headers)
        self.size = len(body)
        self._body = body

    def body(self) -> bytes:
        return self._body


def _media_type(headers: tuple[tuple[str, str], ...]) -> str:
    value = next((value for name, value in headers if name == "content-type"), None)
    if value is None:
        return "application/octet-stream"
    return value.split(";", 1)[0].strip().casefold() or "application/octet-stream"


class _Engine:
    """Own the Playwright driver and one persistent Chromium context."""

    __slots__ = (
        "_commands",
        "_ready",
        "_thread",
        "_failure",
        "_runtime",
        "_context",
        "_connections",
        "_connection_lock",
        "_closed",
    )

    def __init__(self) -> None:
        self._commands: queue.Queue[_Command | None] = queue.Queue()
        self._ready = threading.Event()
        self._thread = threading.Thread(
            target=self._main,
            name="sciretriever-playwright-engine",
            daemon=True,
        )
        self._failure: BaseException | None = None
        self._runtime: object | None = None
        self._context: _Context | None = None
        self._connections: set[http.client.HTTPConnection] = set()
        self._connection_lock = threading.Lock()
        self._closed = False

    def start(self) -> None:
        self._thread.start()
        if not self._ready.wait(_COMMAND_TIMEOUT_SECONDS) or self._failure is not None:
            raise _runtime_error()

    def call(self, operation: Callable[[], _T]) -> _T:
        if self._closed:
            raise _runtime_error()
        if threading.current_thread() is self._thread:
            try:
                return operation()
            except PlaywrightRuntimeError:
                raise
            except BaseException:
                raise _runtime_error() from None
        command = _Command(cast(Callable[[], object], operation))
        self._commands.put(command)
        if not command.completed.wait(_COMMAND_TIMEOUT_SECONDS):
            self.interrupt()
            raise _runtime_error()
        if command.failure or not command.result:
            raise _runtime_error()
        return cast(_T, command.result[0])

    def launch_context(
        self,
        profile: object | None,
        downloads_path: str,
    ) -> _Context:
        if self._context is not None:
            raise _runtime_error()

        def launch() -> _Context:
            runtime = self._runtime
            if runtime is None:
                raise _runtime_error()
            chromium = getattr(runtime, "chromium", None)
            launch_persistent = getattr(chromium, "launch_persistent_context", None)
            if not callable(launch_persistent):
                raise _runtime_error()
            directory = _profile_directory(profile)
            raw_context = launch_persistent(
                os.fspath(directory),
                headless=True,
                accept_downloads=True,
                downloads_path=downloads_path,
                service_workers="block",
                no_viewport=True,
            )
            context = _Context(self, raw_context)
            self._context = context
            return context

        return self.call(launch)

    def fetch(self, request: _Request, binding: object) -> _Response:
        parsed = urlsplit(request.url)
        scheme = _binding_text(binding, "scheme")
        hostname = _binding_text(binding, "hostname")
        address = _binding_text(binding, "address")
        authority = _binding_text(binding, "authority")
        server_name = _binding_text(binding, "tls_server_name")
        port = _binding_port(binding)
        verified = getattr(binding, "verified_addresses", None)
        if (
            scheme not in {"http", "https"}
            or parsed.scheme.casefold() != scheme
            or parsed.hostname is None
            or parsed.hostname.casefold() != hostname
            or parsed.port not in {None, port}
            or not isinstance(verified, tuple)
            or address not in verified
        ):
            raise _runtime_error()
        connection: http.client.HTTPConnection
        if scheme == "https":
            connection = _BoundHttpsConnection(
                address=address,
                port=port,
                authority=authority,
                server_name=server_name,
            )
        else:
            connection = _BoundHttpConnection(
                address=address,
                port=port,
                authority=authority,
            )
        with self._connection_lock:
            self._connections.add(connection)
        try:
            target = parsed.path or "/"
            if parsed.query:
                target = f"{target}?{parsed.query}"
            headers = dict(request.headers)
            headers["host"] = _authority_header(scheme, authority, port)
            connection.request(
                request.method,
                target,
                body=request.body,
                headers=headers,
            )
            raw_response = connection.getresponse()
            body = raw_response.read(_MAX_RESPONSE_BYTES + 1)
            if len(body) > _MAX_RESPONSE_BYTES:
                raise _runtime_error()
            response_headers = _response_headers(raw_response.getheaders(), len(body))
            status = raw_response.status
            if type(status) is not int or not 100 <= status <= 599:
                raise _runtime_error()
            context = self._context
            if context is None or not context.consume_article_bytes(len(body)):
                raise _runtime_error()
            return _Response(
                request,
                status=status,
                headers=response_headers,
                body=body,
            )
        except PlaywrightRuntimeError:
            raise
        except BaseException:
            raise _runtime_error() from None
        finally:
            with self._connection_lock:
                self._connections.discard(connection)
            try:
                connection.close()
            except Exception:
                pass

    def interrupt(self) -> None:
        with self._connection_lock:
            connections = tuple(self._connections)
        for connection in connections:
            try:
                connection.close()
            except Exception:
                continue

    def close(self) -> None:
        if self._closed:
            if self._failure is not None:
                raise _runtime_error()
            return
        self.interrupt()
        self._closed = True
        self._commands.put(None)
        self._thread.join(_COMMAND_TIMEOUT_SECONDS)
        if self._thread.is_alive() or self._failure is not None:
            raise _runtime_error()

    def _main(self) -> None:
        manager: object | None = None
        try:
            from playwright.sync_api import sync_playwright

            manager = sync_playwright()
            self._runtime = _required_callable(manager, "start")()
        except BaseException as error:
            self._failure = error
            self._ready.set()
            return
        self._ready.set()
        while True:
            try:
                command = self._commands.get(timeout=_EVENT_PUMP_INTERVAL_SECONDS)
            except queue.Empty:
                context = self._context
                if context is not None:
                    context.pump_events_from_engine()
                continue
            if command is None:
                break
            try:
                command.result.append(command.operation())
            except BaseException as error:
                command.failure.append(error)
            finally:
                command.completed.set()
        try:
            if self._context is not None:
                self._context.close_from_engine()
            runtime = self._runtime
            if runtime is not None:
                _required_callable(runtime, "stop")()
        except BaseException as error:
            self._failure = error
        finally:
            self._runtime = None


def _binding_text(binding: object, name: str) -> str:
    value = getattr(binding, name, None)
    if type(value) is not str:
        raise _runtime_error()
    return value.strip().casefold()


def _binding_port(binding: object) -> int:
    value = getattr(binding, "port", None)
    if type(value) is not int or not 1 <= value <= 65535:
        raise _runtime_error()
    return value


def _authority_header(scheme: str, authority: str, port: int) -> str:
    default = (scheme == "https" and port == 443) or (scheme == "http" and port == 80)
    return authority if default else f"{authority}:{port}"


def _response_headers(
    headers: list[tuple[str, str]],
    body_size: int,
) -> tuple[tuple[str, str], ...]:
    combined: dict[str, list[str]] = {}
    for name, value in headers:
        folded = name.strip().casefold()
        if (
            not folded
            or folded in _HOP_BY_HOP_HEADERS
            or folded == "content-length"
            or "\r" in value
            or "\n" in value
        ):
            continue
        combined.setdefault(folded, []).append(value)
    result = []
    for name, values in combined.items():
        separator = "\n" if name == "set-cookie" else ", "
        result.append((name, separator.join(values)))
    result.append(("content-length", str(body_size)))
    return tuple(result)


def _profile_directory(profile: object | None) -> Path:
    if profile is None:
        raise _runtime_error()
    runtime_directory = getattr(profile, "runtime_directory", None)
    if not callable(runtime_directory):
        raise _runtime_error()
    try:
        value = runtime_directory()
    except Exception:
        raise _runtime_error() from None
    if not isinstance(value, Path) or not value.is_dir():
        raise _runtime_error()
    return value


class _Route:
    __slots__ = ("_context", "_raw", "request", "_binding", "_finished")

    def __init__(self, context: _Context, raw: object, request: _Request) -> None:
        self._context = context
        self._raw = raw
        self.request = request
        self._binding: object | None = None
        self._finished = False

    def bind_connection(self, binding: object) -> object:
        if self._finished or self._binding is not None:
            raise _runtime_error()
        self._binding = binding
        return binding

    def continue_(self) -> None:
        if self._finished or self._binding is None:
            raise _runtime_error()
        response = self._context.engine.fetch(self.request, self._binding)
        headers = {name: value for name, value in response.headers}
        try:
            cast(Any, self._raw).fulfill(
                status=response.status,
                headers=headers,
                body=response.body(),
            )
        except BaseException:
            raise _runtime_error() from None
        self._finished = True
        self._context.note_response(self.request, response)

    def abort(self) -> None:
        if self._finished:
            return
        try:
            cast(Any, self._raw).abort()
        except BaseException:
            raise _runtime_error() from None
        finally:
            self._finished = True


class _Page:
    __slots__ = ("context", "engine", "raw", "_closed", "_navigation_url")

    def __init__(self, context: _Context, raw: object) -> None:
        self.context = context
        self.engine = context.engine
        self.raw = raw
        self._closed = False
        self._navigation_url: str | None = None

    @property
    def url(self) -> str:
        # ``_goto`` records the final response locator only after every
        # redirect has passed BrowserClient's destination and DNS guards.  A
        # page-state observation should use that already-reviewed value
        # instead of queueing behind arbitrary still-loading subresources on
        # Playwright's single engine thread.
        if self._navigation_url is not None:
            return self._navigation_url

        def current() -> str:
            raw_url = _string_value(self.raw, "url")
            if urlsplit(raw_url).scheme.casefold() in {"http", "https"}:
                return raw_url
            return self._navigation_url or raw_url

        return self.engine.call(current)

    def goto(self, url: str, *, timeout: int) -> _NavigationResponse:
        return self.engine.call(lambda: self._goto(url, timeout=timeout))

    def _goto(self, url: str, *, timeout: int) -> _NavigationResponse:
        deadline = time.monotonic() + (timeout / 1000.0)
        target = url
        for redirect_count in range(_MAX_NAVIGATION_REDIRECTS + 1):
            remaining = deadline - time.monotonic()
            if remaining <= 0.0:
                raise _runtime_error()
            current = self._navigate_once(target, timeout=max(1, int(remaining * 1000)))
            if current.redirect_url is None:
                self._navigation_url = current.url
                return current
            if redirect_count >= _MAX_NAVIGATION_REDIRECTS:
                raise _runtime_error()
            target = current.redirect_url
            self.context.replace_redirect_page(self)
        raise _runtime_error()

    def _navigate_once(self, target: str, *, timeout: int) -> _NavigationResponse:
        self.context.clear_navigation_response(self)
        try:
            self.context.navigate_page(self, target, timeout=timeout)
        except BaseException:
            remembered = self.context.navigation_response(self)
            if remembered is None:
                raise _runtime_error() from None
            return remembered
        remembered = self.context.navigation_response(self)
        if remembered is None:
            raise _runtime_error()
        return remembered

    def open_popup(self, url: str) -> _Page:
        return self.context.open_page(url)

    def title(self) -> str:
        value = self.engine.call(lambda: cast(Any, self.raw).evaluate("() => document.title || ''"))
        if type(value) is not str:
            raise _runtime_error()
        return value

    def content(self) -> str:
        value = self.engine.call(
            lambda: cast(Any, self.raw).evaluate(
                "() => (document.body?.innerText || '').slice(0, 1048576)"
            )
        )
        if type(value) is not str:
            raise _runtime_error()
        return value

    def text_content(self, selector: str, *, timeout: int) -> str | None:
        if type(selector) is not str or type(timeout) is not int or timeout <= 0:
            raise _runtime_error()

        def read() -> object:
            locator = _required_callable(self.raw, "locator")(selector)
            text_content = _required_callable(locator, "text_content")
            try:
                return text_content(timeout=timeout)
            except BaseException as error:
                if _is_playwright_timeout(error):
                    return None
                raise

        try:
            value = self.engine.call(read)
        except BaseException:
            raise _runtime_error() from None
        if value is not None and type(value) is not str:
            raise _runtime_error()
        return cast(str | None, value)

    def has_selector(self, selector: str, *, timeout: int) -> bool:
        if type(selector) is not str or type(timeout) is not int or timeout <= 0:
            raise _runtime_error()

        def count() -> object:
            locator = _required_callable(self.raw, "locator")(selector)
            # ``count`` is a non-waiting DOM-presence query.  Playwright's
            # locator ``wait_for`` can monopolize the single engine thread
            # while route interception is active even when given a short
            # vendor timeout, so it is not a safe marker primitive here.
            return _required_callable(locator, "count")()

        try:
            value = self.engine.call(count)
        except BaseException:
            raise _runtime_error() from None
        if type(value) is not int or value < 0:
            raise _runtime_error()
        return value > 0

    def click(self, selector: str, *, timeout: int) -> None:
        self.engine.call(lambda: cast(Any, self.raw).click(selector, timeout=timeout))

    def fill(self, selector: str, value: str, *, timeout: int) -> None:
        self.engine.call(lambda: cast(Any, self.raw).fill(selector, value, timeout=timeout))

    def abort(self) -> None:
        self.engine.interrupt()

    cancel = abort
    stop = abort

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self.engine.call(lambda: cast(Any, self.raw).close())
        finally:
            self.context.forget_page(self)


class _Context:
    """One persistent context reused by a broker across isolated article pages."""

    __slots__ = (
        "engine",
        "raw",
        "_dispatcher",
        "_route_handler",
        "_event_handlers",
        "_pages",
        "_creating_page",
        "_active_article",
        "_article_bytes",
        "_navigation_responses",
        "_closed",
        "_cleanup_failed",
    )

    def __init__(self, engine: _Engine, raw: object) -> None:
        self.engine = engine
        self.raw = raw
        self._dispatcher = _EventDispatcher()
        self._route_handler: Callable[[object], object] | None = None
        self._event_handlers: dict[str, Callable[[object], object]] = {}
        self._pages: dict[int, _Page] = {}
        self._creating_page = False
        self._active_article = False
        self._article_bytes = 0
        self._navigation_responses: dict[int, _NavigationResponse] = {}
        self._closed = False
        self._cleanup_failed = False
        try:
            cast(Any, raw).on("page", lambda value: self._on_page(value))
        except BaseException:
            raise _runtime_error() from None

    def bind_connection(self, binding: object) -> object:
        if self._closed:
            raise _runtime_error()
        return binding

    def begin_article(self, *, downloads_path: str, connection_binding: object) -> object:
        del downloads_path
        if self._closed or self._active_article:
            raise _runtime_error()
        self._active_article = True
        self._article_bytes = 0
        self._navigation_responses.clear()
        return connection_binding

    def end_article(self) -> bool:
        if not self._active_article:
            return False
        drained = self._dispatcher.drain()
        self._active_article = False
        self._navigation_responses.clear()
        return drained and not self._cleanup_failed

    def route(self, pattern: str, handler: Callable[[object], object]) -> None:
        if pattern != "**/*" or not callable(handler) or self._route_handler is not None:
            raise _runtime_error()
        self._route_handler = handler
        try:
            self.engine.call(
                lambda: cast(Any, self.raw).route(
                    pattern,
                    lambda value: self._on_route(value),
                )
            )
        except BaseException:
            raise _runtime_error() from None

    def on(self, event: str, handler: Callable[[object], object]) -> None:
        if event in self._event_handlers or not callable(handler):
            raise _runtime_error()
        self._event_handlers[event] = handler

    def new_page(self) -> _Page:
        def create() -> _Page:
            self._creating_page = True
            try:
                raw_page = cast(Any, self.raw).new_page()
            finally:
                self._creating_page = False
            return self._page(raw_page)

        return self.engine.call(create)

    def replace_redirect_page(self, page: _Page) -> None:
        """Recover from Chromium's synthetic-redirect error in the same flow.

        Chromium does not follow a redirect created by ``route.fulfill`` and
        leaves that page in ``chrome-error://``.  A fresh page in the same
        persistent context retains the operator session while the next
        HTTP(S) navigation is intercepted again by BrowserClient's policy,
        DNS binding, host admission, and destination guard.
        """

        old_raw = page.raw
        self._creating_page = True
        try:
            raw_page = cast(Any, self.raw).new_page()
        except BaseException:
            raise _runtime_error() from None
        finally:
            self._creating_page = False
        created = self._page(raw_page)
        self._pages.pop(id(old_raw), None)
        self._pages[id(raw_page)] = page
        page.raw = raw_page
        page._navigation_url = None
        if created is not page:
            created._closed = True
        try:
            cast(Any, old_raw).close()
        except BaseException:
            raise _runtime_error() from None

    def navigate_page(self, page: _Page, target: str, *, timeout: int) -> None:
        """Start one fixed top-frame navigation and await its intercepted response."""

        if self._closed or type(timeout) is not int or timeout <= 0:
            raise _runtime_error()
        evaluate = _required_callable(page.raw, "evaluate")
        wait = _required_callable(page.raw, "wait_for_timeout")
        try:
            evaluate("(url) => { window.location.assign(url); }", target)
        except PlaywrightRuntimeError:
            raise
        except BaseException:
            if self.navigation_response(page) is None:
                raise _runtime_error() from None
        deadline = time.monotonic() + (timeout / 1000.0)
        while self.navigation_response(page) is None:
            remaining = deadline - time.monotonic()
            if remaining <= 0.0:
                raise _runtime_error()
            try:
                wait(max(1, min(10, int(remaining * 1000))))
            except BaseException:
                if self.navigation_response(page) is None:
                    raise _runtime_error() from None

    def open_page(self, url: str) -> _Page:
        page = self.new_page()
        page.goto(url, timeout=int(_COMMAND_TIMEOUT_SECONDS * 1000))
        return page

    def consume_article_bytes(self, amount: int) -> bool:
        if not self._active_article or type(amount) is not int or amount < 0:
            return False
        self._article_bytes += amount
        return self._article_bytes <= _MAX_ARTICLE_BYTES

    def pump_events_from_engine(self) -> None:
        """Give Chromium a bounded sync-API turn while no vendor command is queued."""

        if self._closed or not self._active_article:
            return
        page = next(
            (candidate for candidate in self._pages.values() if not candidate._closed), None
        )
        if page is None:
            return
        try:
            cast(Any, page.raw).wait_for_timeout(max(1, int(_EVENT_PUMP_INTERVAL_SECONDS * 1000)))
        except BaseException:
            self._cleanup_failed = True

    def note_response(self, request: _Request, response: _Response) -> None:
        page = request.page
        if page is not None and request.is_navigation_request():
            self._navigation_responses[id(page)] = _NavigationResponse(
                response.url,
                response.status,
                _redirect_url(response),
            )
        self._emit("response", response)
        self._emit("requestfinished", request)

    def navigation_response(self, page: _Page) -> _NavigationResponse | None:
        return self._navigation_responses.get(id(page))

    def clear_navigation_response(self, page: _Page) -> None:
        self._navigation_responses.pop(id(page), None)

    def forget_page(self, page: _Page) -> None:
        """Release one article page wrapper after deterministic page cleanup."""

        self._pages.pop(id(page.raw), None)
        self._navigation_responses.pop(id(page), None)

    def abort(self) -> None:
        self.engine.interrupt()

    cancel = abort
    stop = abort

    @property
    def pages(self) -> tuple[_Page, ...]:
        return tuple(self._pages.values())

    def close(self) -> None:
        if self._closed:
            if self._cleanup_failed:
                raise _runtime_error()
            return
        failed = not self._dispatcher.drain()
        try:
            self.engine.call(self._close_raw_from_engine)
        except PlaywrightRuntimeError:
            failed = True
        if not self._dispatcher.drain():
            failed = True
        if not self._dispatcher.close():
            failed = True
        self._cleanup_failed = failed
        if failed:
            raise _runtime_error()

    def close_from_engine(self) -> None:
        """Best-effort fallback after the engine has rejected new commands."""

        if self._closed:
            return
        failed = False
        try:
            self._close_raw_from_engine()
        except BaseException:
            failed = True
        if not self._dispatcher.close():
            failed = True
        self._cleanup_failed = failed
        if failed:
            raise _runtime_error()

    def _close_raw_from_engine(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            cast(Any, self.raw).close()
        except BaseException:
            raise _runtime_error() from None

    def _page(self, raw_page: object) -> _Page:
        key = id(raw_page)
        page = self._pages.get(key)
        if page is None:
            page = _Page(self, raw_page)
            self._pages[key] = page
            try:
                cast(Any, raw_page).on(
                    "download",
                    lambda value: self._discard_download(value),
                )
            except BaseException:
                raise _runtime_error() from None
        return page

    def _on_page(self, raw_page: object) -> None:
        try:
            page = self._page(raw_page)
            if not self._creating_page:
                self._emit("page", page)
        except BaseException:
            self._cleanup_failed = True

    def _on_route(self, raw_route: object) -> None:
        handler = self._route_handler
        if handler is None or not self._active_article:
            _abort_raw_route(raw_route)
            return
        request: _Request | None = None
        try:
            raw_request = cast(Any, raw_route).request
            page = self._request_page(raw_request)
            request = _Request(raw_request, page)
            handler(_Route(self, raw_route, request))
        except BaseException:
            _abort_raw_route(raw_route)
            self._emit("requestfailed", request if request is not None else raw_route)

    def _request_page(self, raw_request: object) -> _Page | None:
        try:
            frame = cast(Any, raw_request).frame
            raw_page = frame.page
        except BaseException:
            return None
        return self._page(raw_page)

    def _emit(self, event: str, value: object) -> None:
        handler = self._event_handlers.get(event)
        if handler is not None:
            self._dispatcher.submit(lambda: handler(value))

    def _discard_download(self, raw_download: object) -> None:
        try:
            self.engine.call(lambda: cast(Any, raw_download).delete())
        except BaseException:
            self._cleanup_failed = True


def _abort_raw_route(raw_route: object) -> None:
    try:
        cast(Any, raw_route).abort()
    except BaseException:
        return


class _Process:
    __slots__ = ("_engine", "_profile", "_closed")

    def __init__(self, engine: _Engine, profile: object | None) -> None:
        self._engine = engine
        self._profile = profile
        self._closed = False

    def bind_connection(self, binding: object) -> object:
        if self._closed:
            raise _runtime_error()
        return binding

    def new_context(
        self,
        *,
        profile: object | None,
        downloads_path: str,
        accept_downloads: bool,
        connection_binding: object,
    ) -> _Context:
        del connection_binding
        if self._closed or profile is not self._profile or not accept_downloads:
            raise _runtime_error()
        return self._engine.launch_context(profile, downloads_path)

    def abort(self) -> None:
        self._engine.interrupt()

    cancel = abort
    stop = abort

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._engine.close()


class PlaywrightBrowserFactory:
    """Stable callable injected into ``BrowserClient`` by production Bootstrap."""

    __slots__ = ()

    def __call__(
        self,
        *,
        profile: object | None,
        downloads_path: str,
        connection_binding: object,
    ) -> object:
        del downloads_path, connection_binding
        engine = _Engine()
        try:
            engine.start()
            return _Process(engine, profile)
        except BaseException:
            try:
                engine.close()
            except BaseException:
                pass
            raise _runtime_error() from None


__all__ = (
    "PlaywrightBrowserFactory",
    "PlaywrightRuntimeAvailability",
    "PlaywrightRuntimeError",
    "playwright_runtime_availability",
)
