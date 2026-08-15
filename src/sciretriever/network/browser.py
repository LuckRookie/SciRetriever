"""A bounded, policy-checked browser boundary.

The browser is deliberately driven by an injected factory.  The Network
module never imports or constructs a browser vendor runtime, which keeps unit
tests offline and leaves the concrete Playwright (or other) adapter at the
bootstrap boundary.  Provider-specific selectors, click sequences and login
decisions are supplied by a private ``flow`` callback; no browser object or
callback result crosses this module's neutral result boundary.
"""

from __future__ import annotations

import hashlib
import os
import stat
import tempfile
import threading
import time
import unicodedata
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from enum import Enum, unique
from pathlib import Path
from typing import Final, Protocol, TypeAlias, cast, runtime_checkable
from urllib.parse import urlsplit, urlunsplit

from sciretriever.model.access import (
    AccessFailure,
    BoundedByteStream,
    BrowserCapture,
    BrowserCaptureBatch,
    BrowserCaptureKind,
    BrowserRequest,
    BrowserResult,
)

from .admission import (
    AccessCancelled,
    AccessCoordinator,
    AccessPermit,
    AccessPolicy,
    AccessScope,
    AdmissionTimeout,
    HostPermit,
)
from .browser_sessions import (
    BrowserSessionBroker,
    BrowserSessionCancelled,
    BrowserSessionError,
    BrowserSessionLease,
    BrowserSessionTimeout,
)
from .policy import (
    DestinationPolicy,
    PolicyError,
    ResolvedDestination,
    ResolverLike,
    normalize_url,
    normalize_url_with_configured_port,
    resolve_destination,
)

Clock: TypeAlias = Callable[[], float]
BrowserFactory: TypeAlias = Callable[..., object]

_DEFAULT_TIMEOUT_SECONDS: Final[float] = 60.0
_DEFAULT_MAX_RESPONSE_BYTES: Final[int] = 16 * 1024 * 1024
_DEFAULT_MAX_NAVIGATIONS: Final[int] = 16
_DEFAULT_MAX_REQUESTS: Final[int] = 256
_DEFAULT_MAX_POPUPS: Final[int] = 8
_DEFAULT_MAX_DOWNLOADS: Final[int] = 4
_DEFAULT_MAX_CAPTURES: Final[int] = 4
_DEFAULT_MAX_BYTES_PER_DOWNLOAD: Final[int] = 64 * 1024 * 1024
_DEFAULT_MAX_TOTAL_BYTES: Final[int] = 128 * 1024 * 1024
_DEFAULT_MAX_TOTAL_SECONDS: Final[float] = 60.0
_INTERNAL_SCHEMES = frozenset({"about"})
_CHALLENGE_MARKERS = (
    "captcha",
    "verify you are human",
    "checking your browser",
    "just a moment",
    "challenge-platform",
    "access denied",
    "security check",
)


class BrowserError(RuntimeError):
    """Stable error for invalid Browser runtime construction."""


@unique
class BrowserDestinationKind(str, Enum):
    """One Browser destination use checked by an injected closed rule."""

    INITIAL_NAVIGATION = "initial-navigation"
    NAVIGATION = "navigation"
    REQUEST = "request"
    POPUP = "popup"
    RESPONSE = "response"
    DOWNLOAD = "download"


@runtime_checkable
class BrowserDestinationGuard(Protocol):
    """Secret-free guard evaluated before one Browser destination performs I/O.

    Network owns generic URL, DNS, address, host-admission and resource policy.
    This additional hook can only reject a normalized, query-free locator; it
    cannot weaken any Network decision or receive a Browser vendor object.
    """

    def check(self, url: str, kind: BrowserDestinationKind) -> None: ...


@runtime_checkable
class BrowserCaptureGuard(Protocol):
    """Provider rule deciding whether an already-admitted body may be captured."""

    def allows(
        self,
        url: str,
        kind: BrowserCaptureKind,
        media_type: str,
    ) -> bool: ...


@runtime_checkable
class BrowserFlowSession(Protocol):
    """Capability-only flow surface shared with reviewed Acquisition rules."""

    def click(self, selector: str) -> None: ...

    def open_viewer(self, locator: str) -> None: ...

    def open_verified_locator(self, locator: str) -> None: ...

    def wait_for_capture(self, kind: BrowserCaptureKind) -> None: ...

    def text(self, selector: str) -> str: ...

    def observe(self) -> BrowserPageObservation: ...


@dataclass(frozen=True, slots=True, repr=False)
class BrowserPageObservation:
    """A bounded, query-free snapshot available to a provider page rule."""

    locator: str = field(repr=False)
    status_code: int | None

    def __post_init__(self) -> None:
        if not isinstance(self.locator, str):
            raise TypeError("locator must be a string")
        try:
            normalized = normalize_url_with_configured_port(self.locator)
        except (PolicyError, TypeError, ValueError):
            raise ValueError("locator must be a safe query-free HTTP(S) URL") from None
        if normalized.query:
            raise ValueError("locator must not contain a query")
        object.__setattr__(self, "locator", normalized.url)
        if self.status_code is not None and (
            type(self.status_code) is not int or not 100 <= self.status_code <= 599
        ):
            raise ValueError("status_code must be an HTTP status or None")

    @property
    def origin(self) -> str:
        return normalize_url_with_configured_port(self.locator).origin.text

    @property
    def path(self) -> str:
        return normalize_url_with_configured_port(self.locator).path

    def __reduce__(self) -> str | tuple[object, ...]:
        raise TypeError("BrowserPageObservation cannot be serialized")


@dataclass(frozen=True, slots=True)
class BrowserBudget:
    """Hard per-flow Browser resource limits."""

    max_navigations: int = _DEFAULT_MAX_NAVIGATIONS
    max_requests: int = _DEFAULT_MAX_REQUESTS
    max_popups: int = _DEFAULT_MAX_POPUPS
    max_downloads: int = _DEFAULT_MAX_DOWNLOADS
    max_captures: int = _DEFAULT_MAX_CAPTURES
    max_bytes_per_download: int = _DEFAULT_MAX_BYTES_PER_DOWNLOAD
    max_total_bytes: int = _DEFAULT_MAX_TOTAL_BYTES
    max_total_seconds: float = _DEFAULT_MAX_TOTAL_SECONDS

    def __post_init__(self) -> None:
        for name in (
            "max_navigations",
            "max_requests",
            "max_popups",
            "max_downloads",
            "max_captures",
            "max_bytes_per_download",
            "max_total_bytes",
        ):
            value = getattr(self, name)
            if type(value) is not int or value <= 0:
                raise ValueError(f"{name} must be a positive integer")
        if isinstance(self.max_total_seconds, bool) or not isinstance(
            self.max_total_seconds, (int, float)
        ):
            raise TypeError("max_total_seconds must be a number")
        total_seconds = float(self.max_total_seconds)
        if total_seconds <= 0 or total_seconds != total_seconds or total_seconds == float("inf"):
            raise ValueError("max_total_seconds must be finite and positive")
        object.__setattr__(self, "max_total_seconds", total_seconds)


@dataclass(slots=True)
class _Usage:
    navigations: int = 0
    requests: int = 0
    popups: int = 0
    downloads: int = 0
    captures: int = 0
    total_bytes: int = 0


class _Abort(Exception):
    __slots__ = ("code",)

    def __init__(self, code: str) -> None:
        self.code = code


class _Route(Protocol):
    request: object

    def bind_connection(self, binding: object) -> object: ...

    def continue_(self) -> object: ...

    def abort(self) -> object: ...


