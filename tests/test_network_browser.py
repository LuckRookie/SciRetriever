from __future__ import annotations

import tempfile
import threading
import time
import unittest
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable, cast
from unittest import mock
from urllib.parse import urlsplit

from sciretriever.model.access import (
    AccessFailure,
    BoundedByteStream,
    BrowserCapture,
    BrowserCaptureBatch,
    BrowserCaptureKind,
)
from sciretriever.network.admission import (
    AccessCoordinator,
    AccessPermit,
    AccessPolicy,
    AccessScope,
    HostPermit,
)
from sciretriever.network.browser import (
    BrowserCaptureGuard,
    BrowserClient,
    BrowserDestinationKind,
    BrowserOperationLimits,
    BrowserPageObservation,
    _Abort,
    _DownloadCapturePlan,
    _FlowState,
    _PendingResponseDownload,
    _RequestLease,
)
from sciretriever.network.browser_control import (
    BrowserAction,
    BrowserActionOutcome,
    BrowserCaptureState,
    BrowserControlSession,
    BrowserObservation,
    BrowserPageState,
    BrowserSurfaceKind,
    ClickElement,
    ClickPoint,
    GoBack,
    ScrollSurface,
    Stop,
    WaitForChange,
)
from sciretriever.network.browser_sessions import BrowserSessionBroker
from sciretriever.network.policy import (
    AddressClass,
    DestinationPolicy,
    ResolvedDestination,
    normalize_url,
)

_PUBLIC_POLICY = DestinationPolicy(allowed_classes=frozenset({AddressClass.PUBLIC}))


class _FlowController:
    """Typed Browser controller fixture for one capability-only flow."""

    def __init__(self, flow: Callable[..., object]) -> None:
        if not callable(flow):
            raise TypeError("flow must be callable")
        self._flow = flow

    def run(self, session: object) -> None:
        result = self._flow(session)
        del result


class _FakeClock:
    def __init__(self) -> None:
        self.value = 0.0
        self._condition = threading.Condition()

    def __call__(self) -> float:
        with self._condition:
            return self.value

    def advance(self, seconds: float) -> None:
        with self._condition:
            self.value += seconds
        self.coordinator.wake()

    coordinator: AccessCoordinator


class _Resolver:
    def __init__(self, answers: dict[str, tuple[str, ...]]) -> None:
        self.answers = answers
        self.calls: list[str] = []

    def resolve(self, hostname: str) -> Iterable[str]:
        self.calls.append(hostname)
        return self.answers[hostname]


class _OriginGuard:
    def __init__(self, *origins: str) -> None:
        self.origins = frozenset(origins)
        self.calls: list[tuple[str, BrowserDestinationKind]] = []

    def check(self, url: str, kind: BrowserDestinationKind) -> None:
        self.calls.append((url, kind))
        parsed = urlsplit(url)
        origin = f"{parsed.scheme}://{parsed.netloc}"
        if origin not in self.origins:
            raise ValueError("fixture origin rejected")

    def connection_origins(self) -> tuple[str, ...]:
        return tuple(sorted(self.origins))


class _SubresourceRejectingGuard(_OriginGuard):
    """Reject one admitted same-origin subresource at the request boundary."""

    def check_request(self, observation: object) -> None:
        if getattr(observation, "resource_type", None) != "document":
            raise ValueError("fixture subresource rejected")


class _CaptureGuard:
    def __init__(
        self,
        allowed: set[tuple[str, BrowserCaptureKind, str]],
        *,
        error: BaseException | None = None,
    ) -> None:
        self.allowed = allowed
        self.error = error
        self.calls: list[tuple[str, BrowserCaptureKind, str]] = []

    def allows(
        self,
        url: str,
        kind: BrowserCaptureKind,
        media_type: str,
    ) -> bool:
        self.calls.append((url, kind, media_type))
        if self.error is not None:
            raise self.error
        return (url, kind, media_type) in self.allowed


class _DownloadProbe:
    def __init__(self, url: str, request: object | None = None) -> None:
        self.url = url
        self.request = request
        self.body_reads = 0

    def content(self, maximum_bytes: int) -> bytes:
        del maximum_bytes
        self.body_reads += 1
        raise AssertionError("late duplicate download body must not be read")


class _RecordingCoordinator(AccessCoordinator):
    def __init__(self, *args: object, **kwargs: object) -> None:
        super().__init__(*args, **kwargs)  # type: ignore[arg-type]
        self.hosts: list[str] = []
        self.released_hosts: list[str] = []

    def _acquire_host(
        self,
        owner: AccessPermit,
        host: str,
        *,
        host_policy: AccessPolicy | None = None,
        cancel_event: threading.Event | None,
        timeout: float | None,
    ) -> HostPermit:
        self.hosts.append(host)
        return super()._acquire_host(
            owner,
            host,
            host_policy=host_policy,
            cancel_event=cancel_event,
            timeout=timeout,
        )

    def _release_host(self, permit: HostPermit) -> None:
        self.released_hosts.append(permit.host)
        super()._release_host(permit)


class _ReleaseFailingCoordinator(AccessCoordinator):
    def __init__(self) -> None:
        super().__init__()
        self.release_failures = 0

    def _release_scope(self, permit: AccessPermit) -> None:
        super()._release_scope(permit)
        if self.release_failures == 0:
            self.release_failures += 1
            raise RuntimeError("scope release sentinel")


class _FakeRequest:
    def __init__(
        self,
        url: str,
        page: _FakePage,
        *,
        navigation: bool,
        top_frame: bool | None = None,
        redirected_from: _FakeRequest | None = None,
    ) -> None:
        self.url = url
        self.page = page
        self._navigation = navigation
        self.resource_type = "document" if navigation else "image"
        self.is_top_frame = top_frame
        self.redirected_from = redirected_from

    def is_navigation_request(self) -> bool:
        return self._navigation


class _FakeRoute:
    def __init__(self, request: _FakeRequest) -> None:
        self.request = request
        self.continued = False
        self.aborted = False
        self.binding: object | None = None

    def bind_connection(self, binding: object) -> object:
        self.binding = binding
        return binding

    def continue_(self) -> None:
        self.continued = True

    def abort(self) -> None:
        self.aborted = True


@dataclass(frozen=True, slots=True)
class _ResponseFixture:
    body: object
    media_type: str = "application/pdf"
    status: int = 200
    final_url: str | None = None


class _FakeResponse:
    def __init__(
        self,
        request: _FakeRequest,
        status: int = 200,
        *,
        body: object | None = None,
        media_type: str = "text/html",
        download_expected: bool = False,
        attachment_download: bool = False,
        final_url: str | None = None,
    ) -> None:
        self.request = request
        self.url = request.url if final_url is None else final_url
        self.status = status
        self.media_type = media_type
        self._body = body
        self.download_expected = download_expected
        self.attachment_download = attachment_download
        self.size = len(body) if isinstance(body, bytes) else None
        self.body_reads = 0

    def body(self) -> object:
        self.body_reads += 1
        if self._body is None:
            raise RuntimeError("fixture response has no body")
        return self._body


class _BodyStream:
    def __init__(self, body: bytes, *, close_error: bool = False) -> None:
        self.body = body
        self.close_error = close_error
        self.read_calls = 0
        self.close_calls = 0

    def read(self, size: int) -> bytes:
        self.read_calls += 1
        return self.body[:size]

    def close(self) -> None:
        self.close_calls += 1
        if self.close_error:
            raise RuntimeError("response stream close sentinel")


class _FakeDownload:
    def __init__(self, url: str, body: bytes, media_type: str = "application/pdf") -> None:
        self.url = url
        self.body = body
        self.media_type = media_type
        self.deleted = False
        self.delete_calls = 0
        self.request: _FakeRequest | None = None
        self.emitted_after_page_closed: bool | None = None

    def content(self) -> bytes:
        return self.body

    def delete(self) -> None:
        self.delete_calls += 1
        self.deleted = True


class _FakePage:
    def __init__(self, context: _FakeContext, *, url: str = "") -> None:
        self.context = context
        self.url = url
        self.challenge = False
        self.closed = False
        self.close_calls = 0
        self.goto_error: BaseException | None = None
        self.abort_event = threading.Event()
        self.control_generation = 0
        self.control_snapshot_calls = 0
        self.control_calls: list[tuple[object, ...]] = []
        self.control_click_result = True
        self.control_go_back_result = True
        self.control_wait_result = False
        self.control_capture_url: str | None = None

    def goto(self, url: str, *, timeout: int) -> _FakeResponse:
        del timeout
        if self.goto_error is not None:
            raise self.goto_error
        current = url
        visited: set[str] = set()
        while True:
            if current in visited:
                raise RuntimeError("redirect loop sentinel")
            visited.add(current)
            route = self.context.request(current, self, navigation=True)
            if route.aborted:
                raise RuntimeError("route rejected sentinel")
            self.url = current
            redirect = self.context.redirects.get(current)
            if redirect is None:
                self.context.emit_subresources(self)
                if self.context.blocking_goto:
                    self.context.goto_started.set()
                    self.abort_event.wait()
                if (
                    self.context.delayed_native_download
                    and self.context.configured_download is not None
                    and current == self.context.configured_download.url
                ):
                    response = next(
                        (
                            candidate
                            for candidate in reversed(self.context.responses)
                            if candidate.request is route.request
                        ),
                        None,
                    )
                    if response is None:
                        raise RuntimeError("navigation response fixture was not recorded")
                    self.context.schedule_configured_download(self, route.request)
                    return response
                self.context.emit_configured_download(self)
                return _FakeResponse(route.request, self.context.navigation_status)
            current = redirect

    def open_popup(self, url: str) -> _FakePage:
        return self.context.popup(url)

    def discover_pdf_locators(self) -> tuple[str, ...]:
        return self.context.discovered_pdf_locators

    def emit_download(self, download: _FakeDownload) -> None:
        self.context.download(download)

    def title(self) -> str:
        return "verify you are human" if self.challenge else "fixture"

    def content(self) -> str:
        return ""

    def close(self) -> None:
        self.close_calls += 1
        self.closed = True
        self.context.events.append("page-close")

    def abort(self) -> None:
        if not self.context.ignore_page_abort:
            self.abort_event.set()

    def click(self, selector: str, *, timeout: int) -> None:
        del selector, timeout

    def fill(self, selector: str, value: str, *, timeout: int) -> None:
        del selector, value, timeout

    def text_content(self, selector: str, *, timeout: int) -> str:
        del timeout
        return selector

    def control_snapshot(
        self,
        *,
        timeout: int,
        include_screenshot: bool,
        static_selector: str | None = None,
    ) -> dict[str, object]:
        if timeout <= 0:
            raise AssertionError("control snapshot timeout must be positive")
        self.control_snapshot_calls += 1
        locator = self.url or "https://landing.test/start"
        title = f"fixture-{self.control_generation}"
        screenshot = (
            f"screenshot-{self.control_generation}".encode() if include_screenshot else None
        )
        return {
            "width": 1280,
            "height": 720,
            "title": title,
            "surfaces": (
                (0, None, "page", locator, title, 0, 0, 1280, 720, 0, 0, 0, 1440, None),
                (
                    1,
                    0,
                    "frame",
                    f"{locator.rstrip('/')}/frame",
                    "frame",
                    20,
                    20,
                    800,
                    600,
                    0,
                    0,
                    0,
                    600,
                    None,
                ),
                (
                    2,
                    1,
                    "shadow",
                    f"{locator.rstrip('/')}/frame",
                    "shadow",
                    40,
                    40,
                    600,
                    400,
                    0,
                    0,
                    0,
                    400,
                    None,
                ),
                (
                    3,
                    0,
                    "viewer",
                    f"{locator.rstrip('/')}/viewer",
                    "viewer",
                    100,
                    100,
                    700,
                    500,
                    0,
                    0,
                    0,
                    500,
                    None,
                ),
            ),
            "elements": (
                (1, 0, "button", "Download PDF", True, True, 20, 20, 180, 40),
                (2, 0, "button", "Disabled", True, False, 20, 80, 180, 40),
                (3, 1, "button", "Frame action", True, True, 80, 80, 160, 40),
                (4, 2, "button", "Hidden", False, True, 100, 100, 160, 40),
            ),
            "static_element_key": (
                None if static_selector is None or "missing" in static_selector else 1
            ),
            "screenshot": screenshot,
            "screenshot_media_type": "image/png" if include_screenshot else None,
        }

    def control_click_element(
        self,
        element_key: int,
        *,
        expected_role: str,
        expected_name: str,
        expected_enabled: bool,
        expected_surface_key: int,
        timeout: int,
    ) -> bool:
        self.control_calls.append(
            (
                "click-element",
                element_key,
                expected_role,
                expected_name,
                expected_enabled,
                expected_surface_key,
                timeout,
            )
        )
        if self.control_capture_url is not None:
            route = self.context.begin_request(self.control_capture_url, self, navigation=False)
            if not route.aborted:
                download = _FakeDownload(self.control_capture_url, b"%PDF-control-capture")
                download.request = route.request
                self.context.download(download)
                if route.continued:
                    self.context.finish_request(route)
        return self.control_click_result

    def control_click_point(self, x: float, y: float, *, timeout: int) -> bool:
        self.control_calls.append(("click-point", x, y, timeout))
        return self.control_click_result

    def control_scroll_surface(self, surface_key: int, delta_y: int, *, timeout: int) -> None:
        self.control_calls.append(("scroll-surface", surface_key, delta_y, timeout))

    def control_go_back(self, *, timeout: int) -> bool:
        self.control_calls.append(("go-back", timeout))
        return self.control_go_back_result

    def control_wait_for_change(self, *, timeout: int) -> bool:
        self.control_calls.append(("wait-for-change", timeout))
        return self.control_wait_result


