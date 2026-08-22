"""Thread-neutral Playwright API wrappers for the controlled Browser boundary.

The synchronous Playwright API is thread-affine, while :mod:`network.browser`
executes every potentially blocking vendor operation in a cancellable worker.
The production CloakBrowser adapter therefore owns one engine thread and uses
the wrappers in this module to marshal isolated Publisher article lanes onto
Playwright's synchronous API. Every HTTP(S) request is intercepted for
destination admission and then continued through Chromium's native network
stack.

Only opaque vendor wrappers cross into ``network.browser``. Cookies remain in
the operator-managed persistent profile, response and download bodies remain
bounded, and no URL, header, Cookie, profile path, workspace path, or vendor
exception is included in adapter errors or representations. This module does
not discover or launch a stock Chrome/Chromium runtime.
"""

from __future__ import annotations

import queue
import secrets
import threading
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Final, Protocol, TypeVar, cast
from urllib.parse import urlsplit, urlunsplit

from sciretriever.logging.api import get_logger

from .browser_connect import BrowserConnectProxy

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


class _EnginePort(Protocol):
    """Minimal thread-marshalling contract implemented by the Cloak engine."""

    def call(self, operation: Callable[[], _T]) -> _T: ...


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


def _query_free_http_url(value: object) -> str | None:
    """Return one safe query-free HTTP(S) frame locator, if available."""

    if type(value) is not str:
        return None
    try:
        parsed = urlsplit(value)
    except (TypeError, ValueError):
        return None
    if (
        parsed.scheme.casefold() not in {"http", "https"}
        or parsed.username is not None
        or parsed.password is not None
    ):
        return None
    try:
        return urlunsplit((parsed.scheme.casefold(), parsed.netloc, parsed.path or "/", "", ""))
    except ValueError:
        return None


def _frame_observation(raw_request: object) -> tuple[bool, int | None, tuple[str, ...], str | None]:
    """Extract bounded frame ancestry without retaining vendor objects."""

    frame = _optional_value(raw_request, "frame")
    if frame is None:
        return False, None, (), None
    frames: list[str | None] = []
    current = frame
    seen: set[int] = set()
    while current is not None and len(frames) <= 16:
        identity = id(current)
        if identity in seen:
            return False, None, (), None
        seen.add(identity)
        frames.append(_query_free_http_url(_optional_value(current, "url")))
        current = _optional_value(current, "parent_frame")
    if current is not None:
        return False, None, (), None
    if not frames:
        return False, 0, (), None
    # ``frames`` is child -> parent; ancestry exposed to Network excludes the
    # current frame and preserves parent-first order for rule checks.  Keep
    # unknown/opaque child URLs as depth evidence so an about:blank iframe
    # cannot be mistaken for a top-frame request.
    is_top = len(frames) == 1
    ancestry = tuple(value for value in reversed(frames[1:]) if value is not None)
    top_locator = next((value for value in reversed(frames) if value is not None), None)
    return is_top, len(frames) - 1, ancestry, top_locator


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


def _is_cloak_actionability_error(error: BaseException) -> bool:
    """Recognize only CloakBrowser's bounded human-actionability miss.

    CloakBrowser 0.5.8's ``humanize=True`` page actions do not use
    Playwright's ``TimeoutError`` for an element that remains non-actionable.
    The human layer raises its closed ``ActionabilityError`` hierarchy instead.
    Import it lazily so the stock adapter remains usable when the optional
    vendor runtime is absent, and keep all other vendor/runtime failures on the
    fail-closed path.
    """

    try:
        from cloakbrowser.human.actionability import ActionabilityError
    except (ImportError, ModuleNotFoundError):
        return False
    return isinstance(error, ActionabilityError)


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
        "is_top_frame",
        "frame_depth",
        "frame_ancestry",
        "top_frame_locator",
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
        (
            self.is_top_frame,
            self.frame_depth,
            self.frame_ancestry,
            self.top_frame_locator,
        ) = _frame_observation(raw)
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
    page_keys: set[object] = field(default_factory=set)
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
        "_body_source",
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
        # A top-level PDF route may be fetched through Playwright's native
        # ``Route.fetch`` and then fulfilled with the returned APIResponse.
        # Chromium can expose the built-in PDF viewer's HTML from the later
        # response object, while the APIResponse remains the admitted network
        # bytes.  Keep that private source for the body read, but continue to
        # classify the response itself from the normal response event.
        source_reader = getattr(context, "response_body_source", None)
        self._body_source = source_reader(raw, request) if callable(source_reader) else raw
        self.request = request
        self.url = _string_value(raw, "url")
        status = _optional_value(raw, "status")
        if type(status) is not int or not 100 <= status <= 599:
            raise _runtime_error()
        self.status = status
        self.headers = _headers(raw)
        self.media_type = _media_type(self.headers)
        self.size = _content_length(self.headers)
        disposition = next(
            (value for name, value in self.headers if name == "content-disposition"),
            "",
        )
        self.attachment_download = "attachment" in disposition.casefold()
        self.download_expected = self.media_type == "application/pdf" and (
            self.attachment_download
            or (
                context._external_pdf_downloads
                and request.is_navigation_request()
                and self._body_source is raw
            )
        )

    def _read_raw_body(self) -> object:
        return _required_callable(self._body_source, "body")()

    def body(self) -> bytes:
        declared = self.size
        if declared is not None and declared > _MAX_RESPONSE_BYTES:
            raise _runtime_error()
        value = self._context.engine.call(self._read_raw_body)
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


