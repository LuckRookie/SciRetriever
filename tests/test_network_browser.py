from __future__ import annotations

import threading
import time
import unittest
from pathlib import Path
from typing import Callable, Iterable, cast
from urllib.parse import urlsplit

from sciretriever.model.access import AccessFailure, BoundedByteStream
from sciretriever.network.admission import (
    AccessCoordinator,
    AccessPermit,
    AccessPolicy,
    AccessScope,
    HostPermit,
)
from sciretriever.network.browser import (
    BrowserBudget,
    BrowserClient,
    BrowserDestinationKind,
    BrowserPageObservation,
)
from sciretriever.network.browser_sessions import BrowserSessionBroker
from sciretriever.network.policy import AddressClass, DestinationPolicy

_PUBLIC_POLICY = DestinationPolicy(allowed_classes=frozenset({AddressClass.PUBLIC}))


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


class _RecordingCoordinator(AccessCoordinator):
    def __init__(self, *args: object, **kwargs: object) -> None:
        super().__init__(*args, **kwargs)  # type: ignore[arg-type]
        self.hosts: list[str] = []

    def _acquire_host(
        self,
        owner: AccessPermit,
        host: str,
        *,
        cancel_event: threading.Event | None,
        timeout: float | None,
    ) -> HostPermit:
        self.hosts.append(host)
        return super()._acquire_host(
            owner,
            host,
            cancel_event=cancel_event,
            timeout=timeout,
        )


class _FakeRequest:
    def __init__(self, url: str, page: _FakePage, *, navigation: bool) -> None:
        self.url = url
        self.page = page
        self._navigation = navigation
        self.resource_type = "document" if navigation else "image"

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


class _FakeResponse:
    def __init__(self, request: _FakeRequest, status: int = 200) -> None:
        self.request = request
        self.url = request.url
        self.status = status


class _FakeDownload:
    def __init__(self, url: str, body: bytes, media_type: str = "application/pdf") -> None:
        self.url = url
        self.body = body
        self.media_type = media_type
        self.deleted = False
        self.request: _FakeRequest | None = None

    def content(self) -> bytes:
        return self.body

    def delete(self) -> None:
        self.deleted = True


class _FakePage:
    def __init__(self, context: _FakeContext, *, url: str = "") -> None:
        self.context = context
        self.url = url
        self.challenge = False
        self.closed = False
        self.goto_error: BaseException | None = None
        self.abort_event = threading.Event()

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
                self.context.emit_configured_download(self)
                return _FakeResponse(route.request, self.context.navigation_status)
            current = redirect

    def open_popup(self, url: str) -> _FakePage:
        return self.context.popup(url)

    def emit_download(self, download: _FakeDownload) -> None:
        self.context.download(download)

    def title(self) -> str:
        return "verify you are human" if self.challenge else "fixture"

    def content(self) -> str:
        return ""

    def close(self) -> None:
        self.closed = True
        self.context.events.append("page-close")

    def abort(self) -> None:
        self.abort_event.set()

    def click(self, selector: str, *, timeout: int) -> None:
        del selector, timeout

    def fill(self, selector: str, value: str, *, timeout: int) -> None:
        del selector, value, timeout

    def text_content(self, selector: str, *, timeout: int) -> str:
        del timeout
        return selector