class _FakeContext:
    def __init__(
        self,
        *,
        events: list[str],
        redirects: dict[str, str] | None = None,
        close_error: BaseException | None = None,
        goto_error: BaseException | None = None,
        configured_download: _FakeDownload | None = None,
        delayed_native_download: bool = False,
        challenge: bool = False,
        subresources: tuple[str, ...] = (),
        defer_subresource_responses: bool = False,
        blocking_goto: bool = False,
        navigation_status: int = 200,
        response_fixtures: dict[str, _ResponseFixture] | None = None,
        ignore_page_abort: bool = False,
        new_page_error: BaseException | None = None,
    ) -> None:
        self.events = events
        self.redirects = {} if redirects is None else redirects
        self.close_error = close_error
        self.goto_error = goto_error
        self.configured_download = configured_download
        self.delayed_native_download = delayed_native_download
        self.challenge = challenge
        self.subresources = subresources
        self.defer_subresource_responses = defer_subresource_responses
        self.blocking_goto = blocking_goto
        self.navigation_status = navigation_status
        self.response_fixtures = {} if response_fixtures is None else response_fixtures
        self.ignore_page_abort = ignore_page_abort
        self.new_page_error = new_page_error
        self.goto_started = threading.Event()
        self.first_subresource_continued = threading.Event()
        self.second_subresource_continued = threading.Event()
        self.release_first_subresource = threading.Event()
        self.configured_download_emitted = False
        self.delayed_download_scheduled = threading.Event()
        self.release_delayed_download = threading.Event()
        self.delayed_download_finished = threading.Event()
        self.delayed_download_threads: list[threading.Thread] = []
        self.pages: list[_FakePage] = []
        self.route_handler: Callable[[_FakeRoute], object] | None = None
        self.handlers: dict[str, list[Callable[[object], object]]] = {}
        self.responses: list[_FakeResponse] = []
        self.closed = False
        self.close_calls = 0
        self.binding: object | None = None
        self.bindings: list[object] = []
        self.article_paths: list[str] = []
        self.article_bindings: list[object] = []
        self.article_lanes: list[str] = []
        self.article_active = False
        self.discovered_pdf_locators: tuple[str, ...] = ()

    def bind_connection(self, binding: object) -> object:
        self.binding = binding
        self.bindings.append(binding)
        return binding

    def begin_article(
        self,
        *,
        lane_key: str,
        downloads_path: str,
        connection_binding: object,
    ) -> object:
        if self.article_active:
            raise RuntimeError("overlapping article sentinel")
        self.article_active = True
        self.route_handler = None
        self.handlers.clear()
        self.article_lanes.append(lane_key)
        self.article_paths.append(downloads_path)
        self.article_bindings.append(connection_binding)
        self.configured_download_emitted = False
        return self

    def end_article(self) -> bool:
        if not self.article_active:
            raise RuntimeError("article was not active")
        self.article_active = False
        self.route_handler = None
        self.handlers.clear()
        return True

    def route(self, pattern: str, handler: Callable[[_FakeRoute], object]) -> None:
        self.events.append(f"route:{pattern}")
        self.route_handler = handler

    def on(self, event: str, handler: Callable[[object], object]) -> None:
        self.handlers.setdefault(event, []).append(handler)

    def new_page(self) -> _FakePage:
        if self.new_page_error is not None:
            raise self.new_page_error
        page = _FakePage(self)
        page.goto_error = self.goto_error
        page.challenge = self.challenge
        self.pages.append(page)
        return page

    def request(self, url: str, page: _FakePage, *, navigation: bool) -> _FakeRoute:
        route = self.begin_request(url, page, navigation=navigation)
        if route.continued:
            self.emit_response(route)
        if route.continued and navigation:
            self.finish_request(route)
        return route

    def begin_request(self, url: str, page: _FakePage, *, navigation: bool) -> _FakeRoute:
        route = _FakeRoute(_FakeRequest(url, page, navigation=navigation))
        if self.route_handler is None:
            raise AssertionError("route handler was not installed")
        self.route_handler(route)
        return route

    def emit_response(self, route: _FakeRoute) -> None:
        url = route.request.url
        fixture = self.response_fixtures.get(url)
        configured_download = (
            self.configured_download is not None and url == self.configured_download.url
        )
        response = _FakeResponse(
            route.request,
            status=200 if fixture is None else fixture.status,
            body=None if fixture is None else fixture.body,
            media_type=(
                self.configured_download.media_type
                if configured_download and self.configured_download is not None
                else ("text/html" if fixture is None else fixture.media_type)
            ),
            download_expected=configured_download,
            attachment_download=configured_download,
            final_url=None if fixture is None else fixture.final_url,
        )
        self.responses.append(response)
        for handler in self.handlers.get("response", ()):
            handler(response)

    def finish_request(self, route: _FakeRoute) -> None:
        for handler in self.handlers.get("requestfinished", ()):
            handler(route.request)

    def emit_configured_download(self, page: _FakePage) -> None:
        if self.configured_download is None or self.configured_download_emitted:
            return
        self.configured_download_emitted = True
        route = self.request(self.configured_download.url, page, navigation=False)
        if route.aborted:
            return
        self.configured_download.request = route.request
        self.download(self.configured_download)
        if route.continued:
            for handler in self.handlers.get("requestfinished", ()):
                handler(route.request)

    def schedule_configured_download(
        self,
        page: _FakePage,
        request: _FakeRequest,
    ) -> None:
        download = self.configured_download
        if download is None or self.configured_download_emitted:
            raise RuntimeError("delayed download fixture was not available")
        self.configured_download_emitted = True
        download.request = request

        def emit() -> None:
            self.delayed_download_scheduled.set()
            self.release_delayed_download.wait(2.0)
            download.emitted_after_page_closed = page.closed
            try:
                self.download(download)
            finally:
                self.delayed_download_finished.set()

        worker = threading.Thread(target=emit, daemon=True)
        self.delayed_download_threads.append(worker)
        worker.start()

    def emit_subresources(self, page: _FakePage) -> None:
        if not self.subresources:
            return
        if self.defer_subresource_responses:
            self.emit_deferred_subresources(page)
            return

        def fetch(index: int, url: str) -> None:
            route = self.request(url, page, navigation=False)
            if index == 0:
                self.first_subresource_continued.set()
                self.release_first_subresource.wait(1.0)
            else:
                self.second_subresource_continued.set()
            if route.continued:
                for handler in self.handlers.get("requestfinished", ()):
                    handler(route.request)

        workers = [
            threading.Thread(target=fetch, args=(index, url), daemon=True)
            for index, url in enumerate(self.subresources)
        ]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join(2.0)

    def emit_deferred_subresources(self, page: _FakePage) -> None:
        routes = [self.begin_request(url, page, navigation=False) for url in self.subresources]
        if routes[0].continued:
            self.first_subresource_continued.set()
        if len(routes) > 1 and routes[1].continued:
            self.second_subresource_continued.set()
        self.release_first_subresource.wait(1.0)
        for route in routes:
            if route.continued:
                self.emit_response(route)
                self.finish_request(route)

    def popup(self, url: str) -> _FakePage:
        page = _FakePage(self)
        self.pages.append(page)
        for handler in self.handlers.get("page", ()):
            handler(page)
        route = self.request(url, page, navigation=True)
        if route.aborted:
            raise RuntimeError("popup route rejected sentinel")
        page.url = url
        return page

    def download(self, download: _FakeDownload) -> None:
        for handler in self.handlers.get("download", ()):
            handler(download)

    def close(self) -> None:
        self.close_calls += 1
        self.events.append("context-close")
        self.closed = True
        self.release_delayed_download.set()
        for page in self.pages:
            page.abort_event.set()
        for worker in self.delayed_download_threads:
            if worker is not threading.current_thread():
                worker.join(1.0)
        if self.close_error is not None:
            raise self.close_error


class _FakeProcess:
    def __init__(
        self,
        *,
        events: list[str],
        redirects: dict[str, str] | None = None,
        close_error: BaseException | None = None,
        context_close_error: BaseException | None = None,
        goto_error: BaseException | None = None,
        configured_download: _FakeDownload | None = None,
        delayed_native_download: bool = False,
        subresources: tuple[str, ...] = (),
        defer_subresource_responses: bool = False,
        blocking_goto: bool = False,
        navigation_status: int = 200,
        response_fixtures: dict[str, _ResponseFixture] | None = None,
        ignore_page_abort: bool = False,
        enter_error: BaseException | None = None,
        new_context_error: BaseException | None = None,
        new_page_error: BaseException | None = None,
    ) -> None:
        self.events = events
        self.redirects = redirects
        self.close_error = close_error
        self.context_close_error = context_close_error
        self.goto_error = goto_error
        self.configured_download = configured_download
        self.delayed_native_download = delayed_native_download
        self.challenge = False
        self.subresources = subresources
        self.defer_subresource_responses = defer_subresource_responses
        self.blocking_goto = blocking_goto
        self.navigation_status = navigation_status
        self.response_fixtures = response_fixtures
        self.ignore_page_abort = ignore_page_abort
        self.enter_error = enter_error
        self.new_context_error = new_context_error
        self.new_page_error = new_page_error
        self.context: _FakeContext | None = None
        self.downloads_path: str | None = None
        self.closed = False
        self.close_calls = 0
        self.binding: object | None = None
        self.bindings: list[object] = []

    def bind_connection(self, binding: object) -> object:
        self.binding = binding
        self.bindings.append(binding)
        return binding

    def __enter__(self) -> _FakeProcess:
        self.events.append("process-enter")
        if self.enter_error is not None:
            raise self.enter_error
        return self

    def __exit__(self, exc_type: object, exc_value: object, traceback: object) -> bool:
        del exc_type, exc_value, traceback
        self.close()
        self.events.append("process-exit")
        return False

    def new_context(
        self,
        *,
        downloads_path: str,
        accept_downloads: bool,
        connection_binding: object,
    ) -> _FakeContext:
        if self.new_context_error is not None:
            raise self.new_context_error
        if not accept_downloads:
            raise AssertionError("downloads must be explicitly enabled")
        self.downloads_path = downloads_path
        self.events.append("context-create")
        self.context = _FakeContext(
            events=self.events,
            redirects=self.redirects,
            close_error=self.context_close_error,
            goto_error=self.goto_error,
            configured_download=self.configured_download,
            delayed_native_download=self.delayed_native_download,
            challenge=self.challenge,
            subresources=self.subresources,
            defer_subresource_responses=self.defer_subresource_responses,
            blocking_goto=self.blocking_goto,
            navigation_status=self.navigation_status,
            response_fixtures=self.response_fixtures,
            ignore_page_abort=self.ignore_page_abort,
            new_page_error=self.new_page_error,
        )
        self.context.bind_connection(connection_binding)
        return self.context

    def close(self) -> None:
        if self.closed:
            return
        self.close_calls += 1
        self.closed = True
        self.events.append("process-close")
        if self.close_error is not None:
            raise self.close_error


class _FakeFactory:
    def __init__(
        self,
        *,
        redirects: dict[str, str] | None = None,
        process_close_error: BaseException | None = None,
        context_close_error: BaseException | None = None,
        goto_error: BaseException | None = None,
        configured_download: _FakeDownload | None = None,
        delayed_native_download: bool = False,
        subresources: tuple[str, ...] = (),
        defer_subresource_responses: bool = False,
        blocking_goto: bool = False,
        navigation_status: int = 200,
        response_fixtures: dict[str, _ResponseFixture] | None = None,
        ignore_page_abort: bool = False,
        enter_error: BaseException | None = None,
        new_context_error: BaseException | None = None,
        new_page_error: BaseException | None = None,
    ) -> None:
        self.events: list[str] = []
        self.downloads_path: str | None = None
        self.process = _FakeProcess(
            events=self.events,
            redirects=redirects,
            close_error=process_close_error,
            context_close_error=context_close_error,
            goto_error=goto_error,
            configured_download=configured_download,
            delayed_native_download=delayed_native_download,
            subresources=subresources,
            defer_subresource_responses=defer_subresource_responses,
            blocking_goto=blocking_goto,
            navigation_status=navigation_status,
            response_fixtures=response_fixtures,
            ignore_page_abort=ignore_page_abort,
            enter_error=enter_error,
            new_context_error=new_context_error,
            new_page_error=new_page_error,
        )
        self.context_close_error = context_close_error
        self.binding: object | None = None

    def __call__(
        self,
        *,
        downloads_path: str,
        connection_binding: object,
    ) -> _FakeProcess:
        self.downloads_path = downloads_path
        self.binding = connection_binding
        return self.process


class _RotatingFakeFactory:
    def __init__(self, *, fail_first_navigation: bool = False) -> None:
        self.fail_first_navigation = fail_first_navigation
        self.processes: list[_FakeProcess] = []
        self.session_paths: list[str] = []

    def __call__(
        self,
        *,
        downloads_path: str,
        connection_binding: object,
    ) -> _FakeProcess:
        del connection_binding
        process = _FakeProcess(
            events=[],
            goto_error=(
                RuntimeError("first navigation sentinel")
                if self.fail_first_navigation and not self.processes
                else None
            ),
            configured_download=_FakeDownload(
                "https://download.test/article.pdf",
                b"%PDF-persistent-fixture",
            ),
        )
        self.processes.append(process)
        self.session_paths.append(downloads_path)
        return process


def _failure(value: object) -> AccessFailure:
    if not isinstance(value, AccessFailure):
        raise AssertionError(f"expected failure, got {type(value).__name__}")
    return value


def _download(value: object) -> BoundedByteStream:
    if not isinstance(value, BrowserCaptureBatch) or len(value.captures) != 1:
        raise AssertionError(f"expected download, got {type(value).__name__}")
    capture = value.captures[0]
    if capture.kind is not BrowserCaptureKind.DOWNLOAD:
        raise AssertionError(f"expected download, got {capture.kind.value}")
    return capture.stream


def _captures(value: object) -> BrowserCaptureBatch:
    if not isinstance(value, BrowserCaptureBatch):
        raise AssertionError(f"expected captures, got {type(value).__name__}")
    return value