class _FetchedResponse:
    """Bounded, thread-neutral metadata for one native ``Route.fetch`` result."""

    __slots__ = (
        "_route",
        "_raw",
        "url",
        "status",
        "headers",
        "media_type",
        "size",
        "attachment_download",
    )

    def __init__(self, route: _Route, raw: object) -> None:
        self._route = route
        self._raw = raw
        raw_url = _string_value(raw, "url")
        safe_url = _query_free_http_url(raw_url)
        if safe_url is None:
            raise _runtime_error()
        self.url = safe_url
        status = _optional_value(raw, "status")
        if type(status) is not int or not 100 <= status <= 599:
            raise _runtime_error()
        self.status = status
        self.headers = _headers(raw)
        self.media_type = _media_type(self.headers)
        self.size = _content_length(self.headers)
        disposition = next(
            (value for name, value in self.headers if name == "content-disposition"),
            "",
        )
        self.attachment_download = "attachment" in disposition.casefold()


class _Route:
    __slots__ = (
        "_article",
        "_context",
        "_raw",
        "request",
        "_binding",
        "_finished",
        "_fetched_response",
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
        self._binding: object | None = None
        self._finished = False
        self._fetched_response: _FetchedResponse | None = None

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
        if self._fetched_response is not None:
            raise _runtime_error()
        try:
            _required_callable(self._raw, "continue_")()
        except BaseException:
            raise _runtime_error() from None
        self._finished = True

    def fetch(self, *, max_redirects: int = 0) -> _FetchedResponse:
        """Fetch one admitted request without following a native redirect."""

        if (
            self._finished
            or self._binding is None
            or type(max_redirects) is not int
            or max_redirects != 0
            or self._fetched_response is not None
        ):
            raise _runtime_error()
        try:
            raw_response = _required_callable(self._raw, "fetch")(
                max_redirects=max_redirects,
            )
            fetched = _FetchedResponse(self, raw_response)
        except PlaywrightRuntimeError:
            raise
        except BaseException:
            raise _runtime_error() from None
        self._fetched_response = fetched
        return fetched

    def fulfill(self, *, response: object) -> None:
        """Fulfill this route with the exact response returned by ``fetch``."""

        fetched = self._fetched_response
        if self._finished or self._binding is None or fetched is None or response is not fetched:
            raise _runtime_error()
        self._context.save_response_body_source(self.request, fetched._raw)
        try:
            _required_callable(self._raw, "fulfill")(response=fetched._raw)
        except BaseException:
            self._context.clear_response_body_source(self.request)
            raise _runtime_error() from None
        self._fetched_response = None
        self._finished = True

    def abort(self) -> None:
        if self._finished:
            return
        try:
            cast(Any, self._raw).abort()
        except BaseException:
            raise _runtime_error() from None
        finally:
            self._fetched_response = None
            self._finished = True


class _Page:
    __slots__ = (
        "article",
        "context",
        "engine",
        "raw",
        "_closed",
        "_navigation_url",
        "_native_listeners",
        # Request-local Browser Agent element bindings.  These remain on the
        # private adapter side of Network: integer keys are opaque to the
        # Agent and never expose a CSS selector or vendor handle.
        "_agent_key_counter",
        "_agent_marker_key",
        "_agent_locators",
    )

    def __init__(self, context: _Context, article: _ArticleContext, raw: object) -> None:
        self.context = context
        self.article = article
        self.engine = context.engine
        self.raw = raw
        self._closed = False
        self._navigation_url: str | None = None
        self._native_listeners: dict[str, Callable[[object], object]] = {}
        self._agent_key_counter = 1
        # A fresh, page-local Symbol.for key keeps the marker opaque to the
        # Browser Agent and practically unguessable to page scripts.  The
        # marker is still treated as untrusted: click revalidates it and all
        # accessible facts immediately before the humanized Locator action.
        self._agent_marker_key = secrets.token_hex(32)
        self._agent_locators: dict[int, tuple[object, str, str, bool, bool]] = {}

    @property
    def article_token(self) -> object:
        return self.article.article_token

    @property
    def url(self) -> str:
        def current() -> str:
            raw_url = _string_value(self.raw, "url")
            if urlsplit(raw_url).scheme.casefold() in {"http", "https"}:
                # Playwright's raw Page URL is authoritative after a
                # script/click top-frame navigation.  The cached value is
                # only a fallback for internal PDF-viewer/about:blank pages;
                # returning it first would make post-navigation policy and
                # capture checks inspect the previous document.
                self._navigation_url = raw_url
                return raw_url
            return self._navigation_url or raw_url

        return self.engine.call(current)

    def goto(self, url: str, *, timeout: int) -> _NavigationResponse:
        return self.engine.call(lambda: self._goto(url, timeout=timeout))

    def _goto(self, url: str, *, timeout: int) -> _NavigationResponse:  # noqa: C901
        if type(url) is not str or type(timeout) is not int or timeout <= 0:
            raise _runtime_error()
        self.context.clear_navigation_response(self)
        try:
            _required_callable(self.raw, "goto")(
                url,
                timeout=timeout,
                # Return at the network commit point.  A top-level inline PDF
                # immediately transitions into Chromium's built-in viewer;
                # waiting for that viewer's DOMContentLoaded would let the
                # response callback's body command observe the viewer HTML
                # instead of the admitted PDF bytes.  Ordinary HTML waits for
                # DOMContentLoaded explicitly below after its response view
                # has been recorded.
                wait_until="commit",
            )
        except BaseException as error:
            if _is_playwright_timeout(error):
                raise TimeoutError from None
            remembered = self.context.navigation_response(self)
            if remembered is None:
                _LOGGER.debug(
                    "event=browser-native-page-operation-failed operation=navigate "
                    "stage=vendor-call exception_type=%s failure_category=%s "
                    "page_closed=%s code=runtime",
                    type(error).__name__,
                    _playwright_error_category(error),
                    str(_optional_value(self.raw, "is_closed") is True).lower(),
                )
                raise _runtime_error() from None
        remembered = self.context.navigation_response(self)
        if remembered is None:
            _LOGGER.debug(
                "event=browser-native-page-operation-failed operation=navigate "
                "stage=response-correlation failure_category=missing-response "
                "page_closed=%s code=runtime",
                str(_optional_value(self.raw, "is_closed") is True).lower(),
            )
            raise _runtime_error()
        if remembered.media_type != "application/pdf":
            wait_for_load_state = getattr(self.raw, "wait_for_load_state", None)
            if not callable(wait_for_load_state):
                raise _runtime_error()
            try:
                wait_for_load_state("domcontentloaded", timeout=timeout)
            except TypeError:
                # Keep compatibility with small Playwright-like test doubles
                # that expose only the state positional argument.
                try:
                    wait_for_load_state("domcontentloaded")
                except BaseException as error:
                    if _is_playwright_timeout(error):
                        raise TimeoutError from None
                    raise _runtime_error() from None
            except BaseException as error:
                if _is_playwright_timeout(error):
                    raise TimeoutError from None
                raise _runtime_error() from None
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
                    _LOGGER.debug(
                        "event=browser-native-click-finished outcome=not-actionable "
                        "stage=vendor-call exception_type=%s",
                        type(error).__name__,
                    )
                    return False
                if _is_cloak_actionability_error(error):
                    _LOGGER.debug(
                        "event=browser-native-click-finished outcome=not-actionable "
                        "stage=human-actionability exception_type=%s "
                        "failure_category=actionability-miss",
                        type(error).__name__,
                    )
                    return False
                _LOGGER.debug(
                    "event=browser-native-page-operation-failed operation=click "
                    "stage=vendor-call exception_type=%s failure_category=%s "
                    "page_closed=%s code=runtime",
                    type(error).__name__,
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

    def agent_snapshot(self, *, timeout: int) -> dict[str, object]:  # noqa: C901
        """Return bounded neutral facts for the request-local Browser Agent.

        The adapter deliberately returns only opaque integer keys and bounded
        role/name/state facts.  CSS selectors, HTML, cookies and vendor
        handles stay inside this method and are never exposed to the Network
        observation model.  Each matching DOM node receives an opaque,
        request-local marker in the vendor page realm; the marker survives a
        harmless DOM reordering but disappears when the node is replaced, so
        a later click cannot silently fall through to a different ``nth``
        element.  The marker key is never returned across the Network seam.
        """

        if type(timeout) is not int or timeout <= 0:
            raise _runtime_error()
        marker_key = self._agent_marker_key
        script = """
        (seed) => {
          const selector = "a,button,[role='button'],input[type='button']," +
            "input[type='submit'],summary";
          const nodes = Array.from(document.querySelectorAll(selector)).slice(0, 64);
          const marker = Symbol.for("__MARKER__");
          let next = Number(seed);
          return nodes.map((node, key) => {
            let token = node[marker];
            if (!Number.isSafeInteger(token) || token < 1) {
              token = next++;
              node[marker] = token;
            }
            const style = window.getComputedStyle(node);
            const rect = node.getBoundingClientRect();
            const visible = !!(rect.width > 0 && rect.height > 0 &&
              style.visibility !== 'hidden' && style.display !== 'none');
            const disabled = node.hasAttribute('disabled') ||
              node.getAttribute('aria-disabled') === 'true';
            const role = node.getAttribute('role') ||
              (node.tagName.toLowerCase() === 'a' ? 'link' : 'button');
            const rawName = node.getAttribute('aria-label') ||
              node.getAttribute('title') || node.value || node.innerText ||
              node.textContent || role;
            const name = String(rawName).trim().slice(0, 256) || role;
            return {key: token, role: String(role).slice(0, 64), name, visible,
              enabled: !disabled};
          });
        }
        """.replace("__MARKER__", marker_key)

        def read() -> dict[str, object]:
            try:
                seed = self._agent_key_counter
                raw_elements = _required_callable(self.raw, "evaluate")(script, seed)
                if not isinstance(raw_elements, list):
                    raise _runtime_error()
                # Reserve a fresh range for new DOM nodes.  Existing nodes
                # keep their marker, so unchanged observations preserve their
                # revision while replacements naturally receive new keys.
                self._agent_key_counter += len(raw_elements) + 1
                # Bind the Locators before returning from the same engine
                # command as the marker assignment.  This closes the small
                # race in which a framework could reorder nodes between two
                # independent engine calls.
                locator = _required_callable(self.raw, "locator")(
                    "a,button,[role='button'],input[type='button'],input[type='submit'],summary"
                )
                mapping: dict[int, tuple[object, str, str, bool, bool]] = {}
                for index, item in enumerate(raw_elements):
                    if not isinstance(item, dict):
                        raise _runtime_error()
                    key = item.get("key")
                    role = item.get("role")
                    name = item.get("name")
                    visible = item.get("visible")
                    enabled = item.get("enabled")
                    if (
                        type(key) is not int
                        or key < 1
                        or type(role) is not str
                        or type(name) is not str
                        or type(visible) is not bool
                        or type(enabled) is not bool
                    ):
                        raise _runtime_error()
                    item_locator = _required_callable(locator, "nth")(index)
                    if key in mapping:
                        raise _runtime_error()
                    mapping[key] = (item_locator, role, name, visible, enabled)
                self._agent_locators = mapping
                viewport = _optional_value(self.raw, "viewport_size")
                if not isinstance(viewport, dict):
                    viewport = _required_callable(self.raw, "evaluate")(
                        "() => ({width: window.innerWidth, height: window.innerHeight})"
                    )
                screenshot_method = _required_callable(self.raw, "screenshot")
                try:
                    screenshot = screenshot_method(
                        type="jpeg",
                        quality=70,
                        animations="disabled",
                        timeout=timeout,
                        full_page=False,
                    )
                except TypeError:
                    screenshot = screenshot_method(type="jpeg", quality=70)
                return {
                    "width": viewport.get("width") if isinstance(viewport, dict) else None,
                    "height": viewport.get("height") if isinstance(viewport, dict) else None,
                    "screenshot": screenshot,
                    "screenshot_media_type": "image/jpeg",
                    "elements": tuple(
                        (
                            item.get("key"),
                            item.get("role"),
                            item.get("name"),
                            item.get("visible"),
                            item.get("enabled"),
                        )
                        for item in raw_elements
                        if isinstance(item, dict)
                    ),
                }
            except BaseException:
                raise _runtime_error() from None

        return self.engine.call(read)

    def agent_click(
        self,
        key: int,
        *,
        expected_role: str,
        expected_name: str,
        expected_visible: bool,
        expected_enabled: bool,
        expected_locator: str,
        timeout: int,
    ) -> bool:
        if (
            type(key) is not int
            or key < 1
            or type(expected_role) is not str
            or type(expected_name) is not str
            or type(expected_visible) is not bool
            or type(expected_enabled) is not bool
            or type(expected_locator) is not str
            or type(timeout) is not int
            or timeout <= 0
        ):
            raise _runtime_error()

        def click() -> bool:
            try:
                bound = self._agent_locators.get(key)
                if bound is None:
                    raise _runtime_error()
                locator, role, name, visible, enabled = bound
                if (
                    role != expected_role
                    or name != expected_name
                    or visible != expected_visible
                    or enabled != expected_enabled
                ):
                    raise _runtime_error()
                current = _query_free_http_url(_string_value(self.raw, "url"))
                if current is None or current != expected_locator:
                    raise _runtime_error()
                # Re-resolve and validate the marker, accessible facts and
                # visibility immediately before the vendor click.  A stale
                # Locator (for example after a framework rerender) therefore
                # becomes a deterministic runtime failure rather than a click
                # on whichever node now occupies the old nth position.
                verify_script = """
                    (node) => {
                      const marker = Symbol.for("__MARKER__");
                      const style = window.getComputedStyle(node);
                      const rect = node.getBoundingClientRect();
                      const visible = !!(rect.width > 0 && rect.height > 0 &&
                        style.visibility !== 'hidden' && style.display !== 'none');
                      const disabled = node.hasAttribute('disabled') ||
                        node.getAttribute('aria-disabled') === 'true';
                      const role = node.getAttribute('role') ||
                        (node.tagName.toLowerCase() === 'a' ? 'link' : 'button');
                      const rawName = node.getAttribute('aria-label') ||
                        node.getAttribute('title') || node.value || node.innerText ||
                        node.textContent || role;
                      const name = String(rawName).trim().slice(0, 256) || role;
                      return {
                        marker: node[marker], role: String(role).slice(0, 64), name,
                        visible, enabled: !disabled,
                      };
                    }
                    """.replace("__MARKER__", self._agent_marker_key)
                facts = _required_callable(locator, "evaluate")(verify_script)
                if (
                    not isinstance(facts, dict)
                    or facts.get("marker") != key
                    or facts.get("role") != expected_role
                    or facts.get("name") != expected_name
                    or facts.get("visible") is not expected_visible
                    or facts.get("enabled") is not expected_enabled
                ):
                    raise _runtime_error()
                _required_callable(locator, "click")(
                    timeout=timeout,
                    no_wait_after=True,
                )
                return True
            except BaseException as error:
                if _is_playwright_timeout(error):
                    return False
                raise _runtime_error() from None

        return self.engine.call(click)

    def agent_scroll(self, delta_y: int, *, timeout: int) -> None:
        if (
            type(delta_y) is not int
            or delta_y == 0
            or abs(delta_y) > 2_000
            or type(timeout) is not int
            or timeout <= 0
        ):
            raise _runtime_error()

        def scroll() -> None:
            try:
                # CloakBrowser is launched with ``humanize=True``.  Route
                # Agent scroll through the same native mouse/wheel path used
                # by that humanized runtime; direct JavaScript scrolling
                # would bypass the closed interaction seam and create a
                # detectable second control path.
                mouse = getattr(self.raw, "mouse", None)
                if mouse is None:
                    raise _runtime_error()
                _required_callable(mouse, "wheel")(0, delta_y)
                # Native wheel delivery may return just before the page's
                # scroll listener and layout pass run.  Give the browser a
                # small bounded settle window so the next neutral observation
                # cannot race a pending visibility/reorder mutation.  This is
                # still an adapter-owned native wait; no JavaScript or page
                # selector crosses the Browser Agent seam.
                settle = min(timeout, 100)
                wait_for_timeout = getattr(self.raw, "wait_for_timeout", None)
                if settle > 0 and callable(wait_for_timeout):
                    wait_for_timeout(settle)
            except BaseException:
                raise _runtime_error() from None

        self.engine.call(scroll)

    def agent_wait(self, seconds: float, *, timeout: int) -> None:
        if seconds < 0.05 or seconds > 10.0 or type(timeout) is not int or timeout <= 0:
            raise _runtime_error()
        wait_for_timeout = getattr(self.raw, "wait_for_timeout", None)
        if not callable(wait_for_timeout):
            raise _runtime_error()
        try:
            self.engine.call(lambda: wait_for_timeout(int(seconds * 1000)))
        except BaseException:
            raise _runtime_error() from None

    def fill(self, selector: str, value: str, *, timeout: int) -> None:
        self.engine.call(lambda: cast(Any, self.raw).fill(selector, value, timeout=timeout))

    def abort(self) -> None:
        self.article.interrupt_transport()

    cancel = abort
    stop = abort

    def close(self) -> None:
        if self._closed:
            return
        try:
            self.engine.call(self._close_from_engine)
        finally:
            self._closed = True
            self.context.forget_page(self)

    def _close_from_engine(self) -> None:
        remove_listener = getattr(self.raw, "remove_listener", None)
        if callable(remove_listener):
            for event, listener in tuple(self._native_listeners.items()):
                remove_listener(event, listener)
        self._native_listeners.clear()
        self._agent_locators.clear()
        cast(Any, self.raw).close()
        self._closed = True


class _ArticleContext:
    """One Publisher article capability view over the shared native context."""

    __slots__ = ("_context", "_state", "_closed")

    def __init__(self, context: _Context, state: _ArticleState) -> None:
        self._context = context
        self._state = state
        self._closed = False

    @property
    def engine(self) -> _EnginePort:
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
        "_response_body_sources",
        "_article_lock",
        "_event_lock",
        "_external_pdf_downloads",
        "_closed",
        "_cleanup_failed",
    )

    def __init__(
        self,
        engine: _EnginePort,
        raw: object,
        proxy: BrowserConnectProxy,
        downloads_root: Path,
        *,
        external_pdf_downloads: bool = True,
    ) -> None:
        if type(external_pdf_downloads) is not bool:
            raise TypeError("external_pdf_downloads must be a bool")
        self.engine = engine
        self.raw = raw
        self.proxy = proxy
        self.downloads_root = downloads_root
        self._dispatcher = _EventDispatcher()
        self._articles: dict[object, _ArticleState] = {}
        self._lane_tokens: dict[str, object] = {}
        self._pages: dict[object, _Page] = {}
        self._requests: dict[object, _Request] = {}
        self._request_states: dict[object, _NativeRequestState] = {}
        self._response_body_sources: dict[object, object] = {}
        self._article_lock = threading.Lock()
        self._event_lock = threading.Lock()
        self._external_pdf_downloads = external_pdf_downloads
        self._closed = False
        self._cleanup_failed = False
        try:
            cast(Any, raw).route("**/*", lambda value: self._on_route(value))
        except BaseException:
            self._dispatcher.close()
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
        # Keep both the reviewed route handler and its already-authorized
        # CONNECT lane alive until Chromium acknowledges every page close.
        # Tearing either down first can strand a renderer request inside the
        # patched Chromium and make Playwright's otherwise local
        # ``page.close()`` wait forever.  The same article guard still checks
        # every request during this short handshake; only after all pages are
        # closed do we make the article inactive and release its transport.
        if not self._close_remaining_article_pages(state):
            state.cleanup_failed = True
        state.active = False
        if not self._dispatcher.drain():
            drained = False
        if state.transport_drained:
            transport_drained = True
        else:
            try:
                transport_drained = self.proxy.end_lane(state.token)
            except BaseException:
                transport_drained = False
            state.transport_drained = transport_drained
        for key in tuple(state.request_keys):
            self._requests.pop(key, None)
            self._request_states.pop(key, None)
            self._response_body_sources.pop(key, None)
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
            raw_page = cast(Any, self.raw).new_page()
            return self._page(raw_page, state)

        return self.engine.call(create)

    def pump_events_from_engine(self) -> None:
        """Give Chromium a bounded sync-API turn while lanes are active."""

        if self._closed or not any(state.active for state in self._articles.values()):
            return
        try:
            self._pump_once(max(1, int(_EVENT_PUMP_INTERVAL_SECONDS * 1000)), None)
        except BaseException as error:
            _LOGGER.debug(
                "event=browser-native-event-pump-failed exception_type=%s "
                "failure_category=%s code=runtime",
                type(error).__name__,
                _playwright_error_category(error),
            )
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

    def save_response_body_source(self, request: _Request, raw_response: object) -> None:
        """Retain a fetched APIResponse until its corresponding event is handled."""

        key = _vendor_identity(request.raw)
        state = self._articles.get(request.article_token)
        if state is None or not state.active or key not in state.request_keys:
            raise _runtime_error()
        existing = self._response_body_sources.get(key)
        if existing is not None and existing is not raw_response:
            raise _runtime_error()
        self._response_body_sources[key] = raw_response

    def clear_response_body_source(self, request: _Request | object) -> None:
        raw_request = request.raw if isinstance(request, _Request) else request
        self._response_body_sources.pop(_vendor_identity(raw_request), None)

    def response_body_source(self, raw_response: object, request: _Request) -> object:
        source = self._response_body_sources.get(_vendor_identity(request.raw))
        return raw_response if source is None else source

    def forget_page(self, page: _Page) -> None:
        """Release one article page wrapper after deterministic cleanup."""

        key = _vendor_identity(page.raw)
        self._pages.pop(key, None)
        state = self._articles.get(page.article_token)
        if state is not None:
            state.page_keys.discard(key)
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
        finally:
            self._response_body_sources.clear()

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
        key = _vendor_identity(raw_page)
        page = self._pages.get(key)
        if page is not None:
            if page.article_token is not state.token:
                raise _runtime_error()
            return page
        article = _ArticleContext(self, state)
        page = _Page(self, article, raw_page)
        self._pages[key] = page
        state.page_keys.add(key)
        listeners: dict[str, Callable[[object], object]] = {
            "download": lambda value, page=page: self._on_download(page, value),
            "popup": lambda value, page=page: self._on_popup(page, value),
            "response": lambda value: self._on_response(value),
            "requestfinished": lambda value: self._on_request_complete("requestfinished", value),
            "requestfailed": lambda value: self._on_request_complete("requestfailed", value),
        }
        registering_event = "unknown"
        try:
            for event, listener in listeners.items():
                registering_event = event
                cast(Any, raw_page).on(event, listener)
                page._native_listeners[event] = listener
        except BaseException as error:
            _LOGGER.debug(
                "event=browser-native-page-listener-failed browser_event=%s "
                "exception_type=%s failure_category=%s code=runtime",
                registering_event,
                type(error).__name__,
                _playwright_error_category(error),
            )
            remove_listener = getattr(raw_page, "remove_listener", None)
            if callable(remove_listener):
                for event, listener in page._native_listeners.items():
                    remove_listener(event, listener)
            page._native_listeners.clear()
            self._pages.pop(key, None)
            state.page_keys.discard(key)
            raise _runtime_error() from None
        return page

    def _on_popup(self, opener_page: _Page, raw_page: object) -> None:
        try:
            state = self._articles.get(opener_page.article_token)
            if state is None or not state.active:
                cast(Any, raw_page).close()
                return
            page = self._page(raw_page, state)
            self._emit(state, "page", page)
        except BaseException:
            try:
                cast(Any, raw_page).close()
            except BaseException:
                pass
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
        return self._pages.get(_vendor_identity(raw_page))

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
            self.clear_response_body_source(native_state.request)
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
                self.engine.call(page._close_from_engine)
                self.forget_page(page)
            except BaseException:
                cleaned = False
        return cleaned


def _abort_raw_route(raw_route: object) -> None:
    try:
        cast(Any, raw_route).abort()
    except BaseException:
        return


__all__ = ("PlaywrightRuntimeError",)
