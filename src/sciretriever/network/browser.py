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
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from enum import Enum, unique
from pathlib import Path
from typing import Final, NoReturn, Protocol, TypeAlias, cast, runtime_checkable
from urllib.parse import unquote_to_bytes, urlsplit, urlunsplit

from sciretriever.logging.api import get_logger
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
from .browser_control import (
    BrowserAgentActionCommand,
    BrowserAgentActionKind,
    BrowserAgentActionPort,
    BrowserAgentObservation,
    BrowserCaptureState,
    BrowserElement,
    BrowserElementState,
    BrowserObservationBudget,
    BrowserObservationLedger,
    BrowserViewport,
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
_DEFAULT_MAX_ACTION_WAIT_SECONDS: Final[float] = 10.0
_DEFAULT_MAX_CAPTURE_WAIT_SECONDS: Final[float] = 10.0
_DEFAULT_MAX_TOTAL_SECONDS: Final[float] = 60.0
_DEFAULT_CLEANUP_TIMEOUT_SECONDS: Final[float] = 5.0
_MARKER_LOOKUP_TIMEOUT_MILLISECONDS: Final[int] = 250
_MAX_DISCOVERED_PDF_LOCATORS: Final[int] = 16
_MAX_DISCOVERED_LOCATOR_LENGTH: Final[int] = 8192
_MAX_AGENT_SCREENSHOT_BYTES: Final[int] = 2 * 1024 * 1024
_MAX_AGENT_ELEMENTS: Final[int] = 64
_DEFAULT_HOST_REQUEST_POLICY: Final[AccessPolicy] = AccessPolicy(max_concurrency=1)
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
_LOGGER = get_logger(__name__)


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


def _observation_locator(value: object, *, field_name: str) -> str:
    if not isinstance(value, str) or len(value) > _MAX_DISCOVERED_LOCATOR_LENGTH:
        raise TypeError(f"{field_name} must be a string")
    try:
        normalized = normalize_url_with_configured_port(value)
    except (PolicyError, TypeError, ValueError):
        raise ValueError(f"{field_name} must be a safe query-free HTTP(S) URL") from None
    if normalized.query:
        raise ValueError(f"{field_name} must not contain a query")
    return normalized.url


def _observation_resource_type(value: object) -> str:
    if (
        not isinstance(value, str)
        or not value
        or len(value) > 32
        or not value.isascii()
        or any(not (character.isalnum() or character in {"-", "_"}) for character in value)
    ):
        raise ValueError("resource_type must be a bounded ASCII token")
    return value.casefold()


def _observation_ancestry(value: object) -> tuple[str, ...]:
    if not isinstance(value, tuple) or len(value) > 16:
        raise TypeError("frame_ancestry must be a bounded tuple")
    return tuple(_observation_locator(item, field_name="frame_ancestry item") for item in value)


def _observation_top_locator(value: object) -> str | None:
    if value is None:
        return None
    return _observation_locator(value, field_name="top_frame_locator")


@dataclass(frozen=True, slots=True, repr=False)
class BrowserRequestObservation:
    """Bounded, vendor-neutral facts for one admitted Browser request.

    The Network adapter builds this value from its private Playwright wrapper
    before a route is continued.  It intentionally carries only normalized
    locators and small structural facts; no headers, cookies, page objects or
    request bodies cross the boundary.  Provider rules may use it to admit a
    narrowly reviewed dependency (for example a challenge iframe) without
    turning that dependency into a general destination allow-list entry.
    """

    locator: str = field(repr=False)
    kind: BrowserDestinationKind
    resource_type: str
    is_navigation: bool
    is_top_frame: bool
    frame_depth: int | None = None
    frame_ancestry: tuple[str, ...] = field(default=(), repr=False)
    top_frame_locator: str | None = field(default=None, repr=False)
    is_popup: bool = False
    redirect_depth: int = 0
    capture_kind: BrowserCaptureKind | None = None

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "locator",
            _observation_locator(self.locator, field_name="locator"),
        )
        if not isinstance(self.kind, BrowserDestinationKind):
            raise TypeError("kind must be a BrowserDestinationKind")
        object.__setattr__(self, "resource_type", _observation_resource_type(self.resource_type))
        if type(self.is_navigation) is not bool or type(self.is_top_frame) is not bool:
            raise TypeError("navigation and frame flags must be bools")
        if self.frame_depth is not None and (
            type(self.frame_depth) is not int or self.frame_depth < 0 or self.frame_depth > 16
        ):
            raise ValueError("frame_depth must be a bounded non-negative integer")
        object.__setattr__(self, "frame_ancestry", _observation_ancestry(self.frame_ancestry))
        object.__setattr__(
            self, "top_frame_locator", _observation_top_locator(self.top_frame_locator)
        )
        if type(self.is_popup) is not bool:
            raise TypeError("is_popup must be a bool")
        if type(self.redirect_depth) is not int or not 0 <= self.redirect_depth <= 32:
            raise ValueError("redirect_depth must be a bounded non-negative integer")
        if self.capture_kind is not None and not isinstance(self.capture_kind, BrowserCaptureKind):
            raise TypeError("capture_kind must be a BrowserCaptureKind or None")


@dataclass(frozen=True, slots=True, repr=False)
class BrowserChallengeResourceFacts:
    """Payload-free resource facts for one Browser challenge dependency.

    Network records only aggregate counts.  It deliberately does not expose
    the challenge URL, response body, headers, token or a Browser vendor
    object.  Acquisition can use these facts to distinguish a local policy
    block from a challenge that is still settling, while Publisher rules keep
    ownership of the actual page classification.
    """

    admitted_count: int = 0
    blocked_count: int = 0
    pending_count: int = 0

    def __post_init__(self) -> None:
        for name in ("admitted_count", "blocked_count", "pending_count"):
            value = getattr(self, name)
            if type(value) is not int or value < 0:
                raise ValueError(f"{name} must be a non-negative integer")

    @property
    def resource_blocked(self) -> bool:
        return self.blocked_count > 0

    @property
    def loading(self) -> bool:
        return self.pending_count > 0


@dataclass(frozen=True, slots=True, repr=False)
class BrowserChallengeObservation:
    """One bounded snapshot used by the Acquisition challenge lifecycle."""

    page: BrowserPageObservation
    resources: BrowserChallengeResourceFacts
    capture_count: int = 0
    settled: bool = False

    def __post_init__(self) -> None:
        if not isinstance(self.page, BrowserPageObservation):
            raise TypeError("page must be a BrowserPageObservation")
        if not isinstance(self.resources, BrowserChallengeResourceFacts):
            raise TypeError("resources must be BrowserChallengeResourceFacts")
        if type(self.capture_count) is not int or self.capture_count < 0:
            raise ValueError("capture_count must be a non-negative integer")
        if type(self.settled) is not bool:
            raise TypeError("settled must be a bool")


@runtime_checkable
class BrowserChallengeFactsProvider(Protocol):
    """Optional neutral hook implemented by a rule guard/runtime state."""

    def challenge_resource_facts(self) -> BrowserChallengeResourceFacts: ...


@runtime_checkable
class BrowserRequestGuard(Protocol):
    """Optional rule hook for context-sensitive dependency admission."""

    def check_request(self, observation: BrowserRequestObservation) -> None: ...


@runtime_checkable
class BrowserDestinationGuard(Protocol):
    """Secret-free guard evaluated before one Browser destination performs I/O.

    Network owns generic URL, DNS, address, host-admission and resource policy.
    This additional hook can only reject a normalized, query-free locator; it
    cannot weaken any Network decision or receive a Browser vendor object.
    """

    def check(self, url: str, kind: BrowserDestinationKind) -> None: ...


@runtime_checkable
class BrowserConnectionOriginGuard(Protocol):
    """Optional closed origin set that Chromium may preconnect through.

    Prebinding only authorizes a CONNECT tunnel to one already resolved
    numeric address. Every HTTP request still remains paused by Playwright
    until the ordinary destination guard succeeds and the current article has
    acquired or reused its host admission lease.
    """

    def connection_origins(self) -> tuple[str, ...]: ...


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

    def click(self, selector: str) -> bool: ...

    def open_viewer(self, locator: str) -> None: ...

    def open_verified_locator(self, locator: str) -> None: ...

    def discover_pdf_locators(self) -> tuple[str, ...]: ...

    def capture_available(self, kind: BrowserCaptureKind) -> bool: ...

    def wait_for_capture(self, kind: BrowserCaptureKind) -> None: ...

    def wait_for_any_capture(self, kinds: tuple[BrowserCaptureKind, ...]) -> None: ...

    def has_selector(self, selector: str) -> bool: ...

    def text(self, selector: str) -> str: ...

    def observe(self) -> BrowserPageObservation: ...

    def agent_action_port(self) -> BrowserAgentActionPort: ...


@runtime_checkable
class BrowserFlowController(Protocol):
    """Stable, neutral controller seam for one isolated Browser article."""

    def run(self, session: BrowserFlowSession) -> None: ...


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
    max_action_wait_seconds: float = _DEFAULT_MAX_ACTION_WAIT_SECONDS
    max_capture_wait_seconds: float = _DEFAULT_MAX_CAPTURE_WAIT_SECONDS
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
        for name in (
            "max_action_wait_seconds",
            "max_capture_wait_seconds",
            "max_total_seconds",
        ):
            value = getattr(self, name)
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise TypeError(f"{name} must be a number")
            seconds = float(value)
            if seconds <= 0 or seconds != seconds or seconds == float("inf"):
                raise ValueError(f"{name} must be finite and positive")
            object.__setattr__(self, name, seconds)


@dataclass(slots=True)
class _Usage:
    navigations: int = 0
    requests: int = 0
    popups: int = 0
    downloads: int = 0
    captures: int = 0
    total_bytes: int = 0


@dataclass(slots=True)
class _AgentPageState:
    """Operation-local Browser Agent page ledger.

    Only the opaque element mapping and bounded neutral snapshot are retained;
    Playwright handles and selectors remain in the private page adapter.  The
    mapping is invalidated whenever the bounded DOM fingerprint changes.
    """

    page_token: str
    ledger: BrowserObservationLedger = field(default_factory=BrowserObservationLedger)
    fingerprint: bytes | None = None
    element_keys: dict[str, int] = field(default_factory=dict)
    observation: BrowserAgentObservation | None = None


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
    navigation: bool
    completed: bool = False


@dataclass(slots=True)
class _ArticleHostLease:
    """One host admission shared by every request in an article flow."""

    permit: HostPermit | None = None
    acquiring: bool = True
    error_code: str | None = None


@dataclass(frozen=True, slots=True)
class _PendingResponseDownload:
    lease: _RequestLease
    kind: BrowserCaptureKind
    media_type: str
    capture_allowed: bool


@dataclass(frozen=True, slots=True)
class _PendingLocalDownload:
    destination: ResolvedDestination
    media_type: str
    kind: BrowserCaptureKind
    lease: _RequestLease | None = None


@dataclass(frozen=True, slots=True)
class _DownloadCapturePlan:
    destination: ResolvedDestination
    request: object | None
    kind: BrowserCaptureKind
    media_type: str
    capture_allowed: bool


@dataclass(slots=True)
class _Navigation:
    page: object
    destination: ResolvedDestination
    budget_counted: bool = True


@dataclass(slots=True)
class _RuntimeTask:
    """One vendor call whose lifetime remains owned until it acknowledges stop."""

    finished: threading.Event = field(default_factory=threading.Event)
    outcome: list[object] = field(default_factory=list)
    failure: list[BaseException] = field(default_factory=list)
    late_cleanup: Callable[[object], None] | None = None
    lock: threading.Lock = field(default_factory=threading.Lock)
    abandoned: bool = False
    late_cleanup_failed: bool = False

    def invoke(self, operation: Callable[[], object]) -> None:
        try:
            value = operation()
        except BaseException as error:  # converted at the Network boundary
            self.failure.append(error)
        else:
            with self.lock:
                abandoned = self.abandoned
                if not abandoned:
                    self.outcome.append(value)
            if abandoned and self.late_cleanup is not None:
                try:
                    self.late_cleanup(value)
                except BaseException:
                    self.late_cleanup_failed = True
        finally:
            self.finished.set()

    def abandon(self) -> tuple[object, ...]:
        with self.lock:
            self.abandoned = True
            values = tuple(self.outcome)
            self.outcome.clear()
            return values


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


