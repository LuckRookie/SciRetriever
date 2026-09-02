from __future__ import annotations

import json
import logging
import os
import tempfile
import threading
import time
import unittest
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast
from unittest import mock
from urllib.parse import urlsplit

from cloakbrowser.human.actionability import (
    ActionabilityError,
    ElementNotAttachedError,
    ElementNotEditableError,
    ElementNotEnabledError,
    ElementNotReceivingEventsError,
    ElementNotStableError,
    ElementNotVisibleError,
)
from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError

from sciretriever.model.access import (
    BrowserCaptureBatch,
    BrowserCaptureKind,
    BrowserRequest,
)
from sciretriever.network.admission import AccessCoordinator, AccessPolicy, AccessScope
from sciretriever.network.browser import (
    BrowserClient,
    BrowserDestinationKind,
    _ConnectionBinding,
)
from sciretriever.network.browser_sessions import (
    BrowserSessionBroker,
    BrowserSessionError,
)
from sciretriever.network.cloakbrowser import (
    CloakBrowserFactory,
    CloakBrowserRuntimeAvailability,
    CloakBrowserRuntimeError,
    _CloakEngine,
    _CloakProcess,
    cloakbrowser_runtime_availability,
)
from sciretriever.network.playwright import (
    PlaywrightRuntimeError,
    _ArticleContext,
    _Context,
    _Page,
    _Response,
    _Route,
    _vendor_identity,
)
from sciretriever.network.policy import AddressClass, DestinationPolicy
from tests.test_network_browser import (
    _FakeFactory as _BrowserFakeFactory,
)
from tests.test_network_browser import _FlowController
from tests.test_network_browser import (
    _Resolver as _BrowserResolver,
)
from tests.test_network_browser import (
    _ResponseFixture as _BrowserResponseFixture,
)

_EVENTS = ("page", "download", "response", "requestfinished", "requestfailed")


class _Lease:
    def __init__(self, directory: Path, launch_identity: object) -> None:
        self.directory = directory
        self.launch_identity = launch_identity
        self.close_calls = 0
        self.close_thread: int | None = None

    def close(self) -> None:
        self.close_calls += 1
        self.close_thread = threading.get_ident()


class _Profile:
    def __init__(
        self,
        directory: Path,
        *,
        seed: int = 1729,
        browser_version: str = "146.0.7680.177.5",
    ) -> None:
        self.lease = _Lease(
            directory,
            _LaunchIdentity(seed=seed, browser_version=browser_version),
        )

    def acquire_runtime(self) -> _Lease:
        return self.lease


@dataclass(frozen=True, slots=True)
class _LaunchIdentity:
    seed: int
    persona: str = "linux"
    locale: str = "en-US"
    languages: tuple[str, ...] = ("en-US", "en", "zh-CN", "zh", "ja", "ko")
    timezone: str = "UTC"
    screen: tuple[int, int] = (1920, 1080)
    browser_version: str = "146.0.7680.177.5"

    @property
    def fingerprint_seed(self) -> int:
        return self.seed


class _RuntimeLease:
    def __init__(self, cache_directory: Path, browser_version: str) -> None:
        self.cache_directory = cache_directory
        self.browser_version = browser_version
        self.close_calls = 0
        self.close_thread: int | None = None

    def close(self) -> None:
        self.close_calls += 1
        self.close_thread = threading.get_ident()


class _Runtime:
    def __init__(
        self,
        directory: Path,
        *,
        browser_version: str = "146.0.7680.177.5",
        binary_ready: bool = True,
    ) -> None:
        self.lease = _RuntimeLease(directory, browser_version)
        if binary_ready:
            binary = directory / f"chromium-{self.lease.browser_version}" / "chrome"
            binary.parent.mkdir(parents=True)
            binary.write_bytes(b"fixture binary")
            binary.chmod(0o700)

    def acquire_runtime(self) -> _RuntimeLease:
        return self.lease


class _ExplodingContext:
    def __init__(self) -> None:
        self.pumped = threading.Event()
        self.close_calls = 0

    def pump_events_from_engine(self) -> None:
        self.pumped.set()
        raise RuntimeError("event pump fixture failure")

    def close_from_engine(self) -> None:
        self.close_calls += 1

    def interrupt_transport(self) -> None:
        return None


class _Display:
    display = ":97"

    def __init__(self) -> None:
        self.close_calls = 0

    def close(self) -> None:
        self.close_calls += 1


class _RawContext:
    def __init__(self) -> None:
        self.route_handler: Callable[[object], object] | None = None
        self.handlers: dict[str, Callable[[object], object]] = {}
        self.close_calls = 0
        self.close_thread: int | None = None
        self.pages: list[_RawPage] = []

    def route(self, pattern: str, handler: Callable[[object], object]) -> None:
        if pattern != "**/*" or self.route_handler is not None:
            raise AssertionError("unexpected route registration")
        self.route_handler = handler

    def on(self, event: str, handler: Callable[[object], object]) -> None:
        if event in self.handlers:
            raise AssertionError("duplicate event registration")
        self.handlers[event] = handler

    def new_page(self) -> _RawPage:
        page = _RawPage()
        self.pages.append(page)
        return page

    def close(self) -> None:
        self.close_calls += 1
        self.close_thread = threading.get_ident()


class _RawLocator:
    def __init__(self, actions: list[tuple[str, object]]) -> None:
        self.actions = actions
        self.first = self

    def filter(self, *, visible: bool) -> _RawLocator:
        self.actions.append(("filter", visible))
        return self

    def click(self, *, timeout: int, no_wait_after: bool) -> None:
        self.actions.append(("click", (timeout, no_wait_after)))


class _RawPage:
    url = "about:blank"

    def __init__(self) -> None:
        self.actions: list[tuple[str, object]] = []
        self.handlers: dict[str, Callable[[object], object]] = {}
        self.close_calls = 0

    def on(self, event: str, handler: Callable[[object], object]) -> None:
        self.handlers[event] = handler

    def remove_listener(self, event: str, handler: Callable[[object], object]) -> None:
        if self.handlers.get(event) is handler:
            del self.handlers[event]

    def locator(self, _selector: str) -> _RawLocator:
        return _RawLocator(self.actions)

    def fill(self, selector: str, value: str, *, timeout: int) -> None:
        self.actions.append(("fill", (selector, value, timeout)))

    def wait_for_timeout(self, _milliseconds: int) -> None:
        return None

    def close(self) -> None:
        self.close_calls += 1


class _ClickFailureLocator(_RawLocator):
    def __init__(self, actions: list[tuple[str, object]], failure: BaseException) -> None:
        super().__init__(actions)
        self.failure = failure

    def click(self, *, timeout: int, no_wait_after: bool) -> None:
        self.actions.append(("click", (timeout, no_wait_after)))
        raise self.failure