class NetworkBrowserTests(unittest.TestCase):
    def setUp(self) -> None:
        self.resolver = _Resolver(
            {
                "landing.test": ("93.184.216.34",),
                "popup.test": ("93.184.216.35",),
                "download.test": ("93.184.216.36",),
                "other.test": ("93.184.216.37",),
                "private.test": ("127.0.0.1",),
            }
        )
        self.coordinator = _RecordingCoordinator()
        self.factory = _FakeFactory()
        self.client = BrowserClient(
            factory=self.factory,
            resolver=self.resolver,
            coordinator=self.coordinator,
            destination_policy=_PUBLIC_POLICY,
        )
        self.scope = AccessScope("fixture-provider", "web")
        self.policy = AccessPolicy(
            max_concurrency=1,
            cooldown_after_completion=30.0,
        )

    def test_custom_port_requires_an_explicit_exact_browser_policy(self) -> None:
        rejected = _failure(
            self.client.run(
                self.scope,
                "https://landing.test:8443/start",
                self.policy,
            )
        )

        self.assertEqual(rejected.code, "policy")
        self.assertEqual(self.resolver.calls, [])
        self.assertEqual(self.factory.events, [])

        exact_policy = DestinationPolicy(
            allowed_ports=frozenset({("https", 8443)}),
            allowed_classes=frozenset({AddressClass.PUBLIC}),
        )
        exact_factory = _FakeFactory(
            configured_download=_FakeDownload(
                "https://download.test:8443/file",
                b"ok",
            )
        )
        exact_client = BrowserClient(
            factory=exact_factory,
            resolver=self.resolver,
            coordinator=AccessCoordinator(),
            destination_policy=exact_policy,
        )

        result = _download(
            exact_client.run(
                self.scope,
                "https://landing.test:8443/start",
                self.policy,
            )
        )

        self.assertEqual(result.final_locator, "https://download.test:8443/file")
        binding = exact_factory.binding
        self.assertIsNotNone(binding)
        self.assertEqual(getattr(binding, "port"), 8443)

    def test_browser_rejects_an_unlisted_redirect_port(self) -> None:
        exact_policy = DestinationPolicy(
            allowed_ports=frozenset({("https", 8443)}),
            allowed_classes=frozenset({AddressClass.PUBLIC}),
        )
        factory = _FakeFactory(
            redirects={
                "https://landing.test:8443/start": "https://other.test:9443/redirect",
            }
        )
        client = BrowserClient(
            factory=factory,
            resolver=self.resolver,
            coordinator=AccessCoordinator(),
            destination_policy=exact_policy,
        )

        result = _failure(
            client.run(
                self.scope,
                "https://landing.test:8443/start",
                self.policy,
            )
        )

        self.assertEqual(result.code, "policy")
        self.assertNotIn("other.test", self.resolver.calls)

    def test_navigation_popup_download_is_bounded_and_fully_cleaned(self) -> None:
        def flow(session: object) -> None:
            cast(object, session).open_popup("https://popup.test/popup")  # type: ignore[attr-defined]

        self.factory = _FakeFactory(
            configured_download=_FakeDownload(
                "https://download.test/file?token=sentinel", b"fixture"
            )
        )
        self.client = BrowserClient(
            factory=self.factory,
            resolver=self.resolver,
            coordinator=self.coordinator,
            destination_policy=_PUBLIC_POLICY,
        )

        result = _download(
            self.client.run(
                self.scope,
                "https://landing.test/start",
                self.policy,
                controller=_FlowController(flow),
            )
        )
        self.assertEqual(result.chunks, (b"fixture",))
        self.assertEqual(result.size, 7)
        self.assertEqual(result.final_locator, "https://download.test/file")
        self.assertNotIn("sentinel", repr(result))
        self.assertTrue(self.factory.process.closed)
        self.assertTrue(self.factory.process.context is not None)
        assert self.factory.process.context is not None
        self.assertTrue(self.factory.process.context.closed)
        self.assertEqual(self.factory.process.context.pages[0].closed, True)
        self.assertEqual(
            self.coordinator.hosts,
            ["landing.test", "download.test", "popup.test"],
        )
        self.assertIsNotNone(self.factory.downloads_path)
        assert self.factory.downloads_path is not None
        self.assertFalse(Path(self.factory.downloads_path).exists())

    def test_response_popup_viewer_and_verified_locator_captures_are_distinct(self) -> None:
        response_url = "https://landing.test/start"
        popup_url = "https://popup.test/article.pdf"
        viewer_url = "https://other.test/viewer.pdf"
        verified_url = "https://download.test/official-object"
        fixtures = {
            response_url: _ResponseFixture(b"%PDF-response"),
            popup_url: _ResponseFixture(b"%PDF-popup"),
            viewer_url: _ResponseFixture(b"%PDF-viewer"),
            verified_url: _ResponseFixture(
                b"%PDF-verified",
                media_type="application/octet-stream",
            ),
        }
        guard = _CaptureGuard(
            {
                (response_url, BrowserCaptureKind.RESPONSE, "application/pdf"),
                (popup_url, BrowserCaptureKind.POPUP, "application/pdf"),
                (viewer_url, BrowserCaptureKind.VIEWER, "application/pdf"),
                (
                    verified_url,
                    BrowserCaptureKind.VERIFIED_LOCATOR,
                    "application/octet-stream",
                ),
            }
        )
        factory = _FakeFactory(response_fixtures=fixtures)
        client = BrowserClient(
            factory=factory,
            resolver=self.resolver,
            coordinator=AccessCoordinator(),
            destination_policy=_PUBLIC_POLICY,
        )

        def flow(session: object) -> None:
            session.wait_for_capture(BrowserCaptureKind.RESPONSE)  # type: ignore[attr-defined]
            session.open_popup(popup_url)  # type: ignore[attr-defined]
            session.wait_for_capture(BrowserCaptureKind.POPUP)  # type: ignore[attr-defined]
            session.open_viewer(viewer_url)  # type: ignore[attr-defined]
            session.wait_for_capture(BrowserCaptureKind.VIEWER)  # type: ignore[attr-defined]
            session.open_verified_locator(verified_url)  # type: ignore[attr-defined]
            session.wait_for_capture(  # type: ignore[attr-defined]
                BrowserCaptureKind.VERIFIED_LOCATOR
            )

        batch = _captures(
            client.run(
                self.scope,
                response_url,
                self.policy,
                controller=_FlowController(flow),
                capture_guard=guard,
            )
        )

        self.assertIsInstance(guard, BrowserCaptureGuard)
        self.assertEqual(
            tuple(capture.kind for capture in batch.captures),
            (
                BrowserCaptureKind.RESPONSE,
                BrowserCaptureKind.POPUP,
                BrowserCaptureKind.VIEWER,
                BrowserCaptureKind.VERIFIED_LOCATOR,
            ),
        )
        self.assertEqual(
            tuple(b"".join(capture.stream.chunks) for capture in batch.captures),
            tuple(fixture.body for fixture in fixtures.values()),
        )
        assert factory.process.context is not None
        self.assertEqual(
            [response.body_reads for response in factory.process.context.responses],
            [1, 1, 1, 1],
        )

    def test_navigation_route_proof_survives_multiple_responses_until_completion(self) -> None:
        factory = _FakeFactory()
        original_new_context = factory.process.new_context

        def new_context(**kwargs: object) -> _FakeContext:
            context = original_new_context(**kwargs)  # type: ignore[arg-type]

            def request(
                url: str,
                page: _FakePage,
                *,
                navigation: bool,
            ) -> _FakeRoute:
                route = context.begin_request(url, page, navigation=navigation)
                if route.continued:
                    context.emit_response(route)
                    if navigation:
                        # A native navigation can expose more than one
                        # response before requestfinished (for example an
                        # informational/authentication response followed by
                        # the terminal response). Both must reuse the one
                        # intercepted route proof.
                        context.emit_response(route)
                        context.finish_request(route)
                return route

            context.request = request  # type: ignore[method-assign]
            return context

        factory.process.new_context = new_context  # type: ignore[method-assign]
        client = BrowserClient(
            factory=factory,
            resolver=self.resolver,
            coordinator=AccessCoordinator(),
            destination_policy=_PUBLIC_POLICY,
        )

        result = _failure(
            client.run(
                self.scope,
                "https://landing.test/start",
                self.policy,
            )
        )

        self.assertEqual(result.code, "no-download")
        assert factory.process.context is not None
        self.assertEqual(len(factory.process.context.responses), 2)

    def test_subresource_redirect_reuses_same_page_prebound_route_proof(self) -> None:
        factory = _FakeFactory()
        responses: list[_FakeResponse] = []
        coordinator = _RecordingCoordinator()

        def flow(_session: object) -> None:
            context = factory.process.context
            self.assertIsNotNone(context)
            assert context is not None
            page = context.pages[0]
            route = context.begin_request(
                "https://landing.test/assets/redirect",
                page,
                navigation=False,
            )
            self.assertTrue(route.continued)
            redirect = _FakeResponse(route.request, status=302)
            child = _FakeRequest(
                "https://other.test/assets/article.js",
                page,
                navigation=False,
                redirected_from=route.request,
            )
            terminal = _FakeResponse(
                child,
                status=200,
                body=b"fixture-script",
                media_type="application/javascript",
            )
            responses.extend((redirect, terminal))
            for response in responses:
                for handler in context.handlers.get("response", ()):
                    handler(response)
            for handler in context.handlers.get("requestfinished", ()):
                handler(child)

        client = BrowserClient(
            factory=factory,
            resolver=self.resolver,
            coordinator=coordinator,
            destination_policy=_PUBLIC_POLICY,
        )

        result = _failure(
            client.run(
                self.scope,
                "https://landing.test/start",
                self.policy,
                controller=_FlowController(flow),
                destination_guard=_OriginGuard(
                    "https://landing.test",
                    "https://other.test",
                ),
            )
        )

        self.assertEqual(result.code, "no-download")
        self.assertEqual(len(responses), 2)
        self.assertEqual(responses[1].body_reads, 0)
        self.assertEqual(coordinator.hosts, ["landing.test", "other.test"])
        self.assertEqual(coordinator.released_hosts, ["landing.test", "other.test"])
        self.assertEqual(coordinator._active_host_permits, {})

    def test_subresource_redirect_does_not_reuse_route_proof_across_pages(self) -> None:
        factory = _FakeFactory()
        terminal_responses: list[_FakeResponse] = []

        def flow(_session: object) -> None:
            context = factory.process.context
            self.assertIsNotNone(context)
            assert context is not None
            page = context.pages[0]
            route = context.begin_request(
                "https://landing.test/assets/redirect",
                page,
                navigation=False,
            )
            self.assertTrue(route.continued)
            child = _FakeRequest(
                "https://other.test/assets/article.js",
                _FakePage(context),
                navigation=False,
                redirected_from=route.request,
            )
            terminal = _FakeResponse(
                child,
                status=200,
                body=b"must-not-be-read",
                media_type="application/javascript",
            )
            terminal_responses.append(terminal)
            for handler in context.handlers.get("response", ()):
                handler(terminal)

        client = BrowserClient(
            factory=factory,
            resolver=self.resolver,
            coordinator=AccessCoordinator(),
            destination_policy=_PUBLIC_POLICY,
        )

        result = _failure(
            client.run(
                self.scope,
                "https://landing.test/start",
                self.policy,
                controller=_FlowController(flow),
                destination_guard=_OriginGuard(
                    "https://landing.test",
                    "https://other.test",
                ),
            )
        )

        self.assertEqual(result.code, "runtime")
        self.assertEqual(terminal_responses[0].body_reads, 0)

    def test_subresource_redirect_requires_a_prebound_terminal_origin(self) -> None:
        class _ResponseOnlyGuard:
            def check(self, url: str, kind: BrowserDestinationKind) -> None:
                parsed = urlsplit(url)
                origin = f"{parsed.scheme}://{parsed.netloc}"
                if origin == "https://landing.test":
                    return
                if origin == "https://other.test" and kind is BrowserDestinationKind.RESPONSE:
                    return
                raise ValueError("fixture origin rejected")

            def connection_origins(self) -> tuple[str, ...]:
                return ("https://landing.test",)

        factory = _FakeFactory()
        terminal_responses: list[_FakeResponse] = []

        def flow(_session: object) -> None:
            context = factory.process.context
            self.assertIsNotNone(context)
            assert context is not None
            page = context.pages[0]
            route = context.begin_request(
                "https://landing.test/assets/redirect",
                page,
                navigation=False,
            )
            self.assertTrue(route.continued)
            child = _FakeRequest(
                "https://other.test/assets/article.js",
                page,
                navigation=False,
                redirected_from=route.request,
            )
            terminal = _FakeResponse(
                child,
                status=200,
                body=b"must-not-be-read",
                media_type="application/javascript",
            )
            terminal_responses.append(terminal)
            for handler in context.handlers.get("response", ()):
                handler(terminal)

        client = BrowserClient(
            factory=factory,
            resolver=self.resolver,
            coordinator=AccessCoordinator(),
            destination_policy=_PUBLIC_POLICY,
        )

        result = _failure(
            client.run(
                self.scope,
                "https://landing.test/start",
                self.policy,
                controller=_FlowController(flow),
                destination_guard=_ResponseOnlyGuard(),
            )
        )

        self.assertEqual(result.code, "runtime")
        self.assertEqual(terminal_responses[0].body_reads, 0)

    def test_script_navigation_updates_page_status_before_observation(self) -> None:
        factory = _FakeFactory()
        observed_statuses: list[int | None] = []

        def flow(session: object) -> None:
            context = factory.process.context
            self.assertIsNotNone(context)
            assert context is not None
            page = context.pages[0]

            def click(
                element_key: int,
                *,
                expected_role: str,
                expected_name: str,
                expected_enabled: bool,
                expected_surface_key: int,
                timeout: int,
            ) -> bool:
                del (
                    element_key,
                    expected_role,
                    expected_name,
                    expected_enabled,
                    expected_surface_key,
                    timeout,
                )
                target = "https://landing.test/after-click"
                route = context.begin_request(target, page, navigation=True)
                self.assertTrue(route.continued)
                page.url = target
                response = _FakeResponse(route.request, status=403)
                context.responses.append(response)
                for handler in context.handlers.get("response", ()):
                    handler(response)
                context.finish_request(route)
                return True

            page.control_click_element = click  # type: ignore[method-assign]
            session.click("button[data-action='continue']")  # type: ignore[attr-defined]
            observed_statuses.append(session.observe().status_code)  # type: ignore[attr-defined]

        result = _failure(
            BrowserClient(
                factory=factory,
                resolver=self.resolver,
                coordinator=AccessCoordinator(),
                destination_policy=_PUBLIC_POLICY,
            ).run(
                self.scope,
                "https://landing.test/start",
                self.policy,
                controller=_FlowController(flow),
            )
        )

        self.assertEqual(result.code, "no-download")
        self.assertEqual(observed_statuses, [403])

    def test_click_final_location_is_rechecked_even_without_a_route_callback(self) -> None:
        factory = _FakeFactory()
        guard = _OriginGuard("https://landing.test")

        def flow(session: object) -> None:
            context = factory.process.context
            self.assertIsNotNone(context)
            assert context is not None
            page = context.pages[0]

            def click(
                element_key: int,
                *,
                expected_role: str,
                expected_name: str,
                expected_enabled: bool,
                expected_surface_key: int,
                timeout: int,
            ) -> bool:
                del (
                    element_key,
                    expected_role,
                    expected_name,
                    expected_enabled,
                    expected_surface_key,
                    timeout,
                )
                # Model a faulty vendor adapter that returns a final page
                # location without exposing the hop to the route callback.
                page.url = "https://other.test/unreviewed"
                return True

            page.control_click_element = click  # type: ignore[method-assign]
            session.click("button[data-action='continue']")  # type: ignore[attr-defined]

        result = _failure(
            BrowserClient(
                factory=factory,
                resolver=self.resolver,
                coordinator=AccessCoordinator(),
                destination_policy=_PUBLIC_POLICY,
            ).run(
                self.scope,
                "https://landing.test/start",
                self.policy,
                controller=_FlowController(flow),
                destination_guard=guard,
            )
        )

        self.assertEqual(result.code, "policy")
        self.assertNotIn("other.test", self.resolver.calls)

    def test_non_actionable_click_is_a_bounded_normal_miss(self) -> None:
        factory = _FakeFactory()
        outcomes: list[bool] = []
        timeouts: list[int] = []

        def flow(session: object) -> None:
            outcomes.append(session.click("button[data-action='missing']"))  # type: ignore[attr-defined]

        result = _failure(
            BrowserClient(
                factory=factory,
                resolver=self.resolver,
                coordinator=AccessCoordinator(),
                destination_policy=_PUBLIC_POLICY,
            ).run(
                self.scope,
                "https://landing.test/start",
                self.policy,
                controller=_FlowController(flow),
                limits=BrowserOperationLimits(
                    action_timeout_seconds=0.02,
                ),
            )
        )

        self.assertEqual(result.code, "no-download")
        self.assertEqual(outcomes, [False])
        self.assertEqual(timeouts, [])
        self.assertEqual(factory.process.context.pages[0].control_calls, [])

    def test_progressing_flow_has_no_article_total_deadline(self) -> None:
        class _JumpClock:
            value = 0.0

            def __call__(self) -> float:
                return self.value

        clock = _JumpClock()
        client = BrowserClient(
            factory=_FakeFactory(),
            resolver=self.resolver,
            coordinator=AccessCoordinator(),
            destination_policy=_PUBLIC_POLICY,
            clock=clock,
        )

        def flow(session: object) -> None:
            session.text("body")  # type: ignore[attr-defined]
            clock.value = 120.0
            session.text("body")  # type: ignore[attr-defined]

        result = _failure(
            client.run(
                self.scope,
                "https://landing.test/start",
                self.policy,
                controller=_FlowController(flow),
                timeout_seconds=60.0,
            )
        )

        self.assertEqual(result.code, "no-download")

    def test_static_rule_selector_uses_snapshot_and_shared_action_executor(self) -> None:
        factory = _FakeFactory()
        outcomes: list[bool] = []

        def flow(session: object) -> None:
            context = factory.process.context
            self.assertIsNotNone(context)
            assert context is not None
            page = context.pages[0]

            def forbidden_direct_click(selector: str, *, timeout: int) -> bool:
                del selector, timeout
                raise AssertionError("static selector bypassed the control action executor")

            page.click = forbidden_direct_click  # type: ignore[method-assign]
            outcomes.append(session.click("button[data-action='continue']"))  # type: ignore[attr-defined]

        result = _failure(
            BrowserClient(
                factory=factory,
                resolver=self.resolver,
                coordinator=AccessCoordinator(),
                destination_policy=_PUBLIC_POLICY,
            ).run(
                self.scope,
                "https://landing.test/start",
                self.policy,
                controller=_FlowController(flow),
            )
        )

        self.assertEqual(result.code, "no-download")
        self.assertEqual(outcomes, [True])
        context = factory.process.context
        self.assertIsNotNone(context)
        assert context is not None
        page = context.pages[0]
        self.assertEqual(page.control_snapshot_calls, 2)
        self.assertEqual(page.control_calls[0][0], "click-element")

    def test_acknowledged_top_frame_policy_rejection_waits_for_action_and_reuses_session(
        self,
    ) -> None:
        factory = _FakeFactory()
        broker = BrowserSessionBroker()
        self.addCleanup(broker.close)
        client = BrowserClient(
            factory=factory,
            resolver=self.resolver,
            coordinator=AccessCoordinator(),
            destination_policy=_PUBLIC_POLICY,
            session_broker=broker,
            cleanup_timeout_seconds=0.01,
        )
        guard = _OriginGuard("https://landing.test")
        rejected_routes: list[_FakeRoute] = []
        action_completed = threading.Event()

        def flow(session: object) -> None:
            context = factory.process.context
            self.assertIsNotNone(context)
            assert context is not None
            page = context.pages[0]

            def click(
                element_key: int,
                *,
                expected_role: str,
                expected_name: str,
                expected_enabled: bool,
                expected_surface_key: int,
                timeout: int,
            ) -> bool:
                del (
                    element_key,
                    expected_role,
                    expected_name,
                    expected_enabled,
                    expected_surface_key,
                    timeout,
                )
                for index in range(3):
                    request = _FakeRequest(
                        f"https://other.test/unapproved-{index}",
                        page,
                        navigation=True,
                        top_frame=True,
                    )
                    route = _FakeRoute(request)
                    self.assertIsNotNone(context.route_handler)
                    assert context.route_handler is not None
                    context.route_handler(route)
                    rejected_routes.append(route)
                # Keep the vendor action alive beyond the local cleanup
                # acknowledgement budget. A policy result must not turn this
                # normal action unwind into an active transport cancellation.
                time.sleep(0.04)
                action_completed.set()
                return False

            page.control_click_element = click  # type: ignore[method-assign]
            session.click("button[data-action='continue']")  # type: ignore[attr-defined]

        first = _failure(
            client.run(
                self.scope,
                "https://landing.test/first",
                AccessPolicy(max_concurrency=1),
                controller=_FlowController(flow),
                destination_guard=guard,
                session_key="fixture-publisher",
            )
        )

        self.assertEqual(first.code, "policy")
        self.assertTrue(action_completed.is_set())
        self.assertEqual(len(rejected_routes), 3)
        self.assertTrue(all(route.aborted for route in rejected_routes))
        context = factory.process.context
        self.assertIsNotNone(context)
        assert context is not None
        self.assertFalse(context.closed)
        self.assertFalse(factory.process.closed)
        self.assertFalse(context.pages[0].abort_event.is_set())
        self.assertNotIn("other.test", self.resolver.calls)

        second = _failure(
            client.run(
                self.scope,
                "https://landing.test/second",
                AccessPolicy(max_concurrency=1),
                destination_guard=guard,
                session_key="fixture-publisher",
            )
        )

        self.assertEqual(second.code, "no-download")
        self.assertEqual(factory.events.count("process-enter"), 1)
        self.assertEqual(factory.events.count("context-create"), 1)

    def test_response_and_download_duplicate_bytes_are_delivered_once(self) -> None:
        download_url = "https://download.test/article.pdf"
        body = b"%PDF-identical-event-body"
        download = _FakeDownload(download_url, body)
        guard = _CaptureGuard(
            {
                (download_url, BrowserCaptureKind.RESPONSE, "application/pdf"),
                (download_url, BrowserCaptureKind.DOWNLOAD, "application/pdf"),
            }
        )
        factory = _FakeFactory(
            configured_download=download,
            response_fixtures={download_url: _ResponseFixture(body)},
        )
        client = BrowserClient(
            factory=factory,
            resolver=self.resolver,
            coordinator=AccessCoordinator(),
            destination_policy=_PUBLIC_POLICY,
        )

        batch = _captures(
            client.run(
                self.scope,
                "https://landing.test/start",
                self.policy,
                capture_guard=guard,
            )
        )

        self.assertEqual(len(batch.captures), 1)
        self.assertIs(batch.captures[0].kind, BrowserCaptureKind.RESPONSE)
        self.assertEqual(batch.captures[0].stream.chunks, (body,))
        self.assertTrue(download.deleted)
        self.assertEqual(download.delete_calls, 1)

    def test_direct_pdf_waits_for_delayed_native_download_before_cleanup(self) -> None:
        download_url = "https://download.test/article.pdf"
        download = _FakeDownload(download_url, b"%PDF-delayed-native-download")
        factory = _FakeFactory(
            configured_download=download,
            delayed_native_download=True,
        )
        client = BrowserClient(
            factory=factory,
            resolver=self.resolver,
            coordinator=AccessCoordinator(),
            destination_policy=_PUBLIC_POLICY,
        )
        guard = _CaptureGuard(
            {
                (
                    download_url,
                    BrowserCaptureKind.DOWNLOAD,
                    "application/pdf",
                )
            }
        )
        results: list[object] = []

        worker = threading.Thread(
            target=lambda: results.append(
                client.run(
                    self.scope,
                    download_url,
                    self.policy,
                    capture_guard=guard,
                )
            )
        )
        worker.start()
        context: _FakeContext | None = None
        for _ in range(200):
            context = factory.process.context
            if context is not None and context.delayed_download_scheduled.wait(0.01):
                break
            time.sleep(0.01)
        else:
            self.fail("direct-PDF navigation did not reserve its native download")

        assert context is not None
        self.assertTrue(worker.is_alive())
        self.assertFalse(context.pages[0].closed)
        self.assertFalse(context.closed)
        context.release_delayed_download.set()
        worker.join(2.0)

        self.assertFalse(worker.is_alive())
        self.assertTrue(context.delayed_download_finished.is_set())
        self.assertEqual(len(results), 1)
        stream = _download(results[0])
        self.assertEqual(stream.chunks, (b"%PDF-delayed-native-download",))
        self.assertIs(download.emitted_after_page_closed, False)
        self.assertTrue(download.deleted)
        self.assertEqual(download.delete_calls, 1)
        self.assertTrue(context.pages[0].closed)
        self.assertTrue(context.closed)

    def test_private_response_stream_is_bounded_and_closed_exactly_once(self) -> None:
        response_url = "https://landing.test/start"
        guard = _CaptureGuard({(response_url, BrowserCaptureKind.RESPONSE, "application/pdf")})
        for close_error, expected_code in ((False, None), (True, "cleanup")):
            with self.subTest(close_error=close_error):
                stream = _BodyStream(b"%PDF-stream-body", close_error=close_error)
                factory = _FakeFactory(response_fixtures={response_url: _ResponseFixture(stream)})
                client = BrowserClient(
                    factory=factory,
                    resolver=self.resolver,
                    coordinator=AccessCoordinator(),
                    destination_policy=_PUBLIC_POLICY,
                )

                result = client.run(
                    self.scope,
                    response_url,
                    AccessPolicy(max_concurrency=1),
                    capture_guard=guard,
                )

                if expected_code is None:
                    batch = _captures(result)
                    self.assertEqual(batch.captures[0].stream.chunks, (b"%PDF-stream-body",))
                else:
                    self.assertEqual(_failure(result).code, expected_code)
                self.assertEqual(stream.read_calls, 1)
                self.assertEqual(stream.close_calls, 1)
                context = factory.process.context
                self.assertIsNotNone(context)
                assert context is not None
                self.assertEqual(context.pages[0].close_calls, 1)
                self.assertEqual(context.close_calls, 1)
                self.assertEqual(factory.process.close_calls, 1)

    def test_capture_guard_rejects_before_body_and_errors_fail_closed(self) -> None:
        response_url = "https://landing.test/start"
        fixture = _ResponseFixture(b"%PDF-must-not-be-read")
        for guard, expected_code in (
            (_CaptureGuard(set()), "no-download"),
            (
                _CaptureGuard(set(), error=RuntimeError("private policy sentinel")),
                "policy",
            ),
        ):
            with self.subTest(expected_code=expected_code):
                factory = _FakeFactory(response_fixtures={response_url: fixture})
                client = BrowserClient(
                    factory=factory,
                    resolver=self.resolver,
                    coordinator=AccessCoordinator(),
                    destination_policy=_PUBLIC_POLICY,
                )

                failure = _failure(
                    client.run(
                        self.scope,
                        response_url,
                        self.policy,
                        capture_guard=guard,
                    )
                )

                self.assertEqual(failure.code, expected_code)
                self.assertNotIn("sentinel", repr(failure))
                assert factory.process.context is not None
                self.assertEqual(factory.process.context.responses[0].body_reads, 0)

    def test_capture_wait_rejects_unknown_kinds_without_exposing_runtime_state(self) -> None:
        factory = _FakeFactory(
            configured_download=_FakeDownload(
                "https://download.test/article.pdf",
                b"%PDF-fixture",
            )
        )
        client = BrowserClient(
            factory=factory,
            resolver=self.resolver,
            coordinator=AccessCoordinator(),
            destination_policy=_PUBLIC_POLICY,
        )

        def flow(session: object) -> None:
            session.wait_for_capture("dynamic-kind")  # type: ignore[attr-defined]

        failure = _failure(
            client.run(
                self.scope,
                "https://landing.test/start",
                self.policy,
                controller=_FlowController(flow),
            )
        )

        self.assertEqual(failure.code, "policy")

    def test_capture_wait_uses_a_single_operation_timeout(self) -> None:
        client = BrowserClient(
            factory=_FakeFactory(),
            resolver=self.resolver,
            coordinator=AccessCoordinator(),
            destination_policy=_PUBLIC_POLICY,
        )

        def flow(session: object) -> None:
            session.wait_for_any_capture(  # type: ignore[attr-defined]
                (BrowserCaptureKind.DOWNLOAD,)
            )

        started_at = time.monotonic()
        failure = _failure(
            client.run(
                self.scope,
                "https://landing.test/start",
                self.policy,
                controller=_FlowController(flow),
                limits=BrowserOperationLimits(
                    capture_wait_timeout_seconds=0.02,
                ),
            )
        )

        self.assertEqual(failure.code, "no-download")
        self.assertLess(time.monotonic() - started_at, 0.5)

    def test_capture_wait_limit_requires_finite_positive_seconds(self) -> None:
        with self.assertRaises(TypeError):
            BrowserOperationLimits(capture_wait_timeout_seconds=True)
        for value in (0.0, -1.0, float("nan"), float("inf")):
            with self.subTest(value=value), self.assertRaises(ValueError):
                BrowserOperationLimits(capture_wait_timeout_seconds=value)

    def test_action_limit_requires_finite_positive_seconds(self) -> None:
        with self.assertRaises(TypeError):
            BrowserOperationLimits(action_timeout_seconds=True)
        for value in (0.0, -1.0, float("nan"), float("inf")):
            with self.subTest(value=value), self.assertRaises(ValueError):
                BrowserOperationLimits(action_timeout_seconds=value)

    def test_page_request_count_is_not_an_article_job_budget(self) -> None:
        client = BrowserClient(
            factory=_FakeFactory(
                subresources=("https://landing.test/article.js",),
            ),
            resolver=self.resolver,
            coordinator=AccessCoordinator(),
            destination_policy=_PUBLIC_POLICY,
        )

        failure = _failure(
            client.run(
                self.scope,
                "https://landing.test/start",
                self.policy,
            )
        )
        self.assertEqual(failure.code, "no-download")

    def test_response_capture_enforces_the_single_capture_byte_limit(self) -> None:
        response_url = "https://landing.test/start"
        fixture = _ResponseFixture(b"12345")
        guard = _CaptureGuard({(response_url, BrowserCaptureKind.RESPONSE, "application/pdf")})
        client = BrowserClient(
            factory=_FakeFactory(response_fixtures={response_url: fixture}),
            resolver=self.resolver,
            coordinator=AccessCoordinator(),
            destination_policy=_PUBLIC_POLICY,
        )
        self.assertEqual(
            _failure(
                client.run(
                    self.scope,
                    response_url,
                    self.policy,
                    capture_guard=guard,
                    limits=BrowserOperationLimits(max_capture_bytes=4),
                )
            ).code,
            "oversize",
        )

    def test_initial_signed_query_is_rejected_but_runtime_download_is_redacted(self) -> None:
        initial = _failure(
            self.client.run(
                self.scope,
                "https://landing.test/start?token=sentinel",
                self.policy,
            )
        )
        self.assertEqual(initial.code, "policy")
        self.assertNotIn("sentinel", repr(initial))

        self.factory = _FakeFactory(
            configured_download=_FakeDownload("https://download.test/file?token=sentinel", b"ok")
        )
        self.client = BrowserClient(
            factory=self.factory,
            resolver=self.resolver,
            coordinator=self.coordinator,
            destination_policy=_PUBLIC_POLICY,
        )
        result = _download(
            self.client.run(
                self.scope,
                "https://landing.test/start",
                self.policy,
            )
        )
        self.assertEqual(result.final_locator, "https://download.test/file")
        self.assertNotIn("sentinel", repr(result))

    def test_verified_runtime_locator_keeps_signed_query_only_inside_browser(self) -> None:
        signed = "https://download.test/article.pdf?signature=sentinel"
        safe = "https://download.test/article.pdf"
        factory = _FakeFactory(response_fixtures={signed: _ResponseFixture(b"%PDF-signed-runtime")})
        guard = _OriginGuard("https://landing.test", "https://download.test")
        capture_guard = _CaptureGuard(
            {(safe, BrowserCaptureKind.VERIFIED_LOCATOR, "application/pdf")}
        )
        client = BrowserClient(
            factory=factory,
            resolver=self.resolver,
            coordinator=AccessCoordinator(),
            destination_policy=_PUBLIC_POLICY,
        )

        def flow(session: object) -> None:
            session.open_verified_locator(signed)  # type: ignore[attr-defined]
            session.wait_for_capture(  # type: ignore[attr-defined]
                BrowserCaptureKind.VERIFIED_LOCATOR
            )

        batch = _captures(
            client.run(
                self.scope,
                "https://landing.test/start",
                self.policy,
                controller=_FlowController(flow),
                destination_guard=guard,
                capture_guard=capture_guard,
            )
        )

        self.assertEqual(len(batch.captures), 1)
        self.assertIs(batch.captures[0].kind, BrowserCaptureKind.VERIFIED_LOCATOR)
        result = batch.captures[0].stream
        self.assertEqual(result.final_locator, safe)
        assert factory.process.context is not None
        self.assertEqual(factory.process.context.pages[1].url, signed)
        self.assertNotIn("sentinel", repr(result))
        self.assertTrue(all("sentinel" not in url for url, _kind in guard.calls))

    def test_pdf_discovery_filters_origins_before_dns_and_retains_runtime_query(self) -> None:
        signed = "https://download.test/article.pdf?signature=sentinel"
        rejected = "https://other.test/unreviewed.pdf?signature=private"
        factory = _FakeFactory()
        guard = _OriginGuard("https://landing.test", "https://download.test")
        client = BrowserClient(
            factory=factory,
            resolver=self.resolver,
            coordinator=AccessCoordinator(),
            destination_policy=_PUBLIC_POLICY,
        )
        discovered: list[tuple[str, ...]] = []

        def flow(session: object) -> None:
            assert factory.process.context is not None
            factory.process.context.discovered_pdf_locators = (signed, rejected)
            discovered.append(session.discover_pdf_locators())  # type: ignore[attr-defined]

        result = _failure(
            client.run(
                self.scope,
                "https://landing.test/start",
                self.policy,
                controller=_FlowController(flow),
                destination_guard=guard,
            )
        )

        self.assertEqual(result.code, "no-download")
        self.assertEqual(discovered, [(signed,)])
        self.assertNotIn("other.test", self.resolver.calls)
        self.assertTrue(all("sentinel" not in url for url, _kind in guard.calls))

    def test_redirect_and_request_policy_rechecks_each_actual_navigation(self) -> None:
        factory = _FakeFactory(
            redirects={
                "https://landing.test/start": "https://other.test/redirect",
            },
            configured_download=_FakeDownload("https://download.test/file", b"ok"),
        )
        client = BrowserClient(
            factory=factory,
            resolver=self.resolver,
            coordinator=self.coordinator,
            destination_policy=_PUBLIC_POLICY,
        )
        result = client.run(
            self.scope,
            "https://landing.test/start",
            self.policy,
        )
        self.assertEqual(_download(result).chunks, (b"ok",))
        self.assertEqual(
            self.coordinator.hosts,
            ["landing.test", "other.test", "download.test"],
        )

        rejected_factory = _FakeFactory(
            redirects={"https://landing.test/start": "https://private.test/redirect"}
        )
        rejected_client = BrowserClient(
            factory=rejected_factory,
            resolver=self.resolver,
            coordinator=AccessCoordinator(),
            destination_policy=_PUBLIC_POLICY,
        )
        rejected = _failure(
            rejected_client.run(self.scope, "https://landing.test/start", self.policy)
        )
        self.assertEqual(rejected.code, "policy")

    def test_destination_guard_rejects_initial_origin_before_dns_or_runtime(self) -> None:
        guard = _OriginGuard("https://landing.test")

        result = _failure(
            self.client.run(
                self.scope,
                "https://other.test/start",
                self.policy,
                destination_guard=guard,
            )
        )

        self.assertEqual(result.code, "policy")
        self.assertEqual(self.resolver.calls, [])
        self.assertEqual(self.factory.events, [])
        self.assertEqual(
            guard.calls,
            [
                (
                    "https://other.test/start",
                    BrowserDestinationKind.INITIAL_NAVIGATION,
                )
            ],
        )

    def test_destination_guard_rejects_each_external_hop_before_its_dns_lookup(
        self,
    ) -> None:
        cases: tuple[
            tuple[
                str,
                _FakeFactory,
                Callable[[object], None] | None,
                str,
                BrowserDestinationKind,
            ],
            ...,
        ] = (
            (
                "redirect",
                _FakeFactory(
                    redirects={
                        "https://landing.test/start": "https://other.test/redirect",
                    }
                ),
                None,
                "https://other.test/redirect",
                BrowserDestinationKind.NAVIGATION,
            ),
            (
                "subresource",
                _FakeFactory(subresources=("https://other.test/tracker.js",)),
                None,
                "https://other.test/tracker.js",
                BrowserDestinationKind.REQUEST,
            ),
            (
                "popup",
                _FakeFactory(),
                lambda session: session.open_popup(  # type: ignore[attr-defined]
                    "https://other.test/viewer"
                ),
                "https://other.test/viewer",
                BrowserDestinationKind.POPUP,
            ),
            (
                "download",
                _FakeFactory(
                    configured_download=_FakeDownload(
                        "https://other.test/article.pdf",
                        b"blocked",
                    )
                ),
                None,
                "https://other.test/article.pdf",
                BrowserDestinationKind.REQUEST,
            ),
        )
        for name, factory, flow, expected_url, expected_kind in cases:
            with self.subTest(name=name):
                resolver = _Resolver(self.resolver.answers)
                guard = _OriginGuard("https://landing.test")
                client = BrowserClient(
                    factory=factory,
                    resolver=resolver,
                    coordinator=AccessCoordinator(),
                    destination_policy=_PUBLIC_POLICY,
                )

                result = _failure(
                    client.run(
                        self.scope,
                        "https://landing.test/start",
                        self.policy,
                        controller=None if flow is None else _FlowController(flow),
                        destination_guard=guard,
                    )
                )

                self.assertEqual(result.code, "policy")
                self.assertNotIn("other.test", resolver.calls)
                self.assertIn(
                    (expected_url, expected_kind),
                    guard.calls,
                )

    def test_unapproved_subresources_can_be_discarded_without_weakening_navigation(self) -> None:
        factory = _FakeFactory(
            subresources=(
                "https://landing.test/article.js",
                "https://other.test/tracker.js",
            )
        )
        resolver = _Resolver(self.resolver.answers)
        guard = _OriginGuard("https://landing.test")
        client = BrowserClient(
            factory=factory,
            resolver=resolver,
            coordinator=AccessCoordinator(),
            destination_policy=_PUBLIC_POLICY,
        )

        result = _failure(
            client.run(
                self.scope,
                "https://landing.test/start",
                self.policy,
                destination_guard=guard,
                discard_unapproved_subresources=True,
            )
        )

        self.assertEqual(result.code, "no-download")
        self.assertNotIn("other.test", resolver.calls)
        context = factory.process.context
        self.assertIsNotNone(context)
        assert context is not None
        self.assertIn(
            "https://landing.test/article.js",
            tuple(response.url for response in context.responses),
        )
        self.assertNotIn(
            "https://other.test/tracker.js",
            tuple(response.url for response in context.responses),
        )
        self.assertIn(
            (
                "https://other.test/tracker.js",
                BrowserDestinationKind.REQUEST,
            ),
            guard.calls,
        )

        redirect_factory = _FakeFactory(
            redirects={
                "https://landing.test/start": "https://other.test/redirect",
            }
        )
        redirect_resolver = _Resolver(self.resolver.answers)
        redirect_client = BrowserClient(
            factory=redirect_factory,
            resolver=redirect_resolver,
            coordinator=AccessCoordinator(),
            destination_policy=_PUBLIC_POLICY,
        )

        redirect_result = _failure(
            redirect_client.run(
                self.scope,
                "https://landing.test/start",
                self.policy,
                destination_guard=_OriginGuard("https://landing.test"),
                discard_unapproved_subresources=True,
            )
        )

        self.assertEqual(redirect_result.code, "policy")
        self.assertNotIn("other.test", redirect_resolver.calls)

    def test_request_guard_policy_rejection_discards_subresource_before_host_binding(self) -> None:
        factory = _FakeFactory(subresources=("https://landing.test/challenge.js",))
        coordinator = _RecordingCoordinator()
        resolver = _Resolver(self.resolver.answers)
        guard = _SubresourceRejectingGuard("https://landing.test")
        client = BrowserClient(
            factory=factory,
            resolver=resolver,
            coordinator=coordinator,
            destination_policy=_PUBLIC_POLICY,
        )

        with self.assertLogs("sciretriever.network.browser", level="DEBUG") as logs:
            result = _failure(
                client.run(
                    self.scope,
                    "https://landing.test/start",
                    self.policy,
                    destination_guard=guard,
                    discard_unapproved_subresources=True,
                )
            )

        self.assertEqual(result.code, "no-download")
        self.assertEqual(coordinator.hosts, ["landing.test"])
        context = factory.process.context
        self.assertIsNotNone(context)
        assert context is not None
        # Process/context acknowledgement plus one prebound origin are the
        # complete initial transport handshake; the rejected subresource must
        # not add another context binding.
        self.assertEqual(len(context.bindings), 3)
        self.assertEqual(
            tuple(response.url for response in context.responses),
            ("https://landing.test/start",),
        )
        self.assertIn("blocked_requests=1", "\n".join(logs.output))
        self.assertNotIn("challenge.js", "\n".join(logs.output))

    def test_unapproved_redirected_subresource_response_is_locally_discarded(self) -> None:
        approved_request = "https://landing.test/redirecting-tracker.js"
        rejected_response = "https://other.test/tracker.js"
        factory = _FakeFactory(
            subresources=(approved_request,),
            response_fixtures={
                approved_request: _ResponseFixture(
                    b"not-readable",
                    media_type="application/javascript",
                    final_url=rejected_response,
                )
            },
        )
        resolver = _Resolver(self.resolver.answers)
        guard = _OriginGuard("https://landing.test")
        client = BrowserClient(
            factory=factory,
            resolver=resolver,
            coordinator=AccessCoordinator(),
            destination_policy=_PUBLIC_POLICY,
        )

        result = _failure(
            client.run(
                self.scope,
                "https://landing.test/start",
                self.policy,
                destination_guard=guard,
                discard_unapproved_subresources=True,
            )
        )

        self.assertEqual(result.code, "no-download")
        self.assertNotIn("other.test", resolver.calls)
        self.assertIn(
            (rejected_response, BrowserDestinationKind.RESPONSE),
            guard.calls,
        )

    def test_destination_guard_covers_popup_request_and_download_capture(self) -> None:
        factory = _FakeFactory(
            configured_download=_FakeDownload(
                "https://download.test/article.pdf?view=full",
                b"fixture",
            )
        )
        guard = _OriginGuard(
            "https://landing.test",
            "https://popup.test",
            "https://download.test",
        )
        client = BrowserClient(
            factory=factory,
            resolver=self.resolver,
            coordinator=AccessCoordinator(),
            destination_policy=_PUBLIC_POLICY,
        )

        result = _download(
            client.run(
                self.scope,
                "https://landing.test/start",
                self.policy,
                controller=_FlowController(
                    lambda session: session.open_popup(  # type: ignore[attr-defined]
                        "https://popup.test/viewer"
                    )
                ),
                destination_guard=guard,
            )
        )

        self.assertEqual(result.chunks, (b"fixture",))
        kinds = {kind for _url, kind in guard.calls}
        self.assertTrue(
            {
                BrowserDestinationKind.INITIAL_NAVIGATION,
                BrowserDestinationKind.NAVIGATION,
                BrowserDestinationKind.REQUEST,
                BrowserDestinationKind.POPUP,
                BrowserDestinationKind.RESPONSE,
                BrowserDestinationKind.DOWNLOAD,
            }
            <= kinds
        )
        self.assertTrue(all("?" not in url for url, _kind in guard.calls))

    def test_download_oversize_is_bounded_but_popup_count_is_not_a_job_budget(self) -> None:
        def oversized(session: object) -> None:
            del session

        oversized_result = _failure(
            BrowserClient(
                factory=_FakeFactory(
                    configured_download=_FakeDownload("https://download.test/file", b"12345")
                ),
                resolver=self.resolver,
                coordinator=self.coordinator,
                destination_policy=_PUBLIC_POLICY,
            ).run(
                self.scope,
                "https://landing.test/start",
                self.policy,
                controller=_FlowController(oversized),
                limits=BrowserOperationLimits(max_capture_bytes=4),
            )
        )
        self.assertEqual(oversized_result.code, "oversize")

        storm_factory = _FakeFactory()
        storm_coordinator = AccessCoordinator()
        storm_client = BrowserClient(
            factory=storm_factory,
            resolver=self.resolver,
            coordinator=storm_coordinator,
            destination_policy=_PUBLIC_POLICY,
        )

        def popup_storm(session: object) -> None:
            session.open_popup("https://popup.test/one")  # type: ignore[attr-defined]
            session.open_popup("https://popup.test/two")  # type: ignore[attr-defined]

        storm_result = _failure(
            storm_client.run(
                self.scope,
                "https://landing.test/start",
                self.policy,
                controller=_FlowController(popup_storm),
            )
        )
        self.assertEqual(storm_result.code, "no-download")

    def test_control_observation_enumerates_article_surfaces_and_clears_after_cleanup(
        self,
    ) -> None:
        observed: list[BrowserObservation] = []
        retained_control: list[BrowserControlSession] = []

        def inspect_flow(session: object) -> None:
            getattr(session, "open_popup")("https://popup.test/viewer")
            control = cast(BrowserControlSession, getattr(session, "control_session")())
            retained_control.append(control)
            observed.append(control.observe(page_state=BrowserPageState.CHALLENGE))

        result = _failure(
            self.client.run(
                self.scope,
                "https://landing.test/start",
                self.policy,
                controller=_FlowController(inspect_flow),
            )
        )

        self.assertEqual(result.code, "no-download")
        observation = observed[0]
        self.assertIs(observation.page_state, BrowserPageState.CHALLENGE)
        self.assertIs(observation.capture_state, BrowserCaptureState.NONE)
        self.assertEqual(len(observation.surfaces), 8)
        self.assertEqual(
            {surface.kind for surface in observation.surfaces},
            {
                BrowserSurfaceKind.PAGE,
                BrowserSurfaceKind.POPUP,
                BrowserSurfaceKind.FRAME,
                BrowserSurfaceKind.SHADOW,
                BrowserSurfaceKind.VIEWER,
            },
        )
        self.assertEqual(len(observation.elements), 6)
        self.assertEqual(observation.page_id, observation.screenshot.page_id)
        control_state = getattr(getattr(retained_control[0], "_state"), "control")
        self.assertIsNone(control_state.ledger.current)
        self.assertIsNone(control_state.observation)
        self.assertEqual(control_state.page_keys, {})
        self.assertEqual(control_state.surface_keys, {})
        self.assertEqual(control_state.element_keys, {})

    def test_control_executes_six_closed_actions_and_returns_receipts(self) -> None:
        receipts: list[object] = []
        vendor_calls: list[tuple[object, ...]] = []

        def action_flow(session: object) -> None:
            control = cast(BrowserControlSession, getattr(session, "control_session")())
            observation = control.observe(page_state=BrowserPageState.NORMAL)
            enabled = next(
                element for element in observation.elements if element.name == "Download PDF"
            )
            enabled_surface = next(
                surface
                for surface in observation.surfaces
                if surface.surface_id == enabled.surface_id
            )
            receipts.append(
                control.execute(
                    ClickElement(
                        observation.article_token,
                        enabled_surface.page_id,
                        enabled_surface.surface_id,
                        observation.revision,
                        enabled.element_id,
                    ),
                    observation,
                    timeout_seconds=0.5,
                )
            )

            observation = control.observe(page_state=BrowserPageState.NORMAL)
            frame = next(
                surface
                for surface in observation.surfaces
                if surface.kind is BrowserSurfaceKind.FRAME
            )
            receipts.append(
                control.execute(
                    ClickPoint(
                        observation.article_token,
                        frame.page_id,
                        frame.surface_id,
                        observation.revision,
                        observation.screenshot.screenshot_id,
                        100,
                        100,
                    ),
                    observation,
                    timeout_seconds=0.5,
                )
            )

            observation = control.observe(page_state=BrowserPageState.NORMAL)
            receipts.append(
                control.execute(
                    ScrollSurface(
                        observation.article_token,
                        observation.page_id,
                        frame.surface_id,
                        observation.revision,
                        300,
                    ),
                    observation,
                    timeout_seconds=0.5,
                )
            )

            observation = control.observe(page_state=BrowserPageState.NORMAL)
            receipts.append(
                control.execute(
                    GoBack(
                        observation.article_token,
                        observation.page_id,
                        observation.revision,
                    ),
                    observation,
                    timeout_seconds=0.5,
                )
            )

            observation = control.observe(page_state=BrowserPageState.NORMAL)
            receipts.append(
                control.execute(
                    WaitForChange(
                        observation.article_token,
                        observation.page_id,
                        observation.revision,
                    ),
                    observation,
                    timeout_seconds=0.5,
                )
            )
            receipts.append(
                control.execute(
                    Stop(
                        observation.article_token,
                        observation.page_id,
                        observation.revision,
                        "normal-miss",
                    ),
                    observation,
                    timeout_seconds=0.5,
                )
            )
            context = self.factory.process.context
            assert context is not None
            vendor_calls.extend(context.pages[0].control_calls)

        result = _failure(
            self.client.run(
                self.scope,
                "https://landing.test/start",
                self.policy,
                controller=_FlowController(action_flow),
            )
        )

        self.assertEqual(result.code, "no-download")
        self.assertEqual(
            tuple(getattr(receipt, "outcome") for receipt in receipts),
            (
                BrowserActionOutcome.APPLIED,
                BrowserActionOutcome.APPLIED,
                BrowserActionOutcome.APPLIED,
                BrowserActionOutcome.NAVIGATION,
                BrowserActionOutcome.NO_CHANGE,
                BrowserActionOutcome.APPLIED,
            ),
        )
        self.assertEqual(
            tuple(call[0] for call in vendor_calls),
            ("click-element", "click-point", "scroll-surface", "go-back", "wait-for-change"),
        )
        self.assertTrue(all(call[-1] == 500 for call in vendor_calls), vendor_calls)

    def test_control_rejects_invalid_targets_before_vendor_action(self) -> None:  # noqa: C901
        case_names = (
            "stale-revision",
            "unknown-element",
            "hidden-element",
            "disabled-element",
            "unknown-page",
            "unknown-surface",
            "wrong-screenshot",
            "outside-viewport",
            "outside-surface",
            "unknown-scroll-surface",
        )

        def build_action(name: str, observation: BrowserObservation) -> BrowserAction:
            enabled = next(
                element for element in observation.elements if element.name == "Download PDF"
            )
            disabled = next(
                element for element in observation.elements if element.name == "Disabled"
            )
            root = next(
                surface
                for surface in observation.surfaces
                if surface.kind is BrowserSurfaceKind.PAGE
            )
            frame = next(
                surface
                for surface in observation.surfaces
                if surface.kind is BrowserSurfaceKind.FRAME
            )
            if name == "stale-revision":
                return ClickElement(
                    observation.article_token,
                    observation.page_id,
                    root.surface_id,
                    observation.revision + 1,
                    enabled.element_id,
                )
            if name in {"unknown-element", "hidden-element"}:
                return ClickElement(
                    observation.article_token,
                    observation.page_id,
                    root.surface_id,
                    observation.revision,
                    "effffffff" if name == "unknown-element" else "efffffffe",
                )
            if name == "disabled-element":
                return ClickElement(
                    observation.article_token,
                    observation.page_id,
                    root.surface_id,
                    observation.revision,
                    disabled.element_id,
                )
            if name == "unknown-page":
                return ClickElement(
                    observation.article_token,
                    "pffffffff",
                    root.surface_id,
                    observation.revision,
                    enabled.element_id,
                )
            if name == "unknown-scroll-surface":
                return ScrollSurface(
                    observation.article_token,
                    observation.page_id,
                    "sffffffff",
                    observation.revision,
                    200,
                )
            surface_id = "sffffffff" if name == "unknown-surface" else root.surface_id
            screenshot_id = (
                "iffffffff" if name == "wrong-screenshot" else observation.screenshot.screenshot_id
            )
            x = 1281.0 if name == "outside-viewport" else 100.0
            if name == "outside-surface":
                surface_id = frame.surface_id
                x = 1000.0
            return ClickPoint(
                observation.article_token,
                observation.page_id,
                surface_id,
                observation.revision,
                screenshot_id,
                x,
                100,
            )

        for name in case_names:
            with self.subTest(case=name):
                factory = _FakeFactory()
                client = BrowserClient(
                    factory=factory,
                    resolver=self.resolver,
                    coordinator=AccessCoordinator(),
                    destination_policy=_PUBLIC_POLICY,
                )
                rejected: list[bool] = []
                snapshot_calls_before_execute: list[int] = []

                def rejected_flow(session: object) -> None:
                    control = cast(
                        BrowserControlSession,
                        getattr(session, "control_session")(),
                    )
                    observation = control.observe(page_state=BrowserPageState.NORMAL)
                    context = factory.process.context
                    assert context is not None
                    snapshot_calls_before_execute.append(context.pages[0].control_snapshot_calls)
                    try:
                        control.execute(
                            build_action(name, observation),
                            observation,
                            timeout_seconds=0.5,
                        )
                    except Exception:
                        rejected.append(True)

                result = _failure(
                    client.run(
                        self.scope,
                        "https://landing.test/start",
                        self.policy,
                        controller=_FlowController(rejected_flow),
                    )
                )
                self.assertEqual(result.code, "no-download")
                self.assertEqual(rejected, [True])
                context = factory.process.context
                assert context is not None
                self.assertEqual(context.pages[0].control_calls, [])
                self.assertEqual(snapshot_calls_before_execute, [1])
                self.assertEqual(context.pages[0].control_snapshot_calls, 1)

    def test_control_capture_receipt_uses_shared_download_pipeline(self) -> None:
        receipt_outcomes: list[BrowserActionOutcome] = []

        def capture_flow(session: object) -> None:
            context = self.factory.process.context
            assert context is not None
            context.pages[0].control_capture_url = "https://download.test/control.pdf"
            control = cast(BrowserControlSession, getattr(session, "control_session")())
            observation = control.observe(page_state=BrowserPageState.NORMAL)
            element = next(value for value in observation.elements if value.name == "Download PDF")
            surface = next(
                value for value in observation.surfaces if value.surface_id == element.surface_id
            )
            receipt = control.execute(
                ClickElement(
                    observation.article_token,
                    surface.page_id,
                    surface.surface_id,
                    observation.revision,
                    element.element_id,
                ),
                observation,
                timeout_seconds=0.5,
            )
            receipt_outcomes.append(receipt.outcome)

        result = self.client.run(
            self.scope,
            "https://landing.test/start",
            self.policy,
            controller=_FlowController(capture_flow),
        )

        self.assertIsInstance(result, BrowserCaptureBatch)
        self.assertEqual(receipt_outcomes, [BrowserActionOutcome.CAPTURE])
        assert isinstance(result, BrowserCaptureBatch)
        self.assertEqual(b"".join(result.captures[0].stream.chunks), b"%PDF-control-capture")

    def test_cancel_and_timeout_never_return_late_download(self) -> None:
        cancelled = threading.Event()

        def cancel_flow(session: object) -> None:
            del session
            cancelled.set()

        cancelled_result = _failure(
            self.client.run(
                self.scope,
                "https://landing.test/start",
                self.policy,
                controller=_FlowController(cancel_flow),
                cancel_event=cancelled,
            )
        )
        self.assertEqual(cancelled_result.code, "cancelled")
        self.assertNotIn("late", repr(cancelled_result))

        timeout_factory = _FakeFactory(goto_error=TimeoutError("timeout-secret"))
        timeout_client = BrowserClient(
            factory=timeout_factory,
            resolver=self.resolver,
            coordinator=AccessCoordinator(),
            destination_policy=_PUBLIC_POLICY,
        )
        timeout_result = _failure(
            timeout_client.run(
                self.scope,
                "https://landing.test/start",
                self.policy,
                timeout_seconds=0.001,
            )
        )
        self.assertIn(timeout_result.code, {"timeout", "runtime"})
        self.assertNotIn("timeout-secret", repr(timeout_result))

    def test_cleanup_exception_is_neutral_and_scope_cooldown_starts_after_cleanup(self) -> None:
        marker = "cleanup-secret-sentinel"
        factory = _FakeFactory(
            context_close_error=RuntimeError(marker),
            configured_download=_FakeDownload("https://download.test/file", b"ok"),
        )
        clock = _FakeClock()
        coordinator = _RecordingCoordinator(clock=clock)
        clock.coordinator = coordinator
        client = BrowserClient(
            factory=factory,
            resolver=self.resolver,
            coordinator=coordinator,
            destination_policy=_PUBLIC_POLICY,
            clock=clock,
        )
        result = _failure(
            client.run(
                self.scope,
                "https://landing.test/start",
                self.policy,
            )
        )
        self.assertEqual(result.code, "cleanup")
        self.assertNotIn(marker, repr(result))

        acquired = threading.Event()
        release = threading.Event()

        def wait_for_scope() -> None:
            permit = coordinator.acquire_scope(self.scope)
            acquired.set()
            release.wait(1.0)
            permit.release()

        worker = threading.Thread(target=wait_for_scope)
        worker.start()
        self.assertFalse(acquired.wait(0.05))
        clock.advance(29.9)
        self.assertFalse(acquired.wait(0.05))
        clock.advance(0.1)
        self.assertTrue(acquired.wait(1.0))
        release.set()
        worker.join(1.0)
        self.assertFalse(worker.is_alive())

    def test_scope_release_failure_is_cleanup_not_exhaustion_or_permit_leak(self) -> None:
        coordinator = _ReleaseFailingCoordinator()
        download = _FakeDownload("https://download.test/file", b"%PDF-fixture")
        factory = _FakeFactory(configured_download=download)
        client = BrowserClient(
            factory=factory,
            resolver=self.resolver,
            coordinator=coordinator,
            destination_policy=_PUBLIC_POLICY,
        )

        result = _failure(
            client.run(
                self.scope,
                "https://landing.test/start",
                AccessPolicy(max_concurrency=1),
            )
        )

        self.assertEqual(result.code, "cleanup")
        self.assertEqual(download.delete_calls, 1)
        self.assertEqual(coordinator.release_failures, 1)
        permit = coordinator.acquire_scope(self.scope, timeout=0.1)
        permit.release()

    def test_article_temporary_directory_cleanup_failure_is_stable(self) -> None:
        real_temporary_directory = tempfile.TemporaryDirectory

        class FailingTemporaryDirectory:
            def __init__(self, *, prefix: str) -> None:
                self._delegate = real_temporary_directory(prefix=prefix)
                self.name = self._delegate.name
                self.cleanup_calls = 0
                created.append(self)

            def cleanup(self) -> None:
                self.cleanup_calls += 1
                self._delegate.cleanup()
                raise RuntimeError("temporary cleanup sentinel")

        created: list[FailingTemporaryDirectory] = []

        factory = _FakeFactory(
            configured_download=_FakeDownload(
                "https://download.test/file",
                b"%PDF-fixture",
            )
        )
        client = BrowserClient(
            factory=factory,
            resolver=self.resolver,
            coordinator=AccessCoordinator(),
            destination_policy=_PUBLIC_POLICY,
        )

        with mock.patch(
            "sciretriever.network.browser.tempfile.TemporaryDirectory",
            FailingTemporaryDirectory,
        ):
            result = _failure(
                client.run(
                    self.scope,
                    "https://landing.test/start",
                    AccessPolicy(max_concurrency=1),
                )
            )

        self.assertEqual(result.code, "cleanup")
        self.assertEqual(len(created), 1)
        temporary = created[0]
        self.assertEqual(temporary.cleanup_calls, 1)
        self.assertFalse(Path(temporary.name).exists())

    def test_runtime_without_mandatory_connection_binding_fails_closed(self) -> None:
        factory = _FakeFactory()
        # Accept the injected keyword but deliberately provide no runtime
        # acknowledgement: resolver addresses must never be an ignored hint.
        factory.process.bind_connection = None  # type: ignore[method-assign]
        client = BrowserClient(
            factory=factory,
            resolver=self.resolver,
            coordinator=AccessCoordinator(),
            destination_policy=_PUBLIC_POLICY,
        )
        result = _failure(client.run(self.scope, "https://landing.test/start", self.policy))
        self.assertEqual(result.code, "runtime")
        self.assertEqual(factory.events, ["process-enter", "process-close", "process-exit"])

    def test_setup_failpoints_close_each_acquired_runtime_resource_once(self) -> None:
        cases = (
            _FakeFactory(enter_error=RuntimeError("enter sentinel")),
            _FakeFactory(new_context_error=RuntimeError("context sentinel")),
            _FakeFactory(new_page_error=RuntimeError("page sentinel")),
        )
        for factory in cases:
            with self.subTest(events=factory.events):
                client = BrowserClient(
                    factory=factory,
                    resolver=self.resolver,
                    coordinator=AccessCoordinator(),
                    destination_policy=_PUBLIC_POLICY,
                )

                result = _failure(
                    client.run(
                        self.scope,
                        "https://landing.test/start",
                        AccessPolicy(max_concurrency=1),
                    )
                )

                self.assertEqual(result.code, "runtime")
                self.assertTrue(factory.process.closed)
                self.assertEqual(factory.process.close_calls, 1)
                context = factory.process.context
                if context is not None:
                    self.assertTrue(context.closed)
                    self.assertEqual(context.close_calls, 1)

    def test_connection_binding_preserves_authority_tls_and_verified_endpoint(self) -> None:
        factory = _FakeFactory(
            configured_download=_FakeDownload("https://download.test/file", b"ok")
        )
        client = BrowserClient(
            factory=factory,
            resolver=self.resolver,
            coordinator=AccessCoordinator(),
            destination_policy=_PUBLIC_POLICY,
        )
        result = _download(client.run(self.scope, "https://landing.test/start", self.policy))
        self.assertEqual(result.chunks, (b"ok",))
        binding = factory.binding
        self.assertIsNotNone(binding)
        assert binding is not None
        self.assertEqual(getattr(binding, "address"), "93.184.216.34")
        self.assertEqual(getattr(binding, "verified_addresses"), ("93.184.216.34",))
        self.assertEqual(getattr(binding, "hostname"), "landing.test")
        self.assertEqual(getattr(binding, "authority"), "landing.test")
        self.assertEqual(getattr(binding, "tls_server_name"), "landing.test")
        self.assertIs(factory.process.bindings[0], binding)
        assert factory.process.context is not None
        self.assertIs(factory.process.context.bindings[0], binding)

    def test_flow_receives_only_capabilities_and_no_vendor_surface(self) -> None:
        factory = _FakeFactory(
            configured_download=_FakeDownload("https://download.test/file", b"ok")
        )
        client = BrowserClient(
            factory=factory,
            resolver=self.resolver,
            coordinator=AccessCoordinator(),
            destination_policy=_PUBLIC_POLICY,
        )
        seen: dict[str, object] = {}

        def flow(session: object) -> None:
            for name in ("page", "context", "process", "route", "popups", "downloads"):
                try:
                    getattr(session, name)
                except AttributeError:
                    seen[name] = "hidden"
                else:
                    seen[name] = "exposed"
            self.assertIsNone(session.open_popup("https://popup.test/popup"))  # type: ignore[attr-defined]
            self.assertTrue(callable(getattr(session, "click")))
            self.assertIsNone(session.fill("#query", "fixture"))  # type: ignore[attr-defined]
            self.assertEqual(session.text("#title"), "#title")  # type: ignore[attr-defined]
            observation = cast(BrowserPageObservation, getattr(session, "observe")())
            self.assertEqual(observation.locator, "https://landing.test/start")
            self.assertEqual(observation.status_code, 200)
            self.assertEqual(observation.origin, "https://landing.test")
            self.assertEqual(observation.path, "/start")

        result = _download(
            client.run(
                self.scope,
                "https://landing.test/start",
                self.policy,
                controller=_FlowController(flow),
            )
        )
        self.assertEqual(result.chunks, (b"ok",))
        self.assertEqual(set(seen), {"page", "context", "process", "route", "popups", "downloads"})
        self.assertTrue(all(value == "hidden" for value in seen.values()))

    def test_page_observation_rejects_query_and_invalid_status(self) -> None:
        observation = BrowserPageObservation(
            locator="https://landing.test/article",
            status_code=403,
        )
        self.assertNotIn("landing.test", repr(observation))
        with self.assertRaises(ValueError):
            BrowserPageObservation(
                locator="https://landing.test/article?session=private",
                status_code=200,
            )
        for status in (True, 99, 600):
            with self.subTest(status=status), self.assertRaises(ValueError):
                BrowserPageObservation(
                    locator="https://landing.test/article",
                    status_code=cast(int, status),
                )

    def test_provider_rule_receives_403_instead_of_network_guessing_entitlement(self) -> None:
        factory = _FakeFactory(navigation_status=403)
        client = BrowserClient(
            factory=factory,
            resolver=self.resolver,
            coordinator=AccessCoordinator(),
            destination_policy=_PUBLIC_POLICY,
        )
        observations: list[BrowserPageObservation] = []

        def flow(session: object) -> None:
            observations.append(cast(BrowserPageObservation, getattr(session, "observe")()))

        result = _failure(
            client.run(
                self.scope,
                "https://landing.test/article",
                self.policy,
                controller=_FlowController(flow),
            )
        )

        self.assertEqual(result.code, "no-download")
        self.assertEqual(len(observations), 1)
        self.assertEqual(observations[0].status_code, 403)

    def test_same_article_subresources_reuse_host_before_response_events(self) -> None:
        factory = _FakeFactory(
            subresources=(
                "https://landing.test/one.png",
                "https://landing.test/two.png",
            ),
            defer_subresource_responses=True,
        )
        coordinator = _RecordingCoordinator()
        client = BrowserClient(
            factory=factory,
            resolver=self.resolver,
            coordinator=coordinator,
            destination_policy=_PUBLIC_POLICY,
        )
        policy = AccessPolicy(max_concurrency=1, min_start_interval=30.0)
        result_holder: list[object] = []

        def run() -> None:
            result_holder.append(client.run(self.scope, "https://landing.test/start", policy))

        worker = threading.Thread(target=run)
        worker.start()
        for _ in range(100):
            context = factory.process.context
            if context is not None and context.first_subresource_continued.wait(0.01):
                break
            time.sleep(0.01)
        else:
            self.fail("first subresource did not reach route continuation")
        context = factory.process.context
        assert context is not None
        # Neither response nor requestfinished has been emitted. A synchronous
        # Playwright route callback must still admit the second same-origin
        # request instead of waiting for an event on its own engine thread.
        self.assertTrue(context.second_subresource_continued.wait(1.0))
        self.assertEqual(coordinator.hosts, ["landing.test"])
        context.release_first_subresource.set()
        worker.join(2.0)
        self.assertFalse(worker.is_alive())
        self.assertEqual(_failure(result_holder[0]).code, "no-download")
        self.assertEqual(coordinator.released_hosts, ["landing.test"])
        self.assertEqual(coordinator._active_host_permits, {})

    def test_cancel_aborts_blocking_navigation_before_return(self) -> None:
        factory = _FakeFactory(
            blocking_goto=True,
            configured_download=_FakeDownload("https://download.test/late", b"late"),
        )
        client = BrowserClient(
            factory=factory,
            resolver=self.resolver,
            coordinator=AccessCoordinator(),
            destination_policy=_PUBLIC_POLICY,
        )
        cancelled = threading.Event()
        result_holder: list[object] = []

        def run() -> None:
            result_holder.append(
                client.run(
                    self.scope,
                    "https://landing.test/start",
                    self.policy,
                    cancel_event=cancelled,
                )
            )

        worker = threading.Thread(target=run)
        worker.start()
        context: _FakeContext | None = None
        for _ in range(100):
            context = factory.process.context
            if context is not None and context.goto_started.wait(0.01):
                break
            time.sleep(0.01)
        else:
            self.fail("blocking navigation did not start")
        cancelled.set()
        worker.join(2.0)
        self.assertFalse(worker.is_alive())
        self.assertEqual(_failure(result_holder[0]).code, "cancelled")
        self.assertNotIn("late", repr(result_holder[0]))
        assert context is not None
        self.assertTrue(factory.process.context.pages[0].abort_event.is_set())
        self.assertTrue(context.closed)
        self.assertTrue(factory.process.closed)

    def test_cancel_after_factory_completion_closes_unpublished_result_once(self) -> None:
        cancelled = threading.Event()
        delegate = _FakeFactory()

        def factory(
            *,
            downloads_path: str,
            connection_binding: object,
        ) -> object:
            process = delegate(
                downloads_path=downloads_path,
                connection_binding=connection_binding,
            )
            # The operation has produced a resource, but the cancellation is
            # visible before _run_cancellable publishes that result.
            cancelled.set()
            return process

        coordinator = AccessCoordinator()
        client = BrowserClient(
            factory=factory,
            resolver=self.resolver,
            coordinator=coordinator,
            destination_policy=_PUBLIC_POLICY,
        )

        result = _failure(
            client.run(
                self.scope,
                "https://landing.test/start",
                AccessPolicy(max_concurrency=1),
                cancel_event=cancelled,
            )
        )

        self.assertEqual(result.code, "cancelled")
        self.assertTrue(delegate.process.closed)
        self.assertEqual(delegate.process.close_calls, 1)
        permit = coordinator.acquire_scope(self.scope, timeout=0.1)
        permit.release()

    def test_unacknowledged_page_abort_escalates_to_bounded_cleanup(self) -> None:
        factory = _FakeFactory(blocking_goto=True, ignore_page_abort=True)
        coordinator = AccessCoordinator()
        client = BrowserClient(
            factory=factory,
            resolver=self.resolver,
            coordinator=coordinator,
            destination_policy=_PUBLIC_POLICY,
            cleanup_timeout_seconds=0.05,
        )
        cancelled = threading.Event()
        result_holder: list[object] = []

        worker = threading.Thread(
            target=lambda: result_holder.append(
                client.run(
                    self.scope,
                    "https://landing.test/start",
                    AccessPolicy(max_concurrency=1),
                    cancel_event=cancelled,
                )
            )
        )
        worker.start()
        for _ in range(100):
            context = factory.process.context
            if context is not None and context.goto_started.wait(0.01):
                break
            time.sleep(0.01)
        else:
            self.fail("blocking navigation did not start")

        cancelled.set()
        worker.join(1.0)

        self.assertFalse(worker.is_alive())
        self.assertEqual(_failure(result_holder[0]).code, "cleanup")
        context = factory.process.context
        self.assertIsNotNone(context)
        assert context is not None
        self.assertTrue(context.closed)
        self.assertEqual(context.close_calls, 1)
        self.assertEqual(context.pages[0].close_calls, 1)
        self.assertTrue(factory.process.closed)
        self.assertEqual(factory.process.close_calls, 1)
        permit = coordinator.acquire_scope(self.scope, timeout=0.1)
        permit.release()

    def test_route_abort_failure_retains_admission_until_cleanup(self) -> None:
        coordinator = AccessCoordinator()
        factory = _FakeFactory()
        client = BrowserClient(
            factory=factory,
            resolver=self.resolver,
            coordinator=coordinator,
            destination_policy=_PUBLIC_POLICY,
        )

        with (
            mock.patch.object(
                _FakeRoute,
                "continue_",
                side_effect=RuntimeError("route continuation sentinel"),
            ),
            mock.patch.object(
                _FakeRoute,
                "abort",
                side_effect=RuntimeError("route abort sentinel"),
            ),
        ):
            result = _failure(
                client.run(
                    self.scope,
                    "https://landing.test/start",
                    AccessPolicy(max_concurrency=1),
                )
            )

        self.assertEqual(result.code, "cleanup")
        self.assertEqual(factory.process.context.close_calls, 1)  # type: ignore[union-attr]
        self.assertEqual(factory.process.close_calls, 1)
        permit = coordinator.acquire_scope(self.scope, timeout=0.1)
        permit.release()

    def test_unacknowledged_top_frame_policy_abort_retires_shared_session(self) -> None:
        class _UnacknowledgedRoute(_FakeRoute):
            def __init__(self, request: _FakeRequest) -> None:
                super().__init__(request)
                self.abort_calls = 0

            def abort(self) -> None:
                self.abort_calls += 1
                raise RuntimeError("route abort sentinel")

        factory = _RotatingFakeFactory()
        broker = BrowserSessionBroker()
        self.addCleanup(broker.close)
        client = BrowserClient(
            factory=factory,
            resolver=self.resolver,
            coordinator=AccessCoordinator(),
            destination_policy=_PUBLIC_POLICY,
            session_broker=broker,
        )
        guard = _OriginGuard(
            "https://landing.test",
            "https://download.test",
        )
        rejected_routes: list[_UnacknowledgedRoute] = []

        def flow(session: object) -> None:
            del session
            context = factory.processes[0].context
            self.assertIsNotNone(context)
            assert context is not None
            page = context.pages[0]
            route = _UnacknowledgedRoute(
                _FakeRequest(
                    "https://other.test/unapproved",
                    page,
                    navigation=True,
                    top_frame=True,
                )
            )
            self.assertIsNotNone(context.route_handler)
            assert context.route_handler is not None
            context.route_handler(route)
            rejected_routes.append(route)

        first = _failure(
            client.run(
                self.scope,
                "https://landing.test/first",
                AccessPolicy(max_concurrency=1),
                controller=_FlowController(flow),
                destination_guard=guard,
                session_key="fixture-publisher",
            )
        )

        self.assertEqual(first.code, "cleanup")
        self.assertEqual(len(rejected_routes), 1)
        self.assertEqual(rejected_routes[0].abort_calls, 1)
        self.assertEqual(len(factory.processes), 1)
        self.assertTrue(factory.processes[0].closed)

        second = _download(
            client.run(
                self.scope,
                "https://landing.test/second",
                AccessPolicy(max_concurrency=1),
                destination_guard=guard,
                session_key="fixture-publisher",
            )
        )

        self.assertEqual(second.chunks, (b"%PDF-persistent-fixture",))
        self.assertEqual(len(factory.processes), 2)
        self.assertFalse(factory.processes[1].closed)

    def test_shared_session_reuses_context_but_isolates_article_resources(self) -> None:
        factory = _FakeFactory(
            configured_download=_FakeDownload(
                "https://download.test/article.pdf",
                b"%PDF-persistent-fixture",
            )
        )
        broker = BrowserSessionBroker()
        self.addCleanup(broker.close)
        client = BrowserClient(
            factory=factory,
            resolver=self.resolver,
            coordinator=AccessCoordinator(),
            destination_policy=_PUBLIC_POLICY,
            session_broker=broker,
        )
        policy = AccessPolicy(max_concurrency=1)

        first = _download(
            client.run(
                self.scope,
                "https://landing.test/first",
                policy,
                session_key="fixture-publisher",
            )
        )
        second = _download(
            client.run(
                self.scope,
                "https://landing.test/second",
                policy,
                session_key="fixture-publisher",
            )
        )

        self.assertEqual(first.chunks, (b"%PDF-persistent-fixture",))
        self.assertEqual(second.chunks, (b"%PDF-persistent-fixture",))
        self.assertEqual(factory.events.count("process-enter"), 1)
        self.assertEqual(factory.events.count("context-create"), 1)
        self.assertEqual(factory.events.count("route:**/*"), 2)
        context = factory.process.context
        self.assertIsNotNone(context)
        assert context is not None
        self.assertFalse(context.closed)
        self.assertFalse(factory.process.closed)
        self.assertFalse(context.article_active)
        self.assertEqual(context.article_lanes, ["fixture-publisher"] * 2)
        self.assertIsNone(context.route_handler)
        self.assertEqual(context.handlers, {})
        self.assertEqual(len(context.article_paths), 2)
        self.assertNotEqual(context.article_paths[0], context.article_paths[1])
        self.assertTrue(all(not Path(path).exists() for path in context.article_paths))
        self.assertEqual(len(context.article_bindings), 2)
        self.assertIsNot(context.article_bindings[0], context.article_bindings[1])
        self.assertEqual(len(context.pages), 2)
        self.assertTrue(all(page.closed for page in context.pages))

        session_path = factory.downloads_path
        self.assertIsNotNone(session_path)
        assert session_path is not None
        self.assertTrue(Path(session_path).is_dir())
        broker.close()
        self.assertTrue(context.closed)
        self.assertTrue(factory.process.closed)
        self.assertFalse(Path(session_path).exists())

    def test_operation_local_session_configuration_is_explicit_and_closed(self) -> None:
        resolver = _Resolver({"landing.test": ("93.184.216.34",)})
        factory = _FakeFactory()
        broker = BrowserSessionBroker()
        self.addCleanup(broker.close)
        operation_local = BrowserClient(
            factory=factory,
            resolver=resolver,
            coordinator=AccessCoordinator(),
            destination_policy=_PUBLIC_POLICY,
            session_broker=broker,
        )
        ephemeral = BrowserClient(
            factory=factory,
            resolver=resolver,
            coordinator=AccessCoordinator(),
            destination_policy=_PUBLIC_POLICY,
        )
        policy = AccessPolicy(max_concurrency=1)

        self.assertEqual(
            _failure(operation_local.run(self.scope, "https://landing.test/start", policy)).code,
            "policy",
        )
        self.assertEqual(
            _failure(
                ephemeral.run(
                    self.scope,
                    "https://landing.test/start",
                    policy,
                    session_key="fixture-publisher",
                )
            ).code,
            "policy",
        )
        self.assertEqual(
            _failure(
                operation_local.run(
                    self.scope,
                    "https://landing.test/start",
                    policy,
                    session_key="publisher-token",
                )
            ).code,
            "policy",
        )
        self.assertEqual(resolver.calls, [])
        self.assertEqual(factory.events, [])

    def test_runtime_failure_retires_shared_session_before_retry(self) -> None:
        factory = _RotatingFakeFactory(fail_first_navigation=True)
        broker = BrowserSessionBroker()
        self.addCleanup(broker.close)
        client = BrowserClient(
            factory=factory,
            resolver=self.resolver,
            coordinator=AccessCoordinator(),
            destination_policy=_PUBLIC_POLICY,
            session_broker=broker,
        )
        policy = AccessPolicy(max_concurrency=1)

        first = _failure(
            client.run(
                self.scope,
                "https://landing.test/first",
                policy,
                session_key="fixture-publisher",
            )
        )
        self.assertEqual(first.code, "runtime")
        self.assertEqual(len(factory.processes), 1)
        self.assertTrue(factory.processes[0].closed)
        self.assertIsNotNone(factory.processes[0].context)
        assert factory.processes[0].context is not None
        self.assertTrue(factory.processes[0].context.closed)

        second = _download(
            client.run(
                self.scope,
                "https://landing.test/second",
                policy,
                session_key="fixture-publisher",
            )
        )
        self.assertEqual(second.chunks, (b"%PDF-persistent-fixture",))
        self.assertEqual(len(factory.processes), 2)
        self.assertFalse(factory.processes[1].closed)


