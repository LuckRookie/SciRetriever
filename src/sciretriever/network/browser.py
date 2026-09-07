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
from urllib.parse import unquote_to_bytes, urljoin, urlsplit, urlunsplit

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
from sciretriever.model.primitives import sha256_digest

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
    BrowserAction,
    BrowserActionKind,
    BrowserActionOutcome,
    BrowserActionReceipt,
    BrowserAgentStatus,
    BrowserBounds,
    BrowserCancelledTransition,
    BrowserCandidateTimeoutTransition,
    BrowserCapturedTransition,
    BrowserCaptureState,
    BrowserElement,
    BrowserElementState,
    BrowserFailedTransition,
    BrowserObservation,
    BrowserObservationLedger,
    BrowserObservationUnavailable,
    BrowserPageState,
    BrowserScreenshot,
    BrowserScrollState,
    BrowserSettledTransition,
    BrowserStaleTransition,
    BrowserStepDriver,
    BrowserStepPolicy,
    BrowserStepSession,
    BrowserStoppedTransition,
    BrowserSurface,
    BrowserSurfaceKind,
    BrowserTransition,
    BrowserViewport,
    ClickElement,
    ClickPoint,
    GoBack,
    ScrollSurface,
    Stop,
    WaitForChange,
    stable_semantic_page_fingerprint,
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
_DEFAULT_MAX_CAPTURE_BYTES: Final[int] = 64 * 1024 * 1024
_DEFAULT_ACTION_TIMEOUT_SECONDS: Final[float] = 10.0
_DEFAULT_CAPTURE_WAIT_TIMEOUT_SECONDS: Final[float] = 10.0
_DEFAULT_CLEANUP_TIMEOUT_SECONDS: Final[float] = 5.0
_CONTROL_OBSERVATION_QUIET_SECONDS: Final[float] = 0.05
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
# Vendor runtimes may expose a bounded resource token, but that token is not a
# stable diagnostic contract. Keep only the cross-browser vocabulary in logs;
# unknown values collapse to ``other`` so an adapter cannot smuggle arbitrary
# strings into stderr. The observation contract remains strict and unchanged.
_SAFE_RESOURCE_TYPES: Final[frozenset[str]] = frozenset(
    {
        "document",
        "main_frame",
        "stylesheet",
        "script",
        "image",
        "font",
        "media",
        "xhr",
        "fetch",
        "manifest",
        "texttrack",
        "eventsource",
        "websocket",
        "other",
    }
)
_LOGGER = get_logger(__name__)


def _control_id(prefix: str, *parts: object) -> str:
    digest = hashlib.sha256()
    for part in parts:
        digest.update(str(part).encode("utf-8"))
        digest.update(b"\0")
    return f"{prefix}{digest.hexdigest()[:24]}"


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


@unique
class BrowserCaptureDecision(str, Enum):
    """One article policy decision made before Browser body access."""

    ACCEPT = "accept"
    DEFER = "defer"
    REJECT = "reject"


@unique
class BrowserCaptureCorrelation(str, Enum):
    """How an event is tied to one live, transport-admitted request."""

    DIRECT_REQUEST = "direct-request"
    REDIRECT_DESCENDANT = "redirect-descendant"


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


def _capture_media_type(value: object) -> str:
    if not isinstance(value, str):
        raise TypeError("media_type must be a string")
    candidate = value.split(";", 1)[0].strip().casefold()
    if (
        not candidate
        or len(candidate) > 127
        or not candidate.isascii()
        or any(ord(character) < 33 or ord(character) == 127 for character in candidate)
    ):
        raise ValueError("media_type must be a bounded ASCII token")
    return candidate


@dataclass(frozen=True, slots=True, repr=False)
class BrowserCaptureEvidence:
    """Operation-local, vendor-neutral proof available to article policy.

    ``locator`` is the normalized query-free representation already admitted
    by destination, DNS, host and request guards.  Redirect and exact-start
    flags describe Network-owned lineage only; they do not decide Publisher or
    article identity.  No vendor object, header, cookie, query or body crosses
    this contract.
    """

    locator: str = field(repr=False)
    kind: BrowserCaptureKind
    media_type: str
    correlation: BrowserCaptureCorrelation
    request_navigation: bool
    from_exact_start: bool
    redirect_depth: int
    native_download: bool = False

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "locator",
            _observation_locator(self.locator, field_name="locator"),
        )
        if not isinstance(self.kind, BrowserCaptureKind):
            raise TypeError("kind must be a BrowserCaptureKind")
        object.__setattr__(self, "media_type", _capture_media_type(self.media_type))
        if not isinstance(self.correlation, BrowserCaptureCorrelation):
            raise TypeError("correlation must be a BrowserCaptureCorrelation")
        if (
            type(self.request_navigation) is not bool
            or type(self.from_exact_start) is not bool
            or type(self.native_download) is not bool
        ):
            raise TypeError("capture evidence flags must be bools")
        if self.from_exact_start and not self.request_navigation:
            raise ValueError("an exact start must come from a navigation request")
        if type(self.redirect_depth) is not int or not 0 <= self.redirect_depth <= 32:
            raise ValueError("redirect_depth must be a bounded non-negative integer")
        if (
            self.correlation is BrowserCaptureCorrelation.DIRECT_REQUEST
            and self.redirect_depth != 0
        ):
            raise ValueError("direct request evidence cannot contain redirect depth")
        if (
            self.correlation is BrowserCaptureCorrelation.REDIRECT_DESCENDANT
            and self.redirect_depth < 1
        ):
            raise ValueError("redirect evidence requires a positive redirect depth")

    def __reduce__(self) -> str | tuple[object, ...]:
        raise TypeError("BrowserCaptureEvidence cannot be serialized")


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
    method: str = "OTHER"

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
        if not isinstance(self.method, str):
            raise TypeError("method must be a string")
        method = self.method.strip().upper()
        if method not in {"GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"}:
            method = "OTHER"
        object.__setattr__(self, "method", method)


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
class BrowserCapturePolicy(Protocol):
    """Article policy deciding an admitted event without receiving its body."""

    def decide(self, evidence: BrowserCaptureEvidence) -> BrowserCaptureDecision: ...


@runtime_checkable
class BrowserCapturePrefetchPolicy(Protocol):
    """Optional article policy selecting an admitted request for fetch/fulfill."""

    def prefetch(self, observation: BrowserRequestObservation) -> bool: ...


@runtime_checkable
class BrowserFlowSession(Protocol):
    """Narrow controller surface for reachability probes and atomic Agent steps.

    The read-only page observation exists only for Bootstrap reachability
    probes. Article acquisition must use :meth:`browser_steps`; controllers no
    longer receive selector, locator, form-fill, or capture-wait operations.
    """

    def observe(self) -> BrowserPageObservation: ...

    def browser_steps(
        self,
        policy: BrowserStepPolicy,
        *,
        timeout_seconds: float,
    ) -> BrowserStepSession: ...


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
class BrowserOperationLimits:
    """Objective limits applied independently to one Browser operation."""

    max_capture_bytes: int = _DEFAULT_MAX_CAPTURE_BYTES
    action_timeout_seconds: float = _DEFAULT_ACTION_TIMEOUT_SECONDS
    capture_wait_timeout_seconds: float = _DEFAULT_CAPTURE_WAIT_TIMEOUT_SECONDS

    def __post_init__(self) -> None:
        if type(self.max_capture_bytes) is not int or self.max_capture_bytes <= 0:
            raise ValueError("max_capture_bytes must be a positive integer")
        for name in ("action_timeout_seconds", "capture_wait_timeout_seconds"):
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
class _ControlState:
    """Operation-local unified Browser control ledger.

    Vendor page/surface/element keys remain private to Network.  Only opaque
    request-local ids and the current neutral snapshot cross the control seam.
    """

    article_token: str
    ledger: BrowserObservationLedger = field(default_factory=BrowserObservationLedger)
    fingerprint: bytes | None = None
    page_keys: dict[str, object] = field(default_factory=dict)
    surface_keys: dict[str, tuple[object, int]] = field(default_factory=dict)
    element_keys: dict[str, tuple[object, int]] = field(default_factory=dict)
    observation: BrowserObservation | None = None
    agent_status: BrowserAgentStatus = BrowserAgentStatus.RUNNING
    last_receipt: BrowserActionReceipt | None = None

    def clear(self) -> None:
        """Release every neutral snapshot and private vendor binding."""

        self.ledger.invalidate()
        self.fingerprint = None
        self.page_keys.clear()
        self.surface_keys.clear()
        self.element_keys.clear()
        self.observation = None
        self.last_receipt = None


@dataclass(frozen=True, slots=True)
class _ControlSurfaceFact:
    key: int
    parent_key: int | None
    kind: BrowserSurfaceKind
    origin: str
    path: str
    title: str
    x: float
    y: float
    width: float
    height: float
    scroll_x: float
    scroll_y: float
    maximum_x: float
    maximum_y: float


class _Abort(Exception):
    __slots__ = ("code",)

    def __init__(self, code: str) -> None:
        self.code = code


def _control_observation_abort(stage: str) -> _Abort:
    """Return a payload-free failure that identifies the broken observation stage."""

    _LOGGER.debug(
        "event=browser-control-observation-failed stage=%s code=runtime",
        stage,
    )
    return _Abort("runtime")


def _redirect_policy_reason(error: _Abort) -> str:
    cause = error.__cause__
    if isinstance(cause, PolicyError):
        return {
            "network policy rejected input": "invalid-url-shape",
            "network destination is not allowed": "address-not-public",
            "network DNS resolution failed": "dns-resolution",
            "network destination changed during recheck": "dns-address-change",
            "network budget exceeded": "network-budget",
        }.get(str(cause), "destination-policy")
    if isinstance(cause, ValueError):
        return "destination-guard"
    return "destination-policy"


class _Stale(Exception):
    __slots__ = ("observation",)

    def __init__(self, observation: BrowserObservation) -> None:
        self.observation = observation


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
    resource: object = field(repr=False, compare=False)
    lease: _RequestLease
    evidence: BrowserCaptureEvidence
    body_unavailable: bool = False


@dataclass(frozen=True, slots=True)
class _PendingLocalDownload:
    destination: ResolvedDestination
    lease: _RequestLease
    evidence: BrowserCaptureEvidence


@dataclass(frozen=True, slots=True)
class _DownloadCapturePlan:
    destination: ResolvedDestination
    lease: _RequestLease
    evidence: BrowserCaptureEvidence


@unique
class _DeferredCaptureSource(str, Enum):
    RESPONSE = "response"
    DOWNLOAD = "download"


@dataclass(frozen=True, slots=True)
class _DeferredCapture:
    source: _DeferredCaptureSource
    resource: object = field(repr=False, compare=False)
    destination: ResolvedDestination
    lease: _RequestLease = field(repr=False, compare=False)
    evidence: BrowserCaptureEvidence


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
        "timeout": ("browser operation timed out", "retry after checking the operation", True),
        "oversize": ("browser capture exceeded its byte limit", "use a smaller resource", False),
        "challenge": (
            "browser access challenge was not supported",
            "use an approved source",
            False,
        ),
        "no-download": ("browser flow produced no download", "use another source", False),
        "capture-timeout": (
            "browser capture candidate did not resolve",
            "retry after checking the publisher response",
            True,
        ),
        "cleanup": ("browser resources could not be cleaned up", "retry the operation", True),
        "runtime": ("browser runtime failed", "retry the operation", True),
    }
    reason, action, retryable = messages.get(code, messages["runtime"])
    return AccessFailure(code=code, reason=reason, action=action, retryable=retryable)


def _http_status_class(value: object) -> str:
    """Return a bounded status class suitable for diagnostics."""

    if type(value) is not int or not 100 <= value <= 599:
        return "unknown"
    return f"{value // 100}xx"


def _media_category(value: object) -> str:
    """Collapse a response media type to the only class the operator needs."""

    return "pdf" if value == "application/pdf" else "other"


def _flow_diagnostic_counts(
    state: _FlowState,
) -> tuple[int, int, int, int, int, int, int, int]:
    """Read aggregate article state without exposing locators or vendor objects."""

    with state.lock:
        return (
            len(state.request_leases),
            len(state.pending_response_downloads),
            len(state.pending_local_downloads),
            len(state.deferred_captures),
            state.active_download_callbacks,
            len(state.captures),
            len(state.pages),
            len(state.popups),
        )


def _control_failure(code: str) -> AccessFailure:
    """Convert a private Browser abort into a safe controller failure."""

    values: dict[str, tuple[str, str, str, bool]] = {
        "policy": (
            "acquisition-browser-agent-action-rejected",
            "The Browser Agent action no longer matched the controlled page.",
            "Retry the Browser route with a fresh page observation.",
            False,
        ),
        "timeout": (
            "acquisition-browser-agent-action-timeout",
            "The controlled Browser action did not finish before its timeout.",
            "Retry the Browser route after checking the site and runtime.",
            True,
        ),
        "runtime": (
            "acquisition-browser-agent-action-failed",
            "The controlled Browser runtime could not apply the selected action.",
            "Review the Browser runtime and retry the route.",
            True,
        ),
    }
    stable_code, reason, action, retryable = values.get(code, values["runtime"])
    return AccessFailure(
        code=stable_code,
        reason=reason,
        action=action,
        retryable=retryable,
    )


def _control_settle_failure(code: str) -> AccessFailure:
    """Keep a settled route-policy stop distinct from action validation."""

    if code != "policy":
        return _control_failure(code)
    return AccessFailure(
        code="acquisition-browser-policy-failed",
        reason="The controlled Browser destination was rejected while the page settled.",
        action="Check the local site rule and Network destination policy.",
        retryable=False,
    )


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


