from __future__ import annotations

import json
import tempfile
import threading
import time
import unittest
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable, Protocol, cast
from unittest import mock
from urllib.parse import urlsplit

from sciretriever.acquisition.browser_control import (
    AgentBrowserController,
    BrowserArticleGoal,
)
from sciretriever.acquisition.sources.browser import (
    _BrowserAction,
    _GenericCapturePolicy,
    _GenericStepSessionFactory,
    build_generic_browser_destination_guard,
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
from sciretriever.model.access import (
    AccessFailure,
    BoundedByteStream,
    BrowserCapture,
    BrowserCaptureBatch,
    BrowserCaptureKind,
)
from sciretriever.model.primitives import sha256_digest
from sciretriever.network.admission import (
    AccessCoordinator,
    AccessPermit,
    AccessPolicy,
    AccessScope,
    HostPermit,
)
from sciretriever.network.browser import (
    BrowserCaptureCorrelation,
    BrowserCaptureDecision,
    BrowserCaptureEvidence,
    BrowserCapturePolicy,
    BrowserClient,
    BrowserDestinationKind,
    BrowserOperationLimits,
    BrowserPageObservation,
    BrowserRequestObservation,
    _Abort,
    _DownloadCapturePlan,
    _FlowState,
    _PendingResponseDownload,
    _RequestLease,
    _safe_resource_type,
)
from sciretriever.network.browser_control import (
    BROWSER_OBSERVATION_MEDIA_TYPE,
    BrowserAction,
    BrowserActionOutcome,
    BrowserBlocked,
    BrowserBlockedReason,
    BrowserCancelled,
    BrowserCancelledTransition,
    BrowserCandidateTimeoutTransition,
    BrowserCaptureState,
    BrowserFailed,
    BrowserFailedTransition,
    BrowserObservation,
    BrowserObservationUnavailable,
    BrowserPageState,
    BrowserSettledTransition,
    BrowserStaleTransition,
    BrowserStoppedTransition,
    BrowserSurfaceKind,
    BrowserTransition,
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


class _ControlDriver(Protocol):
    def observe(self, *, page_state: BrowserPageState) -> BrowserObservation: ...

    def execute(
        self,
        action: BrowserAction,
        observation: BrowserObservation,
        *,
        timeout_seconds: float,
    ) -> BrowserTransition: ...

    def settle(
        self,
        observation: BrowserObservation,
        *,
        timeout_seconds: float,
    ) -> BrowserTransition: ...


class _FlowController:
    """Typed Browser controller fixture for one capability-only flow."""

    def __init__(self, flow: Callable[..., object]) -> None:
        if not callable(flow):
            raise TypeError("flow must be callable")
        self._flow = flow

    def run(self, session: object) -> None:
        result = self._flow(session)
        del result


class _ScriptedBrowserAgent:
    """Fake Provider that chooses actions from the real Browser observation."""

    provider_name = "fixture-browser-agent"

    def __init__(
        self,
        actions: tuple[str, ...],
        *,
        on_call: Callable[[int], None] | None = None,
    ) -> None:
        if not actions or any(action not in {"click", "stop"} for action in actions):
            raise ValueError("scripted Browser action is unsupported")
        self.actions = actions
        self.on_call = on_call
        self.calls: list[AgentProviderCall] = []
        self.summaries: list[dict[str, object]] = []

    def execute(self, call: AgentProviderCall) -> AgentToolCall:
        self.calls.append(call)
        turn = len(self.calls)
        if self.on_call is not None:
            self.on_call(turn)
        raw_summary = json.loads(call.text_parts[1].text)
        if not isinstance(raw_summary, dict):
            raise AssertionError("Browser Agent summary must be an object")
        summary = cast(dict[str, object], raw_summary)
        self.summaries.append(summary)
        article_token = self._text(summary, "article_token")
        page_id = self._text(summary, "page_id")
        revision = self._integer(summary, "revision")
        action = self.actions[min(turn - 1, len(self.actions) - 1)]
        arguments: dict[str, object] = {
            "article_token": article_token,
            "page_id": page_id,
            "revision": revision,
        }
        if action == "click":
            element = self._download_element(summary)
            arguments.update(
                {
                    "surface_id": self._text(element, "surface_id"),
                    "element_id": self._text(element, "element_id"),
                }
            )
            tool_name = "click_element"
        else:
            arguments["reason"] = "normal-miss"
            tool_name = "stop"
        encoded = json.dumps(arguments, sort_keys=True, separators=(",", ":"))
        return AgentToolCall(
            tool_name=tool_name,
            arguments=encoded,
            provenance=AgentProvenance(
                provider=self.provider_name,
                model=call.model,
                input_sha256=call.input_sha256,
                parameters_sha256=sha256_digest(b"production-shaped-browser-fixture"),
                usage=AgentUsage(output_tokens=1, response_bytes=len(encoded)),
            ),
        )

    @staticmethod
    def _text(values: dict[str, object], key: str) -> str:
        value = values.get(key)
        if type(value) is not str:
            raise AssertionError(f"Browser Agent summary field {key} must be text")
        return value

    @staticmethod
    def _integer(values: dict[str, object], key: str) -> int:
        value = values.get(key)
        if type(value) is not int:
            raise AssertionError(f"Browser Agent summary field {key} must be an integer")
        return value

    @staticmethod
    def _download_element(summary: dict[str, object]) -> dict[str, object]:
        values = summary.get("elements")
        if not isinstance(values, list):
            raise AssertionError("Browser Agent summary omitted elements")
        for value in values:
            if isinstance(value, dict) and value.get("name") == "Download PDF":
                return cast(dict[str, object], value)
        raise AssertionError("Browser Agent summary omitted the download action")


def _browser_agent_runtime(adapter: _ScriptedBrowserAgent) -> AgentRuntime:
    return AgentRuntime(
        adapter=adapter,
        browser=AgentRoleBinding(
            role=AgentRole.BROWSER,
            model="fixture-browser-model",
            capabilities=AgentModelCapabilities(
                context_window_tokens=1_000_000,
                max_output_tokens=131_072,
                image_input=True,
                tool_decision=True,
                supported_image_media_types=frozenset(
                    {BROWSER_OBSERVATION_MEDIA_TYPE, "image/png"}
                ),
                max_image_count=1,
                max_image_bytes=2 * 1024 * 1024,
            ),
            limits=AgentCallLimits(
                max_prompt_bytes=131_072,
                max_input_bytes=2 * 1024 * 1024,
                max_request_bytes=3 * 1024 * 1024,
                max_response_bytes=1 * 1024 * 1024,
                max_result_bytes=1 * 1024 * 1024,
                max_output_tokens=131_072,
                context_window_tokens=1_000_000,
            ),
        ),
    )


@dataclass
class _GenericAttemptFacts:
    page_state: BrowserPageState = BrowserPageState.NORMAL


def _generic_step_factory(
    *,
    start_url: str,
) -> tuple[_GenericStepSessionFactory, _GenericCapturePolicy, _GenericAttemptFacts]:
    action = _BrowserAction(
        start_url=start_url,
        scope_origin="https://landing.test",
        evidence_kind="production-shaped-fixture",
        identity="production-shaped-fixture",
        article_goal=BrowserArticleGoal(
            doi="10.1000/generic-browser",
            title="Generic Browser fixture",
            landing_origins=("https://landing.test",),
            asset_origins=("https://download.test",),
        ),
    )
    capture_policy = _GenericCapturePolicy(action)
    facts = _GenericAttemptFacts()
    return (
        _GenericStepSessionFactory(),
        capture_policy,
        facts,
    )


class _DeferredCapturePolicy:
    def decide(self, evidence: BrowserCaptureEvidence) -> BrowserCaptureDecision:
        del evidence
        return BrowserCaptureDecision.DEFER


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


class _CapturePolicy:
    def __init__(
        self,
        allowed: set[tuple[str, BrowserCaptureKind, str]],
        *,
        deferred: set[tuple[str, BrowserCaptureKind, str]] | None = None,
        prefetched: set[str] | None = None,
        error: BaseException | None = None,
    ) -> None:
        self.allowed = allowed
        self.deferred = set() if deferred is None else deferred
        self.prefetched = set() if prefetched is None else prefetched
        self.error = error
        self.calls: list[tuple[str, BrowserCaptureKind, str]] = []
        self.prefetch_calls: list[BrowserRequestObservation] = []

    def decide(self, evidence: BrowserCaptureEvidence) -> BrowserCaptureDecision:
        self.calls.append((evidence.locator, evidence.kind, evidence.media_type))
        if self.error is not None:
            raise self.error
        key = (evidence.locator, evidence.kind, evidence.media_type)
        if key in self.deferred:
            return BrowserCaptureDecision.DEFER
        return (
            BrowserCaptureDecision.ACCEPT if key in self.allowed else BrowserCaptureDecision.REJECT
        )

    def prefetch(self, observation: BrowserRequestObservation) -> bool:
        self.prefetch_calls.append(observation)
        return observation.method == "GET" and observation.locator in self.prefetched


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
        self.method = "GET"
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
        self.fetch_calls: list[int] = []
        self.fetched_response: object | None = None
        self.fulfilled_response: object | None = None

    def bind_connection(self, binding: object) -> object:
        self.binding = binding
        return binding

    def continue_(self) -> None:
        self.continued = True

    def fetch(self, *, max_redirects: int) -> object:
        self.fetch_calls.append(max_redirects)
        self.fetched_response = object()
        return self.fetched_response

    def fulfill(self, *, response: object) -> None:
        if response is not self.fetched_response:
            raise AssertionError("route fulfilled with an unrelated response")
        self.fulfilled_response = response
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
        headers: tuple[tuple[str, str], ...] = (),
    ) -> None:
        self.request = request
        self.url = request.url if final_url is None else final_url
        self.status = status
        self.media_type = media_type
        self._body = body
        self.download_expected = download_expected
        self.attachment_download = attachment_download
        self.size = len(body) if isinstance(body, bytes) else None
        self.headers = headers
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
        self.content_reads = 0
        self.request: _FakeRequest | None = None
        self.emitted_after_page_closed: bool | None = None

    def content(self) -> bytes:
        self.content_reads += 1
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
        self.control_snapshot_error: BaseException | None = None
        self.control_click_hook: Callable[[_FakePage], None] | None = None
        self.control_snapshot_hook: Callable[[_FakePage], None] | None = None
        self.control_wait_hook: Callable[[_FakePage], None] | None = None

    def goto(self, url: str, *, timeout: int) -> _FakeResponse:  # noqa: C901
        del timeout
        if self.goto_error is not None:
            raise self.goto_error
        current = url
        visited: set[str] = set()
        redirected_from: _FakeRequest | None = None
        while True:
            if current in visited:
                raise RuntimeError("redirect loop sentinel")
            visited.add(current)
            if self.context.native_redirects:
                if redirected_from is None:
                    route = self.context.begin_request(current, self, navigation=True)
                    if route.continued:
                        self.context.emit_response(route)
                else:
                    request = _FakeRequest(
                        current,
                        self,
                        navigation=True,
                        top_frame=True,
                        redirected_from=redirected_from,
                    )
                    route = _FakeRoute(request)
                    route.continued = True
                    self.context.emit_response(route)
                    self.context.emit_configured_download(self, request=request)
            else:
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
                configured = self.context.configured_download
                self.context.emit_configured_download(
                    self,
                    request=(
                        route.request
                        if configured is not None and current == configured.url
                        else None
                    ),
                )
                return _FakeResponse(route.request, self.context.navigation_status)
            redirected_from = route.request
            current = redirect

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

    def control_snapshot(
        self,
        *,
        timeout: int,
        include_screenshot: bool,
    ) -> dict[str, object]:
        if timeout <= 0:
            raise AssertionError("control snapshot timeout must be positive")
        self.control_snapshot_calls += 1
        if self.control_snapshot_hook is not None:
            self.control_snapshot_hook(self)
        if self.control_snapshot_error is not None:
            raise self.control_snapshot_error
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
            "screenshot": screenshot,
            "screenshot_media_type": "image/png" if include_screenshot else None,
        }

    def control_is_closed(self) -> bool:
        return self.closed

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
        if self.control_click_hook is not None:
            self.control_click_hook(self)
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
        if self.control_wait_hook is not None:
            self.control_wait_hook(self)
        return self.control_wait_result


