from __future__ import annotations

import ast
import os
import re
import sqlite3
import stat
import tempfile
import threading
import time
import unittest
from collections.abc import Callable, Iterable
from pathlib import Path
from typing import cast
from unittest import mock

from sciretriever.model.access import (
    AccessFailure,
    BoundedByteStream,
    BrowserCaptureBatch,
    BrowserCaptureKind,
    TransportRequest,
    TransportResponse,
)
from sciretriever.model.primitives import RelativeArtifactPath, sha256_digest
from sciretriever.network.admission import (
    AccessCoordinator,
    AccessPolicy,
    AccessScope,
    AdmissionTimeout,
)
from sciretriever.network.browser import BrowserClient
from sciretriever.network.http import HttpClient
from sciretriever.network.policy import AddressClass, DestinationPolicy, ResolvedDestination
from sciretriever.storage.files import output as output_module
from sciretriever.storage.files.output import write_atomic
from sciretriever.storage.files.paths import StorageRoot
from sciretriever.storage.files.reader import VerifiedReader, VerifiedReaderError
from sciretriever.storage.files.store import ArtifactReference, ArtifactStore, ArtifactStoreError
from sciretriever.storage.locking import CatalogLockConflictError, CatalogWriteLock
from sciretriever.storage.sqlite import artifacts as artifact_helpers
from sciretriever.storage.sqlite.artifacts import (
    ArtifactCatalogError,
    ArtifactObject,
    get_artifact,
    register_artifact,
)
from sciretriever.storage.sqlite.engine import CatalogEngine

_PUBLIC_POLICY = DestinationPolicy(allowed_classes=frozenset({AddressClass.PUBLIC}))
_WEB_POLICY = AccessPolicy(
    max_concurrency=1,
    cooldown_after_completion=30.0,
)


class _FakeClock:
    def __init__(self) -> None:
        self.value = 0.0
        self.coordinator: AccessCoordinator | None = None

    def __call__(self) -> float:
        return self.value

    def advance(self, seconds: float) -> None:
        self.value += seconds
        if self.coordinator is not None:
            self.coordinator.wake()


class _FakeResolver:
    def __init__(self, addresses: dict[str, tuple[str, ...]]) -> None:
        self.addresses = addresses
        self.calls: list[str] = []

    def resolve(self, hostname: str) -> Iterable[str]:
        self.calls.append(hostname)
        return self.addresses[hostname]


class _RawResponse:
    def __init__(
        self,
        *,
        status: int = 200,
        headers: tuple[tuple[str, str], ...] = (),
        body: bytes = b"http-body",
    ) -> None:
        self.status = status
        self.headers = headers
        self.body = body
        self.closed = False

    def close(self) -> None:
        self.closed = True


class _FakeTransport:
    def __init__(self, *, entered: threading.Event | None = None) -> None:
        self.entered = entered
        self.release = threading.Event()
        self.calls: list[tuple[TransportRequest, ResolvedDestination]] = []
        self.responses: list[_RawResponse] = []

    def send(
        self,
        request: TransportRequest,
        destination: ResolvedDestination,
        *,
        headers: tuple[tuple[str, str], ...],
        request_target_renderer: object,
        connect_timeout_seconds: float,
        read_timeout_seconds: float,
        tls_server_hostname: str | None,
        cancel_event: threading.Event | None,
    ) -> _RawResponse:
        del (
            headers,
            request_target_renderer,
            connect_timeout_seconds,
            read_timeout_seconds,
            tls_server_hostname,
            cancel_event,
        )
        self.calls.append((request, destination))
        if self.entered is not None:
            self.entered.set()
            self.release.wait(2.0)
        response = _RawResponse()
        self.responses.append(response)
        return response

    def close(self) -> None:
        return None


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
        self.aborted = False
        self.continued = False
        self.binding: object | None = None

    def bind_connection(self, binding: object) -> object:
        self.binding = binding
        return binding

    def continue_(self) -> None:
        self.continued = True

    def abort(self) -> None:
        self.aborted = True


class _FakeDownload:
    def __init__(self, url: str, body: bytes) -> None:
        self.url = url
        self.body = body
        self.media_type = "application/pdf"
        self.deleted = False
        self.request: _FakeRequest | None = None

    def content(self) -> bytes:
        return self.body

    def delete(self) -> None:
        self.deleted = True


