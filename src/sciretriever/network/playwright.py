"""Production headed-Playwright adapter for the controlled Browser boundary.

The synchronous Playwright API is thread-affine, while :mod:`network.browser`
executes every potentially blocking vendor operation in a cancellable worker.
This adapter therefore owns one engine thread for the shared persistent-profile
runtime and marshals isolated Publisher article lanes onto it. Every HTTP(S) request is
intercepted for destination admission and then continued through Chromium's
native network stack. A loopback CONNECT tunnel pins the connection to the
exact DNS result approved by ``BrowserClient`` while forwarding encrypted
bytes without terminating TLS or replacing Chrome HTTP behaviour.

Only opaque vendor wrappers cross into ``network.browser``. Cookies remain in
the operator-managed persistent profile, response and download bodies remain
bounded, and no URL, header, Cookie, profile path, workspace path, or vendor
exception is included in adapter errors or representations.
"""

from __future__ import annotations

import importlib.util
import json
import os
import queue
import shutil
import sys
import threading
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Final, TypeVar, cast
from urllib.parse import urlsplit

from sciretriever.logging.api import get_logger

from .browser_connect import (
    BrowserConnectProxy,
    HeadedDisplayLease,
    acquire_headed_display,
    xvfb_executable_available,
)

_T = TypeVar("_T")
_COMMAND_TIMEOUT_SECONDS: Final[float] = 65.0
_EVENT_PUMP_INTERVAL_SECONDS: Final[float] = 0.01
_MAX_RESPONSE_BYTES: Final[int] = 64 * 1024 * 1024
_MAX_ARTICLE_BYTES: Final[int] = 128 * 1024 * 1024
_MAX_DISCOVERED_PDF_LOCATORS: Final[int] = 16
_MAX_DISCOVERED_LOCATOR_LENGTH: Final[int] = 8192
_CAPTURE_RESPONSE_HEADERS: Final[frozenset[str]] = frozenset(
    {"content-type", "content-length", "content-disposition"}
)
_LOGGER = get_logger(__name__)


class PlaywrightRuntimeError(RuntimeError):
    """Path-free, payload-free failure from the concrete Browser runtime."""


def _runtime_error() -> PlaywrightRuntimeError:
    return PlaywrightRuntimeError("controlled Playwright runtime failed")


class _ResponseViewError(PlaywrightRuntimeError):
    """Payload-free response-view failure with one safe field identifier."""

    __slots__ = ("field",)

    def __init__(self, field: str) -> None:
        self.field = field
        super().__init__("controlled Playwright runtime failed")


def _response_view_error(field: str) -> _ResponseViewError:
    return _ResponseViewError(field)


@dataclass(frozen=True, slots=True)
class PlaywrightRuntimeAvailability:
    """Static package, browser and headed-display presence without launching."""

    python_dependency_available: bool
    chromium_executable_available: bool
    headed_display_available: bool

    def __post_init__(self) -> None:
        if type(self.python_dependency_available) is not bool:
            raise TypeError("python_dependency_available must be a bool")
        if type(self.chromium_executable_available) is not bool:
            raise TypeError("chromium_executable_available must be a bool")
        if type(self.headed_display_available) is not bool:
            raise TypeError("headed_display_available must be a bool")
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
        return PlaywrightRuntimeAvailability(False, False, xvfb_executable_available())
    revision = _chromium_revision(package)
    if revision is None:
        return PlaywrightRuntimeAvailability(
            True,
            _stable_chrome_available(),
            xvfb_executable_available(),
        )
    available = _stable_chrome_available() or any(
        candidate.is_file() and (os.name == "nt" or os.access(candidate, os.X_OK))
        for candidate in _chromium_executable_candidates(package, revision)
    )
    return PlaywrightRuntimeAvailability(True, available, xvfb_executable_available())


def _stable_chrome_available() -> bool:
    if sys.platform.startswith("linux"):
        candidates = (
            shutil.which("google-chrome"),
            shutil.which("google-chrome-stable"),
            "/opt/google/chrome/chrome",
        )
    elif sys.platform == "darwin":
        candidates = ("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",)
    elif os.name == "nt":
        candidates = tuple(
            os.path.join(root, "Google", "Chrome", "Application", "chrome.exe")
            for root in (
                os.environ.get("PROGRAMFILES", ""),
                os.environ.get("PROGRAMFILES(X86)", ""),
                os.environ.get("LOCALAPPDATA", ""),
            )
            if root
        )
    else:
        candidates = ()
    return any(
        candidate is not None
        and os.path.isfile(candidate)
        and (os.name == "nt" or os.access(candidate, os.X_OK))
        for candidate in candidates
    )


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


def _vendor_identity(value: object) -> object:
    """Return one operation-local identity stable across Playwright wrappers."""

    implementation = getattr(value, "_impl_obj", None)
    guid = getattr(implementation, "_guid", None)
    if type(guid) is str and guid:
        return ("playwright-guid", guid)
    return id(value)


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


def _playwright_error_category(error: BaseException) -> str:
    """Map a vendor message to one fixed, payload-free diagnostic category."""

    try:
        message = str(error).casefold()
    except BaseException:
        return "unknown"
    if "execution context was destroyed" in message or "because of a navigation" in message:
        return "navigation-race"
    if "frame was detached" in message or "cannot find context with specified id" in message:
        return "frame-transition"
    if "target page, context or browser has been closed" in message:
        return "page-closed"
    if "strict mode violation" in message or "unexpected token" in message:
        return "selector-contract"
    if "timeout" in message:
        return "vendor-timeout"
    return "other"


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


@dataclass(frozen=True, slots=True)
class _NavigationResponse:
    url: str
    status: int
    media_type: str