def _safe_resource_type(value: object) -> str:
    """Return a bounded resource class for diagnostic messages only."""

    try:
        raw = _text_attribute(value, "resource_type")
    except BaseException:
        return "unknown"
    if raw is None:
        return "unknown"
    try:
        normalized = _observation_resource_type(raw)
    except (TypeError, ValueError):
        return "unknown"
    return normalized if normalized in _SAFE_RESOURCE_TYPES else "other"


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
        "capture_policy",
        "initial_locator",
        "navigation_only",
        "discard_unapproved_subresources",
        "limits",
        "clock",
        "operation_timeout_seconds",
        "cancel_event",
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
        "response_body_reads",
        "pending_local_downloads",
        "deferred_captures",
        "active_download_callbacks",
        "runtime",
        "connection_binder",
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
        "captures",
        "capture_digests",
        "control",
        "error",
    )

    def __init__(
        self,
        scope_permit: AccessPermit,
        host_policy: AccessPolicy,
        resolver: ResolverLike,
        destination_policy: DestinationPolicy,
        destination_guard: BrowserDestinationGuard | None,
        capture_policy: BrowserCapturePolicy | None,
        initial_locator: str,
        navigation_only: bool,
        discard_unapproved_subresources: bool,
        limits: BrowserOperationLimits,
        clock: Clock,
        operation_timeout_seconds: float,
        cancel_event: threading.Event | None,
        cleanup_timeout_seconds: float,
    ) -> None:
        self.scope_permit = scope_permit
        self.host_policy = host_policy
        self.resolver = resolver
        self.destination_policy = destination_policy
        self.destination_guard = destination_guard
        self.capture_policy = capture_policy
        self.initial_locator = _observation_locator(
            initial_locator,
            field_name="initial_locator",
        )
        self.navigation_only = navigation_only
        self.discard_unapproved_subresources = discard_unapproved_subresources
        self.limits = limits
        self.clock = clock
        self.operation_timeout_seconds = operation_timeout_seconds
        self.cancel_event = cancel_event
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
        self.response_body_reads: set[str] = set()
        self.pending_local_downloads: list[_PendingLocalDownload] = []
        self.deferred_captures: dict[int, _DeferredCapture] = {}
        self.active_download_callbacks = 0
        self.runtime: object | None = None
        self.connection_binder: object | None = None
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
        self.captures: list[BrowserCapture] = []
        self.capture_digests: set[bytes] = set()
        article_digest = hashlib.sha256(f"{id(self)}".encode("ascii")).hexdigest()[:24]
        self.control = _ControlState(article_token=f"a{article_digest}")
        self.error: _Abort | None = None

    def check(self) -> None:
        with self.lock:
            if self.error is not None:
                raise self.error
            if self.closed:
                raise _Abort("cancelled")
        if self.cancel_event is not None and self.cancel_event.is_set():
            raise _Abort("cancelled")

    def operation_timeout_milliseconds(self) -> int:
        self.check()
        return max(1, int(self.operation_timeout_seconds * 1000))

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

    def begin_download_callback(self, download: object) -> bool:
        """Atomically own one Download event and enter its callback lifetime."""

        with self.condition:
            if self.closed:
                return False
            if all(candidate is not download for candidate in self.downloads):
                self.downloads.append(download)
            self.active_download_callbacks += 1
            self.condition.notify_all()
            return True

    def finish_download_callback(self) -> None:
        with self.condition:
            if self.active_download_callbacks < 1:
                raise _Abort("cleanup")
            self.active_download_callbacks -= 1
            self.condition.notify_all()

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
            self.control.clear()
            return pages, downloads, streams

    def close_after_download_callbacks(self, deadline: float) -> bool:
        """Seal results only after every callback that already owns a download exits."""

        with self.condition:
            while self.active_download_callbacks > 0:
                remaining = deadline - time.monotonic()
                if remaining <= 0.0:
                    self.closed = True
                    self.cleanup_failed = True
                    self.condition.notify_all()
                    return False
                self.condition.wait(timeout=min(remaining, 0.01))
            self.closed = True
            self.condition.notify_all()
            return not self.cleanup_failed

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
        """Wait within the local cleanup timeout; never use Provider clocks."""

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
            # short bounded interval while retaining one cleanup timeout.
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

    def record_usage(
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

    def capture_decision(self, evidence: BrowserCaptureEvidence) -> BrowserCaptureDecision:
        if not isinstance(evidence, BrowserCaptureEvidence):
            raise _Abort("policy")
        policy = self.capture_policy
        if policy is None:
            return (
                BrowserCaptureDecision.ACCEPT
                if evidence.kind is BrowserCaptureKind.DOWNLOAD
                else BrowserCaptureDecision.REJECT
            )
        try:
            decision = policy.decide(evidence)
        except Exception as error:
            raise _Abort("policy") from error
        if not isinstance(decision, BrowserCaptureDecision):
            raise _Abort("policy")
        return decision

    def capture_prefetch(self, observation: BrowserRequestObservation) -> bool:
        if not isinstance(observation, BrowserRequestObservation):
            raise _Abort("policy")
        policy = self.capture_policy
        if policy is None or not isinstance(policy, BrowserCapturePrefetchPolicy):
            return False
        try:
            decision = policy.prefetch(observation)
        except Exception as error:
            raise _Abort("policy") from error
        if type(decision) is not bool:
            raise _Abort("policy")
        return decision

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
        self.record_usage(total_bytes=len(body))
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
                _LOGGER.debug(
                    "event=browser-capture-finished kind=%s media_category=%s "
                    "body_bytes=%d outcome=duplicate capture_count=%d",
                    kind.value,
                    _media_category(media_type),
                    len(body),
                    len(self.captures),
                )
                return
            self.usage.captures += 1
            self.capture_digests.add(digest)
            self.captures.append(capture)
            self.condition.notify_all()
            _LOGGER.debug(
                "event=browser-capture-finished kind=%s media_category=%s "
                "body_bytes=%d outcome=captured capture_count=%d",
                kind.value,
                _media_category(media_type),
                len(body),
                len(self.captures),
            )

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
            method=_text_attribute(request, "method") or "OTHER",
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
                timeout=self.operation_timeout_seconds,
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
        wait_deadline = self.clock() + self.operation_timeout_seconds
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
                remaining = wait_deadline - self.clock()
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
        resource: object,
        evidence: BrowserCaptureEvidence,
    ) -> None:
        key = destination.url.url
        with self.condition:
            existing = self.pending_response_downloads.get(key)
            pending = _PendingResponseDownload(
                resource=resource,
                lease=lease,
                evidence=evidence,
            )
            if existing is not None and existing != pending:
                # A page may emit another response/download pair for the same
                # PDF while the first candidate is still being drained (for
                # example a click handler retries after a challenge spinner).
                # Keep the first correlation proof; treating the duplicate as
                # a runtime failure would terminate an otherwise live Agent
                # session before it can observe the page again.
                _LOGGER.debug(
                    "event=browser-response-download-reserved outcome=duplicate "
                    "pending_response_count=%d",
                    len(self.pending_response_downloads),
                )
                return
            self.pending_response_downloads[key] = pending
            self.condition.notify_all()
            _LOGGER.debug(
                "event=browser-response-download-reserved kind=%s media_category=%s "
                "outcome=correlated pending_response_count=%d",
                evidence.kind.value,
                _media_category(evidence.media_type),
                len(self.pending_response_downloads),
            )

    def take_response_download(
        self,
        destination: ResolvedDestination,
    ) -> _PendingResponseDownload | None:
        with self.condition:
            pending = self.pending_response_downloads.pop(destination.url.url, None)
            self.condition.notify_all()
            return pending

    def pending_response_download_snapshot(self) -> tuple[_PendingResponseDownload, ...]:
        with self.condition:
            return tuple(self.pending_response_downloads.values())

    def begin_response_download_body(self, pending: _PendingResponseDownload) -> bool:
        key = pending.lease.destination.url.url
        with self.condition:
            current = self.pending_response_downloads.get(key)
            if (
                current is not pending
                or pending.body_unavailable
                or key in self.response_body_reads
            ):
                return False
            self.response_body_reads.add(key)
            return True

    def finish_response_download_body(
        self,
        pending: _PendingResponseDownload,
        *,
        captured: bool,
    ) -> None:
        key = pending.lease.destination.url.url
        with self.condition:
            self.response_body_reads.discard(key)
            current = self.pending_response_downloads.get(key)
            if current is pending:
                if captured:
                    self.pending_response_downloads.pop(key, None)
                else:
                    self.pending_response_downloads[key] = replace(
                        pending,
                        body_unavailable=True,
                    )
            self.condition.notify_all()

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

    def request_waits_for_capture(self, request: object) -> bool:
        with self.condition:
            return any(
                pending.lease.request is request
                for pending in self.pending_response_downloads.values()
            ) or any(
                candidate.lease.request is request for candidate in self.deferred_captures.values()
            )

    def expect_local_download(
        self,
        destination: ResolvedDestination,
        *,
        lease: _RequestLease,
        evidence: BrowserCaptureEvidence,
    ) -> None:
        with self.lock:
            self.pending_local_downloads.append(
                _PendingLocalDownload(
                    destination=destination,
                    lease=lease,
                    evidence=evidence,
                )
            )
            self.condition.notify_all()
            _LOGGER.debug(
                "event=browser-capture-candidate kind=%s media_category=%s "
                "decision=pending outcome=pending-local pending_local_count=%d",
                evidence.kind.value,
                _media_category(evidence.media_type),
                len(self.pending_local_downloads),
            )

    def take_local_download(self) -> _PendingLocalDownload | None:
        with self.condition:
            pending = self.pending_local_downloads.pop(0) if self.pending_local_downloads else None
            self.condition.notify_all()
            return pending

    def defer_capture(self, candidate: _DeferredCapture) -> None:
        if not isinstance(candidate, _DeferredCapture):
            raise _Abort("runtime")
        key = id(candidate.resource)
        with self.condition:
            existing = self.deferred_captures.get(key)
            if existing is not None and existing.resource is not candidate.resource:
                raise _Abort("runtime")
            self.deferred_captures[key] = candidate
            self.condition.notify_all()

    def deferred_capture_snapshot(self) -> tuple[_DeferredCapture, ...]:
        with self.condition:
            return tuple(self.deferred_captures.values())

    def claim_deferred_capture(self, candidate: _DeferredCapture) -> bool:
        key = id(candidate.resource)
        with self.condition:
            existing = self.deferred_captures.get(key)
            if existing is not candidate:
                return False
            self.deferred_captures.pop(key, None)
            self.condition.notify_all()
            return True

    def has_capture_candidate(self) -> bool:
        with self.condition:
            active = self.active_download_callbacks > 0
            evidences = (
                tuple(pending.evidence for pending in self.pending_response_downloads.values())
                + tuple(pending.evidence for pending in self.pending_local_downloads)
                + tuple(candidate.evidence for candidate in self.deferred_captures.values())
            )
        if active:
            return True
        return any(
            self.capture_decision(evidence) is not BrowserCaptureDecision.REJECT
            for evidence in evidences
        )

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

        Playwright routes only the first URL of a native redirect chain. A
        later chain member is admissible only when it points back to that live
        request, stays on the same non-null page, and its exact origin was
        reviewed, resolved and pinned in the transparent CONNECT tunnel before
        the routed request continued. These conditions apply equally to
        navigation and ordinary page-subresource redirects.
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
            self.response_body_reads.clear()
            self.pending_local_downloads.clear()
            self.deferred_captures.clear()
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


class _BrowserTransitionDriver:
    """Request-local neutral control capability over one private article."""

    __slots__ = ("_client", "_state", "_page")

    def __init__(self, client: BrowserClient, state: _FlowState, page: object) -> None:
        self._client = client
        self._state = state
        self._page = page

    def observe(self, *, page_state: BrowserPageState) -> BrowserObservation:
        return self._client._client_control_observe(
            self._state,
            self._page,
            page_state=page_state,
        )

    def begin(
        self,
        *,
        page_state: BrowserPageState,
        timeout_seconds: float,
    ) -> BrowserObservation | BrowserTransition:
        return self._client._client_control_begin(
            self._state,
            self._page,
            page_state=page_state,
            timeout_seconds=timeout_seconds,
        )

    def execute(
        self,
        action: BrowserAction,
        observation: BrowserObservation,
        *,
        timeout_seconds: float,
    ) -> BrowserTransition:
        return self._client._client_control_transition(
            self._state,
            self._page,
            action,
            observation,
            timeout_seconds=timeout_seconds,
        )

    def settle(
        self,
        observation: BrowserObservation,
        *,
        timeout_seconds: float,
    ) -> BrowserTransition:
        return self._client._client_control_settle(
            self._state,
            self._page,
            observation,
            receipt=None,
            timeout_seconds=timeout_seconds,
        )