class _PageContext(Protocol):
    pages: Iterable[object]

    def bind_connection(self, binding: object) -> object: ...

    def route(self, pattern: str, handler: Callable[[object], object]) -> object: ...

    def on(self, event: str, handler: Callable[[object], object]) -> object: ...

    def new_page(self) -> object: ...

    def close(self) -> object: ...


class _ProcessRuntime(Protocol):
    def bind_connection(self, binding: object) -> object: ...

    def new_context(
        self,
        *,
        profile: object | None,
        downloads_path: str,
        accept_downloads: bool,
        connection_binding: object,
    ) -> _PageContext: ...


@dataclass(frozen=True, slots=True)
class _ConnectionBinding:
    """A mandatory, identity-checked DNS-to-runtime connection binding.

    ``address`` is the endpoint the runtime must actually use.  The complete
    verified answer set is carried as evidence so an adapter can reject a
    runtime endpoint that is not one of the resolver answers.  ``authority``
    and ``tls_server_name`` intentionally remain the normalized hostname: an
    IP endpoint must not silently change HTTP authority or TLS identity.
    ``token`` is deliberately identity-based and is never exposed in a public
    result; runtimes must return this exact object from ``bind_connection``.
    """

    scheme: str
    hostname: str
    port: int
    address: str
    verified_addresses: tuple[str, ...]
    authority: str
    tls_server_name: str
    token: object = field(default_factory=object, repr=False, compare=False)


@dataclass(slots=True)
class _RequestLease:
    request: object
    page: object | None
    destination: ResolvedDestination
    host_permit: HostPermit
    navigation: bool
    completed: bool = False


@dataclass(slots=True)
class _Navigation:
    page: object
    destination: ResolvedDestination
    initial_host: HostPermit | None
    saw_request: bool = False


def _failure(code: str) -> AccessFailure:
    messages = {
        "policy": ("browser destination was rejected", "check the configured web policy", False),
        "admission": ("browser access admission failed", "retry after access is available", True),
        "cancelled": ("browser operation was cancelled", "retry the operation", True),
        "timeout": ("browser operation timed out", "retry with a larger time budget", True),
        "budget": ("browser resource budget was exceeded", "reduce the page scope", False),
        "oversize": ("browser download exceeded its byte budget", "use a smaller resource", False),
        "challenge": (
            "browser access challenge was not supported",
            "use an approved source",
            False,
        ),
        "no-download": ("browser flow produced no download", "use another source", False),
        "cleanup": ("browser resources could not be cleaned up", "retry the operation", True),
        "runtime": ("browser runtime failed", "retry the operation", True),
    }
    reason, action, retryable = messages.get(code, messages["runtime"])
    return AccessFailure(code=code, reason=reason, action=action, retryable=retryable)


def _attribute(value: object, name: str) -> object | None:
    try:
        candidate = getattr(value, name)
    except AttributeError:
        return None
    except Exception as error:
        raise _Abort("runtime") from error
    if callable(candidate):
        try:
            return candidate()
        except TypeError:
            return candidate
        except Exception as error:
            raise _Abort("runtime") from error
    return candidate


def _text_attribute(value: object, name: str) -> str | None:
    candidate = _attribute(value, name)
    return candidate if type(candidate) is str else None


def _is_internal_url(value: str) -> bool:
    try:
        return urlsplit(value).scheme.casefold() in _INTERNAL_SCHEMES
    except ValueError:
        return False


def _policy_url(value: str) -> str:
    """Return the URL representation that may cross the policy boundary.

    Browser runtimes can expose short-lived signed download URLs.  The
    signature is needed by the private runtime, but it is not a destination
    identity and must not be handed to the shared URL policy or a neutral
    result.  Validate the URL shape here, then let ``normalize_url`` perform
    the canonical scheme/host/path checks on a query-free representation.
    """

    if type(value) is not str:
        raise _Abort("policy")
    try:
        parsed = urlsplit(value)
        if (
            parsed.username is not None
            or parsed.password is not None
            or parsed.fragment
            or "\\" in value
            or any(
                character.isspace()
                or ord(character) < 32
                or ord(character) == 127
                or unicodedata.category(character) in {"Cc", "Cf"}
                for character in value
            )
        ):
            raise _Abort("policy")
        return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))
    except _Abort:
        raise
    except (TypeError, ValueError):
        raise _Abort("policy") from None