def _positive_seconds(value: object, *, field_name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError(f"{field_name} must be a number")
    candidate = float(value)
    if candidate <= 0 or candidate != candidate or candidate == float("inf"):
        raise ValueError(f"{field_name} must be finite and positive")
    return candidate


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


def _runtime_url(value: str, policy: DestinationPolicy) -> str:
    """Return a canonical operation-local URL while retaining its query.

    Destination guards, DNS state, logs and neutral results use
    :func:`_policy_url`, which removes the query.  Chromium still needs the
    original query for short-lived Publisher download links.  This helper
    validates the opaque query's wire shape without interpreting or exposing
    its keys, then attaches it to the already-normalized safe destination.
    """

    if type(value) is not str or len(value) > _MAX_DISCOVERED_LOCATOR_LENGTH:
        raise _Abort("policy")
    policy_value = _policy_url(value)
    try:
        parsed = urlsplit(value)
        query = parsed.query
        index = 0
        while index < len(query):
            if query[index] != "%":
                index += 1
                continue
            if (
                index + 2 >= len(query)
                or query[index + 1] not in "0123456789abcdefABCDEF"
                or query[index + 2] not in "0123456789abcdefABCDEF"
            ):
                raise _Abort("policy")
            index += 3
        decoded = unquote_to_bytes(query.replace("+", " ")).decode("utf-8", "strict")
        if any(
            ord(character) < 32
            or ord(character) == 127
            or unicodedata.category(character) in {"Cc", "Cf"}
            for character in decoded
        ):
            raise _Abort("policy")
        normalized = normalize_url(
            policy_value,
            allowed_schemes=policy.allowed_schemes,
            allowed_ports=policy.allowed_ports,
        )
        canonical = urlsplit(normalized.url)
        return urlunsplit((canonical.scheme, canonical.netloc, canonical.path, query, ""))
    except _Abort:
        raise
    except (UnicodeError, PolicyError, TypeError, ValueError):
        raise _Abort("policy") from None


class _FlowState:
    """Private state shared by route, popup, download and flow callbacks."""

    __slots__ = (
        "scope_permit",
        "host_policy",
        "resolver",
        "destination_policy",
        "destination_guard",
        "capture_guard",
        "navigation_only",
        "discard_unapproved_subresources",
        "budget",
        "clock",
        "started_at",
        "deadline",
        "cancel_event",
        "max_bytes_per_download",
        "cleanup_timeout_seconds",
        "usage",
        "policy_rejection",
        "policy_rejection_after_operation",
        "admitted_requests",
        "blocked_requests",
        "destinations",
        "host_leases",
        "prebound_origins",
        "navigations",
        "page_statuses",
        "request_leases",
        "pending_response_downloads",
        "pending_local_downloads",
        "runtime",
        "lock",
        "condition",
        "closed",
        "cleanup_started",
        "cleanup_finished",
        "cleanup_failed",
        "cleanup_claims",
        "active_tasks",
        "pages",
        "popups",
        "downloads",
        "streams",
        "viewer_locators",
        "verified_locators",
        "captures",
        "capture_digests",
        "agent_pages",
        "error",
    )

    def __init__(
        self,
        scope_permit: AccessPermit,
        host_policy: AccessPolicy,
        resolver: ResolverLike,
        destination_policy: DestinationPolicy,
        destination_guard: BrowserDestinationGuard | None,
        capture_guard: BrowserCaptureGuard | None,
        navigation_only: bool,
        discard_unapproved_subresources: bool,
        budget: BrowserBudget,
        clock: Clock,
        deadline: float,
        cancel_event: threading.Event | None,
        max_bytes_per_download: int,
        cleanup_timeout_seconds: float,
    ) -> None:
        self.scope_permit = scope_permit
        self.host_policy = host_policy
        self.resolver = resolver
        self.destination_policy = destination_policy
        self.destination_guard = destination_guard
        self.capture_guard = capture_guard
        self.navigation_only = navigation_only
        self.discard_unapproved_subresources = discard_unapproved_subresources
        self.budget = budget
        self.clock = clock
        self.started_at = clock()
        self.deadline = deadline
        self.cancel_event = cancel_event
        self.max_bytes_per_download = max_bytes_per_download
        self.cleanup_timeout_seconds = cleanup_timeout_seconds
        self.usage = _Usage()
        self.policy_rejection = False
        self.policy_rejection_after_operation = False
        self.admitted_requests = 0
        self.blocked_requests = 0
        self.destinations: dict[str, ResolvedDestination] = {}
        self.host_leases: dict[str, _ArticleHostLease] = {}
        self.prebound_origins: set[str] = set()
        self.navigations: dict[int, _Navigation] = {}
        self.page_statuses: dict[int, int | None] = {}
        self.request_leases: dict[int, _RequestLease] = {}
        self.pending_response_downloads: dict[str, _PendingResponseDownload] = {}
        self.pending_local_downloads: list[_PendingLocalDownload] = []
        self.runtime: object | None = None
        self.lock = threading.RLock()
        self.condition = threading.Condition(self.lock)
        self.closed = False
        self.cleanup_started = False
        self.cleanup_finished = False
        self.cleanup_failed = False
        self.cleanup_claims: dict[int, object] = {}
        self.active_tasks: dict[int, _RuntimeTask] = {}
        self.pages: list[object] = []
        self.popups: list[object] = []
        self.downloads: list[object] = []
        self.streams: list[object] = []
        self.viewer_locators: set[str] = set()
        self.verified_locators: set[str] = set()
        self.captures: list[BrowserCapture] = []
        self.capture_digests: set[bytes] = set()
        self.agent_pages: dict[int, _AgentPageState] = {}
        self.error: _Abort | None = None

    def check(self) -> None:
        with self.lock:
            if self.error is not None:
                raise self.error
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

    def mark_cleanup_failure(self) -> None:
        with self.condition:
            self.cleanup_failed = True
            self.condition.notify_all()

    def close_for_results(self) -> None:
        """Invalidate callbacks before runtime teardown starts."""

        with self.condition:
            self.closed = True
            self.condition.notify_all()

    def own_page(self, page: object) -> bool:
        with self.lock:
            if self.closed:
                return False
            if all(candidate is not page for candidate in self.pages):
                self.pages.append(page)
            return True

    def register_popup(self, page: object) -> bool:
        """Own one popup once across runtime events and direct return values."""

        with self.lock:
            if self.closed:
                raise _Abort("cleanup")
            is_new = all(candidate is not page for candidate in self.popups)
            if is_new:
                self.popups.append(page)
            if all(candidate is not page for candidate in self.pages):
                self.pages.append(page)
            return is_new

    def own_download(self, download: object) -> bool:
        with self.lock:
            if self.closed:
                return False
            if all(candidate is not download for candidate in self.downloads):
                self.downloads.append(download)
            return True

    def own_stream(self, stream: object) -> bool:
        with self.lock:
            if self.closed:
                return False
            if all(candidate is not stream for candidate in self.streams):
                self.streams.append(stream)
            return True

    def forget_stream(self, stream: object) -> None:
        with self.lock:
            self.streams = [candidate for candidate in self.streams if candidate is not stream]

    def take_article_resources(
        self,
    ) -> tuple[tuple[object, ...], tuple[object, ...], tuple[object, ...]]:
        with self.lock:
            pages = tuple(self.pages)
            downloads = tuple(self.downloads)
            streams = tuple(self.streams)
            self.pages.clear()
            self.downloads.clear()
            self.streams.clear()
            return pages, downloads, streams

    def claim_cleanup(self, value: object) -> bool:
        with self.lock:
            identity = id(value)
            existing = self.cleanup_claims.get(identity)
            if existing is value:
                return False
            self.cleanup_claims[identity] = value
            return True

    def register_task(self, task: _RuntimeTask) -> None:
        with self.condition:
            self.active_tasks[id(task)] = task
            self.condition.notify_all()

    def finish_task(self, task: _RuntimeTask) -> None:
        with self.condition:
            self.active_tasks.pop(id(task), None)
            self.condition.notify_all()

    def wait_for_tasks(self, deadline: float) -> bool:
        """Wait within the local cleanup budget; never use Provider clocks."""

        while True:
            with self.condition:
                finished = tuple(
                    task for task in self.active_tasks.values() if task.finished.is_set()
                )
                for task in finished:
                    self.active_tasks.pop(id(task), None)
                    if task.late_cleanup_failed:
                        self.cleanup_failed = True
                if not self.active_tasks:
                    return not self.cleanup_failed
            remaining = deadline - time.monotonic()
            if remaining <= 0.0:
                self.mark_cleanup_failure()
                return False
            # A vendor task may not signal this condition directly, so poll a
            # short bounded interval while retaining one total cleanup budget.
            time.sleep(min(remaining, 0.01))

    def begin_cleanup(self) -> bool:
        with self.condition:
            if self.cleanup_started:
                return False
            self.cleanup_started = True
            return True

    def finish_cleanup(self, *, failed: bool) -> None:
        with self.condition:
            self.cleanup_failed = self.cleanup_failed or failed
            self.cleanup_finished = True
            self.condition.notify_all()

    def wait_for_cleanup(self, deadline: float) -> bool:
        with self.condition:
            while not self.cleanup_finished:
                remaining = deadline - time.monotonic()
                if remaining <= 0.0:
                    self.cleanup_failed = True
                    return False
                self.condition.wait(timeout=min(remaining, 0.01))
            return not self.cleanup_failed

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
            limits = (
                ("navigations", self.usage.navigations, self.budget.max_navigations, "budget"),
                ("requests", self.usage.requests, self.budget.max_requests, "budget"),
                ("popups", self.usage.popups, self.budget.max_popups, "budget"),
                ("downloads", self.usage.downloads, self.budget.max_downloads, "budget"),
                ("captures", self.usage.captures, self.budget.max_captures, "budget"),
                ("total-bytes", self.usage.total_bytes, self.budget.max_total_bytes, "oversize"),
            )
            for resource, used, limit, code in limits:
                if used <= limit:
                    continue
                _LOGGER.debug(
                    "event=browser-budget-exceeded resource=%s used=%d limit=%d code=%s",
                    resource,
                    used,
                    limit,
                    code,
                )
                raise _Abort(code)

    def record_request(self, *, admitted: bool) -> None:
        """Record safe aggregate route facts without retaining locators."""

        if type(admitted) is not bool:
            raise TypeError("admitted must be a bool")
        with self.lock:
            if admitted:
                self.admitted_requests += 1
            else:
                self.blocked_requests += 1

    def mark_policy_rejection(self) -> None:
        """Remember a non-navigation response policy rejection without aborting its page."""

        with self.lock:
            self.policy_rejection = True

    def defer_policy_rejection_until_operation_finishes(self) -> None:
        """Keep an acknowledged route rejection from cancelling its active action."""

        with self.condition:
            self.policy_rejection = True
            self.policy_rejection_after_operation = True
            self.condition.notify_all()

    def check_deferred_policy_rejection(self) -> None:
        """Raise a sticky route policy result only at a vendor-call boundary."""

        with self.lock:
            if self.policy_rejection_after_operation:
                raise _Abort("policy")

    def challenge_resource_facts(self) -> BrowserChallengeResourceFacts:
        """Return aggregate challenge-resource facts from the closed guard.

        The guard is intentionally optional: ordinary Browser rules do not
        declare a challenge dependency and therefore expose an empty fact
        set.  A malformed optional hook is a runtime contract failure rather
        than a reason to guess that resources were safe.
        """

        guard = self.destination_guard
        provider = guard if isinstance(guard, BrowserChallengeFactsProvider) else None
        if provider is None:
            return BrowserChallengeResourceFacts(
                pending_count=self._pending_request_count(),
            )
        try:
            facts = provider.challenge_resource_facts()
        except Exception as error:
            raise _Abort("runtime") from error
        if not isinstance(facts, BrowserChallengeResourceFacts):
            raise _Abort("runtime")
        pending = self._pending_request_count()
        return BrowserChallengeResourceFacts(
            admitted_count=facts.admitted_count,
            blocked_count=facts.blocked_count,
            pending_count=pending,
        )

    def _pending_request_count(self) -> int:
        with self.lock:
            return len(self.request_leases)

    def challenge_observation(self, page: object) -> BrowserChallengeObservation:
        """Build a safe, request-local challenge snapshot for Acquisition."""

        locator = _text_attribute(page, "url")
        if locator is None or _is_internal_url(locator):
            raise _Abort("runtime")
        policy_locator = _policy_url(locator)
        try:
            normalized = normalize_url(
                policy_locator,
                allowed_schemes=self.destination_policy.allowed_schemes,
                allowed_ports=self.destination_policy.allowed_ports,
            )
        except (PolicyError, TypeError, ValueError) as error:
            raise _Abort("policy") from error
        self.guard(normalized.url, BrowserDestinationKind.RESPONSE)
        page_observation = BrowserPageObservation(
            locator=normalized.url,
            status_code=self.page_statuses.get(id(page)),
        )
        resources = self.challenge_resource_facts()
        with self.lock:
            captures = len(self.captures)
        return BrowserChallengeObservation(
            page=page_observation,
            resources=resources,
            capture_count=captures,
            settled=resources.pending_count == 0,
        )

    def wait_for_challenge_settle(
        self,
        page: object,
        timeout_seconds: float,
    ) -> BrowserChallengeObservation:
        """Wait for a short quiet window without sleeping past the article budget."""

        if isinstance(timeout_seconds, bool) or not isinstance(timeout_seconds, (int, float)):
            raise _Abort("policy")
        timeout = float(timeout_seconds)
        if timeout <= 0 or timeout != timeout or timeout == float("inf"):
            raise _Abort("policy")
        started = self.clock()
        deadline = min(self.deadline, started + timeout)
        stable_polls = 0
        latest: BrowserChallengeObservation | None = None
        while True:
            self.check()
            latest = self.challenge_observation(page)
            if latest.resources.resource_blocked:
                return latest
            if latest.settled:
                stable_polls += 1
                if stable_polls >= 2:
                    return latest
            else:
                stable_polls = 0
            remaining = deadline - self.clock()
            if remaining <= 0:
                return latest
            with self.condition:
                self.condition.wait(timeout=min(remaining, 0.05))

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
        self.wait_for_any_capture((kind,))

    def wait_for_any_capture(self, kinds: tuple[BrowserCaptureKind, ...]) -> None:
        if (
            not isinstance(kinds, tuple)
            or not kinds
            or any(not isinstance(kind, BrowserCaptureKind) for kind in kinds)
            or len(kinds) != len(set(kinds))
        ):
            raise _Abort("policy")
        started_at = self.clock()
        settle_deadline = min(
            self.deadline,
            started_at + self.budget.max_capture_wait_seconds,
        )
        _LOGGER.debug(
            "event=browser-capture-wait-started max_wait_seconds=%.3f",
            self.budget.max_capture_wait_seconds,
        )
        with self.condition:
            while not any(capture.kind in kinds for capture in self.captures):
                if self.error is not None:
                    raise self.error
                self.check()
                remaining = settle_deadline - self.clock()
                if remaining <= 0:
                    _LOGGER.debug(
                        "event=browser-capture-wait-finished outcome=no-capture elapsed_ms=%d",
                        max(int((self.clock() - started_at) * 1000), 0),
                    )
                    return
                self.condition.wait(timeout=min(remaining, 0.25))
        _LOGGER.debug(
            "event=browser-capture-wait-finished outcome=captured elapsed_ms=%d",
            max(int((self.clock() - started_at) * 1000), 0),
        )

    def wait_for_page_result(
        self,
        page: object,
        *,
        prior_capture_count: int,
    ) -> None:
        """Wait until a page's top-level request and capture callback settle."""

        if type(prior_capture_count) is not int or prior_capture_count < 0:
            raise _Abort("runtime")
        with self.condition:
            while True:
                if self.error is not None:
                    raise self.error
                navigation_active = any(
                    lease.page is page and lease.navigation
                    for lease in self.request_leases.values()
                )
                if not navigation_active:
                    return
                self.check()
                remaining = self.deadline - self.clock()
                if remaining <= 0:
                    raise _Abort("timeout")
                self.condition.wait(timeout=min(remaining, 0.25))

    def capture_available(self, kind: BrowserCaptureKind) -> bool:
        if not isinstance(kind, BrowserCaptureKind):
            raise _Abort("policy")
        with self.condition:
            return any(capture.kind is kind for capture in self.captures)

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

    def guard_request(
        self,
        request: object,
        page: object | None,
        value: str,
        kind: BrowserDestinationKind,
        *,
        capture_kind: BrowserCaptureKind | None = None,
    ) -> None:
        """Apply the optional context-sensitive rule before route I/O.

        ``BrowserDestinationGuard.check`` remains the inexpensive URL/kind
        gate used by every caller.  A rule that declares a narrowly scoped
        dependency may additionally implement ``check_request``; Network
        supplies only the bounded request/frame facts below.  The hook is
        intentionally best-effort for legacy guards that do not implement it,
        while an implemented hook is fail-closed on malformed observations.
        """

        guard = self.destination_guard
        if guard is None or not isinstance(guard, BrowserRequestGuard):
            return
        try:
            observation = self._request_observation(
                request,
                page,
                value,
                kind,
                capture_kind=capture_kind,
            )
            guard.check_request(observation)
        except _Abort:
            raise
        except Exception as error:
            raise _Abort("policy") from error

    def _request_observation(
        self,
        request: object,
        page: object | None,
        value: str,
        kind: BrowserDestinationKind,
        *,
        capture_kind: BrowserCaptureKind | None,
    ) -> BrowserRequestObservation:
        navigation = BrowserClient._is_navigation_request(request)
        resource_type = _text_attribute(request, "resource_type") or (
            "document" if navigation else "other"
        )
        top_frame = _attribute(request, "is_top_frame")
        if type(top_frame) is not bool:
            # Legacy wrappers expose no frame metadata.  Treat a navigation
            # request as top-frame only when the wrapper explicitly confirms
            # it; context-sensitive challenge rules must reject unknown
            # ancestry rather than guessing.
            top_frame = False
        depth = _attribute(request, "frame_depth")
        frame_depth = depth if type(depth) is int else None
        ancestry_value = _attribute(request, "frame_ancestry")
        ancestry = ancestry_value if isinstance(ancestry_value, tuple) else ()
        top_locator = _text_attribute(request, "top_frame_locator")
        if top_locator is None and page is not None:
            top_locator = _text_attribute(page, "top_frame_locator")
        redirected = _attribute(request, "redirected_from")
        redirect_depth = 0
        seen: set[int] = set()
        current = redirected
        while current is not None and redirect_depth < 32:
            identity = id(current)
            if identity in seen:
                break
            seen.add(identity)
            redirect_depth += 1
            current = _attribute(current, "redirected_from")
        is_popup = page is not None and any(candidate is page for candidate in self.popups)
        return BrowserRequestObservation(
            locator=value,
            kind=kind,
            resource_type=resource_type,
            is_navigation=navigation,
            is_top_frame=top_frame,
            frame_depth=frame_depth,
            frame_ancestry=ancestry,
            top_frame_locator=top_locator,
            is_popup=is_popup,
            redirect_depth=redirect_depth,
            capture_kind=capture_kind,
        )

    def acquire_host(self, destination: ResolvedDestination) -> HostPermit:
        """Acquire one host permit per article and reuse it for all subrequests.

        A Playwright route callback runs on the same engine thread that emits
        response completion events.  Waiting for a second same-host permit in
        that callback can therefore prevent the event which would release the
        first request from ever running.  The high-level Browser scheduler
        already serializes articles for one Publisher; this lease keeps shared
        cross-scope host admission while allowing a normal page to load its
        same-host CSS, JavaScript, images and PDF request concurrently.
        """

        lease, existing = self._claim_article_host_lease(destination.hostname)
        if existing is not None:
            return existing

        try:
            permit = self.scope_permit.acquire_host(
                destination.hostname,
                host_policy=self.host_policy,
                cancel_event=self.cancel_event,
                timeout=max(self.deadline - self.clock(), 0.001),
            )
        except AccessCancelled as error:
            code = "cancelled"
            cause: Exception = error
        except AdmissionTimeout as error:
            code = "timeout"
            cause = error
        except Exception as error:
            code = "admission"
            cause = error
        else:
            with self.condition:
                lease.permit = permit
                lease.acquiring = False
                self.condition.notify_all()
            self.check()
            return permit

        with self.condition:
            lease.error_code = code
            lease.acquiring = False
            self.condition.notify_all()
        raise _Abort(code) from cause

    def _claim_article_host_lease(
        self,
        hostname: str,
    ) -> tuple[_ArticleHostLease, HostPermit | None]:
        with self.condition:
            while True:
                self.check()
                lease = self.host_leases.get(hostname)
                if lease is None:
                    lease = _ArticleHostLease()
                    self.host_leases[hostname] = lease
                    return lease, None
                if lease.permit is not None:
                    if lease.permit.released:
                        raise _Abort("cleanup")
                    return lease, lease.permit
                if lease.error_code is not None:
                    raise _Abort(lease.error_code)
                if not lease.acquiring:
                    raise _Abort("cleanup")
                remaining = self.deadline - self.clock()
                if remaining <= 0:
                    raise _Abort("timeout")
                self.condition.wait(timeout=min(remaining, 0.25))

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

    def register_request(
        self,
        request: object,
        *,
        page: object | None,
        destination: ResolvedDestination,
        navigation: bool,
    ) -> None:
        with self.lock:
            self.request_leases[id(request)] = _RequestLease(
                request=request,
                page=page,
                destination=destination,
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
        with self.condition:
            self.condition.notify_all()

    def find_request_for_download(self, destination: ResolvedDestination) -> object | None:
        """Correlate a download with its intercepted request, fail closed if ambiguous."""

        with self.lock:
            matches = [
                lease.request
                for lease in self.request_leases.values()
                if lease.destination.url.url == destination.url.url
            ]
        return matches[0] if len(matches) == 1 else None

    def expect_response_download(
        self,
        destination: ResolvedDestination,
        lease: _RequestLease,
        *,
        kind: BrowserCaptureKind,
        media_type: str,
        capture_allowed: bool,
    ) -> None:
        key = destination.url.url
        with self.condition:
            existing = self.pending_response_downloads.get(key)
            pending = _PendingResponseDownload(
                lease=lease,
                kind=kind,
                media_type=media_type,
                capture_allowed=capture_allowed,
            )
            if existing is not None and existing != pending:
                raise _Abort("runtime")
            self.pending_response_downloads[key] = pending
            self.condition.notify_all()

    def take_response_download(
        self,
        destination: ResolvedDestination,
    ) -> _PendingResponseDownload | None:
        with self.condition:
            pending = self.pending_response_downloads.pop(destination.url.url, None)
            self.condition.notify_all()
            return pending

    def duplicate_download_is_proven(self, destination: ResolvedDestination) -> bool:
        """Return whether a native Download is a safe late duplicate.

        Chromium may emit a second ``download`` event after a PDF response has
        already been captured (Springer is one observed example).  A download
        event without a live intercepted request normally fails closed because
        Network cannot prove that its bytes travelled through the reviewed
        route.  The only exception is an operation-local duplicate for the
        exact query-free locator that is already present in ``captures`` and
        for which no response/download request is still pending or live.  This
        predicate deliberately keeps all of those proofs private to one
        article ``_FlowState``; it never authorises a new destination or reads
        the late download body.
        """

        if not isinstance(destination, ResolvedDestination):
            raise TypeError("destination must be a ResolvedDestination")
        locator = destination.url.url
        with self.condition:
            if not any(capture.stream.final_locator == locator for capture in self.captures):
                return False
            if locator in self.pending_response_downloads:
                return False
            if any(
                pending.destination.url.url == locator for pending in self.pending_local_downloads
            ):
                return False
            if any(lease.destination.url.url == locator for lease in self.request_leases.values()):
                return False
            return True

    def request_waits_for_response_download(self, request: object) -> bool:
        with self.condition:
            return any(
                pending.lease.request is request
                for pending in self.pending_response_downloads.values()
            )

    def expect_local_download(
        self,
        destination: ResolvedDestination,
        *,
        media_type: str,
        kind: BrowserCaptureKind,
        lease: _RequestLease,
    ) -> None:
        with self.lock:
            if len(self.pending_local_downloads) >= self.budget.max_downloads:
                raise _Abort("budget")
            self.pending_local_downloads.append(
                _PendingLocalDownload(
                    destination=destination,
                    media_type=media_type,
                    kind=kind,
                    lease=lease,
                )
            )
            self.condition.notify_all()

    def take_local_download(self) -> _PendingLocalDownload | None:
        with self.condition:
            pending = self.pending_local_downloads.pop(0) if self.pending_local_downloads else None
            self.condition.notify_all()
            return pending

    def validate_local_blob(self, value: str) -> None:
        """Accept only an opaque blob created on one prebound HTTPS origin."""

        try:
            parsed = urlsplit(value)
            if (
                parsed.scheme.casefold() != "blob"
                or not parsed.path
                or parsed.query
                or parsed.fragment
                or len(value) > 8192
            ):
                raise _Abort("policy")
            embedded = normalize_url(
                _policy_url(parsed.path),
                allowed_schemes=self.destination_policy.allowed_schemes,
                allowed_ports=self.destination_policy.allowed_ports,
            )
        except _Abort:
            raise
        except (PolicyError, TypeError, ValueError) as error:
            raise _Abort("policy") from error
        if embedded.origin.text not in self.prebound_origins:
            raise _Abort("policy")

    def correlate_response_request(
        self,
        request: object,
        destination: ResolvedDestination,
    ) -> _RequestLease | None:
        """Find one live route lease, including a native redirect-chain root.

        Playwright routes only the first URL of a native redirect chain.  A
        later chain member is admissible only when it points back to that live
        request, stays on the same non-null page, and its exact origin was
        reviewed, resolved and pinned in the transparent CONNECT tunnel before
        the article began.  These conditions apply equally to navigation and
        ordinary page-subresource redirects.
        """

        current: object | None = request
        redirected = False
        seen: set[int] = set()
        while current is not None and len(seen) < 32:
            identity = id(current)
            if identity in seen:
                return None
            seen.add(identity)
            with self.lock:
                lease = self.request_leases.get(identity)
            if lease is not None and lease.request is current:
                if lease.destination.url.url == destination.url.url:
                    return lease
                request_page = _attribute(request, "page")
                if (
                    redirected
                    and lease.page is not None
                    and request_page is lease.page
                    and destination.url.origin.text in self.prebound_origins
                ):
                    # Playwright does not always expose a native redirect
                    # member through a second route callback.  The reviewed,
                    # prebound destination still needs its own article-level
                    # host admission before any terminal response body can be
                    # classified or captured.  Same-host redirects simply
                    # reuse the existing permit; cross-host redirects acquire
                    # and retain the additional permit through teardown.
                    self.acquire_host(destination)
                    return lease
                return None
            current = _attribute(current, "redirected_from")
            redirected = True
        return None

    def finish_page_navigation(self, page: object) -> None:
        """Finish navigation leases only after the runtime says goto is done."""

        with self.lock:
            leases = [
                lease
                for lease in self.request_leases.values()
                if lease.page is page and lease.navigation
            ]
            self.navigations.pop(id(page), None)
        for lease in leases:
            self.finish_request(lease.request)

    def detach_navigation(self, page: object) -> None:
        """Detach navigation bookkeeping while request correlation stays live."""

        with self.lock:
            self.navigations.pop(id(page), None)

    def finish_all_requests(self) -> bool:
        with self.lock:
            leases = tuple(self.request_leases.values())
            self.request_leases.clear()
            self.pending_response_downloads.clear()
            self.pending_local_downloads.clear()
            self.navigations.clear()
            host_leases = tuple(self.host_leases.values())
            self.host_leases.clear()
        failed = self.cleanup_failed
        for lease in leases:
            if lease.completed:
                continue
            lease.completed = True
        for host_lease in host_leases:
            permit = host_lease.permit
            if permit is None:
                continue
            try:
                permit.release()
            except Exception:
                failed = True
                self.mark_cleanup_failure()
        return failed

    def check_challenge(self, page: object, response: object | None = None) -> None:
        """Honor only an explicit runtime abort, not generic page text.

        Page challenge/paywall/login classification belongs to Acquisition's
        reviewed Publisher markers.  Scanning title/body here used to abort a
        page before its approved challenge resources could settle and also
        misclassified ordinary ``access denied`` pages.  The explicit
        ``challenge`` flag is retained as a narrow vendor/runtime fail-closed
        signal for legacy adapters and offline fixtures.
        """

        del response
        challenge = _attribute(page, "challenge")
        if challenge is True:
            raise _Abort("challenge")


class _BrowserAgentActionPort:
    """Request-local neutral Agent action port over one private page lane."""

    __slots__ = ("_client", "_state", "_page")

    def __init__(self, client: BrowserClient, state: _FlowState, page: object) -> None:
        self._client = client
        self._state = state
        self._page = page

    def observe(self) -> BrowserAgentObservation:
        return self._client._client_agent_observe(self._state, self._page)

    def execute(
        self,
        command: BrowserAgentActionCommand,
        observation: BrowserAgentObservation,
        *,
        timeout_seconds: float,
    ) -> None:
        self._client._client_agent_execute(
            self._state,
            self._page,
            command,
            observation,
            timeout_seconds=timeout_seconds,
        )


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
        "_discover_pdf_locators_operation",
        "_click_operation",
        "_fill_operation",
        "_has_selector_operation",
        "_text_operation",
        "_observe_operation",
        "_capture_available_operation",
        "_wait_for_capture_operation",
        "_wait_for_any_capture_operation",
        "_challenge_observation_operation",
        "_wait_for_challenge_settle_operation",
        "_agent_action_port_operation",
    )

    def __init__(self, client: BrowserClient, state: _FlowState, page: object) -> None:
        self._navigate_operation = lambda url: client._client_navigate(state, page, url)
        self._popup_operation = lambda url: client._client_open_popup(state, page, url)
        self._viewer_operation = lambda url: client._client_open_viewer(state, page, url)
        self._verified_locator_operation = lambda url: client._client_open_verified_locator(
            state, page, url
        )
        self._discover_pdf_locators_operation = lambda: client._client_discover_pdf_locators(
            state, page
        )
        self._click_operation = lambda selector: client._client_click(state, page, selector)
        self._fill_operation = lambda selector, value: client._client_fill(
            state, page, selector, value
        )
        self._has_selector_operation = lambda selector: client._client_has_selector(
            state, page, selector
        )
        self._text_operation = lambda selector: client._client_text(state, page, selector)
        self._observe_operation = lambda: client._client_observe(state, page)
        self._capture_available_operation = lambda kind: state.capture_available(kind)
        self._wait_for_capture_operation = lambda kind: state.wait_for_capture(kind)
        self._wait_for_any_capture_operation = lambda kinds: state.wait_for_any_capture(kinds)
        self._challenge_observation_operation = lambda: state.challenge_observation(page)
        self._wait_for_challenge_settle_operation = lambda timeout: state.wait_for_challenge_settle(
            page,
            timeout,
        )
        self._agent_action_port_operation = lambda: _BrowserAgentActionPort(client, state, page)

    def navigate(self, url: str) -> None:
        self._navigate_operation(url)

    def open_popup(self, url: str) -> None:
        self._popup_operation(url)

    def open_viewer(self, locator: str) -> None:
        self._viewer_operation(locator)

    def open_verified_locator(self, locator: str) -> None:
        self._verified_locator_operation(locator)

    def discover_pdf_locators(self) -> tuple[str, ...]:
        return self._discover_pdf_locators_operation()

    def click(self, selector: str) -> bool:
        return self._click_operation(selector)

    def fill(self, selector: str, value: str) -> None:
        self._fill_operation(selector, value)

    def has_selector(self, selector: str) -> bool:
        return self._has_selector_operation(selector)

    def text(self, selector: str) -> str:
        return self._text_operation(selector)

    def observe(self) -> BrowserPageObservation:
        return self._observe_operation()

    def capture_available(self, kind: BrowserCaptureKind) -> bool:
        return self._capture_available_operation(kind)

    def wait_for_capture(self, kind: BrowserCaptureKind) -> None:
        self._wait_for_capture_operation(kind)

    def wait_for_any_capture(self, kinds: tuple[BrowserCaptureKind, ...]) -> None:
        self._wait_for_any_capture_operation(kinds)

    def challenge_observation(self) -> BrowserChallengeObservation:
        """Return one bounded challenge/resource snapshot for this page."""

        return self._challenge_observation_operation()

    def wait_for_challenge_settle(self, timeout_seconds: float) -> BrowserChallengeObservation:
        """Wait for a bounded quiet window and return its final snapshot."""

        return self._wait_for_challenge_settle_operation(timeout_seconds)

    def agent_action_port(self) -> BrowserAgentActionPort:
        """Return one request-local neutral Agent page capability."""

        return self._agent_action_port_operation()


class BrowserClient:
    """Run one isolated, policy-checked Browser flow."""

    __slots__ = (
        "_factory",
        "_resolver",
        "_coordinator",
        "_destination_policy",
        "_host_policy",
        "_session_broker",
        "_clock",
        "_timeout_seconds",
        "_cleanup_timeout_seconds",
        "_budget",
    )

    def __init__(
        self,
        *,
        factory: BrowserFactory,
        resolver: ResolverLike,
        coordinator: AccessCoordinator,
        destination_policy: DestinationPolicy | None = None,
        host_policy: AccessPolicy | None = None,
        session_broker: BrowserSessionBroker | None = None,
        timeout_seconds: float = _DEFAULT_TIMEOUT_SECONDS,
        cleanup_timeout_seconds: float = _DEFAULT_CLEANUP_TIMEOUT_SECONDS,
        budget: BrowserBudget | None = None,
        clock: Clock | None = None,
    ) -> None:
        if not callable(factory):
            raise TypeError("factory must be callable")
        if not isinstance(coordinator, AccessCoordinator):
            raise TypeError("coordinator must be an AccessCoordinator")
        if not isinstance(destination_policy, (DestinationPolicy, type(None))):
            raise TypeError("destination_policy must be a DestinationPolicy")
        if host_policy is not None and not isinstance(host_policy, AccessPolicy):
            raise TypeError("host_policy must be an AccessPolicy or None")
        timeout = _positive_seconds(timeout_seconds, field_name="timeout_seconds")
        cleanup_timeout = _positive_seconds(
            cleanup_timeout_seconds,
            field_name="cleanup_timeout_seconds",
        )
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
        self._host_policy = host_policy or _DEFAULT_HOST_REQUEST_POLICY
        self._session_broker = session_broker
        self._clock = clock or time.monotonic
        self._timeout_seconds = timeout
        self._cleanup_timeout_seconds = cleanup_timeout
        self._budget = budget or BrowserBudget()

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
        controller: BrowserFlowController | None = None,
        destination_guard: BrowserDestinationGuard | None = None,
        capture_guard: BrowserCaptureGuard | None = None,
        navigation_only: bool = False,
        discard_unapproved_subresources: bool = False,
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
            if controller is not None and not isinstance(controller, BrowserFlowController):
                raise _Abort("policy")
            if type(navigation_only) is not bool:
                raise _Abort("policy")
            if type(discard_unapproved_subresources) is not bool:
                raise _Abort("policy")
            if navigation_only and discard_unapproved_subresources:
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
                self._host_policy,
                self._resolver,
                self._destination_policy,
                destination_guard,
                capture_guard,
                navigation_only,
                discard_unapproved_subresources,
                effective_budget,
                self._clock,
                deadline,
                cancel_event,
                effective_budget.max_bytes_per_download,
                self._cleanup_timeout_seconds,
            )
            state.destinations[initial.hostname] = initial
            initial_binding = self._binding(initial)
            temporary = tempfile.TemporaryDirectory(prefix="sciretriever-browser-")
            temporary_path = Path(temporary.name)
            os.chmod(temporary_path, stat.S_IRWXU)
            state.check()

            if self._session_broker is None:
                process_manager = self._run_cancellable(
                    state,
                    lambda: self._factory(
                        downloads_path=str(temporary_path),
                        connection_binding=initial_binding,
                    ),
                    abort=lambda: None,
                    late_cleanup=lambda value: self._late_close(state, value),
                )
                process_runtime = process_manager
                enter = getattr(process_manager, "__enter__", None)
                if callable(enter):
                    entered_value = self._run_cancellable(
                        state,
                        enter,
                        abort=lambda: self._abort_runtime(None, None, process_manager),
                        late_cleanup=lambda value: self._late_close(state, value),
                    )
                    entered_process = True
                    if entered_value is not None:
                        process_runtime = entered_value
                if process_runtime is None:
                    raise _Abort("runtime")
                self._run_cancellable(
                    state,
                    lambda: self._acknowledge_binding(process_runtime, initial_binding),
                    abort=lambda: self._abort_runtime(None, None, process_runtime),
                )
                state.runtime = process_runtime
                launch = getattr(process_runtime, "new_context", None)
                if not callable(launch):
                    raise _Abort("runtime")
                context = cast(
                    _PageContext,
                    self._run_cancellable(
                        state,
                        lambda: launch(
                            downloads_path=str(temporary_path),
                            accept_downloads=True,
                            connection_binding=initial_binding,
                        ),
                        abort=lambda: self._abort_runtime(None, None, process_runtime),
                        late_cleanup=lambda value: self._late_close(state, value),
                    ),
                )
                self._run_cancellable(
                    state,
                    lambda: self._acknowledge_binding(context, initial_binding),
                    abort=lambda: self._abort_runtime(None, context, process_runtime),
                )
                self._run_cancellable(
                    state,
                    lambda: self._install_handlers(state, context),
                    abort=lambda: self._abort_runtime(None, context, process_runtime),
                )
            else:
                if normalized_session_key is None:
                    raise _Abort("policy")
                session_lease = cast(
                    BrowserSessionLease,
                    self._run_cancellable(
                        state,
                        lambda: self._session_broker.acquire(
                            normalized_session_key,
                            factory=self._factory,
                            downloads_path=str(temporary_path),
                            connection_binding=initial_binding,
                            route_handler=self._route_handler(state),
                            event_handlers=self._event_handlers(state),
                            cancel_event=cancel_event,
                            timeout=max(deadline - self._clock(), 0.001),
                        ),
                        abort=lambda: None,
                        late_cleanup=self._discard_late_session_lease,
                    ),
                )
                process_runtime = session_lease.process_runtime
                context = cast(_PageContext, session_lease.context)
                state.runtime = process_runtime
            self._prebind_connection_origins(
                state,
                context,
                initial,
                destination_guard,
            )
            new_page = getattr(context, "new_page", None)
            if not callable(new_page):
                raise _Abort("runtime")
            page = self._run_cancellable(
                state,
                new_page,
                abort=lambda: self._abort_runtime(None, context, process_runtime),
                late_cleanup=lambda value: self._late_close(state, value),
            )
            if not state.own_page(page):
                if state.claim_cleanup(page) and not self._close_object(page):
                    state.mark_cleanup_failure()
                raise _Abort("cleanup")
            self._client_navigate(state, page, initial.url.url)
            state.check()
            if controller is not None:
                session = _BrowserSession(self, state, page)
                controller_result = self._run_cancellable(
                    state,
                    lambda: controller.run(session),
                    abort=lambda: self._abort_runtime(page, context, process_runtime),
                )
                # Controller results are intentionally not a Network/Browser
                # data channel.  A typed controller performs side effects and
                # returns ``None``; any vendor/object result is rejected before
                # the flow can report a capture.
                if controller_result is not None:
                    raise _Abort("runtime")
            state.check()
            state.check_challenge(page)
            if state.error is not None:
                raise state.error
            if state.policy_rejection:
                raise _Abort("policy")
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
            final_cleanup_deadline = time.monotonic() + self._cleanup_timeout_seconds
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
                if state is None:
                    try:
                        session_lease.drain_article()
                    except BrowserSessionError:
                        cleanup_error = True
                        session_lease.invalidate()
                elif not self._cleanup_call(
                    state,
                    (session_lease, "drain"),
                    session_lease.drain_article,
                    final_cleanup_deadline,
                ):
                    cleanup_error = True
                    session_lease.invalidate()
                if state is None:
                    try:
                        session_lease.release()
                    except BrowserSessionError:
                        cleanup_error = True
                elif not self._cleanup_call(
                    state,
                    (session_lease, "release"),
                    session_lease.release,
                    final_cleanup_deadline,
                ):
                    cleanup_error = True
                if state is not None and state.finish_all_requests():
                    cleanup_error = True
            if temporary is not None:
                if state is None:
                    try:
                        temporary.cleanup()
                    except Exception:
                        cleanup_error = True
                elif not self._cleanup_call(
                    state,
                    (temporary, "cleanup"),
                    temporary.cleanup,
                    final_cleanup_deadline,
                ):
                    cleanup_error = True
            if scope_permit is not None:
                if state is None:
                    try:
                        scope_permit.release()
                    except Exception:
                        cleanup_error = True
                elif not self._cleanup_call(
                    state,
                    (scope_permit, "release"),
                    scope_permit.release,
                    final_cleanup_deadline,
                ):
                    cleanup_error = True
            if state is not None and not state.wait_for_tasks(final_cleanup_deadline):
                cleanup_error = True
            if state is not None and state.cleanup_failed:
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
            max_action_wait_seconds=selected.max_action_wait_seconds,
            max_capture_wait_seconds=selected.max_capture_wait_seconds,
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
        """Signal a blocking vendor operation without consuming cleanup ownership.

        Page/context/process close belongs to the deterministic teardown phase
        and must be attempted at most once.  This method therefore uses only a
        non-owning interrupt surface; teardown escalates to close and waits for
        every outstanding vendor task within the local cleanup budget.
        """

        for target in (page, context, process_runtime):
            if target is None:
                continue
            for name in ("abort", "cancel", "stop"):
                method = getattr(target, name, None)
                if not callable(method):
                    continue
                try:
                    method()
                except Exception:
                    continue
                return

    def _run_cancellable(
        self,
        state: _FlowState,
        operation: Callable[[], object],
        *,
        abort: Callable[[], None],
        late_cleanup: Callable[[object], None] | None = None,
    ) -> object:
        """Run a potentially blocking runtime operation with active abort.

        The worker is joined after abort so no late result can cross the
        Browser boundary.  ``state.check`` is also run after completion to
        invalidate a result that raced with cancellation/deadline.
        """

        state.check()
        state.check_deferred_policy_rejection()
        task = self._start_runtime_task(state, operation, late_cleanup=late_cleanup)
        while not task.finished.wait(0.01):
            try:
                state.check()
            except _Abort as error:
                self._cancel_runtime_task(
                    state,
                    task,
                    abort=abort,
                    late_cleanup=late_cleanup,
                    code=error.code,
                )
        state.finish_task(task)
        if task.failure:
            error = task.failure[0]
            if isinstance(error, _Abort):
                # Internal cancellation/cleanup failures retain their exact
                # fail-closed semantics even if a route policy stop raced the
                # same vendor call.
                raise error
            # An acknowledged route abort can make the vendor action return a
            # terminal exception. The policy result is authoritative and must
            # not trigger a second transport interruption.
            state.check_deferred_policy_rejection()
            raise error
        try:
            state.check()
        except _Abort as error:
            # The vendor call may have completed in the narrow interval between
            # the last polling check and ``finished``.  Its result has not yet
            # crossed the Network boundary, so cancellation must transfer any
            # resource result to the same bounded late-cleanup path used for a
            # still-running operation.
            self._cancel_runtime_task(
                state,
                task,
                abort=abort,
                late_cleanup=late_cleanup,
                code=error.code,
            )
        state.check_deferred_policy_rejection()
        if not task.outcome:
            raise _Abort("runtime")
        return task.outcome[0]

    @staticmethod
    def _start_runtime_task(
        state: _FlowState,
        operation: Callable[[], object],
        *,
        late_cleanup: Callable[[object], None] | None = None,
    ) -> _RuntimeTask:
        task = _RuntimeTask(late_cleanup=late_cleanup)
        state.register_task(task)
        worker = threading.Thread(target=lambda: task.invoke(operation), daemon=True)
        try:
            worker.start()
        except Exception as error:
            state.finish_task(task)
            state.mark_cleanup_failure()
            raise _Abort("cleanup") from error
        return task

    def _cancel_runtime_task(
        self,
        state: _FlowState,
        task: _RuntimeTask,
        *,
        abort: Callable[[], None],
        late_cleanup: Callable[[object], None] | None,
        code: str,
    ) -> NoReturn:
        late_values = task.abandon()
        cleanup_tasks = self._start_late_cleanup_tasks(state, late_values, late_cleanup)
        try:
            abort_task = self._start_runtime_task(state, abort)
        except _Abort:
            state.close_for_results()
            raise
        deadline = time.monotonic() + state.cleanup_timeout_seconds
        observed = (task, abort_task, *cleanup_tasks)
        self._wait_runtime_tasks(observed, deadline)
        cleanup_ok = self._finish_cancelled_tasks(state, task, cleanup_tasks, observed)
        if not cleanup_ok:
            # No result may cross the boundary after abort acknowledgement
            # failed. Final teardown escalates to owned resource close and the
            # scheduler opens the provider cleanup circuit.
            state.close_for_results()
            state.mark_cleanup_failure()
            raise _Abort("cleanup")
        raise _Abort(code)

    def _start_late_cleanup_tasks(
        self,
        state: _FlowState,
        values: tuple[object, ...],
        cleanup: Callable[[object], None] | None,
    ) -> tuple[_RuntimeTask, ...]:
        if cleanup is None:
            return ()
        tasks = []
        for value in values:
            try:
                tasks.append(
                    self._start_runtime_task(
                        state,
                        lambda value=value: cleanup(value),
                    )
                )
            except _Abort:
                state.mark_cleanup_failure()
        return tuple(tasks)

    @staticmethod
    def _wait_runtime_tasks(tasks: tuple[_RuntimeTask, ...], deadline: float) -> None:
        while any(not task.finished.is_set() for task in tasks):
            remaining = deadline - time.monotonic()
            if remaining <= 0.0:
                return
            time.sleep(min(remaining, 0.01))

    @staticmethod
    def _finish_cancelled_tasks(
        state: _FlowState,
        operation_task: _RuntimeTask,
        cleanup_tasks: tuple[_RuntimeTask, ...],
        observed: tuple[_RuntimeTask, ...],
    ) -> bool:
        for current in observed:
            if current.finished.is_set():
                state.finish_task(current)
        abort_task = observed[1]
        cleanup_failed = (
            operation_task.late_cleanup_failed
            or bool(abort_task.failure)
            or abort_task.late_cleanup_failed
            or any(current.failure or current.late_cleanup_failed for current in cleanup_tasks)
        )
        if cleanup_failed:
            state.mark_cleanup_failure()
        return (
            all(current.finished.is_set() for current in observed)
            and not cleanup_failed
            and not state.cleanup_failed
        )

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

    def _prebind_connection_origins(
        self,
        state: _FlowState,
        context: _PageContext,
        initial: ResolvedDestination,
        destination_guard: BrowserDestinationGuard | None,
    ) -> None:
        """Pin reviewed Browser origins before Chromium may open a tunnel.

        Chromium can establish a proxy CONNECT and TLS session before the
        Playwright route callback pauses the corresponding HTTP request. The
        byte tunnel must therefore know every closed Provider origin up front;
        request-level destination checks and article-host admission still
        happen later in ``_admit_route``.
        """

        origins = [initial.url.origin.text]
        if isinstance(destination_guard, BrowserConnectionOriginGuard):
            try:
                declared = destination_guard.connection_origins()
            except Exception as error:
                raise _Abort("policy") from error
            if not isinstance(declared, tuple) or len(declared) > 32:
                raise _Abort("policy")
            origins.extend(declared)
        for origin in dict.fromkeys(origins):
            try:
                normalized = normalize_url(
                    origin,
                    allowed_schemes=self._destination_policy.allowed_schemes,
                    allowed_ports=self._destination_policy.allowed_ports,
                )
                if normalized.path != "/" or normalized.query:
                    raise _Abort("policy")
                destination = resolve_destination(
                    normalized,
                    self._resolver,
                    policy=self._destination_policy,
                    previous=state.destinations.get(normalized.hostname),
                )
            except _Abort:
                raise
            except (PolicyError, TypeError, ValueError) as error:
                raise _Abort("policy") from error
            state.destinations[destination.hostname] = destination
            # A CONNECT may be established before Playwright emits a route
            # callback (notably for Service Worker traffic).  Hold the same
            # article-level host permit before prebinding so opaque transport
            # cannot bypass host pacing or cleanup.  Path/resource admission
            # still belongs to ``check_request`` when a route observation is
            # available; CONNECT itself intentionally never terminates TLS.
            state.acquire_host(destination)
            state.bind_runtime(context, destination, allow_runtime_fallback=False)
            state.prebound_origins.add(destination.url.origin.text)

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

    def _handle_route(self, state: _FlowState, raw_route: object) -> None:  # noqa: C901
        route = cast(_Route, raw_route)
        request: object | None = None
        navigation = False
        try:
            request = route.request
            url = _text_attribute(request, "url")
            if url is None:
                raise _Abort("policy")
            page = _attribute(request, "page")
            navigation = self._is_navigation_request(request)
            if state.navigation_only and not navigation:
                if not self._abort_route(route):
                    state.mark_cleanup_failure()
                return
            state.consume(requests=1)
            try:
                destination = state.resolve_request(url, navigation=navigation)
            except _Abort as error:
                if (
                    error.code == "policy"
                    and not navigation
                    and state.discard_unapproved_subresources
                ):
                    state.record_request(admitted=False)
                    self._finish_rejected_route(state, route, request)
                    return
                raise
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
            if (
                error.code == "policy"
                and request is not None
                and not navigation
                and state.discard_unapproved_subresources
            ):
                # A reviewed challenge profile may deliberately reject one
                # subresource after destination/host admission (for example,
                # an unreviewed challenge script).  Treat that request as a
                # local blocked dependency and keep the article flow alive so
                # Acquisition can classify the challenge deterministically.
                state.record_request(admitted=False)
                self._finish_rejected_route(state, route, request)
                return
            if error.code == "policy":
                state.record_request(admitted=False)
                if (
                    navigation
                    and request is not None
                    and _attribute(request, "is_top_frame") is True
                ):
                    # ``route.abort`` is the transport acknowledgement. Let a
                    # concurrent humanized action unwind naturally instead of
                    # interrupting the same article transport a second time.
                    # Unknown/subframe ownership retains the immediate
                    # fail-closed path below.
                    if self._finish_rejected_route(state, route, request):
                        state.defer_policy_rejection_until_operation_finishes()
                    return
            state.fail(error.code)
            self._finish_rejected_route(state, route, request)
        except Exception:
            state.record_request(admitted=False)
            state.fail("runtime")
            self._finish_rejected_route(state, route, request)

    def _finish_rejected_route(
        self,
        state: _FlowState,
        route: _Route,
        request: object | None,
    ) -> bool:
        if not self._abort_route(route):
            # Without abort acknowledgement the transport may still be live.
            # Retain any registered host lease until context/process teardown
            # acknowledges stop; releasing it here would open an admission gap.
            state.mark_cleanup_failure()
            state.fail("cleanup")
            return False
        try:
            state.finish_request(request)
        except Exception:
            state.mark_cleanup_failure()
            state.fail("cleanup")
            return False
        return True

    def _admit_route(
        self,
        state: _FlowState,
        route: _Route,
        request: object,
        page: object | None,
        destination: ResolvedDestination,
        navigation: bool,
    ) -> None:
        current_navigation = state.navigations.get(id(page)) if navigation else None
        if navigation and (current_navigation is None or not current_navigation.budget_counted):
            state.consume(navigations=1)
            if current_navigation is not None:
                current_navigation.budget_counted = True
        if navigation and page is not None:
            with state.lock:
                current_navigation = state.navigations.get(id(page))
                if current_navigation is not None:
                    current_navigation.destination = destination
        state.guard_request(
            request,
            page,
            destination.url.url,
            BrowserDestinationKind.NAVIGATION if navigation else BrowserDestinationKind.REQUEST,
        )
        state.acquire_host(destination)
        # Binding is mandatory and occurs before route continuation.  A
        # route/runtime that merely accepts an ignored ``addresses`` kwarg
        # cannot cross this boundary.
        state.bind_runtime(route, destination, allow_runtime_fallback=False)
        state.register_request(
            request,
            page=page,
            destination=destination,
            navigation=navigation,
        )
        self._continue_route(route)
        state.record_request(admitted=True)

    @staticmethod
    def _request_from_event(value: object) -> object:
        candidate = _attribute(value, "request")
        return value if candidate is None else candidate

    def _handle_request_finished(self, state: _FlowState, value: object) -> None:
        try:
            request = self._request_from_event(value)
            if state.request_waits_for_response_download(request):
                return
            state.finish_request(request)
        except _Abort as error:
            state.fail(error.code)
        except Exception:
            state.fail("cleanup")

    def _handle_response(self, state: _FlowState, response: object) -> None:  # noqa: C901
        """Guard a response locator before any future body/capture operation."""

        stage = "response-shape"
        request: object | None = None
        lease: _RequestLease | None = None
        status: object = None
        release_after_response = True
        try:
            url, request = self._response_shape(response)
            status = _attribute(response, "status")
            stage = "destination-guard"
            destination = self._resolve_response_destination(state, url, request)
            if destination is None:
                return
            stage = "request-correlation"
            lease = self._correlate_response_request(
                state,
                request,
                destination,
                status=status,
            )
            state.guard_request(
                request,
                lease.page,
                destination.url.url,
                BrowserDestinationKind.RESPONSE,
            )
            stage = "response-classification"
            if lease.navigation and lease.page is not None and type(status) is int:
                # Script, click and native redirect navigations do not all
                # return through ``page.goto``.  The correlated top-frame
                # response is therefore the authoritative status update for
                # later page-state classification.
                state.page_statuses[id(lease.page)] = status
            if type(status) is not int or not 200 <= status <= 299:
                return
            media_type = self._response_media_type(response)
            kind = self._response_capture_kind(
                state,
                lease.page,
                destination.url.url,
            )
            state.guard_request(
                request,
                lease.page,
                destination.url.url,
                BrowserDestinationKind.RESPONSE,
                capture_kind=kind,
            )
            capture_allowed = state.allows_capture(
                destination.url.url,
                kind,
                media_type,
            )
            stage = "native-download-reservation"
            if self._reserve_response_download(
                state,
                response,
                destination,
                lease,
                kind=kind,
                media_type=media_type,
                capture_allowed=capture_allowed,
            ):
                release_after_response = False
                return
            if not capture_allowed:
                self._reserve_local_pdf_download(
                    state,
                    destination,
                    lease,
                    media_type=media_type,
                )
                return
            stage = "response-body"
            self._capture_response_body(
                state,
                response,
                destination,
                lease,
                kind=kind,
                media_type=media_type,
            )
        except _Abort as error:
            _LOGGER.debug(
                "event=browser-response-failed stage=%s code=%s retryable=%s "
                "status=%d navigation=%s redirected=%s",
                stage,
                error.code,
                str(error.code in {"timeout", "admission", "runtime"}).lower(),
                status if type(status) is int else -1,
                str(request is not None and self._is_navigation_request(request)).lower(),
                str(
                    request is not None and _attribute(request, "redirected_from") is not None
                ).lower(),
            )
            if error.code == "policy":
                state.record_request(admitted=False)
                if (
                    request is not None
                    and not self._is_navigation_request(request)
                    and state.discard_unapproved_subresources
                ):
                    # A response-level rule can reject an otherwise admitted
                    # subresource (notably a challenge PDF marked as
                    # capture-forbidden).  Preserve the local blocked fact,
                    # avoid reading its body, and let Acquisition classify it
                    # from the challenge resource facts.  Only a response
                    # classification rejection needs to preserve a policy
                    # result for the caller; route/resolve/guard rejection is
                    # intentionally a local no-download outcome. Top-level
                    # response policy remains fail-closed below.
                    if stage == "response-classification":
                        state.mark_policy_rejection()
                    return
            state.fail(error.code)
        except Exception:
            _LOGGER.debug(
                "event=browser-response-failed stage=%s code=runtime retryable=true "
                "status=%d navigation=%s redirected=%s",
                stage,
                status if type(status) is int else -1,
                str(request is not None and self._is_navigation_request(request)).lower(),
                str(
                    request is not None and _attribute(request, "redirected_from") is not None
                ).lower(),
            )
            state.fail("runtime")
        finally:
            self._release_response_request(
                state,
                lease,
                status=status,
                release_after_response=release_after_response,
            )

    @staticmethod
    def _response_shape(response: object) -> tuple[str, object]:
        url = _text_attribute(response, "url")
        request = _attribute(response, "request")
        if url is None or request is None:
            raise _Abort("runtime")
        return url, request

    def _resolve_response_destination(
        self,
        state: _FlowState,
        url: str,
        request: object,
    ) -> ResolvedDestination | None:
        try:
            return state.resolve(url, kind=BrowserDestinationKind.RESPONSE)
        except _Abort as error:
            if (
                error.code == "policy"
                and state.discard_unapproved_subresources
                and not self._is_navigation_request(request)
            ):
                # Chromium can emit a terminal response for a non-navigation
                # redirect even when the unapproved destination was stopped by
                # the pinned transport. Do not read or correlate that body, and
                # do not convert an intentionally discarded tracker into an
                # article failure. Top-level navigation remains fail closed.
                _LOGGER.debug(
                    "event=browser-response-discarded "
                    "stage=destination-guard reason=unapproved-subresource"
                )
                return None
            raise

    @staticmethod
    def _correlate_response_request(
        state: _FlowState,
        request: object,
        destination: ResolvedDestination,
        *,
        status: object,
    ) -> _RequestLease:
        lease = state.correlate_response_request(request, destination)
        if lease is not None:
            return lease
        with state.lock:
            direct_lease = state.request_leases.get(id(request))
        current = _attribute(request, "redirected_from")
        redirect_depth = 0
        ancestor_lease: _RequestLease | None = None
        seen: set[int] = {id(request)}
        while current is not None and redirect_depth < 32:
            identity = id(current)
            if identity in seen:
                break
            seen.add(identity)
            redirect_depth += 1
            with state.lock:
                candidate = state.request_leases.get(identity)
            if candidate is not None and candidate.request is current:
                ancestor_lease = candidate
                break
            current = _attribute(current, "redirected_from")
        request_page = _attribute(request, "page")
        _LOGGER.debug(
            "event=browser-response-correlation-miss lease_present=%s "
            "request_identity_matches=%s destination_matches=%s status=%d "
            "navigation=%s redirect_depth=%d ancestor_lease_present=%s "
            "ancestor_navigation=%s page_matches=%s origin_prebound=%s",
            str(direct_lease is not None).lower(),
            str(direct_lease is not None and direct_lease.request is request).lower(),
            str(
                direct_lease is not None and direct_lease.destination.url.url == destination.url.url
            ).lower(),
            status if type(status) is int else -1,
            str(BrowserClient._is_navigation_request(request)).lower(),
            redirect_depth,
            str(ancestor_lease is not None).lower(),
            str(ancestor_lease is not None and ancestor_lease.navigation).lower(),
            str(ancestor_lease is not None and request_page is ancestor_lease.page).lower(),
            str(destination.url.origin.text in state.prebound_origins).lower(),
        )
        # Response access was admitted only if its still-live route lease
        # proves that guard, DNS binding and host admission ran before
        # transport. Future body capture reuses that proof.
        raise _Abort("runtime")

    @staticmethod
    def _reserve_response_download(
        state: _FlowState,
        response: object,
        destination: ResolvedDestination,
        lease: _RequestLease,
        *,
        kind: BrowserCaptureKind,
        media_type: str,
        capture_allowed: bool,
    ) -> bool:
        if _attribute(response, "download_expected") is not True:
            return False
        if not capture_allowed and _attribute(response, "attachment_download") is True:
            kind = BrowserCaptureKind.DOWNLOAD
            capture_allowed = state.allows_capture(
                destination.url.url,
                kind,
                media_type,
            )
        state.expect_response_download(
            destination,
            lease,
            kind=kind,
            media_type=media_type,
            capture_allowed=capture_allowed,
        )
        return True

    @staticmethod
    def _reserve_local_pdf_download(
        state: _FlowState,
        destination: ResolvedDestination,
        lease: _RequestLease,
        *,
        media_type: str,
    ) -> None:
        if media_type != "application/pdf" or not state.allows_capture(
            destination.url.url,
            BrowserCaptureKind.DOWNLOAD,
            media_type,
        ):
            return
        # A reviewed page script may turn an already-admitted PDF response
        # into a local blob download. Keep only the safe response locator and
        # media type as its one-shot provenance; the opaque blob URL never
        # enters policy, logs or results.
        state.expect_local_download(
            destination,
            media_type=media_type,
            kind=BrowserCaptureKind.DOWNLOAD,
            lease=lease,
        )

    def _capture_response_body(
        self,
        state: _FlowState,
        response: object,
        destination: ResolvedDestination,
        lease: _RequestLease,
        *,
        kind: BrowserCaptureKind,
        media_type: str,
    ) -> None:
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

    @staticmethod
    def _release_response_request(
        state: _FlowState,
        lease: _RequestLease | None,
        *,
        status: object,
        release_after_response: bool,
    ) -> None:
        # A terminal response is enough to retire request correlation even
        # when requestfinished has not arrived. The article-level host lease is
        # intentionally unaffected and remains held through Browser cleanup.
        # Native 3xx responses are the exception: Playwright does not route
        # later redirect members, so their root correlation remains live until
        # a terminal response arrives.
        if (
            lease is None
            or lease.navigation
            or not release_after_response
            or status in {301, 302, 303, 307, 308}
        ):
            # A navigation can produce more than one response before
            # Playwright emits requestfinished (redirects, authentication, or
            # an informational response). Keep its route proof live for the
            # complete native request lifecycle; requestfinished performs the
            # retirement. Non-navigation responses may still retire here for
            # runtimes that expose response completion without a separate
            # completion event.
            return
        try:
            state.finish_request(lease.request)
        except _Abort as error:
            state.fail(error.code)
            state.mark_cleanup_failure()
        except Exception:
            state.fail("cleanup")
            state.mark_cleanup_failure()

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
    def _abort_route(route: _Route) -> bool:
        method = getattr(route, "abort", None)
        if not callable(method):
            return False
        try:
            method()
        except Exception:
            return False
        return True

    def _handle_popup(self, state: _FlowState, page: object) -> None:
        try:
            if state.register_popup(page):
                state.consume(popups=1)
        except _Abort as error:
            state.fail(error.code)
            if state.claim_cleanup(page) and not self._close_object(page):
                state.mark_cleanup_failure()
        except Exception:
            state.fail("runtime")
            if state.claim_cleanup(page) and not self._close_object(page):
                state.mark_cleanup_failure()

    def _handle_download(self, state: _FlowState, download: object) -> None:
        request: object | None = None
        stage = "ownership"
        try:
            if not state.own_download(download):
                raise _Abort("cleanup")
            state.consume(downloads=1)
            stage = "capture-plan"
            plan = self._download_capture_plan(state, download)
            if plan is None:
                return
            request = plan.request
            if not plan.capture_allowed:
                return
            stage = "download-body"
            body = cast(
                bytes,
                self._run_cancellable(
                    state,
                    lambda: self._download_bytes(state, download),
                    abort=lambda: self._abort_runtime(None, None, state.runtime),
                ),
            )
            state.check()
            stage = "capture"
            state.add_capture(
                kind=plan.kind,
                body=body,
                media_type=plan.media_type,
                locator=plan.destination.url.url,
            )
        except _Abort as error:
            _LOGGER.debug(
                "event=browser-download-failed stage=%s code=%s retryable=%s",
                stage,
                error.code,
                str(error.code in {"timeout", "admission", "runtime"}).lower(),
            )
            state.fail(error.code)
            self._discard_failed_download(state, download)
        except Exception:
            _LOGGER.debug(
                "event=browser-download-failed stage=%s code=runtime retryable=true",
                stage,
            )
            state.fail("runtime")
            self._discard_failed_download(state, download)
        finally:
            if request is not None:
                try:
                    state.finish_request(request)
                except Exception:
                    state.fail("cleanup")
                    state.mark_cleanup_failure()

    def _download_capture_plan(
        self,
        state: _FlowState,
        download: object,
    ) -> _DownloadCapturePlan | None:
        url = _text_attribute(download, "url")
        if url is None:
            raise _Abort("policy")
        if urlsplit(url).scheme.casefold() == "blob":
            return self._local_download_capture_plan(state, url)
        return self._network_download_capture_plan(state, download, url)

    def _local_download_capture_plan(
        self,
        state: _FlowState,
        url: str,
    ) -> _DownloadCapturePlan | None:
        state.validate_local_blob(url)
        pending = state.take_local_download()
        if pending is None:
            pending = self._infer_local_download(state)
        if pending is None:
            return None
        request = None if pending.lease is None else pending.lease.request
        return _DownloadCapturePlan(
            destination=pending.destination,
            request=request,
            kind=pending.kind,
            media_type=pending.media_type,
            capture_allowed=True,
        )

    @staticmethod
    def _infer_local_download(state: _FlowState) -> _PendingLocalDownload | None:
        with state.lock:
            capture_already_available = bool(state.captures)
            live_leases = tuple(state.request_leases.values())
        if capture_already_available:
            return None
        candidates: list[_PendingLocalDownload] = []
        for lease in live_leases:
            for kind in (
                BrowserCaptureKind.RESPONSE,
                BrowserCaptureKind.DOWNLOAD,
            ):
                if state.allows_capture(
                    lease.destination.url.url,
                    kind,
                    "application/pdf",
                ):
                    candidates.append(
                        _PendingLocalDownload(
                            destination=lease.destination,
                            media_type="application/pdf",
                            kind=kind,
                            lease=lease,
                        )
                    )
                    break
        if len(candidates) != 1:
            raise _Abort("policy")
        return candidates[0]

    def _network_download_capture_plan(
        self,
        state: _FlowState,
        download: object,
        url: str,
    ) -> _DownloadCapturePlan | None:
        destination = state.resolve(url, kind=BrowserDestinationKind.DOWNLOAD)
        pending = state.take_response_download(destination)
        request_candidate = _attribute(download, "request")
        # A native PDF response can be followed by a duplicate Download event
        # after Playwright has retired the original request.  Do not infer a
        # new request or read the duplicate body unless the article-local state
        # proves this exact query-free locator was already captured and no
        # pending/live request remains.  All other correlation misses remain
        # fail-closed below.
        if (
            pending is None
            and request_candidate is None
            and state.duplicate_download_is_proven(destination)
        ):
            _LOGGER.debug("event=browser-download-discarded reason=late-duplicate-capture")
            return None
        request = (
            pending.lease.request
            if pending is not None
            else (
                request_candidate
                if request_candidate is not None
                else state.find_request_for_download(destination)
            )
        )
        with state.lock:
            existing = state.request_leases.get(id(request)) if request is not None else None
        if (
            existing is None
            or (pending is None and existing.destination.url.url != destination.url.url)
            or (pending is not None and existing is not pending.lease)
        ):
            _LOGGER.debug(
                "event=browser-download-correlation-miss pending_response=%s "
                "download_request_present=%s inferred_request_present=%s "
                "live_request_present=%s destination_matches=%s",
                str(pending is not None).lower(),
                str(request_candidate is not None).lower(),
                str(request is not None).lower(),
                str(existing is not None).lower(),
                str(
                    existing is not None and existing.destination.url.url == destination.url.url
                ).lower(),
            )
            # A network download without a still-live intercepted request
            # cannot prove pre-transport admission. Local blob downloads use
            # the separately recorded response proof.
            raise _Abort("runtime")
        kind = BrowserCaptureKind.DOWNLOAD if pending is None else pending.kind
        media_type = self._download_media_type(download) if pending is None else pending.media_type
        capture_allowed = (
            state.allows_capture(destination.url.url, kind, media_type)
            if pending is None
            else pending.capture_allowed
        )
        return _DownloadCapturePlan(
            destination=destination,
            request=request,
            kind=kind,
            media_type=media_type,
            capture_allowed=capture_allowed,
        )

    @staticmethod
    def _discard_failed_download(state: _FlowState, download: object) -> None:
        if state.claim_cleanup(download) and not BrowserClient._delete_object(download):
            state.mark_cleanup_failure()

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
        return BrowserClient._bounded_body_value(state, value)

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
        return BrowserClient._bounded_body_value(state, value)

    @staticmethod
    def _bounded_body_value(state: _FlowState, value: object) -> bytes:
        """Consume bytes or one private closable stream without leaking it."""

        if isinstance(value, bytes):
            return BrowserClient._checked_body_bytes(state, value)
        reader = getattr(value, "read", None)
        close = getattr(value, "close", None)
        if not callable(reader) or not callable(close):
            raise _Abort("runtime")
        return BrowserClient._read_private_stream(state, value, reader)

    @staticmethod
    def _read_private_stream(
        state: _FlowState,
        stream: object,
        reader: Callable[..., object],
    ) -> bytes:
        if not state.own_stream(stream):
            if state.claim_cleanup(stream) and not BrowserClient._close_object(stream):
                state.mark_cleanup_failure()
            raise _Abort("cleanup")
        body: object = None
        read_error: Exception | None = None
        try:
            body = reader(state.max_bytes_per_download + 1)
        except Exception as error:
            read_error = error
        finally:
            state.forget_stream(stream)
            if state.claim_cleanup(stream) and not BrowserClient._close_object(stream):
                state.mark_cleanup_failure()
                raise _Abort("cleanup") from None
        if read_error is not None:
            if isinstance(read_error, _Abort):
                raise read_error
            raise _Abort("runtime") from read_error
        if not isinstance(body, bytes):
            raise _Abort("runtime")
        return BrowserClient._checked_body_bytes(state, body)

    @staticmethod
    def _checked_body_bytes(state: _FlowState, body: bytes) -> bytes:
        if len(body) > state.max_bytes_per_download:
            raise _Abort("oversize")
        return body

    def _client_navigate(self, state: _FlowState, page: object, url: str) -> None:
        try:
            state.check()
            destination = state.resolve(url, kind=BrowserDestinationKind.NAVIGATION)
            runtime_url = _runtime_url(url, state.destination_policy)
            if _policy_url(runtime_url) != destination.url.url:
                raise _Abort("policy")
            state.consume(navigations=1)
            with state.lock:
                prior_capture_count = len(state.captures)
            state.acquire_host(destination)
            navigation = _Navigation(page, destination)
            state.navigations[id(page)] = navigation
            response = self._navigate_registered_page(
                state,
                page,
                runtime_url,
            )
            state.check()
            self._record_navigation_result(
                state,
                page,
                response,
                navigation,
            )
            media_type = _text_attribute(response, "media_type")
            final_url = _text_attribute(page, "url") or _text_attribute(response, "url")
            if (
                media_type is not None
                and final_url is not None
                and any(
                    state.allows_capture(_policy_url(final_url), kind, media_type)
                    for kind in (BrowserCaptureKind.RESPONSE, BrowserCaptureKind.DOWNLOAD)
                )
            ):
                state.wait_for_page_result(
                    page,
                    prior_capture_count=prior_capture_count,
                )
        except _Abort:
            raise
        except (TimeoutError,):
            raise _Abort("timeout") from None
        except Exception as error:
            if state.error is not None:
                raise state.error
            raise _Abort("runtime") from error

    def _navigate_registered_page(
        self,
        state: _FlowState,
        page: object,
        runtime_url: str,
    ) -> object:
        operation_complete = False
        try:
            goto = getattr(page, "goto", None)
            if not callable(goto):
                raise _Abort("runtime")
            response = self._run_cancellable(
                state,
                lambda: goto(
                    runtime_url,
                    timeout=state.remaining_milliseconds(),
                ),
                abort=lambda: self._abort_runtime(page, None, state.runtime),
            )
            state.detach_navigation(page)
            operation_complete = True
            return response
        finally:
            if not operation_complete:
                state.finish_page_navigation(page)

    @staticmethod
    def _record_navigation_result(
        state: _FlowState,
        page: object,
        response: object,
        navigation: _Navigation,
    ) -> None:
        final_url = _text_attribute(page, "url") or _text_attribute(response, "url")
        if final_url is not None and not _is_internal_url(final_url):
            final_destination = state.resolve(
                final_url,
                kind=BrowserDestinationKind.NAVIGATION,
            )
            if final_destination.hostname != navigation.destination.hostname:
                state.acquire_host(final_destination)
                state.bind_runtime(state.runtime or page, final_destination)
            navigation.destination = final_destination
        status = _attribute(response, "status") if response is not None else None
        if status is not None and (type(status) is not int or not 100 <= status <= 599):
            raise _Abort("runtime")
        state.page_statuses[id(page)] = cast(int | None, status)

    def _client_open_popup(self, state: _FlowState, opener: object, url: str) -> object:
        try:
            state.check()
            destination = state.resolve(url, kind=BrowserDestinationKind.POPUP)
            runtime_url = _runtime_url(url, state.destination_policy)
            if _policy_url(runtime_url) != destination.url.url:
                raise _Abort("policy")
            opener_method = getattr(opener, "open_popup", None)
            if not callable(opener_method):
                raise _Abort("runtime")
            popup = self._run_cancellable(
                state,
                lambda: opener_method(runtime_url),
                abort=lambda: self._abort_runtime(opener, None, state.runtime),
            )
            if popup is None:
                raise _Abort("runtime")
            if state.register_popup(popup):
                state.consume(popups=1)
            state.detach_navigation(popup)
            self._validate_page_location(state, popup)
            return popup
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
            prior_capture_count = len(state.captures)
            state.verified_locators.add(destination.url.url)
        popup = self._client_open_popup(state, opener, url)
        state.wait_for_page_result(
            popup,
            prior_capture_count=prior_capture_count,
        )

    def _client_open_viewer(
        self,
        state: _FlowState,
        opener: object,
        url: str,
    ) -> None:
        destination = state.resolve(url, kind=BrowserDestinationKind.POPUP)
        with state.lock:
            prior_capture_count = len(state.captures)
            state.viewer_locators.add(destination.url.url)
        popup = self._client_open_popup(state, opener, url)
        state.wait_for_page_result(
            popup,
            prior_capture_count=prior_capture_count,
        )

    def _client_discover_pdf_locators(
        self,
        state: _FlowState,
        page: object,
    ) -> tuple[str, ...]:
        discover = getattr(page, "discover_pdf_locators", None)
        if not callable(discover):
            raise _Abort("runtime")
        raw = self._run_cancellable(
            state,
            discover,
            abort=lambda: self._abort_runtime(page, None, state.runtime),
        )
        if not isinstance(raw, tuple) or len(raw) > _MAX_DISCOVERED_PDF_LOCATORS:
            raise _Abort("runtime")
        discovered: dict[str, str] = {}
        for value in raw:
            reviewed = self._review_discovered_pdf_locator(state, value)
            if reviewed is None:
                continue
            policy_locator, runtime_locator = reviewed
            discovered.setdefault(policy_locator, runtime_locator)
        return tuple(discovered.values())

    @staticmethod
    def _review_discovered_pdf_locator(
        state: _FlowState,
        value: object,
    ) -> tuple[str, str] | None:
        if type(value) is not str or not value or len(value) > _MAX_DISCOVERED_LOCATOR_LENGTH:
            raise _Abort("runtime")
        try:
            policy_locator = _policy_url(value)
            normalized = normalize_url(
                policy_locator,
                allowed_schemes=state.destination_policy.allowed_schemes,
                allowed_ports=state.destination_policy.allowed_ports,
            )
            if normalized.origin.text not in state.prebound_origins:
                return None
            try:
                state.guard(normalized.url, BrowserDestinationKind.POPUP)
            except _Abort as error:
                if error.code == "policy":
                    return None
                raise
            destination = state.resolve(
                value,
                kind=BrowserDestinationKind.POPUP,
            )
            runtime_locator = _runtime_url(value, state.destination_policy)
            if _policy_url(runtime_locator) != destination.url.url:
                raise _Abort("policy")
        except _Abort:
            raise
        except (PolicyError, TypeError, ValueError):
            return None
        return destination.url.url, runtime_locator

    @staticmethod
    def _selector(value: str) -> str:
        if type(value) is not str or not value or len(value) > 1024:
            raise _Abort("policy")
        if any(ord(character) < 32 or ord(character) == 127 for character in value):
            raise _Abort("policy")
        return value

    def _client_click(self, state: _FlowState, page: object, selector: str) -> bool:
        selector = self._selector(selector)
        click = getattr(page, "click", None)
        if not callable(click):
            raise _Abort("runtime")
        current_url = _text_attribute(page, "url")
        if current_url is None or _is_internal_url(current_url):
            raise _Abort("runtime")
        try:
            current = normalize_url(
                _policy_url(current_url),
                allowed_schemes=state.destination_policy.allowed_schemes,
                allowed_ports=state.destination_policy.allowed_ports,
            )
        except (PolicyError, TypeError, ValueError) as error:
            raise _Abort("policy") from error
        current_destination = state.destinations.get(current.hostname)
        if (
            current_destination is None
            or current_destination.url.scheme != current.scheme
            or current_destination.url.port != current.port
        ):
            raise _Abort("runtime")
        with state.lock:
            if id(page) in state.navigations:
                raise _Abort("runtime")
            # A reviewed click may synchronously start one top-frame
            # navigation.  Keep one lifecycle marker around the vendor call
            # so every explicit 3xx hop belongs to that single budgeted
            # navigation instead of being counted as a new user action.
            # Non-navigating buttons leave ``budget_counted`` false and do not
            # consume navigation budget.
            state.navigations[id(page)] = _Navigation(
                page,
                current_destination,
                budget_counted=False,
            )
        started_at = state.clock()
        maximum_wait_milliseconds = min(
            state.remaining_milliseconds(),
            max(1, int(state.budget.max_action_wait_seconds * 1000)),
        )
        _LOGGER.debug(
            "event=browser-click-started max_wait_seconds=%.3f",
            state.budget.max_action_wait_seconds,
        )
        try:
            raw_clicked = self._run_cancellable(
                state,
                lambda: click(selector, timeout=maximum_wait_milliseconds),
                abort=lambda: self._abort_runtime(page, None, state.runtime),
            )
            if raw_clicked is not None and type(raw_clicked) is not bool:
                raise _Abort("runtime")
            clicked = raw_clicked is not False
            if clicked:
                self._validate_page_location(state, page)
            _LOGGER.debug(
                "event=browser-click-finished outcome=%s elapsed_ms=%d",
                "performed" if clicked else "not-actionable",
                max(int((state.clock() - started_at) * 1000), 0),
            )
            return clicked
        finally:
            state.detach_navigation(page)

    @staticmethod
    def _validate_page_location(state: _FlowState, page: object) -> ResolvedDestination:
        """Recheck the current top-frame URL after a vendor navigation call.

        Route and response guards remain the pre-I/O boundary.  This final
        check closes the separate postcondition: a vendor click/popup method
        must not return a page that silently ended on an internal or
        unreviewed target, even when the runtime did not expose the final hop
        through the expected callback sequence.
        """

        locator = _text_attribute(page, "url")
        if locator is None or _is_internal_url(locator):
            raise _Abort("runtime")
        destination = state.resolve(
            locator,
            kind=BrowserDestinationKind.NAVIGATION,
        )
        return destination

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

    def _client_has_selector(self, state: _FlowState, page: object, selector: str) -> bool:
        selector = self._selector(selector)
        has_selector = getattr(page, "has_selector", None)
        if not callable(has_selector):
            raise _Abort("runtime")
        value = self._run_cancellable(
            state,
            lambda: has_selector(
                selector,
                timeout=min(
                    state.remaining_milliseconds(),
                    _MARKER_LOOKUP_TIMEOUT_MILLISECONDS,
                ),
            ),
            abort=lambda: self._abort_runtime(page, None, state.runtime),
        )
        if type(value) is not bool:
            raise _Abort("runtime")
        return value

    def _client_text(self, state: _FlowState, page: object, selector: str) -> str:
        selector = self._selector(selector)
        text_content = getattr(page, "text_content", None)
        if not callable(text_content):
            raise _Abort("runtime")
        value = self._run_cancellable(
            state,
            # Marker probes must be non-blocking.  A direct-PDF navigation has
            # no HTML DOM, and a missing selector must not consume the entire
            # article timeout before an already captured response is returned.
            lambda: text_content(
                selector,
                timeout=min(
                    state.remaining_milliseconds(),
                    _MARKER_LOOKUP_TIMEOUT_MILLISECONDS,
                ),
            ),
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
        destination = self._validate_page_location(state, page)
        if destination.url.url != normalized.url:
            raise _Abort("policy")
        return BrowserPageObservation(
            locator=normalized.url,
            status_code=state.page_statuses.get(id(page)),
        )

    def _client_agent_observe(  # noqa: C901
        self,
        state: _FlowState,
        page: object,
    ) -> BrowserAgentObservation:
        """Create one bounded request-local observation for the Agent seam."""

        state.check()
        page_snapshot = getattr(page, "agent_snapshot", None)
        if not callable(page_snapshot):
            raise _Abort("runtime")
        snapshot = self._run_cancellable(
            state,
            lambda: page_snapshot(timeout=state.remaining_milliseconds()),
            abort=lambda: self._abort_runtime(page, None, state.runtime),
        )
        if not isinstance(snapshot, dict):
            raise _Abort("runtime")
        locator = _text_attribute(page, "url")
        if locator is None or _is_internal_url(locator):
            raise _Abort("runtime")
        try:
            normalized = normalize_url(
                _policy_url(locator),
                allowed_schemes=self._destination_policy.allowed_schemes,
                allowed_ports=self._destination_policy.allowed_ports,
            )
            destination = self._validate_page_location(state, page)
        except (PolicyError, TypeError, ValueError) as error:
            raise _Abort("policy") from error
        if destination.url.url != normalized.url:
            raise _Abort("policy")

        width = snapshot.get("width")
        height = snapshot.get("height")
        screenshot = snapshot.get("screenshot")
        screenshot_media_type = snapshot.get("screenshot_media_type")
        raw_elements = snapshot.get("elements")
        if (
            type(width) is not int
            or type(height) is not int
            or width < 1
            or height < 1
            or width > 16_384
            or height > 16_384
            or type(screenshot) is not bytes
            or not screenshot
            or len(screenshot) > _MAX_AGENT_SCREENSHOT_BYTES
            or screenshot_media_type not in {"image/png", "image/jpeg", "image/webp"}
            or not isinstance(raw_elements, tuple)
            or len(raw_elements) > _MAX_AGENT_ELEMENTS
        ):
            raise _Abort("runtime")
        facts: list[tuple[int, str, str, bool, bool]] = []
        for item in raw_elements:
            if not isinstance(item, tuple) or len(item) != 5:
                raise _Abort("runtime")
            key, role, name, visible, enabled = item
            if (
                type(key) is not int
                or key < 0
                or type(role) is not str
                or type(name) is not str
                or type(visible) is not bool
                or type(enabled) is not bool
            ):
                raise _Abort("runtime")
            facts.append((key, role, name, visible, enabled))
        status_code = state.page_statuses.get(id(page))
        fingerprint = hashlib.sha256()
        fingerprint.update(normalized.url.encode("utf-8"))
        fingerprint.update(str(status_code).encode("ascii"))
        for key, role, name, visible, enabled in facts:
            fingerprint.update(repr((key, role, name, visible, enabled)).encode("utf-8"))
        page_state = state.agent_pages.get(id(page))
        if page_state is None:
            token_digest = hashlib.sha256(f"{id(page)}".encode("ascii")).hexdigest()[:24]
            page_state = _AgentPageState(page_token=f"p{token_digest}")
            state.agent_pages[id(page)] = page_state
        fingerprint_bytes = fingerprint.digest()
        changed = (
            page_state.observation is None
            or page_state.fingerprint != fingerprint_bytes
            or page_state.ledger.current is None
        )
        budget = self._agent_observation_budget(state, screenshot)
        if changed:
            elements: list[BrowserElement] = []
            mapping: dict[str, int] = {}
            # Publish a provisional snapshot first so IDs bind to the actual
            # ledger revision while keeping selectors/handles private.
            provisional = BrowserAgentObservation(
                revision=1,
                page_token=page_state.page_token,
                locator=normalized.url,
                status_code=status_code,
                viewport=BrowserViewport(width=width, height=height),
                screenshot=screenshot,
                screenshot_media_type=screenshot_media_type,
                elements=(),
                capture_state=(
                    BrowserCaptureState.CAPTURED if state.captures else BrowserCaptureState.NONE
                ),
                remaining_budget=budget,
            )
            revision = page_state.ledger.publish(provisional).revision
            for index, (key, role, name, visible, enabled) in enumerate(facts):
                element_id = (
                    "e"
                    + hashlib.sha256(
                        f"{page_state.page_token}:{revision}:{index}:{key}".encode("ascii")
                    ).hexdigest()[:16]
                )
                element_state = (
                    BrowserElementState.VISIBLE_ENABLED
                    if visible and enabled
                    else BrowserElementState.VISIBLE_DISABLED
                    if visible
                    else BrowserElementState.HIDDEN_ENABLED
                    if enabled
                    else BrowserElementState.HIDDEN_DISABLED
                )
                elements.append(
                    BrowserElement(
                        element_id=element_id,
                        role=role,
                        name=name,
                        state=element_state,
                    )
                )
                mapping[element_id] = key
            observation = BrowserAgentObservation(
                revision=revision,
                page_token=page_state.page_token,
                locator=normalized.url,
                status_code=status_code,
                viewport=BrowserViewport(width=width, height=height),
                screenshot=screenshot,
                screenshot_media_type=screenshot_media_type,
                elements=tuple(elements),
                capture_state=(
                    BrowserCaptureState.CAPTURED if state.captures else BrowserCaptureState.NONE
                ),
                remaining_budget=budget,
            )
            # Keep the ledger's current revision while storing the complete
            # element set; no selector or page object is retained here.
            page_state.ledger.replace_current(observation)
            page_state.element_keys = mapping
            page_state.fingerprint = fingerprint_bytes
            page_state.observation = observation
            return observation
        assert page_state.observation is not None
        observation = replace(
            page_state.observation,
            status_code=status_code,
            screenshot=screenshot,
            screenshot_media_type=screenshot_media_type,
            capture_state=(
                BrowserCaptureState.CAPTURED if state.captures else BrowserCaptureState.NONE
            ),
            remaining_budget=budget,
        )
        page_state.observation = observation
        page_state.ledger.replace_current(observation)
        return observation

    @staticmethod
    def _agent_observation_budget(
        state: _FlowState,
        screenshot: bytes,
    ) -> BrowserObservationBudget:
        remaining_seconds = max(state.deadline - state.clock(), 0.0)
        with state.lock:
            remaining_navigations = max(
                state.budget.max_navigations - state.usage.navigations,
                0,
            )
        # Agent action steps intentionally share the Network navigation budget:
        # clicks/scrolls/waits are allowed only while the flow still has
        # navigation headroom.  A zero navigation remainder therefore denies
        # the whole Agent turn before any model decision is requested.
        return BrowserObservationBudget(
            remaining_steps=remaining_navigations,
            remaining_seconds=remaining_seconds,
            remaining_image_bytes=max(_MAX_AGENT_SCREENSHOT_BYTES - len(screenshot), 0),
            remaining_navigations=remaining_navigations,
        )

    def _client_agent_execute(  # noqa: C901
        self,
        state: _FlowState,
        page: object,
        command: BrowserAgentActionCommand,
        observation: BrowserAgentObservation,
        *,
        timeout_seconds: float,
    ) -> None:
        """Revalidate and execute one closed Agent action on the same page."""

        if not isinstance(observation, BrowserAgentObservation):
            raise _Abort("policy")
        if (
            isinstance(timeout_seconds, bool)
            or not isinstance(timeout_seconds, (int, float))
            or timeout_seconds <= 0
            or timeout_seconds > _DEFAULT_MAX_ACTION_WAIT_SECONDS
        ):
            raise _Abort("policy")
        current = self._client_agent_observe(state, page)
        if (
            current.revision != observation.revision
            or current.page_token != observation.page_token
            or current.locator != observation.locator
        ):
            raise _Abort("runtime")
        # Capture may arrive during the final observation/action hand-off.
        # Once Network sees any capture, reject the late command before the
        # vendor click/scroll/wait is invoked.
        if current.capture_state is not BrowserCaptureState.NONE:
            raise _Abort("runtime")
        if not isinstance(command, BrowserAgentActionCommand):
            raise _Abort("policy")
        if command.revision != current.revision:
            raise _Abort("policy")
        milliseconds = max(1, int(timeout_seconds * 1000))
        page_state = state.agent_pages.get(id(page))
        if page_state is None:
            raise _Abort("runtime")
        if command.kind is BrowserAgentActionKind.STOP_FLOW:
            return
        if command.kind is BrowserAgentActionKind.CLICK_ELEMENT:
            element_id = command.element_id
            if element_id is None:
                raise _Abort("policy")
            key = page_state.element_keys.get(element_id)
            if key is None:
                raise _Abort("policy")
            element = page_state.ledger.element(current.revision, element_id)
            if not element.visible or not element.enabled:
                raise _Abort("policy")
            operation = getattr(page, "agent_click", None)
            if not callable(operation):
                raise _Abort("runtime")
            page_state.ledger.invalidate()
            self._run_cancellable(
                state,
                lambda: operation(
                    key,
                    expected_role=element.role,
                    expected_name=element.name,
                    expected_visible=element.visible,
                    expected_enabled=element.enabled,
                    expected_locator=current.locator,
                    timeout=milliseconds,
                ),
                abort=lambda: self._abort_runtime(page, None, state.runtime),
            )
            return
        if command.kind is BrowserAgentActionKind.SCROLL_PAGE:
            delta_y = command.delta_y
            if delta_y is None:
                raise _Abort("policy")
            operation = getattr(page, "agent_scroll", None)
            if not callable(operation):
                raise _Abort("runtime")
            page_state.ledger.invalidate()
            self._run_cancellable(
                state,
                lambda: operation(delta_y, timeout=milliseconds),
                abort=lambda: self._abort_runtime(page, None, state.runtime),
            )
            return
        if command.kind is BrowserAgentActionKind.WAIT_FOR_PAGE:
            seconds = command.seconds
            if seconds is None or seconds > timeout_seconds:
                raise _Abort("policy")
            operation = getattr(page, "agent_wait", None)
            if not callable(operation):
                raise _Abort("runtime")
            self._run_cancellable(
                state,
                lambda: operation(float(seconds), timeout=milliseconds),
                abort=lambda: self._abort_runtime(page, None, state.runtime),
            )
            return
        raise _Abort("policy")

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
        cleanup_deadline = time.monotonic() + state.cleanup_timeout_seconds
        if not state.begin_cleanup():
            return not state.wait_for_cleanup(cleanup_deadline)
        failed = state.cleanup_failed
        state.close_for_results()
        owned_pages, owned_downloads, owned_streams = state.take_article_resources()
        if not self._cleanup_objects(state, owned_pages, cleanup_deadline, delete=False):
            failed = True
        if not self._cleanup_objects(state, owned_downloads, cleanup_deadline, delete=True):
            failed = True
        if not self._cleanup_objects(state, owned_streams, cleanup_deadline, delete=False):
            failed = True
        if context is not None and not keep_session:
            if not self._cleanup_call(
                state,
                context,
                lambda: self._close_object_or_raise(context),
                cleanup_deadline,
            ):
                failed = True
        if (
            not keep_session
            and process_manager is not None
            and not self._cleanup_process(
                process_manager,
                process_runtime,
                entered_process,
                state=state,
                deadline=cleanup_deadline,
            )
        ):
            failed = True
        # Runtime calls must acknowledge completion after page/context/process
        # shutdown and before host admission is released.  A non-acknowledging
        # task is a cleanup failure, never a late candidate or exhaustion.
        if not state.wait_for_tasks(cleanup_deadline):
            failed = True
        # Context close is the runtime-level abort/completion acknowledgement
        # for any subresource that did not emit requestfinished/requestfailed.
        # Keep every article-host lease until after that close returns.
        if not keep_session and state.finish_all_requests():
            failed = True
        _LOGGER.debug(
            "event=browser-resource-summary admitted_requests=%d blocked_requests=%d "
            "total_requests=%d total_bytes=%d captures=%d",
            state.admitted_requests,
            state.blocked_requests,
            state.usage.requests,
            state.usage.total_bytes,
            state.usage.captures,
        )
        state.finish_cleanup(failed=failed)
        return failed

    def _cleanup_objects(
        self,
        state: _FlowState,
        values: tuple[object, ...],
        deadline: float,
        *,
        delete: bool,
    ) -> bool:
        cleaned = True
        for value in reversed(values):
            operation = (
                (lambda value=value: self._delete_object_or_raise(value))
                if delete
                else (lambda value=value: self._close_object_or_raise(value))
            )
            if not self._cleanup_call(state, value, operation, deadline):
                cleaned = False
        return cleaned

    def _cleanup_process(
        self,
        process_manager: object,
        process_runtime: object | None,
        entered_process: bool,
        *,
        state: _FlowState | None = None,
        deadline: float | None = None,
    ) -> bool:
        target: object
        if entered_process:
            exit_method = getattr(process_manager, "__exit__", None)
            if callable(exit_method):
                target = process_manager

                def operation() -> object:
                    return exit_method(None, None, None)

            else:
                target = process_runtime if process_runtime is not None else process_manager

                def operation() -> object:
                    return self._close_object_or_raise(target)

        else:
            target = process_runtime if process_runtime is not None else process_manager

            def operation() -> object:
                return self._close_object_or_raise(target)

        if state is None:
            try:
                operation()
            except Exception:
                return False
            return True
        if deadline is None:
            raise TypeError("deadline is required for state-owned cleanup")
        return self._cleanup_call(state, target, operation, deadline)

    @staticmethod
    def _cleanup_call(
        state: _FlowState,
        owner: object,
        operation: Callable[[], object],
        deadline: float,
    ) -> bool:
        if not state.claim_cleanup(owner):
            return not state.cleanup_failed
        task = _RuntimeTask()
        state.register_task(task)
        worker = threading.Thread(target=lambda: task.invoke(operation), daemon=True)
        try:
            worker.start()
        except Exception:
            state.finish_task(task)
            state.mark_cleanup_failure()
            return False
        remaining = deadline - time.monotonic()
        if remaining <= 0.0 or not task.finished.wait(remaining):
            state.mark_cleanup_failure()
            return False
        state.finish_task(task)
        if task.failure:
            state.mark_cleanup_failure()
            return False
        return True

    @staticmethod
    def _late_close(state: _FlowState, value: object) -> None:
        if not state.claim_cleanup(value):
            return
        if not BrowserClient._close_object(value):
            state.mark_cleanup_failure()
            raise RuntimeError("late Browser resource cleanup failed")

    @staticmethod
    def _discard_late_session_lease(value: object) -> None:
        if not isinstance(value, BrowserSessionLease):
            raise RuntimeError("late Browser session result violated its contract")
        value.invalidate()
        value.release()

    @staticmethod
    def _close_object_or_raise(value: object) -> None:
        if not BrowserClient._close_object(value):
            raise RuntimeError("Browser object cleanup failed")

    @staticmethod
    def _delete_object_or_raise(value: object) -> None:
        if not BrowserClient._delete_object(value):
            raise RuntimeError("Browser download cleanup failed")

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
    "BrowserChallengeFactsProvider",
    "BrowserChallengeObservation",
    "BrowserChallengeResourceFacts",
    "BrowserClient",
    "BrowserConnectionOriginGuard",
    "BrowserDestinationGuard",
    "BrowserDestinationKind",
    "BrowserError",
    "BrowserFlowController",
    "BrowserFlowSession",
    "BrowserPageObservation",
    "BrowserRequestGuard",
    "BrowserRequestObservation",
)