class _FakeContext:
    def __init__(
        self,
        *,
        events: list[str],
        redirects: dict[str, str] | None = None,
        native_redirects: bool = False,
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
        self.native_redirects = native_redirects
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
        self.routes: list[_FakeRoute] = []
        self.closed = False
        self.close_calls = 0
        self.binding: object | None = None
        self.bindings: list[object] = []
        self.article_paths: list[str] = []
        self.article_bindings: list[object] = []
        self.article_lanes: list[str] = []
        self.article_active = False

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
        self.routes.append(route)
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

    def emit_configured_download(
        self,
        page: _FakePage,
        *,
        request: _FakeRequest | None = None,
    ) -> None:
        if self.configured_download is None or self.configured_download_emitted:
            return
        self.configured_download_emitted = True
        if request is None:
            route = self.request(self.configured_download.url, page, navigation=False)
            if route.aborted:
                return
            request = route.request
        else:
            route = None
        self.configured_download.request = request
        self.download(self.configured_download)
        if route is not None and route.continued:
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
        native_redirects: bool = False,
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
        self.native_redirects = native_redirects
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
            native_redirects=self.native_redirects,
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
        native_redirects: bool = False,
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
            native_redirects=native_redirects,
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
    def __init__(
        self,
        *,
        fail_first_navigation: bool = False,
        first_configured_download: bool = True,
    ) -> None:
        self.fail_first_navigation = fail_first_navigation
        self.first_configured_download = first_configured_download
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
            configured_download=(
                _FakeDownload(
                    "https://download.test/article.pdf",
                    b"%PDF-persistent-fixture",
                )
                if self.first_configured_download or self.processes
                else None
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
        raise AssertionError(
            f"expected captures, got {type(value).__name__}: {getattr(value, 'code', 'unknown')}"
        )
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

    def test_resource_type_diagnostic_collapses_unknown_vendor_tokens(self) -> None:
        class _VendorRequest:
            resource_type = "vendor-secret-token"

        class _MalformedRequest:
            resource_type = "bad value with spaces"

        class _KnownRequest:
            resource_type = "document"

        self.assertEqual(_safe_resource_type(_VendorRequest()), "other")
        self.assertEqual(_safe_resource_type(_MalformedRequest()), "unknown")
        self.assertEqual(_safe_resource_type(_KnownRequest()), "document")
        self.assertEqual(_safe_resource_type(object()), "unknown")

    def test_generic_capture_prefetches_browser_document_navigations(self) -> None:
        action = _BrowserAction(
            start_url="https://landing.test/article",
            scope_origin="https://landing.test",
            evidence_kind="fixture",
            identity="fixture-prefetch",
            article_goal=BrowserArticleGoal(),
        )
        policy = _GenericCapturePolicy(action)

        top_navigation = BrowserRequestObservation(
            locator="https://landing.test/article",
            kind=BrowserDestinationKind.NAVIGATION,
            resource_type="document",
            is_navigation=True,
            is_top_frame=True,
            method="GET",
        )
        subresource = BrowserRequestObservation(
            locator="https://landing.test/app.js",
            kind=BrowserDestinationKind.REQUEST,
            resource_type="script",
            is_navigation=False,
            is_top_frame=False,
            method="GET",
        )
        form_navigation = BrowserRequestObservation(
            locator="https://landing.test/search",
            kind=BrowserDestinationKind.NAVIGATION,
            resource_type="document",
            is_navigation=True,
            is_top_frame=True,
            method="POST",
        )
        embedded_navigation = BrowserRequestObservation(
            locator="https://landing.test/article-pdf",
            kind=BrowserDestinationKind.NAVIGATION,
            resource_type="document",
            is_navigation=True,
            is_top_frame=False,
            method="GET",
        )

        self.assertTrue(policy.prefetch(top_navigation))
        self.assertFalse(policy.prefetch(subresource))
        self.assertTrue(policy.prefetch(form_navigation))
        self.assertTrue(policy.prefetch(embedded_navigation))

    def test_exact_article_pdf_redirect_is_captured_before_first_agent_call(self) -> None:
        start_url = "https://landing.test/doi/pdf/10.1000/early-pdf"
        final_url = "https://landing.test/action/download-pdf"
        download = _FakeDownload(final_url, b"%PDF-early-redirect")
        factory = _FakeFactory(
            redirects={start_url: final_url},
            native_redirects=True,
            configured_download=download,
            response_fixtures={
                start_url: _ResponseFixture(
                    body=None,
                    media_type="text/html",
                    status=301,
                )
            },
        )
        action = _BrowserAction(
            start_url=start_url,
            scope_origin="https://landing.test",
            evidence_kind="doi-resolved-origin",
            identity="fixture-early-pdf",
            article_goal=BrowserArticleGoal(
                doi="10.1000/early-pdf",
                landing_origins=("https://landing.test",),
            ),
        )
        capture_policy = _GenericCapturePolicy(action)
        adapter = _ScriptedBrowserAgent(("stop",))
        controller = AgentBrowserController(
            runtime=_browser_agent_runtime(adapter),
            step_factory=_GenericStepSessionFactory(),
            article_goal=action.article_goal,
            action_timeout_seconds=0.5,
        )

        result = BrowserClient(
            factory=factory,
            resolver=self.resolver,
            coordinator=AccessCoordinator(),
            destination_policy=_PUBLIC_POLICY,
        ).run(
            self.scope,
            start_url,
            AccessPolicy(max_concurrency=1),
            controller=controller,
            destination_guard=build_generic_browser_destination_guard(start_url),
            capture_policy=capture_policy,
        )

        self.assertIsInstance(result, BrowserCaptureBatch, getattr(result, "code", result))
        batch = cast(BrowserCaptureBatch, result)
        self.assertEqual(len(batch.captures), 1)
        self.assertEqual(batch.captures[0].stream.chunks, (b"%PDF-early-redirect",))
        self.assertEqual(adapter.calls, [])
        self.assertEqual(download.content_reads, 1)
        self.assertEqual(download.delete_calls, 1)

    def test_exact_start_redirect_rejects_non_pdf_resources_before_body_read(self) -> None:
        start_url = "https://landing.test/doi/pdf/10.1000/early-pdf"
        cases = (
            ("https://landing.test/doi/pdf/10.1000/early-pdf/render", "text/html"),
            ("https://landing.test/doi/pdf/10.1000/early-pdf/cover", "image/png"),
            ("https://landing.test/doi/pdf/10.1000/early-pdf/readme", "text/plain"),
        )
        for final_url, media_type in cases:
            with self.subTest(final_url=final_url, media_type=media_type):
                download = _FakeDownload(
                    final_url,
                    b"%PDF-must-not-be-read",
                    media_type=media_type,
                )
                factory = _FakeFactory(
                    redirects={start_url: final_url},
                    native_redirects=True,
                    configured_download=download,
                    response_fixtures={
                        start_url: _ResponseFixture(
                            body=None,
                            media_type="text/html",
                            status=301,
                        )
                    },
                )
                capture_policy = _GenericCapturePolicy(
                    _BrowserAction(
                        start_url=start_url,
                        scope_origin="https://landing.test",
                        evidence_kind="doi-resolved-origin",
                        identity="fixture-unsafe-redirect",
                        article_goal=BrowserArticleGoal(
                            doi="10.1000/early-pdf",
                            landing_origins=("https://landing.test",),
                        ),
                    )
                )

                result = BrowserClient(
                    factory=factory,
                    resolver=self.resolver,
                    coordinator=AccessCoordinator(),
                    destination_policy=_PUBLIC_POLICY,
                ).run(
                    self.scope,
                    start_url,
                    AccessPolicy(max_concurrency=1),
                    destination_guard=build_generic_browser_destination_guard(start_url),
                    capture_policy=capture_policy,
                    limits=BrowserOperationLimits(capture_wait_timeout_seconds=0.02),
                )

                self.assertIsInstance(result, AccessFailure)
                self.assertEqual(cast(AccessFailure, result).code, "no-download")
                self.assertEqual(download.content_reads, 0)
                self.assertEqual(download.delete_calls, 1)
                assert factory.process.context is not None
                self.assertTrue(
                    all(response.body_reads == 0 for response in factory.process.context.responses)
                )

    def test_initial_pdf_response_is_captured_before_agent_decision(self) -> None:
        start_url = "https://landing.test/pdf/article-123.pdf"
        action = _BrowserAction(
            start_url=start_url,
            scope_origin="https://landing.test",
            evidence_kind="landing-pending-fixture",
            identity="fixture-deferred-landing",
            article_goal=BrowserArticleGoal(
                title="Article 123",
                landing_origins=("https://landing.test",),
            ),
        )
        capture_policy = _GenericCapturePolicy(action)
        adapter = _ScriptedBrowserAgent(("stop",))
        controller = AgentBrowserController(
            runtime=_browser_agent_runtime(adapter),
            step_factory=_GenericStepSessionFactory(),
            article_goal=action.article_goal,
            action_timeout_seconds=0.5,
        )
        factory = _FakeFactory(
            response_fixtures={
                start_url: _ResponseFixture(b"%PDF-deferred-response"),
            }
        )

        result = BrowserClient(
            factory=factory,
            resolver=self.resolver,
            coordinator=AccessCoordinator(),
            destination_policy=_PUBLIC_POLICY,
        ).run(
            self.scope,
            start_url,
            AccessPolicy(max_concurrency=1),
            controller=controller,
            destination_guard=build_generic_browser_destination_guard(start_url),
            capture_policy=capture_policy,
        )

        batch = _captures(result)
        self.assertEqual(batch.captures[0].stream.chunks, (b"%PDF-deferred-response",))
        self.assertEqual(adapter.calls, [])
        assert factory.process.context is not None
        self.assertEqual(factory.process.context.responses[0].body_reads, 1)

    def test_native_download_uses_the_current_generic_capture_policy(self) -> None:
        start_url = "https://landing.test/article-123"
        final_url = "https://landing.test/pdf/article-123.pdf"
        action = _BrowserAction(
            start_url=start_url,
            scope_origin="https://landing.test",
            evidence_kind="landing-pending-fixture",
            identity="fixture-deferred-native-download",
            article_goal=BrowserArticleGoal(
                title="Article 123",
                landing_origins=("https://landing.test",),
            ),
        )
        capture_policy = _GenericCapturePolicy(
            _BrowserAction(
                start_url=start_url,
                scope_origin="https://landing.test",
                evidence_kind="landing-pending-fixture",
                identity="fixture-deferred-native-download",
                article_goal=action.article_goal,
            )
        )
        adapter = _ScriptedBrowserAgent(("stop",))
        controller = AgentBrowserController(
            runtime=_browser_agent_runtime(adapter),
            step_factory=_GenericStepSessionFactory(),
            article_goal=action.article_goal,
            action_timeout_seconds=0.5,
        )
        download = _FakeDownload(final_url, b"%PDF-deferred-native-download")
        factory = _FakeFactory(
            redirects={start_url: final_url},
            native_redirects=True,
            configured_download=download,
            response_fixtures={
                start_url: _ResponseFixture(
                    body=None,
                    media_type="text/html",
                    status=301,
                )
            },
        )

        result = BrowserClient(
            factory=factory,
            resolver=self.resolver,
            coordinator=AccessCoordinator(),
            destination_policy=_PUBLIC_POLICY,
        ).run(
            self.scope,
            start_url,
            AccessPolicy(max_concurrency=1),
            controller=controller,
            destination_guard=build_generic_browser_destination_guard(start_url),
            capture_policy=capture_policy,
        )

        batch = _captures(result)
        self.assertEqual(
            batch.captures[0].stream.chunks,
            (b"%PDF-deferred-native-download",),
        )
        self.assertEqual(adapter.calls, [])
        self.assertEqual(download.content_reads, 1)
        self.assertEqual(download.delete_calls, 1)

    def test_unresolved_deferred_response_times_out_unread(self) -> None:
        start_url = "https://landing.test/pdf/article-123.pdf"
        capture_policy = _DeferredCapturePolicy()
        factory = _FakeFactory(
            response_fixtures={
                start_url: _ResponseFixture(b"%PDF-must-remain-unread"),
            }
        )

        result = BrowserClient(
            factory=factory,
            resolver=self.resolver,
            coordinator=AccessCoordinator(),
            destination_policy=_PUBLIC_POLICY,
        ).run(
            self.scope,
            start_url,
            AccessPolicy(max_concurrency=1),
            destination_guard=build_generic_browser_destination_guard(start_url),
            capture_policy=capture_policy,
            limits=BrowserOperationLimits(capture_wait_timeout_seconds=0.02),
        )

        self.assertIsInstance(result, AccessFailure)
        self.assertEqual(cast(AccessFailure, result).code, "capture-timeout")
        assert factory.process.context is not None
        self.assertEqual(factory.process.context.responses[0].body_reads, 0)

    def _run_production_agent(
        self,
        *,
        actions: tuple[str, ...],
        start_url: str = "https://landing.test/article",
        configure: Callable[[int, _FakePage, _FakeContext], None] | None = None,
        limits: BrowserOperationLimits | None = None,
        cancel_event: threading.Event | None = None,
        capture_policy_override: BrowserCapturePolicy | None = None,
    ) -> tuple[
        object,
        AgentBrowserController,
        _ScriptedBrowserAgent,
        _FakeFactory,
        _GenericCapturePolicy,
        _GenericAttemptFacts,
    ]:
        factory = _FakeFactory()
        factory.process.challenge = start_url.endswith("/challenge")
        step_factory, capture_policy, facts = _generic_step_factory(
            start_url=start_url,
        )

        def on_call(turn: int) -> None:
            if configure is None:
                return
            context = factory.process.context
            if context is None or not context.pages:
                raise AssertionError("Browser Agent ran before the vendor page existed")
            configure(turn, context.pages[0], context)

        adapter = _ScriptedBrowserAgent(actions, on_call=on_call)
        controller = AgentBrowserController(
            runtime=_browser_agent_runtime(adapter),
            step_factory=step_factory,
            article_goal=capture_policy.action.article_goal,
            cancel_event=cancel_event,
            action_timeout_seconds=0.5,
        )
        client = BrowserClient(
            factory=factory,
            resolver=self.resolver,
            coordinator=AccessCoordinator(),
            destination_policy=_PUBLIC_POLICY,
        )
        result = client.run(
            self.scope,
            start_url,
            AccessPolicy(max_concurrency=1),
            controller=controller,
            destination_guard=build_generic_browser_destination_guard(start_url),
            capture_policy=(
                capture_policy_override if capture_policy_override is not None else capture_policy
            ),
            limits=limits,
            cancel_event=cancel_event,
        )
        return result, controller, adapter, factory, capture_policy, facts

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

    def test_navigation_download_is_bounded_and_fully_cleaned(self) -> None:
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
            ["landing.test", "download.test"],
        )
        self.assertIsNotNone(self.factory.downloads_path)
        assert self.factory.downloads_path is not None
        self.assertFalse(Path(self.factory.downloads_path).exists())

    def test_reviewed_capture_request_uses_fetch_fulfill_and_ignores_range_chunks(
        self,
    ) -> None:
        response_url = "https://landing.test/article-pdf"
        policy = _CapturePolicy(
            {(response_url, BrowserCaptureKind.RESPONSE, "application/pdf")},
            prefetched={response_url},
        )
        factory = _FakeFactory(
            response_fixtures={response_url: _ResponseFixture(b"%PDF-prefetched")}
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
                response_url,
                self.policy,
                capture_policy=policy,
            )
        )

        self.assertEqual(b"".join(batch.captures[0].stream.chunks), b"%PDF-prefetched")
        assert factory.process.context is not None
        route = factory.process.context.routes[0]
        self.assertEqual(route.fetch_calls, [0])
        self.assertIs(route.fulfilled_response, route.fetched_response)
        self.assertEqual(policy.prefetch_calls[0].method, "GET")

        partial_policy = _CapturePolicy(
            {(response_url, BrowserCaptureKind.RESPONSE, "application/pdf")},
            prefetched={response_url},
        )
        partial_factory = _FakeFactory(
            response_fixtures={
                response_url: _ResponseFixture(
                    b"partial-range",
                    status=206,
                )
            }
        )
        partial_client = BrowserClient(
            factory=partial_factory,
            resolver=self.resolver,
            coordinator=AccessCoordinator(),
            destination_policy=_PUBLIC_POLICY,
        )

        partial = partial_client.run(
            self.scope,
            response_url,
            self.policy,
            capture_policy=partial_policy,
        )

        self.assertEqual(_failure(partial).code, "no-download")
        assert partial_factory.process.context is not None
        self.assertEqual(partial_factory.process.context.responses[0].body_reads, 0)

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

    def test_redirect_reuses_a_dynamically_admitted_same_page_origin(self) -> None:
        class _DynamicOriginGuard:
            def check(self, url: str, kind: BrowserDestinationKind) -> None:
                del kind
                if urlsplit(url).hostname not in {"landing.test", "other.test"}:
                    raise ValueError("fixture origin rejected")

            def connection_origins(self) -> tuple[str, ...]:
                return ("https://landing.test",)

        factory = _FakeFactory()
        responses: list[_FakeResponse] = []
        coordinator = _RecordingCoordinator()

        def flow(_session: object) -> None:
            context = factory.process.context
            self.assertIsNotNone(context)
            assert context is not None
            page = context.pages[0]
            route = context.begin_request(
                "https://other.test/auth/start",
                page,
                navigation=True,
            )
            self.assertTrue(route.continued)
            redirect = _FakeResponse(route.request, status=302)
            child = _FakeRequest(
                "https://other.test/auth/next",
                page,
                navigation=True,
                redirected_from=route.request,
            )
            terminal = _FakeResponse(child, status=302)
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
                destination_guard=_DynamicOriginGuard(),
            )
        )

        self.assertEqual(result.code, "no-download")
        self.assertEqual(len(responses), 2)
        self.assertEqual(coordinator.hosts, ["landing.test", "other.test"])

    def test_redirect_location_prebinds_the_next_guarded_origin(self) -> None:
        class _DynamicOriginGuard:
            def check(self, url: str, kind: BrowserDestinationKind) -> None:
                del kind
                if urlsplit(url).hostname not in {"landing.test", "other.test"}:
                    raise ValueError("fixture origin rejected")

            def connection_origins(self) -> tuple[str, ...]:
                return ("https://landing.test",)

        factory = _FakeFactory()
        coordinator = _RecordingCoordinator()

        def flow(_session: object) -> None:
            context = factory.process.context
            self.assertIsNotNone(context)
            assert context is not None
            page = context.pages[0]
            route = context.begin_request(
                "https://landing.test/auth/start",
                page,
                navigation=True,
            )
            response = _FakeResponse(
                route.request,
                status=302,
                headers=(("location", "https://other.test/auth/next"),),
            )
            for handler in context.handlers.get("response", ()):
                handler(response)

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
                destination_guard=_DynamicOriginGuard(),
            )
        )

        self.assertEqual(result.code, "no-download")
        self.assertEqual(coordinator.hosts, ["landing.test", "other.test"])

    def test_response_and_download_duplicate_bytes_are_delivered_once(self) -> None:
        download_url = "https://download.test/article.pdf"
        body = b"%PDF-identical-event-body"
        download = _FakeDownload(download_url, body)
        guard = _CapturePolicy(
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
                capture_policy=guard,
            )
        )

        self.assertEqual(len(batch.captures), 1)
        self.assertIs(batch.captures[0].kind, BrowserCaptureKind.DOWNLOAD)
        self.assertEqual(batch.captures[0].stream.chunks, (body,))
        context = factory.process.context
        self.assertIsNotNone(context)
        assert context is not None
        self.assertEqual(context.responses[-1].body_reads, 0)
        self.assertEqual(download.content_reads, 1)
        self.assertTrue(download.deleted)
        self.assertEqual(download.delete_calls, 1)

    def test_response_only_policy_captures_fetch_before_blob_download(self) -> None:
        pdf_url = "https://landing.test/article.pdf"
        body = b"%PDF-fetch-then-blob"
        blob_download = _FakeDownload(
            "blob:https://landing.test/article-download",
            body,
        )
        response_holder: list[_FakeResponse] = []
        factory = _FakeFactory()
        client = BrowserClient(
            factory=factory,
            resolver=self.resolver,
            coordinator=AccessCoordinator(),
            destination_policy=_PUBLIC_POLICY,
        )
        policy = _CapturePolicy({(pdf_url, BrowserCaptureKind.RESPONSE, "application/pdf")})

        def fetch_then_download(_session: object) -> None:
            context = factory.process.context
            self.assertIsNotNone(context)
            assert context is not None
            page = context.pages[0]
            route = context.begin_request(pdf_url, page, navigation=False)
            self.assertTrue(route.continued)
            response = _FakeResponse(
                route.request,
                body=body,
                media_type="application/pdf",
                download_expected=True,
                attachment_download=True,
            )
            response_holder.append(response)
            context.responses.append(response)
            for handler in context.handlers.get("response", ()):
                handler(response)
            context.download(blob_download)
            context.finish_request(route)

        batch = _captures(
            client.run(
                self.scope,
                "https://landing.test/start",
                self.policy,
                controller=_FlowController(fetch_then_download),
                capture_policy=policy,
            )
        )

        self.assertEqual(len(batch.captures), 1)
        self.assertIs(batch.captures[0].kind, BrowserCaptureKind.RESPONSE)
        self.assertEqual(batch.captures[0].stream.chunks, (body,))
        self.assertEqual(response_holder[0].body_reads, 1)
        self.assertEqual(blob_download.content_reads, 0)
        self.assertTrue(blob_download.deleted)
        self.assertEqual(blob_download.delete_calls, 1)

    def test_response_only_policy_uses_native_download_for_pdf_navigation(self) -> None:
        pdf_url = "https://download.test/article.pdf"
        body = b"%PDF-navigation-native-download"
        download = _FakeDownload(pdf_url, body)
        factory = _FakeFactory(configured_download=download)
        client = BrowserClient(
            factory=factory,
            resolver=self.resolver,
            coordinator=AccessCoordinator(),
            destination_policy=_PUBLIC_POLICY,
        )
        policy = _CapturePolicy({(pdf_url, BrowserCaptureKind.RESPONSE, "application/pdf")})

        batch = _captures(
            client.run(
                self.scope,
                pdf_url,
                self.policy,
                capture_policy=policy,
            )
        )

        self.assertEqual(len(batch.captures), 1)
        self.assertIs(batch.captures[0].kind, BrowserCaptureKind.RESPONSE)
        self.assertEqual(batch.captures[0].stream.chunks, (body,))
        context = factory.process.context
        self.assertIsNotNone(context)
        assert context is not None
        self.assertEqual(context.responses[0].body_reads, 0)
        self.assertEqual(download.content_reads, 1)
        self.assertEqual(download.delete_calls, 1)

    def test_rejected_pdf_navigation_reservation_is_logged_as_discard(self) -> None:
        pdf_url = "https://download.test/rejected.pdf"
        download = _FakeDownload(pdf_url, b"%PDF-rejected-native-download")
        factory = _FakeFactory(configured_download=download)
        client = BrowserClient(
            factory=factory,
            resolver=self.resolver,
            coordinator=AccessCoordinator(),
            destination_policy=_PUBLIC_POLICY,
        )

        with self.assertLogs("sciretriever.network.browser", level="DEBUG") as logs:
            result = client.run(
                self.scope,
                pdf_url,
                self.policy,
                capture_policy=_CapturePolicy(set()),
            )

        self.assertEqual(_failure(result).code, "no-download")
        context = factory.process.context
        self.assertIsNotNone(context)
        assert context is not None
        self.assertEqual(context.responses[0].body_reads, 0)
        self.assertEqual(download.content_reads, 0)
        self.assertEqual(download.delete_calls, 1)
        transcript = "\n".join(logs.output)
        self.assertIn("outcome=pending-discard", transcript)
        self.assertNotIn("outcome=pending-candidate", transcript)

    def test_cleanup_waits_for_inflight_duplicate_download_callback(self) -> None:
        pdf_url = "https://landing.test/article.pdf"
        body = b"%PDF-inflight-duplicate"
        delete_started = threading.Event()
        release_delete = threading.Event()
        controller_returning = threading.Event()
        run_finished = threading.Event()

        class _BlockingBlobDownload(_FakeDownload):
            def delete(self) -> None:
                delete_started.set()
                if not release_delete.wait(1.0):
                    raise RuntimeError("fixture download cleanup was not released")
                super().delete()

        blob_download = _BlockingBlobDownload(
            "blob:https://landing.test/inflight-download",
            body,
        )
        factory = _FakeFactory()
        client = BrowserClient(
            factory=factory,
            resolver=self.resolver,
            coordinator=AccessCoordinator(),
            destination_policy=_PUBLIC_POLICY,
        )
        policy = _CapturePolicy({(pdf_url, BrowserCaptureKind.RESPONSE, "application/pdf")})
        callback_threads: list[threading.Thread] = []

        def fetch_then_download(_session: object) -> None:
            context = factory.process.context
            self.assertIsNotNone(context)
            assert context is not None
            page = context.pages[0]
            route = context.begin_request(pdf_url, page, navigation=False)
            response = _FakeResponse(
                route.request,
                body=body,
                media_type="application/pdf",
                download_expected=True,
                attachment_download=True,
            )
            context.responses.append(response)
            for handler in context.handlers.get("response", ()):
                handler(response)
            callback = threading.Thread(
                target=context.download,
                args=(blob_download,),
                daemon=True,
            )
            callback_threads.append(callback)
            callback.start()
            self.assertTrue(delete_started.wait(0.5))
            context.finish_request(route)
            controller_returning.set()

        results: list[object] = []

        def run() -> None:
            try:
                results.append(
                    client.run(
                        self.scope,
                        "https://landing.test/start",
                        self.policy,
                        controller=_FlowController(fetch_then_download),
                        capture_policy=policy,
                    )
                )
            finally:
                run_finished.set()

        worker = threading.Thread(target=run, daemon=True)
        worker.start()
        controller_was_returning = controller_returning.wait(1.0)
        finished_before_release = run_finished.wait(0.05) if controller_was_returning else False
        release_delete.set()
        worker.join(2.0)
        for callback in callback_threads:
            callback.join(1.0)

        self.assertTrue(controller_was_returning)
        self.assertFalse(finished_before_release)
        self.assertFalse(worker.is_alive())
        self.assertEqual(len(results), 1)
        batch = _captures(results[0])
        self.assertEqual(batch.captures[0].stream.chunks, (body,))
        self.assertEqual(blob_download.content_reads, 0)
        self.assertEqual(blob_download.delete_calls, 1)

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
        guard = _CapturePolicy(
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
                    capture_policy=guard,
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
        guard = _CapturePolicy({(response_url, BrowserCaptureKind.RESPONSE, "application/pdf")})
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
                    capture_policy=guard,
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

    def test_capture_policy_rejects_before_body_and_errors_fail_closed(self) -> None:
        response_url = "https://landing.test/start"
        fixture = _ResponseFixture(b"%PDF-must-not-be-read")
        for guard, expected_code in (
            (_CapturePolicy(set()), "no-download"),
            (
                _CapturePolicy(set(), error=RuntimeError("private policy sentinel")),
                "no-download",
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
                        capture_policy=guard,
                    )
                )

                self.assertEqual(failure.code, expected_code)
                self.assertNotIn("sentinel", repr(failure))
                assert factory.process.context is not None
                self.assertEqual(factory.process.context.responses[0].body_reads, 0)

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
        guard = _CapturePolicy({(response_url, BrowserCaptureKind.RESPONSE, "application/pdf")})
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
                    capture_policy=guard,
                    limits=BrowserOperationLimits(max_capture_bytes=4),
                )
            ).code,
            "no-download",
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
                "https://other.test/redirect",
                BrowserDestinationKind.NAVIGATION,
            ),
            (
                "subresource",
                _FakeFactory(subresources=("https://other.test/tracker.js",)),
                "https://other.test/tracker.js",
                BrowserDestinationKind.REQUEST,
            ),
            (
                "download",
                _FakeFactory(
                    configured_download=_FakeDownload(
                        "https://other.test/article.pdf",
                        b"blocked",
                    )
                ),
                "https://other.test/article.pdf",
                BrowserDestinationKind.REQUEST,
            ),
        )
        for name, factory, expected_url, expected_kind in cases:
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

    def test_destination_guard_covers_request_and_download_capture(self) -> None:
        factory = _FakeFactory(
            configured_download=_FakeDownload(
                "https://download.test/article.pdf?view=full",
                b"fixture",
            )
        )
        guard = _OriginGuard(
            "https://landing.test",
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
                BrowserDestinationKind.RESPONSE,
                BrowserDestinationKind.DOWNLOAD,
            }
            <= kinds
        )
        self.assertTrue(all("?" not in url for url, _kind in guard.calls))

    def test_download_oversize_is_bounded(self) -> None:
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
                limits=BrowserOperationLimits(max_capture_bytes=4),
            )
        )
        self.assertEqual(oversized_result.code, "no-download")

    def test_control_observation_enumerates_article_surfaces_and_clears_after_cleanup(
        self,
    ) -> None:
        observed: list[BrowserObservation] = []
        retained_control: list[_ControlDriver] = []

        def inspect_flow(session: object) -> None:
            control = cast(_ControlDriver, getattr(session, "_control_driver")())
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
        self.assertEqual(len(observation.surfaces), 4)
        self.assertEqual(
            {surface.kind for surface in observation.surfaces},
            {
                BrowserSurfaceKind.PAGE,
                BrowserSurfaceKind.FRAME,
                BrowserSurfaceKind.SHADOW,
                BrowserSurfaceKind.VIEWER,
            },
        )
        self.assertEqual(len(observation.elements), 3)
        self.assertEqual(observation.page_id, observation.screenshot.page_id)
        control_state = getattr(getattr(retained_control[0], "_state"), "control")
        self.assertIsNone(control_state.ledger.current)
        self.assertIsNone(control_state.observation)
        self.assertEqual(control_state.page_keys, {})
        self.assertEqual(control_state.surface_keys, {})
        self.assertEqual(control_state.element_keys, {})

    def test_production_agent_waits_for_delayed_page_change_before_stopping(self) -> None:
        settled_clicks = 0

        def clear_challenge(turn: int, page: _FakePage, _context: _FakeContext) -> None:
            if turn != 1:
                return

            def reveal(selected: _FakePage) -> None:
                nonlocal settled_clicks
                click_count = sum(call[0] == "click-element" for call in selected.control_calls)
                if click_count <= settled_clicks:
                    return
                settled_clicks = click_count
                selected.url = "https://landing.test/article"
                selected.challenge = False
                selected.control_generation += 1

            page.control_wait_hook = reveal

        result, controller, adapter, factory, _guard, facts = self._run_production_agent(
            actions=("click", "stop"),
            start_url="https://landing.test/challenge",
            configure=clear_challenge,
        )

        self.assertEqual(_failure(result).code, "no-download")
        outcome = controller.result
        self.assertIsNotNone(outcome)
        assert outcome is not None
        self.assertIsInstance(outcome.step, BrowserBlocked)
        self.assertIs(outcome.blocked_reason, BrowserBlockedReason.STOPPED)
        self.assertIs(outcome.page_state, BrowserPageState.NORMAL)
        self.assertEqual(outcome.action_count, 2)
        self.assertEqual(outcome.model_call_count, 2)
        self.assertEqual(len(adapter.summaries), 2)
        self.assertEqual(adapter.summaries[0]["page_state"], "normal")
        self.assertEqual(adapter.summaries[1]["page_state"], "normal")
        transition = adapter.summaries[1]["previous_transition"]
        self.assertIsInstance(transition, dict)
        assert isinstance(transition, dict)
        self.assertIs(transition["semantic_changed"], True)
        context = factory.process.context
        self.assertIsNotNone(context)
        assert context is not None
        control_calls = [call[0] for call in context.pages[0].control_calls]
        self.assertEqual(control_calls.count("click-element"), 1)
        click_index = control_calls.index("click-element")
        self.assertEqual(control_calls[:click_index], ["wait-for-change", "wait-for-change"])
        # One wait observes the delayed successor, a second proves that
        # successor quiet, and the next apply refreshes the stable binding
        # before the Agent's Stop action is accepted.
        self.assertGreaterEqual(len(control_calls[click_index + 1 :]), 3)
        self.assertTrue(all(call == "wait-for-change" for call in control_calls[click_index + 1 :]))
        self.assertIs(facts.page_state, BrowserPageState.NORMAL)
        self.assertEqual(context.pages[0].close_calls, 1)
        self.assertEqual(context.close_calls, 1)
        self.assertEqual(factory.process.close_calls, 1)

    def test_bootstrap_production_route_runs_the_agent_and_fake_vendor_chain(self) -> None:
        import sciretriever.bootstrap as bootstrap
        import sciretriever.bootstrap.assembly as bootstrap_assembly
        from sciretriever.acquisition.outcomes import RouteOutcome
        from sciretriever.acquisition.ports import (
            AcquisitionExpectedFacts,
            AcquisitionRequest,
            CandidateKeyTracker,
        )
        from sciretriever.acquisition.registry import AcquisitionRegistry
        from sciretriever.acquisition.routes import RouteExecutionContext
        from sciretriever.acquisition.routing import build_acquisition_evidence
        from sciretriever.configuration import initialize_browser_profile, parse_configuration
        from sciretriever.configuration.cloak_runtime import (
            CLOAKBROWSER_BROWSER_VERSION,
            CloakRuntimeStatus,
        )
        from sciretriever.literature.content import metadata_sha256
        from sciretriever.model.acquisition import AssetHint, AssetHintKind
        from sciretriever.model.literature import Literature, LiteratureStatus, VersionRole
        from sciretriever.model.metadata import LiteratureMetadata, MetadataObservation
        from sciretriever.model.primitives import (
            LiteratureId,
            MetaLiteratureId,
            ObservationId,
            ProvenanceId,
            Sha256,
            SourceKind,
            UtcTimestamp,
        )
        from sciretriever.model.provenance import Provenance
        from sciretriever.network.cloakbrowser import CloakBrowserRuntimeAvailability

        def fixture_id(index: int) -> str:
            return f"{index:08d}-0000-4000-8000-000000000000"

        start_url = "https://pubs.rsc.org/en/content/articlelanding/2026/fixture"
        runtime_adapter = _ScriptedBrowserAgent(("click", "stop"))
        runtime = _browser_agent_runtime(runtime_adapter)
        factory = _FakeFactory()
        graph: bootstrap.DatabaseCompletionObjectGraph | None = None

        with tempfile.TemporaryDirectory(
            prefix="sciretriever-browser-bootstrap-fixture-"
        ) as temporary:
            root = Path(temporary)
            profile_home = root / "home"
            profile_home.mkdir(mode=0o700)
            initialize_browser_profile("fixture-profile", home=profile_home)
            configuration = parse_configuration(
                f"""
                [paths]
                catalog_path = {str(root / "catalog.sqlite3")!r}
                artifact_root = {str(root / "artifacts")!r}
                [providers.fixture-agents]
                api = "openai-responses"
                base_url = "http://127.0.0.1:8765/v1"
                [models."fixture-agents/browser-model"]
                reasoning = "default"
                image = true
                [browser]
                model = "fixture-agents/browser-model"
                enabled = true
                profile = "fixture-profile"
                """
            )
            ready_runtime = CloakRuntimeStatus(
                presence="configured",
                ready=True,
                version=CLOAKBROWSER_BROWSER_VERSION,
                signature_verified=True,
            )
            availability = CloakBrowserRuntimeAvailability(
                cloak_wrapper_available=True,
                playwright_api_available=True,
                binary_executable_available=True,
                headed_display_available=True,
                browser_version=CLOAKBROWSER_BROWSER_VERSION,
            )
            with (
                mock.patch.object(
                    bootstrap_assembly,
                    "_build_agents_runtime",
                    return_value=runtime,
                ),
                mock.patch(
                    "sciretriever.bootstrap.browser.CloakRuntimeManager.status",
                    return_value=ready_runtime,
                ),
                mock.patch(
                    "sciretriever.bootstrap.browser.cloakbrowser_runtime_availability",
                    return_value=availability,
                ),
                mock.patch(
                    "sciretriever.bootstrap.browser.CloakBrowserFactory",
                    return_value=factory,
                ),
                mock.patch(
                    "sciretriever.network.http.SystemResolver.resolve",
                    return_value=("93.184.216.34",),
                ),
            ):
                graph = cast(
                    bootstrap.DatabaseCompletionObjectGraph,
                    bootstrap.build_production_object_graph(
                        configuration,
                        scope=bootstrap.ProductionEntryScope.ASSET_COMPLETION,
                        credentials_home=profile_home,
                        configure_process_logging=False,
                    ),
                )

                literature = Literature(
                    literature_id=LiteratureId(fixture_id(1)),
                    meta_literature_id=MetaLiteratureId(fixture_id(2)),
                    version_role=VersionRole.PUBLISHED,
                    metadata=LiteratureMetadata(title="Bootstrap Browser fixture"),
                    status=LiteratureStatus.UNREVIEWED,
                )
                observed_at = UtcTimestamp("2026-09-03T00:00:00Z")
                observation = MetadataObservation(
                    observation_id=ObservationId(fixture_id(3)),
                    provenance=Provenance(
                        provenance_id=ProvenanceId(fixture_id(4)),
                        source_kind=SourceKind.METADATA_PROVIDER,
                        source_name="crossref",
                        source_record_id="bootstrap-browser-fixture",
                        observed_at=observed_at,
                        input_sha256=Sha256("a" * 64),
                        parameters_sha256=None,
                    ),
                    metadata=LiteratureMetadata(title="Bootstrap Browser fixture"),
                    asset_hints=(AssetHint(url=start_url, kind=AssetHintKind.LANDING_PAGE),),
                )
                request = AcquisitionRequest(
                    literature=literature,
                    expected_facts=AcquisitionExpectedFacts(
                        literature_id=literature.literature_id,
                        meta_literature_id=literature.meta_literature_id,
                        metadata_revision=1,
                        metadata_sha256=metadata_sha256(literature.metadata),
                        expected_no_primary_pdf=True,
                    ),
                    observations=(observation,),
                )
                registry = cast(AcquisitionRegistry, graph.acquisition_registry)
                binding = registry.route_registry.binding_for("browser:generic")
                route = cast(Any, binding.adapter)
                self.assertIsNotNone(route)
                self.assertIs(route._runner._client, graph.browser_client)
                self.assertIs(route._agent_runtime, runtime)

                results = tuple(
                    route.execute(
                        RouteExecutionContext(
                            request=request,
                            evidence=build_acquisition_evidence(request),
                            route_hints=(),
                            candidate_keys=CandidateKeyTracker(),
                        )
                    )
                )

                self.assertEqual(len(results), 1)
                self.assertIs(results[0].outcome, RouteOutcome.NORMAL_MISS)
                self.assertEqual(len(runtime_adapter.calls), 2)
                context = factory.process.context
                self.assertIsNotNone(context)
                assert context is not None
                control_calls = [
                    call[0]
                    for call in context.pages[0].control_calls
                    if call[0] in {"click-element", "wait-for-change"}
                ]
                self.assertEqual(control_calls.count("click-element"), 1)
                self.assertGreaterEqual(control_calls.count("wait-for-change"), 3)
                self.assertEqual(control_calls[:2], ["wait-for-change", "wait-for-change"])
                self.assertEqual(context.pages[0].close_calls, 1)
            assert graph is not None
            graph.close()

        context = factory.process.context
        self.assertIsNotNone(context)
        assert context is not None
        self.assertEqual(context.close_calls, 1)
        self.assertEqual(factory.process.close_calls, 1)

    def test_production_agent_allows_first_self_edge_then_stops_self_and_cycle_repeats(
        self,
    ) -> None:
        cases = (
            (
                "self",
                None,
                BrowserBlockedReason.REPEATED_SELF_TRANSITION,
                2,
                1,
            ),
            (
                "cycle",
                (1, 0),
                BrowserBlockedReason.REPEATED_CYCLE_EDGE,
                3,
                2,
            ),
        )
        for name, generations, blocked_reason, calls, dispatches in cases:
            with self.subTest(case=name):
                pending = [] if generations is None else list(generations)
                settled_clicks = 0

                def configure(
                    turn: int,
                    page: _FakePage,
                    _context: _FakeContext,
                ) -> None:
                    if turn != 1 or generations is None:
                        return

                    def toggle(selected: _FakePage) -> None:
                        nonlocal settled_clicks
                        click_count = sum(
                            call[0] == "click-element" for call in selected.control_calls
                        )
                        if click_count <= settled_clicks:
                            return
                        settled_clicks = click_count
                        if pending:
                            selected.control_generation = pending.pop(0)

                    page.control_wait_hook = toggle

                result, controller, adapter, factory, _guard, _facts = self._run_production_agent(
                    actions=("click",),
                    configure=configure,
                )

                self.assertEqual(_failure(result).code, "no-download")
                outcome = controller.result
                self.assertIsNotNone(outcome)
                assert outcome is not None
                self.assertIsInstance(outcome.step, BrowserFailed)
                assert outcome.failure is not None
                self.assertEqual(outcome.failure.code, "controller-safety-limit")
                self.assertEqual(outcome.model_call_count, 32)
                self.assertEqual(outcome.action_count, 32)
                self.assertEqual(len(adapter.calls), 32)
                context = factory.process.context
                self.assertIsNotNone(context)
                assert context is not None
                vendor_actions = [
                    call[0] for call in context.pages[0].control_calls if call[0] == "click-element"
                ]
                self.assertEqual(len(vendor_actions), 32)
                self.assertEqual(context.pages[0].close_calls, 1)
                self.assertEqual(context.close_calls, 1)
                self.assertEqual(factory.process.close_calls, 1)

    def test_production_agent_candidate_is_captured_or_times_out_from_vendor_events(
        self,
    ) -> None:
        candidate_url = "https://download.test/article.pdf"
        for candidate_outcome in ("captured", "timeout"):
            with self.subTest(outcome=candidate_outcome):
                download = _FakeDownload(candidate_url, b"%PDF-agent-candidate")
                completed = [False]

                def configure(
                    turn: int,
                    page: _FakePage,
                    context: _FakeContext,
                ) -> None:
                    if turn != 1:
                        return

                    def reserve(selected: _FakePage) -> None:
                        route = context.begin_request(
                            candidate_url,
                            selected,
                            navigation=False,
                        )
                        response = _FakeResponse(
                            route.request,
                            media_type="application/pdf",
                            download_expected=True,
                            attachment_download=True,
                        )
                        context.responses.append(response)
                        for handler in context.handlers.get("response", ()):
                            handler(response)
                        if candidate_outcome == "captured":
                            download.request = route.request
                            context.download(download)
                            context.finish_request(route)
                            completed[0] = True

                    page.control_click_hook = reserve

                result, controller, adapter, factory, _guard, _facts = self._run_production_agent(
                    actions=("click", "stop"),
                    configure=configure,
                    limits=BrowserOperationLimits(
                        capture_wait_timeout_seconds=0.01,
                    ),
                )
                outcome = controller.result
                self.assertIsNotNone(outcome)
                assert outcome is not None
                if candidate_outcome == "captured":
                    self.assertIsInstance(result, BrowserCaptureBatch)
                    self.assertIsInstance(outcome.step, BrowserBlocked)
                    self.assertIs(outcome.blocked_reason, BrowserBlockedReason.STOPPED)
                    self.assertIs(outcome.capture_state, BrowserCaptureState.NONE)
                    self.assertTrue(completed[0])
                    self.assertEqual(download.body, b"%PDF-agent-candidate")
                else:
                    self.assertEqual(_failure(result).code, "capture-timeout")
                    self.assertIsInstance(outcome.step, BrowserBlocked)
                    self.assertIs(
                        outcome.blocked_reason,
                        BrowserBlockedReason.STOPPED,
                    )
                    self.assertIs(outcome.capture_state, BrowserCaptureState.NONE)
                    self.assertFalse(completed[0])
                self.assertEqual(len(adapter.calls), 2)
                context = factory.process.context
                self.assertIsNotNone(context)
                assert context is not None
                self.assertEqual(context.pages[0].close_calls, 1)
                self.assertEqual(context.close_calls, 1)
                self.assertEqual(factory.process.close_calls, 1)

    def test_capture_survives_snapshot_runtime_failure_after_agent_action(self) -> None:
        candidate_url = "https://download.test/snapshot-race.pdf"
        body = b"%PDF-captured-before-snapshot-failure"

        def configure(
            turn: int,
            page: _FakePage,
            context: _FakeContext,
        ) -> None:
            if turn != 1:
                return

            def emit_candidate(selected: _FakePage) -> None:
                route = context.begin_request(candidate_url, selected, navigation=False)
                response = _FakeResponse(
                    route.request,
                    body=body,
                    media_type="application/pdf",
                    download_expected=True,
                    attachment_download=True,
                )
                context.responses.append(response)
                for handler in context.handlers.get("response", ()):
                    handler(response)
                # Any snapshot attempted after the capture is available is a
                # vendor runtime failure. Outcome-first settlement must return
                # the captured bytes without touching this failing snapshot.
                selected.control_snapshot_error = RuntimeError("snapshot-after-capture sentinel")
                context.finish_request(route)

            page.control_click_hook = emit_candidate

        result, controller, adapter, factory, _guard, _facts = self._run_production_agent(
            actions=("click", "stop"),
            configure=configure,
        )

        batch = _captures(result)
        self.assertEqual(batch.captures[0].stream.chunks, (body,))
        self.assertEqual(len(adapter.calls), 2)
        outcome = controller.result
        self.assertIsNotNone(outcome)
        assert outcome is not None
        self.assertIs(outcome.blocked_reason, BrowserBlockedReason.STOPPED)
        context = factory.process.context
        self.assertIsNotNone(context)
        assert context is not None
        self.assertEqual(context.pages[0].close_calls, 1)

    def test_production_agent_keeps_exploring_after_first_capture_and_returns_batch(self) -> None:
        candidates = (
            ("https://download.test/wrong.pdf", b"<html>wrong article</html>"),
            ("https://download.test/article.pdf", b"%PDF-valid-article"),
        )
        click_count = 0

        def configure(
            turn: int,
            page: _FakePage,
            context: _FakeContext,
        ) -> None:
            del turn

            def emit_candidate(selected: _FakePage) -> None:
                nonlocal click_count
                click_count += 1
                if click_count > len(candidates):
                    return
                url, body = candidates[click_count - 1]
                route = context.begin_request(url, selected, navigation=False)
                response = _FakeResponse(
                    route.request,
                    media_type="application/pdf",
                    download_expected=True,
                    attachment_download=True,
                )
                context.responses.append(response)
                for handler in context.handlers.get("response", ()):
                    handler(response)
                download = _FakeDownload(url, body)
                download.request = route.request
                context.download(download)
                context.finish_request(route)

            page.control_click_hook = emit_candidate

        result, controller, adapter, factory, _guard, _facts = self._run_production_agent(
            actions=("click", "click", "stop"),
            configure=configure,
        )

        batch = _captures(result)
        self.assertEqual(
            tuple(capture.stream.chunks for capture in batch.captures),
            tuple((body,) for _url, body in candidates),
        )
        outcome = controller.result
        self.assertIsNotNone(outcome)
        assert outcome is not None
        self.assertIsInstance(outcome.step, BrowserBlocked)
        self.assertIs(outcome.blocked_reason, BrowserBlockedReason.STOPPED)
        self.assertEqual(outcome.action_count, 3)
        self.assertEqual(outcome.model_call_count, 3)
        self.assertEqual(len(adapter.calls), 3)
        context = factory.process.context
        self.assertIsNotNone(context)
        assert context is not None
        self.assertEqual(
            [call[0] for call in context.pages[0].control_calls].count("click-element"),
            2,
        )
        self.assertEqual(context.pages[0].close_calls, 1)
        self.assertEqual(context.close_calls, 1)
        self.assertEqual(factory.process.close_calls, 1)

    def test_deferred_candidate_read_failure_is_local_and_next_action_can_capture(self) -> None:
        first_url = "https://download.test/deferred-wrong.pdf"
        second_url = "https://download.test/deferred-valid.pdf"
        responses: list[_FakeResponse] = []
        click_count = 0

        class _Policy:
            def __init__(self) -> None:
                self.first_reviewed = False

            def decide(self, evidence: BrowserCaptureEvidence) -> BrowserCaptureDecision:
                if evidence.locator == first_url:
                    if not self.first_reviewed:
                        self.first_reviewed = True
                        return BrowserCaptureDecision.DEFER
                    return BrowserCaptureDecision.ACCEPT
                if evidence.locator == second_url:
                    return BrowserCaptureDecision.ACCEPT
                return BrowserCaptureDecision.REJECT

        def configure(
            turn: int,
            page: _FakePage,
            context: _FakeContext,
        ) -> None:
            del turn

            def emit_candidate(selected: _FakePage) -> None:
                nonlocal click_count
                click_count += 1
                url = first_url if click_count == 1 else second_url
                body = None if click_count == 1 else b"%PDF-deferred-valid"
                route = context.begin_request(url, selected, navigation=False)
                response = _FakeResponse(
                    route.request,
                    body=body,
                    media_type="application/pdf",
                )
                responses.append(response)
                for handler in context.handlers.get("response", ()):
                    handler(response)

            page.control_click_hook = emit_candidate

        result, controller, adapter, factory, _guard, _facts = self._run_production_agent(
            actions=("click", "click", "stop"),
            configure=configure,
            capture_policy_override=_Policy(),
        )

        batch = _captures(result)
        self.assertEqual(
            tuple(capture.stream.chunks for capture in batch.captures),
            ((b"%PDF-deferred-valid",),),
        )
        self.assertEqual(len(responses), 2)
        self.assertEqual(responses[0].body_reads, 1)
        self.assertEqual(responses[1].body_reads, 1)
        outcome = controller.result
        self.assertIsNotNone(outcome)
        assert outcome is not None
        self.assertIs(outcome.blocked_reason, BrowserBlockedReason.STOPPED)
        self.assertEqual(outcome.action_count, 3)
        self.assertEqual(outcome.model_call_count, 3)
        self.assertEqual(len(adapter.calls), 3)
        context = factory.process.context
        self.assertIsNotNone(context)
        assert context is not None
        self.assertEqual(context.pages[0].close_calls, 1)
        self.assertEqual(context.close_calls, 1)
        self.assertEqual(factory.process.close_calls, 1)

    def test_production_agent_specific_vendor_failure_and_cancellation_are_typed(self) -> None:
        private_error = "https://private.invalid/?token=VENDOR-SECRET"

        def fail_vendor(turn: int, page: _FakePage, _context: _FakeContext) -> None:
            if turn != 1:
                return

            def fail(_selected: _FakePage) -> None:
                raise RuntimeError(private_error)

            page.control_wait_hook = fail

        with self.assertLogs("sciretriever", level="DEBUG") as failure_logs:
            result, controller, adapter, factory, _guard, _facts = self._run_production_agent(
                actions=("click",),
                configure=fail_vendor,
            )
        self.assertEqual(_failure(result).code, "no-download")
        failure = controller.result
        self.assertIsNotNone(failure)
        assert failure is not None
        self.assertIsInstance(failure.step, BrowserFailed)
        self.assertIsNotNone(failure.failure)
        assert failure.failure is not None
        self.assertEqual(
            failure.failure.code,
            "acquisition-browser-agent-action-failed",
        )
        self.assertTrue(failure.failure.retryable)
        self.assertEqual(len(adapter.calls), 1)
        self.assertNotIn(private_error, "\n".join(failure_logs.output))
        context = factory.process.context
        self.assertIsNotNone(context)
        assert context is not None
        self.assertEqual(context.pages[0].close_calls, 1)
        self.assertEqual(context.close_calls, 1)
        self.assertEqual(factory.process.close_calls, 1)

        cancel_event = threading.Event()

        def cancel(turn: int, _page: _FakePage, _context: _FakeContext) -> None:
            if turn == 1:
                cancel_event.set()

        cancelled_result, cancelled, cancelled_adapter, cancelled_factory, _guard, _facts = (
            self._run_production_agent(
                actions=("click",),
                configure=cancel,
                cancel_event=cancel_event,
            )
        )
        self.assertEqual(_failure(cancelled_result).code, "cancelled")
        cancelled_outcome = cancelled.result
        self.assertIsNotNone(cancelled_outcome)
        assert cancelled_outcome is not None
        self.assertIsInstance(cancelled_outcome.step, BrowserCancelled)
        self.assertEqual(len(cancelled_adapter.calls), 1)
        cancelled_context = cancelled_factory.process.context
        self.assertIsNotNone(cancelled_context)
        assert cancelled_context is not None
        self.assertEqual(cancelled_context.pages[0].close_calls, 1)
        self.assertEqual(cancelled_context.close_calls, 1)
        self.assertEqual(cancelled_factory.process.close_calls, 1)

    def test_production_agent_safety_fuse_stops_unique_vendor_transitions(self) -> None:
        settled_clicks = 0

        def advance(turn: int, page: _FakePage, _context: _FakeContext) -> None:
            if turn != 1:
                return

            def mutate(selected: _FakePage) -> None:
                nonlocal settled_clicks
                click_count = sum(call[0] == "click-element" for call in selected.control_calls)
                if click_count <= settled_clicks:
                    return
                settled_clicks = click_count
                selected.control_generation += 1

            page.control_wait_hook = mutate

        result, controller, adapter, factory, _guard, _facts = self._run_production_agent(
            actions=("click",),
            configure=advance,
        )

        self.assertEqual(_failure(result).code, "no-download")
        outcome = controller.result
        self.assertIsNotNone(outcome)
        assert outcome is not None
        self.assertIsInstance(outcome.step, BrowserFailed)
        self.assertIsNotNone(outcome.failure)
        assert outcome.failure is not None
        self.assertEqual(outcome.failure.code, "controller-safety-limit")
        self.assertEqual(outcome.model_call_count, 32)
        self.assertEqual(outcome.action_count, 32)
        self.assertEqual(len(adapter.calls), 32)
        context = factory.process.context
        self.assertIsNotNone(context)
        assert context is not None
        vendor_actions = [
            call[0] for call in context.pages[0].control_calls if call[0] == "click-element"
        ]
        self.assertEqual(len(vendor_actions), 32)
        self.assertEqual(context.pages[0].close_calls, 1)
        self.assertEqual(context.close_calls, 1)
        self.assertEqual(factory.process.close_calls, 1)

    def test_control_executes_six_closed_actions_and_returns_settled_transitions(self) -> None:
        transitions: list[object] = []
        vendor_calls: list[tuple[object, ...]] = []

        def action_flow(session: object) -> None:
            control = cast(_ControlDriver, getattr(session, "_control_driver")())
            observation = control.observe(page_state=BrowserPageState.NORMAL)
            enabled = next(
                element for element in observation.elements if element.name == "Download PDF"
            )
            enabled_surface = next(
                surface
                for surface in observation.surfaces
                if surface.surface_id == enabled.surface_id
            )
            transitions.append(
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
            transitions.append(
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
            transitions.append(
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
            transitions.append(
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
            transitions.append(
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
            observation = control.observe(page_state=BrowserPageState.NORMAL)
            transitions.append(
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
            tuple(type(transition) for transition in transitions),
            (
                BrowserSettledTransition,
                BrowserSettledTransition,
                BrowserSettledTransition,
                BrowserSettledTransition,
                BrowserSettledTransition,
                BrowserStoppedTransition,
            ),
        )
        self.assertEqual(
            tuple(getattr(transition, "receipt").outcome for transition in transitions),
            (
                BrowserActionOutcome.APPLIED,
                BrowserActionOutcome.APPLIED,
                BrowserActionOutcome.APPLIED,
                BrowserActionOutcome.APPLIED,
                BrowserActionOutcome.NO_CHANGE,
                BrowserActionOutcome.APPLIED,
            ),
        )
        self.assertEqual(
            tuple(call[0] for call in vendor_calls),
            (
                "click-element",
                "wait-for-change",
                "click-point",
                "wait-for-change",
                "scroll-surface",
                "wait-for-change",
                "go-back",
                "wait-for-change",
                "wait-for-change",
            ),
        )
        for call in vendor_calls:
            timeout = call[-1]
            if type(timeout) is not int:
                self.fail("vendor control timeout was not an integer")
            self.assertTrue(1 <= timeout <= 500, vendor_calls)

    def test_control_settle_waits_for_a_delayed_semantic_page_change(self) -> None:
        transitions: list[object] = []

        def action_flow(session: object) -> None:
            control = cast(_ControlDriver, getattr(session, "_control_driver")())
            observation = control.observe(page_state=BrowserPageState.CHALLENGE)
            element = next(value for value in observation.elements if value.name == "Download PDF")
            surface = next(
                value for value in observation.surfaces if value.surface_id == element.surface_id
            )
            context = self.factory.process.context
            assert context is not None
            page = context.pages[0]
            changed = False

            def reveal_cleared_challenge(selected: _FakePage) -> None:
                nonlocal changed
                if not changed:
                    selected.control_generation += 1
                    changed = True

            page.control_wait_hook = reveal_cleared_challenge
            transitions.append(
                control.execute(
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
            )

        result = _failure(
            self.client.run(
                self.scope,
                "https://landing.test/start",
                self.policy,
                controller=_FlowController(action_flow),
            )
        )

        self.assertEqual(result.code, "no-download")
        self.assertEqual(len(transitions), 1)
        transition = transitions[0]
        self.assertIsInstance(transition, BrowserSettledTransition)
        assert isinstance(transition, BrowserSettledTransition)
        self.assertTrue(transition.changed)
        context = self.factory.process.context
        assert context is not None
        page = context.pages[0]
        self.assertEqual(
            [call[0] for call in page.control_calls],
            ["click-element", "wait-for-change", "wait-for-change"],
        )
        self.assertGreaterEqual(page.control_snapshot_calls, 4)

    def test_control_settle_reobserves_after_a_transient_document_replacement(self) -> None:
        transitions: list[object] = []

        def action_flow(session: object) -> None:
            control = cast(_ControlDriver, getattr(session, "_control_driver")())
            observation = control.observe(page_state=BrowserPageState.CHALLENGE)
            element = next(value for value in observation.elements if value.name == "Download PDF")
            surface = next(
                value for value in observation.surfaces if value.surface_id == element.surface_id
            )
            context = self.factory.process.context
            assert context is not None
            page = context.pages[0]
            wait_count = 0

            def replace_document(selected: _FakePage) -> None:
                nonlocal wait_count
                wait_count += 1
                if wait_count == 1:
                    raise BrowserObservationUnavailable()
                if wait_count == 2:
                    selected.url = "https://landing.test/article"
                    selected.control_generation += 1

            page.control_wait_hook = replace_document
            transitions.append(
                control.execute(
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
            )

        result = _failure(
            self.client.run(
                self.scope,
                "https://landing.test/challenge",
                self.policy,
                controller=_FlowController(action_flow),
            )
        )

        self.assertEqual(result.code, "no-download")
        self.assertEqual(len(transitions), 1)
        transition = transitions[0]
        self.assertIsInstance(transition, BrowserSettledTransition)
        assert isinstance(transition, BrowserSettledTransition)
        self.assertTrue(transition.changed)
        self.assertEqual(transition.observation.surfaces[0].path, "/article")

    def test_control_settle_reports_timeout_when_transition_never_becomes_observable(
        self,
    ) -> None:
        transitions: list[object] = []

        def action_flow(session: object) -> None:
            control = cast(_ControlDriver, getattr(session, "_control_driver")())
            observation = control.observe(page_state=BrowserPageState.NORMAL)
            element = next(value for value in observation.elements if value.name == "Download PDF")
            surface = next(
                value for value in observation.surfaces if value.surface_id == element.surface_id
            )
            context = self.factory.process.context
            assert context is not None
            page = context.pages[0]

            def become_unobservable(selected: _FakePage) -> None:
                selected.control_snapshot_error = BrowserObservationUnavailable()

            page.control_click_hook = become_unobservable
            transitions.append(
                control.execute(
                    ClickElement(
                        observation.article_token,
                        surface.page_id,
                        surface.surface_id,
                        observation.revision,
                        element.element_id,
                    ),
                    observation,
                    timeout_seconds=0.02,
                )
            )

        result = _failure(
            self.client.run(
                self.scope,
                "https://landing.test/article",
                self.policy,
                controller=_FlowController(action_flow),
            )
        )

        self.assertEqual(result.code, "no-download")
        self.assertEqual(len(transitions), 1)
        transition = transitions[0]
        self.assertIsInstance(transition, BrowserFailedTransition)
        assert isinstance(transition, BrowserFailedTransition)
        self.assertEqual(
            transition.failure.code,
            "acquisition-browser-agent-action-timeout",
        )
        self.assertIsNotNone(transition.receipt)

    def test_control_settle_returns_latest_observation_when_page_never_becomes_quiet(
        self,
    ) -> None:
        transitions: list[object] = []
        before_revisions: list[int] = []

        def action_flow(session: object) -> None:
            control = cast(_ControlDriver, getattr(session, "_control_driver")())
            observation = control.observe(page_state=BrowserPageState.CHALLENGE)
            before_revisions.append(observation.revision)
            element = next(value for value in observation.elements if value.name == "Download PDF")
            surface = next(
                value for value in observation.surfaces if value.surface_id == element.surface_id
            )
            context = self.factory.process.context
            assert context is not None
            page = context.pages[0]

            def keep_changing(selected: _FakePage) -> None:
                selected.control_generation += 1

            page.control_wait_hook = keep_changing
            transitions.append(
                control.execute(
                    ClickElement(
                        observation.article_token,
                        surface.page_id,
                        surface.surface_id,
                        observation.revision,
                        element.element_id,
                    ),
                    observation,
                    timeout_seconds=0.02,
                )
            )

        result = _failure(
            self.client.run(
                self.scope,
                "https://landing.test/challenge",
                self.policy,
                controller=_FlowController(action_flow),
            )
        )

        self.assertEqual(result.code, "no-download")
        self.assertEqual(len(transitions), 1)
        transition = transitions[0]
        self.assertIsInstance(transition, BrowserSettledTransition)
        assert isinstance(transition, BrowserSettledTransition)
        self.assertTrue(transition.changed)
        self.assertIsNotNone(transition.receipt)
        self.assertGreater(transition.observation.revision, before_revisions[0])

    def test_control_settle_follows_an_article_owned_successor_page(self) -> None:
        transitions: list[object] = []
        successor_pages: list[_FakePage] = []

        def action_flow(session: object) -> None:
            control = cast(_ControlDriver, getattr(session, "_control_driver")())
            observation = control.observe(page_state=BrowserPageState.NORMAL)
            element = next(value for value in observation.elements if value.name == "Download PDF")
            surface = next(
                value for value in observation.surfaces if value.surface_id == element.surface_id
            )
            context = self.factory.process.context
            assert context is not None
            original = context.pages[0]

            def open_successor(selected: _FakePage) -> None:
                selected.close()
                successor = context.popup("https://landing.test/article/viewer")
                successor.control_generation = 3
                successor_pages.append(successor)

            original.control_click_hook = open_successor
            transitions.append(
                control.execute(
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
            )

        result = _failure(
            self.client.run(
                self.scope,
                "https://landing.test/article",
                self.policy,
                controller=_FlowController(action_flow),
            )
        )

        self.assertEqual(result.code, "no-download")
        self.assertEqual(len(successor_pages), 1)
        transition = transitions[0]
        self.assertIsInstance(transition, BrowserSettledTransition)
        assert isinstance(transition, BrowserSettledTransition)
        self.assertTrue(transition.changed)
        self.assertEqual(transition.observation.surfaces[0].path, "/article/viewer")
        assert transition.receipt is not None
        self.assertNotEqual(transition.receipt.page_id, transition.observation.page_id)

    def test_control_candidate_lifecycle_captures_clears_and_times_out(self) -> None:
        url = "https://download.test/candidate.pdf"
        cases = ("captured", "cleared", "timeout")
        for outcome in cases:
            with self.subTest(outcome=outcome):
                download = _FakeDownload(url, b"%PDF-candidate")
                factory = _FakeFactory()
                client = BrowserClient(
                    factory=factory,
                    resolver=self.resolver,
                    coordinator=AccessCoordinator(),
                    destination_policy=_PUBLIC_POLICY,
                )
                allowed = (
                    {(url, BrowserCaptureKind.DOWNLOAD, "application/pdf")}
                    if outcome == "captured"
                    else set()
                )
                deferred = (
                    {(url, BrowserCaptureKind.DOWNLOAD, "application/pdf")}
                    if outcome == "timeout"
                    else set()
                )
                guard = _CapturePolicy(allowed, deferred=deferred)
                transitions: list[object] = []
                pending_route: list[_FakeRoute] = []

                def candidate_flow(session: object) -> None:
                    control = cast(
                        _ControlDriver,
                        getattr(session, "_control_driver")(),
                    )
                    observation = control.observe(page_state=BrowserPageState.CHALLENGE)
                    element = next(
                        value for value in observation.elements if value.name == "Download PDF"
                    )
                    surface = next(
                        value
                        for value in observation.surfaces
                        if value.surface_id == element.surface_id
                    )
                    context = factory.process.context
                    assert context is not None
                    page = context.pages[0]

                    def reserve_candidate(selected: _FakePage) -> None:
                        route = context.begin_request(url, selected, navigation=False)
                        pending_route.append(route)
                        response = _FakeResponse(
                            route.request,
                            media_type="application/pdf",
                            download_expected=True,
                            attachment_download=True,
                        )
                        context.responses.append(response)
                        for handler in context.handlers.get("response", ()):
                            handler(response)
                        # Candidate settlement no longer refreshes the page
                        # snapshot while a response/download pair is pending.
                        # Emit the native event from the click itself so the
                        # fixture models the vendor event stream directly.
                        if outcome in {"captured", "cleared"}:
                            route = pending_route[0]
                            download.request = route.request
                            context.download(download)

                    page.control_click_hook = reserve_candidate
                    transitions.append(
                        control.execute(
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
                    )

                result = client.run(
                    self.scope,
                    "https://landing.test/start",
                    self.policy,
                    controller=_FlowController(candidate_flow),
                    capture_policy=cast(BrowserCapturePolicy, guard),
                    limits=BrowserOperationLimits(
                        capture_wait_timeout_seconds=0.01,
                    ),
                )

                self.assertEqual(len(transitions), 1)
                expected_type = {
                    # Captures that happen after an Agent action remain
                    # operation-local candidates; the controller continues
                    # until Stop/budget and the outer result carries the
                    # completed batch.
                    "captured": BrowserSettledTransition,
                    "cleared": BrowserSettledTransition,
                    "timeout": BrowserCandidateTimeoutTransition,
                }[outcome]
                self.assertIsInstance(transitions[0], expected_type)
                if outcome == "captured":
                    self.assertIsInstance(result, BrowserCaptureBatch)
                else:
                    expected_code = "capture-timeout" if outcome == "timeout" else "no-download"
                    self.assertEqual(_failure(result).code, expected_code)
                context = factory.process.context
                assert context is not None
                self.assertEqual(context.pages[0].close_calls, 1)
                self.assertEqual(context.close_calls, 1)
                self.assertEqual(factory.process.close_calls, 1)

    def test_control_settle_cancellation_and_vendor_failure_are_typed_and_cleaned_once(
        self,
    ) -> None:
        cases = ("cancelled", "vendor-failure")
        for outcome in cases:
            with self.subTest(outcome=outcome):
                factory = _FakeFactory()
                client = BrowserClient(
                    factory=factory,
                    resolver=self.resolver,
                    coordinator=AccessCoordinator(),
                    destination_policy=_PUBLIC_POLICY,
                )
                cancel_event = threading.Event()
                transitions: list[object] = []

                def action_flow(session: object) -> None:
                    control = cast(
                        _ControlDriver,
                        getattr(session, "_control_driver")(),
                    )
                    observation = control.observe(page_state=BrowserPageState.NORMAL)
                    element = next(
                        value for value in observation.elements if value.name == "Download PDF"
                    )
                    surface = next(
                        value
                        for value in observation.surfaces
                        if value.surface_id == element.surface_id
                    )
                    context = factory.process.context
                    assert context is not None
                    page = context.pages[0]

                    def terminal_wait(selected: _FakePage) -> None:
                        del selected
                        if outcome == "cancelled":
                            cancel_event.set()
                        else:
                            raise RuntimeError("vendor-private-sentinel")

                    page.control_wait_hook = terminal_wait
                    transitions.append(
                        control.execute(
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
                    )

                result = client.run(
                    self.scope,
                    "https://landing.test/start",
                    self.policy,
                    controller=_FlowController(action_flow),
                    cancel_event=cancel_event,
                )

                if outcome == "cancelled":
                    self.assertIsInstance(transitions[0], BrowserCancelledTransition)
                    self.assertEqual(_failure(result).code, "cancelled")
                else:
                    transition = transitions[0]
                    self.assertIsInstance(transition, BrowserFailedTransition)
                    assert isinstance(transition, BrowserFailedTransition)
                    self.assertEqual(
                        transition.failure.code,
                        "acquisition-browser-agent-action-failed",
                    )
                    self.assertNotIn("vendor-private-sentinel", repr(transition))
                    self.assertEqual(_failure(result).code, "no-download")
                context = factory.process.context
                assert context is not None
                self.assertEqual(context.pages[0].close_calls, 1)
                self.assertEqual(context.close_calls, 1)
                self.assertEqual(factory.process.close_calls, 1)

    def test_control_settle_reports_destination_policy_after_dispatched_action(
        self,
    ) -> None:
        factory = _FakeFactory()
        client = BrowserClient(
            factory=factory,
            resolver=self.resolver,
            coordinator=AccessCoordinator(),
            destination_policy=_PUBLIC_POLICY,
        )
        transitions: list[object] = []
        rejected_routes: list[_FakeRoute] = []

        def action_flow(session: object) -> None:
            control = cast(_ControlDriver, getattr(session, "_control_driver")())
            observation = control.observe(page_state=BrowserPageState.NORMAL)
            element = next(value for value in observation.elements if value.name == "Download PDF")
            surface = next(
                value for value in observation.surfaces if value.surface_id == element.surface_id
            )
            context = factory.process.context
            assert context is not None
            page = context.pages[0]

            def reject_transition(selected: _FakePage) -> None:
                request = _FakeRequest(
                    "https://other.test/unapproved",
                    selected,
                    navigation=True,
                    top_frame=True,
                )
                route = _FakeRoute(request)
                assert context.route_handler is not None
                context.route_handler(route)
                rejected_routes.append(route)

            page.control_wait_hook = reject_transition
            transitions.append(
                control.execute(
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
            )

        result = _failure(
            client.run(
                self.scope,
                "https://landing.test/start",
                self.policy,
                controller=_FlowController(action_flow),
                destination_guard=_OriginGuard("https://landing.test"),
            )
        )

        self.assertEqual(result.code, "no-download")
        self.assertEqual(len(rejected_routes), 1)
        self.assertTrue(rejected_routes[0].aborted)
        self.assertEqual(len(transitions), 1)
        transition = transitions[0]
        assert isinstance(transition, BrowserSettledTransition)
        self.assertIsNotNone(transition.receipt)

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
                transitions: list[object] = []
                snapshot_calls_before_execute: list[int] = []

                def rejected_flow(session: object) -> None:
                    control = cast(
                        _ControlDriver,
                        getattr(session, "_control_driver")(),
                    )
                    observation = control.observe(page_state=BrowserPageState.NORMAL)
                    context = factory.process.context
                    assert context is not None
                    snapshot_calls_before_execute.append(context.pages[0].control_snapshot_calls)
                    transitions.append(
                        control.execute(
                            build_action(name, observation),
                            observation,
                            timeout_seconds=0.5,
                        )
                    )

                result = _failure(
                    client.run(
                        self.scope,
                        "https://landing.test/start",
                        self.policy,
                        controller=_FlowController(rejected_flow),
                    )
                )
                self.assertEqual(result.code, "no-download")
                self.assertEqual(len(transitions), 1)
                transition = transitions[0]
                self.assertIsInstance(transition, BrowserFailedTransition)
                assert isinstance(transition, BrowserFailedTransition)
                self.assertEqual(
                    transition.failure.code,
                    "acquisition-browser-agent-action-rejected",
                )
                context = factory.process.context
                assert context is not None
                self.assertEqual(context.pages[0].control_calls, [])
                self.assertEqual(snapshot_calls_before_execute, [1])
                self.assertEqual(context.pages[0].control_snapshot_calls, 1)

    def test_control_returns_stale_before_dispatch_when_page_changed(self) -> None:
        transitions: list[object] = []

        def stale_flow(session: object) -> None:
            control = cast(_ControlDriver, getattr(session, "_control_driver")())
            observation = control.observe(page_state=BrowserPageState.NORMAL)
            element = next(value for value in observation.elements if value.name == "Download PDF")
            surface = next(
                value for value in observation.surfaces if value.surface_id == element.surface_id
            )
            context = self.factory.process.context
            assert context is not None
            context.pages[0].control_generation += 1
            transitions.append(
                control.execute(
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
            )

        result = _failure(
            self.client.run(
                self.scope,
                "https://landing.test/start",
                self.policy,
                controller=_FlowController(stale_flow),
            )
        )

        self.assertEqual(result.code, "no-download")
        self.assertEqual(len(transitions), 1)
        self.assertIsInstance(transitions[0], BrowserStaleTransition)
        context = self.factory.process.context
        assert context is not None
        self.assertEqual(context.pages[0].control_calls, [])

    def test_control_capture_receipt_uses_shared_download_pipeline(self) -> None:
        transitions: list[object] = []

        def capture_flow(session: object) -> None:
            context = self.factory.process.context
            assert context is not None
            context.pages[0].control_capture_url = "https://download.test/control.pdf"
            control = cast(_ControlDriver, getattr(session, "_control_driver")())
            observation = control.observe(page_state=BrowserPageState.NORMAL)
            element = next(value for value in observation.elements if value.name == "Download PDF")
            surface = next(
                value for value in observation.surfaces if value.surface_id == element.surface_id
            )
            transition = control.execute(
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
            transitions.append(transition)

        result = self.client.run(
            self.scope,
            "https://landing.test/start",
            self.policy,
            controller=_FlowController(capture_flow),
        )

        self.assertIsInstance(result, BrowserCaptureBatch)
        self.assertEqual(len(transitions), 1)
        self.assertIsInstance(transitions[0], BrowserSettledTransition)
        settled = cast(BrowserSettledTransition, transitions[0])
        self.assertIsNotNone(settled.receipt)
        assert settled.receipt is not None
        self.assertEqual(settled.receipt.outcome, BrowserActionOutcome.APPLIED)
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
        factory = _FakeFactory()
        client = BrowserClient(
            factory=factory,
            resolver=self.resolver,
            coordinator=AccessCoordinator(),
            destination_policy=_PUBLIC_POLICY,
        )
        seen: dict[str, object] = {}
        hidden = (
            "page",
            "context",
            "process",
            "route",
            "popups",
            "downloads",
            "click",
            "fill",
            "open_popup",
            "open_viewer",
            "open_verified_locator",
            "discover_pdf_locators",
            "has_selector",
            "text",
            "capture_available",
            "wait_for_capture",
            "wait_for_any_capture",
        )

        def flow(session: object) -> None:
            for name in hidden:
                try:
                    getattr(session, name)
                except AttributeError:
                    seen[name] = "hidden"
                else:
                    seen[name] = "exposed"
            self.assertTrue(callable(getattr(session, "browser_steps")))
            observation = cast(BrowserPageObservation, getattr(session, "observe")())
            self.assertEqual(observation.locator, "https://landing.test/start")
            self.assertEqual(observation.status_code, 200)
            self.assertEqual(observation.origin, "https://landing.test")
            self.assertEqual(observation.path, "/start")

        result = _failure(
            client.run(
                self.scope,
                "https://landing.test/start",
                self.policy,
                controller=_FlowController(flow),
            )
        )
        self.assertEqual(result.code, "no-download")
        self.assertEqual(set(seen), set(hidden))
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

        factory = _RotatingFakeFactory(first_configured_download=False)
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
            capture_policy=None,
            initial_locator=locator,
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
            resource=object(),
            lease=lease,
            evidence=BrowserCaptureEvidence(
                locator=self._LOCATOR,
                kind=BrowserCaptureKind.RESPONSE,
                media_type="application/pdf",
                correlation=BrowserCaptureCorrelation.DIRECT_REQUEST,
                request_navigation=False,
                from_exact_start=False,
                redirect_depth=0,
                native_download=True,
            ),
        )
        state.pending_response_downloads[destination.url.url] = pending
        state.request_leases[id(request)] = lease
        download = _DownloadProbe(self._LOCATOR)
        plan = self._plan(state, download)
        self.assertIsNotNone(plan)
        assert plan is not None
        self.assertIs(plan.lease.request, request)
        self.assertEqual(download.body_reads, 0)


if __name__ == "__main__":
    unittest.main()