class _FakePage:
    def __init__(self, context: _FakeContext) -> None:
        self.context = context
        self.url = ""
        self.closed = False
        self.abort_event = threading.Event()

    def goto(self, url: str, *, timeout: int) -> None:
        del timeout
        route = self.context.request(url, self, navigation=True)
        if route.aborted:
            raise RuntimeError("navigation rejected")
        self.url = url
        if self.context.blocking_goto:
            self.context.goto_started.set()
            self.abort_event.wait(2.0)
        self.context.emit_configured_download(self)

    def open_popup(self, url: str) -> _FakePage:
        return self.context.popup(url)

    def close(self) -> None:
        self.closed = True

    def abort(self) -> None:
        self.abort_event.set()

    def click(self, selector: str, *, timeout: int) -> None:
        del selector, timeout

    def fill(self, selector: str, value: str, *, timeout: int) -> None:
        del selector, value, timeout

    def text_content(self, selector: str, *, timeout: int) -> str:
        del timeout
        return selector

    def title(self) -> str:
        return "fixture"

    def content(self) -> str:
        return ""


class _FakeContext:
    def __init__(
        self,
        process: _FakeProcess,
        *,
        configured_download: _FakeDownload | None = None,
        blocking_goto: bool = False,
        hold_request_finished: bool = False,
    ) -> None:
        self.process = process
        self.pages: list[_FakePage] = []
        self.route_handler: Callable[[_FakeRoute], object] | None = None
        self.handlers: dict[str, list[Callable[[object], object]]] = {}
        self.downloads: list[_FakeDownload] = []
        self.configured_download = configured_download
        self.configured_download_emitted = False
        self.blocking_goto = blocking_goto
        self.hold_request_finished = hold_request_finished
        self.request_continued = threading.Event()
        self.request_finished_gate = threading.Event()
        self.goto_started = threading.Event()
        self.binding: object | None = None
        self.closed = False

    def bind_connection(self, binding: object) -> object:
        self.binding = binding
        return binding

    def route(self, pattern: str, handler: Callable[[_FakeRoute], object]) -> None:
        del pattern
        self.route_handler = handler

    def on(self, event: str, handler: Callable[[object], object]) -> None:
        self.handlers.setdefault(event, []).append(handler)

    def new_page(self) -> _FakePage:
        page = _FakePage(self)
        self.pages.append(page)
        return page

    def request(self, url: str, page: _FakePage, *, navigation: bool) -> _FakeRoute:
        if self.route_handler is None:
            raise RuntimeError("route handler missing")
        route = _FakeRoute(_FakeRequest(url, page, navigation=navigation))
        self.route_handler(route)
        if route.continued and navigation:
            if self.hold_request_finished:
                self.request_continued.set()
                self.request_finished_gate.wait(2.0)
            for handler in self.handlers.get("requestfinished", ()):
                handler(route.request)
        return route

    def popup(self, url: str) -> _FakePage:
        page = self.new_page()
        for handler in self.handlers.get("page", ()):
            handler(page)
        route = self.request(url, page, navigation=True)
        if route.aborted:
            raise RuntimeError("popup rejected")
        page.url = url
        return page

    def emit_download(self, download: _FakeDownload) -> None:
        self.downloads.append(download)
        for handler in self.handlers.get("download", ()):
            handler(download)

    def emit_configured_download(self, page: _FakePage) -> None:
        if self.configured_download is None or self.configured_download_emitted:
            return
        self.configured_download_emitted = True
        route = self.request(self.configured_download.url, page, navigation=False)
        if route.aborted:
            return
        self.configured_download.request = route.request
        self.emit_download(self.configured_download)
        if route.continued:
            for handler in self.handlers.get("requestfinished", ()):
                handler(route.request)

    def close(self) -> None:
        self.closed = True