class _FlowState:
    """Private state shared by route, popup, download and flow callbacks."""

    __slots__ = (
        "scope_permit",
        "resolver",
        "destination_policy",
        "destination_guard",
        "capture_guard",
        "budget",
        "clock",
        "started_at",
        "deadline",
        "cancel_event",
        "max_bytes_per_download",
        "usage",
        "destinations",
        "navigations",
        "page_statuses",
        "request_leases",
        "runtime",
        "lock",
        "condition",
        "closed",
        "pages",
        "popups",
        "downloads",
        "viewer_locators",
        "verified_locators",
        "captures",
        "capture_digests",
        "error",
    )

    def __init__(
        self,
        scope_permit: AccessPermit,
        resolver: ResolverLike,
        destination_policy: DestinationPolicy,
        destination_guard: BrowserDestinationGuard | None,
        capture_guard: BrowserCaptureGuard | None,
        budget: BrowserBudget,
        clock: Clock,
        deadline: float,
        cancel_event: threading.Event | None,
        max_bytes_per_download: int,
    ) -> None:
        self.scope_permit = scope_permit
        self.resolver = resolver
        self.destination_policy = destination_policy
        self.destination_guard = destination_guard
        self.capture_guard = capture_guard
        self.budget = budget
        self.clock = clock
        self.started_at = clock()
        self.deadline = deadline
        self.cancel_event = cancel_event
        self.max_bytes_per_download = max_bytes_per_download
        self.usage = _Usage()
        self.destinations: dict[str, ResolvedDestination] = {}
        self.navigations: dict[int, _Navigation] = {}
        self.page_statuses: dict[int, int | None] = {}
        self.request_leases: dict[int, _RequestLease] = {}
        self.runtime: object | None = None
        self.lock = threading.RLock()
        self.condition = threading.Condition(self.lock)
        self.closed = False
        self.pages: list[object] = []
        self.popups: list[object] = []
        self.downloads: list[object] = []
        self.viewer_locators: set[str] = set()
        self.verified_locators: set[str] = set()
        self.captures: list[BrowserCapture] = []
        self.capture_digests: set[bytes] = set()
        self.error: _Abort | None = None

    def check(self) -> None:
        with self.lock:
            if self.closed:
                raise _Abort("cancelled")
        if self.cancel_event is not None and self.cancel_event.is_set():
            raise _Abort("cancelled")
        if self.clock() >= self.deadline:
            raise _Abort("timeout")

    def remaining_milliseconds(self) -> int:
        self.check()
        remaining = self.deadline - self.clock()
        if remaining <= 0:
            raise _Abort("timeout")
        return max(1, int(remaining * 1000))

    def fail(self, code: str) -> None:
        with self.condition:
            if self.error is None:
                self.error = _Abort(code)
            self.condition.notify_all()

    def close_for_results(self) -> None:
        """Invalidate callbacks before runtime teardown starts."""

        with self.condition:
            self.closed = True
            self.condition.notify_all()

    def consume(
        self,
        *,
        navigations: int = 0,
        requests: int = 0,
        popups: int = 0,
        downloads: int = 0,
        captures: int = 0,
        total_bytes: int = 0,
    ) -> None:
        self.check()
        with self.lock:
            self.usage.navigations += navigations
            self.usage.requests += requests
            self.usage.popups += popups
            self.usage.downloads += downloads
            self.usage.captures += captures
            self.usage.total_bytes += total_bytes
            if self.usage.navigations > self.budget.max_navigations:
                raise _Abort("budget")
            if self.usage.requests > self.budget.max_requests:
                raise _Abort("budget")
            if self.usage.popups > self.budget.max_popups:
                raise _Abort("budget")
            if self.usage.downloads > self.budget.max_downloads:
                raise _Abort("budget")
            if self.usage.captures > self.budget.max_captures:
                raise _Abort("budget")
            if self.usage.total_bytes > self.budget.max_total_bytes:
                raise _Abort("oversize")

    def allows_capture(
        self,
        locator: str,
        kind: BrowserCaptureKind,
        media_type: str,
    ) -> bool:
        guard = self.capture_guard
        if guard is None:
            return kind is BrowserCaptureKind.DOWNLOAD
        try:
            return guard.allows(locator, kind, media_type) is True
        except Exception as error:
            raise _Abort("policy") from error

    def add_capture(
        self,
        *,
        kind: BrowserCaptureKind,
        body: bytes,
        media_type: str,
        locator: str,
    ) -> None:
        if not isinstance(kind, BrowserCaptureKind):
            raise _Abort("runtime")
        if not isinstance(body, bytes) or not isinstance(media_type, str):
            raise _Abort("runtime")
        self.consume(total_bytes=len(body))
        digest = hashlib.sha256(body).digest()
        capture = BrowserCapture(
            kind=kind,
            stream=BoundedByteStream(
                chunks=(body,),
                media_type=media_type,
                final_locator=locator,
                size=len(body),
            ),
        )
        with self.condition:
            if digest in self.capture_digests:
                return
            if self.usage.captures >= self.budget.max_captures:
                raise _Abort("budget")
            self.usage.captures += 1
            self.capture_digests.add(digest)
            self.captures.append(capture)
            self.condition.notify_all()

    def wait_for_capture(self, kind: BrowserCaptureKind) -> None:
        if not isinstance(kind, BrowserCaptureKind):
            raise _Abort("policy")
        with self.condition:
            while not any(capture.kind is kind for capture in self.captures):
                if self.error is not None:
                    raise self.error
                self.check()
                remaining = self.deadline - self.clock()
                if remaining <= 0:
                    raise _Abort("timeout")
                self.condition.wait(timeout=min(remaining, 0.25))

    def resolve(
        self,
        value: str,
        *,
        kind: BrowserDestinationKind,
    ) -> ResolvedDestination:
        if type(value) is not str or _is_internal_url(value):
            raise _Abort("policy")
        try:
            policy_value = _policy_url(value)
            self.guard(policy_value, kind)
            normalized = normalize_url(
                policy_value,
                allowed_schemes=self.destination_policy.allowed_schemes,
                allowed_ports=self.destination_policy.allowed_ports,
            )
            with self.lock:
                previous = self.destinations.get(normalized.hostname)
                destination = resolve_destination(
                    normalized,
                    self.resolver,
                    policy=self.destination_policy,
                    previous=previous,
                )
        except (PolicyError, TypeError, ValueError) as error:
            raise _Abort("policy") from error
        self.destinations[destination.hostname] = destination
        return destination

    def resolve_request(
        self,
        value: str,
        *,
        navigation: bool,
    ) -> ResolvedDestination | None:
        if type(value) is not str:
            raise _Abort("policy")
        if _is_internal_url(value):
            return None
        return self.resolve(
            value,
            kind=(
                BrowserDestinationKind.NAVIGATION if navigation else BrowserDestinationKind.REQUEST
            ),
        )

    def guard(self, value: str, kind: BrowserDestinationKind) -> None:
        guard = self.destination_guard
        if guard is None:
            return
        if not isinstance(kind, BrowserDestinationKind):
            raise _Abort("policy")
        try:
            guard.check(value, kind)
        except Exception as error:
            raise _Abort("policy") from error

    def acquire_host(self, destination: ResolvedDestination) -> HostPermit:
        self.check()
        try:
            return self.scope_permit.acquire_host(
                destination.hostname,
                cancel_event=self.cancel_event,
                timeout=max(self.deadline - self.clock(), 0.001),
            )
        except AccessCancelled as error:
            raise _Abort("cancelled") from error
        except AdmissionTimeout as error:
            raise _Abort("timeout") from error
        except Exception as error:
            raise _Abort("admission") from error

    def close_host(self, permit: HostPermit) -> None:
        try:
            permit.release()
        except Exception as error:
            raise _Abort("cleanup") from error

    def bind_runtime(
        self,
        target: object,
        destination: ResolvedDestination,
        *,
        allow_runtime_fallback: bool = True,
    ) -> None:
        """Require the runtime/route to acknowledge the exact safe binding.

        Passing resolver addresses as an optional factory keyword is not a
        security boundary: an implementation can silently ignore them.  Each
        actual request therefore needs a capability that returns the exact
        identity-bearing binding object.  The binding keeps hostname authority
        and TLS server name while requiring a verified endpoint address.
        """

        if not isinstance(destination, ResolvedDestination):
            raise _Abort("runtime")
        addresses = tuple(destination.addresses)
        if not addresses:
            raise _Abort("policy")
        binding = _ConnectionBinding(
            scheme=destination.url.scheme,
            hostname=destination.hostname,
            port=destination.url.port,
            address=addresses[0],
            verified_addresses=addresses,
            authority=destination.hostname,
            tls_server_name=destination.hostname,
        )
        binder = getattr(target, "bind_connection", None)
        if not callable(binder) and allow_runtime_fallback:
            target = self.runtime
            binder = getattr(target, "bind_connection", None) if target is not None else None
        if not callable(binder):
            raise _Abort("runtime")
        try:
            acknowledged = binder(binding)
        except Exception as error:
            raise _Abort("runtime") from error
        if acknowledged is not binding:
            raise _Abort("runtime")

    def take_initial_host(
        self,
        page: object | None,
        destination: ResolvedDestination,
    ) -> HostPermit | None:
        if page is None:
            return None
        with self.lock:
            navigation = self.navigations.get(id(page))
            if navigation is None or navigation.saw_request:
                return None
            navigation.saw_request = True
            initial_host = navigation.initial_host
            if initial_host is not None and (
                destination.hostname != navigation.destination.hostname
                or destination.addresses != navigation.destination.addresses
            ):
                navigation.initial_host = None
        if initial_host is not None and navigation.initial_host is None:
            # The preflight target did not match the first actual request;
            # release that unused reservation before admitting the real one.
            self.close_host(initial_host)
            return None
        if initial_host is not None:
            with self.lock:
                navigation.initial_host = None
        return initial_host

    def register_request(
        self,
        request: object,
        *,
        page: object | None,
        destination: ResolvedDestination,
        host_permit: HostPermit,
        navigation: bool,
    ) -> None:
        with self.lock:
            self.request_leases[id(request)] = _RequestLease(
                request=request,
                page=page,
                destination=destination,
                host_permit=host_permit,
                navigation=navigation,
            )

    def finish_request(self, request: object | None) -> None:
        if request is None:
            return
        with self.lock:
            lease = self.request_leases.get(id(request))
            if lease is None or lease.request is not request:
                return
            self.request_leases.pop(id(request), None)
        if lease.completed:
            return
        lease.completed = True
        self.close_host(lease.host_permit)

    def find_request_for_download(self, destination: ResolvedDestination) -> object | None:
        """Correlate a download with its intercepted request, fail closed if ambiguous."""

        with self.lock:
            matches = [
                lease.request
                for lease in self.request_leases.values()
                if lease.destination.url.url == destination.url.url
            ]
        return matches[0] if len(matches) == 1 else None

    def finish_page_navigation(self, page: object) -> None:
        """Finish navigation leases only after the runtime says goto is done."""

        with self.lock:
            leases = [
                lease
                for lease in self.request_leases.values()
                if lease.page is page and lease.navigation
            ]
            navigation = self.navigations.pop(id(page), None)
            initial_host = navigation.initial_host if navigation is not None else None
            if navigation is not None:
                navigation.initial_host = None
        for lease in leases:
            self.finish_request(lease.request)
        if initial_host is not None:
            self.close_host(initial_host)

    def detach_navigation(self, page: object) -> None:
        """Detach navigation bookkeeping while request leases remain live.

        A browser navigation can yield a download after ``goto``/popup returns.
        Request-finished/request-failed or download completion must therefore
        release its host permit; detaching only removes the preflight marker.
        """

        with self.lock:
            navigation = self.navigations.pop(id(page), None)
            initial_host = navigation.initial_host if navigation is not None else None
            if navigation is not None:
                navigation.initial_host = None
        if initial_host is not None:
            self.close_host(initial_host)

    def finish_all_requests(self) -> bool:
        with self.lock:
            leases = tuple(self.request_leases.values())
            self.request_leases.clear()
            navigations = tuple(self.navigations.values())
            self.navigations.clear()
        failed = False
        for lease in leases:
            if lease.completed:
                continue
            lease.completed = True
            try:
                lease.host_permit.release()
            except Exception:
                failed = True
        for navigation in navigations:
            if navigation.initial_host is None:
                continue
            try:
                navigation.initial_host.release()
            except Exception:
                failed = True
            navigation.initial_host = None
        return failed

    def check_challenge(self, page: object, response: object | None = None) -> None:
        del response
        challenge = _attribute(page, "challenge")
        if challenge is True:
            raise _Abort("challenge")
        title = _text_attribute(page, "title") or ""
        content = _text_attribute(page, "content") or ""
        marker_text = f"{title} {content}".casefold()
        if any(marker in marker_text for marker in _CHALLENGE_MARKERS):
            raise _Abort("challenge")