class BrowserLateDownloadCorrelationTests(unittest.TestCase):
    """Network-only proofs for late native Download correlation."""

    _LOCATOR = "https://download.test/article.pdf"
    _OTHER_LOCATOR = "https://download.test/other.pdf"

    def _state(self, locator: str) -> tuple[_FlowState, ResolvedDestination]:
        destination = ResolvedDestination(
            url=normalize_url(locator),
            addresses=("93.184.216.34",),
            classes=(AddressClass.PUBLIC,),
        )
        payload = b"%PDF-fixture"
        coordinator = AccessCoordinator()
        scope = AccessScope("fixture-provider", "web")
        permit = coordinator.acquire_scope(scope, AccessPolicy(max_concurrency=1))
        self.addCleanup(permit.release)
        state = _FlowState(
            scope_permit=permit,
            host_policy=AccessPolicy(max_concurrency=1),
            resolver=_Resolver({"download.test": ("93.184.216.34",)}),
            destination_policy=_PUBLIC_POLICY,
            destination_guard=None,
            capture_guard=None,
            navigation_only=False,
            discard_unapproved_subresources=False,
            limits=BrowserOperationLimits(),
            clock=lambda: 0.0,
            operation_timeout_seconds=60.0,
            cancel_event=None,
            cleanup_timeout_seconds=5.0,
        )
        state.captures = [
            BrowserCapture(
                kind=BrowserCaptureKind.RESPONSE,
                stream=BoundedByteStream(
                    chunks=(payload,),
                    media_type="application/pdf",
                    final_locator=locator,
                    size=len(payload),
                ),
            )
        ]
        return state, destination

    @staticmethod
    def _plan(
        state: _FlowState,
        download: _DownloadProbe,
    ) -> _DownloadCapturePlan | None:
        client = object.__new__(BrowserClient)
        return BrowserClient._network_download_capture_plan(
            client,
            state,
            download,
            download.url,
        )

    def test_late_duplicate_download_without_request_is_discarded_without_body(self) -> None:
        state, _ = self._state(self._LOCATOR)
        download = _DownloadProbe(self._LOCATOR)
        plan = self._plan(state, download)
        self.assertIsNone(plan)
        self.assertEqual(download.body_reads, 0)
        self.assertEqual(len(state.captures), 1)

    def test_late_duplicate_download_with_unassociated_request_fails_closed(self) -> None:
        state, _ = self._state(self._LOCATOR)
        download = _DownloadProbe(self._LOCATOR, request=object())
        with self.assertRaises(_Abort) as raised:
            self._plan(state, download)
        self.assertEqual(raised.exception.code, "runtime")
        self.assertEqual(len(state.captures), 1)
        self.assertEqual(download.body_reads, 0)

    def test_late_download_with_different_locator_fails_closed(self) -> None:
        state, _ = self._state(self._LOCATOR)
        download = _DownloadProbe(self._OTHER_LOCATOR)
        with self.assertRaises(_Abort) as raised:
            self._plan(state, download)
        self.assertEqual(raised.exception.code, "runtime")
        self.assertEqual(download.body_reads, 0)

    def test_late_duplicate_with_pending_request_uses_correlation(self) -> None:
        state, destination = self._state(self._LOCATOR)
        request = object()
        lease = _RequestLease(
            request=request,
            page=None,
            destination=destination,
            navigation=False,
        )
        pending = _PendingResponseDownload(
            lease=lease,
            kind=BrowserCaptureKind.RESPONSE,
            media_type="application/pdf",
            capture_allowed=True,
        )
        state.pending_response_downloads[destination.url.url] = pending
        state.request_leases[id(request)] = lease
        download = _DownloadProbe(self._LOCATOR)
        plan = self._plan(state, download)
        self.assertIsNotNone(plan)
        assert plan is not None
        self.assertIs(plan.request, request)
        self.assertEqual(download.body_reads, 0)


if __name__ == "__main__":
    unittest.main()