class _Request:
    """Thread-neutral identity and safe fields for one Playwright request."""

    __slots__ = (
        "raw",
        "page",
        "url",
        "resource_type",
        "method",
        "redirected_from",
        "article_token",
        "_navigation",
    )

    def __init__(
        self,
        raw: object,
        page: _Page | None,
        redirected_from: _Request | None,
    ) -> None:
        self.raw = raw
        self.page = page
        self.url = _string_value(raw, "url")
        self.resource_type = _string_value(raw, "resource_type")
        self.method = _string_value(raw, "method")
        self.redirected_from = redirected_from
        self.article_token = (
            page.article_token
            if page is not None
            else None
            if redirected_from is None
            else redirected_from.article_token
        )
        navigation = _optional_value(raw, "is_navigation_request")
        self._navigation = navigation is True

    def is_navigation_request(self) -> bool:
        return self._navigation


@dataclass(slots=True)
class _NativeRequestState:
    """Order native response/completion events for one redirect-chain member."""

    request: _Request
    root: _NativeRequestState | None = None
    chain: list[_NativeRequestState] = field(default_factory=list)
    response_pending: int = 0
    response_seen: bool = False
    response_redirects: bool = False
    completion_event: str | None = None
    completion_submitted: bool = False

    def __post_init__(self) -> None:
        if self.root is None:
            self.root = self
            self.chain.append(self)
        else:
            self.root.chain.append(self)


@dataclass(slots=True)
class _ArticleState:
    """All mutable Browser facts owned by one active Publisher article lane."""

    lane_key: str
    token: object = field(default_factory=object)
    route_handler: Callable[[object], object] | None = None
    event_handlers: dict[str, Callable[[object], object]] = field(default_factory=dict)
    page_keys: set[int] = field(default_factory=set)
    request_keys: set[object] = field(default_factory=set)
    navigation_responses: dict[int, _NavigationResponse] = field(default_factory=dict)
    article_bytes: int = 0
    transport_drained: bool = False
    cleanup_failed: bool = False
    active: bool = True


def _headers(raw: object) -> tuple[tuple[str, str], ...]:
    # Playwright's cached ``headers`` property is deliberately preferred here.
    # Calling ``all_headers()`` from inside the synchronous native response
    # callback pumps protocol events re-entrantly; a same-origin subresource
    # route can then wait on the still-live parent host lease and deadlock the
    # engine thread. Only three capture-classification fields are retained;
    # unrelated multi-value fields such as Set-Cookie must never invalidate a
    # complete response view.
    value = _optional_value(raw, "headers")
    if not isinstance(value, Mapping):
        raise _response_view_error("headers")
    headers: list[tuple[str, str]] = []
    for name, item in value.items():
        if not isinstance(name, str):
            continue
        folded = name.strip().casefold()
        if folded not in _CAPTURE_RESPONSE_HEADERS:
            continue
        if not isinstance(item, str) or "\r" in item or "\n" in item:
            raise _response_view_error(folded)
        headers.append((folded, item))
    return tuple(headers)


def _content_length(headers: tuple[tuple[str, str], ...]) -> int | None:
    value = next((item for name, item in headers if name == "content-length"), None)
    if value is None or not value.isascii() or not value.isdigit():
        return None
    size = int(value)
    return size if size >= 0 else None


class _Response:
    """Thread-neutral response view whose body stays on the engine thread."""

    __slots__ = (
        "_context",
        "_article",
        "_raw",
        "request",
        "url",
        "status",
        "headers",
        "media_type",
        "size",
        "download_expected",
        "attachment_download",
    )

    def __init__(
        self,
        context: _Context,
        article: _ArticleContext,
        raw: object,
        request: _Request,
    ) -> None:
        self._context = context
        self._article = article
        self._raw = raw
        self.request = request
        self.url = _string_value(raw, "url")
        status = _optional_value(raw, "status")
        if type(status) is not int or not 100 <= status <= 599:
            raise _runtime_error()
        self.status = status
        self.headers = _headers(raw)
        self.media_type = _media_type(self.headers)
        self.size = _content_length(self.headers)
        self.download_expected = (
            request.is_navigation_request() and self.media_type == "application/pdf"
        )
        disposition = next(
            (value for name, value in self.headers if name == "content-disposition"),
            "",
        )
        self.attachment_download = (
            request.is_navigation_request() and "attachment" in disposition.casefold()
        )

    def body(self) -> bytes:
        declared = self.size
        if declared is not None and declared > _MAX_RESPONSE_BYTES:
            raise _runtime_error()
        value = self._context.engine.call(lambda: _required_callable(self._raw, "body")())
        if not isinstance(value, bytes) or len(value) > _MAX_RESPONSE_BYTES:
            raise _runtime_error()
        if not self._article.consume_article_bytes(len(value)):
            raise _runtime_error()
        return value


class _Download:
    """Thread-neutral view of one native Playwright download."""

    __slots__ = ("_article", "_context", "_raw", "request", "url", "media_type", "size")

    def __init__(self, context: _Context, article: _ArticleContext, raw: object) -> None:
        self._context = context
        self._article = article
        self._raw = raw
        self.request = None
        self.url = _string_value(raw, "url")
        self.media_type = "application/octet-stream"
        self.size = None

    def content(self, maximum_bytes: int) -> bytes:
        if type(maximum_bytes) is not int or maximum_bytes < 1:
            raise _runtime_error()
        value = self._context.engine.call(lambda: _required_callable(self._raw, "path")())
        if not isinstance(value, (str, Path)):
            raise _runtime_error()
        candidate = Path(value)
        try:
            resolved = candidate.resolve(strict=True)
            root = self._context.downloads_root.resolve(strict=True)
            resolved.relative_to(root)
            if candidate.is_symlink() or not resolved.is_file():
                raise _runtime_error()
            if resolved.stat().st_size > maximum_bytes:
                raise _runtime_error()
            with resolved.open("rb") as stream:
                body = stream.read(maximum_bytes + 1)
        except PlaywrightRuntimeError:
            raise
        except OSError:
            raise _runtime_error() from None
        if len(body) > maximum_bytes or not self._article.consume_article_bytes(len(body)):
            raise _runtime_error()
        return body

    def delete(self) -> None:
        self._context.engine.call(lambda: _required_callable(self._raw, "delete")())