class _ClickFailurePage(_RawPage):
    def __init__(self, failure: BaseException) -> None:
        super().__init__()
        self.failure = failure

    def locator(self, _selector: str) -> _ClickFailureLocator:
        return _ClickFailureLocator(self.actions, self.failure)


class _InlineEngine:
    def call(self, operation: Callable[[], object]) -> object:
        return operation()


class _Guid:
    def __init__(self, value: str) -> None:
        self._guid = value


class _GuidPage(_RawPage):
    def __init__(self, guid: str, *, recorder: list[tuple[str, object]] | None = None) -> None:
        super().__init__()
        self._impl_obj = _Guid(guid)
        self.recorder = recorder if recorder is not None else []
        self.removed_listeners: list[tuple[str, Callable[[object], object]]] = []

    def remove_listener(self, event: str, handler: Callable[[object], object]) -> None:
        self.removed_listeners.append((event, handler))
        self.recorder.append(("remove-listener", event))
        super().remove_listener(event, handler)

    def close(self) -> None:
        self.recorder.append(("page-close", self))
        super().close()

    def wait_for_timeout(self, milliseconds: int) -> None:
        self.recorder.append(("page-pump", milliseconds))


class _RawContextForPageContract:
    def __init__(self, recorder: list[tuple[str, object]]) -> None:
        self.recorder = recorder
        self.route_handler: Callable[[object], object] | None = None
        self.close_calls = 0

    def route(self, pattern: str, handler: Callable[[object], object]) -> None:
        if pattern != "**/*" or self.route_handler is not None:
            raise AssertionError("unexpected route registration")
        self.route_handler = handler

    def close(self) -> None:
        self.recorder.append(("context-close", self))
        self.close_calls += 1


class _RouteRegistrationFailureContext:
    def route(self, _pattern: str, _handler: Callable[[object], object]) -> None:
        raise RuntimeError("route registration fixture failure")


class _EngineCall:
    def __init__(self, recorder: list[tuple[str, object]]) -> None:
        self.recorder = recorder

    def call(self, operation: Callable[[], object]) -> object:
        self.recorder.append(("engine-call", operation))
        return operation()

    def interrupt(self) -> None:
        self.recorder.append(("engine-interrupt", self))


class _ProxyRecorder:
    def __init__(self, recorder: list[tuple[str, object]]) -> None:
        self.recorder = recorder

    def begin_lane(self, token: object) -> object:
        self.recorder.append(("begin-lane", token))
        return token

    def authorize(self, token: object, binding: object) -> object:
        self.recorder.append(("authorize", (token, binding)))
        return binding

    def end_lane(self, token: object) -> bool:
        self.recorder.append(("end-lane", token))
        return True


class _ResponseContext:
    def __init__(self, *, external_pdf_downloads: bool) -> None:
        self._external_pdf_downloads = external_pdf_downloads


class _SignedQueryDestinationGuard:
    """Record that destination policy receives only the safe URL locator."""

    def __init__(self, origin: str) -> None:
        self._origin = origin
        self.calls: list[tuple[str, BrowserDestinationKind]] = []

    def check(self, url: str, kind: BrowserDestinationKind) -> None:
        self.calls.append((url, kind))
        parsed = urlsplit(url)
        if parsed.query or f"{parsed.scheme}://{parsed.netloc}" != self._origin:
            raise ValueError("signed query escaped the destination policy boundary")

    def connection_origins(self) -> tuple[str, ...]:
        return (self._origin,)


class _SignedQueryCaptureGuard:
    """Allow only the query-free top-level PDF capture locator."""

    def __init__(self, locator: str) -> None:
        self._locator = locator
        self.calls: list[tuple[str, BrowserCaptureKind, str]] = []

    def allows(self, url: str, kind: BrowserCaptureKind, media_type: str) -> bool:
        self.calls.append((url, kind, media_type))
        return (
            url == self._locator
            and kind is BrowserCaptureKind.RESPONSE
            and media_type == "application/pdf"
        )


def _event_handlers() -> Mapping[str, Callable[[object], object]]:
    return {event: lambda _value: None for event in _EVENTS}


def _route_handler(_value: object) -> None:
    return None


def _binding() -> _ConnectionBinding:
    return _ConnectionBinding(
        scheme="https",
        hostname="publisher.sciretriever.test",
        port=443,
        address="127.0.0.1",
        verified_addresses=("127.0.0.1",),
        authority="publisher.sciretriever.test",
        tls_server_name="publisher.sciretriever.test",
    )


class CloakBrowserHumanizedClickTests(unittest.TestCase):
    def _page_for_failure(self, failure: BaseException) -> Any:
        context = cast(Any, SimpleNamespace(engine=_InlineEngine()))
        return _Page(context, cast(Any, object()), _ClickFailurePage(failure))

    def test_click_maps_stock_timeout_and_pinned_actionability_misses(self) -> None:
        failures = (
            PlaywrightTimeoutError("fixture timeout"),
            ActionabilityError("button", "timeout", "bounded miss"),
            ElementNotAttachedError("button"),
            ElementNotVisibleError("button"),
            ElementNotStableError("button"),
            ElementNotEnabledError("button"),
            ElementNotEditableError("button"),
            ElementNotReceivingEventsError("button"),
        )
        for failure in failures:
            with self.subTest(exception_type=type(failure).__name__):
                page = self._page_for_failure(failure)
                self.assertFalse(page.click("button", timeout=10_000))

    def test_click_keeps_unknown_and_contract_failures_fail_closed(self) -> None:
        failures = (
            RuntimeError("unexpected runtime failure"),
            PlaywrightError("Target page, context or browser has been closed"),
            PlaywrightError("Execution context was destroyed, most likely because of a navigation"),
            PlaywrightError("Unexpected token in selector"),
        )
        for failure in failures:
            with self.subTest(exception_type=type(failure).__name__):
                page = self._page_for_failure(failure)
                with self.assertRaises(PlaywrightRuntimeError):
                    page.click("button", timeout=10_000)