class _BrowserSession:
    """Read-only probe plus atomic generic-step flow handle.

    The flow never receives a page/context/process/route or event object. All
    article actions go through ``BrowserStepSession`` so Network can enforce
    exact observation binding, one dispatch, settlement, capture and cleanup.
    """

    __slots__ = (
        "_observe_operation",
        "_control_driver_operation",
    )

    def __init__(self, client: BrowserClient, state: _FlowState, page: object) -> None:
        self._observe_operation = lambda: client._client_observe(state, page)
        self._control_driver_operation = lambda: _BrowserTransitionDriver(client, state, page)

    def observe(self) -> BrowserPageObservation:
        return self._observe_operation()

    def browser_steps(
        self,
        policy: BrowserStepPolicy,
        *,
        timeout_seconds: float,
    ) -> BrowserStepSession:
        """Open Network's atomic step engine for the current article."""

        return BrowserStepSession(
            driver=self._control_driver_operation(),
            policy=policy,
            timeout_seconds=timeout_seconds,
        )

    def _control_driver(self) -> BrowserStepDriver:
        """Expose the transition driver only to Network's direct tests."""

        return self._control_driver_operation()


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
        "_limits",
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
        limits: BrowserOperationLimits | None = None,
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
        if limits is not None and not isinstance(limits, BrowserOperationLimits):
            raise TypeError("limits must be BrowserOperationLimits")
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
        self._limits = limits or BrowserOperationLimits()

    @property
    def limits(self) -> BrowserOperationLimits:
        return self._limits

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
        capture_policy: BrowserCapturePolicy | None = None,
        navigation_only: bool = False,
        discard_unapproved_subresources: bool = False,
        session_key: str | None = None,
        limits: BrowserOperationLimits | None = None,
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
            effective_limits = self._effective_limits(limits, request_max_bytes)
            if cancel_event is not None and not hasattr(cancel_event, "is_set"):
                raise _Abort("policy")
            if destination_guard is not None and not isinstance(
                destination_guard,
                BrowserDestinationGuard,
            ):
                raise _Abort("policy")
            if capture_policy is not None and not isinstance(
                capture_policy,
                BrowserCapturePolicy,
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
        result_code_before_cleanup = "runtime"
        result_contains_capture = False
        capture_count_before_cleanup = 0
        entered_process = False
        try:
            try:
                scope_permit = self._coordinator.acquire_scope(
                    scope,
                    policy,
                    cancel_event=cancel_event,
                    timeout=effective_timeout,
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
                capture_policy,
                _policy_url(initial.url.url),
                navigation_only,
                discard_unapproved_subresources,
                effective_limits,
                self._clock,
                effective_timeout,
                cancel_event,
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
                            timeout=effective_timeout,
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
            self._refresh_deferred_captures(state)
            # A PDF captured during the initial navigation is already a
            # complete Browser outcome. Do not ask the Agent for a page
            # snapshot (or a redundant action) after the result is available.
            if controller is not None and not state.captures:
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
            self._refresh_deferred_captures(state)
            if controller is None and state.has_capture_candidate():
                self._client_wait_for_any_capture(
                    state,
                    tuple(BrowserCaptureKind),
                    candidate_only=True,
                )
                self._refresh_deferred_captures(state)
            if state.error is not None:
                raise state.error
            if state.policy_rejection:
                raise _Abort("policy")
            if not state.captures:
                raise _Abort("capture-timeout" if state.has_capture_candidate() else "no-download")
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
            result_code_before_cleanup = (
                "capture-batch"
                if isinstance(result, BrowserCaptureBatch)
                else result.code
                if isinstance(result, AccessFailure)
                else "contract"
            )
            result_contains_capture = isinstance(result, BrowserCaptureBatch)
            capture_count_before_cleanup = 0 if state is None else len(state.captures)
            _LOGGER.debug(
                "event=browser-result-before-cleanup cleanup_scope=runtime-resources "
                "result=%s result_contains_capture=%s capture_count_before=%d",
                result_code_before_cleanup,
                str(result_contains_capture).lower(),
                capture_count_before_cleanup,
            )
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
            _LOGGER.debug(
                "event=browser-result-after-cleanup cleanup_scope=runtime-resources "
                "result_before=%s result_replaced=true cleanup_error=true "
                "capture_count_before=%d capture_count_after=%d "
                "result_contains_capture=%s business_result_deliverable=false",
                result_code_before_cleanup,
                capture_count_before_cleanup,
                0 if state is None else len(state.captures),
                str(result_contains_capture).lower(),
            )
            return _failure("cleanup")
        _LOGGER.debug(
            "event=browser-result-after-cleanup cleanup_scope=runtime-resources "
            "result_before=%s result_replaced=false cleanup_error=false "
            "capture_count_before=%d capture_count_after=%d "
            "result_contains_capture=%s business_result_deliverable=%s",
            result_code_before_cleanup,
            capture_count_before_cleanup,
            0 if state is None else len(state.captures),
            str(result_contains_capture).lower(),
            str(result_contains_capture).lower(),
        )
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
    def _effective_limits(
        limits: BrowserOperationLimits | None,
        request_max_bytes: int,
    ) -> BrowserOperationLimits:
        selected = BrowserOperationLimits() if limits is None else limits
        if not isinstance(selected, BrowserOperationLimits):
            raise _Abort("policy")
        return BrowserOperationLimits(
            max_capture_bytes=min(selected.max_capture_bytes, request_max_bytes),
            action_timeout_seconds=selected.action_timeout_seconds,
            capture_wait_timeout_seconds=selected.capture_wait_timeout_seconds,
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
        every outstanding vendor task within the local cleanup timeout.
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

        state.connection_binder = context
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
                _LOGGER.debug(
                    "event=browser-request-classified outcome=rejected reason=navigation-only "
                    "navigation=false resource_type=%s",
                    _safe_resource_type(request),
                )
                return
            state.record_usage(requests=1)
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
                _LOGGER.debug(
                    "event=browser-request-classified outcome=ignored reason=internal "
                    "navigation=%s resource_type=%s",
                    str(navigation).lower(),
                    _safe_resource_type(request),
                )
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
            _LOGGER.debug(
                "event=browser-request-classified outcome=rejected code=%s "
                "navigation=%s resource_type=%s",
                error.code,
                str(navigation).lower(),
                _safe_resource_type(request) if request is not None else "unknown",
            )
            if (
                error.code != "cancelled"
                and request is not None
                and not navigation
                and state.discard_unapproved_subresources
            ):
                # A page may request optional scripts, frames, images or
                # trackers that disappear while a challenge is settling.  A
                # rejected/failed dependency is local evidence, not an
                # article-level terminal state.  Abort only this route and
                # let the next stable observation reach the Agent.
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
                    # ``route.abort`` is the transport acknowledgement.  A
                    # humanized click may still be unwinding or the page may
                    # be replacing its document; keep this rejection local to
                    # the failed hop and let the next stable observation guide
                    # the Agent.  Initial navigation is still guarded before
                    # any Browser page is exposed, and a later unapproved hop
                    # will be rejected again at its own route boundary.
                    self._finish_rejected_route(state, route, request)
                    return
            state.fail(error.code)
            self._finish_rejected_route(state, route, request)
        except Exception:
            state.record_request(admitted=False)
            if request is not None and not navigation and state.discard_unapproved_subresources:
                # Vendor/Resolver exceptions for optional resources are local
                # evidence.  Keep the article lease alive and let the next
                # stable observation guide the Agent; cleanup failures are
                # still reported by ``_finish_rejected_route`` below.
                _LOGGER.debug(
                    "event=browser-request-discarded outcome=local-failure "
                    "reason=noncritical-resource-failure"
                )
            else:
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
            state.record_usage(navigations=1)
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
        # Playwright may route only the first member of a native redirect
        # chain. Record this request-reviewed connection origin so later
        # same-page descendants can reuse the still-live route lease without
        # requiring the origin to have been known before Browser launch.
        state.prebound_origins.add(destination.url.origin.text)
        state.register_request(
            request,
            page=page,
            destination=destination,
            navigation=navigation,
        )
        prefetch_observation = state._request_observation(
            request,
            page,
            destination.url.url,
            BrowserDestinationKind.NAVIGATION if navigation else BrowserDestinationKind.REQUEST,
            capture_kind=BrowserCaptureKind.RESPONSE,
        )
        prefetched = state.capture_prefetch(prefetch_observation) and self._prefetch_route(route)
        if not prefetched:
            self._continue_route(route)
        state.record_request(admitted=True)
        _LOGGER.debug(
            "event=browser-request-classified outcome=admitted navigation=%s resource_type=%s "
            "method=%s top_frame=%s transport=%s",
            str(navigation).lower(),
            _safe_resource_type(request),
            prefetch_observation.method,
            str(prefetch_observation.is_top_frame).lower(),
            "fetch-fulfill" if prefetched else "continue",
        )

    @staticmethod
    def _prefetch_route(route: _Route) -> bool:
        fetch = getattr(route, "fetch", None)
        fulfill = getattr(route, "fulfill", None)
        if not callable(fetch) or not callable(fulfill):
            return False
        try:
            response = fetch(max_redirects=0)
            fulfill(response=response)
        except Exception as error:
            raise _Abort("runtime") from error
        return True

    @staticmethod
    def _request_from_event(value: object) -> object:
        candidate = _attribute(value, "request")
        return value if candidate is None else candidate

    def _handle_request_finished(self, state: _FlowState, value: object) -> None:
        try:
            request = self._request_from_event(value)
            if state.request_waits_for_capture(request):
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
        media_type = "unknown"
        capture_kind: BrowserCaptureKind | None = None
        decision: BrowserCaptureDecision | None = None
        release_after_response = True
        try:
            url, request = self._response_shape(response)
            status = _attribute(response, "status")
            _LOGGER.debug(
                "event=browser-response-seen status=%s status_class=%s navigation=%s redirected=%s",
                "unknown" if type(status) is not int else status,
                _http_status_class(status),
                str(self._is_navigation_request(request)).lower(),
                str(_attribute(request, "redirected_from") is not None).lower(),
            )
            stage = "destination-guard"
            destination = self._resolve_response_destination(state, url, request)
            if destination is None:
                _LOGGER.debug(
                    "event=browser-response-classified outcome=ignored "
                    "reason=unapproved-subresource status=%s status_class=%s",
                    "unknown" if type(status) is not int else status,
                    _http_status_class(status),
                )
                return
            stage = "request-correlation"
            lease = self._correlate_response_request(
                state,
                request,
                destination,
                status=status,
            )
            _LOGGER.debug(
                "event=browser-response-correlation outcome=matched navigation=%s "
                "status=%s status_class=%s",
                str(lease.navigation).lower(),
                "unknown" if type(status) is not int else status,
                _http_status_class(status),
            )
            state.guard_request(
                request,
                lease.page,
                destination.url.url,
                BrowserDestinationKind.RESPONSE,
            )
            if type(status) is int and status in {301, 302, 303, 307, 308}:
                self._prepare_redirect_connection(
                    state,
                    response,
                    lease,
                    destination,
                )
            stage = "response-classification"
            if lease.navigation and lease.page is not None and type(status) is int:
                # Script, click and native redirect navigations do not all
                # return through ``page.goto``.  The correlated top-frame
                # response is therefore the authoritative status update for
                # later page-state classification.
                state.page_statuses[id(lease.page)] = status
            if type(status) is not int or not 200 <= status <= 299:
                _LOGGER.debug(
                    "event=browser-response-classified outcome=non-2xx status=%s "
                    "status_class=%s navigation=%s",
                    "unknown" if type(status) is not int else status,
                    _http_status_class(status),
                    str(lease.navigation).lower(),
                )
                return
            if status == 206:
                _LOGGER.debug(
                    "event=browser-response-classified outcome=partial-content "
                    "body_read=no status=206 status_class=2xx"
                )
                return
            media_type = self._response_media_type(response)
            capture_kind = self._response_capture_kind(
                state,
                lease.page,
                destination.url.url,
            )
            state.guard_request(
                request,
                lease.page,
                destination.url.url,
                BrowserDestinationKind.RESPONSE,
                capture_kind=capture_kind,
            )
            download_expected = _attribute(response, "download_expected") is True
            evidence = self._capture_evidence(
                state,
                destination,
                lease,
                request,
                kind=capture_kind,
                media_type=media_type,
                native_download=download_expected,
            )
            decision = state.capture_decision(evidence)
            if download_expected:
                download_evidence = replace(
                    evidence,
                    kind=BrowserCaptureKind.DOWNLOAD,
                )
                download_decision = state.capture_decision(download_evidence)
                priority = {
                    BrowserCaptureDecision.REJECT: 0,
                    BrowserCaptureDecision.DEFER: 1,
                    BrowserCaptureDecision.ACCEPT: 2,
                }
                if priority[download_decision] >= priority[decision]:
                    evidence = download_evidence
                    decision = download_decision
                    capture_kind = BrowserCaptureKind.DOWNLOAD
            stage = "native-download-reservation"
            reserved_download = self._reserve_response_download(
                state,
                response,
                destination,
                lease,
                evidence=evidence,
            )
            if reserved_download:
                release_after_response = False
                reservation_outcome = (
                    "pending-discard"
                    if decision is BrowserCaptureDecision.REJECT
                    else "pending-candidate"
                )
                _LOGGER.debug(
                    "event=browser-response-classified outcome=%s "
                    "media_category=%s capture_kind=%s decision=%s body_read=no "
                    "correlation=%s from_exact_start=%s redirect_depth=%d "
                    "download_expected=true status=%s status_class=%s",
                    reservation_outcome,
                    _media_category(media_type),
                    capture_kind.value,
                    decision.value,
                    evidence.correlation.value,
                    str(evidence.from_exact_start).lower(),
                    evidence.redirect_depth,
                    status,
                    _http_status_class(status),
                )
                return
            if decision is BrowserCaptureDecision.DEFER:
                state.defer_capture(
                    _DeferredCapture(
                        source=_DeferredCaptureSource.RESPONSE,
                        resource=response,
                        destination=destination,
                        lease=lease,
                        evidence=evidence,
                    )
                )
                release_after_response = False
                _LOGGER.debug(
                    "event=browser-response-classified outcome=deferred "
                    "media_category=%s capture_kind=%s decision=defer body_read=no "
                    "correlation=%s from_exact_start=%s redirect_depth=%d "
                    "download_expected=false status=%s status_class=%s",
                    _media_category(media_type),
                    capture_kind.value,
                    evidence.correlation.value,
                    str(evidence.from_exact_start).lower(),
                    evidence.redirect_depth,
                    status,
                    _http_status_class(status),
                )
                return
            if decision is BrowserCaptureDecision.REJECT:
                self._reserve_local_pdf_download(
                    state,
                    destination,
                    lease,
                    evidence=evidence,
                )
                release_after_response = not state.request_waits_for_capture(lease.request)
                _LOGGER.debug(
                    "event=browser-response-classified outcome=rejected "
                    "media_category=%s capture_kind=%s decision=reject body_read=no "
                    "correlation=%s from_exact_start=%s redirect_depth=%d "
                    "download_expected=false status=%s status_class=%s",
                    _media_category(media_type),
                    capture_kind.value,
                    evidence.correlation.value,
                    str(evidence.from_exact_start).lower(),
                    evidence.redirect_depth,
                    status,
                    _http_status_class(status),
                )
                return
            stage = "response-body"
            self._capture_response_body(
                state,
                response,
                destination,
                lease,
                kind=capture_kind,
                media_type=media_type,
            )
        except _Abort as error:
            _LOGGER.debug(
                "event=browser-response-failed stage=%s code=%s retryable=%s "
                "status=%s status_class=%s media_category=%s capture_kind=%s "
                "decision=%s body_read=%s navigation=%s redirected=%s outcome=%s",
                stage,
                error.code,
                str(error.code in {"timeout", "admission", "runtime"}).lower(),
                "unknown" if type(status) is not int else status,
                _http_status_class(status),
                _media_category(media_type),
                "none" if capture_kind is None else capture_kind.value,
                "none" if decision is None else decision.value,
                str(stage in {"response-body", "capture"}).lower(),
                str(request is not None and self._is_navigation_request(request)).lower(),
                str(
                    request is not None and _attribute(request, "redirected_from") is not None
                ).lower(),
                "rejected" if error.code == "policy" else "failed",
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
                    # intentionally a local no-download outcome.  The
                    # optional dependency must not turn a transient response
                    # race into an article-level policy terminal.
                    return
            if (
                request is not None
                and not self._is_navigation_request(request)
                and state.discard_unapproved_subresources
                and error.code not in {"cancelled", "cleanup"}
            ):
                # Response body/correlation errors for optional dependencies
                # must not strand the article flow.  The candidate (if any)
                # is discarded by its owning callback and the Agent can keep
                # exploring the live page.
                state.record_request(admitted=False)
                _LOGGER.debug(
                    "event=browser-response-discarded stage=%s reason=noncritical-resource-failure",
                    stage,
                )
                return
            if request is not None and self._is_navigation_request(request):
                # A top-frame response can race a click/redirect transition.
                # Route admission already acknowledged the request; do not
                # turn a transient response classification into a sticky
                # article failure.  A later route/observation still applies
                # the normal destination checks once the page settles.
                state.record_request(admitted=False)
                _LOGGER.debug(
                    "event=browser-response-discarded stage=%s reason=transient-navigation-failure",
                    stage,
                )
                return
            state.fail(error.code)
        except Exception:
            _LOGGER.debug(
                "event=browser-response-failed stage=%s code=runtime retryable=true "
                "status=%s status_class=%s media_category=%s capture_kind=%s "
                "decision=%s body_read=%s navigation=%s redirected=%s outcome=failed",
                stage,
                "unknown" if type(status) is not int else status,
                _http_status_class(status),
                _media_category(media_type),
                "none" if capture_kind is None else capture_kind.value,
                "none" if decision is None else decision.value,
                str(stage in {"response-body", "capture"}).lower(),
                str(request is not None and self._is_navigation_request(request)).lower(),
                str(
                    request is not None and _attribute(request, "redirected_from") is not None
                ).lower(),
            )
            if (
                request is not None
                and not self._is_navigation_request(request)
                and state.discard_unapproved_subresources
            ):
                # Optional resource response failures are not article
                # failures.  The next observation can still describe a
                # usable page or a later PDF candidate.
                _LOGGER.debug(
                    "event=browser-response-discarded stage=%s reason=noncritical-resource-failure",
                    stage,
                )
            else:
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
    def _prepare_redirect_connection(
        state: _FlowState,
        response: object,
        lease: _RequestLease,
        source: ResolvedDestination,
    ) -> None:
        """Guard and bind a native redirect before Chromium opens CONNECT.

        Playwright may route only the first member of a native redirect chain.
        The 3xx response is therefore the last deterministic point at which
        Network can admit a cross-origin next hop before Chromium asks the
        transparent proxy for a tunnel.
        """

        headers = _attribute(response, "headers")
        if headers is None:
            return
        if not isinstance(headers, tuple):
            raise _Abort("runtime")
        location: str | None = None
        for item in headers:
            if (
                not isinstance(item, tuple)
                or len(item) != 2
                or type(item[0]) is not str
                or type(item[1]) is not str
            ):
                raise _Abort("runtime")
            if item[0].casefold() == "location":
                location = item[1]
                break
        if location is None:
            return
        try:
            target = urljoin(source.url.url, location)
            parsed = urlsplit(target)
            if source.url.scheme == "https" and parsed.scheme.casefold() == "http":
                target = urlunsplit(
                    (
                        "https",
                        parsed.netloc,
                        parsed.path,
                        parsed.query,
                        parsed.fragment,
                    )
                )
        except (TypeError, ValueError):
            raise _Abort("policy") from None
        destination = BrowserClient._resolve_redirect_destination(
            state,
            target,
            navigation=lease.navigation,
            target_scheme=parsed.scheme.casefold() or "missing",
            has_fragment=bool(parsed.fragment),
            has_query=bool(parsed.query),
            encoded_path_separator=bool(
                "%2f" in parsed.path.casefold() or "%5c" in parsed.path.casefold()
            ),
            double_slash_path="//" in parsed.path,
            dot_segment_path=any(segment in {".", ".."} for segment in parsed.path.split("/")),
        )
        state.acquire_host(destination)
        binder = state.connection_binder
        if binder is None:
            raise _Abort("runtime")
        state.bind_runtime(binder, destination, allow_runtime_fallback=False)
        state.prebound_origins.add(destination.url.origin.text)

    @staticmethod
    def _resolve_redirect_destination(
        state: _FlowState,
        target: str,
        *,
        navigation: bool,
        target_scheme: str,
        has_fragment: bool,
        has_query: bool,
        encoded_path_separator: bool,
        double_slash_path: bool,
        dot_segment_path: bool,
    ) -> ResolvedDestination:
        try:
            return state.resolve(
                target,
                kind=(
                    BrowserDestinationKind.NAVIGATION
                    if navigation
                    else BrowserDestinationKind.REQUEST
                ),
            )
        except _Abort as error:
            _LOGGER.debug(
                "event=browser-redirect-prebind-failed stage=resolve code=%s reason=%s "
                "target_scheme=%s has_fragment=%s has_query=%s "
                "encoded_path_separator=%s double_slash_path=%s dot_segment_path=%s",
                error.code,
                _redirect_policy_reason(error),
                target_scheme,
                str(has_fragment).lower(),
                str(has_query).lower(),
                str(encoded_path_separator).lower(),
                str(double_slash_path).lower(),
                str(dot_segment_path).lower(),
            )
            raise

    @staticmethod
    def _capture_evidence(
        state: _FlowState,
        destination: ResolvedDestination,
        lease: _RequestLease,
        request: object,
        *,
        kind: BrowserCaptureKind,
        media_type: str,
        native_download: bool,
    ) -> BrowserCaptureEvidence:
        """Build bounded lineage proof without exposing a vendor object.

        The request must be either the exact intercepted request held by the
        lease or a live native redirect descendant of it.  This is evidence
        about transport correlation only: Publisher/article interpretation is
        deliberately left to the injected capture policy.
        """

        if not isinstance(destination, ResolvedDestination) or not isinstance(
            lease,
            _RequestLease,
        ):
            raise _Abort("runtime")
        current: object | None = request
        seen: set[int] = set()
        redirect_depth = 0
        while current is not None and redirect_depth <= 32:
            identity = id(current)
            if identity in seen:
                raise _Abort("runtime")
            seen.add(identity)
            if current is lease.request:
                correlation = (
                    BrowserCaptureCorrelation.DIRECT_REQUEST
                    if redirect_depth == 0
                    else BrowserCaptureCorrelation.REDIRECT_DESCENDANT
                )
                return BrowserCaptureEvidence(
                    locator=destination.url.url,
                    kind=kind,
                    media_type=media_type,
                    correlation=correlation,
                    request_navigation=lease.navigation,
                    from_exact_start=(
                        lease.navigation and lease.destination.url.url == state.initial_locator
                    ),
                    redirect_depth=redirect_depth,
                    native_download=native_download,
                )
            current = _attribute(current, "redirected_from")
            redirect_depth += 1
        raise _Abort("runtime")

    @staticmethod
    def _reserve_response_download(
        state: _FlowState,
        response: object,
        destination: ResolvedDestination,
        lease: _RequestLease,
        *,
        evidence: BrowserCaptureEvidence,
    ) -> bool:
        if _attribute(response, "download_expected") is not True or (
            evidence.kind is not BrowserCaptureKind.DOWNLOAD and not evidence.request_navigation
        ):
            return False
        state.expect_response_download(
            destination,
            lease,
            resource=response,
            evidence=evidence,
        )
        return True

    def _reserve_local_pdf_download(
        self,
        state: _FlowState,
        destination: ResolvedDestination,
        lease: _RequestLease,
        *,
        evidence: BrowserCaptureEvidence,
    ) -> None:
        if evidence.media_type != "application/pdf":
            return
        download_evidence = replace(
            evidence,
            kind=BrowserCaptureKind.DOWNLOAD,
            native_download=True,
        )
        if state.capture_decision(download_evidence) is BrowserCaptureDecision.REJECT:
            return
        # A reviewed page script may turn an already-admitted PDF response
        # into a local blob download. Keep only the safe response locator and
        # media type as its one-shot provenance; the opaque blob URL never
        # enters policy, logs or results.
        state.expect_local_download(
            destination,
            lease=lease,
            evidence=download_evidence,
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
        _LOGGER.debug(
            "event=browser-capture-started source=response kind=%s media_category=%s",
            kind.value,
            _media_category(media_type),
        )
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
        _LOGGER.debug(
            "event=browser-capture-body outcome=accepted source=response kind=%s "
            "media_category=%s body_bytes=%d capture_count=%d",
            kind.value,
            _media_category(media_type),
            len(body),
            len(state.captures),
        )

    def _refresh_deferred_captures(self, state: _FlowState) -> None:
        """Resolve operation-local candidates against the policy's current facts.

        A deferred response or download remains unread until this method sees
        ``ACCEPT``.  Policy updates therefore affect the live candidate rather
        than an old boolean snapshot.  Claiming precedes body access so two
        event/control threads cannot consume the same vendor resource.
        """

        self._refresh_pending_response_downloads(state)

        for candidate in state.deferred_capture_snapshot():
            decision = state.capture_decision(candidate.evidence)
            _LOGGER.debug(
                "event=browser-capture-candidate-reviewed source=%s decision=%s "
                "kind=%s media_category=%s body_read=no correlation=%s "
                "from_exact_start=%s redirect_depth=%d",
                candidate.source.value,
                decision.value,
                candidate.evidence.kind.value,
                _media_category(candidate.evidence.media_type),
                candidate.evidence.correlation.value,
                str(candidate.evidence.from_exact_start).lower(),
                candidate.evidence.redirect_depth,
            )
            if decision is BrowserCaptureDecision.DEFER:
                continue
            if not state.claim_deferred_capture(candidate):
                continue
            try:
                self._materialize_deferred_capture(state, candidate, decision)
            except _Abort as error:
                if error.code in {"cancelled", "cleanup"}:
                    raise
                # A deferred response/download is still only a candidate.
                # Body races, oversize data and vendor read failures must not
                # terminate the live Agent session; discard this candidate
                # and allow the next observation to choose another entry.
                if candidate.source is _DeferredCaptureSource.DOWNLOAD:
                    self._discard_failed_download(state, candidate.resource)
                _LOGGER.debug(
                    "event=browser-capture-candidate-finished source=%s "
                    "decision=discard reason=candidate-failure code=%s",
                    candidate.source.value,
                    error.code,
                )
            except Exception:
                if candidate.source is _DeferredCaptureSource.DOWNLOAD:
                    self._discard_failed_download(state, candidate.resource)
                _LOGGER.debug(
                    "event=browser-capture-candidate-finished source=%s "
                    "decision=discard reason=candidate-runtime-failure",
                    candidate.source.value,
                )
            finally:
                state.finish_request(candidate.lease.request)

    def _refresh_pending_response_downloads(self, state: _FlowState) -> None:
        """Materialize a PDF response when no native Download is required.

        Playwright integrations are not consistent about whether a PDF
        navigation emits a native ``download`` event. The response callback
        therefore retains the response resource as an operation-local
        candidate. If its body is readable, it is captured immediately; if
        the runtime cannot read it, the candidate remains available to a
        later native download event.
        """

        for pending in state.pending_response_download_snapshot():
            if pending.body_unavailable:
                continue
            decision = state.capture_decision(pending.evidence)
            _LOGGER.debug(
                "event=browser-capture-candidate-reviewed source=response "
                "decision=%s kind=%s media_category=%s body_read=no "
                "correlation=%s from_exact_start=%s redirect_depth=%d",
                decision.value,
                pending.evidence.kind.value,
                _media_category(pending.evidence.media_type),
                pending.evidence.correlation.value,
                str(pending.evidence.from_exact_start).lower(),
                pending.evidence.redirect_depth,
            )
            if decision is not BrowserCaptureDecision.ACCEPT:
                # Keep DEFER and REJECT reservations until a native download
                # event (if any) arrives; that event can still be safely
                # correlated and discarded without turning a late callback
                # into an unrelated runtime failure.
                continue
            if not state.begin_response_download_body(pending):
                continue
            candidate = _DeferredCapture(
                source=_DeferredCaptureSource.RESPONSE,
                resource=pending.resource,
                destination=pending.lease.destination,
                lease=pending.lease,
                evidence=pending.evidence,
            )
            try:
                self._materialize_deferred_capture(
                    state,
                    candidate,
                    BrowserCaptureDecision.ACCEPT,
                )
            except _Abort as error:
                if error.code in {"cancelled", "cleanup"}:
                    raise
                # The response headers are still valid correlation proof. Do
                # not retry a body read that this runtime cannot perform; a
                # native Download callback may provide the same bytes later.
                state.finish_response_download_body(pending, captured=False)
                _LOGGER.debug(
                    "event=browser-capture-candidate-finished source=response "
                    "decision=await-native-download reason=body-unavailable code=%s",
                    error.code,
                )
            except Exception:
                state.finish_response_download_body(pending, captured=False)
                _LOGGER.debug(
                    "event=browser-capture-candidate-finished source=response "
                    "decision=await-native-download reason=body-unavailable code=runtime"
                )
            else:
                state.finish_response_download_body(pending, captured=True)
                state.finish_request(pending.lease.request)

    def _materialize_deferred_capture(
        self,
        state: _FlowState,
        candidate: _DeferredCapture,
        decision: BrowserCaptureDecision,
    ) -> None:
        if decision is BrowserCaptureDecision.REJECT:
            if candidate.source is _DeferredCaptureSource.DOWNLOAD:
                self._discard_failed_download(state, candidate.resource)
            _LOGGER.debug(
                "event=browser-capture-candidate-finished source=%s "
                "decision=reject body_read=no cleanup=discarded",
                candidate.source.value,
            )
            return

        body = self._read_deferred_capture(state, candidate)
        state.check()
        state.add_capture(
            kind=candidate.evidence.kind,
            body=body,
            media_type=candidate.evidence.media_type,
            locator=candidate.destination.url.url,
        )
        _LOGGER.debug(
            "event=browser-capture-candidate-finished source=%s "
            "decision=accept body_read=yes cleanup=owned body_bytes=%d",
            candidate.source.value,
            len(body),
        )

    def _read_deferred_capture(self, state: _FlowState, candidate: _DeferredCapture) -> bytes:
        if candidate.source is _DeferredCaptureSource.RESPONSE:
            return cast(
                bytes,
                self._run_cancellable(
                    state,
                    lambda: self._response_bytes(state, candidate.resource),
                    abort=lambda: self._abort_runtime(
                        candidate.lease.page,
                        None,
                        state.runtime,
                    ),
                ),
            )
        return cast(
            bytes,
            self._run_cancellable(
                state,
                lambda: self._download_bytes(state, candidate.resource),
                abort=lambda: self._abort_runtime(None, None, state.runtime),
            ),
        )

    def _client_wait_for_any_capture(
        self,
        state: _FlowState,
        kinds: tuple[BrowserCaptureKind, ...],
        *,
        candidate_only: bool = False,
    ) -> None:
        if (
            not isinstance(kinds, tuple)
            or not kinds
            or any(not isinstance(kind, BrowserCaptureKind) for kind in kinds)
            or len(kinds) != len(set(kinds))
        ):
            raise _Abort("policy")
        if type(candidate_only) is not bool:
            raise _Abort("policy")
        started_at = state.clock()
        deadline = started_at + state.limits.capture_wait_timeout_seconds
        _LOGGER.debug(
            "event=browser-capture-wait-started max_wait_seconds=%.3f",
            state.limits.capture_wait_timeout_seconds,
        )
        while True:
            self._refresh_deferred_captures(state)
            with state.condition:
                if any(capture.kind in kinds for capture in state.captures):
                    _LOGGER.debug(
                        "event=browser-capture-wait-finished outcome=captured elapsed_ms=%d",
                        max(int((state.clock() - started_at) * 1000), 0),
                    )
                    return
                if state.error is not None:
                    raise state.error
                if candidate_only and not state.has_capture_candidate():
                    return
                state.check()
                remaining = deadline - state.clock()
                if remaining <= 0:
                    _LOGGER.debug(
                        "event=browser-capture-wait-finished outcome=no-capture elapsed_ms=%d",
                        max(int((state.clock() - started_at) * 1000), 0),
                    )
                    return
                state.condition.wait(timeout=min(remaining, 0.05))

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
        del locator
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
            is_new = state.register_popup(page)
            if is_new:
                state.record_usage(popups=1)
            _LOGGER.debug(
                "event=browser-page-successor outcome=registered kind=popup new=%s "
                "page_count=%d popup_count=%d",
                str(is_new).lower(),
                len(state.pages),
                len(state.popups),
            )
        except _Abort as error:
            _LOGGER.debug(
                "event=browser-page-successor outcome=rejected kind=popup code=%s",
                error.code,
            )
            state.fail(error.code)
            if state.claim_cleanup(page) and not self._close_object(page):
                state.mark_cleanup_failure()
        except Exception:
            _LOGGER.debug("event=browser-page-successor outcome=failed kind=popup code=runtime")
            state.fail("runtime")
            if state.claim_cleanup(page) and not self._close_object(page):
                state.mark_cleanup_failure()

    def _handle_download(self, state: _FlowState, download: object) -> None:  # noqa: C901
        request: object | None = None
        callback_started = False
        deferred = False
        stage = "ownership"
        plan: _DownloadCapturePlan | None = None
        decision: BrowserCaptureDecision | None = None
        try:
            if not state.begin_download_callback(download):
                raise _Abort("cleanup")
            callback_started = True
            state.record_usage(downloads=1)
            _LOGGER.debug("event=browser-download-seen outcome=received")
            stage = "capture-plan"
            plan = self._download_capture_plan(state, download)
            if plan is None:
                _LOGGER.debug(
                    "event=browser-download-classified outcome=ignored reason=no-capture-plan "
                    "body_read=no cleanup=discarded"
                )
                self._discard_failed_download(state, download)
                return
            request = plan.lease.request
            decision = state.capture_decision(plan.evidence)
            if decision is BrowserCaptureDecision.REJECT:
                _LOGGER.debug(
                    "event=browser-download-classified outcome=rejected "
                    "kind=%s media_category=%s decision=reject body_read=no "
                    "correlation=%s from_exact_start=%s redirect_depth=%d "
                    "cleanup=discarded",
                    plan.evidence.kind.value,
                    _media_category(plan.evidence.media_type),
                    plan.evidence.correlation.value,
                    str(plan.evidence.from_exact_start).lower(),
                    plan.evidence.redirect_depth,
                )
                self._discard_failed_download(state, download)
                return
            if decision is BrowserCaptureDecision.DEFER:
                state.defer_capture(
                    _DeferredCapture(
                        source=_DeferredCaptureSource.DOWNLOAD,
                        resource=download,
                        destination=plan.destination,
                        lease=plan.lease,
                        evidence=plan.evidence,
                    )
                )
                deferred = True
                _LOGGER.debug(
                    "event=browser-download-classified outcome=deferred "
                    "kind=%s media_category=%s decision=defer body_read=no "
                    "correlation=%s from_exact_start=%s redirect_depth=%d",
                    plan.evidence.kind.value,
                    _media_category(plan.evidence.media_type),
                    plan.evidence.correlation.value,
                    str(plan.evidence.from_exact_start).lower(),
                    plan.evidence.redirect_depth,
                )
                return
            _LOGGER.debug(
                "event=browser-download-classified outcome=accepted kind=%s "
                "media_category=%s decision=accept body_read=yes correlation=%s "
                "from_exact_start=%s redirect_depth=%d",
                plan.evidence.kind.value,
                _media_category(plan.evidence.media_type),
                plan.evidence.correlation.value,
                str(plan.evidence.from_exact_start).lower(),
                plan.evidence.redirect_depth,
            )
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
                kind=plan.evidence.kind,
                body=body,
                media_type=plan.evidence.media_type,
                locator=plan.destination.url.url,
            )
            _LOGGER.debug(
                "event=browser-download-captured outcome=captured kind=%s "
                "media_category=%s body_bytes=%d capture_count=%d",
                plan.evidence.kind.value,
                _media_category(plan.evidence.media_type),
                len(body),
                len(state.captures),
            )
        except _Abort as error:
            _LOGGER.debug(
                "event=browser-download-failed stage=%s code=%s retryable=%s "
                "outcome=%s kind=%s media_category=%s correlation=%s",
                stage,
                error.code,
                str(error.code in {"timeout", "admission", "runtime"}).lower(),
                "rejected" if error.code == "policy" else "failed",
                "none" if plan is None else plan.evidence.kind.value,
                "unknown" if plan is None else _media_category(plan.evidence.media_type),
                "none" if plan is None else plan.evidence.correlation.value,
            )
            if plan is not None and error.code not in {"cancelled", "cleanup"}:
                # A native download is still only a candidate until
                # Acquisition validates its bytes and article identity.  A
                # malformed/partial candidate is discarded locally so the
                # Agent can try another visible entry point in this same
                # Browser session.
                _LOGGER.debug(
                    "event=browser-download-discarded stage=%s reason=candidate-failure",
                    stage,
                )
            else:
                state.fail(error.code)
            self._discard_failed_download(state, download)
        except Exception:
            _LOGGER.debug(
                "event=browser-download-failed stage=%s code=runtime retryable=true "
                "outcome=failed kind=%s media_category=%s correlation=%s",
                stage,
                "none" if plan is None else plan.evidence.kind.value,
                "unknown" if plan is None else _media_category(plan.evidence.media_type),
                "none" if plan is None else plan.evidence.correlation.value,
            )
            if plan is None:
                state.fail("runtime")
            else:
                _LOGGER.debug(
                    "event=browser-download-discarded stage=%s reason=candidate-runtime-failure",
                    stage,
                )
            self._discard_failed_download(state, download)
        finally:
            if request is not None and not deferred:
                try:
                    state.finish_request(request)
                except Exception:
                    state.fail("cleanup")
                    state.mark_cleanup_failure()
            if callback_started:
                try:
                    state.finish_download_callback()
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
        return _DownloadCapturePlan(
            destination=pending.destination,
            lease=pending.lease,
            evidence=replace(pending.evidence, native_download=True),
        )

    def _infer_local_download(self, state: _FlowState) -> _PendingLocalDownload | None:
        with state.lock:
            capture_already_available = bool(state.captures)
            live_leases = tuple(state.request_leases.values())
        if capture_already_available:
            return None
        candidates: list[_PendingLocalDownload] = []
        for lease in live_leases:
            evidence = self._capture_evidence(
                state,
                lease.destination,
                lease,
                lease.request,
                kind=BrowserCaptureKind.DOWNLOAD,
                media_type="application/pdf",
                native_download=True,
            )
            if state.capture_decision(evidence) is not BrowserCaptureDecision.REJECT:
                candidates.append(
                    _PendingLocalDownload(
                        destination=lease.destination,
                        lease=lease,
                        evidence=evidence,
                    )
                )
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
        download_media_type = self._download_media_type(download)
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
        lease: _RequestLease | None = None
        if pending is not None:
            lease = pending.lease
        elif request_candidate is not None:
            lease = state.correlate_response_request(request_candidate, destination)
        else:
            inferred_request = state.find_request_for_download(destination)
            if inferred_request is not None:
                with state.lock:
                    candidate = state.request_leases.get(id(inferred_request))
                if candidate is not None and candidate.request is inferred_request:
                    lease = candidate
                    request_candidate = inferred_request
        with state.lock:
            live = lease is not None and state.request_leases.get(id(lease.request)) is lease
        if lease is None or not live:
            _LOGGER.debug(
                "event=browser-download-correlation-miss outcome=correlation-miss "
                "pending_response=%s "
                "download_request_present=%s inferred_request_present=%s "
                "live_request_present=%s destination_matches=%s media_category=%s",
                str(pending is not None).lower(),
                str(request_candidate is not None).lower(),
                str(request_candidate is not None).lower(),
                str(live).lower(),
                str(lease is not None and lease.destination.url.url == destination.url.url).lower(),
                _media_category(download_media_type),
            )
            # A network download without a still-live intercepted request
            # cannot prove pre-transport admission. Local blob downloads use
            # the separately recorded response proof.
            raise _Abort("runtime")
        evidence = (
            replace(pending.evidence, native_download=True)
            if pending is not None
            else self._capture_evidence(
                state,
                destination,
                lease,
                request_candidate,
                kind=BrowserCaptureKind.DOWNLOAD,
                media_type=download_media_type,
                native_download=True,
            )
        )
        return _DownloadCapturePlan(
            destination=destination,
            lease=lease,
            evidence=evidence,
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
        if isinstance(declared, int) and declared > state.limits.max_capture_bytes:
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
            value = reader(state.limits.max_capture_bytes + 1)
        return BrowserClient._bounded_body_value(state, value)

    @staticmethod
    def _download_bytes(state: _FlowState, download: object) -> bytes:
        declared = _attribute(download, "size")
        if isinstance(declared, int) and declared > state.limits.max_capture_bytes:
            raise _Abort("oversize")
        reader = getattr(download, "content", None)
        if not callable(reader):
            reader = getattr(download, "read", None)
        if not callable(reader):
            raise _Abort("runtime")
        try:
            value = reader()
        except TypeError:
            value = reader(state.limits.max_capture_bytes + 1)
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
            body = reader(state.limits.max_capture_bytes + 1)
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
        if len(body) > state.limits.max_capture_bytes:
            raise _Abort("oversize")
        return body

    def _client_navigate(self, state: _FlowState, page: object, url: str) -> None:
        try:
            state.check()
            destination = state.resolve(url, kind=BrowserDestinationKind.NAVIGATION)
            runtime_url = _runtime_url(url, state.destination_policy)
            if _policy_url(runtime_url) != destination.url.url:
                raise _Abort("policy")
            state.record_usage(navigations=1)
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
            if state.has_capture_candidate():
                self._wait_for_navigation_candidate(
                    state,
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

    def _wait_for_navigation_candidate(
        self,
        state: _FlowState,
        page: object,
        *,
        prior_capture_count: int,
    ) -> None:
        """Let a native download callback arrive before page control starts.

        A fully materialized deferred candidate returns immediately so
        Acquisition can add article facts.  Pending response/download
        correlation is allowed one bounded capture interval, which preserves
        delayed native downloads without making a controller observe a page
        while its download callback is still in flight.
        """

        deadline = state.clock() + state.limits.capture_wait_timeout_seconds
        while True:
            self._refresh_deferred_captures(state)
            with state.condition:
                if len(state.captures) > prior_capture_count:
                    return
                if any(
                    candidate.lease.page is page for candidate in state.deferred_captures.values()
                ):
                    return
                pending_for_page = any(
                    pending.lease.page is page
                    for pending in state.pending_response_downloads.values()
                ) or any(pending.lease.page is page for pending in state.pending_local_downloads)
                if not pending_for_page and state.active_download_callbacks == 0:
                    return
                state.check()
                remaining = deadline - state.clock()
                if remaining <= 0:
                    return
                state.condition.wait(timeout=min(remaining, 0.05))

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
                    timeout=state.operation_timeout_milliseconds(),
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

    def _begin_control_click_navigation(
        self,
        state: _FlowState,
        page: object,
    ) -> None:
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
            # increment the navigation diagnostic counter.
            state.navigations[id(page)] = _Navigation(
                page,
                current_destination,
                budget_counted=False,
            )

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

    def _client_control_observe(  # noqa: C901, PLR0912, PLR0915
        self,
        state: _FlowState,
        page: object,
        *,
        page_state: BrowserPageState,
    ) -> BrowserObservation:
        """Create one unified article-owned Browser observation."""

        if not isinstance(page_state, BrowserPageState):
            raise _Abort("policy")
        state.check()
        self._refresh_deferred_captures(state)
        candidate = state.has_capture_candidate()
        with state.lock:
            pages = tuple(state.pages)
            captures = bool(state.captures)
        if not pages or all(candidate_page is not page for candidate_page in pages):
            raise _control_observation_abort("page-membership")
        observable_pages: list[object] = []
        for candidate_page in pages:
            closed_method = getattr(candidate_page, "control_is_closed", None)
            if not callable(closed_method):
                observable_pages.append(candidate_page)
                continue
            is_closed = self._run_cancellable(
                state,
                closed_method,
                abort=lambda candidate_page=candidate_page: self._abort_runtime(
                    candidate_page,
                    None,
                    state.runtime,
                ),
            )
            if type(is_closed) is not bool:
                raise _control_observation_abort("page-closed-contract")
            if not is_closed:
                observable_pages.append(candidate_page)
        if not observable_pages:
            raise BrowserObservationUnavailable()
        selected_page = observable_pages[-1]
        control = state.control
        previous_page_id = None if control.observation is None else control.observation.page_id
        page_keys: dict[str, object] = {}
        surface_keys: dict[str, tuple[object, int]] = {}
        element_keys: dict[str, tuple[object, int]] = {}
        surfaces: list[BrowserSurface] = []
        elements: list[BrowserElement] = []
        selected_screenshot: bytes | None = None
        selected_media_type: str | None = None
        selected_viewport: BrowserViewport | None = None
        selected_root_surface_id: str | None = None

        for candidate_page in observable_pages:
            snapshot_method = getattr(candidate_page, "control_snapshot", None)
            if not callable(snapshot_method):
                raise _control_observation_abort("snapshot-capability")
            try:
                snapshot = self._run_cancellable(
                    state,
                    lambda candidate_page=candidate_page, snapshot_method=snapshot_method: (
                        snapshot_method(
                            timeout=state.operation_timeout_milliseconds(),
                            include_screenshot=candidate_page is selected_page,
                        )
                    ),
                    abort=lambda candidate_page=candidate_page: self._abort_runtime(
                        candidate_page,
                        None,
                        state.runtime,
                    ),
                )
            except BrowserObservationUnavailable:
                if candidate_page is selected_page:
                    raise
                continue
            if not isinstance(snapshot, dict):
                raise _control_observation_abort("snapshot-shape")
            width = snapshot.get("width")
            height = snapshot.get("height")
            raw_title = snapshot.get("title")
            raw_surfaces = snapshot.get("surfaces")
            raw_elements = snapshot.get("elements")
            screenshot = snapshot.get("screenshot")
            media_type = snapshot.get("screenshot_media_type")
            if (
                type(width) is not int
                or type(height) is not int
                or not 1 <= width <= 16_384
                or not 1 <= height <= 16_384
                or type(raw_title) is not str
                or not isinstance(raw_surfaces, tuple)
                or not raw_surfaces
                or len(raw_surfaces) > 128
                or not isinstance(raw_elements, tuple)
                or len(raw_elements) > 256
            ):
                raise _control_observation_abort("snapshot-contract")
            if candidate_page is selected_page:
                if (
                    type(screenshot) is not bytes
                    or not screenshot
                    or len(screenshot) > _MAX_AGENT_SCREENSHOT_BYTES
                    or media_type not in {"image/png", "image/jpeg", "image/webp"}
                ):
                    raise _control_observation_abort("selected-screenshot-contract")
                selected_screenshot = screenshot
                selected_media_type = media_type
                selected_viewport = BrowserViewport(width=width, height=height)
            elif screenshot is not None or media_type is not None:
                raise _control_observation_abort("background-screenshot-contract")

            page_id = _control_id("p", id(candidate_page))
            if page_id in page_keys:
                raise _control_observation_abort("page-identity")
            page_keys[page_id] = candidate_page
            surface_id_by_key: dict[int, str] = {}
            surface_fact_by_key: dict[int, _ControlSurfaceFact] = {}
            root_keys: list[int] = []
            for raw_surface in raw_surfaces:
                if not isinstance(raw_surface, tuple) or len(raw_surface) != 14:
                    raise _control_observation_abort("surface-shape")
                (
                    key,
                    parent_key,
                    kind_value,
                    locator,
                    title,
                    x,
                    y,
                    surface_width,
                    surface_height,
                    scroll_x,
                    scroll_y,
                    maximum_x,
                    maximum_y,
                    reserved,
                ) = raw_surface
                if (
                    type(key) is not int
                    or key < 0
                    or (parent_key is not None and (type(parent_key) is not int or parent_key < 0))
                    or type(kind_value) is not str
                    or type(locator) is not str
                    or type(title) is not str
                    or reserved is not None
                    or key in surface_fact_by_key
                ):
                    raise _control_observation_abort("surface-contract")
                try:
                    kind = BrowserSurfaceKind(kind_value)
                    normalized = normalize_url(
                        _policy_url(locator),
                        allowed_schemes=self._destination_policy.allowed_schemes,
                        allowed_ports=self._destination_policy.allowed_ports,
                    )
                    state.guard(normalized.url, BrowserDestinationKind.RESPONSE)
                except (PolicyError, TypeError, ValueError) as error:
                    raise _Abort("policy") from error
                if parent_key is None:
                    root_keys.append(key)
                    kind = (
                        BrowserSurfaceKind.POPUP
                        if any(candidate_page is popup for popup in state.popups)
                        else BrowserSurfaceKind.PAGE
                    )
                elif kind in {BrowserSurfaceKind.PAGE, BrowserSurfaceKind.POPUP}:
                    raise _control_observation_abort("surface-kind")
                surface_id = _control_id("s", page_id, key)
                checked_key = cast(int, key)
                checked_parent = cast(int | None, parent_key)
                surface_id_by_key[checked_key] = surface_id
                surface_fact_by_key[checked_key] = _ControlSurfaceFact(
                    key=checked_key,
                    parent_key=checked_parent,
                    kind=kind,
                    origin=normalized.origin.text,
                    path=normalized.path,
                    title=cast(str, title),
                    x=cast(float, x),
                    y=cast(float, y),
                    width=cast(float, surface_width),
                    height=cast(float, surface_height),
                    scroll_x=cast(float, scroll_x),
                    scroll_y=cast(float, scroll_y),
                    maximum_x=cast(float, maximum_x),
                    maximum_y=cast(float, maximum_y),
                )
            if len(root_keys) != 1:
                raise _control_observation_abort("surface-root")
            if any(
                fact.parent_key is not None and fact.parent_key not in surface_fact_by_key
                for fact in surface_fact_by_key.values()
            ):
                raise _control_observation_abort("surface-parent")

            viewport = BrowserViewport(width=width, height=height)
            for fact in surface_fact_by_key.values():
                try:
                    surface = BrowserSurface(
                        surface_id=surface_id_by_key[fact.key],
                        page_id=page_id,
                        kind=fact.kind,
                        parent_surface_id=(
                            None if fact.parent_key is None else surface_id_by_key[fact.parent_key]
                        ),
                        origin=fact.origin,
                        path=fact.path,
                        title=fact.title if fact.title else raw_title,
                        viewport=viewport,
                        bounds=BrowserBounds(
                            x=fact.x,
                            y=fact.y,
                            width=fact.width,
                            height=fact.height,
                        ),
                        scroll=BrowserScrollState(
                            x=fact.scroll_x,
                            y=fact.scroll_y,
                            maximum_x=fact.maximum_x,
                            maximum_y=fact.maximum_y,
                        ),
                    )
                except (TypeError, ValueError) as error:
                    raise _control_observation_abort("surface-model") from error
                surfaces.append(surface)
                surface_keys[surface.surface_id] = (candidate_page, fact.key)
            if candidate_page is selected_page:
                selected_root_surface_id = surface_id_by_key[root_keys[0]]

            for raw_element in raw_elements:
                if not isinstance(raw_element, tuple) or len(raw_element) != 10:
                    raise _control_observation_abort("element-shape")
                (
                    element_key,
                    surface_key,
                    role,
                    name,
                    visible,
                    enabled,
                    x,
                    y,
                    element_width,
                    element_height,
                ) = raw_element
                if (
                    type(element_key) is not int
                    or element_key < 1
                    or type(surface_key) is not int
                    or surface_key not in surface_id_by_key
                    or type(role) is not str
                    or type(name) is not str
                    or type(visible) is not bool
                    or type(enabled) is not bool
                ):
                    raise _control_observation_abort("element-contract")
                if not visible:
                    continue
                element_id = _control_id("e", page_id, surface_key, element_key)
                if element_id in element_keys:
                    raise _control_observation_abort("element-identity")
                try:
                    element = BrowserElement(
                        element_id=element_id,
                        surface_id=surface_id_by_key[surface_key],
                        role=role,
                        name=name,
                        state=(
                            BrowserElementState.ENABLED if enabled else BrowserElementState.DISABLED
                        ),
                        bounds=BrowserBounds(
                            x=x,
                            y=y,
                            width=element_width,
                            height=element_height,
                        ),
                    )
                except (TypeError, ValueError) as error:
                    raise _control_observation_abort("element-model") from error
                elements.append(element)
                element_keys[element_id] = (candidate_page, element_key)

        if (
            selected_screenshot is None
            or selected_media_type is None
            or selected_viewport is None
            or selected_root_surface_id is None
        ):
            raise _control_observation_abort("selected-page-contract")
        selected_page_id = next(
            page_id
            for page_id, candidate_page in page_keys.items()
            if candidate_page is selected_page
        )
        if previous_page_id is not None and previous_page_id != selected_page_id:
            _LOGGER.debug(
                "event=browser-control-page-successor previous_page_id=%s "
                "selected_page_id=%s page_count=%d popup_count=%d",
                previous_page_id,
                selected_page_id,
                len(page_keys),
                len(state.popups),
            )
        # Captures are terminal only to the outer Acquisition boundary.  Keep
        # the Agent session observable while it explores: a previously
        # captured (and still unvalidated) candidate must not make the next
        # click/scroll look like a completed article.  A pending candidate is
        # still surfaced so the bounded capture wait can finish before the
        # next action.  The outer ``BrowserClient`` returns every materialized
        # capture after the controller stops, where Acquisition performs the
        # PDF and article-identity gates.
        capture_state = (
            # A capture that arrived before the Agent was ever called is an
            # immediately consumable terminal (for example an initial URL
            # that is already a PDF).  Once an action receipt exists, keep
            # captures hidden from the in-flight Agent loop so it can continue
            # exploring and Acquisition can validate the complete batch when
            # the controller eventually stops.
            BrowserCaptureState.CAPTURED
            if captures and control.last_receipt is None
            else BrowserCaptureState.CANDIDATE
            if candidate and not captures
            else BrowserCaptureState.NONE
        )
        current = control.ledger.current
        provisional_revision = 1 if current is None else current.revision + 1
        screenshot_sha256 = sha256_digest(selected_screenshot)
        screenshot_value = BrowserScreenshot(
            screenshot_id=_control_id(
                "i",
                selected_page_id,
                selected_root_surface_id,
                screenshot_sha256.root,
            ),
            article_token=control.article_token,
            page_id=selected_page_id,
            surface_id=selected_root_surface_id,
            revision=provisional_revision,
            viewport=selected_viewport,
            media_type=selected_media_type,
            sha256=screenshot_sha256,
            content=selected_screenshot,
        )
        provisional = BrowserObservation(
            article_token=control.article_token,
            revision=provisional_revision,
            page_id=selected_page_id,
            surfaces=tuple(surfaces),
            elements=tuple(elements),
            screenshot=screenshot_value,
            page_state=page_state,
            agent_status=control.agent_status,
            capture_state=capture_state,
            last_receipt=control.last_receipt,
        )
        fingerprint = bytes.fromhex(stable_semantic_page_fingerprint(provisional).root)
        changed = (
            control.observation is None
            or control.fingerprint != fingerprint
            or control.ledger.current is None
        )
        if changed:
            observation = control.ledger.publish(provisional)
        else:
            assert current is not None
            observation = replace(
                provisional,
                revision=current.revision,
                screenshot=replace(screenshot_value, revision=current.revision),
            )
            control.ledger.replace_current(observation)
        control.page_keys = page_keys
        control.surface_keys = surface_keys
        control.element_keys = element_keys
        control.fingerprint = fingerprint
        control.observation = observation
        root = observation.primary_surface
        (
            request_count,
            pending_response_count,
            pending_local_count,
            deferred_capture_count,
            active_download_callbacks,
            capture_count,
            page_count,
            popup_count,
        ) = _flow_diagnostic_counts(state)
        _LOGGER.debug(
            "event=browser-control-observation-summary page_id=%s revision=%d "
            "page_state=%s capture_state=%s page_count=%d popup_count=%d "
            "surface_count=%d element_count=%d root_surface_kind=%s "
            "root_scroll_y=%.1f root_scroll_max_y=%.1f "
            "pending_response_count=%d pending_local_count=%d deferred_capture_count=%d "
            "active_download_callbacks=%d capture_count=%d request_count=%d",
            observation.page_id,
            observation.revision,
            observation.page_state.value,
            observation.capture_state.value,
            page_count,
            popup_count,
            len(observation.surfaces),
            len(observation.elements),
            root.kind.value,
            root.scroll.y,
            root.scroll.maximum_y,
            pending_response_count,
            pending_local_count,
            deferred_capture_count,
            active_download_callbacks,
            capture_count,
            request_count,
        )
        return observation

    def _client_control_stale_after_transition(
        self,
        state: _FlowState,
        page: object,
        observation: BrowserObservation,
        *,
        timeout_seconds: float,
    ) -> BrowserTransition:
        """Settle a pre-dispatch page transition and keep the action stale."""

        readiness = self._client_control_settle(
            state,
            page,
            observation,
            receipt=None,
            timeout_seconds=timeout_seconds,
        )
        if isinstance(readiness, BrowserSettledTransition):
            return BrowserStaleTransition(readiness.observation)
        return readiness

    def _client_control_transition(
        self,
        state: _FlowState,
        page: object,
        action: BrowserAction,
        observation: BrowserObservation,
        *,
        timeout_seconds: float,
    ) -> BrowserTransition:
        """Dispatch one action and return only after its bounded settlement."""

        action_started = time.monotonic()
        try:
            receipt = self._client_control_execute(
                state,
                page,
                action,
                observation,
                timeout_seconds=timeout_seconds,
            )
        except BrowserObservationUnavailable:
            return self._client_control_stale_after_transition(
                state,
                page,
                observation,
                timeout_seconds=timeout_seconds,
            )
        except _Stale as stale:
            return BrowserStaleTransition(stale.observation)
        except _Abort as error:
            current = state.control.observation
            if error.code == "cancelled":
                return BrowserCancelledTransition(current)
            return BrowserFailedTransition(
                failure=_control_failure(error.code),
                observation=current,
            )
        if isinstance(action, Stop):
            current = state.control.observation
            if current is None:
                return BrowserFailedTransition(_control_failure("runtime"))
            return BrowserStoppedTransition(receipt=receipt, observation=current)
        if receipt.outcome is BrowserActionOutcome.NO_CHANGE:
            current = state.control.observation
            if current is None:
                return BrowserFailedTransition(
                    _control_failure("runtime"),
                    receipt=receipt,
                )
            current, finalized = self._finalize_control_receipt(state, current, receipt)
            return BrowserSettledTransition(
                observation=current,
                changed=False,
                receipt=finalized,
            )
        remaining = float(timeout_seconds) - (time.monotonic() - action_started)
        if remaining <= 0:
            return BrowserFailedTransition(
                failure=_control_failure("timeout"),
                observation=state.control.observation,
                receipt=receipt,
            )
        return self._client_control_settle(
            state,
            page,
            observation,
            receipt=receipt,
            timeout_seconds=remaining,
        )

    @staticmethod
    def _control_begin_abort(
        state: _FlowState,
        error: _Abort,
    ) -> BrowserCancelledTransition | BrowserFailedTransition:
        if error.code == "cancelled":
            return BrowserCancelledTransition(state.control.observation)
        return BrowserFailedTransition(
            _control_settle_failure(error.code),
            state.control.observation,
        )

    def _wait_for_control_observation(
        self,
        state: _FlowState,
        *,
        deadline: float,
    ) -> BrowserTransition | None:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return BrowserFailedTransition(_control_failure("timeout"))
        with state.condition:
            try:
                state.check()
            except _Abort as error:
                return self._control_begin_abort(state, error)
            state.condition.wait(timeout=min(remaining, _CONTROL_OBSERVATION_QUIET_SECONDS))
        return None

    def _client_control_begin(
        self,
        state: _FlowState,
        page: object,
        *,
        page_state: BrowserPageState,
        timeout_seconds: float,
    ) -> BrowserObservation | BrowserTransition:
        """Return the first coherent observation for policy priming.

        Initial Publisher classification may bind landing-page facts that are
        required to accept an already pending PDF candidate.  Consequently
        this primitive must not enter the capture/quiet settle loop itself;
        :class:`BrowserStepSession` classifies this provisional observation
        and then calls ``settle`` with the classified state.  The provisional
        transition remains private to Network and never reaches a chooser.
        """

        if not isinstance(page_state, BrowserPageState):
            return BrowserFailedTransition(_control_failure("policy"))
        if (
            isinstance(timeout_seconds, bool)
            or not isinstance(timeout_seconds, (int, float))
            or not 0 < timeout_seconds <= state.limits.action_timeout_seconds
        ):
            return BrowserFailedTransition(_control_failure("policy"))
        deadline = time.monotonic() + float(timeout_seconds)
        while True:
            try:
                observation = self._client_control_observe(
                    state,
                    page,
                    page_state=page_state,
                )
            except BrowserObservationUnavailable:
                terminal = self._wait_for_control_observation(
                    state,
                    deadline=deadline,
                )
                if terminal is not None:
                    return terminal
                continue
            except _Abort as error:
                return self._control_begin_abort(state, error)
            if time.monotonic() >= deadline:
                return BrowserFailedTransition(
                    _control_failure("timeout"),
                    observation,
                )
            return observation

    @staticmethod
    def _control_capture_progress(state: _FlowState) -> BrowserCaptureState:
        with state.lock:
            if state.captures:
                return BrowserCaptureState.CAPTURED
        return (
            BrowserCaptureState.CANDIDATE
            if state.has_capture_candidate()
            else BrowserCaptureState.NONE
        )

    @staticmethod
    def _finalize_control_receipt(
        state: _FlowState,
        observation: BrowserObservation,
        receipt: BrowserActionReceipt | None,
    ) -> tuple[BrowserObservation, BrowserActionReceipt | None]:
        if receipt is None:
            # A pre-dispatch settle may reuse the last coherent snapshot
            # while capture is being drained. Keep the request-local ledger
            # aligned with that snapshot even though no new receipt exists.
            state.control.observation = observation
            if state.control.ledger.current is not None:
                state.control.ledger.replace_current(observation)
            else:
                state.control.ledger.restore_current(observation)
            return observation, None
        finalized = replace(receipt, after_revision=observation.revision)
        current = replace(observation, last_receipt=finalized)
        state.control.last_receipt = finalized
        state.control.observation = current
        # An applied action invalidates the observation ledger before its
        # settle phase begins.  A capture can complete during that phase, so
        # the terminal result may legitimately use the last coherent page
        # snapshot without forcing a new vendor snapshot just to repopulate
        # the ledger.
        if state.control.ledger.current is not None:
            state.control.ledger.replace_current(current)
        else:
            state.control.ledger.restore_current(current)
        return current, finalized

    def _client_control_settle(  # noqa: C901
        self,
        state: _FlowState,
        page: object,
        observation: BrowserObservation,
        *,
        receipt: BrowserActionReceipt | None,
        timeout_seconds: float,
    ) -> BrowserTransition:
        """Wait for page/capture effects using one action-level settle primitive."""

        if not isinstance(observation, BrowserObservation):
            return BrowserFailedTransition(_control_failure("policy"))
        if (
            isinstance(timeout_seconds, bool)
            or not isinstance(timeout_seconds, (int, float))
            or not 0 < timeout_seconds <= state.limits.action_timeout_seconds
        ):
            return BrowserFailedTransition(_control_failure("policy"), observation)
        before = stable_semantic_page_fingerprint(observation)
        action_deadline = time.monotonic() + float(timeout_seconds)
        candidate_deadline: float | None = None
        quiet_fingerprint: str | None = None
        current: BrowserObservation | None = None
        settle_stage = "snapshot"
        try:
            while True:
                # Capture is an outcome channel, not a page-observation
                # side effect.  Drain operation-local candidates before
                # touching the Browser page again; PDF viewers frequently
                # replace their document while a response/download callback
                # is still completing, which makes an otherwise harmless
                # snapshot temporarily unavailable.
                settle_stage = "capture"
                self._refresh_deferred_captures(state)
                with state.lock:
                    captured = bool(state.captures)
                if captured:
                    # A capture that arrives after an Agent action is an
                    # internal candidate, not an instruction to stop the
                    # Agent. Acquisition may still need another candidate
                    # to establish article identity. Only a capture present
                    # before the first Agent decision is terminal here.
                    initial_capture = receipt is None and observation.last_receipt is None
                    capture_state = (
                        BrowserCaptureState.CAPTURED
                        if initial_capture
                        else BrowserCaptureState.NONE
                    )
                    current = replace(observation, capture_state=capture_state)
                    current, finalized = self._finalize_control_receipt(
                        state,
                        current,
                        receipt,
                    )
                    if initial_capture:
                        return BrowserCapturedTransition(current, finalized)
                    return BrowserSettledTransition(
                        observation=current,
                        changed=False,
                        receipt=finalized,
                    )
                if state.has_capture_candidate():
                    now = time.monotonic()
                    if candidate_deadline is None:
                        candidate_deadline = now + state.limits.capture_wait_timeout_seconds
                    remaining = candidate_deadline - now
                    if remaining <= 0:
                        return self._client_control_candidate_timeout(
                            state,
                            observation,
                            receipt=receipt,
                        )
                    with state.condition:
                        state.check()
                        state.condition.wait(
                            timeout=min(remaining, _CONTROL_OBSERVATION_QUIET_SECONDS)
                        )
                    continue
                settle_stage = "snapshot"
                try:
                    current = self._client_control_observe(
                        state,
                        page,
                        page_state=observation.page_state,
                    )
                except BrowserObservationUnavailable:
                    quiet_fingerprint = None
                    remaining = action_deadline - time.monotonic()
                    if remaining <= 0:
                        raise _Abort("timeout") from None
                    _LOGGER.debug(
                        "event=browser-control-observation-transition stage=snapshot "
                        "remaining_ms=%d",
                        max(0, int(remaining * 1000)),
                    )
                    with state.condition:
                        state.check()
                        state.condition.wait(
                            timeout=min(remaining, _CONTROL_OBSERVATION_QUIET_SECONDS)
                        )
                    continue
                settle_stage = "capture"
                capture_state = current.capture_state
                if capture_state is BrowserCaptureState.CAPTURED:
                    current, finalized = self._finalize_control_receipt(
                        state,
                        current,
                        receipt,
                    )
                    return BrowserCapturedTransition(current, finalized)
                if capture_state is BrowserCaptureState.CANDIDATE:
                    now = time.monotonic()
                    if candidate_deadline is None:
                        candidate_deadline = now + state.limits.capture_wait_timeout_seconds
                    remaining = candidate_deadline - now
                    if remaining <= 0:
                        return self._client_control_candidate_timeout(
                            state,
                            current,
                            receipt=receipt,
                        )
                    with state.condition:
                        state.check()
                        state.condition.wait(
                            timeout=min(remaining, _CONTROL_OBSERVATION_QUIET_SECONDS)
                        )
                    quiet_fingerprint = None
                    continue

                current_fingerprint = stable_semantic_page_fingerprint(current)
                changed = current_fingerprint != before
                if quiet_fingerprint == current_fingerprint.root:
                    current, finalized = self._finalize_control_receipt(
                        state,
                        current,
                        receipt,
                    )
                    return BrowserSettledTransition(
                        observation=current,
                        changed=changed,
                        receipt=finalized,
                    )
                quiet_fingerprint = None

                remaining = action_deadline - time.monotonic()
                if remaining <= 0:
                    # A real page may keep changing because of a challenge,
                    # countdown, animation, telemetry widget, or live
                    # content.  Once we have a coherent snapshot, lack of a
                    # second identical fingerprint is not a Browser failure:
                    # give the latest observation to the Agent.  The next
                    # action is still rebound and revalidated immediately
                    # before dispatch, so a stale element cannot be clicked
                    # merely because the page was not quiet.
                    current, finalized = self._finalize_control_receipt(
                        state,
                        current,
                        receipt,
                    )
                    _LOGGER.debug(
                        "event=browser-control-settle-latest-observation "
                        "outcome=settled changed=%s",
                        str(changed).lower(),
                    )
                    return BrowserSettledTransition(
                        observation=current,
                        changed=changed,
                        receipt=finalized,
                    )
                settle_stage = "page-binding"
                selected_page = state.control.page_keys.get(current.page_id)
                operation = (
                    None
                    if selected_page is None
                    else getattr(selected_page, "control_wait_for_change", None)
                )
                if not callable(operation):
                    raise _Abort("runtime")
                wait_for_change = cast(Callable[..., object], operation)
                milliseconds = max(
                    1,
                    int(min(remaining, _CONTROL_OBSERVATION_QUIET_SECONDS) * 1000),
                )
                try:
                    settle_stage = "change-wait"
                    result = self._run_cancellable(
                        state,
                        lambda: wait_for_change(timeout=milliseconds),
                        abort=lambda: self._abort_runtime(
                            selected_page,
                            None,
                            state.runtime,
                        ),
                    )
                except BrowserObservationUnavailable:
                    _LOGGER.debug(
                        "event=browser-control-observation-transition stage=change-wait "
                        "remaining_ms=%d",
                        max(0, int((action_deadline - time.monotonic()) * 1000)),
                    )
                    continue
                settle_stage = "change-result"
                if type(result) is not bool:
                    raise _Abort("runtime")
                if not result:
                    quiet_fingerprint = current_fingerprint.root
        except _Stale as stale:
            return BrowserStaleTransition(stale.observation)
        except _Abort as error:
            _LOGGER.debug(
                "event=browser-control-settle-failed stage=%s code=%s",
                settle_stage,
                error.code,
            )
            if error.code == "cancelled":
                return BrowserCancelledTransition(state.control.observation)
            failed_observation = state.control.observation
            finalized_receipt = receipt
            if failed_observation is not None and receipt is not None:
                failed_observation, finalized_receipt = self._finalize_control_receipt(
                    state,
                    failed_observation,
                    receipt,
                )
            return BrowserFailedTransition(
                failure=_control_settle_failure(error.code),
                observation=failed_observation,
                receipt=finalized_receipt,
            )
        except Exception:
            _LOGGER.debug(
                "event=browser-control-settle-failed stage=%s code=runtime",
                settle_stage,
            )
            failed_observation = state.control.observation
            finalized_receipt = receipt
            if failed_observation is not None and receipt is not None:
                failed_observation, finalized_receipt = self._finalize_control_receipt(
                    state,
                    failed_observation,
                    receipt,
                )
            return BrowserFailedTransition(
                failure=_control_failure("runtime"),
                observation=failed_observation,
                receipt=finalized_receipt,
            )

    def _client_control_candidate_timeout(
        self,
        state: _FlowState,
        observation: BrowserObservation,
        *,
        receipt: BrowserActionReceipt | None,
    ) -> BrowserCandidateTimeoutTransition:
        """Report a timed-out candidate while restoring an actionable ledger.

        Candidate progress is an internal capture concern.  The transition
        retains ``CANDIDATE`` as evidence for callers that inspect the
        Network transition, but the next Agent action must see the same
        request-local observation with capture progress hidden.  Otherwise
        ``BrowserStepSession`` would return a ``Ready`` observation whose
        execution fingerprint disagrees with the ledger and every subsequent
        action (including ``Stop``) would be treated as stale.
        """

        candidate = replace(observation, capture_state=BrowserCaptureState.CANDIDATE)
        candidate, finalized = self._finalize_control_receipt(
            state,
            candidate,
            receipt,
        )
        ready = replace(candidate, capture_state=BrowserCaptureState.NONE)
        state.control.observation = ready
        if state.control.ledger.current is not None:
            state.control.ledger.replace_current(ready)
        else:
            state.control.ledger.restore_current(ready)
        return BrowserCandidateTimeoutTransition(candidate, finalized)

    def _client_control_execute(  # noqa: C901, PLR0912, PLR0915
        self,
        state: _FlowState,
        page: object,
        action: BrowserAction,
        observation: BrowserObservation,
        *,
        timeout_seconds: float,
    ) -> BrowserActionReceipt:
        """Validate and execute one closed action on the current article."""

        if not isinstance(
            action,
            (ClickElement, ClickPoint, ScrollSurface, GoBack, WaitForChange, Stop),
        ):
            raise _Abort("policy")
        if not isinstance(observation, BrowserObservation):
            raise _Abort("policy")
        if (
            isinstance(timeout_seconds, bool)
            or not isinstance(timeout_seconds, (int, float))
            or not 0 < timeout_seconds <= state.limits.action_timeout_seconds
        ):
            raise _Abort("policy")
        control = state.control
        # Reject every action fact that is already decidable from the current
        # request-local ledger before refreshing the vendor page.  A stale
        # revision, unknown target, disabled element, wrong screenshot or
        # out-of-bounds coordinate is caller input, not a reason to perform a
        # Playwright snapshot.  The later refresh remains necessary to catch a
        # real page change that happened after the observation was delivered.
        try:
            try:
                ledger_current = control.ledger.require_current(observation)
            except ValueError:
                if control.observation is not None:
                    raise _Stale(control.observation) from None
                raise _Abort("runtime") from None
            if (
                action.article_token != ledger_current.article_token
                or action.revision != ledger_current.revision
                or action.page_id not in control.page_keys
            ):
                raise _Abort("policy")
            selected_binding = control.page_keys[action.page_id]
            if ledger_current.capture_state is not BrowserCaptureState.NONE:
                raise _Stale(ledger_current)
            if isinstance(action, ClickElement):
                ledger_element = control.ledger.element(ledger_current, action.element_id)
                element_binding = control.element_keys.get(action.element_id)
                surface_binding = control.surface_keys.get(action.surface_id)
                if (
                    not ledger_element.enabled
                    or ledger_element.surface_id != action.surface_id
                    or element_binding is None
                    or surface_binding is None
                    or element_binding[0] is not selected_binding
                    or surface_binding[0] is not selected_binding
                ):
                    raise _Abort("policy")
            elif isinstance(action, ClickPoint):
                if (
                    action.page_id != ledger_current.screenshot.page_id
                    or action.screenshot_id != ledger_current.screenshot.screenshot_id
                ):
                    raise _Abort("policy")
                ledger_surface = control.ledger.surface(ledger_current, action.surface_id)
                if (
                    ledger_surface.page_id != ledger_current.screenshot.page_id
                    or not ledger_surface.bounds.contains(action.x, action.y)
                    or action.x > ledger_current.viewport.width
                    or action.y > ledger_current.viewport.height
                ):
                    raise _Abort("policy")
            elif isinstance(action, ScrollSurface):
                ledger_surface = control.ledger.surface(ledger_current, action.surface_id)
                surface_binding = control.surface_keys.get(action.surface_id)
                if (
                    ledger_surface.page_id != action.page_id
                    or surface_binding is None
                    or surface_binding[0] is not selected_binding
                ):
                    raise _Abort("policy")
        except (_Abort, _Stale):
            raise
        except (TypeError, ValueError) as error:
            raise _Abort("policy") from error
        # Stop is a no-op at the vendor boundary.  Re-snapshotting here would
        # turn an otherwise valid stop into a stale action whenever a pending
        # response/download candidate makes the page temporarily
        # unobservable.  The pre-dispatch settle already refreshed the
        # request-local ledger; use that coherent observation directly.
        current = (
            ledger_current
            if isinstance(action, Stop)
            else self._client_control_observe(
                state,
                page,
                page_state=observation.page_state,
            )
        )
        if (
            current.article_token != observation.article_token
            or current.revision != observation.revision
            or current.page_id != observation.page_id
            or stable_semantic_page_fingerprint(current)
            != stable_semantic_page_fingerprint(observation)
        ):
            raise _Stale(current)
        if (
            action.article_token != current.article_token
            or action.revision != current.revision
            or action.page_id not in control.page_keys
        ):
            raise _Abort("policy")
        if current.capture_state is not BrowserCaptureState.NONE:
            raise _Stale(current)
        selected_page = control.page_keys[action.page_id]
        milliseconds = max(1, int(timeout_seconds * 1000))
        started_ns = time.monotonic_ns()

        if isinstance(action, Stop):
            control.agent_status = BrowserAgentStatus.STOPPED
            receipt = BrowserActionReceipt(
                action_kind=BrowserActionKind.STOP,
                outcome=BrowserActionOutcome.APPLIED,
                article_token=current.article_token,
                page_id=action.page_id,
                surface_id=None,
                before_revision=current.revision,
                after_revision=current.revision,
                elapsed_milliseconds=0,
            )
            control.last_receipt = receipt
            control.observation = replace(
                current,
                agent_status=BrowserAgentStatus.STOPPED,
                last_receipt=receipt,
            )
            control.ledger.replace_current(control.observation)
            return receipt

        operation_result = True
        click_action = isinstance(action, (ClickElement, ClickPoint))
        if click_action:
            self._begin_control_click_navigation(state, selected_page)
        try:
            if isinstance(action, ClickElement):
                element = control.ledger.element(current, action.element_id)
                if not element.enabled or element.surface_id != action.surface_id:
                    raise _Abort("policy")
                binding = control.element_keys.get(action.element_id)
                surface_binding = control.surface_keys.get(action.surface_id)
                if (
                    binding is None
                    or surface_binding is None
                    or binding[0] is not selected_page
                    or surface_binding[0] is not selected_page
                ):
                    raise _Abort("policy")
                operation = getattr(selected_page, "control_click_element", None)
                if not callable(operation):
                    raise _Abort("runtime")
                operation_result = self._run_cancellable(
                    state,
                    lambda: operation(
                        binding[1],
                        expected_role=element.role,
                        expected_name=element.name,
                        expected_enabled=element.enabled,
                        expected_surface_key=surface_binding[1],
                        timeout=milliseconds,
                    ),
                    abort=lambda: self._abort_runtime(
                        selected_page,
                        None,
                        state.runtime,
                    ),
                )
                if type(operation_result) is not bool:
                    raise _Abort("runtime")
                # Do not inspect the page URL immediately after a click.  A
                # humanized click can synchronously enter a challenge,
                # replace the document, or start a native redirect while the
                # vendor call is still unwinding.  Route admission has already
                # checked every network request; the settle primitive will
                # obtain the next coherent observation and perform the final
                # location check once the page is observable again.
            elif isinstance(action, ClickPoint):
                if (
                    action.page_id != current.screenshot.page_id
                    or action.screenshot_id != current.screenshot.screenshot_id
                ):
                    raise _Abort("policy")
                surface = control.ledger.surface(current, action.surface_id)
                if (
                    surface.page_id != current.screenshot.page_id
                    or not surface.bounds.contains(action.x, action.y)
                    or action.x > current.viewport.width
                    or action.y > current.viewport.height
                ):
                    raise _Abort("policy")
                operation = getattr(selected_page, "control_click_point", None)
                if not callable(operation):
                    raise _Abort("runtime")
                operation_result = self._run_cancellable(
                    state,
                    lambda: operation(action.x, action.y, timeout=milliseconds),
                    abort=lambda: self._abort_runtime(
                        selected_page,
                        None,
                        state.runtime,
                    ),
                )
                if type(operation_result) is not bool:
                    raise _Abort("runtime")
                # See the element-click path above: URL validation belongs to
                # the next stable observation, not to the narrow interval in
                # which Chromium is replacing the document.
            elif isinstance(action, ScrollSurface):
                surface = control.ledger.surface(current, action.surface_id)
                if surface.page_id != action.page_id:
                    raise _Abort("policy")
                surface_binding = control.surface_keys.get(action.surface_id)
                if surface_binding is None or surface_binding[0] is not selected_page:
                    raise _Abort("policy")
                operation = getattr(selected_page, "control_scroll_surface", None)
                if not callable(operation):
                    raise _Abort("runtime")
                self._run_cancellable(
                    state,
                    lambda: operation(
                        surface_binding[1],
                        action.delta_y,
                        timeout=milliseconds,
                    ),
                    abort=lambda: self._abort_runtime(
                        selected_page,
                        None,
                        state.runtime,
                    ),
                )
            elif isinstance(action, GoBack):
                operation = getattr(selected_page, "control_go_back", None)
                if not callable(operation):
                    raise _Abort("runtime")
                operation_result = self._run_cancellable(
                    state,
                    lambda: operation(timeout=milliseconds),
                    abort=lambda: self._abort_runtime(
                        selected_page,
                        None,
                        state.runtime,
                    ),
                )
                if type(operation_result) is not bool:
                    raise _Abort("runtime")
            elif isinstance(action, WaitForChange):
                operation = getattr(selected_page, "control_wait_for_change", None)
                if not callable(operation):
                    raise _Abort("runtime")
                operation_result = self._run_cancellable(
                    state,
                    lambda: operation(timeout=milliseconds),
                    abort=lambda: self._abort_runtime(
                        selected_page,
                        None,
                        state.runtime,
                    ),
                )
                if type(operation_result) is not bool:
                    raise _Abort("runtime")
        except _Abort:
            control.agent_status = BrowserAgentStatus.FAILED
            control.ledger.invalidate()
            control.observation = None
            raise
        except BaseException as error:
            control.agent_status = BrowserAgentStatus.FAILED
            control.ledger.invalidate()
            control.observation = None
            raise _Abort("runtime") from error
        finally:
            if click_action:
                state.detach_navigation(selected_page)

        outcome = (
            BrowserActionOutcome.APPLIED if operation_result else BrowserActionOutcome.NO_CHANGE
        )
        elapsed = max(0, (time.monotonic_ns() - started_ns) // 1_000_000)
        receipt = BrowserActionReceipt(
            action_kind=action.kind,
            outcome=outcome,
            article_token=current.article_token,
            page_id=action.page_id,
            surface_id=action.surface_id,
            before_revision=current.revision,
            after_revision=None,
            elapsed_milliseconds=elapsed,
        )
        control.last_receipt = receipt
        if outcome is not BrowserActionOutcome.NO_CHANGE:
            control.ledger.invalidate()
            control.observation = None
        else:
            control.observation = replace(current, last_receipt=receipt)
            control.ledger.replace_current(control.observation)
        return receipt

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
        with state.lock:
            capture_count_before = len(state.captures)
            page_count_before = len(state.pages)
            download_count_before = len(state.downloads)
            stream_count_before = len(state.streams)
            pending_response_before = len(state.pending_response_downloads)
            pending_local_before = len(state.pending_local_downloads)
            deferred_capture_before = len(state.deferred_captures)
            active_callbacks_before = state.active_download_callbacks
            active_tasks_before = len(state.active_tasks)
        _LOGGER.debug(
            "event=browser-cleanup-started cleanup_scope=runtime-resources "
            "capture_count_before=%d page_count=%d download_count=%d stream_count=%d "
            "pending_response_count=%d pending_local_count=%d "
            "deferred_capture_count=%d "
            "active_download_callbacks=%d active_tasks=%d keep_session=%s",
            capture_count_before,
            page_count_before,
            download_count_before,
            stream_count_before,
            pending_response_before,
            pending_local_before,
            deferred_capture_before,
            active_callbacks_before,
            active_tasks_before,
            str(keep_session).lower(),
        )
        if not state.begin_cleanup():
            failed = not state.wait_for_cleanup(cleanup_deadline)
            _LOGGER.debug(
                "event=browser-cleanup-finished cleanup_scope=runtime-resources "
                "outcome=%s cleanup_failed=%s capture_count_before=%d "
                "capture_count_after=%d result_contains_capture=%s "
                "business_result_deliverable=deferred",
                "failure" if failed else "success",
                str(failed).lower(),
                capture_count_before,
                len(state.captures),
                str(bool(state.captures)).lower(),
            )
            return failed
        failed = state.cleanup_failed
        failed = not state.close_after_download_callbacks(cleanup_deadline) or failed
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
        _LOGGER.debug(
            "event=browser-cleanup-finished cleanup_scope=runtime-resources "
            "outcome=%s cleanup_failed=%s capture_count_before=%d capture_count_after=%d "
            "result_contains_capture=%s business_result_deliverable=deferred "
            "resources_closed=true",
            "failure" if failed else "success",
            str(failed).lower(),
            capture_count_before,
            len(state.captures),
            str(bool(state.captures)).lower(),
        )
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
    "BrowserOperationLimits",
    "BrowserCaptureCorrelation",
    "BrowserCaptureDecision",
    "BrowserCaptureEvidence",
    "BrowserCapturePolicy",
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