class _FakeProcess:
    def __init__(
        self,
        *,
        configured_download: _FakeDownload | None = None,
        blocking_goto: bool = False,
        hold_request_finished: bool = False,
    ) -> None:
        self.context: _FakeContext | None = None
        self.configured_download = configured_download
        self.blocking_goto = blocking_goto
        self.hold_request_finished = hold_request_finished
        self.downloads_path: str | None = None
        self.closed = False
        self.binding: object | None = None

    def bind_connection(self, binding: object) -> object:
        self.binding = binding
        return binding

    def __enter__(self) -> _FakeProcess:
        return self

    def __exit__(self, exc_type: object, exc_value: object, traceback: object) -> bool:
        del exc_type, exc_value, traceback
        self.close()
        return False

    def new_context(
        self,
        *,
        downloads_path: str,
        accept_downloads: bool,
        connection_binding: object,
    ) -> _FakeContext:
        if not accept_downloads:
            raise RuntimeError("downloads must be enabled")
        self.downloads_path = downloads_path
        self.context = _FakeContext(
            self,
            configured_download=self.configured_download,
            blocking_goto=self.blocking_goto,
            hold_request_finished=self.hold_request_finished,
        )
        self.context.bind_connection(connection_binding)
        return self.context

    def close(self) -> None:
        self.closed = True


class _FakeBrowserFactory:
    def __init__(
        self,
        *,
        configured_download: _FakeDownload | None = None,
        blocking_goto: bool = False,
        hold_request_finished: bool = False,
    ) -> None:
        self.processes: list[_FakeProcess] = []
        self.configured_download = configured_download
        self.blocking_goto = blocking_goto
        self.hold_request_finished = hold_request_finished

    def __call__(
        self,
        *,
        downloads_path: str,
        connection_binding: object,
    ) -> _FakeProcess:
        del downloads_path
        process = _FakeProcess(
            configured_download=self.configured_download,
            blocking_goto=self.blocking_goto,
            hold_request_finished=self.hold_request_finished,
        )
        process.bind_connection(connection_binding)
        self.processes.append(process)
        return process


def _failure(value: object) -> AccessFailure:
    if not isinstance(value, AccessFailure):
        raise AssertionError(f"expected AccessFailure, got {type(value).__name__}")
    return value


def _stream(value: object) -> BoundedByteStream:
    if not isinstance(value, BoundedByteStream):
        raise AssertionError(f"expected BoundedByteStream, got {type(value).__name__}")
    return value


def _browser_download(value: object) -> BoundedByteStream:
    if not isinstance(value, BrowserCaptureBatch) or len(value.captures) != 1:
        raise AssertionError(f"expected one Browser capture, got {type(value).__name__}")
    capture = value.captures[0]
    if capture.kind is not BrowserCaptureKind.DOWNLOAD:
        raise AssertionError(f"expected Browser download, got {capture.kind.value}")
    return capture.stream


def _declared_port_classes(tree: ast.AST) -> tuple[str, ...]:
    return tuple(
        node.name
        for node in ast.walk(tree)
        if isinstance(node, ast.ClassDef) and node.name.endswith("Port")
    )