class _BrowserSession:
    """Capability-only flow handle.

    The flow receives operations, never a page/context/process/route or event
    object.  Operation implementations stay in this module so every action
    reuses the same timeout, cancellation, budget, policy and admission
    boundary.  The callable slots intentionally hold closures instead of
    vendor objects, keeping the public flow surface narrow.
    """

    __slots__ = (
        "_navigate_operation",
        "_popup_operation",
        "_viewer_operation",
        "_verified_locator_operation",
        "_click_operation",
        "_fill_operation",
        "_text_operation",
        "_observe_operation",
        "_wait_for_capture_operation",
    )

    def __init__(self, client: BrowserClient, state: _FlowState, page: object) -> None:
        self._navigate_operation = lambda url: client._client_navigate(state, page, url)
        self._popup_operation = lambda url: client._client_open_popup(state, page, url)
        self._viewer_operation = lambda url: client._client_open_viewer(state, page, url)
        self._verified_locator_operation = lambda url: client._client_open_verified_locator(
            state, page, url
        )
        self._click_operation = lambda selector: client._client_click(state, page, selector)
        self._fill_operation = lambda selector, value: client._client_fill(
            state, page, selector, value
        )
        self._text_operation = lambda selector: client._client_text(state, page, selector)
        self._observe_operation = lambda: client._client_observe(state, page)
        self._wait_for_capture_operation = lambda kind: state.wait_for_capture(kind)

    def navigate(self, url: str) -> None:
        self._navigate_operation(url)

    def open_popup(self, url: str) -> None:
        self._popup_operation(url)

    def open_viewer(self, locator: str) -> None:
        self._viewer_operation(locator)

    def open_verified_locator(self, locator: str) -> None:
        self._verified_locator_operation(locator)

    def click(self, selector: str) -> None:
        self._click_operation(selector)

    def fill(self, selector: str, value: str) -> None:
        self._fill_operation(selector, value)

    def text(self, selector: str) -> str:
        return self._text_operation(selector)

    def observe(self) -> BrowserPageObservation:
        return self._observe_operation()

    def wait_for_capture(self, kind: BrowserCaptureKind) -> None:
        self._wait_for_capture_operation(kind)