class CloakBrowserAdapterTests(unittest.TestCase):
    def test_runtime_availability_is_static_and_validates_shape(self) -> None:
        available = CloakBrowserRuntimeAvailability(True, True, True, True, "146.0.7680.177.5")
        self.assertTrue(available.cloak_wrapper_available)
        self.assertTrue(available.playwright_api_available)
        self.assertTrue(available.binary_executable_available)
        with self.assertRaises(ValueError):
            CloakBrowserRuntimeAvailability(True, True, False, True, "not-a-version")
        with self.assertRaises(ValueError):
            CloakBrowserRuntimeAvailability(False, True, True, True)

    def test_runtime_availability_uses_only_controlled_cache_layout(self) -> None:
        with tempfile.TemporaryDirectory(prefix="sciretriever-cloak-test-") as raw:
            root = Path(raw)
            version = "146.0.7680.177.5"
            binary = root / f"chromium-{version}" / "chrome"
            binary.parent.mkdir(parents=True)
            binary.write_bytes(b"fixture binary")
            binary.chmod(0o700)
            with mock.patch.dict(
                os.environ,
                {
                    "CLOAKBROWSER_CACHE_DIR": "/attacker/cache",
                    "CLOAKBROWSER_BINARY_PATH": "/attacker/chrome",
                },
                clear=False,
            ):
                available = cloakbrowser_runtime_availability(
                    browser_version=version,
                    cache_directory=root,
                )
            self.assertTrue(available.binary_executable_available)
            self.assertFalse(
                cloakbrowser_runtime_availability(
                    browser_version=version,
                    cache_directory=root / "chromium-version" / "chrome",
                ).binary_executable_available
            )
            binary.unlink()
            binary.symlink_to(root / "not-accepted")
            self.assertFalse(
                cloakbrowser_runtime_availability(
                    browser_version=version,
                    cache_directory=root,
                ).binary_executable_available
            )

    def test_launch_options_are_fixed_humanized_linux_and_clean_environment(self) -> None:
        with tempfile.TemporaryDirectory(prefix="sciretriever-cloak-test-") as raw:
            root = Path(raw)
            profile = _Profile(root / "profile")
            profile.lease.directory.mkdir()
            runtime = _Runtime(root / "cache")
            display = _Display()
            calls: list[tuple[str, dict[str, object], int]] = []
            vendor_environment: dict[str, str | None] = {}
            ambient_names = (
                "CLOAKBROWSER_CACHE_DIR",
                "CLOAKBROWSER_BINARY_PATH",
                "CLOAKBROWSER_VERSION",
                "CLOAKBROWSER_DOWNLOAD_URL",
                "CLOAKBROWSER_LICENSE_KEY",
                "CLOAKBROWSER_AUTO_UPDATE",
                "HTTP_PROXY",
                "HTTPS_PROXY",
                "ALL_PROXY",
                "http_proxy",
                "https_proxy",
                "all_proxy",
            )

            def launcher(user_data_dir: str, **options: object) -> _RawContext:
                calls.append((user_data_dir, options, threading.get_ident()))
                vendor_environment.update(
                    {
                        "cache": os.environ.get("CLOAKBROWSER_CACHE_DIR"),
                        "auto_update": os.environ.get("CLOAKBROWSER_AUTO_UPDATE"),
                        "ambient_version": os.environ.get("CLOAKBROWSER_VERSION"),
                        "ambient_proxy": os.environ.get("HTTP_PROXY"),
                    }
                )
                return _RawContext()

            with (
                mock.patch.dict(
                    os.environ,
                    {
                        "CLOAKBROWSER_CACHE_DIR": "/attacker/cache",
                        "CLOAKBROWSER_VERSION": "attacker-version",
                        "CLOAKBROWSER_BINARY_PATH": "/attacker/chrome",
                        "CLOAKBROWSER_DOWNLOAD_URL": "https://attacker.invalid/binary",
                        "CLOAKBROWSER_LICENSE_KEY": "ambient-license-sentinel",
                        "CLOAKBROWSER_AUTO_UPDATE": "true",
                        "HTTP_PROXY": "http://attacker.invalid:8080",
                        "HTTPS_PROXY": "http://attacker.invalid:8081",
                        "ALL_PROXY": "http://attacker.invalid:8082",
                        "http_proxy": "http://attacker.invalid:8083",
                        "https_proxy": "http://attacker.invalid:8084",
                        "all_proxy": "http://attacker.invalid:8085",
                        "SCIRETRIEVER_SECRET_SENTINEL": "must-not-reach-child",
                    },
                    clear=False,
                ),
                mock.patch(
                    "sciretriever.network.cloakbrowser.acquire_headed_display",
                    return_value=display,
                ),
            ):
                ambient_before = {name: os.environ.get(name) for name in ambient_names}
                factory = CloakBrowserFactory(profile, runtime, launcher=launcher)
                process = cast(
                    _CloakProcess,
                    factory(downloads_path=raw, connection_binding=object()),
                )
                process.__enter__()
                context = process.new_context(
                    downloads_path=raw,
                    accept_downloads=True,
                    connection_binding=_binding(),
                )
                options = calls[0][1]
                self.assertFalse(options["stealth_args"])
                self.assertTrue(options["humanize"])
                self.assertEqual(options["human_preset"], "default")
                self.assertFalse(options["headless"])
                self.assertIsNone(options["viewport"])
                self.assertFalse(options["geoip"])
                self.assertEqual(options["browser_version"], "146.0.7680.177.5")
                self.assertEqual(options["timezone"], "UTC")
                self.assertEqual(options["proxy"], {"server": context.proxy.server_url})
                self.assertEqual(options["service_workers"], "block")
                self.assertEqual(options["timeout"], 30_000)
                preferences = json.loads(
                    (profile.lease.directory / "Default" / "Preferences").read_text(
                        encoding="utf-8"
                    )
                )
                self.assertEqual(
                    preferences["plugins"],
                    {
                        "always_open_pdf_externally": True,
                        "open_pdf_in_system_reader": False,
                    },
                )
                self.assertTrue(context._external_pdf_downloads)
                args = cast(list[object], options["args"])
                self.assertIn("--lang=en-US", args)
                self.assertNotIn("--disable-pdf-extension", args)
                self.assertNotIn("--disable-background-networking", args)
                self.assertIn("--fingerprint=1729", args)
                self.assertIn("--fingerprint-platform=linux", args)
                child_env = cast(dict[str, str], options["env"])
                self.assertNotIn("CLOAKBROWSER_VERSION", child_env)
                self.assertNotIn("HTTP_PROXY", child_env)
                self.assertNotIn("HTTPS_PROXY", child_env)
                self.assertNotIn("ALL_PROXY", child_env)
                self.assertNotIn("SCIRETRIEVER_SECRET_SENTINEL", child_env)
                self.assertEqual(
                    vendor_environment["cache"],
                    os.fspath(runtime.lease.cache_directory),
                )
                self.assertEqual(vendor_environment["auto_update"], "false")
                self.assertIsNone(vendor_environment["ambient_version"])
                self.assertIsNone(vendor_environment["ambient_proxy"])
                self.assertNotIn("license_key", options)
                process.abort()
                process.cancel()
                process.stop()
                context.close()
                process.close()
                self.assertEqual(
                    {name: os.environ.get(name) for name in ambient_names},
                    ambient_before,
                )
                process_again = cast(
                    _CloakProcess,
                    factory(downloads_path=raw, connection_binding=object()),
                )
                context_again = process_again.new_context(
                    downloads_path=raw,
                    accept_downloads=True,
                    connection_binding=_binding(),
                )
                self.assertNotIn("license_key", calls[1][1])
                context_again.close()
                process_again.close()
                self.assertEqual(
                    {name: os.environ.get(name) for name in ambient_names},
                    ambient_before,
                )
            self.assertEqual(profile.lease.close_calls, 2)
            self.assertEqual(runtime.lease.close_calls, 2)
            self.assertEqual(display.close_calls, 2)
            self.assertEqual(profile.lease.close_thread, runtime.lease.close_thread)
            self.assertEqual(runtime.lease.close_thread, calls[1][2])

    def test_process_and_context_close_are_idempotent_and_engine_affine(self) -> None:
        with tempfile.TemporaryDirectory(prefix="sciretriever-cloak-test-") as raw:
            root = Path(raw)
            profile = _Profile(root / "profile")
            profile.lease.directory.mkdir()
            runtime = _Runtime(root / "cache")
            display = _Display()
            raws: list[_RawContext] = []

            def launcher(_user_data_dir: str, **_options: object) -> _RawContext:
                value = _RawContext()
                raws.append(value)
                return value

            with mock.patch(
                "sciretriever.network.cloakbrowser.acquire_headed_display",
                return_value=display,
            ):
                factory = CloakBrowserFactory(profile, runtime, launcher=launcher)
                process = cast(
                    _CloakProcess,
                    factory(downloads_path=raw, connection_binding=object()),
                )
                context = process.new_context(
                    downloads_path=raw,
                    accept_downloads=True,
                    connection_binding=_binding(),
                )
                process.abort()
                process.cancel()
                process.stop()
                context.close()
                context.close()
                process.close()
                process.close()

            self.assertEqual(raws[0].close_calls, 1)
            self.assertEqual(profile.lease.close_calls, 1)
            self.assertEqual(runtime.lease.close_calls, 1)
            self.assertEqual(display.close_calls, 1)
            self.assertEqual(profile.lease.close_thread, runtime.lease.close_thread)
            self.assertEqual(raws[0].close_thread, profile.lease.close_thread)

    def test_runtime_and_cleanup_logs_are_safe_and_actionable(self) -> None:
        with tempfile.TemporaryDirectory(prefix="sciretriever-cloak-test-") as raw:
            root = Path(raw)
            profile = _Profile(root / "profile")
            profile.lease.directory.mkdir()
            runtime = _Runtime(root / "cache")
            display = _Display()

            with mock.patch(
                "sciretriever.network.cloakbrowser.acquire_headed_display",
                return_value=display,
            ):
                factory = CloakBrowserFactory(
                    profile,
                    runtime,
                    launcher=lambda _user_data_dir, **_: _RawContext(),
                )
                with self.assertLogs("sciretriever.network.cloakbrowser", level="DEBUG") as logs:
                    process = cast(
                        _CloakProcess,
                        factory(downloads_path=raw, connection_binding=object()),
                    )
                    context = process.new_context(
                        downloads_path=raw,
                        accept_downloads=True,
                        connection_binding=_binding(),
                    )
                    context.close()
                    process.close()

            output = "\n".join(logs.output)
            self.assertIn("event=browser-cloak-runtime-ready", output)
            self.assertIn("runtime_version=146.0.7680.177.5", output)
            self.assertIn("identity_stable=true", output)
            self.assertIn("event=browser-cloak-cleanup", output)
            self.assertIn("cleanup=completed", output)
            ready = next(
                record
                for record in logs.records
                if "event=browser-cloak-runtime-ready" in record.getMessage()
            )
            self.assertEqual(ready.levelno, logging.DEBUG)
            self.assertNotIn("1729", output)
            self.assertNotIn(os.fspath(root), output)

    def test_guid_identity_reuses_one_page_wrapper_and_rejects_cross_article_collision(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory(prefix="sciretriever-cloak-test-") as raw:
            recorder: list[tuple[str, object]] = []
            engine = _EngineCall(recorder)
            proxy = _ProxyRecorder(recorder)
            context_raw = _RawContextForPageContract(recorder)
            context = _Context(cast(Any, engine), context_raw, cast(Any, proxy), Path(raw))
            state = context._register_article("publisher-one", raw)
            first_raw = _GuidPage("page-guid", recorder=recorder)
            second_raw = _GuidPage("page-guid", recorder=recorder)

            first = context._page(first_raw, state)
            second = context._page(second_raw, state)
            self.assertIs(first, second)
            self.assertEqual(_vendor_identity(first_raw), _vendor_identity(second_raw))
            self.assertEqual(len(first_raw.handlers), 5)
            self.assertEqual(second_raw.handlers, {})

            other = context._register_article("publisher-two", raw)
            with self.assertRaises(RuntimeError):
                context._page(second_raw, other)

            first.close()
            first.close()
            self.assertEqual(first_raw.close_calls, 1)
            self.assertEqual(len(first_raw.removed_listeners), 5)
            self.assertEqual(context.pages, ())
            context.close()

    def test_page_url_refreshes_http_navigation_and_only_falls_back_for_internal_viewer(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory(prefix="sciretriever-cloak-test-") as raw:
            recorder: list[tuple[str, object]] = []
            context = _Context(
                cast(Any, _EngineCall(recorder)),
                _RawContextForPageContract(recorder),
                cast(Any, _ProxyRecorder(recorder)),
                Path(raw),
            )
            state = context._register_article("publisher-one", raw)
            page_raw = _GuidPage("page-guid", recorder=recorder)
            page = context._page(page_raw, state)
            try:
                page_raw.url = "https://publisher.sciretriever.test/article"
                self.assertEqual(page.url, page_raw.url)
                page_raw.url = "https://publisher.sciretriever.test/article.pdf"
                self.assertEqual(page.url, page_raw.url)
                cached = "https://publisher.sciretriever.test/article.pdf"
                cast(Any, page)._navigation_url = cached
                page_raw.url = "chrome-extension://pdf-viewer/index.html"
                self.assertEqual(page.url, cached)
            finally:
                page.close()
                context.close()

    def test_route_fetch_fulfills_without_reading_body_and_response_uses_api_source(  # noqa: C901
        self,
    ) -> None:  # noqa: C901
        signed_url = "https://publisher.sciretriever.test/article.pdf?signed=fixture"
        pdf = b"%PDF-1.7\napi-response-source\n"
        viewer_html = b"<html><body>pdf viewer</body></html>"

        class _Frame:
            def __init__(self, page: object) -> None:
                self.page = page
                self.parent_frame = None
                self.url = signed_url

        class _RawRequest:
            url = signed_url
            resource_type = "document"
            method = "GET"
            redirected_from = None

            def __init__(self, page: object) -> None:
                self.frame = _Frame(page)

            def is_navigation_request(self) -> bool:
                return True

        class _RawAPIResponse:
            url = signed_url
            status = 200
            headers = {
                "Content-Type": "application/pdf",
                "Content-Length": str(len(pdf)),
            }

            def __init__(self) -> None:
                self.body_calls = 0

            def body(self) -> bytes:
                self.body_calls += 1
                return pdf

        class _RawResponse:
            url = signed_url
            status = 200
            headers = {
                "Content-Type": "application/pdf",
                "Content-Length": str(len(pdf)),
            }

            def __init__(self, request: _RawRequest) -> None:
                self.request = request

            def body(self) -> bytes:
                return viewer_html

        class _RawRoute:
            def __init__(self, request: _RawRequest, response: _RawAPIResponse) -> None:
                self.request = request
                self.response = response
                self.fetch_calls: list[int] = []
                self.fulfilled: object | None = None

            def fetch(self, *, max_redirects: int) -> _RawAPIResponse:
                self.fetch_calls.append(max_redirects)
                return self.response

            def fulfill(self, *, response: object) -> None:
                self.fulfilled = response

            def abort(self) -> None:
                raise AssertionError("route should not abort")

        with tempfile.TemporaryDirectory(prefix="sciretriever-cloak-test-") as raw:
            recorder: list[tuple[str, object]] = []
            engine = _EngineCall(recorder)
            proxy = _ProxyRecorder(recorder)
            context_raw = _RawContextForPageContract(recorder)
            context = _Context(cast(Any, engine), context_raw, cast(Any, proxy), Path(raw))
            state = context._register_article("publisher-one", raw)
            page = context._page(_GuidPage("page-guid", recorder=recorder), state)
            article = _ArticleContext(context, state)
            raw_request = _RawRequest(page.raw)
            request = context._request(raw_request, page)
            raw_api_response = _RawAPIResponse()
            raw_route = _RawRoute(raw_request, raw_api_response)
            route = _Route(context, article, raw_route, request)
            try:
                route.bind_connection(_binding())
                fetched = route.fetch(max_redirects=0)
                self.assertEqual(raw_route.fetch_calls, [0])
                self.assertEqual(raw_api_response.body_calls, 0)
                self.assertEqual(fetched.media_type, "application/pdf")
                route.fulfill(response=fetched)
                self.assertIs(raw_route.fulfilled, raw_api_response)
                response = _Response(
                    context,
                    article,
                    _RawResponse(raw_request),
                    request,
                )
                self.assertEqual(response.body(), pdf)
                self.assertEqual(raw_api_response.body_calls, 1)
            finally:
                article.end_article()
                context.close()

    def test_page_listeners_are_registered_per_page_and_removed_before_close(self) -> None:
        with tempfile.TemporaryDirectory(prefix="sciretriever-cloak-test-") as raw:
            recorder: list[tuple[str, object]] = []
            engine = _EngineCall(recorder)
            proxy = _ProxyRecorder(recorder)
            context_raw = _RawContextForPageContract(recorder)
            context = _Context(cast(Any, engine), context_raw, cast(Any, proxy), Path(raw))
            state = context._register_article("publisher-one", raw)
            page_raw = _GuidPage("page-guid", recorder=recorder)
            page = context._page(page_raw, state)

            self.assertEqual(
                set(page_raw.handlers),
                {"download", "popup", "response", "requestfinished", "requestfailed"},
            )
            page.close()
            self.assertEqual(
                {event for event, _handler in page_raw.removed_listeners},
                set(page_raw.handlers)
                | {"download", "popup", "response", "requestfinished", "requestfailed"},
            )
            self.assertEqual(page_raw.handlers, {})
            self.assertEqual(page_raw.close_calls, 1)
            removal_events = [
                index
                for index, (event, _value) in enumerate(recorder)
                if event == "remove-listener"
            ]
            close_events = [
                index for index, (event, _value) in enumerate(recorder) if event == "page-close"
            ]
            self.assertEqual(len(removal_events), 5)
            self.assertEqual(len(close_events), 1)
            self.assertLess(max(removal_events), close_events[0])
            context.close()

    def test_context_route_registration_failure_does_not_leave_event_dispatcher_thread(
        self,
    ) -> None:
        before = {
            thread.ident
            for thread in threading.enumerate()
            if thread.name == "sciretriever-playwright-events"
        }
        with self.assertRaises(PlaywrightRuntimeError):
            _Context(
                cast(Any, _EngineCall([])),
                _RouteRegistrationFailureContext(),
                cast(Any, _ProxyRecorder([])),
                Path(tempfile.gettempdir()),
            )
        after = {
            thread.ident
            for thread in threading.enumerate()
            if thread.name == "sciretriever-playwright-events"
        }
        self.assertEqual(after, before)

    def test_popup_guid_collision_closes_unowned_raw_popup(self) -> None:
        with tempfile.TemporaryDirectory(prefix="sciretriever-cloak-test-") as raw:
            recorder: list[tuple[str, object]] = []
            engine = _EngineCall(recorder)
            proxy = _ProxyRecorder(recorder)
            context_raw = _RawContextForPageContract(recorder)
            context = _Context(cast(Any, engine), context_raw, cast(Any, proxy), Path(raw))
            first_state = context._register_article("publisher-one", raw)
            second_state = context._register_article("publisher-two", raw)
            context._page(_GuidPage("same-guid", recorder=recorder), second_state)
            opener = context._page(_GuidPage("opener-guid", recorder=recorder), first_state)
            popup_raw = _GuidPage("same-guid", recorder=recorder)

            context._on_popup(opener, popup_raw)
            self.assertTrue(context._cleanup_failed)
            self.assertEqual(popup_raw.close_calls, 1)
            context.close()

    def test_popup_is_owned_by_opener_article_and_closed_when_article_is_inactive(self) -> None:
        with tempfile.TemporaryDirectory(prefix="sciretriever-cloak-test-") as raw:
            recorder: list[tuple[str, object]] = []
            engine = _EngineCall(recorder)
            proxy = _ProxyRecorder(recorder)
            context_raw = _RawContextForPageContract(recorder)
            context = _Context(cast(Any, engine), context_raw, cast(Any, proxy), Path(raw))
            state = context._register_article("publisher-one", raw)
            opener_raw = _GuidPage("opener-guid", recorder=recorder)
            popup_raw = _GuidPage("popup-guid", recorder=recorder)
            opener = context._page(opener_raw, state)
            seen: list[object] = []
            state.event_handlers["page"] = seen.append

            context._on_popup(opener, popup_raw)
            self.assertTrue(context._dispatcher.drain())
            self.assertEqual(len(seen), 1)
            popup = seen[0]
            self.assertEqual(getattr(popup, "article_token"), opener.article_token)
            self.assertIn(popup, context.pages)
            self.assertEqual(set(popup_raw.handlers), set(opener_raw.handlers))

            state.active = False
            late_popup = _GuidPage("late-popup-guid", recorder=recorder)
            context._on_popup(opener, late_popup)
            self.assertEqual(late_popup.close_calls, 1)
            context.close()

    def test_end_article_closes_pages_before_releasing_connect_lane(self) -> None:
        with tempfile.TemporaryDirectory(prefix="sciretriever-cloak-test-") as raw:
            recorder: list[tuple[str, object]] = []
            engine = _EngineCall(recorder)
            proxy = _ProxyRecorder(recorder)
            context_raw = _RawContextForPageContract(recorder)
            context = _Context(cast(Any, engine), context_raw, cast(Any, proxy), Path(raw))
            state = context._register_article("publisher-one", raw)
            page_raw = _GuidPage("page-guid", recorder=recorder)
            context._page(page_raw, state)
            article = _ArticleContext(context, state)

            self.assertTrue(context.end_article(article))
            page_close_index = next(
                index for index, (event, _value) in enumerate(recorder) if event == "page-close"
            )
            lane_end_index = next(
                index for index, (event, _value) in enumerate(recorder) if event == "end-lane"
            )
            self.assertLess(page_close_index, lane_end_index)
            self.assertFalse(state.active)
            self.assertEqual(page_raw.handlers, {})
            context.close()

    def test_pdf_attachment_classification_does_not_require_navigation(self) -> None:
        class _RequestStub:
            def __init__(self, navigation: bool) -> None:
                self.navigation = navigation

            def is_navigation_request(self) -> bool:
                return self.navigation

        class _ResponseStub:
            url = "https://publisher.sciretriever.test/article.pdf"
            status = 200

            def __init__(self, headers: Mapping[str, str]) -> None:
                self.headers = headers

        attachment = _Response(
            cast(Any, _ResponseContext(external_pdf_downloads=True)),
            cast(Any, object()),
            _ResponseStub(
                {
                    "Content-Type": "application/pdf",
                    "Content-Disposition": "attachment; filename=paper.pdf",
                }
            ),
            cast(Any, _RequestStub(False)),
        )
        inline = _Response(
            cast(Any, _ResponseContext(external_pdf_downloads=True)),
            cast(Any, object()),
            _ResponseStub({"Content-Type": "application/pdf"}),
            cast(Any, _RequestStub(False)),
        )
        navigation = _Response(
            cast(Any, _ResponseContext(external_pdf_downloads=True)),
            cast(Any, object()),
            _ResponseStub({"Content-Type": "application/pdf"}),
            cast(Any, _RequestStub(True)),
        )
        text_attachment = _Response(
            cast(Any, _ResponseContext(external_pdf_downloads=True)),
            cast(Any, object()),
            _ResponseStub(
                {
                    "Content-Type": "text/html",
                    "Content-Disposition": "attachment; filename=paper.html",
                }
            ),
            cast(Any, _RequestStub(False)),
        )
        self.assertTrue(attachment.attachment_download)
        self.assertTrue(attachment.download_expected)
        self.assertFalse(inline.attachment_download)
        self.assertFalse(inline.download_expected)
        self.assertFalse(navigation.attachment_download)
        self.assertTrue(navigation.download_expected)
        self.assertTrue(text_attachment.attachment_download)
        self.assertFalse(text_attachment.download_expected)

    def test_external_pdf_download_capability_controls_inline_top_level_pdf(self) -> None:
        class _RequestStub:
            def is_navigation_request(self) -> bool:
                return True

        class _ResponseStub:
            url = "https://publisher.sciretriever.test/article.pdf"
            status = 200

            def __init__(self, headers: Mapping[str, str]) -> None:
                self.headers = headers

        inline = {"Content-Type": "application/pdf"}
        attachment = {
            "Content-Type": "application/pdf",
            "Content-Disposition": "attachment; filename=paper.pdf",
        }
        stock_inline = _Response(
            cast(Any, _ResponseContext(external_pdf_downloads=True)),
            cast(Any, object()),
            _ResponseStub(inline),
            cast(Any, _RequestStub()),
        )
        cloak_inline = _Response(
            cast(Any, _ResponseContext(external_pdf_downloads=False)),
            cast(Any, object()),
            _ResponseStub(inline),
            cast(Any, _RequestStub()),
        )
        cloak_attachment = _Response(
            cast(Any, _ResponseContext(external_pdf_downloads=False)),
            cast(Any, object()),
            _ResponseStub(attachment),
            cast(Any, _RequestStub()),
        )
        self.assertTrue(stock_inline.download_expected)
        self.assertFalse(cloak_inline.download_expected)
        self.assertTrue(cloak_attachment.attachment_download)
        self.assertTrue(cloak_attachment.download_expected)

    def test_signed_query_navigation_preserves_runtime_url_but_redacts_capture_policy(self) -> None:
        signed_url = "https://download.test/article.pdf?signed-query=fixture&expires=9"
        policy_url = "https://download.test/article.pdf"
        pdf = b"%PDF-1.4\ncloak signed-query fixture\n"
        factory = _BrowserFakeFactory(
            response_fixtures={
                signed_url: _BrowserResponseFixture(
                    body=pdf,
                    media_type="application/pdf",
                )
            }
        )
        client = BrowserClient(
            factory=factory,
            resolver=_BrowserResolver({"download.test": ("93.184.216.36",)}),
            coordinator=AccessCoordinator(),
            destination_policy=DestinationPolicy(
                allowed_classes=frozenset({AddressClass.PUBLIC}),
            ),
        )
        destination_guard = _SignedQueryDestinationGuard("https://download.test")
        capture_guard = _SignedQueryCaptureGuard(policy_url)

        with self.assertLogs("sciretriever.network.browser", level="DEBUG") as logs:
            result = client.run(
                AccessScope("cloak-signed-query-fixture", "web"),
                BrowserRequest(
                    url=signed_url,
                    timeout_seconds=10.0,
                    max_response_bytes=1024 * 1024,
                ),
                AccessPolicy(max_concurrency=1),
                destination_guard=destination_guard,
                capture_guard=capture_guard,
                navigation_only=True,
                controller=_FlowController(
                    lambda session: session.wait_for_capture(BrowserCaptureKind.RESPONSE)
                ),
            )

        self.assertIsInstance(result, BrowserCaptureBatch)
        assert isinstance(result, BrowserCaptureBatch)
        self.assertEqual(len(result.captures), 1)
        self.assertEqual(
            b"".join(result.captures[0].stream.chunks),
            pdf,
        )
        self.assertEqual(result.captures[0].stream.final_locator, policy_url)
        self.assertTrue(factory.process.context is not None)
        assert factory.process.context is not None
        self.assertEqual(factory.process.context.pages[0].url, signed_url)
        self.assertTrue(capture_guard.calls)
        self.assertTrue(all(call[0] == policy_url for call in capture_guard.calls))
        self.assertTrue(all(not urlsplit(url).query for url, _kind in destination_guard.calls))
        self.assertNotIn(signed_url, repr(result))
        self.assertNotIn(signed_url, "\n".join(logs.output))

    def test_shared_broker_uses_one_process_and_context_for_multiple_lanes(self) -> None:
        with tempfile.TemporaryDirectory(prefix="sciretriever-cloak-test-") as raw:
            root = Path(raw)
            profile = _Profile(root / "profile", seed=7)
            profile.lease.directory.mkdir()
            runtime = _Runtime(root / "cache")
            displays: list[_Display] = []
            raws: list[_RawContext] = []

            def display_factory() -> _Display:
                value = _Display()
                displays.append(value)
                return value

            def launcher(_user_data_dir: str, **_options: object) -> _RawContext:
                value = _RawContext()
                raws.append(value)
                return value

            with mock.patch(
                "sciretriever.network.cloakbrowser.acquire_headed_display",
                side_effect=display_factory,
            ):
                factory = CloakBrowserFactory(profile, runtime, launcher=launcher)
                broker = BrowserSessionBroker()
                first = broker.acquire(
                    "publisher-one",
                    factory=factory,
                    downloads_path=raw,
                    connection_binding=_binding(),
                    route_handler=_route_handler,
                    event_handlers=_event_handlers(),
                    timeout=1.0,
                )
                second = broker.acquire(
                    "publisher-two",
                    factory=factory,
                    downloads_path=raw,
                    connection_binding=_binding(),
                    route_handler=_route_handler,
                    event_handlers=_event_handlers(),
                    timeout=1.0,
                )
                self.assertIs(first.process_runtime, second.process_runtime)
                self.assertIsNot(first.context, second.context)
                self.assertEqual(len(raws), 1)
                first.release()
                second.release()
                broker.close()
            self.assertEqual(profile.lease.close_calls, 1)
            self.assertEqual(runtime.lease.close_calls, 1)
            self.assertEqual(len(displays), 1)
            self.assertEqual(raws[0].close_calls, 1)

    def test_broker_serializes_same_lane_but_overlaps_distinct_publisher_lanes(self) -> None:
        with tempfile.TemporaryDirectory(prefix="sciretriever-cloak-test-") as raw:
            root = Path(raw)
            profile = _Profile(root / "profile", seed=7)
            profile.lease.directory.mkdir()
            runtime = _Runtime(root / "cache")
            displays: list[_Display] = []
            raws: list[_RawContext] = []

            def display_factory() -> _Display:
                value = _Display()
                displays.append(value)
                return value

            def launcher(_user_data_dir: str, **_options: object) -> _RawContext:
                value = _RawContext()
                raws.append(value)
                return value

            def acquire(broker: BrowserSessionBroker, key: str) -> object:
                return broker.acquire(
                    key,
                    factory=factory,
                    downloads_path=raw,
                    connection_binding=_binding(),
                    route_handler=_route_handler,
                    event_handlers=_event_handlers(),
                    timeout=2.0,
                )

            with mock.patch(
                "sciretriever.network.cloakbrowser.acquire_headed_display",
                side_effect=display_factory,
            ):
                factory = CloakBrowserFactory(profile, runtime, launcher=launcher)
                broker = BrowserSessionBroker()
                first = cast(Any, acquire(broker, "publisher-one"))
                same_started = threading.Event()
                same_done = threading.Event()
                same_result: dict[str, object] = {}

                def acquire_same_lane() -> None:
                    same_started.set()
                    try:
                        same_result["lease"] = acquire(broker, "publisher-one")
                    except BaseException as error:  # pragma: no cover - diagnostic only
                        same_result["error"] = error
                    finally:
                        same_done.set()

                worker = threading.Thread(target=acquire_same_lane)
                worker.start()
                self.assertTrue(same_started.wait(1.0))
                self.assertFalse(same_done.wait(0.1))

                second = cast(Any, acquire(broker, "publisher-two"))
                self.assertIs(first.process_runtime, second.process_runtime)
                self.assertIsNot(first.context, second.context)
                first.release()
                self.assertTrue(same_done.wait(1.0))
                worker.join(1.0)
                self.assertNotIn("error", same_result)
                same = cast(Any, same_result["lease"])
                self.assertIs(same.process_runtime, second.process_runtime)
                same.release()
                second.release()
                broker.close()

            self.assertEqual(len(raws), 1)
            self.assertEqual(len(displays), 1)

    def test_humanized_page_actions_use_the_single_context_page_path(self) -> None:
        with tempfile.TemporaryDirectory(prefix="sciretriever-cloak-test-") as raw:
            root = Path(raw)
            profile = _Profile(root / "profile")
            profile.lease.directory.mkdir()
            runtime = _Runtime(root / "cache")
            displays: list[_Display] = []
            raws: list[_RawContext] = []

            def display_factory() -> _Display:
                value = _Display()
                displays.append(value)
                return value

            def launcher(_user_data_dir: str, **_options: object) -> _RawContext:
                value = _RawContext()
                raws.append(value)
                return value

            with mock.patch(
                "sciretriever.network.cloakbrowser.acquire_headed_display",
                side_effect=display_factory,
            ):
                factory = CloakBrowserFactory(profile, runtime, launcher=launcher)
                broker = BrowserSessionBroker()
                lease = broker.acquire(
                    "publisher-one",
                    factory=factory,
                    downloads_path=raw,
                    connection_binding=_binding(),
                    route_handler=_route_handler,
                    event_handlers=_event_handlers(),
                    timeout=1.0,
                )
                page = cast(Any, lease.context).new_page()
                page.click("#continue", timeout=250)
                page.fill("#query", "fixture", timeout=250)
                raw_page = raws[0].pages[0]
                self.assertEqual(raw_page.actions[0][0], "filter")
                self.assertEqual(raw_page.actions[1][0], "click")
                self.assertEqual(raw_page.actions[2][0], "fill")
                page.close()
                lease.release()
                broker.close()
            self.assertEqual(len(displays), 1)

    def test_binary_version_mismatch_rejects_before_wrapper_and_releases_both_leases(self) -> None:
        with tempfile.TemporaryDirectory(prefix="sciretriever-cloak-test-") as raw:
            root = Path(raw)
            profile = _Profile(root / "profile")
            profile.lease.directory.mkdir()
            runtime = _Runtime(root / "cache", browser_version="147.0.8000.1.1")
            display = _Display()
            launch_calls = 0

            def launcher(_user_data_dir: str, **_options: object) -> _RawContext:
                nonlocal launch_calls
                launch_calls += 1
                return _RawContext()

            with mock.patch(
                "sciretriever.network.cloakbrowser.acquire_headed_display",
                return_value=display,
            ):
                factory = CloakBrowserFactory(profile, runtime, launcher=launcher)
                broker = BrowserSessionBroker()
                with self.assertRaises(BrowserSessionError):
                    broker.acquire(
                        "publisher-one",
                        factory=factory,
                        downloads_path=raw,
                        connection_binding=_binding(),
                        route_handler=_route_handler,
                        event_handlers=_event_handlers(),
                        timeout=1.0,
                    )
                broker.close()
            self.assertEqual(launch_calls, 0)
            self.assertEqual(profile.lease.close_calls, 1)
            self.assertEqual(runtime.lease.close_calls, 1)
            self.assertEqual(display.close_calls, 0)

    def test_missing_binary_rejects_without_wrapper_or_profile_lease(self) -> None:
        with tempfile.TemporaryDirectory(prefix="sciretriever-cloak-test-") as raw:
            root = Path(raw)
            profile = _Profile(root / "profile")
            profile.lease.directory.mkdir()
            runtime = _Runtime(root / "cache", binary_ready=False)
            launch_calls = 0

            def launcher(_user_data_dir: str, **_options: object) -> _RawContext:
                nonlocal launch_calls
                launch_calls += 1
                return _RawContext()

            factory = CloakBrowserFactory(profile, runtime, launcher=launcher)
            broker = BrowserSessionBroker()
            with self.assertRaises(BrowserSessionError):
                broker.acquire(
                    "publisher-one",
                    factory=factory,
                    downloads_path=raw,
                    connection_binding=_binding(),
                    route_handler=_route_handler,
                    event_handlers=_event_handlers(),
                    timeout=1.0,
                )
            broker.close()
            self.assertEqual(launch_calls, 0)
            self.assertEqual(profile.lease.close_calls, 0)
            self.assertEqual(runtime.lease.close_calls, 1)

    def test_event_pump_failure_runs_nested_cleanup_once(self) -> None:
        with tempfile.TemporaryDirectory(prefix="sciretriever-cloak-test-") as raw:
            root = Path(raw)
            profile = _Profile(root / "profile")
            runtime = _Runtime(root / "cache")
            profile.lease.directory.mkdir()
            engine = _CloakEngine(
                profile,
                runtime,
                ignore_https_errors=False,
                launcher=lambda _directory, **_options: _RawContext(),
            )
            exploding = _ExplodingContext()
            cast(Any, engine)._context = exploding
            cast(Any, engine)._profile_lease = profile.lease
            cast(Any, engine)._runtime_lease = runtime.lease
            engine.start()
            self.assertTrue(exploding.pumped.wait(1.0))
            engine._thread.join(1.0)
            started = time.monotonic()
            with self.assertRaises(CloakBrowserRuntimeError):
                engine.call(lambda: None)
            self.assertLess(time.monotonic() - started, 0.1)
            with self.assertRaises(CloakBrowserRuntimeError):
                engine.close()
            self.assertEqual(exploding.close_calls, 1)
            self.assertEqual(profile.lease.close_calls, 1)
            self.assertEqual(runtime.lease.close_calls, 1)

    def test_dead_engine_rejects_new_commands_without_waiting(self) -> None:
        with tempfile.TemporaryDirectory(prefix="sciretriever-cloak-test-") as raw:
            root = Path(raw)
            profile = _Profile(root / "profile")
            runtime = _Runtime(root / "cache")
            engine = _CloakEngine(
                profile,
                runtime,
                ignore_https_errors=False,
                launcher=lambda _directory, **_options: _RawContext(),
            )
            with mock.patch(
                "sciretriever.network.cloakbrowser._COMMAND_TIMEOUT_SECONDS",
                1.0,
            ):
                engine.start()
                cast(Any, engine)._commands.put(None)
                engine._thread.join(1.0)
                self.assertFalse(engine._thread.is_alive())
                started = time.monotonic()
                with self.assertRaises(CloakBrowserRuntimeError):
                    engine.call(lambda: None)
                self.assertLess(time.monotonic() - started, 0.1)
                engine.close()

    def test_launch_failure_closes_profile_and_does_not_leave_engine_thread(self) -> None:
        with tempfile.TemporaryDirectory(prefix="sciretriever-cloak-test-") as raw:
            root = Path(raw)
            profile = _Profile(root / "profile", seed=11)
            profile.lease.directory.mkdir()
            runtime = _Runtime(root / "cache")
            display = _Display()
            threads_before = {
                thread.ident
                for thread in threading.enumerate()
                if thread.name == "sciretriever-cloakbrowser-engine"
            }

            def launcher(_user_data_dir: str, **_options: object) -> object:
                raise RuntimeError("fixture launch failure")

            with mock.patch(
                "sciretriever.network.cloakbrowser.acquire_headed_display",
                return_value=display,
            ):
                factory = CloakBrowserFactory(profile, runtime, launcher=launcher)
                broker = BrowserSessionBroker()
                with self.assertRaises(BrowserSessionError):
                    broker.acquire(
                        "publisher-one",
                        factory=factory,
                        downloads_path=raw,
                        connection_binding=object(),
                        route_handler=_route_handler,
                        event_handlers=_event_handlers(),
                        timeout=1.0,
                    )
                broker.close()
            self.assertEqual(profile.lease.close_calls, 1)
            self.assertEqual(runtime.lease.close_calls, 1)
            self.assertEqual(display.close_calls, 1)
            threads_after = {
                thread.ident
                for thread in threading.enumerate()
                if thread.name == "sciretriever-cloakbrowser-engine"
            }
            self.assertEqual(threads_after, threads_before)


if __name__ == "__main__":
    unittest.main()