class _FakeContext:
    def __init__(
        self,
        *,
        events: list[str],
        redirects: dict[str, str] | None = None,
        close_error: BaseException | None = None,
        goto_error: BaseException | None = None,
        configured_download: _FakeDownload | None = None,
        challenge: bool = False,
        subresources: tuple[str, ...] = (),
        blocking_goto: bool = False,
        navigation_status: int = 200,
    ) -> None:
        self.events = events
        self.redirects = {} if redirects is None else redirects
        self.close_error = close_error
        self.goto_error = goto_error
        self.configured_download = configured_download
        self.challenge = challenge
        self.subresources = subresources
        self.blocking_goto = blocking_goto
        self.navigation_status = navigation_status
        self.goto_started = threading.Event()
        self.first_subresource_continued = threading.Event()
        self.second_subresource_continued = threading.Event()
        self.release_first_subresource = threading.Event()
        self.configured_download_emitted = False
        self.pages: list[_FakePage] = []
        self.route_handler: Callable[[_FakeRoute], object] | None = None
        self.handlers: dict[str, list[Callable[[object], object]]] = {}
        self.closed = False
        self.binding: object | None = None
        self.bindings: list[object] = []
        self.article_paths: list[str] = []
        self.article_bindings: list[object] = []
        self.article_active = False

    def bind_connection(self, binding: object) -> object:
        self.binding = binding
        self.bindings.append(binding)
        return binding

    def begin_article(self, *, downloads_path: str, connection_binding: object) -> object:
        if self.article_active:
            raise RuntimeError("overlapping article sentinel")
        self.article_active = True
        self.article_paths.append(downloads_path)
        self.article_bindings.append(connection_binding)
        self.configured_download_emitted = False
        return connection_binding

    def end_article(self) -> bool:
        if not self.article_active:
            raise RuntimeError("article was not active")
        self.article_active = False
        return True

    def route(self, pattern: str, handler: Callable[[_FakeRoute], object]) -> None:
        self.events.append(f"route:{pattern}")
        self.route_handler = handler

    def on(self, event: str, handler: Callable[[object], object]) -> None:
        self.handlers.setdefault(event, []).append(handler)

    def new_page(self) -> _FakePage:
        page = _FakePage(self)
        page.goto_error = self.goto_error
        page.challenge = self.challenge
        self.pages.append(page)
        return page

    def request(self, url: str, page: _FakePage, *, navigation: bool) -> _FakeRoute:
        route = _FakeRoute(_FakeRequest(url, page, navigation=navigation))
        if self.route_handler is None:
            raise AssertionError("route handler was not installed")
        self.route_handler(route)
        if route.continued:
            response = _FakeResponse(route.request)
            for handler in self.handlers.get("response", ()):
                handler(response)
        if route.continued and navigation:
            for handler in self.handlers.get("requestfinished", ()):
                handler(route.request)
        return route

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

    def emit_subresources(self, page: _FakePage) -> None:
        if not self.subresources:
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
        self.events.append("context-close")
        self.closed = True
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
        subresources: tuple[str, ...] = (),
        blocking_goto: bool = False,
        navigation_status: int = 200,
    ) -> None:
        self.events = events
        self.redirects = redirects
        self.close_error = close_error
        self.context_close_error = context_close_error
        self.goto_error = goto_error
        self.configured_download = configured_download
        self.challenge = False
        self.subresources = subresources
        self.blocking_goto = blocking_goto
        self.navigation_status = navigation_status
        self.context: _FakeContext | None = None
        self.profile: object | None = None
        self.downloads_path: str | None = None
        self.closed = False
        self.binding: object | None = None
        self.bindings: list[object] = []

    def bind_connection(self, binding: object) -> object:
        self.binding = binding
        self.bindings.append(binding)
        return binding

    def __enter__(self) -> _FakeProcess:
        self.events.append("process-enter")
        return self

    def __exit__(self, exc_type: object, exc_value: object, traceback: object) -> bool:
        del exc_type, exc_value, traceback
        self.close()
        self.events.append("process-exit")
        return False

    def new_context(
        self,
        *,
        profile: object | None,
        downloads_path: str,
        accept_downloads: bool,
        connection_binding: object,
    ) -> _FakeContext:
        if not accept_downloads:
            raise AssertionError("downloads must be explicitly enabled")
        self.profile = profile
        self.downloads_path = downloads_path
        self.events.append("context-create")
        self.context = _FakeContext(
            events=self.events,
            redirects=self.redirects,
            close_error=self.context_close_error,
            goto_error=self.goto_error,
            configured_download=self.configured_download,
            challenge=self.challenge,
            subresources=self.subresources,
            blocking_goto=self.blocking_goto,
            navigation_status=self.navigation_status,
        )
        self.context.bind_connection(connection_binding)
        return self.context

    def close(self) -> None:
        if self.closed:
            return
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
        subresources: tuple[str, ...] = (),
        blocking_goto: bool = False,
        navigation_status: int = 200,
    ) -> None:
        self.events: list[str] = []
        self.profile: object | None = None
        self.downloads_path: str | None = None
        self.process = _FakeProcess(
            events=self.events,
            redirects=redirects,
            close_error=process_close_error,
            context_close_error=context_close_error,
            goto_error=goto_error,
            configured_download=configured_download,
            subresources=subresources,
            blocking_goto=blocking_goto,
            navigation_status=navigation_status,
        )
        self.context_close_error = context_close_error
        self.binding: object | None = None

    def __call__(
        self,
        *,
        profile: object | None,
        downloads_path: str,
        connection_binding: object,
    ) -> _FakeProcess:
        self.profile = profile
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
        profile: object | None,
        downloads_path: str,
        connection_binding: object,
    ) -> _FakeProcess:
        del profile, connection_binding
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
    if not isinstance(value, BoundedByteStream):
        raise AssertionError(f"expected download, got {type(value).__name__}")
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
            operator_profile=object(),
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
            operator_profile=object(),
        )

        result = _download(
            self.client.run(
                self.scope,
                "https://landing.test/start",
                self.policy,
                flow=flow,
            )
        )
        self.assertEqual(result.chunks, (b"fixture",))
        self.assertEqual(result.size, 7)
        self.assertEqual(result.final_locator, "https://download.test/file")
        self.assertNotIn("sentinel", repr(result))
        self.assertEqual(self.factory.profile, self.client.operator_profile)
        self.assertNotIn("fixture", repr(self.factory.profile))
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
                        flow=flow,
                        destination_guard=guard,
                    )
                )

                self.assertEqual(result.code, "policy")
                self.assertNotIn("other.test", resolver.calls)
                self.assertIn(
                    (expected_url, expected_kind),
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
                flow=lambda session: session.open_popup(  # type: ignore[attr-defined]
                    "https://popup.test/viewer"
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

    def test_download_oversize_and_popup_budget_fail_closed(self) -> None:
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
                flow=oversized,
                budget=BrowserBudget(max_bytes_per_download=4),
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
                flow=popup_storm,
                budget=BrowserBudget(max_popups=1),
            )
        )
        self.assertEqual(storm_result.code, "budget")

    def test_cancel_timeout_and_challenge_never_return_late_download(self) -> None:
        cancelled = threading.Event()

        def cancel_flow(session: object) -> None:
            del session
            cancelled.set()

        cancelled_result = _failure(
            self.client.run(
                self.scope,
                "https://landing.test/start",
                self.policy,
                flow=cancel_flow,
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

        challenge_factory = _FakeFactory()
        challenge_client = BrowserClient(
            factory=challenge_factory,
            resolver=self.resolver,
            coordinator=AccessCoordinator(),
            destination_policy=_PUBLIC_POLICY,
        )

        challenge_factory.process.challenge = True

        def challenge_flow(session: object) -> None:
            del session

        challenge_result = _failure(
            challenge_client.run(
                self.scope,
                "https://landing.test/start",
                self.policy,
                flow=challenge_flow,
            )
        )
        self.assertEqual(challenge_result.code, "challenge")

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
            self.assertIsNone(session.click("#download"))  # type: ignore[attr-defined]
            self.assertIsNone(session.fill("#query", "fixture"))  # type: ignore[attr-defined]
            self.assertEqual(session.text("#title"), "#title")  # type: ignore[attr-defined]
            observation = cast(BrowserPageObservation, getattr(session, "observe")())
            self.assertEqual(observation.locator, "https://landing.test/start")
            self.assertEqual(observation.status_code, 200)
            self.assertEqual(observation.origin, "https://landing.test")
            self.assertEqual(observation.path, "/start")

        result = _download(
            client.run(self.scope, "https://landing.test/start", self.policy, flow=flow)
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
                flow=flow,
            )
        )

        self.assertEqual(result.code, "no-download")
        self.assertEqual(len(observations), 1)
        self.assertEqual(observations[0].status_code, 403)

    def test_subresource_host_permit_is_held_until_request_finished(self) -> None:
        factory = _FakeFactory(
            subresources=(
                "https://landing.test/one.png",
                "https://landing.test/two.png",
            )
        )
        client = BrowserClient(
            factory=factory,
            resolver=self.resolver,
            coordinator=AccessCoordinator(),
            destination_policy=_PUBLIC_POLICY,
        )
        policy = AccessPolicy(max_concurrency=1)
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
        self.assertFalse(context.second_subresource_continued.wait(0.05))
        context.release_first_subresource.set()
        self.assertTrue(context.second_subresource_continued.wait(1.0))
        worker.join(2.0)
        self.assertFalse(worker.is_alive())
        self.assertEqual(_failure(result_holder[0]).code, "no-download")

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

    def test_persistent_session_reuses_context_but_isolates_article_resources(self) -> None:
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
            operator_profile=self.client.operator_profile,
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
        self.assertEqual(factory.events.count("route:**/*"), 1)
        context = factory.process.context
        self.assertIsNotNone(context)
        assert context is not None
        self.assertFalse(context.closed)
        self.assertFalse(factory.process.closed)
        self.assertFalse(context.article_active)
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

    def test_persistent_session_configuration_is_explicit_and_closed(self) -> None:
        resolver = _Resolver({"landing.test": ("93.184.216.34",)})
        factory = _FakeFactory()
        broker = BrowserSessionBroker()
        self.addCleanup(broker.close)
        persistent = BrowserClient(
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
            _failure(persistent.run(self.scope, "https://landing.test/start", policy)).code,
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
                persistent.run(
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

    def test_runtime_failure_retires_persistent_session_before_retry(self) -> None:
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


if __name__ == "__main__":
    unittest.main()