class BrowserClient:
    """Run one isolated, policy-checked Browser flow."""

    __slots__ = (
        "_factory",
        "_resolver",
        "_coordinator",
        "_destination_policy",
        "_operator_profile",
        "_session_broker",
        "_clock",
        "_timeout_seconds",
        "_budget",
    )

    def __init__(
        self,
        *,
        factory: BrowserFactory,
        resolver: ResolverLike,
        coordinator: AccessCoordinator,
        destination_policy: DestinationPolicy | None = None,
        operator_profile: object | None = None,
        session_broker: BrowserSessionBroker | None = None,
        timeout_seconds: float = _DEFAULT_TIMEOUT_SECONDS,
        budget: BrowserBudget | None = None,
        clock: Clock | None = None,
    ) -> None:
        if not callable(factory):
            raise TypeError("factory must be callable")
        if not isinstance(coordinator, AccessCoordinator):
            raise TypeError("coordinator must be an AccessCoordinator")
        if not isinstance(destination_policy, (DestinationPolicy, type(None))):
            raise TypeError("destination_policy must be a DestinationPolicy")
        if isinstance(timeout_seconds, bool) or not isinstance(timeout_seconds, (int, float)):
            raise TypeError("timeout_seconds must be a number")
        if float(timeout_seconds) <= 0:
            raise ValueError("timeout_seconds must be positive")
        if budget is not None and not isinstance(budget, BrowserBudget):
            raise TypeError("budget must be a BrowserBudget")
        if session_broker is not None and not isinstance(
            session_broker,
            BrowserSessionBroker,
        ):
            raise TypeError("session_broker must be a BrowserSessionBroker or None")
        if clock is not None and not callable(clock):
            raise TypeError("clock must be callable")
        self._factory = factory
        self._resolver = resolver
        self._coordinator = coordinator
        self._destination_policy = destination_policy or DestinationPolicy()
        self._operator_profile = operator_profile
        self._session_broker = session_broker
        self._clock = clock or time.monotonic
        self._timeout_seconds = float(timeout_seconds)
        self._budget = budget or BrowserBudget()

    @property
    def operator_profile(self) -> object | None:
        """Return the opaque profile injection token without inspecting it."""

        return self._operator_profile

    @property
    def budget(self) -> BrowserBudget:
        return self._budget

    # Keep setup, execution, and teardown together so every return path shares
    # the same cleanup and permit-release boundary.
    def run(  # noqa: C901
        self,
        scope: AccessScope,
        request: BrowserRequest | str,
        policy: AccessPolicy,
        *,
        flow: Callable[[BrowserFlowSession], object] | None = None,
        destination_guard: BrowserDestinationGuard | None = None,
        capture_guard: BrowserCaptureGuard | None = None,
        session_key: str | None = None,
        budget: BrowserBudget | None = None,
        timeout_seconds: float | None = None,
        cancel_event: threading.Event | None = None,
    ) -> BrowserResult:
        """Run one complete Browser flow and return only a neutral result."""

        try:
            if not isinstance(scope, AccessScope) or scope.channel != "web":
                raise _Abort("policy")
            if not isinstance(policy, AccessPolicy):
                raise _Abort("policy")
            raw_url, request_timeout, request_max_bytes = self._request_values(request)
            effective_timeout = (
                self._timeout_seconds if timeout_seconds is None else timeout_seconds
            )
            if isinstance(effective_timeout, bool) or not isinstance(
                effective_timeout, (int, float)
            ):
                raise _Abort("policy")
            effective_timeout = min(float(effective_timeout), request_timeout)
            if effective_timeout <= 0:
                raise _Abort("timeout")
            effective_budget = self._effective_budget(budget, request_max_bytes)
            if cancel_event is not None and not hasattr(cancel_event, "is_set"):
                raise _Abort("policy")
            if destination_guard is not None and not isinstance(
                destination_guard,
                BrowserDestinationGuard,
            ):
                raise _Abort("policy")
            if capture_guard is not None and not isinstance(
                capture_guard,
                BrowserCaptureGuard,
            ):
                raise _Abort("policy")
            if (self._session_broker is None) != (session_key is None):
                raise _Abort("policy")
            normalized_session_key = (
                None
                if session_key is None
                else BrowserSessionBroker.validate_session_key(session_key)
            )
        except _Abort as error:
            return _failure(error.code)
        except Exception:
            return _failure("policy")

        started = self._clock()
        deadline = started + min(effective_timeout, effective_budget.max_total_seconds)
        try:
            # Validate the initial destination before acquiring a permit, but
            # do not invoke the factory or navigate until scope admission is held.
            initial = self._resolve_initial(raw_url, destination_guard)
        except _Abort as error:
            return _failure(error.code)

        scope_permit: AccessPermit | None = None
        temporary: tempfile.TemporaryDirectory[str] | None = None
        process_manager: object | None = None
        process_runtime: object | None = None
        context: _PageContext | None = None
        session_lease: BrowserSessionLease | None = None
        state: _FlowState | None = None
        result: BrowserResult = _failure("runtime")
        cleanup_error = False
        entered_process = False
        try:
            try:
                scope_permit = self._coordinator.acquire_scope(
                    scope,
                    policy,
                    cancel_event=cancel_event,
                    timeout=max(deadline - self._clock(), 0.001),
                )
            except AccessCancelled:
                return _failure("cancelled")
            except AdmissionTimeout:
                return _failure("timeout")
            except Exception:
                return _failure("admission")

            state = _FlowState(
                scope_permit,
                self._resolver,
                self._destination_policy,
                destination_guard,
                capture_guard,
                effective_budget,
                self._clock,
                deadline,
                cancel_event,
                effective_budget.max_bytes_per_download,
            )
            state.destinations[initial.hostname] = initial
            initial_binding = self._binding(initial)
            temporary = tempfile.TemporaryDirectory(prefix="sciretriever-browser-")
            temporary_path = Path(temporary.name)
            os.chmod(temporary_path, stat.S_IRWXU)
            state.check()

            if self._session_broker is None:
                process_manager = self._factory(
                    profile=self._operator_profile,
                    downloads_path=str(temporary_path),
                    connection_binding=initial_binding,
                )
                process_runtime = process_manager
                enter = getattr(process_manager, "__enter__", None)
                if callable(enter):
                    entered_value = enter()
                    entered_process = True
                    if entered_value is not None:
                        process_runtime = entered_value
                if process_runtime is None:
                    raise _Abort("runtime")
                self._acknowledge_binding(process_runtime, initial_binding)
                state.runtime = process_runtime
                launch = getattr(process_runtime, "new_context", None)
                if not callable(launch):
                    raise _Abort("runtime")
                context = cast(
                    _PageContext,
                    launch(
                        profile=self._operator_profile,
                        downloads_path=str(temporary_path),
                        accept_downloads=True,
                        connection_binding=initial_binding,
                    ),
                )
                self._acknowledge_binding(context, initial_binding)
                self._install_handlers(state, context)
            else:
                if normalized_session_key is None:
                    raise _Abort("policy")
                session_lease = self._session_broker.acquire(
                    normalized_session_key,
                    factory=self._factory,
                    profile=self._operator_profile,
                    downloads_path=str(temporary_path),
                    connection_binding=initial_binding,
                    route_handler=self._route_handler(state),
                    event_handlers=self._event_handlers(state),
                    cancel_event=cancel_event,
                    timeout=max(deadline - self._clock(), 0.001),
                )
                process_runtime = session_lease.process_runtime
                context = cast(_PageContext, session_lease.context)
                state.runtime = process_runtime
            new_page = getattr(context, "new_page", None)
            if not callable(new_page):
                raise _Abort("runtime")
            page = new_page()
            state.pages.append(page)
            self._client_navigate(state, page, initial.url.url)
            state.check()
            if flow is not None:
                session = _BrowserSession(self, state, page)
                self._run_cancellable(
                    state,
                    lambda: flow(session),
                    abort=lambda: self._abort_runtime(page, context, process_runtime),
                )
            state.check()
            state.check_challenge(page)
            if state.error is not None:
                raise state.error
            if not state.captures:
                raise _Abort("no-download")
            result = BrowserCaptureBatch(captures=tuple(state.captures))
        except _Abort as error:
            result = _failure(error.code)
        except BrowserSessionCancelled:
            result = _failure("cancelled")
        except BrowserSessionTimeout:
            result = _failure("timeout")
        except BrowserSessionError:
            result = _failure("runtime")
        except TimeoutError:
            result = _failure(
                state.error.code if state is not None and state.error is not None else "timeout"
            )
        except Exception:
            result = _failure(
                state.error.code if state is not None and state.error is not None else "runtime"
            )
        finally:
            if state is not None:
                cleanup_error = self._cleanup_state(
                    state,
                    context,
                    process_manager,
                    process_runtime,
                    entered_process,
                    keep_session=session_lease is not None,
                )
            elif process_manager is not None:
                cleanup_error = self._cleanup_process(
                    process_manager,
                    process_runtime,
                    entered_process,
                )
            if session_lease is not None:
                if cleanup_error or self._result_requires_session_retirement(result):
                    session_lease.invalidate()
                try:
                    session_lease.drain_article()
                except BrowserSessionError:
                    cleanup_error = True
                    session_lease.invalidate()
                if state is not None and state.finish_all_requests():
                    cleanup_error = True
                    session_lease.invalidate()
                try:
                    session_lease.release()
                except BrowserSessionError:
                    cleanup_error = True
            if temporary is not None:
                try:
                    temporary.cleanup()
                except Exception:
                    cleanup_error = True
            if scope_permit is not None:
                try:
                    scope_permit.release()
                except Exception:
                    cleanup_error = True
        if cleanup_error:
            return _failure("cleanup")
        return result

    @staticmethod
    def _result_requires_session_retirement(result: BrowserResult) -> bool:
        return isinstance(result, AccessFailure) and result.code in {
            "cancelled",
            "runtime",
            "timeout",
        }

    def _request_values(self, request: BrowserRequest | str) -> tuple[str, float, int]:
        if isinstance(request, BrowserRequest):
            return request.url, request.timeout_seconds, request.max_response_bytes
        if type(request) is not str:
            raise _Abort("policy")
        return request, self._timeout_seconds, _DEFAULT_MAX_RESPONSE_BYTES

    @staticmethod
    def _effective_budget(
        budget: BrowserBudget | None,
        request_max_bytes: int,
    ) -> BrowserBudget:
        selected = BrowserBudget() if budget is None else budget
        if not isinstance(selected, BrowserBudget):
            raise _Abort("policy")
        return BrowserBudget(
            max_navigations=selected.max_navigations,
            max_requests=selected.max_requests,
            max_popups=selected.max_popups,
            max_downloads=selected.max_downloads,
            max_captures=selected.max_captures,
            max_bytes_per_download=min(selected.max_bytes_per_download, request_max_bytes),
            max_total_bytes=selected.max_total_bytes,
            max_total_seconds=selected.max_total_seconds,
        )

    @staticmethod
    def _binding(destination: ResolvedDestination) -> _ConnectionBinding:
        addresses = tuple(destination.addresses)
        if not addresses:
            raise _Abort("policy")
        return _ConnectionBinding(
            scheme=destination.url.scheme,
            hostname=destination.hostname,
            port=destination.url.port,
            address=addresses[0],
            verified_addresses=addresses,
            authority=destination.hostname,
            tls_server_name=destination.hostname,
        )

    @staticmethod
    def _acknowledge_binding(target: object, binding: _ConnectionBinding) -> None:
        binder = getattr(target, "bind_connection", None)
        if not callable(binder):
            raise _Abort("runtime")
        try:
            acknowledged = binder(binding)
        except Exception as error:
            raise _Abort("runtime") from error
        if acknowledged is not binding:
            raise _Abort("runtime")

    @staticmethod
    def _abort_runtime(
        page: object | None,
        context: object | None,
        process_runtime: object | None,
    ) -> None:
        """Actively interrupt a blocking vendor operation.

        A cancellation that only stops waiting in the caller would leave the
        browser connected and allow a late page/download result to mutate the
        flow.  Abort/stop/cancel are preferred; close is the fail-closed
        fallback for minimal injected runtimes.
        """

        for target in (page, context, process_runtime):
            if target is None:
                continue
            invoked = False
            for name in ("abort", "cancel", "stop", "close"):
                method = getattr(target, name, None)
                if not callable(method):
                    continue
                try:
                    method()
                except Exception:
                    pass
                invoked = True
                break
            if not invoked:
                continue

    def _run_cancellable(
        self,
        state: _FlowState,
        operation: Callable[[], object],
        *,
        abort: Callable[[], None],
    ) -> object:
        """Run a potentially blocking runtime operation with active abort.

        The worker is joined after abort so no late result can cross the
        Browser boundary.  ``state.check`` is also run after completion to
        invalidate a result that raced with cancellation/deadline.
        """

        finished = threading.Event()
        outcome: list[object] = []
        failure: list[BaseException] = []

        def invoke() -> None:
            try:
                outcome.append(operation())
            except BaseException as error:  # boundary converts below
                failure.append(error)
            finally:
                finished.set()

        worker = threading.Thread(target=invoke, daemon=True)
        worker.start()
        aborted_code: str | None = None
        while not finished.wait(0.01):
            try:
                state.check()
            except _Abort as error:
                aborted_code = error.code
                abort()
                break
        if aborted_code is not None:
            # Waiting here is intentional: cleanup and admission must not
            # race a still-running page/navigation/download operation.
            while not finished.wait(0.01):
                abort()
            raise _Abort(aborted_code)
        if failure:
            error = failure[0]
            if isinstance(error, _Abort):
                raise error
            raise error
        state.check()
        if not outcome:
            raise _Abort("runtime")
        return outcome[0]

    def _resolve_initial(
        self,
        url: str,
        destination_guard: BrowserDestinationGuard | None,
    ) -> ResolvedDestination:
        if type(url) is not str:
            raise _Abort("policy")
        try:
            policy_url = _policy_url(url)
            if destination_guard is not None:
                try:
                    destination_guard.check(
                        policy_url,
                        BrowserDestinationKind.INITIAL_NAVIGATION,
                    )
                except Exception as error:
                    raise _Abort("policy") from error
            normalized = normalize_url(
                url,
                allowed_schemes=self._destination_policy.allowed_schemes,
                allowed_ports=self._destination_policy.allowed_ports,
            )
            return resolve_destination(
                normalized,
                self._resolver,
                policy=self._destination_policy,
            )
        except (PolicyError, TypeError, ValueError) as error:
            raise _Abort("policy") from error

    def _install_handlers(self, state: _FlowState, context: _PageContext) -> None:
        route = getattr(context, "route", None)
        on = getattr(context, "on", None)
        if not callable(route) or not callable(on):
            raise _Abort("runtime")
        route("**/*", self._route_handler(state))
        for event, handler in self._event_handlers(state).items():
            on(event, handler)

    def _route_handler(self, state: _FlowState) -> Callable[[object], object]:
        return lambda value: self._handle_route(state, value)

    def _event_handlers(
        self,
        state: _FlowState,
    ) -> dict[str, Callable[[object], object]]:
        # Playwright-like runtimes emit these only after the response body is
        # complete or the request has failed.  They are deliberately distinct
        # from ``response``: a response header event is not request completion.
        return {
            "page": lambda value: self._handle_popup(state, value),
            "download": lambda value: self._handle_download(state, value),
            "response": lambda value: self._handle_response(state, value),
            "requestfinished": lambda value: self._handle_request_finished(state, value),
            "requestfailed": lambda value: self._handle_request_finished(state, value),
        }

    def _handle_route(self, state: _FlowState, raw_route: object) -> None:
        route = cast(_Route, raw_route)
        request: object | None = None
        try:
            request = route.request
            url = _text_attribute(request, "url")
            if url is None:
                raise _Abort("policy")
            state.consume(requests=1)
            page = _attribute(request, "page")
            navigation = self._is_navigation_request(request)
            destination = state.resolve_request(url, navigation=navigation)
            if destination is None:
                self._continue_route(route)
                return
            self._admit_route(
                state,
                route,
                request,
                page,
                destination,
                navigation,
            )
        except _Abort as error:
            state.fail(error.code)
            self._abort_route(route)
            state.finish_request(request)
        except Exception:
            state.fail("runtime")
            self._abort_route(route)
            state.finish_request(request)

    def _admit_route(
        self,
        state: _FlowState,
        route: _Route,
        request: object,
        page: object | None,
        destination: ResolvedDestination,
        navigation: bool,
    ) -> None:
        if navigation and state.navigations.get(id(page)) is None:
            state.consume(navigations=1)
        if navigation and page is not None:
            with state.lock:
                current_navigation = state.navigations.get(id(page))
                if current_navigation is not None:
                    current_navigation.destination = destination
        host_permit = state.take_initial_host(page, destination) if navigation else None
        if host_permit is None:
            host_permit = state.acquire_host(destination)
        try:
            # Binding is mandatory and occurs before route continuation.  A
            # route/runtime that merely accepts an ignored ``addresses`` kwarg
            # cannot cross this boundary.
            state.bind_runtime(route, destination, allow_runtime_fallback=False)
            state.register_request(
                request,
                page=page,
                destination=destination,
                host_permit=host_permit,
                navigation=navigation,
            )
            host_permit = None
            self._continue_route(route)
        finally:
            if host_permit is not None:
                host_permit.release()

    @staticmethod
    def _request_from_event(value: object) -> object:
        candidate = _attribute(value, "request")
        return value if candidate is None else candidate

    def _handle_request_finished(self, state: _FlowState, value: object) -> None:
        try:
            state.finish_request(self._request_from_event(value))
        except _Abort as error:
            state.fail(error.code)
        except Exception:
            state.fail("cleanup")

    def _handle_response(self, state: _FlowState, response: object) -> None:
        """Guard a response locator before any future body/capture operation."""

        try:
            url = _text_attribute(response, "url")
            request = _attribute(response, "request")
            if url is None or request is None:
                raise _Abort("runtime")
            destination = state.resolve(url, kind=BrowserDestinationKind.RESPONSE)
            with state.lock:
                lease = state.request_leases.get(id(request))
            if (
                lease is None
                or lease.request is not request
                or lease.destination.url.url != destination.url.url
            ):
                # Response access was admitted only if its still-live route
                # lease proves that guard, DNS binding and host admission ran
                # before transport.  A future response-body capture reuses
                # this same condition rather than admitting after the fact.
                raise _Abort("runtime")
            status = _attribute(response, "status")
            if type(status) is not int or not 200 <= status <= 299:
                return
            media_type = self._response_media_type(response)
            kind = self._response_capture_kind(
                state,
                lease.page,
                destination.url.url,
            )
            if not state.allows_capture(destination.url.url, kind, media_type):
                return
            body = cast(
                bytes,
                self._run_cancellable(
                    state,
                    lambda: self._response_bytes(state, response),
                    abort=lambda: self._abort_runtime(lease.page, None, state.runtime),
                ),
            )
            state.check()
            state.add_capture(
                kind=kind,
                body=body,
                media_type=media_type,
                locator=destination.url.url,
            )
        except _Abort as error:
            state.fail(error.code)
        except Exception:
            state.fail("runtime")

    @staticmethod
    def _is_navigation_request(request: object) -> bool:
        value = _attribute(request, "is_navigation_request")
        if isinstance(value, bool):
            return value
        resource_type = _text_attribute(request, "resource_type")
        return resource_type in {"document", "main_frame"}

    def _response_capture_kind(
        self,
        state: _FlowState,
        page: object | None,
        locator: str,
    ) -> BrowserCaptureKind:
        if locator in state.verified_locators:
            return BrowserCaptureKind.VERIFIED_LOCATOR
        if locator in state.viewer_locators:
            return BrowserCaptureKind.VIEWER
        if page is not None and page in state.popups:
            return BrowserCaptureKind.POPUP
        return BrowserCaptureKind.RESPONSE

    @staticmethod
    def _continue_route(route: _Route) -> None:
        method = getattr(route, "continue_", None)
        if not callable(method):
            method = getattr(route, "continue", None)
        if not callable(method):
            raise _Abort("runtime")
        method()

    @staticmethod
    def _abort_route(route: _Route) -> None:
        method = getattr(route, "abort", None)
        if callable(method):
            try:
                method()
            except Exception:
                pass

    def _handle_popup(self, state: _FlowState, page: object) -> None:
        try:
            state.consume(popups=1)
            state.popups.append(page)
            if page not in state.pages:
                state.pages.append(page)
        except _Abort as error:
            state.fail(error.code)
            self._close_object(page)
        except Exception:
            state.fail("runtime")
            self._close_object(page)

    def _handle_download(self, state: _FlowState, download: object) -> None:
        request: object | None = None
        try:
            state.downloads.append(download)
            state.consume(downloads=1)
            url = _text_attribute(download, "url")
            if url is None:
                raise _Abort("policy")
            destination = state.resolve(url, kind=BrowserDestinationKind.DOWNLOAD)
            request_candidate = _attribute(download, "request")
            request = (
                request_candidate
                if request_candidate is not None
                else state.find_request_for_download(destination)
            )
            with state.lock:
                existing = state.request_leases.get(id(request)) if request is not None else None
            if existing is None or existing.destination.url.url != destination.url.url:
                # A download event without a still-live intercepted request
                # cannot prove that host admission preceded the connection.
                # Acquiring a permit here would be too late, so fail closed.
                raise _Abort("runtime")
            # ``destination`` was resolved from a query-free policy URL.  It
            # is therefore safe to expose as the locator even when the
            # private Browser download object carried a signed query.
            locator = destination.url.url
            media_type = self._download_media_type(download)
            if not state.allows_capture(locator, BrowserCaptureKind.DOWNLOAD, media_type):
                return
            body = cast(
                bytes,
                self._run_cancellable(
                    state,
                    lambda: self._download_bytes(state, download),
                    abort=lambda: self._abort_runtime(None, None, state.runtime),
                ),
            )
            state.check()
            state.add_capture(
                kind=BrowserCaptureKind.DOWNLOAD,
                body=body,
                media_type=media_type,
                locator=locator,
            )
        except _Abort as error:
            state.fail(error.code)
            self._delete_object(download)
        except Exception:
            state.fail("runtime")
            self._delete_object(download)
        finally:
            if request is not None:
                try:
                    state.finish_request(request)
                except Exception:
                    state.fail("cleanup")

    @staticmethod
    def _download_media_type(download: object) -> str:
        for name in ("media_type", "content_type"):
            value = _text_attribute(download, name)
            if value:
                candidate = value.split(";", 1)[0].strip()
                if candidate and all(ord(character) >= 32 for character in candidate):
                    return candidate
        return "application/octet-stream"

    @staticmethod
    def _response_media_type(response: object) -> str:
        for name in ("media_type", "content_type"):
            value = _text_attribute(response, name)
            if value:
                candidate = value.split(";", 1)[0].strip().casefold()
                if candidate and all(ord(character) >= 32 for character in candidate):
                    return candidate
        candidate = BrowserClient._media_type_from_headers(_attribute(response, "headers"))
        return "application/octet-stream" if candidate is None else candidate

    @staticmethod
    def _media_type_from_headers(headers: object) -> str | None:
        if isinstance(headers, dict):
            for name, value in headers.items():
                if (
                    isinstance(name, str)
                    and name.casefold() == "content-type"
                    and isinstance(value, str)
                ):
                    candidate = value.split(";", 1)[0].strip().casefold()
                    if candidate:
                        return candidate
        if isinstance(headers, (tuple, list)):
            for item in headers:
                if (
                    isinstance(item, (tuple, list))
                    and len(item) == 2
                    and isinstance(item[0], str)
                    and item[0].casefold() == "content-type"
                    and isinstance(item[1], str)
                ):
                    candidate = item[1].split(";", 1)[0].strip().casefold()
                    if candidate:
                        return candidate
        return None

    @staticmethod
    def _response_bytes(state: _FlowState, response: object) -> bytes:
        declared = _attribute(response, "size")
        if isinstance(declared, int) and declared > state.max_bytes_per_download:
            raise _Abort("oversize")
        reader = getattr(response, "body", None)
        if not callable(reader):
            reader = getattr(response, "content", None)
        if not callable(reader):
            reader = getattr(response, "read", None)
        if not callable(reader):
            raise _Abort("runtime")
        try:
            value = reader()
        except TypeError:
            value = reader(state.max_bytes_per_download + 1)
        if not isinstance(value, bytes):
            raise _Abort("runtime")
        if len(value) > state.max_bytes_per_download:
            raise _Abort("oversize")
        return value

    @staticmethod
    def _download_bytes(state: _FlowState, download: object) -> bytes:
        declared = _attribute(download, "size")
        if isinstance(declared, int) and declared > state.max_bytes_per_download:
            raise _Abort("oversize")
        reader = getattr(download, "content", None)
        if not callable(reader):
            reader = getattr(download, "read", None)
        if not callable(reader):
            raise _Abort("runtime")
        try:
            value = reader()
        except TypeError:
            value = reader(state.max_bytes_per_download + 1)
        if not isinstance(value, bytes):
            raise _Abort("runtime")
        if len(value) > state.max_bytes_per_download:
            raise _Abort("oversize")
        return value

    def _client_navigate(self, state: _FlowState, page: object, url: str) -> None:
        try:
            state.check()
            destination = state.resolve(url, kind=BrowserDestinationKind.NAVIGATION)
            state.consume(navigations=1)
            initial_host = state.acquire_host(destination)
            navigation = _Navigation(page, destination, initial_host)
            state.navigations[id(page)] = navigation
            operation_complete = False
            try:
                goto = getattr(page, "goto", None)
                if not callable(goto):
                    raise _Abort("runtime")
                response = self._run_cancellable(
                    state,
                    lambda: goto(
                        destination.url.url,
                        timeout=state.remaining_milliseconds(),
                    ),
                    abort=lambda: self._abort_runtime(page, None, state.runtime),
                )
                state.detach_navigation(page)
                operation_complete = True
                state.check()
                final_url = _text_attribute(page, "url") or _text_attribute(response, "url")
                if final_url is not None and not _is_internal_url(final_url):
                    final_destination = state.resolve(
                        final_url,
                        kind=BrowserDestinationKind.NAVIGATION,
                    )
                    if final_destination.hostname != navigation.destination.hostname:
                        final_host = state.acquire_host(final_destination)
                        try:
                            state.bind_runtime(state.runtime or page, final_destination)
                        finally:
                            state.close_host(final_host)
                    navigation.destination = final_destination
                status = _attribute(response, "status") if response is not None else None
                if status is not None and (type(status) is not int or not 100 <= status <= 599):
                    raise _Abort("runtime")
                state.page_statuses[id(page)] = cast(int | None, status)
                state.check_challenge(page, response)
            finally:
                if not operation_complete:
                    state.finish_page_navigation(page)
        except _Abort:
            raise
        except (TimeoutError,):
            raise _Abort("timeout") from None
        except Exception as error:
            if state.error is not None:
                raise state.error
            raise _Abort("runtime") from error

    def _client_open_popup(self, state: _FlowState, opener: object, url: str) -> None:
        try:
            state.check()
            destination = state.resolve(url, kind=BrowserDestinationKind.POPUP)
            opener_method = getattr(opener, "open_popup", None)
            if not callable(opener_method):
                raise _Abort("runtime")
            popup = self._run_cancellable(
                state,
                lambda: opener_method(destination.url.url),
                abort=lambda: self._abort_runtime(opener, None, state.runtime),
            )
            if popup is None:
                raise _Abort("runtime")
            state.detach_navigation(popup)
        except _Abort:
            raise
        except TimeoutError:
            raise _Abort("timeout") from None
        except Exception as error:
            if state.error is not None:
                raise state.error
            raise _Abort("runtime") from error

    def _client_open_verified_locator(
        self,
        state: _FlowState,
        opener: object,
        url: str,
    ) -> None:
        destination = state.resolve(url, kind=BrowserDestinationKind.POPUP)
        with state.lock:
            state.verified_locators.add(destination.url.url)
        self._client_open_popup(state, opener, destination.url.url)

    def _client_open_viewer(
        self,
        state: _FlowState,
        opener: object,
        url: str,
    ) -> None:
        destination = state.resolve(url, kind=BrowserDestinationKind.POPUP)
        with state.lock:
            state.viewer_locators.add(destination.url.url)
        self._client_open_popup(state, opener, destination.url.url)

    @staticmethod
    def _selector(value: str) -> str:
        if type(value) is not str or not value or len(value) > 1024:
            raise _Abort("policy")
        if any(ord(character) < 32 or ord(character) == 127 for character in value):
            raise _Abort("policy")
        return value

    def _client_click(self, state: _FlowState, page: object, selector: str) -> None:
        selector = self._selector(selector)
        click = getattr(page, "click", None)
        if not callable(click):
            raise _Abort("runtime")
        self._run_cancellable(
            state,
            lambda: click(selector, timeout=state.remaining_milliseconds()),
            abort=lambda: self._abort_runtime(page, None, state.runtime),
        )

    def _client_fill(self, state: _FlowState, page: object, selector: str, value: str) -> None:
        selector = self._selector(selector)
        if type(value) is not str or len(value) > 1024 * 1024:
            raise _Abort("policy")
        if any(ord(character) < 32 and character not in "\t\n\r" for character in value):
            raise _Abort("policy")
        fill = getattr(page, "fill", None)
        if not callable(fill):
            raise _Abort("runtime")
        self._run_cancellable(
            state,
            lambda: fill(selector, value, timeout=state.remaining_milliseconds()),
            abort=lambda: self._abort_runtime(page, None, state.runtime),
        )

    def _client_text(self, state: _FlowState, page: object, selector: str) -> str:
        selector = self._selector(selector)
        text_content = getattr(page, "text_content", None)
        if not callable(text_content):
            raise _Abort("runtime")
        value = self._run_cancellable(
            state,
            lambda: text_content(selector, timeout=state.remaining_milliseconds()),
            abort=lambda: self._abort_runtime(page, None, state.runtime),
        )
        if value is None:
            return ""
        if type(value) is not str or len(value) > 1024 * 1024:
            raise _Abort("runtime")
        return value

    def _client_observe(
        self,
        state: _FlowState,
        page: object,
    ) -> BrowserPageObservation:
        state.check()
        locator = _text_attribute(page, "url")
        if locator is None or _is_internal_url(locator):
            raise _Abort("runtime")
        policy_locator = _policy_url(locator)
        try:
            normalized = normalize_url(
                policy_locator,
                allowed_schemes=self._destination_policy.allowed_schemes,
                allowed_ports=self._destination_policy.allowed_ports,
            )
        except (PolicyError, TypeError, ValueError) as error:
            raise _Abort("policy") from error
        state.guard(normalized.url, BrowserDestinationKind.NAVIGATION)
        if normalized.hostname not in state.destinations:
            raise _Abort("runtime")
        return BrowserPageObservation(
            locator=normalized.url,
            status_code=state.page_statuses.get(id(page)),
        )

    def _cleanup_state(
        self,
        state: _FlowState,
        context: _PageContext | None,
        process_manager: object | None,
        process_runtime: object | None,
        entered_process: bool,
        *,
        keep_session: bool = False,
    ) -> bool:
        failed = False
        state.close_for_results()
        pages: list[object] = list(state.pages)
        if context is not None and not keep_session:
            try:
                pages.extend(page for page in context.pages if page not in pages)
            except Exception:
                failed = True
        for page in reversed(pages):
            if not self._close_object(page):
                failed = True
        for download in reversed(state.downloads):
            if not self._delete_object(download):
                failed = True
        if context is not None and not keep_session and not self._close_object(context):
            failed = True
        # Context close is the runtime-level abort/completion acknowledgement
        # for any subresource that did not emit requestfinished/requestfailed.
        # Keep its host lease until after that close returns.
        if not keep_session and state.finish_all_requests():
            failed = True
        if (
            not keep_session
            and process_manager is not None
            and not self._cleanup_process(
                process_manager,
                process_runtime,
                entered_process,
            )
        ):
            failed = True
        return failed

    @staticmethod
    def _cleanup_process(
        process_manager: object,
        process_runtime: object | None,
        entered_process: bool,
    ) -> bool:
        failed = False
        if entered_process:
            exit_method = getattr(process_manager, "__exit__", None)
            if callable(exit_method):
                try:
                    exit_method(None, None, None)
                except Exception:
                    failed = True
            return not failed
        target = process_runtime if process_runtime is not None else process_manager
        close = getattr(target, "close", None)
        if callable(close):
            try:
                close()
            except Exception:
                failed = True
        return not failed

    @staticmethod
    def _close_object(value: object) -> bool:
        close = getattr(value, "close", None)
        if not callable(close):
            return True
        try:
            close()
        except Exception:
            return False
        return True

    @staticmethod
    def _delete_object(value: object) -> bool:
        delete = getattr(value, "delete", None)
        if not callable(delete):
            return True
        try:
            delete()
        except Exception:
            return False
        return True


__all__ = (
    "BrowserBudget",
    "BrowserCaptureGuard",
    "BrowserClient",
    "BrowserDestinationGuard",
    "BrowserDestinationKind",
    "BrowserError",
    "BrowserFlowSession",
    "BrowserPageObservation",
)