class NetworkStorageFoundationTests(unittest.TestCase):
    def test_package_markers_have_no_imports_calls_or_public_reexports(self) -> None:
        package_paths = (
            Path(__file__).parents[1] / "src/sciretriever/network/__init__.py",
            Path(__file__).parents[1] / "src/sciretriever/storage/__init__.py",
            Path(__file__).parents[1] / "src/sciretriever/storage/files/__init__.py",
            Path(__file__).parents[1] / "src/sciretriever/storage/sqlite/__init__.py",
        )
        for path in package_paths:
            tree = ast.parse(path.read_text(encoding="utf-8"))
            self.assertFalse(
                any(isinstance(node, (ast.Import, ast.ImportFrom)) for node in ast.walk(tree)),
                path,
            )
            self.assertFalse(any(isinstance(node, ast.Call) for node in ast.walk(tree)), path)

        import importlib

        for module_name in (
            "sciretriever.network",
            "sciretriever.storage",
            "sciretriever.storage.files",
            "sciretriever.storage.sqlite",
        ):
            module = importlib.import_module(module_name)
            self.assertEqual(getattr(module, "__all__"), ())
            self.assertFalse(
                any(
                    name in vars(module)
                    for name in (
                        "HttpClient",
                        "BrowserClient",
                        "CatalogEngine",
                        "CatalogWriteLock",
                        "ArtifactStore",
                    )
                )
            )

    def test_port_ownership_check_distinguishes_definitions_from_adapters(self) -> None:
        tree = ast.parse(
            """
from typing import Protocol
from sciretriever.analysis.ports import AnalysisArtifactPublicationPort

class AnalysisArtifactPublisher:
    pass

class Resolver(Protocol):
    pass

class _Transport(Protocol):
    pass

class MisownedAnalysisArtifactPort(Protocol):
    pass
"""
        )

        self.assertEqual(
            _declared_port_classes(tree),
            ("MisownedAnalysisArtifactPort",),
        )

    def test_production_boundaries_have_no_cross_module_business_or_sql_leaks(self) -> None:
        source_root = Path(__file__).parents[1] / "src/sciretriever"
        network_root = source_root / "network"
        storage_root = source_root / "storage"
        production_files = tuple(network_root.rglob("*.py")) + tuple(storage_root.rglob("*.py"))
        revoked_legacy_terms = (
            "Collection",
            "BatchRun",
            "DocumentPackage",
            "WorkVersion",
        )
        sql_statement = re.compile(r"^(SELECT|INSERT|UPDATE|DELETE)\b", re.IGNORECASE)
        for path in production_files:
            relative = path.relative_to(source_root).as_posix()
            source = path.read_text(encoding="utf-8")
            self.assertNotIn("tomllib", source)
            self.assertNotIn("infrastructure.", source)
            for term in revoked_legacy_terms:
                self.assertNotIn(term, source, relative)
            tree = ast.parse(source, filename=relative)
            self.assertEqual(_declared_port_classes(tree), (), relative)
            for node in ast.walk(tree):
                if isinstance(node, (ast.Import, ast.ImportFrom)):
                    names = [alias.name for alias in node.names]
                    if any(name == "sqlite3" or name.startswith("sqlite3.") for name in names):
                        self.assertTrue(relative.startswith("storage/sqlite/"), relative)
                if isinstance(node, ast.Constant) and isinstance(node.value, str):
                    text = node.value.strip()
                    if sql_statement.match(text) and any(character.isspace() for character in text):
                        self.assertTrue(relative.startswith("storage/sqlite/"), relative)

        for path in network_root.rglob("*.py"):
            source = path.read_text(encoding="utf-8")
            self.assertNotIn("sqlite3", source)
            self.assertNotIn("credentials.toml", source)

    def test_http_and_browser_share_scope_and_host_admission_without_persistent_state(self) -> None:
        with tempfile.TemporaryDirectory(prefix="sciretriever-t10-network-") as temporary:
            state_root = Path(temporary)
            before = tuple(sorted(path.relative_to(state_root) for path in state_root.rglob("*")))
            resolver = _FakeResolver({"shared.test": ("93.184.216.34",)})
            coordinator = AccessCoordinator()
            entered = threading.Event()
            transport = _FakeTransport(entered=entered)
            http = HttpClient(
                resolver=resolver,
                transport=transport,
                coordinator=coordinator,
                destination_policy=_PUBLIC_POLICY,
                overall_timeout_seconds=1.0,
                max_retries=0,
            )
            scope = AccessScope("fixture-provider", "web")
            http_result: list[TransportResponse | AccessFailure] = []

            worker = threading.Thread(
                target=lambda: http_result.append(
                    http.request(scope, "https://shared.test/start", _WEB_POLICY)
                )
            )
            worker.start()
            self.assertTrue(entered.wait(1.0))

            factory = _FakeBrowserFactory()
            browser = BrowserClient(
                factory=factory,
                resolver=resolver,
                coordinator=coordinator,
                destination_policy=_PUBLIC_POLICY,
                timeout_seconds=0.05,
            )
            blocked = _failure(browser.run(scope, "https://shared.test/start", _WEB_POLICY))
            self.assertEqual(blocked.code, "timeout")
            self.assertEqual(factory.processes, [])

            transport.release.set()
            worker.join(1.0)
            self.assertFalse(worker.is_alive())
            self.assertEqual(len(http_result), 1)
            self.assertIsInstance(http_result[0], TransportResponse)

            after = tuple(sorted(path.relative_to(state_root) for path in state_root.rglob("*")))
            self.assertEqual(before, after)
            self.assertNotIn("fixture-provider", repr(coordinator))
            self.assertNotIn("shared.test", repr(coordinator))

    def test_same_host_is_shared_across_independent_api_and_web_scopes(self) -> None:
        resolver = _FakeResolver({"shared.test": ("93.184.216.34",)})
        coordinator = AccessCoordinator()
        entered = threading.Event()
        transport = _FakeTransport(entered=entered)
        http = HttpClient(
            resolver=resolver,
            transport=transport,
            coordinator=coordinator,
            destination_policy=_PUBLIC_POLICY,
            overall_timeout_seconds=1.0,
            max_retries=0,
        )
        api_scope = AccessScope("api-provider", "api", "metadata")
        web_scope = AccessScope("browser-provider", "web")
        result: list[TransportResponse | AccessFailure] = []
        worker = threading.Thread(
            target=lambda: result.append(
                http.request(api_scope, "https://shared.test/api", AccessPolicy(max_concurrency=1))
            )
        )
        worker.start()
        self.assertTrue(entered.wait(1.0))

        factory = _FakeBrowserFactory()
        browser = BrowserClient(
            factory=factory,
            resolver=resolver,
            coordinator=coordinator,
            destination_policy=_PUBLIC_POLICY,
            timeout_seconds=0.05,
        )
        blocked = _failure(browser.run(web_scope, "https://shared.test/page", _WEB_POLICY))
        self.assertEqual(blocked.code, "timeout")
        transport.release.set()
        worker.join(1.0)
        self.assertFalse(worker.is_alive())
        self.assertEqual(len(result), 1)

    def test_browser_holds_host_permit_until_the_article_flow_finishes(self) -> None:
        resolver = _FakeResolver({"landing.test": ("93.184.216.34",)})
        coordinator = AccessCoordinator()
        factory = _FakeBrowserFactory()
        browser = BrowserClient(
            factory=factory,
            resolver=resolver,
            coordinator=coordinator,
            destination_policy=_PUBLIC_POLICY,
        )
        web_scope = AccessScope("browser-provider", "web")
        api_scope = AccessScope("api-provider", "api", "metadata")
        result_holder: list[object] = []
        article_flow_entered = threading.Event()
        release_article_flow = threading.Event()

        def hold_article_flow(session: object) -> None:
            del session
            article_flow_entered.set()
            release_article_flow.wait(1.0)

        worker = threading.Thread(
            target=lambda: result_holder.append(
                browser.run(
                    web_scope,
                    "https://landing.test/start",
                    _WEB_POLICY,
                    flow=hold_article_flow,
                )
            )
        )
        worker.start()
        self.assertTrue(article_flow_entered.wait(1.0))

        api_permit = coordinator.acquire_scope(api_scope, AccessPolicy(max_concurrency=1))
        try:
            with self.assertRaises(AdmissionTimeout):
                api_permit.acquire_host("landing.test", timeout=0.05)
        finally:
            api_permit.release()

        release_article_flow.set()
        worker.join(2.0)
        self.assertFalse(worker.is_alive())
        self.assertEqual(_failure(result_holder[0]).code, "no-download")

        api_permit = coordinator.acquire_scope(api_scope, AccessPolicy(max_concurrency=1))
        try:
            host_permit = api_permit.acquire_host("landing.test", timeout=0.2)
            host_permit.release()
        finally:
            api_permit.release()

    def test_browser_cancellation_actively_aborts_blocking_runtime(self) -> None:
        resolver = _FakeResolver({"landing.test": ("93.184.216.34",)})
        coordinator = AccessCoordinator()
        factory = _FakeBrowserFactory(blocking_goto=True)
        browser = BrowserClient(
            factory=factory,
            resolver=resolver,
            coordinator=coordinator,
            destination_policy=_PUBLIC_POLICY,
        )
        scope = AccessScope("browser-provider", "web")
        cancelled = threading.Event()
        result_holder: list[object] = []

        worker = threading.Thread(
            target=lambda: result_holder.append(
                browser.run(
                    scope,
                    "https://landing.test/start",
                    _WEB_POLICY,
                    cancel_event=cancelled,
                )
            )
        )
        worker.start()
        context: _FakeContext | None = None
        for _ in range(100):
            if factory.processes and factory.processes[0].context is not None:
                context = factory.processes[0].context
                if context.goto_started.wait(0.01):
                    break
            time.sleep(0.01)
        else:
            self.fail("blocking navigation did not start")
        assert context is not None

        cancelled.set()
        worker.join(2.0)
        self.assertFalse(worker.is_alive())
        self.assertEqual(_failure(result_holder[0]).code, "cancelled")
        self.assertNotIn("late", repr(result_holder[0]))
        self.assertTrue(context.pages[0].abort_event.is_set())
        self.assertTrue(context.pages[0].closed)
        self.assertTrue(context.closed)
        self.assertTrue(factory.processes[0].closed)

    def test_browser_lifecycle_cooldown_and_cleanup_apply_to_all_terminal_results(self) -> None:
        resolver = _FakeResolver(
            {
                "landing.test": ("93.184.216.34",),
                "popup.test": ("93.184.216.35",),
                "download.test": ("93.184.216.36",),
            }
        )
        clock = _FakeClock()
        coordinator = AccessCoordinator(clock=clock)
        clock.coordinator = coordinator

        scenarios: tuple[tuple[str, Callable[[object], object], str], ...] = (
            (
                "success",
                lambda session: getattr(session, "open_popup")("https://popup.test/popup"),
                "success",
            ),
            (
                "failure",
                lambda session: (
                    getattr(session, "open_popup")("https://popup.test/popup"),
                    (_ for _ in ()).throw(RuntimeError("runtime-secret")),
                ),
                "runtime",
            ),
            (
                "timeout",
                lambda session: (clock.advance(2.0), None)[1],
                "timeout",
            ),
            (
                "cancel",
                lambda session: getattr(session, "open_popup")("https://popup.test/popup"),
                "cancelled",
            ),
        )

        for index, (label, flow, expected_code) in enumerate(scenarios):
            factory = _FakeBrowserFactory(
                configured_download=(
                    _FakeDownload("https://download.test/file?token=secret", b"fixture")
                    if label == "success"
                    else None
                )
            )
            browser = BrowserClient(
                factory=factory,
                resolver=resolver,
                coordinator=coordinator,
                destination_policy=_PUBLIC_POLICY,
                timeout_seconds=1.0,
                clock=clock,
            )
            scope = AccessScope(f"fixture-{label}-{index}", "web")
            cancel_event = threading.Event()
            if label == "cancel":
                cancel_event.set()
                # The initial cancellation is intentionally cleared only after
                # admission, by the flow below, to exercise cleanup after a
                # complete browser setup.
                cancel_event.clear()

                def cancel_flow(session: object, event: threading.Event = cancel_event) -> object:
                    getattr(session, "open_popup")("https://popup.test/popup")
                    event.set()
                    return None

                flow = cancel_flow
            result = browser.run(
                scope,
                "https://landing.test/start",
                _WEB_POLICY,
                flow=flow,
                cancel_event=cancel_event,
            )
            if label == "success":
                self.assertEqual(_browser_download(result).chunks, (b"fixture",))
            else:
                self.assertEqual(_failure(result).code, expected_code)
            self.assertNotIn("runtime-secret", repr(result))
            self.assertNotIn("secret", repr(result))
            self.assertEqual(len(factory.processes), 1)
            process = factory.processes[0]
            self.assertTrue(process.closed)
            self.assertIsNotNone(process.context)
            assert process.context is not None
            self.assertTrue(process.context.closed)
            self.assertTrue(all(page.closed for page in process.context.pages))
            self.assertTrue(all(download.deleted for download in process.context.downloads))
            if process.downloads_path is not None:
                self.assertFalse(Path(process.downloads_path).exists())

            if label == "success":
                # API admission is a separate scope: a web completion cooldown
                # must not freeze the same provider's API capability.
                api_scope = AccessScope(f"fixture-{label}-{index}", "api", "content")
                api_permit = coordinator.acquire_scope(api_scope, AccessPolicy(max_concurrency=1))
                api_permit.release()

            with self.assertRaises(AdmissionTimeout):
                coordinator.acquire_scope(scope, _WEB_POLICY, timeout=0.02)
            clock.advance(30.0)
            permit = coordinator.acquire_scope(scope)
            permit.release()

    def test_storage_file_first_sqlite_later_verified_reader_and_atomic_output(self) -> None:
        payload = b"immutable fixture bytes\n"
        digest = sha256_digest(payload)
        with tempfile.TemporaryDirectory(prefix="sciretriever-t10-storage-") as temporary:
            base = Path(temporary)
            root = StorageRoot(base / "artifacts")
            catalog_path = base / "catalog.sqlite"
            engine = CatalogEngine(catalog_path)
            store = ArtifactStore(root)
            reference = store.publish(
                payload,
                sha256=digest,
                byte_size=len(payload),
                media_type="application/pdf",
            )

            registered = None
            reader = VerifiedReader(root)
            with CatalogWriteLock(catalog_path):
                with reader.acquire(reference) as lease:
                    registered = register_artifact(engine, "fixture-artifact", lease)
            self.assertIsNotNone(registered)
            assert registered is not None
            self.assertEqual(registered.relative_path, reference.path)
            row = get_artifact(engine, "fixture-artifact")
            self.assertIsNotNone(row)
            assert row is not None
            self.assertEqual(row.sha256, digest)
            self.assertEqual(row.byte_size, len(payload))

            output_path = base / "user-output.bin"
            formal_path = root.canonical_path / reference.path.root
            formal_path.write_bytes(b"tampered")
            with self.assertRaises(VerifiedReaderError):
                reader.open(reference)
            formal_path.write_bytes(payload)
            with reader.open(reference) as stream:
                output = write_atomic(
                    output_path,
                    stream,
                    expected_sha256=digest,
                    expected_size=len(payload),
                )
            self.assertEqual(output.sha256, digest)
            self.assertEqual(output.byte_size, len(payload))
            self.assertEqual(output_path.read_bytes(), payload)
            self.assertEqual(stat.S_IMODE(output_path.stat().st_mode), 0o600)

            with CatalogWriteLock(catalog_path):
                self.assertIsNotNone(get_artifact(engine, "fixture-artifact"))
                with engine.read_snapshot() as snapshot:
                    with self.assertRaises(sqlite3.OperationalError):
                        snapshot.execute("CREATE TABLE forbidden_write(value TEXT)")

            with engine.read_snapshot() as snapshot:
                table_names = {
                    cast(str, row[0])
                    for row in snapshot.execute(
                        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
                    ).fetchall()
                }
            self.assertTrue(
                {"artifact_objects", "provenances", "schema_identity"}.issubset(table_names)
            )

    def test_sqlite_failure_after_registration_rolls_back_and_keeps_orphan_readable(self) -> None:
        payload = b"orphan fixture"
        digest = sha256_digest(payload)
        with tempfile.TemporaryDirectory(prefix="sciretriever-t10-crash-") as temporary:
            base = Path(temporary)
            root = StorageRoot(base / "artifacts")
            catalog_path = base / "catalog.sqlite"
            engine = CatalogEngine(catalog_path)
            reference = ArtifactStore(root).publish(
                payload,
                sha256=digest,
                byte_size=len(payload),
                media_type="application/octet-stream",
            )
            reader = VerifiedReader(root)

            original_insert = artifact_helpers._insert_or_verify_artifact

            def crash_after_insert(
                connection: sqlite3.Connection, artifact: ArtifactObject
            ) -> object:
                original_insert(connection, artifact)
                raise RuntimeError("simulated crash")

            with reader.acquire(reference) as lease:
                with mock.patch.object(
                    artifact_helpers,
                    "_insert_or_verify_artifact",
                    side_effect=crash_after_insert,
                ):
                    with CatalogWriteLock(catalog_path):
                        with self.assertRaises(ArtifactCatalogError):
                            register_artifact(engine, "orphan-artifact", lease)
            self.assertIsNone(get_artifact(engine, "orphan-artifact"))
            with reader.open(reference) as stream:
                self.assertEqual(stream.read(), payload)

    def test_artifact_and_output_failpoints_never_leave_partial_files(self) -> None:
        payload = b"failpoint fixture payload"
        digest = sha256_digest(payload)
        artifact_failpoints = (
            "after-stage-fsync",
            "after-publish",
            "after-directory-fsync",
            "after-cleanup",
        )
        output_failpoints = (
            "staging-created",
            "staging-written",
            "staging-fsynced",
            "staging-verified",
            "before-publish",
            "after-publish",
            "before-directory-fsync",
            "directory-fsynced",
            "after-cleanup",
        )
        with tempfile.TemporaryDirectory(prefix="sciretriever-t10-failpoints-") as temporary:
            base = Path(temporary)
            for failpoint in artifact_failpoints:
                root = StorageRoot(base / f"artifact-{failpoint}")
                store = ArtifactStore(root)

                def stop(name: str, expected: str = failpoint) -> None:
                    if name == expected:
                        raise RuntimeError("injected artifact failure")

                with self.assertRaises(ArtifactStoreError):
                    store.publish(
                        payload,
                        sha256=digest,
                        byte_size=len(payload),
                        media_type="application/octet-stream",
                        checkpoint=stop,
                    )
                formal = (
                    root.canonical_path
                    / ".objects"
                    / digest.root[:2]
                    / (f"{digest.root}-{len(payload)}")
                )
                if failpoint == "after-stage-fsync":
                    self.assertFalse(formal.exists())
                else:
                    self.assertEqual(formal.read_bytes(), payload)
                    with VerifiedReader(root).open(
                        ArtifactReference(
                            path=RelativeArtifactPath(
                                f".objects/{digest.root[:2]}/{digest.root}-{len(payload)}"
                            ),
                            sha256=digest,
                            byte_size=len(payload),
                            media_type="application/octet-stream",
                        )
                    ) as stream:
                        self.assertEqual(stream.read(), payload)
                self.assertFalse(
                    any(
                        path.is_file() and ".staging" in path.parts
                        for path in root.canonical_path.rglob("*")
                    )
                )

            for failpoint in output_failpoints:
                target = base / f"output-{failpoint}.bin"
                old_payload = b"old complete output\n"
                target.write_bytes(old_payload)
                os.chmod(target, 0o600)

                def stop_output(name: str, expected: str = failpoint) -> None:
                    if name == expected:
                        raise RuntimeError("injected output failure")

                with self.assertRaises(RuntimeError):
                    write_atomic(
                        target,
                        payload,
                        overwrite=True,
                        failpoint=stop_output,
                    )
                self.assertEqual(target.read_bytes(), old_payload)
                self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
                self.assertFalse(
                    any(
                        path.is_file() and path.name.endswith(".staging") for path in base.iterdir()
                    )
                )

            target = base / "output-directory-fsync.bin"
            old_payload = b"old directory-fsync output\n"
            target.write_bytes(old_payload)
            os.chmod(target, 0o600)
            original_fsync = output_module.os.fsync
            failed_directory_fsync = False

            def fail_directory_fsync(descriptor: int) -> None:
                nonlocal failed_directory_fsync
                if not failed_directory_fsync and stat.S_ISDIR(os.fstat(descriptor).st_mode):
                    failed_directory_fsync = True
                    raise OSError("injected directory fsync failure")
                original_fsync(descriptor)

            with mock.patch.object(output_module.os, "fsync", side_effect=fail_directory_fsync):
                with self.assertRaises(output_module.AtomicOutputError):
                    write_atomic(target, payload, overwrite=True)
            self.assertTrue(failed_directory_fsync)
            self.assertEqual(target.read_bytes(), old_payload)
            self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
            self.assertFalse(
                any(path.is_file() and path.name.endswith(".staging") for path in base.iterdir())
            )

    def test_catalog_write_lock_is_single_nonblocking_core_writer_and_readers_do_not_lock(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory(prefix="sciretriever-t10-lock-") as temporary:
            base = Path(temporary)
            first_catalog = base / "first.sqlite"
            second_catalog = base / "second.sqlite"
            first_engine = CatalogEngine(first_catalog)
            CatalogEngine(second_catalog)
            first = CatalogWriteLock(first_catalog)
            second = CatalogWriteLock(first_catalog)
            started = time.monotonic()
            with first:
                with self.assertRaises(CatalogLockConflictError):
                    second.acquire()
                self.assertLess(time.monotonic() - started, 0.5)
                with first_engine.read_snapshot() as snapshot:
                    self.assertEqual(snapshot.execute("SELECT 1").fetchone(), (1,))
            second.acquire()
            second.release()

            independent = CatalogWriteLock(second_catalog)
            with first:
                independent.acquire()
                independent.release()
            self.assertFalse(first.locked)


if __name__ == "__main__":
    unittest.main()