def _media_type(headers: tuple[tuple[str, str], ...]) -> str:
    value = next((value for name, value in headers if name == "content-type"), None)
    if value is None:
        return "application/octet-stream"
    return value.split(";", 1)[0].strip().casefold() or "application/octet-stream"


class _Engine:
    """Own one headed Chromium context, display lease and native byte tunnel."""

    __slots__ = (
        "_commands",
        "_ready",
        "_thread",
        "_failure",
        "_runtime",
        "_context",
        "_proxy",
        "_display",
        "_profile_handle",
        "_profile_lease",
        "_ignore_https_errors",
        "_closed",
    )

    def __init__(self, profile_handle: object, *, ignore_https_errors: bool) -> None:
        if type(ignore_https_errors) is not bool:
            raise TypeError("ignore_https_errors must be a bool")
        if not callable(getattr(profile_handle, "acquire_runtime", None)):
            raise TypeError("profile_handle must expose acquire_runtime()")
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
        self._proxy: BrowserConnectProxy | None = None
        self._display: HeadedDisplayLease | None = None
        self._profile_handle = profile_handle
        self._profile_lease: object | None = None
        self._ignore_https_errors = ignore_https_errors
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
        if command.failure:
            if isinstance(command.failure[0], TimeoutError):
                raise TimeoutError from None
            raise _runtime_error()
        if not command.result:
            raise _runtime_error()
        return cast(_T, command.result[0])

    def launch_context(
        self,
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
            profile_lease = _required_callable(self._profile_handle, "acquire_runtime")()
            directory = _runtime_profile_directory(profile_lease)
            self._profile_lease = profile_lease
            _configure_pdf_download_preference(directory)
            proxy = BrowserConnectProxy(maximum_article_bytes=_MAX_ARTICLE_BYTES)
            display = acquire_headed_display()
            self._proxy = proxy
            self._display = display
            options: dict[str, object] = {
                "headless": False,
                "accept_downloads": True,
                "downloads_path": downloads_path,
                "service_workers": "block",
                "no_viewport": True,
                "ignore_https_errors": self._ignore_https_errors,
                "proxy": {"server": proxy.server_url},
                "env": display.environment(),
                "args": (
                    "--disable-background-networking",
                    "--disable-component-update",
                    "--disable-default-apps",
                    "--disable-pdf-extension",
                    "--disable-sync",
                    "--no-first-run",
                ),
            }
            if _stable_chrome_available():
                options["channel"] = "chrome"
            try:
                raw_context = launch_persistent(os.fspath(directory), **options)
            except BaseException:
                if "channel" not in options:
                    raise
                options.pop("channel")
                raw_context = launch_persistent(os.fspath(directory), **options)
            context = _Context(self, raw_context, proxy, Path(downloads_path))
            self._context = context
            return context

        return self.call(launch)

    def interrupt(self) -> None:
        context = self._context
        if context is not None:
            context.interrupt_transport()

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
        if not self._start_runtime():
            return
        self._ready.set()
        self._run_commands()
        cleanup_failure = self._stop_runtime()
        if cleanup_failure is not None:
            self._failure = cleanup_failure

    def _start_runtime(self) -> bool:
        try:
            from playwright.sync_api import sync_playwright

            manager = sync_playwright()
            self._runtime = _required_callable(manager, "start")()
        except BaseException as error:
            self._failure = error
            self._ready.set()
            return False
        return True

    def _run_commands(self) -> None:
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

    def _stop_runtime(self) -> BaseException | None:
        cleanup_failure: BaseException | None = None
        try:
            if self._context is not None:
                self._context.close_from_engine()
            runtime = self._runtime
            if runtime is not None:
                _required_callable(runtime, "stop")()
        except BaseException as error:
            cleanup_failure = error
        self._runtime = None
        proxy = self._proxy
        self._proxy = None
        cleanup_failure = self._close_cleanup_resource(proxy, cleanup_failure)
        display = self._display
        self._display = None
        cleanup_failure = self._close_cleanup_resource(display, cleanup_failure)
        profile_lease = self._profile_lease
        self._profile_lease = None
        return self._close_cleanup_resource(profile_lease, cleanup_failure)

    @staticmethod
    def _close_cleanup_resource(
        resource: object | None,
        prior: BaseException | None,
    ) -> BaseException | None:
        if resource is None:
            return prior
        try:
            _required_callable(resource, "close")()
        except BaseException as error:
            return prior or error
        return prior


def _runtime_profile_directory(profile_lease: object) -> Path:
    candidate = _optional_value(profile_lease, "directory")
    if not isinstance(candidate, Path):
        raise _runtime_error()
    try:
        if candidate.is_symlink() or not candidate.is_dir():
            raise _runtime_error()
    except PlaywrightRuntimeError:
        raise
    except OSError:
        raise _runtime_error() from None
    return candidate


def _configure_pdf_download_preference(directory: Path) -> None:
    """Make native PDF navigation produce a bounded Chrome download event.

    An empty newly initialized profile is seeded once. Existing user settings
    are never overwritten: profile history, authentication state, extensions,
    preferences and site data belong to the operator-managed identity.
    """

    try:
        default = directory / "Default"
        default.mkdir(mode=0o700, parents=False, exist_ok=True)
        preferences = default / "Preferences"
        if preferences.exists():
            if preferences.is_symlink() or not preferences.is_file():
                raise _runtime_error()
            return
        preferences.write_text(
            json.dumps(
                {"plugins": {"always_open_pdf_externally": True}},
                separators=(",", ":"),
                sort_keys=True,
            ),
            encoding="utf-8",
        )
        os.chmod(preferences, 0o600)
    except OSError:
        raise _runtime_error() from None


class _Route:
    __slots__ = ("_article", "_context", "_raw", "request", "_binding", "_finished")

    def __init__(
        self,
        context: _Context,
        article: _ArticleContext,
        raw: object,
        request: _Request,
    ) -> None:
        self._context = context
        self._article = article
        self._raw = raw
        self.request = request
        self._binding: object | None = None
        self._finished = False

    def bind_connection(self, binding: object) -> object:
        if self._finished or self._binding is not None:
            raise _runtime_error()
        acknowledged = self._context.proxy.authorize(self._article.article_token, binding)
        if acknowledged is not binding:
            raise _runtime_error()
        self._binding = binding
        return binding

    def continue_(self) -> None:
        if self._finished or self._binding is None:
            raise _runtime_error()
        try:
            _required_callable(self._raw, "continue_")()
        except BaseException:
            raise _runtime_error() from None
        self._finished = True

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
    __slots__ = ("article", "context", "engine", "raw", "_closed", "_navigation_url")

    def __init__(self, context: _Context, article: _ArticleContext, raw: object) -> None:
        self.context = context
        self.article = article
        self.engine = context.engine
        self.raw = raw
        self._closed = False
        self._navigation_url: str | None = None

    @property
    def article_token(self) -> object:
        return self.article.article_token

    @property
    def url(self) -> str:
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
        if type(url) is not str or type(timeout) is not int or timeout <= 0:
            raise _runtime_error()
        self.context.clear_navigation_response(self)
        try:
            _required_callable(self.raw, "goto")(
                url,
                timeout=timeout,
                wait_until="domcontentloaded",
            )
        except BaseException as error:
            if _is_playwright_timeout(error):
                raise TimeoutError from None
            remembered = self.context.navigation_response(self)
            if remembered is None:
                raise _runtime_error() from None
        remembered = self.context.navigation_response(self)
        if remembered is None:
            raise _runtime_error()
        current_url = _string_value(self.raw, "url")
        if urlsplit(current_url).scheme.casefold() in {"http", "https"}:
            self._navigation_url = current_url
        else:
            self._navigation_url = remembered.url
        return remembered

    def open_popup(self, url: str) -> _Page:
        return self.article.open_page(url)

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
            stage = "locator"
            try:
                locator = _required_callable(self.raw, "locator")(selector)
                # Marker selectors describe a bounded page fact, not a strict
                # locator assertion. Real article pages can contain multiple
                # matching elements (notably HTML ``title`` plus SVG
                # ``title`` nodes); Playwright's strict text_content call
                # would turn that ordinary DOM shape into a runtime failure.
                # DOM order plus the reviewed static selector gives one
                # deterministic, bounded value.
                locator = _optional_value(locator, "first")
                if locator is None:
                    raise _runtime_error()
                stage = "text-content"
                text_content = _required_callable(locator, "text_content")
                stage = "vendor-call"
                return text_content(timeout=timeout)
            except BaseException as error:
                if _is_playwright_timeout(error):
                    return None
                _LOGGER.debug(
                    "event=browser-native-page-operation-failed "
                    "operation=text-content stage=%s exception_type=%s "
                    "failure_category=%s page_closed=%s code=runtime",
                    stage,
                    type(error).__name__,
                    _playwright_error_category(error),
                    str(_optional_value(self.raw, "is_closed") is True).lower(),
                )
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
            stage = "locator"
            try:
                locator = _required_callable(self.raw, "locator")(selector)
                # ``count`` is a non-waiting DOM-presence query. Playwright's
                # locator ``wait_for`` can monopolize the single engine thread
                # while route interception is active even when given a short
                # vendor timeout, so it is not a safe marker primitive here.
                stage = "vendor-call"
                return _required_callable(locator, "count")()
            except BaseException as error:
                _LOGGER.debug(
                    "event=browser-native-page-operation-failed "
                    "operation=selector-count stage=%s exception_type=%s "
                    "failure_category=%s page_closed=%s code=runtime",
                    stage,
                    type(error).__name__,
                    _playwright_error_category(error),
                    str(_optional_value(self.raw, "is_closed") is True).lower(),
                )
                raise

        try:
            value = self.engine.call(count)
        except BaseException:
            raise _runtime_error() from None
        if type(value) is not int or value < 0:
            raise _runtime_error()
        return value > 0

    def discover_pdf_locators(self) -> tuple[str, ...]:
        """Discover bounded browser-resolved PDF entry points without clicking."""

        script = """
        () => {
          const values = [];
          const seen = new Set();
          const add = (raw) => {
            if (typeof raw !== 'string' || !raw.trim()) return;
            try {
              const value = new URL(raw, document.baseURI).href;
              const parsed = new URL(value);
              if (!['http:', 'https:'].includes(parsed.protocol)) return;
              if (value.length > 8192 || seen.has(value)) return;
              seen.add(value);
              values.push(value);
            } catch (_) {}
          };
          document.querySelectorAll(
            "meta[name='citation_pdf_url'], meta[name='wkhealth_pdf_url'], " +
            "meta[name='eprints.document_url'], meta[property='citation_pdf_url']"
          ).forEach((node) => add(node.getAttribute('content')));
          document.querySelectorAll('a[href], iframe[src], embed[src], object[data]')
            .forEach((node) => {
              const raw = node.getAttribute('href') || node.getAttribute('src') ||
                node.getAttribute('data');
              const label = [node.textContent, node.getAttribute('aria-label'),
                node.getAttribute('title'), raw].filter(Boolean).join(' ').toLowerCase();
              const mediaType = (node.getAttribute('type') || '').toLowerCase();
              if (/supplement|supporting information|appendix|extended data/.test(label)) return;
              if (mediaType.includes('pdf') ||
                  /(^|[\\s_-])(download[\\s_-]*)?pdf($|[\\s_-])|full[\\s_-]*text/.test(label) ||
                  /\\.pdf(?:$|[?#])|\\/(?:pdf|epdf|pdfdirect|pdfft)(?:$|[/?#])/.test(label)) {
                add(raw);
              }
            });
          return values.slice(0, 16);
        }
        """
        value = self.engine.call(lambda: _required_callable(self.raw, "evaluate")(script))
        if not isinstance(value, list) or len(value) > _MAX_DISCOVERED_PDF_LOCATORS:
            raise _runtime_error()
        result: list[str] = []
        for item in value:
            if type(item) is not str or not item or len(item) > _MAX_DISCOVERED_LOCATOR_LENGTH:
                raise _runtime_error()
            result.append(item)
        return tuple(result)

    def click(self, selector: str, *, timeout: int) -> bool:
        def click() -> bool:
            try:
                locator = _required_callable(self.raw, "locator")(selector)
                locator = _required_callable(locator, "filter")(visible=True)
                locator = cast(Any, locator).first
                _required_callable(locator, "click")(
                    timeout=timeout,
                    no_wait_after=True,
                )
            except BaseException as error:
                if _is_playwright_timeout(error):
                    _LOGGER.debug("event=browser-native-click-finished outcome=not-actionable")
                    return False
                _LOGGER.debug(
                    "event=browser-native-page-operation-failed operation=click "
                    "failure_category=%s page_closed=%s code=runtime",
                    _playwright_error_category(error),
                    str(_optional_value(self.raw, "is_closed") is True).lower(),
                )
                raise
            return True

        try:
            clicked = self.engine.call(click)
        except BaseException:
            raise _runtime_error() from None
        if type(clicked) is not bool or not clicked:
            return False
        try:
            current_url = self.url
        except PlaywrightRuntimeError:
            return True
        if urlsplit(current_url).scheme.casefold() in {"http", "https"}:
            self._navigation_url = current_url
        return True

    def fill(self, selector: str, value: str, *, timeout: int) -> None:
        self.engine.call(lambda: cast(Any, self.raw).fill(selector, value, timeout=timeout))

    def abort(self) -> None:
        self.article.interrupt_transport()

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


class _ArticleContext:
    """One Publisher article capability view over the shared native context."""

    __slots__ = ("_context", "_state", "_closed")

    def __init__(self, context: _Context, state: _ArticleState) -> None:
        self._context = context
        self._state = state
        self._closed = False

    @property
    def engine(self) -> _Engine:
        return self._context.engine

    @property
    def article_token(self) -> object:
        return self._state.token

    def bind_connection(self, binding: object) -> object:
        if self._closed or not self._state.active:
            raise _runtime_error()
        return self._context.bind_article_connection(self, binding)

    def route(self, pattern: str, handler: Callable[[object], object]) -> None:
        if (
            self._closed
            or not self._state.active
            or pattern != "**/*"
            or not callable(handler)
            or self._state.route_handler is not None
        ):
            raise _runtime_error()
        self._state.route_handler = handler

    def on(self, event: str, handler: Callable[[object], object]) -> None:
        if (
            self._closed
            or not self._state.active
            or event in self._state.event_handlers
            or event not in {"page", "download", "response", "requestfinished", "requestfailed"}
            or not callable(handler)
        ):
            raise _runtime_error()
        self._state.event_handlers[event] = handler

    def new_page(self) -> _Page:
        if self._closed or not self._state.active:
            raise _runtime_error()
        return self._context.new_article_page(self)

    def open_page(self, url: str) -> _Page:
        page = self.new_page()
        page.goto(url, timeout=int(_COMMAND_TIMEOUT_SECONDS * 1000))
        return page

    def consume_article_bytes(self, amount: int) -> bool:
        if self._closed or not self._state.active or type(amount) is not int or amount < 0:
            return False
        self._state.article_bytes += amount
        return self._state.article_bytes <= _MAX_ARTICLE_BYTES

    def interrupt_transport(self) -> None:
        self._context.interrupt_article_transport(self)

    def abort(self) -> None:
        self.interrupt_transport()

    cancel = abort
    stop = abort

    @property
    def pages(self) -> tuple[_Page, ...]:
        return self._context.article_pages(self)

    def end_article(self) -> bool:
        if self._closed:
            return False
        self._closed = True
        return self._context.end_article(self)

    def close(self) -> None:
        if not self._closed:
            self.end_article()


class _Context:
    """One persistent native context multiplexed across Publisher article lanes."""

    __slots__ = (
        "engine",
        "raw",
        "proxy",
        "downloads_root",
        "_dispatcher",
        "_articles",
        "_lane_tokens",
        "_pages",
        "_requests",
        "_request_states",
        "_article_lock",
        "_event_lock",
        "_creating_article_token",
        "_closed",
        "_cleanup_failed",
    )

    def __init__(
        self,
        engine: _Engine,
        raw: object,
        proxy: BrowserConnectProxy,
        downloads_root: Path,
    ) -> None:
        self.engine = engine
        self.raw = raw
        self.proxy = proxy
        self.downloads_root = downloads_root
        self._dispatcher = _EventDispatcher()
        self._articles: dict[object, _ArticleState] = {}
        self._lane_tokens: dict[str, object] = {}
        self._pages: dict[int, _Page] = {}
        self._requests: dict[object, _Request] = {}
        self._request_states: dict[object, _NativeRequestState] = {}
        self._article_lock = threading.Lock()
        self._event_lock = threading.Lock()
        self._creating_article_token: object | None = None
        self._closed = False
        self._cleanup_failed = False
        try:
            cast(Any, raw).route("**/*", lambda value: self._on_route(value))
            cast(Any, raw).on("page", lambda value: self._on_page(value))
            cast(Any, raw).on("response", lambda value: self._on_response(value))
            cast(Any, raw).on(
                "requestfinished",
                lambda value: self._on_request_complete("requestfinished", value),
            )
            cast(Any, raw).on(
                "requestfailed",
                lambda value: self._on_request_complete("requestfailed", value),
            )
        except BaseException:
            raise _runtime_error() from None

    def bind_connection(self, binding: object) -> object:
        if self._closed:
            raise _runtime_error()
        return binding

    def begin_article(
        self,
        *,
        lane_key: str,
        downloads_path: str,
        connection_binding: object,
    ) -> _ArticleContext:
        state = self._register_article(lane_key, downloads_path)
        try:
            self._start_article_transport(state, connection_binding)
        except BaseException:
            try:
                self.proxy.end_lane(state.token)
            except BaseException:
                pass
            with self._article_lock:
                self._articles.pop(state.token, None)
                self._lane_tokens.pop(lane_key, None)
            raise _runtime_error() from None
        return _ArticleContext(self, state)

    def _register_article(self, lane_key: str, downloads_path: str) -> _ArticleState:
        if type(lane_key) is not str or not lane_key:
            raise _runtime_error()
        if type(downloads_path) is not str or not downloads_path:
            raise _runtime_error()
        try:
            directory = Path(downloads_path)
            if directory.is_symlink() or not directory.is_dir():
                raise _runtime_error()
        except PlaywrightRuntimeError:
            raise
        except OSError:
            raise _runtime_error() from None
        state = _ArticleState(lane_key=lane_key)
        with self._article_lock:
            if self._closed or lane_key in self._lane_tokens:
                raise _runtime_error()
            self._articles[state.token] = state
            self._lane_tokens[lane_key] = state.token
        return state

    def _start_article_transport(
        self,
        state: _ArticleState,
        connection_binding: object,
    ) -> None:
        if self.proxy.begin_lane(state.token) is not state.token:
            raise _runtime_error()
        acknowledged = self.proxy.authorize(state.token, connection_binding)
        if acknowledged is not connection_binding:
            raise _runtime_error()

    def bind_article_connection(
        self,
        article: _ArticleContext,
        binding: object,
    ) -> object:
        state = self._article_state(article)
        try:
            acknowledged = self.proxy.authorize(state.token, binding)
        except BaseException:
            raise _runtime_error() from None
        if acknowledged is not binding:
            raise _runtime_error()
        return binding

    def end_article(self, article: _ArticleContext) -> bool:
        state = self._article_state(article, require_active=False)
        if not state.active:
            return False
        try:
            self.engine.call(lambda: self._pump_once(25, state.token))
        except PlaywrightRuntimeError:
            state.cleanup_failed = True
        drained = self._dispatcher.drain()
        if state.transport_drained:
            transport_drained = True
        else:
            try:
                transport_drained = self.proxy.end_lane(state.token)
            except BaseException:
                transport_drained = False
            state.transport_drained = transport_drained
        state.active = False
        if not self._dispatcher.drain():
            drained = False
        if not self._close_remaining_article_pages(state):
            state.cleanup_failed = True
        for key in tuple(state.request_keys):
            self._requests.pop(key, None)
            self._request_states.pop(key, None)
        state.request_keys.clear()
        state.navigation_responses.clear()
        with self._article_lock:
            self._articles.pop(state.token, None)
            if self._lane_tokens.get(state.lane_key) is state.token:
                self._lane_tokens.pop(state.lane_key, None)
        _LOGGER.debug(
            "event=browser-native-article-drained lane_key=%s event_queue_drained=%s "
            "connect_tunnel_drained=%s article_cleanup_failed=%s",
            state.lane_key,
            str(drained).lower(),
            str(transport_drained).lower(),
            str(state.cleanup_failed).lower(),
        )
        return drained and transport_drained and not state.cleanup_failed

    def new_article_page(self, article: _ArticleContext) -> _Page:
        state = self._article_state(article)

        def create() -> _Page:
            if self._creating_article_token is not None:
                raise _runtime_error()
            self._creating_article_token = state.token
            try:
                raw_page = cast(Any, self.raw).new_page()
            finally:
                self._creating_article_token = None
            return self._page(raw_page, state)

        return self.engine.call(create)

    def pump_events_from_engine(self) -> None:
        """Give Chromium a bounded sync-API turn while lanes are active."""

        if self._closed or not any(state.active for state in self._articles.values()):
            return
        try:
            self._pump_once(max(1, int(_EVENT_PUMP_INTERVAL_SECONDS * 1000)), None)
        except BaseException:
            self._cleanup_failed = True

    def _pump_once(self, milliseconds: int, article_token: object | None) -> None:
        page = next(
            (
                candidate
                for candidate in self._pages.values()
                if not candidate._closed
                and (article_token is None or candidate.article_token is article_token)
            ),
            None,
        )
        if page is not None:
            cast(Any, page.raw).wait_for_timeout(milliseconds)

    def navigation_response(self, page: _Page) -> _NavigationResponse | None:
        state = self._articles.get(page.article_token)
        return None if state is None else state.navigation_responses.get(id(page))

    def clear_navigation_response(self, page: _Page) -> None:
        state = self._articles.get(page.article_token)
        if state is not None:
            state.navigation_responses.pop(id(page), None)

    def forget_page(self, page: _Page) -> None:
        """Release one article page wrapper after deterministic cleanup."""

        self._pages.pop(id(page.raw), None)
        state = self._articles.get(page.article_token)
        if state is not None:
            state.page_keys.discard(id(page.raw))
            state.navigation_responses.pop(id(page), None)

    def article_pages(self, article: _ArticleContext) -> tuple[_Page, ...]:
        state = self._article_state(article, require_active=False)
        return tuple(
            page for key in tuple(state.page_keys) if (page := self._pages.get(key)) is not None
        )

    def interrupt_article_transport(self, article: _ArticleContext) -> None:
        state = self._article_state(article, require_active=False)
        if not state.active or state.transport_drained:
            return
        try:
            state.transport_drained = self.proxy.end_lane(state.token)
        except BaseException:
            state.cleanup_failed = True

    def interrupt_transport(self) -> None:
        for state in tuple(self._articles.values()):
            if not state.active or state.transport_drained:
                continue
            try:
                state.transport_drained = self.proxy.end_lane(state.token)
            except BaseException:
                state.cleanup_failed = True
                self._cleanup_failed = True

    abort = interrupt_transport
    cancel = interrupt_transport
    stop = interrupt_transport

    @property
    def pages(self) -> tuple[_Page, ...]:
        return tuple(self._pages.values())

    def close(self) -> None:
        if self._closed:
            if self._cleanup_failed:
                raise _runtime_error()
            return
        self.interrupt_transport()
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
        for state in self._articles.values():
            state.active = False
        try:
            cast(Any, self.raw).close()
        except BaseException:
            raise _runtime_error() from None

    def _article_state(
        self,
        article: _ArticleContext,
        *,
        require_active: bool = True,
    ) -> _ArticleState:
        if not isinstance(article, _ArticleContext) or article._context is not self:
            raise _runtime_error()
        state = self._articles.get(article.article_token)
        if state is None or state is not article._state:
            raise _runtime_error()
        if require_active and not state.active:
            raise _runtime_error()
        return state

    def _page(self, raw_page: object, state: _ArticleState) -> _Page:
        if not state.active:
            raise _runtime_error()
        key = id(raw_page)
        page = self._pages.get(key)
        if page is not None:
            if page.article_token is not state.token:
                raise _runtime_error()
            return page
        article = _ArticleContext(self, state)
        page = _Page(self, article, raw_page)
        self._pages[key] = page
        state.page_keys.add(key)
        try:
            cast(Any, raw_page).on(
                "download",
                lambda value, page=page: self._on_download(page, value),
            )
        except BaseException:
            self._pages.pop(key, None)
            state.page_keys.discard(key)
            raise _runtime_error() from None
        return page

    def _on_page(self, raw_page: object) -> None:
        try:
            token = self._creating_article_token
            explicit = token is not None
            if token is None:
                opener = _optional_value(raw_page, "opener")
                opener_page = None if opener is None else self._pages.get(id(opener))
                token = None if opener_page is None else opener_page.article_token
            state = None if token is None else self._articles.get(token)
            if state is None or not state.active:
                cast(Any, raw_page).close()
                return
            page = self._page(raw_page, state)
            if not explicit:
                self._emit(state, "page", page)
        except BaseException:
            self._cleanup_failed = True

    def _on_route(self, raw_route: object) -> None:
        request: _Request | None = None
        state: _ArticleState | None = None
        try:
            raw_request = cast(Any, raw_route).request
            page = self._request_page(raw_request)
            if page is None:
                _abort_raw_route(raw_route)
                return
            state = self._articles.get(page.article_token)
            if state is None or not state.active or state.route_handler is None:
                _abort_raw_route(raw_route)
                return
            request = self._request(raw_request, page)
            state.route_handler(_Route(self, page.article, raw_route, request))
        except BaseException:
            _abort_raw_route(raw_route)
            if state is not None:
                self._emit(state, "requestfailed", request if request is not None else raw_route)

    def _request_page(self, raw_request: object) -> _Page | None:
        try:
            frame = cast(Any, raw_request).frame
            raw_page = frame.page
        except BaseException:
            return None
        return self._pages.get(id(raw_page))

    def _request(self, raw_request: object, page: _Page | None = None) -> _Request:
        key = _vendor_identity(raw_request)
        request = self._requests.get(key)
        if request is None:
            raw_previous = _optional_value(raw_request, "redirected_from")
            previous = None if raw_previous is None else self._request(raw_previous)
            request = _Request(
                raw_request,
                self._request_page(raw_request) if page is None else page,
                previous,
            )
            if request.article_token is None:
                raise _runtime_error()
            state = self._articles.get(request.article_token)
            if state is None or not state.active:
                raise _runtime_error()
            self._requests[key] = request
            state.request_keys.add(key)
            previous_state = (
                None
                if previous is None
                else self._request_states.get(_vendor_identity(previous.raw))
            )
            root = None if previous_state is None else previous_state.root
            self._request_states[key] = _NativeRequestState(request=request, root=root)
        return request

    def _request_state(self, raw_request: object) -> _NativeRequestState:
        request = self._request(raw_request)
        state = self._request_states.get(_vendor_identity(raw_request))
        if state is None or state.request is not request:
            raise _runtime_error()
        return state

    def _on_response(self, raw_response: object) -> None:
        native_state: _NativeRequestState | None = None
        article_state: _ArticleState | None = None
        stage = "request"
        try:
            raw_request = cast(Any, raw_response).request
            native_state = self._request_state(raw_request)
            request = native_state.request
            article_state = self._articles.get(request.article_token)
            if article_state is None or not article_state.active:
                return
            stage = "status"
            status = _optional_value(raw_response, "status")
            if type(status) is not int or not 100 <= status <= 599:
                raise _runtime_error()
            with self._event_lock:
                native_state.response_seen = True
                native_state.response_redirects = status in {301, 302, 303, 307, 308}
                native_state.response_pending += 1
            stage = "response-view"
            article = _ArticleContext(self, article_state)
            response = _Response(self, article, raw_response, request)
            stage = "navigation-view"
            page = request.page
            if page is not None and request.is_navigation_request():
                article_state.navigation_responses[id(page)] = _NavigationResponse(
                    response.url,
                    response.status,
                    response.media_type,
                )
            handler = article_state.event_handlers.get("response")
            if handler is not None:
                stage = "dispatch"
                self._dispatcher.submit(
                    lambda: self._dispatch_response(
                        article_state,
                        native_state,
                        handler,
                        response,
                    )
                )
            else:
                stage = "finish"
                self._finish_response(native_state)
        except BaseException as error:
            response_field = error.field if isinstance(error, _ResponseViewError) else "unknown"
            _LOGGER.debug(
                "event=browser-native-event-failed browser_event=response stage=%s "
                "response_field=%s exception_type=%s code=runtime",
                stage,
                response_field,
                type(error).__name__,
            )
            if native_state is not None:
                self._finish_response(native_state)
            if article_state is None:
                self._cleanup_failed = True
            else:
                article_state.cleanup_failed = True

    def _on_request_complete(self, event: str, raw_request: object) -> None:
        article_state: _ArticleState | None = None
        try:
            native_state = self._request_state(raw_request)
            article_state = self._articles.get(native_state.request.article_token)
            if article_state is None or not article_state.active:
                return
            with self._event_lock:
                if native_state.completion_event is None:
                    native_state.completion_event = event
                elif native_state.completion_event != event:
                    raise _runtime_error()
                ready = self._ready_completions_locked(native_state)
            for completion_event, request in ready:
                self._emit(article_state, completion_event, request)
        except BaseException:
            _LOGGER.debug(
                "event=browser-native-event-failed browser_event=%s code=runtime",
                event,
            )
            if article_state is None:
                self._cleanup_failed = True
            else:
                article_state.cleanup_failed = True

    def _dispatch_response(
        self,
        article_state: _ArticleState,
        native_state: _NativeRequestState,
        handler: Callable[[object], object],
        response: _Response,
    ) -> None:
        self._invoke_handler(article_state, "response", handler, response)
        ready = self._finish_response(native_state)
        for event, request in ready:
            completion_handler = article_state.event_handlers.get(event)
            if completion_handler is not None:
                self._invoke_handler(
                    article_state,
                    event,
                    completion_handler,
                    request,
                )

    def _finish_response(
        self,
        native_state: _NativeRequestState,
    ) -> tuple[tuple[str, _Request], ...]:
        with self._event_lock:
            if native_state.response_pending <= 0:
                return ()
            native_state.response_pending -= 1
            return self._ready_completions_locked(native_state)

    @staticmethod
    def _ready_completions_locked(
        native_state: _NativeRequestState,
    ) -> tuple[tuple[str, _Request], ...]:
        root = native_state.root
        if root is None:
            raise _runtime_error()
        chain = tuple(root.chain)
        if any(item.response_pending for item in chain):
            return ()
        terminal = chain[-1]
        if terminal.completion_event == "requestfinished" and not terminal.response_seen:
            return ()
        if terminal.response_seen and terminal.response_redirects:
            return ()
        if terminal.completion_event is None:
            return ()
        ready: list[tuple[str, _Request]] = []
        for item in chain:
            if item.completion_event is None or item.completion_submitted:
                continue
            item.completion_submitted = True
            ready.append((item.completion_event, item.request))
        return tuple(ready)

    def _on_download(self, page: _Page, raw_download: object) -> None:
        article_state = self._articles.get(page.article_token)
        try:
            if article_state is None or not article_state.active:
                cast(Any, raw_download).delete()
                return
            self._emit(
                article_state,
                "download",
                _Download(self, page.article, raw_download),
            )
        except BaseException:
            _LOGGER.debug("event=browser-native-event-failed browser_event=download code=runtime")
            if article_state is None:
                self._cleanup_failed = True
            else:
                article_state.cleanup_failed = True

    def _emit(self, article_state: _ArticleState, event: str, value: object) -> None:
        handler = article_state.event_handlers.get(event)
        if handler is None:
            return
        self._dispatcher.submit(lambda: self._invoke_handler(article_state, event, handler, value))

    @staticmethod
    def _invoke_handler(
        article_state: _ArticleState,
        event: str,
        handler: Callable[[object], object],
        value: object,
    ) -> None:
        try:
            handler(value)
        except BaseException as error:
            article_state.cleanup_failed = True
            _LOGGER.debug(
                "event=browser-native-handler-failed browser_event=%s "
                "exception_type=%s code=runtime",
                event,
                type(error).__name__,
            )

    def _close_remaining_article_pages(self, state: _ArticleState) -> bool:
        pages = tuple(
            page for key in tuple(state.page_keys) if (page := self._pages.get(key)) is not None
        )
        cleaned = True
        for page in pages:
            if page._closed:
                self.forget_page(page)
                continue
            try:
                self.engine.call(lambda page=page: cast(Any, page.raw).close())
                page._closed = True
                self.forget_page(page)
            except BaseException:
                cleaned = False
        return cleaned


def _abort_raw_route(raw_route: object) -> None:
    try:
        cast(Any, raw_route).abort()
    except BaseException:
        return


class _Process:
    __slots__ = ("_engine", "_closed")

    def __init__(self, engine: _Engine) -> None:
        self._engine = engine
        self._closed = False

    def bind_connection(self, binding: object) -> object:
        if self._closed:
            raise _runtime_error()
        return binding

    def new_context(
        self,
        *,
        downloads_path: str,
        accept_downloads: bool,
        connection_binding: object,
    ) -> _Context:
        del connection_binding
        if self._closed or not accept_downloads:
            raise _runtime_error()
        return self._engine.launch_context(downloads_path)

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

    __slots__ = ("_ignore_https_errors", "_profile_handle")

    def __init__(self, profile_handle: object, *, ignore_https_errors: bool = False) -> None:
        if type(ignore_https_errors) is not bool:
            raise TypeError("ignore_https_errors must be a bool")
        if not callable(getattr(profile_handle, "acquire_runtime", None)):
            raise TypeError("profile_handle must expose acquire_runtime()")
        self._profile_handle = profile_handle
        self._ignore_https_errors = ignore_https_errors

    def __call__(
        self,
        *,
        downloads_path: str,
        connection_binding: object,
    ) -> object:
        del downloads_path, connection_binding
        engine = _Engine(
            self._profile_handle,
            ignore_https_errors=self._ignore_https_errors,
        )
        try:
            engine.start()
            return _Process(engine)
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
